import { expect, test, type Page } from '@playwright/test';

import { CHARACTERS, CHARACTER_IDS } from '../../src/core/characters';
import { RACE_CONFIG } from '../../src/core/config';
import { MAX_PARTICIPANTS, MIN_PARTICIPANTS } from '../../src/core/participants';
import type { CharacterId } from '../../src/core/types';
import { VIEW } from '../../src/render/viewConfig';
import {
  expectNoErrors,
  raceUrl,
  readFinishCore,
  readFinishDom,
  waitForFinished,
  waitForHooks,
  watchConsole,
} from './helpers';

/**
 * Courses de 3 à 6 coureurs — vérifications de bout en bout, sur le build de production.
 *
 * Ces tests ne croient jamais l'interface sur parole : le nombre de partants est lu dans le **noyau**
 * (`participants()`, `state().characters`), comparé au nombre de sprites réellement dessinés
 * (`__CHAOS_RACE_VIEW__.sprites()`), au nombre de lignes du classement affiché, et au nombre de
 * résultats de l'écran d'arrivée. La géométrie des voies est mesurée en pixels logiques du canvas,
 * aux deux résolutions de téléphone paysage demandées, et comparée aux constantes du format.
 */

/** Une taille de voie mesurée : hauteur logique du sprite et ordonnée de son centre. */
interface LaneMeasure {
  readonly id: string;
  readonly centerY: number;
  readonly height: number;
  readonly nameX: number;
  readonly screenX: number;
  readonly screenY: number;
}

/** Mesure, dans un **seul** appel, les partants du noyau et les voies réellement dessinées. */
async function measureLanes(page: Page): Promise<{
  readonly players: number;
  readonly participants: readonly string[];
  readonly stateCharacters: readonly string[];
  readonly compact: boolean;
  readonly arenaHeight: number;
  readonly lanes: readonly LaneMeasure[];
}> {
  await waitForHooks(page);
  return page.evaluate(() => {
    const api = window.__CHAOS_RACE__;
    const view = window.__CHAOS_RACE_VIEW__;
    if (api === undefined || view === undefined) {
      throw new Error('hooks absents');
    }
    const sprites = view.sprites();
    return {
      players: api.players(),
      participants: [...api.participants()],
      stateCharacters: api.state().characters.map((character) => character.id),
      compact: view.track().compact,
      arenaHeight: view.track().arenaHeight,
      lanes: sprites.map((sprite) => ({
        id: sprite.id,
        centerY: sprite.screenY,
        height: sprite.height,
        nameX: sprite.nameX,
        screenX: sprite.screenX,
        screenY: sprite.screenY,
      })),
    };
  });
}

/** Séparation **visible** entre deux voies voisines, en pixels logiques, au pire cas. */
function visibleGap(lanes: readonly LaneMeasure[]): number {
  const sorted = [...lanes].sort((a, b) => a.centerY - b.centerY);
  let smallest = Number.POSITIVE_INFINITY;
  for (let index = 1; index < sorted.length; index += 1) {
    const above = sorted[index - 1];
    const below = sorted[index];
    if (above === undefined || below === undefined) {
      continue;
    }
    // Pire cas assumé : la silhouette occupe toute la hauteur visible de son cadre (95,6 %), l'une
    // au-dessus de l'autre. C'est cette valeur que l'œil juge, pas l'écart entre cadres.
    const gap = below.centerY - above.centerY - below.height * 0.956;
    smallest = Math.min(smallest, gap);
  }
  return smallest;
}

test('sans paramètre d’URL, la course aligne six coureurs et le sélecteur l’affiche', async ({
  page,
}) => {
  const watch = watchConsole(page);
  await page.goto(raceUrl({ seed: 'K7QM2X9A' }));
  await waitForHooks(page);

  const measured = await measureLanes(page);
  expect(measured.players).toBe(MAX_PARTICIPANTS);
  expect(measured.participants).toEqual([...CHARACTER_IDS]);
  expect(measured.stateCharacters).toEqual([...CHARACTER_IDS]);
  expect(measured.lanes).toHaveLength(MAX_PARTICIPANTS);

  // Le contrôle propose exactement les quatre effectifs, et affiche celui de la course. La valeur
  // porte le mot (`4 coureurs`) : en petit paysage le libellé général est masqué, et le contrôle doit
  // rester compréhensible sans lui.
  const select = page.getByTestId('players-select');
  await expect(select).toHaveValue(String(MAX_PARTICIPANTS));
  await expect(select).toBeEnabled();
  const options = await select.locator('option').allTextContents();
  expect(options).toEqual(['3 coureurs', '4 coureurs', '5 coureurs', '6 coureurs']);

  // L'URL décrit l'identité complète de la course : seed **et** effectif.
  const url = new URL(page.url());
  expect(url.searchParams.get('seed')).toBe('K7QM2X9A');
  expect(url.searchParams.get('players')).toBe(String(MAX_PARTICIPANTS));

  expectNoErrors(watch);
});

for (const players of [MIN_PARTICIPANTS, 4, 5, MAX_PARTICIPANTS]) {
  test(`une URL players=${String(players)} aligne exactement ${String(players)} partants, du noyau à l’écran`, async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const watch = watchConsole(page);
    await page.goto(raceUrl({ seed: 'K7QM2X9A', players, fast: true, autostart: true }));
    await waitForHooks(page);

    const measured = await measureLanes(page);
    expect(measured.players).toBe(players);
    expect(measured.participants).toHaveLength(players);
    expect(measured.stateCharacters).toEqual([...measured.participants]);
    expect(measured.lanes).toHaveLength(players);
    expect(new Set(measured.participants).size).toBe(players);
    for (const id of measured.participants) {
      expect(CHARACTER_IDS, `${id} doit venir du roster officiel`).toContain(id);
    }
    // Ordre canonique : les voies suivent l'ordre du roster, jamais l'ordre du tirage.
    const positions = measured.participants.map((id) => CHARACTER_IDS.indexOf(id as CharacterId));
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);

    await waitForFinished(page);
    const core = await readFinishCore(page);
    const dom = await readFinishDom(page);

    // Le classement, le podium et les résultats suivent l'effectif réel — jamais six par défaut.
    expect(core.ranks).toHaveLength(players);
    expect(core.distances).toHaveLength(players);
    expect(core.panel?.rows).toHaveLength(players);
    expect(core.panel?.podiumIds).toHaveLength(Math.min(3, players));
    expect(dom.rows).toHaveLength(players);
    expect(dom.podium).toHaveLength(Math.min(3, players));
    expect(core.panel?.rows.map((row) => row.id)).toEqual(core.ranks.map((row) => row.id));
    // Chaque ligne affichée nomme un partant réel.
    for (const row of dom.rows) {
      expect(measured.participants, `l’arrivée cite ${row.id}`).toContain(row.id);
      expect(row.name).toBe(CHARACTERS.find((character) => character.id === row.id)?.name ?? '');
    }

    expectNoErrors(watch);
  });
}

test('une URL illisible retombe proprement sur six coureurs', async ({ page }) => {
  const watch = watchConsole(page);

  for (const value of ['9', '2', 'abc', '']) {
    await page.goto(raceUrl({ seed: 'K7QM2X9A', players: value }));
    await waitForHooks(page);
    const measured = await measureLanes(page);
    expect(measured.players, `players=${value} doit retomber sur 6`).toBe(MAX_PARTICIPANTS);
    expect(measured.participants).toEqual([...CHARACTER_IDS]);
    // L'URL est réécrite avec l'effectif réellement utilisé : elle décrit la course, pas la demande.
    expect(new URL(page.url()).searchParams.get('players')).toBe(String(MAX_PARTICIPANTS));
  }

  expectNoErrors(watch);
});

test('le choix s’applique avant la course, et plus jamais pendant', async ({ page }) => {
  const watch = watchConsole(page);
  await page.goto(raceUrl({ seed: 'K7QM2X9A' }));
  await waitForHooks(page);

  // Avant toute course (`idle`), le choix prend effet tout de suite : « Lancer » alignera bien trois
  // coureurs, et l'URL décrit déjà la course à venir.
  await page.getByTestId('players-select').selectOption('3');
  const before = await measureLanes(page);
  expect(before.players).toBe(MIN_PARTICIPANTS);
  expect(before.participants).toHaveLength(MIN_PARTICIPANTS);
  expect(before.lanes).toHaveLength(MIN_PARTICIPANTS);
  expect(new URL(page.url()).searchParams.get('players')).toBe('3');

  // Course lancée : le contrôle est **désactivé**, et l'effectif ne bouge plus d'un partant.
  await page.evaluate(() => {
    window.__CHAOS_RACE__?.start();
  });
  await page.waitForFunction(() => (window.__CHAOS_RACE__?.state().steps ?? 0) > 0, null, {
    timeout: 30_000,
  });
  await expect(page.getByTestId('players-select')).toBeDisabled();

  const during = await measureLanes(page);
  expect(during.players).toBe(MIN_PARTICIPANTS);
  expect(during.stateCharacters).toHaveLength(MIN_PARTICIPANTS);
  expect(during.lanes).toHaveLength(MIN_PARTICIPANTS);

  expectNoErrors(watch);
});

test('« Rejouer la même seed » et « Nouvelle course » gardent l’effectif choisi', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const watch = watchConsole(page);
  await page.goto(raceUrl({ seed: 'K7QM2X9A', players: MIN_PARTICIPANTS, fast: true, autostart: true }));
  await waitForFinished(page);

  const first = await readFinishCore(page);
  expect(first.panel?.rows).toHaveLength(MIN_PARTICIPANTS);
  const firstSeed = first.seed;

  // Rejouer **la même** seed : même effectif, même plateau, même résultat.
  await page.getByTestId('finish-replay-same').click();
  await waitForFinished(page);
  const replay = await readFinishCore(page);
  expect(replay.seed).toBe(firstSeed);
  expect(replay.panel?.rows.map((row) => row.id)).toEqual(first.panel?.rows.map((row) => row.id));
  expect(new URL(page.url()).searchParams.get('players')).toBe('3');

  // Nouvelle course : nouvelle seed, **même** effectif.
  await page.getByTestId('finish-new-race').click();
  await waitForHooks(page);
  const afterNew = await measureLanes(page);
  expect(afterNew.players).toBe(MIN_PARTICIPANTS);
  expect(afterNew.lanes).toHaveLength(MIN_PARTICIPANTS);
  expect(new URL(page.url()).searchParams.get('players')).toBe('3');
  expect(new URL(page.url()).searchParams.get('seed')).not.toBe(firstSeed);

  expectNoErrors(watch);
});

for (const viewport of [
  { name: '844×390', width: 844, height: 390 },
  { name: '926×428', width: 926, height: 428 },
] as const) {
  test(`en ${viewport.name}, les personnages grandissent à 5, 4 et 3 coureurs sans se chevaucher`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const watch = watchConsole(page);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });

    const measured: { players: number; lanes: readonly LaneMeasure[]; compact: boolean }[] = [];
    for (const players of [MAX_PARTICIPANTS, 5, 4, MIN_PARTICIPANTS]) {
      await page.goto(raceUrl({ seed: 'KR7Z8NAR', players, fast: true, autostart: true }));
      await waitForHooks(page);
      await page.waitForFunction(() => (window.__CHAOS_RACE__?.state().steps ?? 0) >= 120, null, {
        timeout: 30_000,
      });
      const sample = await measureLanes(page);
      expect(sample.compact, `${viewport.name} doit être en format compact`).toBe(true);
      expect(sample.lanes).toHaveLength(players);
      measured.push({ players, lanes: sample.lanes, compact: sample.compact });
    }

    const six = measured[0];
    const five = measured[1];
    const four = measured[2];
    const three = measured[3];
    if (six === undefined || five === undefined || four === undefined || three === undefined) {
      throw new Error('mesures manquantes');
    }

    // Six coureurs gardent **exactement** la taille historique du format compact.
    expect(six.lanes[0]?.height).toBe(VIEW.CHARACTER_HEIGHT_COMPACT_PX);
    // Moins de coureurs, des personnages plus grands — et jamais plus petits.
    expect(five.lanes[0]?.height ?? 0).toBeGreaterThan(six.lanes[0]?.height ?? 0);
    expect(four.lanes[0]?.height ?? 0).toBeGreaterThanOrEqual(five.lanes[0]?.height ?? 0);
    expect(three.lanes[0]?.height ?? 0).toBeGreaterThanOrEqual(four.lanes[0]?.height ?? 0);
    // Le gain est franc : au moins 30 % de hauteur en plus à trois coureurs.
    expect(three.lanes[0]?.height ?? 0).toBeGreaterThanOrEqual(
      Math.round((six.lanes[0]?.height ?? 0) * 1.3),
    );

    for (const sample of measured) {
      // Aucune collision de silhouettes, et une séparation visible entre deux voies voisines.
      expect(
        visibleGap(sample.lanes),
        `${viewport.name} à ${String(sample.players)} coureurs`,
      ).toBeGreaterThanOrEqual(10);
      // Les voies sont réparties sur toute la hauteur de l'arène, du haut vers le bas.
      const sorted = [...sample.lanes].sort((a, b) => a.centerY - b.centerY);
      expect(sorted).toHaveLength(sample.players);
      for (let index = 1; index < sorted.length; index += 1) {
        expect(sorted[index]?.centerY ?? 0).toBeGreaterThan(sorted[index - 1]?.centerY ?? 0);
      }
      // Le nom reste **à gauche** du personnage, jamais dessous.
      for (const lane of sample.lanes) {
        expect(lane.nameX, `${lane.id} : le nom doit rester à gauche`).toBeLessThan(lane.screenX);
      }
    }

    expectNoErrors(watch);
  });
}

test('le bouton × ferme l’écran d’arrivée sans rien relancer ni rien changer', async ({ page }) => {
  test.setTimeout(120_000);
  const watch = watchConsole(page);
  await page.goto(raceUrl({ seed: 'K7QM2X9A', players: 4, fast: true, autostart: true }));
  await waitForFinished(page);

  const before = await readFinishCore(page);
  const urlBefore = page.url();
  expect(before.panel?.visible).toBe(true);

  const close = page.getByTestId('finish-close');
  await expect(close).toBeVisible();
  await expect(close).toHaveAttribute('aria-label', "Fermer l'écran d'arrivée");
  await close.click();

  await expect(page.getByTestId('finish')).toBeHidden();
  const after = await readFinishCore(page);

  // Le résultat est **intact** : mêmes pas, même instant, même seed, même classement.
  expect(after.steps).toBe(before.steps);
  expect(after.tSim).toBe(before.tSim);
  expect(after.seed).toBe(before.seed);
  expect(after.ranks).toEqual(before.ranks);
  expect(after.panel?.rows).toEqual(before.panel?.rows);
  expect(after.panel?.visible).toBe(false);
  expect(after.simPhase).toBe('finished');
  expect(after.steps).toBe(RACE_CONFIG.TOTAL_STEPS);
  // Aucune nouvelle course, aucune nouvelle seed : l'URL n'a pas bougé.
  expect(page.url()).toBe(urlBefore);

  // Les commandes habituelles redeviennent atteignables : le panneau masqué ne capture plus les clics.
  await expect(page.getByTestId('pause-button')).toBeVisible();
  const pauseReachable = await page.evaluate(() => {
    const button = document.querySelector('[data-testid="pause-button"]');
    if (button === null) {
      return false;
    }
    const box = button.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return hit !== null && (hit === button || button.contains(hit));
  });
  expect(pauseReachable, 'le bouton Pause doit être cliquable après fermeture').toBe(true);

  expectNoErrors(watch);
});

test('Échap ferme aussi l’écran d’arrivée sur un appareil à clavier', async ({ page }) => {
  test.setTimeout(120_000);
  const watch = watchConsole(page);
  await page.goto(raceUrl({ seed: 'K7QM2X9A', fast: true, autostart: true }));
  await waitForFinished(page);

  const before = await readFinishCore(page);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('finish')).toBeHidden();

  const after = await readFinishCore(page);
  expect(after.seed).toBe(before.seed);
  expect(after.steps).toBe(before.steps);
  expect(after.ranks).toEqual(before.ranks);

  expectNoErrors(watch);
});

test('l’écran d’arrivée laisse une marge visible à droite, sans sortir de l’arène', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const watch = watchConsole(page);

  for (const viewport of [
    { width: 844, height: 390 },
    { width: 1280, height: 720 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto(raceUrl({ seed: 'K7QM2X9A', fast: true, autostart: true }));
    await waitForFinished(page);

    const box = await page.evaluate(() => {
      const panel = document.querySelector('[data-testid="finish"]');
      if (panel === null) {
        return null;
      }
      const rect = panel.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        paddingRight: getComputedStyle(panel).paddingRight,
      };
    });

    expect(box).not.toBeNull();
    if (box === null) {
      continue;
    }
    // Le panneau est **entièrement** dans la fenêtre…
    expect(box.left).toBeGreaterThanOrEqual(-1);
    expect(box.top).toBeGreaterThanOrEqual(-1);
    expect(box.right).toBeLessThanOrEqual(box.viewportWidth + 1);
    expect(box.bottom).toBeLessThanOrEqual(box.viewportHeight + 1);
    // …et il laisse une marge visible sur la droite : c'est la demande explicite de cette passe.
    expect(
      box.viewportWidth - box.right,
      `marge droite en ${String(viewport.width)}×${String(viewport.height)}`,
    ).toBeGreaterThanOrEqual(4);
    // La protection Dynamic Island / safe-area reste portée par le `padding` du panneau.
    expect(box.paddingRight.length).toBeGreaterThan(0);
  }

  expectNoErrors(watch);
});

test('le sélecteur ne perturbe pas la seed affichée ni la copie de seed', async ({ page }) => {
  const watch = watchConsole(page);
  await page.goto(raceUrl({ seed: 'K7QM2X9A', players: 5 }));
  await waitForHooks(page);

  // Un seul affichage de seed, et il porte bien la seed de l'URL.
  const seedText = await page.getByTestId('seed-value').textContent();
  expect(seedText).toBe('K7QM2X9A');
  expect(await page.locator('.hud-seed').count()).toBe(1);
  // Le contrôle de l'effectif vit dans la même rangée, sans la recouvrir.
  const overlap = await page.evaluate(() => {
    const seed = document.querySelector('.hud-seed');
    const players = document.querySelector('.hud-players');
    if (seed === null || players === null) {
      return true;
    }
    const a = seed.getBoundingClientRect();
    const b = players.getBoundingClientRect();
    return a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
  });
  expect(overlap, 'le sélecteur ne recouvre pas la seed').toBe(false);

  expectNoErrors(watch);
});
