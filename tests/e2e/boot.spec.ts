import { expect, test } from '@playwright/test';

/**
 * Test fumigène de P001 : la page se charge, le titre est affiché, Phaser monte un canvas
 * et rien n'échoue. Les E2E tournent contre le build de production servi par `vite preview`.
 */
test('la page charge, affiche le titre et monte un canvas Phaser sans erreur', async ({ page }) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const failedRequests: string[] = [];
  const errorResponses: string[] = [];

  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('requestfailed', (request) => {
    failedRequests.push(`${request.method()} ${request.url()} — ${request.failure()?.errorText ?? '?'}`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400) {
      errorResponses.push(`${response.status()} ${response.url()}`);
    }
  });

  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Chaos Race' })).toBeVisible();

  const gameArea = page.locator('#game');
  await expect(gameArea).toBeVisible();

  const canvas = gameArea.locator('canvas');
  await expect(canvas).toBeVisible();

  // Le canvas doit avoir une taille réelle : un canvas 0x0 signalerait un montage raté.
  const box = await canvas.boundingBox();
  expect(box, 'le canvas doit être mesurable').not.toBeNull();
  expect(box?.width ?? 0).toBeGreaterThan(0);
  expect(box?.height ?? 0).toBeGreaterThan(0);

  // Phaser crée le contexte de rendu de façon asynchrone.
  await page.waitForTimeout(500);

  expect(pageErrors, `erreurs JavaScript : ${pageErrors.join(' | ')}`).toEqual([]);
  expect(consoleErrors, `erreurs console : ${consoleErrors.join(' | ')}`).toEqual([]);
  expect(failedRequests, `requêtes échouées : ${failedRequests.join(' | ')}`).toEqual([]);
  expect(errorResponses, `réponses HTTP en erreur : ${errorResponses.join(' | ')}`).toEqual([]);
});
