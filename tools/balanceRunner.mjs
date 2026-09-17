/**
 * Lanceur de `tools/balance.ts` — `npm run balance -- --seeds=1000`.
 *
 * **Pourquoi ce lanceur existe.** Le projet est en TypeScript avec `moduleResolution: "bundler"` :
 * imports sans extension, propriétés de constructeur (`constructor(private readonly x: T)`). Node 26
 * exécute bien un `.ts` (type-stripping intégré), mais refuse ces deux formes — la première parce
 * qu'il n'invente pas les extensions, la seconde parce que le mode « strip-only » n'accepte pas la
 * syntaxe qui **émet** du code. Déformer le code de production (`src/core/**`, `src/speaker/**`) pour
 * satisfaire un outil de développement serait la mauvaise réponse.
 *
 * Ce lanceur demande donc à **Vite** — dépendance déjà validée — de charger le harnais dans son
 * runtime SSR : Vite transforme le TypeScript à la volée et résout les imports exactement comme il le
 * fait pour l'application et pour Vitest. Aucune dépendance n'est ajoutée, aucun artefact n'est
 * committé, et **aucun serveur n'est exposé** : le serveur Vite est créé en mémoire
 * (`middlewareMode`, `listen: false`, `server.hmr: false`), ne surveille aucun fichier et n'ouvre
 * aucun port.
 *
 * Le harnais ne charge que `src/core/**` et `src/speaker/**` : il ne peut donc pas dépendre de
 * Phaser, du DOM ou du rendu.
 *
 * **Rapport JSON.** `tools/balance.ts` est compilé par `tsc`, qui n'a pas `@types/node` dans ce
 * projet : le harnais n'a donc le droit de toucher ni `fs` ni `process`. C'est ce lanceur — du
 * JavaScript pur, hors `tsc` — qui écrit sur disque le rapport structuré rendu par
 * `runBalanceWithReport()` quand `--json` est demandé. Le harnais reste ainsi pur et testable, et
 * l'écriture de fichier reste dans la couche Node.
 *
 * Usage : `node tools/balanceRunner.mjs --seeds=1000`.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(here, '..');
const entry = resolve(here, process.env.CHAOS_RACE_MODULE ?? 'balance.ts');
/** Nom de l'export attendu dans le module chargé. */
const exportName = process.env.CHAOS_RACE_EXPORT ?? 'runBalanceWithReport';

/**
 * Écrit le rapport structuré, si la campagne en a produit un.
 *
 * Le chemin vient du harnais lui-même (`--json=<chemin>`), donc le lanceur n'a pas à re-analyser la
 * ligne de commande. Les dossiers manquants sont créés : `.tmp/` est ignoré par git.
 */
function writeReport(result) {
  if (result === null || typeof result !== 'object' || result.report === null) {
    return;
  }
  const path = result.jsonPath ?? '.tmp/balance-report.json';
  const directory = dirname(path);
  if (directory.length > 0 && directory !== '.') {
    mkdirSync(directory, { recursive: true });
  }
  writeFileSync(path, `${JSON.stringify(result.report, null, 2)}\n`, 'utf8');
  console.log(`\nRapport structuré écrit dans ${path}`);
}

async function main() {
  const { createServer } = await import('vite');

  const server = await createServer({
    configFile: false,
    root: repositoryRoot,
    logLevel: 'warn',
    appType: 'custom',
    // Aucune exposition réseau, aucun watcher, aucun HMR : uniquement le transformateur TypeScript.
    server: { middlewareMode: true, hmr: false, watch: null, open: false, host: '127.0.0.1' },
  });

  try {
    const module = await server.ssrLoadModule(entry);
    if (exportName === 'none') {
      return;
    }
    if (typeof module[exportName] !== 'function') {
      throw new TypeError(`Le module ${entry} n’expose pas ${exportName}().`);
    }
    const result = module[exportName](process.argv.slice(2));
    // `runBalanceCli()` rend un code de sortie ; `runBalanceWithReport()` rend le code **et** le
    // rapport structuré, que ce lanceur — seul à connaître `fs` — écrit sur disque.
    if (typeof result === 'number') {
      process.exitCode = result;
      return;
    }
    writeReport(result);
    process.exitCode = result.exitCode;
  } finally {
    await server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
