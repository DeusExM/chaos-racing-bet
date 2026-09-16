import { expect, test } from '@playwright/test';

import { CHARACTER_IDS } from '../../src/core/characters';
import { RACE_CONFIG } from '../../src/core/config';
import { OvertakeTracker } from '../../src/core/overtakes';
import { computeRanks, isLeaderChange } from '../../src/core/ranking';
import { VIEW } from '../../src/render/viewConfig';
import { OVERTAKE_SEED } from '../fixtures/seeds';
import {
  blockMainThread,
  collectRace,
  currentSteps,
  expectNoErrors,
  raceUrl,
  referenceDistances,
  watchConsole,
} from './helpers';

/**
 * Tests E2E de la course visible.
 *
 * Ils tournent contre le build de production, en `?fast=1` : la course dure alors environ 9 secondes
 * réelles au lieu de 3 minutes, sans que cela change un seul chiffre du résultat (c'est justement
 * l'objet de l'un de ces tests).
 *
 * La seed utilisée n'est pas choisie au hasard : elle est mesurée et justifiée dans
 * `tests/fixtures/seeds.ts`, et vérifiée par `tests/unit/raceSeeds.test.ts`.
 */

/** Tolérance sur les grandeurs dérivées du temps réel, jamais sur le résultat de la course. */
const EPSILON = 1e-9;

test('les 6 personnages avancent, dans l’ordre exact des distances', async ({ page }) => {
  const watch = watchConsole(page);
  await page.goto(raceUrl({ seed: OVERTAKE_SEED, fast: true, autostart: true }));

  const samples = await collectRace(page);
  expect(samples.length, 'la course doit durer plusieurs frames').toBeGreaterThan(10);

  const first = samples[0];
  const last = samples[samples.length - 1];
  expect(first, 'au moins un échantillon').toBeDefined();
  expect(last, 'au moins un échantillon').toBeDefined();
  if (first === undefined || last === undefined) {
    return;
  }

  // La course se termine par le temps : exactement 10 800 pas, soit tSim = 180 s.
  expect(last.phase).toBe('finished');
  expect(last.steps).toBe(RACE_CONFIG.TOTAL_STEPS);
  expect(last.tSim).toBe(180);

  // A) Un sprite par personnage, tous présents et distincts.
  const spriteIds = last.sprites.map((sprite) => sprite.id);
  expect(new Set(spriteIds).size).toBe(CHARACTER_IDS.length);
  expect([...spriteIds].sort()).toEqual([...CHARACTER_IDS].sort());

  // B) Chacun a réellement avancé, et jamais reculé : aucune téléportation n'est possible.
  for (let index = 0; index < CHARACTER_IDS.length; index += 1) {
    expect(
      last.distances[index],
      `le personnage ${String(index)} a progressé`,
    ).toBeGreaterThan(first.distances[index] ?? 0);

    for (let s = 1; s < samples.length; s += 1) {
      const previous = samples[s - 1]?.distances[index] ?? 0;
      const current = samples[s]?.distances[index] ?? 0;
      expect(current, `distance jamais décroissante (frame ${String(s)})`).toBeGreaterThanOrEqual(
        previous,
      );
    }
  }

  // G) L'ordre à l'écran est exactement l'ordre des distances : les sprites sont bien positionnés
  // à partir de `x`, et le rendu n'invente aucun classement.
  for (const sample of samples) {
    for (let i = 0; i < CHARACTER_IDS.length; i += 1) {
      for (let j = i + 1; j < CHARACTER_IDS.length; j += 1) {
        const distanceI = sample.distances[i] ?? 0;
        const distanceJ = sample.distances[j] ?? 0;
        if (distanceI === distanceJ) {
          continue;
        }
        const screenI = sample.sprites[i]?.screenX ?? 0;
        const screenJ = sample.sprites[j]?.screenX ?? 0;
        if (distanceI > distanceJ) {
          expect(screenI, 'le plus avancé est le plus à droite').toBeGreaterThan(screenJ);
        } else {
          expect(screenJ, 'le plus avancé est le plus à droite').toBeGreaterThan(screenI);
        }
      }
    }
  }

  // La fenêtre de caméra reste bornée, comme l'exige GAME_DESIGN §5.
  for (const sample of samples) {
    expect(sample.camera.windowM).toBeLessThanOrEqual(VIEW.CAMERA_WINDOW_MAX_M + EPSILON);
    expect(sample.camera.windowM).toBeGreaterThanOrEqual(VIEW.CAMERA_WINDOW_MIN_M - EPSILON);
  }

  expectNoErrors(watch);
});

test('le classement affiché est exactement celui du noyau', async ({ page }) => {
  const watch = watchConsole(page);
  await page.goto(raceUrl({ seed: OVERTAKE_SEED, fast: true, autostart: true }));

  const samples = await collectRace(page);
  expect(samples.length).toBeGreaterThan(10);

  // Le HUD et l'état du noyau sont lus dans la même frame : la comparaison porte donc sur toutes
  // les frames de la course, pas sur quelques instants choisis.
  let comparedFrames = 0;
  for (const sample of samples) {
    expect(sample.hud.length, 'six lignes affichées').toBe(CHARACTER_IDS.length);
    expect(sample.hud.map((row) => row.id), 'même ordre que le noyau').toEqual(
      sample.ranks.map((row) => row.id),
    );
    expect(sample.hud.map((row) => row.rank), 'mêmes rangs que le noyau').toEqual(
      sample.ranks.map((row) => row.rank),
    );

    for (const row of sample.hud) {
      const expected = sample.ranks.find((candidate) => candidate.id === row.id);
      expect(expected, `le noyau connaît ${row.id}`).toBeDefined();
      expect(row.name.length, 'le nom est affiché').toBeGreaterThan(0);
      // L'écart est affiché arrondi au dixième de mètre : on tolère un demi-dixième.
      const displayed = Number(row.gapText.replace(',', '.').replace(/[^0-9.]/g, ''));
      expect(
        Math.abs(displayed - (expected?.gapMeters ?? 0)),
        `écart affiché pour ${row.id} (frame ${String(sample.steps)})`,
      ).toBeLessThanOrEqual(0.051);
    }
    comparedFrames += 1;
  }

  expect(comparedFrames, 'toutes les frames ont été comparées').toBe(samples.length);
  expectNoErrors(watch);
});

test('des dépassements réels sont observés pendant la course', async ({ page }) => {
  const watch = watchConsole(page);
  await page.goto(raceUrl({ seed: OVERTAKE_SEED, fast: true, autostart: true }));

  const samples = await collectRace(page);
  expect(samples.length).toBeGreaterThan(10);

  // Le décompte est fait ici, par le test, avec `core/overtakes.ts` — celui-là même que P009
  // utilisera. Un classement parallèle côté rendu ne pourrait pas tromper ce test.
  const firstSample = samples[0];
  expect(firstSample).toBeDefined();
  if (firstSample === undefined) {
    return;
  }

  let previousRanks = computeRanks(firstSample.distances, CHARACTER_IDS);
  const tracker = new OvertakeTracker();
  let leaderChanges = 0;
  let overtakes = 0;

  for (let s = 1; s < samples.length; s += 1) {
    const sample = samples[s];
    if (sample === undefined) {
      continue;
    }
    const ranks = computeRanks(sample.distances, CHARACTER_IDS);
    if (isLeaderChange(previousRanks, ranks)) {
      leaderChanges += 1;
    }
    overtakes += tracker.observe(sample.distances, CHARACTER_IDS).length;
    previousRanks = ranks;
  }

  expect(leaderChanges, 'au moins un changement de leader visible').toBeGreaterThanOrEqual(1);
  expect(overtakes, 'au moins trois dépassements visibles').toBeGreaterThanOrEqual(3);

  expectNoErrors(watch);
});

test('le mode accéléré ne change pas le résultat de la course', async ({ page }) => {
  const watch = watchConsole(page);
  await page.goto(raceUrl({ seed: OVERTAKE_SEED, fast: true, autostart: true }));

  const samples = await collectRace(page);
  const last = samples[samples.length - 1];
  expect(last, 'la course doit être allée au bout').toBeDefined();
  if (last === undefined) {
    return;
  }
  expect(last.phase).toBe('finished');
  expect(last.steps).toBe(RACE_CONFIG.TOTAL_STEPS);

  const reference = await referenceDistances(page, OVERTAKE_SEED);
  expect([...last.distances], 'résultat identique à la course de référence').toEqual(reference);

  expectNoErrors(watch);
});

test('un gel du navigateur de 2 secondes ne change ni le résultat ni le nombre de pas', async ({
  page,
}) => {
  const watch = watchConsole(page);
  await page.goto(raceUrl({ seed: OVERTAKE_SEED, fast: true, autostart: true }));

  await expect.poll(() => currentSteps(page), { timeout: 15_000 }).toBeGreaterThan(0);

  // Gel réel du thread principal, en pleine course. Aucun pas ne peut avancer pendant ce temps :
  // c'est vérifié à l'intérieur même du blocage.
  await blockMainThread(page, 2000);

  const samples = await collectRace(page);
  const last = samples[samples.length - 1];
  expect(last, 'la course doit être allée au bout').toBeDefined();
  if (last === undefined) {
    return;
  }

  // Aucun pas n'est perdu, aucun n'est compté deux fois.
  expect(last.steps).toBe(RACE_CONFIG.TOTAL_STEPS);
  expect(last.tSim).toBe(180);

  const reference = await referenceDistances(page, OVERTAKE_SEED);
  expect([...last.distances], 'résultat identique malgré le gel').toEqual(reference);

  expectNoErrors(watch);
});
