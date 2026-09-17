import { defineConfig } from 'vite';

import { DEV_HOST, DEV_PORT, PREVIEW_HOST, PREVIEW_PORT } from './dev-ports';

// P001 : configuration minimale. Le plugin PWA (vite-plugin-pwa) est deja installe
// mais n'est volontairement PAS active ici : son branchement appartient a P016.
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
  },
  server: {
    // Hote explicitement local : jamais 0.0.0.0, aucun acces depuis un autre appareil.
    // Sans cela, `localhost` peut se resoudre en ::1 et le test E2E, qui interroge
    // 127.0.0.1, ne voit jamais le serveur.
    // Hote et port lus dans `dev-ports.ts` : convention 18000-18999, hors des plages que
    // Windows reserve dynamiquement autour de 4000/5000 (bind -> EACCES).
    host: DEV_HOST,
    port: DEV_PORT,
    strictPort: true,
  },
  preview: {
    // Port partage avec `playwright.config.ts` via `dev-ports.ts` : les tests E2E interrogent
    // exactement l'URL servie ici. Voir `dev-ports.ts` pour le choix de la plage 18000-18999.
    host: PREVIEW_HOST,
    port: PREVIEW_PORT,
    strictPort: true,
  },
});
