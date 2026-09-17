import { expect, test, type Page } from '@playwright/test';

import { CHARACTERS, CHARACTER_IDS } from '../../src/core/characters';
import { RACE_CONFIG, SPEED } from '../../src/core/config';
import { SIM_CONFIG } from '../../src/sim/config';
import { VIEW } from '../../src/render/viewConfig';
import { OVERTAKE_SEED } from '../fixtures/seeds';
import {
  collectRace,
  currentSteps,
  expectNoErrors,
  raceUrl,
  readHudFrame,
  referenceResult,
  waitForHooks,
  watchConsole,
} from './helpers';

/**
 * Tests E2E de P011 : HUD complet et panneau de debug.
 *
 * Ils tournent contre le build de production. Les comparaisons portent sur des **identifiants** et
 * des nombres, jamais sur un texte approximatif : le classement affiché doit être exactement celui du
 * noyau, et les marqueurs de la mini-carte exactement dans l'ordre des distances.
 *
 * Le mode accéléré (`?fast=1`) est utilisé dès qu'une course entière doit être observée. Il ne change
 * que le temps réel : le résultat de la course reste identique, ce que ces tests exploitent aussi.
 */

/** Interface de glissement, pour la mise à l'échelle de la police du HUD. */
interface HudMetrics {
  /** Origine de l'arène, en coordonnées page : le HUD vit **dans** l'arène. */
  readonly arenaLeft: number;
  readonly arenaTop: number;
  readonly arenaWidth: number;
  readonly arenaHeight: number;
  readonly remPx: number;
}

/** Rectangle d'un élément, exprimé **relativement à l'arène**. */
interface Box {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

/**
 * Rectangle mesuré dans la page.
 *
 * Le type est déclaré ici parce qu'une valeur renvoyée par `page.evaluate` traverse une frontière de
 * sérialisation : sans annotation explicite, `DOMRect` y perd ses propriétés et devient un objet à
 * clés optionnelles, ce qui obligerait à traiter chaque nombre comme possiblement absent.
 */
interface Measured {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

async function hudMetrics(page: Page): Promise<HudMetrics> {
  return page.evaluate(() => {
    const stage = document.querySelector('.stage');
    if (!(stage instanceof HTMLElement)) {
      throw new Error('arène introuvable');
    }
    const box = stage.getBoundingClientRect();
    const remPx = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
    return {
      arenaLeft: box.left,
      arenaTop: box.top,
      arenaWidth: box.width,
      arenaHeight: box.height,
      remPx,
    };
  });
}

async function boxOf(page: Page, testId: string): Promise<Box> {
  const box = await page.getByTestId(testId).boundingBox();
  if (box === null) {
    throw new Error(`élément ${testId} sans géométrie`);
  }
  return {
    left: box.x,
    right: box.x + box.width,
    top: box.y,
    bottom: box.y + box.height,
  };
}

/** Ramène un rectangle page dans le repère de l'arène. */
function relativeTo(box: Box, metrics: HudMetrics): Box {
  return {
    left: box.left - metrics.arenaLeft,
    right: box.right - metrics.arenaLeft,
    top: box.top - metrics.arenaTop,
    bottom: box.bottom - metrics.arenaTop,
  };
}

/** Vrai si deux rectangles se recouvrent réellement, avec une tolérance de 1 px. */
function overlaps(a: Box, b: Box): boolean {
  return (
    a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1
  );
}

/**
 * Convertit `#rrggbb` en `rgb(r, g, b)`.
 *
 * C'est la forme sous laquelle le navigateur rend `background-color` : comparer cette forme à la
 * couleur du roster prouve que le marqueur porte bien l'identité du personnage, sans passer par une
 * capture visuelle.
 */
function hexToRgb(hex: string): string {
  const value = hex.replace('#', '');
  const red = Number.parseInt(value.slice(0, 2), 16);
  const green = Number.parseInt(value.slice(2, 4), 16);
  const blue = Number.parseInt(value.slice(4, 6), 16);
  return `rgb(${String(red)}, ${String(green)}, ${String(blue)})`;
}

test('le classement affiché est exactement celui du noyau, frame par frame', async ({ page }) => {
  const watch = watchConsole(page);
  await page.goto(raceUrl({ seed: OVERTAKE_SEED, fast: true, autostart: true }));

  const samples = await collectRace(page, 6000);
  const last = samples[samples.length - 1];
  expect(last?.phase, 'la course doit être allée au bout').toBe('finished');
  expect(samples.length).toBeGreaterThan(10);

  let compared = 0;
  for (const sample of samples) {
    // Six lignes, dans l'ordre exact du classement du noyau exposé par les hooks.
    expect(sample.hud.length, 'six lignes affichées').toBe(CHARACTER_IDS.length);
    expect(sample.hud.map((row) => row.id), `ordre du noyau (pas ${String(sample.steps)})`).toEqual(
      sample.ranks.map((row) => row.id),
    );
    expect(sample.hud.map((row) => row.rank), 'rangs du noyau').toEqual(
      sample.ranks.map((row) => row.rank),
    );

    // Le modèle du HUD, lu dans la même frame, décrit le même ordre : le DOM et le modèle ne
    // peuvent pas diverger.
    const model = sample.hudModel;
    expect(model, 'le HUD a affiché une frame').not.toBeNull();
    if (model === null) {
      continue;
    }
    expect(model.rows.map((row) => row.id)).toEqual(sample.ranks.map((row) => row.id));

    for (const row of sample.hud) {
      const expected = sample.ranks.find((candidate) => candidate.id === row.id);
      const modelRow = model.rows.find((candidate) => candidate.id === row.id);
      expect(row.name.length, 'le nom est affiché').toBeGreaterThan(0);
      expect(modelRow?.gapMeters).toBeCloseTo(expected?.gapMeters ?? -1, 6);
      expect(modelRow?.gapSeconds).toBeCloseTo((expected?.gapMeters ?? 0) / SPEED.BASE, 9);

      const displayed = Number(row.gapSecondsText.replace(',', '.').replace(/[^0-9.]/g, ''));
      expect(Math.abs(displayed - (expected?.gapMeters ?? 0) / SPEED.BASE)).toBeLessThanOrEqual(0.051);
    }
    compared += 1;
  }

  expect(compared, 'toutes les frames ont été comparées').toBe(samples.length);
  expectNoErrors(watch);
});

test('le leader est identifiable dans le classement', async ({ page }) => {
  const watch = watchConsole(page);
  await page.goto(raceUrl({ seed: OVERTAKE_SEED, fast: true, autostart: true }));
  await expect.poll(() => currentSteps(page), { timeout: 15_000 }).toBeGreaterThan(0);

  // Lecture **atomique** du DOM : les lignes et la marque du leader décrivent le même instant. Le
  // leader change souvent en mode accéléré, donc comparer des lectures successives serait instable.
  const dom = await page.locator('[data-testid="leaderboard-row"]').evaluateAll((rows) =>
    rows.map((row) => ({
      name: row.querySelector('.hud-name')?.textContent ?? '',
      rank: row.getAttribute('data-rank'),
      leader: row.getAttribute('data-leader') === '1',
      isLeaderClass: row.classList.contains('is-leader'),
      gapText: row.querySelector('.hud-gap')?.textContent ?? '',
    })),
  );

  expect(dom).toHaveLength(CHARACTER_IDS.length);
  expect(dom[0]?.rank, 'la première ligne est le leader').toBe('1');
  expect(dom[0]?.leader, 'la première ligne porte la marque du leader').toBe(true);
  expect(dom[0]?.isLeaderClass, 'la première ligne porte la classe du leader').toBe(true);
  expect(dom[0]?.gapText.replace(',', '.').replace(/[^0-9.]/g, '')).toBe('0.0');

  for (const row of dom.slice(1)) {
    expect(row.leader, 'un seul leader').toBe(false);
    expect(row.isLeaderClass).toBe(false);
  }

  // Le nombre de lignes marquées ne dépend pas de l'instant : il y a toujours exactement un leader.
  const leaderRows = page.locator('[data-testid="leaderboard-row"][data-leader="1"]');
  await expect(leaderRows).toHaveCount(1);

  expectNoErrors(watch);
});

test('la mini-carte suit les distances du noyau à plusieurs instants', async ({ page }) => {
  const watch = watchConsole(page);
  await page.goto(raceUrl({ seed: OVERTAKE_SEED, fast: true, autostart: true }));

  const targets = [200, 1200, 4500];
  let lastFrame = await readHudFrame(page);

  for (const target of targets) {
    await expect
      .poll(() => currentSteps(page), { timeout: 30_000 })
      .toBeGreaterThanOrEqual(target);

    const frame = await readHudFrame(page);
    lastFrame = frame;
    expect(frame.distances).toHaveLength(CHARACTER_IDS.length);
    expect(frame.hudModel.markers.map((marker) => marker.id)).toEqual(CHARACTER_IDS);

    // Ordre strict des marqueurs = ordre des distances du noyau.
    const byPosition = [...frame.hudModel.markers]
      .sort((a, b) => a.position - b.position)
      .map((marker) => marker.id);
    const byDistance = [...frame.hudModel.markers]
      .sort((a, b) => a.distance - b.distance)
      .map((marker) => marker.id);
    expect(byPosition, `ordre des marqueurs à ${String(target)} pas`).toEqual(byDistance);

    for (const marker of frame.hudModel.markers) {
      const index = CHARACTER_IDS.indexOf(marker.id);
      const distance = frame.distances[index] ?? -1;
      const previous = lastFrame.hudModel?.markers.find((candidate) => candidate.id === marker.id);
      const previousDistance = previous?.distance ?? distance;

      // La position affichée est, par construction, `distance / NOMINAL_SCALE_M`, bornée à 1 : elle
      // est donc toujours dans `[0 ; 1]` et strictement proportionnelle à une distance du noyau.
      expect(marker.position).toBeGreaterThanOrEqual(0);
      expect(marker.position).toBeLessThanOrEqual(1);
      expect(marker.overflow).toBe(false);
      expect(marker.position).toBeCloseTo(
        Math.min(Math.max(marker.distance / VIEW.NOMINAL_SCALE_M, 0), 1),
        12,
      );

      // La distance affichée appartient à la plage réellement parcourue depuis le relevé précédent :
      // elle décrit donc un état du noyau, et jamais une valeur inventée.
      const lowest = Math.min(previousDistance, distance);
      const highest = Math.max(previousDistance, distance);
      expect(marker.distance, `distance affichée pour ${marker.id}`).toBeGreaterThanOrEqual(
        lowest - 1e-9,
      );
      expect(marker.distance, `distance affichée pour ${marker.id}`).toBeLessThanOrEqual(
        highest + 1e-9,
      );
    }

    // Les 6 marqueurs réellement dessinés sont présents, dans l'ordre du roster, et portent la même
    // position que le modèle publié — le premier test compare déjà ce modèle au DOM à chaque frame.
    const domMarkers = await page.locator('[data-testid="hud-marker"]').evaluateAll((markers) =>
      markers.map((marker) => ({
        id: marker.getAttribute('data-character-id') ?? '',
        position: Number(marker.getAttribute('data-position') ?? '-1'),
        overflow: marker.getAttribute('data-overflow'),
        color: getComputedStyle(marker).backgroundColor,
      })),
    );
    expect(domMarkers.map((marker) => marker.id)).toEqual(CHARACTER_IDS);
    for (const marker of frame.hudModel.markers) {
      const dom = domMarkers.find((candidate) => candidate.id === marker.id);
      expect(dom?.position, `position DOM du marqueur ${marker.id}`).toBeGreaterThanOrEqual(0);
      expect(dom?.position, `position DOM du marqueur ${marker.id}`).toBeLessThanOrEqual(1);
      expect(dom?.overflow, `dépassement du marqueur ${marker.id}`).toBe('0');
      // La couleur d'identité est celle du roster : `core/characters.ts` reste la seule source.
      const character = CHARACTERS.find((candidate) => candidate.id === marker.id);
      expect(dom?.color, `couleur du marqueur ${marker.id}`).toBe(hexToRgb(character?.color ?? ''));
    }
  }

  // Aucun indicateur de dépassement n'est affiché : personne n'a franchi l'échelle nominale.
  const maxOverflow = Math.max(...lastFrame.hudModel.markers.map((marker) => marker.overflowM));
  expect(maxOverflow, 'aucun marqueur au-delà de l’échelle nominale').toBe(0);
  await expect(page.getByTestId('hud-overflow')).toHaveText('');

  expectNoErrors(watch);
});

test('le chrono et le segment suivent le noyau, sans jamais le piloter', async ({ page }) => {
  const watch = watchConsole(page);
  await page.goto(raceUrl({ seed: OVERTAKE_SEED, fast: true, autostart: true }));

  // Le segment affiché est celui du noyau, et l'instant affiché celui du noyau — jamais une horloge.
  for (const [steps, segment] of [
    [300, 1],
    [RACE_CONFIG.STEPS_PER_SEGMENT + 60, 2],
    [2 * RACE_CONFIG.STEPS_PER_SEGMENT + 60, 3],
  ] as const) {
    await expect.poll(() => currentSteps(page), { timeout: 30_000 }).toBeGreaterThanOrEqual(steps);

    // État du noyau, texte du DOM et modèle du HUD sont lus **dans la même tâche** : la seule
    // différence possible entre eux est l'âge de la frame affichée, pas le temps qui passe entre deux
    // allers-retours Playwright.
    const frame = await page.evaluate(() => {
      const api = window.__CHAOS_RACE__;
      const view = window.__CHAOS_RACE_VIEW__;
      if (api === undefined || view === undefined) {
        throw new Error('hooks absents');
      }
      const text = (testId: string): string =>
        document.querySelector(`[data-testid="${testId}"]`)?.textContent ?? '';
      const toNumber = (value: string): number =>
        Number(value.replace(',', '.').replace(/[^0-9.]/g, ''));
      const state = api.state();
      return {
        tSim: state.tSim,
        steps: state.steps,
        segment: api.segment(),
        shownSegment: text('hud-segment'),
        shownTime: toNumber(text('hud-sim-time')),
        modelSteps: view.hud()?.steps ?? -1,
      };
    });

    expect(frame.segment).toBe(segment);
    expect(frame.shownSegment).toBe(
      `segment ${String(segment)}/${String(RACE_CONFIG.SEGMENT_COUNT)}`,
    );

    // Le chrono affiché est celui du noyau. La frame affichée peut être plus vieille d'au plus
    // `maxStepsPerFrame` pas simulés : la borne est donc déterministe, jamais une marge au hasard.
    const maxFrameAgeS = SIM_CONFIG.maxStepsPerFrame * RACE_CONFIG.DT_S;
    expect(frame.shownTime, 'le HUD ne peut pas afficher un temps futur').toBeLessThanOrEqual(
      frame.tSim + 0.05,
    );
    expect(
      frame.shownTime,
      'le chrono ne peut pas être plus vieux que la frame affichée',
    ).toBeGreaterThanOrEqual(frame.tSim - maxFrameAgeS - 0.05);
    expect(frame.modelSteps, 'la frame affichée date bien du noyau').toBeLessThanOrEqual(
      frame.steps,
    );
  }

  // La course se termine par le temps, jamais par une distance : le chrono s'arrête à 180 s.
  await expect
    .poll(() => currentSteps(page), { timeout: 60_000 })
    .toBe(RACE_CONFIG.TOTAL_STEPS);
  await expect.poll(async () => page.getByTestId('hud-sim-time').textContent()).toBe('180,0\u00A0s');

  expectNoErrors(watch);
});

test('le bandeau de pointage apparaît exactement une fois par checkpoint', async ({ page }) => {
  const watch = watchConsole(page);
  await page.goto(raceUrl({ seed: OVERTAKE_SEED, fast: true, autostart: true }));

  const samples = await collectRace(page, 6000);
  const last = samples[samples.length - 1];
  expect(last?.phase, 'la course doit être allée au bout').toBe('finished');

  // Une « apparition » = une suite contiguë de frames où le même pointage est visible.
  const appearances: number[] = [];
  let previous: number | null = null;
  for (const sample of samples) {
    const visible = sample.simPhase === 'checkpointPause' ? sample.checkpoint : null;
    if (visible !== null && visible !== previous) {
      appearances.push(visible);
    }
    previous = visible;
  }

  expect(appearances, 'exactement trois apparitions, dans l’ordre').toEqual([1, 2, 3]);

  for (const sample of samples) {
    const inPause = sample.simPhase === 'checkpointPause';
    const model = sample.hudModel;
    expect(model, 'le HUD a affiché une frame').not.toBeNull();
    if (model === null) {
      continue;
    }
    if (inPause) {
      // Le titre porte le numéro et l'instant réel de la borne, pris dans le noyau.
      expect(sample.banner).toContain(String(sample.checkpoint));
      expect(sample.banner).toContain(
        `${String((sample.checkpoint ?? 0) * RACE_CONFIG.SEGMENT_DURATION_S)}`,
      );
      expect(model.checkpoint?.number).toBe(sample.checkpoint);
      expect(model.checkpoint?.timeS).toBe(
        (sample.checkpoint ?? 0) * RACE_CONFIG.SEGMENT_DURATION_S,
      );
      expect(model.checkpoint?.rows.map((row) => row.id)).toEqual(
        sample.ranks.map((row) => row.id),
      );
      // Le split de tête est l'instant de la borne, et le premier écart est nul.
      expect(model.checkpoint?.rows[0]?.gapMeters).toBe(0);
    } else {
      // Hors pause, il est masqué et vide : il ne reste jamais affiché en cours de segment.
      expect(sample.bannerHidden).toBe(true);
      expect(sample.banner).toBe('');
      expect(model.checkpoint).toBeNull();
    }
  }

  // Aucune quatrième apparition, et moins d'une frame n'est jamais suffisant pour voir un pointage.
  const pauses = samples.filter((sample) => sample.simPhase === 'checkpointPause');
  for (const number of [1, 2, 3]) {
    expect(
      pauses.filter((sample) => sample.checkpoint === number).length,
      `pointage ${String(number)} visible assez longtemps`,
    ).toBeGreaterThan(3);
  }

  expectNoErrors(watch);
});

test('la seed affichée est celle de l’URL, et le bouton la copie', async ({ page }) => {
  const watch = watchConsole(page);
  await page.goto(raceUrl({ seed: OVERTAKE_SEED, fast: true, autostart: true }));

  await expect(page.getByTestId('seed-value')).toHaveText(OVERTAKE_SEED);
  expect(new URL(page.url()).searchParams.get('seed')).toBe(OVERTAKE_SEED);

  // Le modèle du HUD publie exactement la seed affichée : aucune autre source de vérité.
  const frame = await readHudFrame(page);
  expect(frame.hudModel.seed).toBe(OVERTAKE_SEED);

  await page.getByTestId('seed-copy').click();

  // Confirmation visible et copie réellement aboutie.
  await expect(page.getByTestId('seed-copy-state')).toHaveText('Copié !');
  await expect(page.getByTestId('seed-copy')).toHaveText('Copié !');

  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboard, 'la seed copiée est celle qui est affichée').toBe(OVERTAKE_SEED);

  // La copie n'a rien changé à la course : la même seed produit toujours le même résultat.
  const reference = await referenceResult(page, OVERTAKE_SEED);
  const frameAfter = await readHudFrame(page);
  expect(frameAfter.hudModel.seed).toBe(OVERTAKE_SEED);
  expect(reference.ranking).toHaveLength(CHARACTER_IDS.length);

  expectNoErrors(watch);
});

test('la copie dégrade proprement quand l’API Clipboard est absente', async ({ page }) => {
  const watch = watchConsole(page);

  // L'API est neutralisée **dans la page**, avant tout script applicatif : c'est exactement le cas
  // d'un contexte non sécurisé, où `navigator.clipboard` n'existe simplement pas.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
  });
  await page.goto(raceUrl({ seed: OVERTAKE_SEED, fast: true, autostart: true }));
  await waitForHooks(page);

  // Le chemin de copie de secours est exercé directement, et rend son résultat réel.
  const copied = await page.evaluate(async () => {
    const view = window.__CHAOS_RACE_VIEW__;
    if (view === undefined) {
      throw new Error('hooks de rendu absents');
    }
    return view.hudCopy();
  });

  // Chromium supporte la copie par sélection : la dégradation doit donc aboutir, et surtout ne
  // jamais lever d'exception.
  expect(copied, 'le chemin de secours doit aboutir sans Clipboard API').toBe(true);
  const confirmed = await page.evaluate(() => window.__CHAOS_RACE_VIEW__?.hudCopyConfirmed() ?? false);
  expect(confirmed).toBe(true);
  await expect(page.getByTestId('seed-copy-state')).toHaveText('Copié !');
  await expect(page.getByTestId('seed-value')).toHaveText(OVERTAKE_SEED);

  expectNoErrors(watch);
});

const VIEWPORTS = [
  { name: '1280×720', width: 1280, height: 720 },
  { name: '1920×1080', width: 1920, height: 1080 },
  { name: '844×390 (téléphone paysage)', width: 844, height: 390 },
] as const;

for (const viewport of VIEWPORTS) {
  test(`le HUD reste lisible et sans chevauchement critique en ${viewport.name}`, async ({ page }) => {
    const watch = watchConsole(page);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    // Mode accéléré et **scrutation armée dès le chargement** : le premier pointage tombe après
    // ~2,25 s de course, et sa pause (`checkpointPauseRealS`) ne couvre qu'une douzaine de frames.
    // Attendre le pointage avant de commencer à le chercher le manquerait.
    await page.goto(raceUrl({ seed: OVERTAKE_SEED, fast: true, autostart: true }));

    // 6) Le pointage ne recouvre ni le classement ni la mini-carte quand il apparaît.
    //
    // La scrutation tourne **dans la page**, à la fréquence d'affichage, et la géométrie est figée
    // dans la même tâche que l'observation — sinon elle serait mesurée après la disparition du
    // bandeau. Les autres blocs sont mesurés à ce même instant, pour que la comparaison porte bien
    // sur la même mise en page.
    const domRects = await page.evaluate(async (timeoutMs: number) => {
      const read = (selector: string): DOMRect | null => {
        const element = document.querySelector(selector);
        return element === null ? null : element.getBoundingClientRect();
      };
      const bannerVisible = (): boolean => {
        const banner = document.querySelector('[data-testid="checkpoint-banner"]');
        return (
          banner instanceof HTMLElement &&
          banner.getBoundingClientRect().height > 0 &&
          getComputedStyle(banner).display !== 'none'
        );
      };

      const deadline = performance.now() + timeoutMs;
      while (!bannerVisible()) {
        if (performance.now() > deadline) {
          return null;
        }
        await new Promise((resolve) => {
          requestAnimationFrame(() => {
            resolve(null);
          });
        });
      }

      const arena = read('.stage');
      const rect = (box: DOMRect | null): Measured | null =>
        box === null
          ? null
          : {
              left: box.left,
              right: box.right,
              top: box.top,
              bottom: box.bottom,
              width: box.width,
              height: box.height,
            };
      return {
        arena: rect(arena),
        checkpoint: rect(read('[data-testid="checkpoint-splits"]')),
        leaderboard: rect(read('[data-testid="leaderboard"]')),
        minimap: rect(read('[data-testid="hud-minimap"]')),
        seed: rect(read('[data-testid="hud-seed"]')),
        splits: document.querySelectorAll('[data-testid="checkpoint-split"]').length,
      };
    }, 60_000);

    const metrics = await hudMetrics(page);
    const status = relativeTo(await boxOf(page, 'race-status'), metrics);
    const panel = relativeTo(await boxOf(page, 'leaderboard'), metrics);
    const time = relativeTo(await boxOf(page, 'hud-time'), metrics);
    const minimap = relativeTo(await boxOf(page, 'hud-minimap'), metrics);
    const seed = relativeTo(await boxOf(page, 'hud-seed'), metrics);
    const markers = relativeTo(await boxOf(page, 'hud-markers'), metrics);

    // 1) Aucune information essentielle hors de l'arène.
    for (const [name, box] of [
      ['état', status],
      ['classement', panel],
      ['chrono', time],
      ['mini-carte', minimap],
      ['seed', seed],
    ] as const) {
      expect(box.left, `${name} ne sort pas à gauche`).toBeGreaterThanOrEqual(-1);
      expect(box.top, `${name} ne sort pas en haut`).toBeGreaterThanOrEqual(-1);
      expect(box.right, `${name} ne sort pas à droite`).toBeLessThanOrEqual(
        metrics.arenaWidth + 1,
      );
      expect(box.bottom, `${name} ne sort pas en bas`).toBeLessThanOrEqual(
        metrics.arenaHeight + 1,
      );
    }

    // 2) Aucun chevauchement critique entre les blocs du HUD.
    for (const [aName, a, bName, b] of [
      ['classement', panel, 'mini-carte', minimap],
      ['classement', panel, 'seed', seed],
      ['chrono', time, 'mini-carte', minimap],
      ['état', status, 'chrono', time],
      ['mini-carte', minimap, 'seed', seed],
    ] as const) {
      expect(overlaps(a, b), `${aName} et ${bName} ne se chevauchent pas`).toBe(false);
    }

    // 3) Le classement reste lisible : six lignes, police au-dessus du plancher.
    const rows = page.locator('[data-testid="leaderboard-row"]');
    await expect(rows).toHaveCount(CHARACTER_IDS.length);
    for (const row of await rows.all()) {
      const fontSize = await row.evaluate((element) =>
        Number.parseFloat(getComputedStyle(element).fontSize),
      );
      expect(fontSize, 'le classement doit rester lisible').toBeGreaterThanOrEqual(6);
    }

    // 4) La mini-carte reste lisible : une piste assez large pour séparer 6 marqueurs.
    expect(markers.right - markers.left).toBeGreaterThan(metrics.remPx * 2);
    const markerBox = await page.locator('[data-testid="hud-marker"]').first().boundingBox();
    expect(markerBox?.width ?? 0).toBeGreaterThan(2);

    // 5) Seed et chrono utilisables : visibles, cliquables, et d'une taille exploitable.
    await expect(page.getByTestId('seed-value')).toHaveText(OVERTAKE_SEED);
    await expect(page.getByTestId('seed-copy')).toBeVisible();
    const copyBox = await page.getByTestId('seed-copy').boundingBox();
    expect(copyBox?.height ?? 0).toBeGreaterThanOrEqual(12);
    expect(copyBox?.width ?? 0).toBeGreaterThanOrEqual(20);
    await expect(page.getByTestId('hud-sim-time')).toBeVisible();

    // 6) Le pointage, observé plus haut pendant sa pause, ne recouvre ni le classement ni la
    // mini-carte, et reste dans l'arène avec ses 6 splits.
    expect(domRects, 'le bandeau de pointage a été observé pendant sa pause').not.toBeNull();
    if (domRects === null || domRects.arena === null) {
      throw new Error('pointage jamais observé');
    }
    const arenaRect: Measured = domRects.arena;

    /** Ramène un rectangle déjà mesuré dans le repère de l'arène, elle-même mesurée en même temps. */
    const inArena = (box: Measured | null): Box => {
      if (box === null) {
        throw new Error('élément absent pendant le pointage');
      }
      return {
        left: box.left - arenaRect.left,
        right: box.right - arenaRect.left,
        top: box.top - arenaRect.top,
        bottom: box.bottom - arenaRect.top,
      };
    };

    const checkpoint = inArena(domRects.checkpoint);
    expect(
      overlaps(checkpoint, inArena(domRects.leaderboard)),
      'le pointage ne recouvre pas le classement',
    ).toBe(false);
    expect(
      overlaps(checkpoint, inArena(domRects.minimap)),
      'le pointage ne recouvre pas la mini-carte',
    ).toBe(false);
    expect(
      overlaps(checkpoint, inArena(domRects.seed)),
      'le pointage ne recouvre pas la seed',
    ).toBe(false);
    expect(checkpoint.left, 'le pointage reste dans l’arène').toBeGreaterThanOrEqual(-1);
    expect(checkpoint.right).toBeLessThanOrEqual(arenaRect.width + 1);
    expect(checkpoint.bottom).toBeLessThanOrEqual(arenaRect.height + 1);
    // Les splits affichés sont ceux des 6 personnages.
    expect(domRects.splits).toBe(CHARACTER_IDS.length);

    expectNoErrors(watch);
  });
}

test('?debug=1 affiche un panneau de debug qui reflète le noyau, sans le modifier', async ({
  page,
}) => {
  const watch = watchConsole(page);

  // --- Course sans debug : le panneau est absent du rendu.
  await page.goto(raceUrl({ seed: OVERTAKE_SEED, fast: true, autostart: true }));
  await expect(page.getByTestId('debug')).toBeHidden();
  await expect(page.getByTestId('debug-body')).toHaveCount(0);
  const withoutDebug = await referenceResult(page, OVERTAKE_SEED);

  // --- Course avec debug : le panneau apparaît et reflète les valeurs réelles du noyau.
  await page.goto(raceUrl({ seed: OVERTAKE_SEED, fast: true, autostart: true, debug: true }));
  const panel = page.getByTestId('debug');
  await expect(panel).toBeVisible();
  const body = page.getByTestId('debug-body');
  await expect(body).toContainText(OVERTAKE_SEED);
  await expect(body).toContainText('temps simulé');
  await expect(body).toContainText('segment');
  for (const id of CHARACTER_IDS) {
    await expect(body).toContainText(id);
  }

  await expect.poll(() => currentSteps(page), { timeout: 20_000 }).toBeGreaterThan(0);

  // Le panneau est lu dans la même frame que l'état du noyau : la comparaison est exacte.
  const compared = await page.evaluate(() => {
    const api = window.__CHAOS_RACE__;
    if (api === undefined) {
      throw new Error('hooks absents');
    }
    const state = api.state();
    const text = document.querySelector('[data-testid="debug-body"]')?.textContent ?? '';
    return {
      tSim: state.tSim,
      steps: state.steps,
      distances: state.characters.map((character) => character.x),
      speeds: state.characters.map((character) => character.v),
      text,
    };
  });

  for (const distance of compared.distances) {
    expect(compared.text, 'distance réelle du noyau dans le panneau').toContain(
      distance.toFixed(2).replace('.', ','),
    );
  }
  for (const speed of compared.speeds) {
    expect(compared.text, 'vitesse réelle du noyau dans le panneau').toContain(
      speed.toFixed(3).replace('.', ','),
    );
  }
  expect(compared.text).toContain(compared.tSim.toFixed(3));
  expect(compared.text).toContain(String(compared.steps));

  // --- Preuve d'invariance : mêmes distances finales, même classement, exactement 10800 pas.
  const withDebug = await referenceResult(page, OVERTAKE_SEED);
  expect(withDebug.distances, 'distances finales strictement identiques').toEqual(
    withoutDebug.distances,
  );
  expect(withDebug.ranking, 'classement final strictement identique').toEqual(withoutDebug.ranking);

  expect(compared.steps).toBeGreaterThan(0);
  expect(compared.steps).toBeLessThanOrEqual(RACE_CONFIG.TOTAL_STEPS);
  // Une course complète accélérée compte exactement `TOTAL_STEPS` pas, debug compris.
  await expect
    .poll(() => currentSteps(page), { timeout: 60_000 })
    .toBe(RACE_CONFIG.TOTAL_STEPS);

  expectNoErrors(watch);
});
