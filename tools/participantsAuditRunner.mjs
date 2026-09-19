/**
 * Lanceur de `tools/participantsAudit.ts` — `npm run balance:participants`.
 *
 * Même raison d'être que `tools/leaderAuditRunner.mjs` : le projet est en TypeScript avec
 * `moduleResolution: "bundler"`, une forme que le *type-stripping* de Node refuse. Vite — dépendance
 * déjà validée — charge donc le module dans son runtime SSR, sans serveur exposé, sans watcher et
 * sans port.
 *
 * Le module d'audit n'importe rien de Node (pas de `@types/node` dans ce projet) : c'est ce lanceur,
 * du JavaScript pur hors `tsc`, qui écrit les deux rapports sur disque — le JSON structuré pour la
 * machine, le texte compact pour l'humain — dans `.tmp/`, ignoré par git.
 *
 * Usage : `npm run balance:participants -- --races=2000`.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(here, '..');

/** Écrit un fichier en créant son dossier si besoin. */
function write(path, contents) {
  const directory = dirname(path);
  if (directory.length > 0 && directory !== '.') {
    mkdirSync(directory, { recursive: true });
  }
  writeFileSync(path, contents, 'utf8');
}

async function main() {
  const { createServer } = await import('vite');

  const server = await createServer({
    configFile: false,
    root: repositoryRoot,
    logLevel: 'warn',
    appType: 'custom',
    server: { middlewareMode: true, hmr: false, watch: null, open: false, host: '127.0.0.1' },
  });

  try {
    const module = await server.ssrLoadModule(resolve(here, 'participantsAudit.ts'));
    if (typeof module.runParticipantsAuditWithReport !== 'function') {
      throw new TypeError('tools/participantsAudit.ts n’expose pas runParticipantsAuditWithReport().');
    }
    const result = module.runParticipantsAuditWithReport(process.argv.slice(2));
    console.log('');
    console.log(result.text);
    if (result.textPath.length > 0) {
      write(result.textPath, `${result.text}\n`);
      write(result.jsonPath, `${JSON.stringify(result.report, null, 2)}\n`);
      console.log('');
      console.log(`Rapport texte  : ${result.textPath}`);
      console.log(`Rapport JSON   : ${result.jsonPath}`);
    }
    process.exitCode = result.exitCode;
  } finally {
    await server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
