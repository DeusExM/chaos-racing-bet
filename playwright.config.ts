import { defineConfig, devices } from '@playwright/test';

import { PREVIEW_URL } from './dev-ports';

// Les navigateurs sont installes dans `.playwright-browsers`, localement au projet.
// La variable PLAYWRIGHT_BROWSERS_PATH ne peut PAS etre posee ici : playwright-core
// l'evalue une seule fois au chargement de son module, avant la lecture de ce fichier.
// Elle est fournie par les scripts npm via `node --env-file=.playwright.env`
// (voir package.json, README.md et .playwright.env).

// URL servie par `vite preview` (voir `vite.config.ts`) : meme source unique, `dev-ports.ts`.
const BASE_URL = PREVIEW_URL;

export default defineConfig({
  testDir: './tests/e2e',

  // Tous les artefacts restent dans le projet (aucune ecriture dans AppData).
  outputDir: './test-results',

  fullyParallel: true,

  // Interdit test.only : un test desactive en douce ne doit jamais passer inapercu.
  forbidOnly: true,

  retries: 0,
  workers: 1,

  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],

  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
  },

  projects: [
    {
      name: 'desktop-chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
  ],

  // Les E2E tournent contre le build de production servi par `vite preview`,
  // ce qui verifie du meme coup que `npm run build` produit un dist/ utilisable.
  webServer: {
    command: 'npm run build && npm run preview',
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
