import { expect, test, type Page } from '@playwright/test';

import { CHARACTER_IDS } from '../../src/core/characters';
import { RACE_CONFIG, SPEED } from '../../src/core/config';
import { SIM_CONFIG } from '../../src/sim/config';
import { UI_TEXT_FR } from '../../src/app/strings.fr';
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
 * noyau, et les marqueurs publiés par le modèle exactement dans l'ordre des distances.
 *
 * La passe corrective issue du premier test joueur manuel a retiré du HUD la mini-carte et le grand
 * tableau de checkpoint : le modèle continue de publier ses marqueurs (hook de test et de debug,
 * utile à P014), mais plus aucun élément DOM ne les dessine. Les tests ci-dessous vérifient donc la
 * **piste dégagée** autant que la lisibilité : le canvas doit occuper l'arène, et le classement
 * permanent ne doit pas en manger les quarts.
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

test('les marqueurs du modèle suivent les distances du noyau à plusieurs instants', async ({
  page,
}) => {
  const watch = watchConsole(page);
  await page.goto(raceUrl({ seed: OVERTAKE_SEED, fast: true, autostart: true }));

  const targets = [200, 1200, 3400, RACE_CONFIG.TOTAL_STEPS];
  let lastFrame = await readHudFrame(page);

  for (const target of targets) {
    await expect
      .poll(() => currentSteps(page), { timeout: 30_000 })
      .toBeGreaterThanOrEqual(target);

    const frame = await readHudFrame(page);
    lastFrame = frame;
    expect(frame.distances).toHaveLength(CHARACTER_IDS.length);
    expect(frame.hudModel.markers.map((marker) => marker.id)).toEqual(CHARACTER_IDS);

    // Ordre strict des marqueurs = ordre des distances du noyau, **sous l'échelle nominale**. Au-delà
    // de `VIEW.NOMINAL_SCALE_M`, `position` sature à 1 : c'est la règle documentée du modèle (le
    // rendu ne recadre jamais l'échelle en cours de course), donc deux personnages qui dépassent
    // l'échelle partagent la même position et ne peuvent plus être ordonnés par elle. L'échelle
    // nominale valant exactement `SPEED.BASE × TOTAL_SIM_S`, la saturation est normale en fin de
    // course : elle est donc exclue de l'égalité d'ordre, puis vérifiée à part.
    const belowScale = frame.hudModel.markers.filter((marker) => marker.position < 1);
    const byPosition = [...belowScale]
      .sort((a, b) => a.position - b.position)
      .map((marker) => marker.id);
    const byDistance = [...belowScale]
      .sort((a, b) => a.distance - b.distance)
      .map((marker) => marker.id);
    expect(byPosition, `ordre des marqueurs à ${String(target)} pas`).toEqual(byDistance);

    // Sur l'ensemble, la position reste monotone avec la distance : plus loin ne veut jamais dire
    // moins avancé sur la piste.
    const positionsByDistance = [...frame.hudModel.markers]
      .sort((a, b) => a.distance - b.distance)
      .map((marker) => marker.position);
    for (let index = 1; index < positionsByDistance.length; index += 1) {
      expect(positionsByDistance[index]).toBeGreaterThanOrEqual(positionsByDistance[index - 1] ?? 0);
    }

    for (const marker of frame.hudModel.markers) {
      const index = CHARACTER_IDS.indexOf(marker.id);
      const distance = frame.distances[index] ?? -1;
      const previous = lastFrame.hudModel?.markers.find((candidate) => candidate.id === marker.id);
      const previousDistance = previous?.distance ?? distance;

      // La position publiée est, par construction, `distance / NOMINAL_SCALE_M`, bornée à 1 : elle
      // est donc toujours dans `[0 ; 1]` et strictement proportionnelle à une distance du noyau.
      expect(marker.position).toBeGreaterThanOrEqual(0);
      expect(marker.position).toBeLessThanOrEqual(1);
      expect(marker.position).toBeCloseTo(
        Math.min(Math.max(marker.distance / VIEW.NOMINAL_SCALE_M, 0), 1),
        12,
      );

      // La distance publiée appartient à la plage réellement parcourue depuis le relevé précédent :
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

    // Le modèle publié correspond bien aux distances du noyau lues dans la même frame.
    for (const marker of frame.hudModel.markers) {
      const index = CHARACTER_IDS.indexOf(marker.id);
      expect(marker.distance, `distance du modèle pour ${marker.id}`).toBe(
        frame.distances[index] ?? -1,
      );
    }
  }

  // Aucun recadrage d'échelle : le modèle **publie** le dépassement au lieu de resserrer la piste.
  for (const marker of lastFrame.hudModel.markers) {
    expect(marker.overflowM, `dépassement publié pour ${marker.id}`).toBeCloseTo(
      Math.max(marker.distance - VIEW.NOMINAL_SCALE_M, 0),
      9,
    );
  }

  // `NOMINAL_SCALE_M = SPEED.BASE × TOTAL_SIM_S` vaut la distance **moyenne** de fin de course :
  // environ la moitié du peloton la dépasse. En fin de course, la saturation est donc réelle et
  // vérifiée — c'est ce qui interdit d'ordonner deux marqueurs par leur position au-delà de l'échelle.
  const saturated = lastFrame.hudModel.markers.filter((marker) => marker.position === 1);
  expect(
    saturated.length,
    'en fin de course, une partie du peloton dépasse l’échelle nominale',
  ).toBeGreaterThan(0);
  for (const marker of saturated) {
    expect(marker.distance).toBeGreaterThanOrEqual(VIEW.NOMINAL_SCALE_M);
  }

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

  // La course se termine par le temps, jamais par une distance : le chrono s'arrête à 60 s.
  await expect
    .poll(() => currentSteps(page), { timeout: 60_000 })
    .toBe(RACE_CONFIG.TOTAL_STEPS);
  await expect.poll(async () => page.getByTestId('hud-sim-time').textContent()).toBe('60,0\u00A0s');

  // …et le bloc segment ne prétend plus qu'un quatrième segment existe : à l'arrivée, il n'y a plus
  // de segment en cours. Le noyau n'a que trois segments (1 à 3) : `segment 0/3` était un numéro
  // invalide, et il ne peut plus être affiché (passe corrective 2).
  await expect.poll(async () => page.getByTestId('hud-segment').textContent()).toBe('Terminé');
  const finishSegment = await page.getByTestId('hud-segment').textContent();
  expect(finishSegment ?? '').not.toContain('0/3');
  // Le **modèle** publié ne contient plus aucun segment : c'est la source de l'affichage, et non une
  // correction cosmétique du texte. `null` est distingué de « pas de modèle », sinon l'assertion ne
  // prouverait rien.
  const segmentModel = await page.evaluate(() => {
    const model = window.__CHAOS_RACE_VIEW__?.hud() ?? null;
    return model === null ? 'modèle absent' : { segment: model.segment, tSim: model.tSim };
  });
  expect(segmentModel, 'le HUD a bien affiché une frame').not.toBe('modèle absent');
  if (segmentModel === 'modèle absent') {
    throw new Error('modèle du HUD absent');
  }
  expect(segmentModel.segment, 'le modèle du HUD ne publie aucun segment hors course').toBeNull();
  expect(segmentModel.tSim, 'le temps simulé affiché reste la fin de course').toBe(
    RACE_CONFIG.TOTAL_SIM_S,
  );

  expectNoErrors(watch);
});

test('le bandeau de checkpoint apparaît exactement une fois par checkpoint', async ({ page }) => {
  const watch = watchConsole(page);
  await page.goto(raceUrl({ seed: OVERTAKE_SEED, fast: true, autostart: true }));

  const samples = await collectRace(page, 6000);
  const last = samples[samples.length - 1];
  expect(last?.phase, 'la course doit être allée au bout').toBe('finished');

  // Une « apparition » = une suite contiguë de frames où le même checkpoint est visible.
  const appearances: number[] = [];
  let previous: number | null = null;
  for (const sample of samples) {
    const visible = sample.simPhase === 'checkpointPause' ? sample.checkpoint : null;
    if (visible !== null && visible !== previous) {
      appearances.push(visible);
    }
    previous = visible;
  }

  // Deux checkpoints dans une course de 60 s (bornes à 20 s et 40 s) : ni un de plus, ni un de moins.
  expect(appearances, 'exactement deux apparitions, dans l’ordre').toEqual([1, 2]);

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

  // Aucune troisième apparition, et moins d'une frame n'est jamais suffisant pour voir un checkpoint.
  const pauses = samples.filter((sample) => sample.simPhase === 'checkpointPause');
  for (const number of [1, 2]) {
    expect(
      pauses.filter((sample) => sample.checkpoint === number).length,
      `checkpoint ${String(number)} visible assez longtemps`,
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
  test(`le HUD reste lisible et la piste dégagée en ${viewport.name}`, async ({ page }) => {
    const watch = watchConsole(page);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    // Mode accéléré et **scrutation armée dès le chargement** : le premier checkpoint tombe après
    // ~1 s de course réelle, et sa pause (`checkpointPauseRealS`) ne couvre qu'une douzaine de
    // frames. Attendre le checkpoint avant de commencer à le chercher le manquerait.
    await page.goto(raceUrl({ seed: OVERTAKE_SEED, fast: true, autostart: true }));

    // 6) Le bandeau de checkpoint ne recouvre ni le classement ni la seed quand il apparaît.
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
        // Le canvas est la piste : c'est lui qui doit rester largement visible.
        canvas: rect(read('#game canvas')),
        checkpoint: rect(read('[data-testid="checkpoint"]')),
        leaderboard: rect(read('[data-testid="leaderboard"]')),
        seed: rect(read('[data-testid="hud-seed"]')),
        settings: rect(read('[data-testid="settings"]')),
        checkpointLeader: document.querySelector('[data-testid="checkpoint-leader"]')?.textContent ?? '',
      };
    }, 60_000);

    const metrics = await hudMetrics(page);
    // Géométrie **réelle** de la piste, publiée par le rendu : c'est elle qui doit correspondre à la
    // bande réservée au classement, et non une constante recopiée dans le test (passe corrective 2).
    const track = await page.evaluate(() => {
      const view = window.__CHAOS_RACE_VIEW__;
      if (view === undefined) {
        throw new Error('hooks absents');
      }
      return view.track();
    });
    const status = relativeTo(await boxOf(page, 'race-status'), metrics);
    const time = relativeTo(await boxOf(page, 'hud-time'), metrics);
    const seed = relativeTo(await boxOf(page, 'hud-seed'), metrics);
    const settings = relativeTo(await boxOf(page, 'settings'), metrics);

    // 1) Aucune information essentielle hors de l'arène.
    for (const [name, box] of [
      ['état', status],
      ['chrono', time],
      ['seed', seed],
      ['réglages', settings],
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
      ['chrono', time, 'seed', seed],
      ['état', status, 'chrono', time],
    ] as const) {
      expect(overlaps(a, b), `${aName} et ${bName} ne se chevauchent pas`).toBe(false);
    }

    // 3) Le classement reste lisible : six lignes, police au-dessus du plancher. Les lignes existent
    // même quand le panneau est masqué (téléphone paysage) : le classement de l'écran d'arrivée, lui,
    // reste complet.
    const rows = page.locator('[data-testid="leaderboard-row"]');
    await expect(rows).toHaveCount(CHARACTER_IDS.length);
    for (const row of await rows.all()) {
      const fontSize = await row.evaluate((element) =>
        Number.parseFloat(getComputedStyle(element).fontSize),
      );
      expect(fontSize, 'le classement doit rester lisible').toBeGreaterThanOrEqual(6);
    }

    // 4) La piste reste largement visible : le canvas remplit l'arène, et le classement permanent
    // n'en occupe qu'une fraction limitée. C'est l'exigence §4 de la passe corrective : le HUD ne
    // doit plus manger la course.
    expect(domRects, 'le bandeau de checkpoint a été observé pendant sa pause').not.toBeNull();
    if (domRects === null || domRects.arena === null) {
      throw new Error('checkpoint jamais observé');
    }
    const arenaRect: Measured = domRects.arena;
    const areaFraction = (box: Measured | null): number =>
      box === null ? 0 : (box.width * box.height) / (arenaRect.width * arenaRect.height);

    const canvas = domRects.canvas;
    expect(canvas, 'le canvas est présent').not.toBeNull();
    // En téléphone paysage, le canvas **est** la piste : il n'occupe donc qu'une partie de la largeur
    // de l'arène (le reste est la colonne du HUD), mais toute sa hauteur.
    const canvasWidthRatio = track.compact ? 0.6 : 0.95;
    expect(canvas?.width ?? 0, 'le canvas remplit sa zone en largeur').toBeGreaterThanOrEqual(
      arenaRect.width * canvasWidthRatio,
    );
    expect(canvas?.height ?? 0, 'le canvas remplit l’arène en hauteur').toBeGreaterThanOrEqual(
      arenaRect.height * 0.95,
    );
    expect(
      areaFraction(domRects.leaderboard),
      'le classement permanent ne doit pas occuper plus d’un quart de la piste',
    ).toBeLessThanOrEqual(0.25);

    /*
     * 4 bis) **Le classement ne recouvre plus la piste** (passe corrective 2, étendue au téléphone
     * par la passe responsive).
     *
     * La preuve est géométrique et porte sur les deux rectangles réellement mesurés dans la même
     * tâche : celui du classement, ramené dans le repère de l'arène, et la largeur de piste publiée
     * par le rendu. Le bord gauche du panneau doit se trouver **à droite** de la piste.
     *
     * Sur bureau, la bande est dans le canvas : la piste est plus étroite que l'arène. En téléphone
     * paysage, le canvas **est** la piste et la colonne du HUD commence à son bord droit.
     */
    /*
     * L'échelle entre pixels logiques et pixels CSS se lit sur le **canvas**, pas sur l'arène : en
     * téléphone paysage, le canvas est la piste et n'occupe qu'une partie de l'arène (le reste est la
     * colonne du HUD). Utiliser la largeur de l'arène donnerait une piste fausse, égale à l'écran.
     */
    const canvasScale = (canvas?.width ?? arenaRect.width) / track.arenaWidth;
    const trackWidthCss = track.trackWidth * canvasScale;
    if (track.compact) {
      expect(track.trackWidth, 'en téléphone paysage, la piste occupe tout le canvas').toBe(
        track.arenaWidth,
      );
      const panelRect = domRects.leaderboard;
      expect(panelRect, 'le classement permanent est affiché dans la colonne').not.toBeNull();
      const panelLeft = (panelRect?.left ?? 0) - arenaRect.left;
      expect(
        panelLeft,
        `le classement commence après la piste (piste ${trackWidthCss.toFixed(1)} px, panneau ${panelLeft.toFixed(1)} px)`,
      ).toBeGreaterThanOrEqual(trackWidthCss - 1);
      expect(trackWidthCss, 'la piste ne prend pas toute la largeur de l’écran').toBeLessThan(
        arenaRect.width * 0.75,
      );
      await expect(page.getByTestId('leaderboard')).toBeVisible();
    } else {
      const panelRect = domRects.leaderboard;
      expect(panelRect, 'le classement permanent est affiché hors téléphone paysage').not.toBeNull();
      const panelLeft = (panelRect?.left ?? 0) - arenaRect.left;
      expect(
        panelLeft,
        `le classement commence après la piste (piste ${trackWidthCss.toFixed(1)} px, panneau ${panelLeft.toFixed(1)} px)`,
      ).toBeGreaterThanOrEqual(trackWidthCss);
      expect(track.trackWidth, 'la piste réserve la bande du classement').toBeLessThan(
        track.arenaWidth,
      );
      await expect(page.getByTestId('leaderboard')).toBeVisible();
    }

    // 5) Seed et chrono utilisables : visibles, cliquables, et d'une taille exploitable.
    await expect(page.getByTestId('seed-value')).toHaveText(OVERTAKE_SEED);
    await expect(page.getByTestId('seed-copy')).toBeVisible();
    const copyBox = await page.getByTestId('seed-copy').boundingBox();
    expect(copyBox?.height ?? 0).toBeGreaterThanOrEqual(12);
    expect(copyBox?.width ?? 0).toBeGreaterThanOrEqual(20);
    await expect(page.getByTestId('hud-sim-time')).toBeVisible();
    const settingsBox = await page.getByTestId('settings-sound').boundingBox();
    expect(settingsBox?.height ?? 0, 'les réglages restent cliquables').toBeGreaterThanOrEqual(12);

    // 6) Le bandeau de checkpoint, observé plus haut pendant sa pause, ne recouvre ni le classement
    // ni la seed, reste dans l'arène, reste **léger**, et nomme le leader figé à la borne.
    /** Ramène un rectangle déjà mesuré dans le repère de l'arène, elle-même mesurée en même temps. */
    const inArena = (box: Measured | null): Box => {
      if (box === null) {
        throw new Error('élément absent pendant le checkpoint');
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
      'le bandeau de checkpoint ne recouvre pas le classement',
    ).toBe(false);
    expect(
      overlaps(checkpoint, inArena(domRects.seed)),
      'le bandeau de checkpoint ne recouvre pas la seed',
    ).toBe(false);
    expect(
      overlaps(checkpoint, inArena(domRects.settings)),
      'le bandeau de checkpoint ne recouvre pas les réglages',
    ).toBe(false);
    expect(checkpoint.left, 'le bandeau de checkpoint reste dans l’arène').toBeGreaterThanOrEqual(-1);
    expect(checkpoint.right).toBeLessThanOrEqual(arenaRect.width + 1);
    expect(checkpoint.bottom).toBeLessThanOrEqual(arenaRect.height + 1);
    expect(
      areaFraction(domRects.checkpoint),
      'le checkpoint est un retour bref, pas un tableau',
    ).toBeLessThanOrEqual(0.1);
    // Le nom du leader figé est bien affiché : sans lui, le bandeau ne dirait rien de la course.
    expect(domRects.checkpointLeader.trim().length).toBeGreaterThan(2);

    expectNoErrors(watch);
  });
}

test('les bonus et malus s’affichent sur le bon personnage, puis disparaissent', async ({ page }) => {
  /**
   * Exigence §10 de la passe corrective : un bonus ou un malus qui s'applique doit **se voir**, sur
   * le personnage concerné, et le retour doit venir **exclusivement** d'un événement réel du noyau.
   *
   * La preuve est structurelle plutôt que visuelle : à chaque frame, le test lit l'événement actif
   * du noyau **et** les badges réellement présents dans le DOM, puis compare les deux ensembles. Un
   * badge qui ne correspondrait à aucun événement actif — ou un événement actif sans badge — ferait
   * échouer la comparaison.
   */
  const watch = watchConsole(page);
  await page.goto(raceUrl({ seed: OVERTAKE_SEED, fast: true, autostart: true }));

  const observed = await page.evaluate(async () => {
    interface BadgeRecord {
      readonly characterId: string;
      readonly eventId: string;
      readonly kind: string;
      readonly start: string;
      readonly label: string;
      readonly kindLabel: string;
      /** Part du badge réellement posée sur la piste (intersection avec le canvas). */
      readonly onTrackFraction: number;
    }

    const badges: BadgeRecord[] = [];
    const seenBadges = new Set<string>();
    const coreEvents = new Set<string>();
    const coreMagnitudes = new Map<string, { magnitude: number; target: string }>();
    let maxSimultaneous = 0;

    for (let frame = 0; frame < 20_000; frame += 1) {
      const api = window.__CHAOS_RACE__;
      if (api === undefined) {
        throw new Error('hooks absents');
      }
      const state = api.state();
      const canvas = document.querySelector('#game canvas')?.getBoundingClientRect() ?? null;

      // 1) Ce que le noyau déclare **réellement** à cette frame.
      for (const character of state.characters) {
        const event = character.activeEvent;
        if (event === null) {
          continue;
        }
        const occurrence = `${event.id}@${String(event.startSimS)}`;
        coreEvents.add(`${character.id}:${occurrence}`);
        coreMagnitudes.set(`${character.id}:${occurrence}`, {
          magnitude: event.magnitude,
          target: event.target,
        });
      }

      // 2) Ce que le HUD affiche à la même frame.
      const elements = [...document.querySelectorAll('[data-testid="event-badge"]')];
      maxSimultaneous = Math.max(maxSimultaneous, elements.length);
      for (const element of elements) {
        if (!(element instanceof HTMLElement)) {
          continue;
        }
        const characterId = element.dataset['characterId'] ?? '';
        const eventId = element.dataset['eventId'] ?? '';
        const start = element.dataset['eventStart'] ?? '';
        const key = `${characterId}:${eventId}@${start}`;
        if (seenBadges.has(key)) {
          continue;
        }
        seenBadges.add(key);
        const rect = element.getBoundingClientRect();
        // Le badge est ancré sur le sprite ; près d'un bord, une partie peut sortir de la piste.
        // Ce qui compte est qu'il soit **posé sur la course**, pas qu'il y tienne entièrement.
        const overlapWidth = Math.max(
          0,
          Math.min(rect.right, canvas?.right ?? rect.right) -
            Math.max(rect.left, canvas?.left ?? rect.left),
        );
        const overlapHeight = Math.max(
          0,
          Math.min(rect.bottom, canvas?.bottom ?? rect.bottom) -
            Math.max(rect.top, canvas?.top ?? rect.top),
        );
        const area = rect.width * rect.height;
        badges.push({
          characterId,
          eventId,
          kind: element.dataset['kind'] ?? '',
          start,
          label: element.querySelector('[data-testid="event-label"]')?.textContent ?? '',
          kindLabel: element.querySelector('[data-testid="event-kind"]')?.textContent ?? '',
          onTrackFraction: area > 0 ? (overlapWidth * overlapHeight) / area : 0,
        });
      }

      if (state.steps >= 3600) {
        // Quelques frames de plus : un badge ne doit pas survivre à la fin de son événement.
        for (let extra = 0; extra < 10; extra += 1) {
          await new Promise((resolve) => {
            requestAnimationFrame(() => {
              resolve(null);
            });
          });
        }
        break;
      }
      await new Promise((resolve) => {
        requestAnimationFrame(() => {
          resolve(null);
        });
      });
    }

    return {
      badges,
      coreEvents: [...coreEvents],
      coreMagnitudes: [...coreMagnitudes],
      maxSimultaneous,
      remaining: document.querySelectorAll('[data-testid="event-badge"]').length,
      phases: window.__CHAOS_RACE__?.phase() ?? '',
    };
  });

  expect(observed.phases).toBe('finished');
  expect(observed.coreEvents.length, 'la course a réellement produit des événements').toBeGreaterThan(
    0,
  );
  expect(observed.badges.length, 'chaque événement a été affiché au moins une fois').toBe(
    observed.coreEvents.length,
  );

  const magnitudes = new Map(observed.coreMagnitudes);
  for (const badge of observed.badges) {
    const key = `${badge.characterId}:${badge.eventId}@${badge.start}`;
    // Le badge désigne une occurrence **réelle** : elle appartient à l'ensemble lu dans le noyau.
    expect(observed.coreEvents, `badge ${key} adossé à un événement réel`).toContain(key);
    // La cible publiée par le noyau est bien le personnage qui porte le badge.
    expect(magnitudes.get(key)?.target, `cible du badge ${key}`).toBe(badge.characterId);
    // Le libellé principal est celui du catalogue d'événements, jamais un mot inventé par le rendu.
    expect(UI_TEXT_FR.eventLabels, `libellé du badge ${key}`).toHaveProperty(badge.eventId);
    expect(badge.label.length, `libellé non vide pour ${key}`).toBeGreaterThan(2);
    // Le sens du badge vient du **signe de la magnitude** mesurée, pas d'une décision du rendu.
    const magnitude = magnitudes.get(key)?.magnitude ?? Number.NaN;
    const expectedKind = magnitude > 0 ? 'bonus' : magnitude < 0 ? 'malus' : 'neutral';
    expect(badge.kind, `sens du badge ${key}`).toBe(expectedKind);
    if (expectedKind === 'bonus') {
      expect(badge.kindLabel).toBe(UI_TEXT_FR.eventFeedback.bonus);
    }
    if (expectedKind === 'malus') {
      expect(badge.kindLabel).toBe(UI_TEXT_FR.eventFeedback.malus);
    }
    expect(magnitude, `magnitude non nulle pour ${key}`).not.toBe(0);
    // Non obscurcissant : le retour est posé sur la piste, au-dessus du personnage concerné.
    expect(badge.onTrackFraction, `badge ${key} posé sur la piste`).toBeGreaterThanOrEqual(0.5);
  }
  // Le retour est **temporaire** : plus aucun badge une fois la course terminée.
  expect(observed.remaining, 'aucun badge ne survit à la fin de son événement').toBe(0);

  // Preuve d'invariance : cette course truffée de badges donne exactement le résultat du noyau seul.
  const reference = await referenceResult(page, OVERTAKE_SEED);
  const final = await page.evaluate(() => {
    const api = window.__CHAOS_RACE__;
    if (api === undefined) {
      throw new Error('hooks absents');
    }
    return {
      distances: api.state().characters.map((character) => character.x),
      ranking: api.ranks().map((row) => row.id),
      steps: api.state().steps,
    };
  });
  expect(final.distances, 'les badges ne modifient aucune distance').toEqual(reference.distances);
  expect(final.ranking, 'les badges ne modifient aucun classement').toEqual(reference.ranking);
  expect(final.steps).toBe(RACE_CONFIG.TOTAL_STEPS);

  expectNoErrors(watch);
});

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

  // --- Preuve d'invariance : mêmes distances finales, même classement, exactement 3 600 pas.
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
