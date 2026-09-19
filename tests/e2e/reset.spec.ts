import { expect, test, type Page } from '@playwright/test';

import { RACE_CONFIG } from '../../src/core/config';
import { MAX_PARTICIPANTS, MIN_PARTICIPANTS } from '../../src/core/participants';
import { UI_TEXT_FR } from '../../src/app/strings.fr';
import {
  currentSteps,
  expectNoErrors,
  raceUrl,
  readFinishCore,
  waitForFinished,
  waitForHooks,
  watchConsole,
} from './helpers';

/**
 * Barre principale `Lancer · Pause/Reprendre · Réinitialiser` (passe corrective P013-cor4).
 *
 * Ces tests ne croient jamais l'interface sur parole : l'état des boutons est lu dans le **DOM réel**
 * (`disabled`, rectangles), et l'effectif lancé est comparé aux partants du noyau
 * (`participants()`, `state().characters`), au nombre de sprites dessinés
 * (`__CHAOS_RACE_VIEW__.sprites()`) et au nombre de lignes du classement affiché. C'est ce qui rend
 * le bug « 4 sélectionné → 6 lancés » impossible à laisser passer : le choix affiché et l'effectif
 * réellement couru sont comparés dans la même lecture.
 */

const SEED = 'K7QM2X9A';

/** Taille de l'écran de téléphone paysage de référence. */
const PHONE = { width: 844, height: 390 } as const;

/** États réels des trois commandes, lus dans le DOM. */
interface ControlState {
  readonly startDisabled: boolean;
  readonly startText: string;
  readonly pauseDisabled: boolean;
  readonly pauseText: string;
  readonly resetDisabled: boolean;
  readonly resetText: string;
  readonly playersDisabled: boolean;
  readonly playersValue: string;
  /** Effectif réellement aligné par le moteur. */
  readonly players: number;
  readonly participants: readonly string[];
  readonly stateCharacters: readonly string[];
  readonly simPhase: string;
}

/** Lit, en **un seul** appel, l'état des commandes et l'effectif réellement configuré. */
async function readControls(page: Page): Promise<ControlState> {
  await waitForHooks(page);
  return page.evaluate(() => {
    const api = window.__CHAOS_RACE__;
    if (api === undefined) {
      throw new Error('hooks absents');
    }
    const button = (testId: string): HTMLButtonElement | null => {
      const element = document.querySelector(`[data-testid="${testId}"]`);
      return element instanceof HTMLButtonElement ? element : null;
    };
    const select = document.querySelector('[data-testid="players-select"]');
    const start = button('start-button');
    const pause = button('pause-button');
    const reset = button('reset-button');
    return {
      startDisabled: start?.disabled ?? false,
      startText: start?.textContent ?? '',
      pauseDisabled: pause?.disabled ?? false,
      pauseText: pause?.textContent ?? '',
      resetDisabled: reset?.disabled ?? false,
      resetText: reset?.textContent ?? '',
      playersDisabled: select instanceof HTMLSelectElement ? select.disabled : false,
      playersValue: select instanceof HTMLSelectElement ? select.value : '',
      players: api.players(),
      participants: [...api.participants()],
      stateCharacters: api.state().characters.map((character) => character.id),
      simPhase: api.phase(),
    };
  });
}

/** Attend que la phase temps réel atteigne `phase`. */
async function waitForPhase(page: Page, phase: string, timeoutMs = 30_000): Promise<void> {
  await waitForHooks(page);
  await page.waitForFunction((expected) => window.__CHAOS_RACE__?.phase() === expected, phase, {
    timeout: timeoutMs,
  });
}

/** Attend qu'un nombre réel de pas ait été joué. */
async function waitForSteps(page: Page, steps: number, timeoutMs = 30_000): Promise<void> {
  await waitForHooks(page);
  await page.waitForFunction((count) => (window.__CHAOS_RACE__?.state().steps ?? 0) >= count, steps, {
    timeout: timeoutMs,
  });
}

/** Nombre de sprites réellement construits par le rendu. */
async function spriteIds(page: Page): Promise<readonly string[]> {
  return page.evaluate(() => window.__CHAOS_RACE_VIEW__?.sprites().map((sprite) => sprite.id) ?? []);
}

/** Nombre de lignes réellement écrites dans le classement du HUD. */
async function leaderboardIds(page: Page): Promise<readonly string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid="leaderboard-row"]')).map(
      (row) => row.getAttribute('data-character-id') ?? '',
    ),
  );
}

/** Effectif réellement décrit par l'URL. */
function urlPlayers(page: Page): string | null {
  return new URL(page.url()).searchParams.get('players');
}

test('Cas A — idle à 6, choisir 4, Lancer : exactement 4 partants, 4 sprites et 4 lignes', async ({
  page,
}) => {
  // La course est jouée **en temps réel** jusqu'à l'arrivée (c'est le sujet du test) : 60 s simulées
  // plus le compte à rebours et les deux pauses de checkpoint.
  test.setTimeout(180_000);
  const watch = watchConsole(page);
  await page.goto(raceUrl({ seed: SEED }));

  // Départ à six, comme l'URL par défaut.
  const initial = await readControls(page);
  expect(initial.players).toBe(MAX_PARTICIPANTS);
  expect(initial.startDisabled).toBe(false);

  // Le choix est appliqué **avant** le départ : le moteur est déjà à quatre quand on clique.
  await page.getByTestId('players-select').selectOption('4');
  const chosen = await readControls(page);
  expect(chosen.players).toBe(4);
  expect(chosen.participants).toHaveLength(4);
  expect(chosen.stateCharacters).toHaveLength(4);
  expect(chosen.playersValue).toBe('4');

  await page.getByTestId('start-button').click();

  // Le choix affiché et l'effectif lancé sont comparés **dans la même lecture**, après le départ.
  const launched = await readControls(page);
  expect(launched.simPhase === 'countdown' || launched.simPhase === 'running').toBe(true);
  expect(launched.players).toBe(4);
  expect(launched.participants).toHaveLength(4);
  expect(launched.stateCharacters).toHaveLength(4);
  expect(await spriteIds(page)).toHaveLength(4);
  expect(await leaderboardIds(page)).toHaveLength(4);
  expect(urlPlayers(page)).toBe('4');

  // Et la course va bien jusqu'au bout avec ce plateau.
  await waitForFinished(page);
  const core = await readFinishCore(page);
  expect(core.ranks).toHaveLength(4);
  expect(core.panel?.rows).toHaveLength(4);

  expectNoErrors(watch);
});

test('Cas B — Réinitialiser en pleine course : idle immédiat, ancienne progression effacée, 3 partants ensuite', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const watch = watchConsole(page);
  await page.goto(raceUrl({ seed: SEED, players: MAX_PARTICIPANTS, fast: true, autostart: true }));

  // La course tourne réellement, avec de la progression à effacer.
  await waitForSteps(page, 300);
  const running = await readControls(page);
  expect(running.simPhase).toBe('running');
  expect(running.players).toBe(MAX_PARTICIPANTS);
  const seedBefore = await page.evaluate(() => window.__CHAOS_RACE__?.seed() ?? '');

  await page.getByTestId('reset-button').click();

  // 1) Idle **immédiatement**, sans attendre l'arrivée, et l'ancienne progression a disparu.
  await waitForPhase(page, 'idle');
  const afterReset = await readControls(page);
  expect(afterReset.simPhase).toBe('idle');
  expect(await currentSteps(page)).toBe(0);
  const state = await page.evaluate(() => {
    const api = window.__CHAOS_RACE__;
    if (api === undefined) {
      throw new Error('hooks absents');
    }
    const snapshot = api.state();
    return { tSim: snapshot.tSim, distances: snapshot.characters.map((character) => character.x) };
  });
  expect(state.tSim).toBe(0);
  expect(state.distances.every((distance) => distance === 0)).toBe(true);
  // Aucun sprite ni aucune ligne de l'ancienne course ne subsiste.
  expect(await spriteIds(page)).toHaveLength(MAX_PARTICIPANTS);
  expect(await leaderboardIds(page)).toHaveLength(MAX_PARTICIPANTS);
  // L'URL et le HUD portent une **nouvelle** seed.
  const seedAfter = await page.evaluate(() => window.__CHAOS_RACE__?.seed() ?? '');
  expect(seedAfter).not.toBe(seedBefore);
  await expect(page.getByTestId('seed-value')).toHaveText(seedAfter);
  expect(new URL(page.url()).searchParams.get('seed')).toBe(seedAfter);

  // 2) Réinitialiser n'a rien lancé : on peut choisir un effectif, puis lancer.
  await expect(page.getByTestId('players-select')).toBeEnabled();
  await page.getByTestId('players-select').selectOption('3');
  await page.getByTestId('start-button').click();
  await waitForSteps(page, 1);

  const launched = await readControls(page);
  expect(launched.players).toBe(MIN_PARTICIPANTS);
  expect(launched.stateCharacters).toHaveLength(MIN_PARTICIPANTS);
  expect(await spriteIds(page)).toHaveLength(MIN_PARTICIPANTS);
  expect(await leaderboardIds(page)).toHaveLength(MIN_PARTICIPANTS);
  expect(urlPlayers(page)).toBe('3');

  expectNoErrors(watch);
});

test('Cas C — course à 4 en pause : Réinitialiser ramène en idle immédiatement', async ({ page }) => {
  test.setTimeout(120_000);
  const watch = watchConsole(page);
  await page.goto(raceUrl({ seed: SEED, players: 4, fast: true, autostart: true }));

  await waitForSteps(page, 120);
  await page.getByTestId('pause-button').click();
  await waitForPhase(page, 'userPaused');
  const pausedSteps = await currentSteps(page);

  await page.getByTestId('reset-button').click();
  await waitForPhase(page, 'idle');

  const afterReset = await readControls(page);
  expect(afterReset.simPhase).toBe('idle');
  expect(afterReset.players).toBe(4);
  expect(await currentSteps(page)).toBe(0);
  expect(pausedSteps).toBeGreaterThan(0);
  // La barre de relecture disparaît avec la pause qu'elle décrivait.
  await expect(page.getByTestId('replay-bar')).toBeHidden();
  await expect(page.getByTestId('players-select')).toBeEnabled();

  expectNoErrors(watch);
});

test('Cas D — à l’arrivée, Lancer est désactivé ; après Réinitialiser, Lancer et Coureurs le sont à nouveau', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const watch = watchConsole(page);
  await page.goto(raceUrl({ seed: SEED, players: 4, fast: true, autostart: true }));
  await waitForFinished(page);

  // 1) Course terminée : Lancer et le sélecteur sont **réellement** désactivés (attribut HTML).
  const finished = await readControls(page);
  expect(finished.simPhase).toBe('finished');
  expect(finished.startDisabled).toBe(true);
  expect(finished.playersDisabled).toBe(true);
  expect(finished.pauseDisabled).toBe(true);
  // Le bouton reste à sa place : il est grisé, pas retiré du flux.
  await expect(page.getByTestId('start-button')).toBeVisible();
  await expect(page.getByTestId('start-button')).toHaveAttribute('disabled', '');
  // Les libellés sont ceux de la barre demandée : `Lancer` · `Pause` · `Réinitialiser`.
  expect(finished.startText).toBe(UI_TEXT_FR.startButton);
  expect(finished.pauseText).toBe(UI_TEXT_FR.pauseButton);
  // « Réinitialiser » reste disponible en permanence : c'est la sortie rapide d'une course.
  expect(finished.resetDisabled).toBe(false);
  expect(finished.resetText).toBe(UI_TEXT_FR.resetButton);

  // 2) L'écran d'arrivée est réellement affiché avant le reset.
  await expect(page.getByTestId('finish')).toBeVisible();

  // 3) Réinitialiser masque l'écran d'arrivée, revient en idle et rend les deux contrôles.
  await page.getByTestId('reset-button').click();
  await waitForPhase(page, 'idle');

  const afterReset = await readControls(page);
  expect(afterReset.simPhase).toBe('idle');
  expect(afterReset.startDisabled).toBe(false);
  expect(afterReset.playersDisabled).toBe(false);
  expect(afterReset.pauseDisabled).toBe(true);
  expect(afterReset.playersValue).toBe('4');
  expect(afterReset.players).toBe(4);
  await expect(page.getByTestId('finish')).toBeHidden();
  await expect(page.getByTestId('start-button')).toBeEnabled();
  await expect(page.getByTestId('players-select')).toBeEnabled();

  expectNoErrors(watch);
});

test('Lancer est désactivé dès le compte à rebours et ne peut pas être cliqué deux fois', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const watch = watchConsole(page);
  await page.goto(raceUrl({ seed: SEED }));
  await waitForHooks(page);

  await expect(page.getByTestId('start-button')).toBeEnabled();
  await page.getByTestId('start-button').click();

  // Dès la première frame du compte à rebours, l'attribut HTML `disabled` est posé.
  await expect(page.getByTestId('start-button')).toBeDisabled();
  await expect(page.getByTestId('players-select')).toBeDisabled();
  const countdown = await readControls(page);
  expect(countdown.simPhase).toBe('countdown');
  expect(countdown.startDisabled).toBe(true);

  // Un second clic ne peut pas relancer le compte à rebours : il reste 3 s réelles, pas 6.
  await page.waitForTimeout(1000);
  await page.getByTestId('start-button').click({ force: true });
  const stillCountdown = await readControls(page);
  expect(stillCountdown.simPhase).toBe('countdown');

  await waitForPhase(page, 'running');
  expect((await readControls(page)).startDisabled).toBe(true);

  // Pendant une pause manuelle, Lancer reste désactivé et Réinitialiser reste disponible. Le bouton
  // de pause, lui, devient « Reprendre » : il reste actif, puisque la pause peut être levée.
  await page.getByTestId('pause-button').click();
  await waitForPhase(page, 'userPaused');
  const paused = await readControls(page);
  expect(paused.startDisabled).toBe(true);
  expect(paused.resetDisabled).toBe(false);
  expect(paused.pauseDisabled).toBe(false);
  expect(paused.pauseText).toBe(UI_TEXT_FR.resumeButton);

  // Réinitialiser interrompt la course sans attendre l'arrivée : rien n'a été joué « en plus ».
  await page.getByTestId('reset-button').click();
  await waitForPhase(page, 'idle');
  expect(await currentSteps(page)).toBe(0);

  expectNoErrors(watch);
});

test('« Rejouer la même seed » de l’écran d’arrivée reste reproductible et n’est pas affecté par Réinitialiser', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const watch = watchConsole(page);
  await page.goto(raceUrl({ seed: SEED, players: 5, fast: true, autostart: true }));
  await waitForFinished(page);

  const first = await readFinishCore(page);
  const firstSeed = first.seed;
  expect(first.panel?.rows).toHaveLength(5);

  // Rejouer la même seed : même course, bit à bit, et l'effectif ne bouge pas.
  await page.getByTestId('finish-replay-same').click();
  await waitForFinished(page);
  const replayed = await readFinishCore(page);
  expect(replayed.seed).toBe(firstSeed);
  expect(replayed.steps).toBe(RACE_CONFIG.TOTAL_STEPS);
  expect(replayed.ranks).toEqual(first.ranks);
  expect(replayed.panel?.rows).toEqual(first.panel?.rows);
  expect(urlPlayers(page)).toBe('5');

  // Réinitialiser, ensuite, prépare bien une **nouvelle** course : autre seed, même effectif.
  await page.getByTestId('reset-button').click();
  await waitForPhase(page, 'idle');
  const afterReset = await readControls(page);
  expect(afterReset.players).toBe(5);
  expect(afterReset.startDisabled).toBe(false);
  expect(urlPlayers(page)).toBe('5');
  const newSeed = await page.evaluate(() => window.__CHAOS_RACE__?.seed() ?? '');
  expect(newSeed).not.toBe(firstSeed);

  expectNoErrors(watch);
});

test('en 844×390 et 926×428, le sélecteur est un vrai contrôle tactile sans chevauchement', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const watch = watchConsole(page);

  for (const viewport of [
    { name: '844×390', width: PHONE.width, height: PHONE.height },
    { name: '926×428', width: 926, height: 428 },
  ] as const) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto(raceUrl({ seed: SEED, players: 6, fast: true, autostart: true }));
    await waitForSteps(page, 120);

    const measured = await page.evaluate(() => {
      const box = (selector: string): DOMRect | null => {
        const element = document.querySelector(selector);
        return element === null ? null : element.getBoundingClientRect();
      };
      const select = document.querySelector('[data-testid="players-select"]');
      const selectBox = box('[data-testid="players-select"]');
      const style = select === null ? null : getComputedStyle(select);
      return {
        select: selectBox,
        fontSize: style === null ? 0 : Number.parseFloat(style.fontSize),
        text: select instanceof HTMLSelectElement ? (select.selectedOptions[0]?.textContent ?? '') : '',
        fits: select instanceof HTMLElement ? select.scrollWidth <= select.clientWidth + 1 : false,
        seed: box('[data-testid="hud-seed"]'),
        gallery: box('[data-testid="gallery-button"]'),
        leaderboard: box('[data-testid="leaderboard"]'),
        subtitle: box('[data-testid="subtitle"]'),
        controls: box('.controls'),
        players: box('[data-testid="players-control"]'),
      };
    });

    const select = measured.select;
    expect(select, `sélecteur absent en ${viewport.name}`).not.toBeNull();
    if (select === null) {
      continue;
    }

    // 1) Présence d'un vrai bouton tactile : ≈ 2,2rem de haut, police ≈ 0,72rem.
    expect(select.height, `hauteur du sélecteur en ${viewport.name}`).toBeGreaterThanOrEqual(30);
    expect(measured.fontSize, `police du sélecteur en ${viewport.name}`).toBeGreaterThanOrEqual(11);
    // 2) La valeur est lisible : elle porte le mot, et elle n'est pas tronquée.
    expect(measured.text, `libellé affiché en ${viewport.name}`).toBe('6 coureurs');
    expect(measured.fits, `valeur non tronquée en ${viewport.name}`).toBe(true);
    // 3) Le contrôle est entièrement dans l'écran.
    expect(select.left).toBeGreaterThanOrEqual(0);
    expect(select.right).toBeLessThanOrEqual(viewport.width + 1);
    expect(select.bottom).toBeLessThanOrEqual(viewport.height + 1);

    // 4) Aucun chevauchement : ni avec la seed, ni avec le bouton « persos », ni avec le
    //    classement, ni avec le speaker, ni avec la bande des commandes.
    const overlaps = (a: DOMRect | null, b: DOMRect | null): boolean =>
      a !== null &&
      b !== null &&
      a.left < b.right - 1 &&
      b.left < a.right - 1 &&
      a.top < b.bottom - 1 &&
      b.top < a.bottom - 1;
    for (const [name, neighbour] of [
      ['la seed', measured.seed],
      ['le bouton persos', measured.gallery],
      ['le classement', measured.leaderboard],
      ['le speaker', measured.subtitle],
      ['les commandes', measured.controls],
    ] as const) {
      expect(
        overlaps(measured.players, neighbour),
        `le sélecteur ne recouvre pas ${name} en ${viewport.name}`,
      ).toBe(false);
    }
  }

  expectNoErrors(watch);
});
