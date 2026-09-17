import { expect, test, type Page } from '@playwright/test';

import { RACE_CONFIG } from '../../src/core/config';
import { OVERTAKE_SEED } from '../fixtures/seeds';
import {
  collectRace,
  currentSteps,
  expectNoErrors,
  raceUrl,
  referenceDistances,
  waitForHooks,
  watchConsole,
} from './helpers';

/**
 * Tests E2E de P006 : compte à rebours, bannières de checkpoint, pauses.
 *
 * Le mode test est utilisé dès qu'une course entière doit être observée : à ×20, les deux checkpoints
 * et l'arrivée tiennent en une dizaine de secondes, alors qu'une course normale dure 60 s simulées,
 * plus deux pauses de 3 s et le compte à rebours. Le compte à rebours, lui, se vérifie **en mode
 * normal**, puisque c'est précisément le seul mode où il existe.
 */

/** Pas et distances figés, lus dans la même évaluation pour qu'ils soient cohérents entre eux. */
async function readFreeze(page: Page): Promise<{ steps: number; distances: number[] }> {
  await waitForHooks(page);
  return page.evaluate(() => {
    const api = window.__CHAOS_RACE__;
    if (api === undefined) {
      throw new Error('hooks absents');
    }
    const state = api.state();
    return { steps: state.steps, distances: state.characters.map((character) => character.x) };
  });
}

test('le compte à rebours est visible en mode normal, et rien n’avance pendant', async ({ page }) => {
  const watch = watchConsole(page);
  await page.goto(raceUrl({ seed: OVERTAKE_SEED }));

  const status = page.getByTestId('race-status');
  await expect(status).toHaveText('En attente du départ');
  await expect(page.getByTestId('checkpoint-banner')).toBeHidden();

  await page.getByTestId('start-button').click();
  await expect(status).toHaveText('Départ imminent');
  // Pendant le compte à rebours, la course n'a pas commencé : aucun pas, aucune bannière.
  expect(await currentSteps(page)).toBe(0);

  await expect(status).toHaveText('Course en cours', { timeout: 10_000 });
  await expect.poll(() => currentSteps(page), { timeout: 10_000 }).toBeGreaterThan(0);

  expectNoErrors(watch);
});

test('le mode test n’a aucun compte à rebours', async ({ page }) => {
  const watch = watchConsole(page);
  await page.goto(raceUrl({ seed: OVERTAKE_SEED, fast: true, autostart: true }));

  // Aucune phase de départ : la course est déjà en cours au premier rendu utile.
  await expect(page.getByTestId('race-status')).toHaveText('Course en cours');
  await expect.poll(() => currentSteps(page), { timeout: 10_000 }).toBeGreaterThan(0);

  expectNoErrors(watch);
});

test('les deux bannières de checkpoint apparaissent puis disparaissent', async ({ page }) => {
  const watch = watchConsole(page);
  await page.goto(raceUrl({ seed: OVERTAKE_SEED, fast: true, autostart: true }));

  // Une course entière, un échantillon par frame : aucune bannière ne peut passer inaperçue.
  const samples = await collectRace(page, 6000);
  const last = samples[samples.length - 1];
  expect(last, 'la course doit être allée au bout').toBeDefined();
  expect(last?.phase).toBe('finished');

  const pauses = samples.filter((sample) => sample.simPhase === 'checkpointPause');
  expect(pauses.length, 'les deux pauses doivent être observées').toBeGreaterThan(0);

  // Les pauses se succèdent dans l'ordre 1, 2 — chacune sur plusieurs frames. Une troisième
  // apparition signifierait qu'un checkpoint a été inventé : la course de 60 s n'en compte que deux.
  const numbers: number[] = [];
  for (const sample of pauses) {
    if (numbers[numbers.length - 1] !== sample.checkpoint) {
      numbers.push(sample.checkpoint ?? -1);
    }
  }
  expect(numbers).toEqual([1, 2]);

  for (const sample of pauses) {
    const number = sample.checkpoint ?? 0;
    expect(sample.bannerHidden, 'bannière visible pendant la pause').toBe(false);
    // Le titre porte le numéro du checkpoint **et** l'instant de la borne (20 / 40 s), pris dans le
    // noyau : c'est ce qui rend le bandeau utile, au-delà du simple numéro. Le mot employé est bien
    // « Checkpoint » — la passe corrective a retiré « Pointage », qui n'était pas naturel.
    expect(sample.banner).toContain(`Checkpoint ${String(number)}`);
    expect(sample.banner).not.toContain('Pointage');
    // `\u00A0` : l'espace insécable est celle des formateurs du HUD, et elle évite un retour à la
    // ligne entre le nombre et son unité.
    expect(sample.banner).toContain(
      `· ${String(number * RACE_CONFIG.SEGMENT_DURATION_S)}\u00A0s`,
    );
  }

  // Hors pause, elle est masquée et vide : elle ne reste jamais affichée en cours de segment.
  const outside = samples.filter((sample) => sample.simPhase !== 'checkpointPause');
  expect(outside.length).toBeGreaterThan(0);
  for (const sample of outside) {
    expect(sample.bannerHidden).toBe(true);
    expect(sample.banner).toBe('');
  }

  // Aucune pause n'est un flash d'une seule frame, et la course ne s'arrête jamais sur la dernière.
  for (const number of [1, 2]) {
    const visible = pauses.filter((sample) => sample.checkpoint === number);
    expect(visible.length, `bannière ${number} visible assez longtemps`).toBeGreaterThan(3);
  }
  expect(last?.steps).toBe(RACE_CONFIG.TOTAL_STEPS);
  expect(last?.tSim).toBe(RACE_CONFIG.TOTAL_SIM_S);

  expectNoErrors(watch);
});

test('Espace suspend la course — distances figées — puis la reprend', async ({ page }) => {
  const watch = watchConsole(page);
  await page.goto(raceUrl({ seed: OVERTAKE_SEED, fast: true, autostart: true }));
  await expect.poll(() => currentSteps(page), { timeout: 15_000 }).toBeGreaterThan(50);

  await page.keyboard.press('Space');
  await expect(page.getByTestId('race-status')).toHaveText('En pause');
  await expect(page.getByTestId('pause-button')).toHaveText('Reprendre');

  const frozen = await readFreeze(page);
  await page.waitForTimeout(1200);
  const afterWait = await readFreeze(page);

  // Rien n'a bougé : ni le nombre de pas, ni une seule distance, au bit près.
  expect(afterWait.steps).toBe(frozen.steps);
  expect(afterWait.distances).toEqual(frozen.distances);
  await expect(page.getByTestId('race-status')).toHaveText('En pause');

  await page.keyboard.press('Space');
  await expect(page.getByTestId('race-status')).toHaveText('Course en cours');
  await expect(page.getByTestId('pause-button')).toHaveText('Pause');
  await expect.poll(() => currentSteps(page), { timeout: 10_000 }).toBeGreaterThan(frozen.steps);

  // Le bouton fait exactement la même chose que la touche.
  await page.getByTestId('pause-button').click();
  await expect(page.getByTestId('race-status')).toHaveText('En pause');
  const buttonFrozen = await readFreeze(page);
  await page.waitForTimeout(600);
  expect((await readFreeze(page)).steps).toBe(buttonFrozen.steps);

  await page.getByTestId('pause-button').click();
  await expect(page.getByTestId('race-status')).toHaveText('Course en cours');

  expectNoErrors(watch);
});

test('la course se termine normalement malgré une pause utilisateur au milieu', async ({ page }) => {
  const watch = watchConsole(page);
  await page.goto(raceUrl({ seed: OVERTAKE_SEED, fast: true, autostart: true }));

  // Une pause franche en pleine course, puis on laisse aller au bout.
  await expect.poll(() => currentSteps(page), { timeout: 15_000 }).toBeGreaterThan(100);
  await page.keyboard.press('Space');
  await expect(page.getByTestId('race-status')).toHaveText('En pause');
  await page.waitForTimeout(500);
  await page.keyboard.press('Space');
  await expect(page.getByTestId('race-status')).toHaveText('Course en cours');

  await expect
    .poll(() => currentSteps(page), { timeout: 40_000 })
    .toBe(RACE_CONFIG.TOTAL_STEPS);
  await expect(page.getByTestId('race-status')).toHaveText('Course terminée');

  // 3 600 pas exactement, et le résultat est celui du noyau seul : la pause n'a rien changé.
  const final = await readFreeze(page);
  expect(final.steps).toBe(RACE_CONFIG.TOTAL_STEPS);
  expect(final.distances).toEqual(await referenceDistances(page, OVERTAKE_SEED));

  expectNoErrors(watch);
});
