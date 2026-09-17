import { expect, test } from '@playwright/test';

import { CHARACTER_IDS } from '../../src/core/characters';
import { OVERTAKE_SEED } from '../fixtures/seeds';
import {
  currentSteps,
  expectNoErrors,
  raceUrl,
  readLeaderboard,
  watchConsole,
} from './helpers';

/**
 * Tests E2E de l'interface : boutons, debug, responsive.
 *
 * Ils ne font pas courir la course jusqu'au bout quand ce n'est pas nécessaire — la seule chose qui
 * compte ici est le comportement de l'interface, pas le résultat de la course.
 */

test('Lancer démarre la course, Rejouer la reprend depuis le début avec la même seed', async ({
  page,
}) => {
  const watch = watchConsole(page);
  await page.goto(raceUrl({ seed: OVERTAKE_SEED }));

  // Sans ?autostart, la course attend : rien n'avance.
  await expect(page.getByTestId('race-status')).toHaveText('En attente du départ');
  await page.waitForTimeout(400);
  expect(await currentSteps(page)).toBe(0);

  await page.getByTestId('start-button').click();
  // P006 : `start()` ouvre d'abord le compte à rebours réel, puis la course démarre seule.
  await expect(page.getByTestId('race-status')).toHaveText('Départ imminent');
  await expect(page.getByTestId('race-status')).toHaveText('Course en cours');
  await expect.poll(() => currentSteps(page), { timeout: 10_000 }).toBeGreaterThan(0);

  // On attend d'avoir assez de pas pour que la remise à zéro soit sans ambiguïté.
  await expect.poll(() => currentSteps(page), { timeout: 15_000 }).toBeGreaterThan(300);
  const beforeReplay = await currentSteps(page);

  await page.getByTestId('replay-button').click();
  await expect.poll(() => currentSteps(page), { timeout: 10_000 }).toBeLessThan(beforeReplay);

  // La seed affichée n'a pas changé : « Rejouer » rejoue la même course, compte à rebours compris.
  await expect(page.getByTestId('seed-value')).toHaveText(OVERTAKE_SEED);
  await expect(page.getByTestId('race-status')).toHaveText('Départ imminent');

  expectNoErrors(watch);
});

test('?debug=1 affiche le panneau de debug, absent sans le paramètre', async ({ page }) => {
  const watch = watchConsole(page);
  await page.goto(raceUrl({ seed: OVERTAKE_SEED, debug: true, autostart: true }));

  const panel = page.getByTestId('debug');
  await expect(panel).toBeVisible();

  const body = page.getByTestId('debug-body');
  await expect(body).toContainText(OVERTAKE_SEED);
  await expect(body).toContainText('temps simulé');

  // Les 6 personnages doivent y apparaître, avec leurs distances.
  for (const id of CHARACTER_IDS) {
    await expect(body).toContainText(id);
  }

  await expect.poll(() => currentSteps(page), { timeout: 10_000 }).toBeGreaterThan(0);
  await expect(body).toContainText('pas :');

  // Sans le paramètre, le panneau reste masqué.
  await page.goto(raceUrl({ seed: OVERTAKE_SEED, autostart: true }));
  await expect(page.getByTestId('debug')).toBeHidden();

  expectNoErrors(watch);
});

test('la seed affichée reste conforme au contrat P003', async ({ page }) => {
  await page.goto(raceUrl({ seed: OVERTAKE_SEED }));
  await expect(page.getByTestId('seed-value')).toHaveText(OVERTAKE_SEED);

  const url = new URL(page.url());
  expect(url.searchParams.get('seed')).toBe(OVERTAKE_SEED);
  expect(url.searchParams.get('e2e')).toBe('1');
});

const VIEWPORTS = [
  { name: 'bureau 1440×900', width: 1440, height: 900 },
  { name: 'bureau 1280×720', width: 1280, height: 720 },
  { name: 'téléphone paysage 844×390', width: 844, height: 390 },
];

for (const viewport of VIEWPORTS) {
  test(`le canvas et le classement restent lisibles en ${viewport.name}`, async ({ page }) => {
    const watch = watchConsole(page);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto(raceUrl({ seed: OVERTAKE_SEED, fast: true, autostart: true }));

    const canvas = page.locator('#game canvas');
    await expect(canvas).toBeVisible();

    const box = await canvas.boundingBox();
    expect(box, 'le canvas doit être mesurable').not.toBeNull();
    expect(box?.width ?? 0).toBeGreaterThan(100);
    expect(box?.height ?? 0).toBeGreaterThan(60);

    // L'arène ne déborde jamais de la fenêtre : rien n'est rogné.
    expect(box?.width ?? 0).toBeLessThanOrEqual(viewport.width + 1);
    expect(box?.height ?? 0).toBeLessThanOrEqual(viewport.height + 1);

    // Le classement est en HTML : il reste lisible même quand le canvas est réduit.
    await expect.poll(async () => (await readLeaderboard(page)).length, { timeout: 10_000 }).toBe(
      CHARACTER_IDS.length,
    );

    const rows = page.locator('[data-testid="leaderboard-row"]');
    // Passe corrective 2 : en téléphone paysage, le classement permanent est **masqué pendant la
    // course** (la piste occupe alors toute la largeur). Les lignes restent dans le DOM, donc le
    // classement de l'écran d'arrivée reste complet — c'est le panneau qui est caché, pas la donnée.
    const compact = await page.evaluate(
      () => window.__CHAOS_RACE_VIEW__?.track().compact ?? false,
    );
    if (compact) {
      await expect(page.getByTestId('leaderboard')).toBeHidden();
    } else {
      await expect(rows.first()).toBeVisible();
    }

    const fontSize = await rows.first().evaluate((element) => {
      return Number.parseFloat(getComputedStyle(element).fontSize);
    });
    expect(fontSize, 'le classement doit rester lisible').toBeGreaterThanOrEqual(9);

    for (const row of await readLeaderboard(page)) {
      expect(row.name.length, 'chaque ligne porte un nom').toBeGreaterThan(0);
      expect(row.rank).toBeGreaterThanOrEqual(1);
    }

    expectNoErrors(watch);
  });
}
