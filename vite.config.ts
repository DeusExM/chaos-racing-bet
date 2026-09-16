import { defineConfig } from 'vite';

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
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
  },
});
