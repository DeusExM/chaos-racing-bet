import { expect, test } from '@playwright/test';

import { CHARACTER_IDS } from '../../src/core/characters';
import { RACE_CONFIG } from '../../src/core/config';
import { OVERTAKE_SEED } from '../fixtures/seeds';
import {
  currentSteps,
  expectNoErrors,
  raceUrl,
  readFinishCore,
  readLeaderboard,
  referenceResult,
  waitForFinished,
  watchConsole,
} from './helpers';

/**
 * Tests E2E de l'interface : boutons, debug, responsive.
 *
 * Ils ne font pas courir la course jusqu'au bout quand ce n'est pas nécessaire — la seule chose qui
 * compte ici est le comportement de l'interface, pas le résultat de la course.
 */

test('Lancer démarre la course, Réinitialiser interrompt et repart sur une nouvelle seed', async ({
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
  const beforeReset = await currentSteps(page);

  await page.getByTestId('reset-button').click();

  // 1) La course repart **réellement** de zéro : le compteur de pas retombe à zéro.
  await expect.poll(() => currentSteps(page), { timeout: 10_000 }).toBe(0);
  expect(beforeReset).toBeGreaterThan(0);

  // 2) Réinitialiser ne démarre **jamais** la course : l'état revient en attente, et rien n'avance.
  await expect(page.getByTestId('race-status')).toHaveText('En attente du départ');
  await page.waitForTimeout(600);
  expect(await currentSteps(page), 'aucun pas ne doit être joué après un reset').toBe(0);

  // 3) Une **nouvelle** seed a été tirée : elle diffère de la précédente, et elle est valide.
  const seedAfter = await page.getByTestId('seed-value').textContent();
  expect(seedAfter, 'la seed affichée a changé').not.toBe(OVERTAKE_SEED);
  expect(seedAfter, 'la nouvelle seed respecte le contrat P003').toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);

  // 4) L'URL est synchronisée avec la seed réellement configurée : recopier l'adresse reproduit la course.
  const url = new URL(page.url());
  expect(url.searchParams.get('seed'), 'l’URL porte la nouvelle seed').toBe(seedAfter);

  // 5) Le noyau joue bien cette nouvelle seed, et la course repart quand on le lui demande.
  const coreSeed = await page.evaluate(() => window.__CHAOS_RACE__?.seed() ?? '');
  expect(coreSeed).toBe(seedAfter);
  await expect(page.getByTestId('start-button')).toBeEnabled();
  await page.getByTestId('start-button').click();
  await expect.poll(() => currentSteps(page), { timeout: 15_000 }).toBeGreaterThan(0);

  expectNoErrors(watch);
});

test('Rejouer la même seed, sur l’écran d’arrivée, garde exactement la même course', async ({
  page,
}) => {
  const watch = watchConsole(page);
  await page.goto(raceUrl({ seed: OVERTAKE_SEED, fast: true, autostart: true }));
  await waitForFinished(page);

  // Résultat de référence de cette seed, calculé par le noyau seul, sans aucun rendu.
  const reference = await referenceResult(page, OVERTAKE_SEED);

  await page.getByTestId('finish-replay-same').click();

  // La course repart réellement de zéro — le compteur de pas retombe — et la seed ne change pas.
  await expect
    .poll(() => currentSteps(page), { timeout: 15_000 })
    .toBeLessThan(RACE_CONFIG.TOTAL_STEPS);
  await expect(page.getByTestId('seed-value')).toHaveText(OVERTAKE_SEED);

  // Elle se termine exactement comme la référence : même seed, donc même course, bit à bit.
  await waitForFinished(page);
  const replayed = await readFinishCore(page);
  expect(replayed.seed).toBe(OVERTAKE_SEED);
  expect(replayed.steps).toBe(RACE_CONFIG.TOTAL_STEPS);
  expect([...replayed.distances]).toEqual(reference.distances);
  expect(replayed.ranks.map((row) => row.id)).toEqual(reference.ranking);

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
    // Passe responsive iPhone : en téléphone paysage, le classement permanent vit dans la **colonne
    // de droite**, à côté de la piste — il n'est plus masqué, et il n'a plus besoin de l'être puisque
    // la piste ne passe jamais dessous.
    const compact = await page.evaluate(
      () => window.__CHAOS_RACE_VIEW__?.track().compact ?? false,
    );
    if (compact) {
      await expect(page.getByTestId('leaderboard')).toBeVisible();
      // La colonne est à droite de la piste : les deux zones sont disjointes.
      const canvasBox = await canvas.boundingBox();
      const panelBox = await page.getByTestId('leaderboard').boundingBox();
      expect(panelBox?.x ?? 0, 'le classement commence après la piste').toBeGreaterThanOrEqual(
        (canvasBox?.x ?? 0) + (canvasBox?.width ?? 0) - 1,
      );
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
