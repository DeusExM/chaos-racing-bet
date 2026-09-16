import { expect, test } from '@playwright/test';

/** Alphabet Base32 Crockford : ni I, ni L, ni O, ni U. */
const SEED_PATTERN = /^[0-9A-HJKMNP-TV-Z]{8}$/;

test("la seed de l'URL est affichée et survit au rechargement", async ({ page }) => {
  await page.goto('/?seed=K7QM2X9A');

  const seed = page.getByTestId('seed-value');
  await expect(seed).toHaveText('K7QM2X9A');

  await page.reload();
  await expect(seed).toHaveText('K7QM2X9A');
  expect(new URL(page.url()).searchParams.get('seed')).toBe('K7QM2X9A');
});

test('sans seed dans l’URL, une seed est tirée puis conservée au rechargement', async ({ page }) => {
  await page.goto('/');

  const seed = page.getByTestId('seed-value');
  await expect(seed).toHaveText(SEED_PATTERN);

  const generated = (await seed.textContent()) ?? '';
  expect(generated).toMatch(SEED_PATTERN);
  expect(new URL(page.url()).searchParams.get('seed')).toBe(generated);

  await page.reload();
  await expect(seed).toHaveText(generated);
});

test('une seed libre est acceptée telle quelle', async ({ page }) => {
  await page.goto('/?seed=hello%20world');

  await expect(page.getByTestId('seed-value')).toHaveText('hello world');
});
