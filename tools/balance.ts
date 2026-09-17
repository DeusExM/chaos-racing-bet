/**
 * Ligne de commande du harnais d'équilibrage (P010) : `npm run balance -- --seeds=1000`.
 *
 * Aucun navigateur, aucun Phaser, aucun DOM : uniquement le noyau (`src/core/**`) et la discipline
 * de parole (`src/speaker/**`). Le harnais ne modifie **aucun** état du jeu : il mesure un corpus
 * déterministe et imprime un résumé compact des critères de `GAME_DESIGN.md` §13, suivi des
 * métriques de diagnostic.
 *
 * Avec `--json=<chemin>`, il produit **en plus** un rapport structuré (clés ASCII) : une campagne de
 * 1000 seeds coûte une minute, et un résultat perdu par un terminal tronqué coûte une campagne. La
 * table française reste la sortie destinée à l'humain ; le JSON est la source de `docs/balance-report.md`.
 *
 * Ce module **n'écrit aucun fichier** : il n'importe rien de Node (le projet n'a pas `@types/node`,
 * et le harnais doit rester compilable par `tsc`). C'est `tools/balanceRunner.mjs` — du JavaScript
 * exécuté par Node, hors `tsc` — qui écrit le rapport sur disque quand `--json` est demandé.
 *
 * Le corpus dépend uniquement de `--seeds` : `--seeds=1000` rejoue toujours exactement les mêmes
 * 1000 courses, et le corpus de 300 est le préfixe de celui de 1000.
 *
 * Ce module est exécuté par `tools/balanceRunner.mjs`, qui compile le TypeScript avec le
 * transformateur de Vite avant de l'importer — voir l'en-tête de ce lanceur pour la raison.
 */

import { CHARACTER_IDS } from '../src/core/characters';
import { DRIFT, GAME_CONFIG, RACE_CONFIG, SPEED, SURGE } from '../src/core/config';
import { EVENT_CATALOG } from '../src/core/events';
import { SPEAKER_POLICY } from '../src/speaker/policy';

import {
  LEADER_CHECK_S,
  SPEAKER_TARGET_MAX,
  SPEAKER_TARGET_MIN,
  balanceCriteria,
  corpusSeeds,
  measureReproducibility,
  runBalanceCampaign,
  type BalanceMetrics,
} from './balanceStats';

/** Options de la ligne de commande, toutes optionnelles. */
export interface CliOptions {
  readonly seeds: number;
  readonly replayCheck: boolean;
  readonly releaseDelayS: number;
  readonly corpusPrefix: string;
  /** Chemin du rapport JSON, ou `null` si l'option n'a pas été demandée. */
  readonly jsonPath: string | null;
}

/** Taille par défaut du corpus : celle de `GAME_DESIGN.md` §13. */
export const DEFAULT_SEEDS = 1000;

/** Seeds rejouées par `--replay-check` : le critère §13 est « 100/100 bit à bit ». */
export const REPLAY_SEEDS = 100;

/** Chemin du rapport JSON quand `--json` est donné sans valeur. */
export const DEFAULT_JSON_PATH = '.tmp/balance-report.json';

const HELP = [
  'Usage : npm run balance -- [options]',
  '',
  `  --seeds=<n>            nombre de seeds du corpus (défaut : ${DEFAULT_SEEDS})`,
  '  --corpus=<prefixe>     préfixe du corpus déterministe (défaut : balance-p010)',
  '  --release-delay-s=<s>  libère une réplique après <s> secondes simulées (défaut : 0, immédiat)',
  `  --json[=<chemin>]      écrit un rapport structuré (défaut : ${DEFAULT_JSON_PATH})`,
  `  --replay-check         rejoue ${REPLAY_SEEDS} seeds deux fois et vérifie l’égalité bit à bit`,
  '',
].join('\n');

/** Analyse les arguments. Lève une `RangeError` explicite sur une entrée invalide. */
export function parseArgs(argv: readonly string[]): CliOptions | 'help' {
  let seeds = DEFAULT_SEEDS;
  let replayCheck = false;
  let releaseDelayS = 0;
  let corpusPrefix = 'balance-p010';
  let jsonPath: string | null = null;

  for (const argument of argv) {
    if (argument.startsWith('--seeds=')) {
      const value = Number.parseInt(argument.slice('--seeds='.length), 10);
      if (!Number.isInteger(value) || value < 1) {
        throw new RangeError(`--seeds attend un entier ≥ 1 (reçu : ${argument}).`);
      }
      seeds = value;
      continue;
    }
    if (argument.startsWith('--json=')) {
      jsonPath = argument.slice('--json='.length);
      if (jsonPath.length === 0) {
        throw new RangeError('--json attend un chemin non vide (ou rien du tout).');
      }
      continue;
    }
    if (argument === '--json') {
      jsonPath = DEFAULT_JSON_PATH;
      continue;
    }
    if (argument.startsWith('--release-delay-s=')) {
      const value = Number.parseFloat(argument.slice('--release-delay-s='.length));
      if (!Number.isFinite(value) || value < 0) {
        throw new RangeError(`--release-delay-s attend un nombre ≥ 0 (reçu : ${argument}).`);
      }
      releaseDelayS = value;
      continue;
    }
    if (argument.startsWith('--corpus=')) {
      corpusPrefix = argument.slice('--corpus='.length);
      continue;
    }
    if (argument === '--replay-check') {
      replayCheck = true;
      continue;
    }
    if (argument === '--help' || argument === '-h') {
      return 'help';
    }
    throw new RangeError(`Argument inconnu : ${argument}.`);
  }

  return { seeds, replayCheck, releaseDelayS, corpusPrefix, jsonPath };
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

function padStart(text: string, width: number): string {
  return text.length >= width ? text : ' '.repeat(width - text.length) + text;
}

function fixed(value: number, digits = 2): string {
  return value.toFixed(digits);
}

function printMetrics(metrics: BalanceMetrics): void {
  const criteria = balanceCriteria(metrics);
  const failed = criteria.filter((criterion) => !criterion.pass);

  console.log('');
  console.log('=== Critères §13 ===');
  for (const criterion of criteria) {
    const mark = criterion.pass ? 'OK   ' : 'ÉCHEC';
    console.log(
      `${mark} ${pad(criterion.label, 34)} ${padStart(criterion.value, 16)}   attendu ${criterion.expected}`,
    );
  }
  console.log(`→ ${criteria.length - failed.length}/${criteria.length} critères conformes.`);

  const gap = metrics.gap1to6;
  console.log('');
  console.log('=== Écarts P1–P6 à tSim = 180 s (m) ===');
  console.log(
    `min ${fixed(gap.min)} | p5 ${fixed(gap.p5)} | p25 ${fixed(gap.p25)} | médiane ${fixed(gap.median)} | ` +
      `moyenne ${fixed(gap.mean)} | p75 ${fixed(gap.p75)} | p95 ${fixed(gap.p95)} | max ${fixed(gap.max)}`,
  );
  console.log(`Écart P1–P2 : médiane ${fixed(metrics.gap1to2.median)} m`);

  console.log('');
  console.log('=== Course ===');
  console.log(
    `changements de leader : moyenne ${fixed(metrics.leaderChangesMean)} ` +
      `(min ${fixed(metrics.leaderChanges.min, 0)}, max ${fixed(metrics.leaderChanges.max, 0)}) | ` +
      `dépassements : moyenne ${fixed(metrics.overtakesMean)} ` +
      `(min ${fixed(metrics.overtakes.min, 0)}, max ${fixed(metrics.overtakes.max, 0)})`,
  );
  console.log(
    `leader à t=${LEADER_CHECK_S} s vainqueur : ${fixed(metrics.leaderAtCheckWinRate)} % | ` +
      `pas par course : ${metrics.steps}${metrics.exactSteps ? ' (constant)' : ' (VARIABLE)'}`,
  );

  console.log('');
  console.log('=== Personnages (vitesse, distance, victoires) ===');
  console.log(
    `${pad('id', 4)}${padStart('vitesse moy.', 14)}${padStart('biais', 10)}${padStart('distance moy.', 15)}` +
      `${padStart('victoires', 11)}${padStart('part', 9)}`,
  );
  for (const [index, id] of CHARACTER_IDS.entries()) {
    const speed = metrics.meanSpeedPerCharacter[index] ?? 0;
    const bias = metrics.speedBiasPercentPerCharacter[index] ?? 0;
    const distance = metrics.meanDistancePerCharacter[index] ?? 0;
    const wins = metrics.winsPerCharacter[index] ?? 0;
    const share = metrics.winRatePerCharacter[index] ?? 0;
    console.log(
      `${pad(id, 4)}${padStart(`${fixed(speed, 4)} m/s`, 14)}` +
        `${padStart(`${bias >= 0 ? '+' : ''}${fixed(bias)} %`, 10)}` +
        `${padStart(`${fixed(distance)} m`, 15)}${padStart(String(wins), 11)}${padStart(`${fixed(share)} %`, 9)}`,
    );
  }
  console.log(
    `SPEED.BASE = ${SPEED.BASE} m/s | biais maximal |·| = ${fixed(metrics.maxAbsSpeedBiasPercent)} % ` +
      `(seuil ±1,5 %)`,
  );

  console.log('');
  console.log('=== Événements ===');
  console.log(
    `par course : ${fixed(metrics.eventsTotalMean)} | par personnage : ` +
      CHARACTER_IDS.map(
        (id, index) => `${id} ${fixed(metrics.eventsPerCharacterMean[index] ?? 0)}`,
      ).join(' | '),
  );
  console.log(
    `part par personnage : ` +
      CHARACTER_IDS.map(
        (id, index) => `${id} ${fixed(metrics.eventsPerCharacterShare[index] ?? 0)} %`,
      ).join(' | '),
  );
  for (const definition of EVENT_CATALOG) {
    console.log(
      `  ${pad(definition.id, 14)}${padStart(`${fixed(metrics.eventsByTypePerRace[definition.id])}/course`, 14)}` +
        `${padStart(`${fixed(metrics.eventsByTypeShare[definition.id])} %`, 10)}`,
    );
  }

  console.log('');
  console.log('=== Surges ===');
  console.log(`${pad('id', 6)}${padStart('bonus', 10)}${padStart('frein', 10)}${padStart('total', 10)}`);
  for (const [index, id] of CHARACTER_IDS.entries()) {
    const bonus = metrics.surgeBonusPerCharacterMean[index] ?? 0;
    const brake = metrics.surgeBrakePerCharacterMean[index] ?? 0;
    console.log(
      `${pad(id, 6)}${padStart(fixed(bonus), 10)}${padStart(fixed(brake), 10)}${padStart(fixed(bonus + brake), 10)}`,
    );
  }

  const lines = metrics.speakerLines;
  console.log('');
  console.log('=== Speaker (discipline déterministe, libération immédiate) ===');
  if (lines === null) {
    console.log('non mesuré');
  } else {
    console.log(
      `min ${lines.min} | p5 ${fixed(lines.p5)} | p25 ${fixed(lines.p25)} | médiane ${fixed(lines.median)} | ` +
        `moyenne ${fixed(lines.mean)} | p75 ${fixed(lines.p75)} | p95 ${fixed(lines.p95)} | max ${lines.max}`,
    );
    console.log(
      `courses < ${SPEAKER_TARGET_MIN} répliques : ${metrics.speakerLinesUnderTarget} | ` +
        `= 0 : ${metrics.speakerLinesAtZero} | ` +
        `> ${SPEAKER_TARGET_MAX} : ${metrics.speakerLinesOverTarget} | ` +
        `segments saturés (quota) : ${metrics.speakerQuotaSaturatedRaces} courses`,
    );
    console.log(
      `refus admission : importance ${metrics.speakerRejections.IMPORTANCE} | ` +
        `dédup ${metrics.speakerRejections.DEDUP} | file ${metrics.speakerRejections.QUEUE} | ` +
        `éviction ${metrics.speakerRejections.QUEUE_DROP}`,
    );
    console.log(
      `refus par porte : type ${metrics.speakerGateRejections.TYPE_COOLDOWN} | ` +
        `global ${metrics.speakerGateRejections.GLOBAL_COOLDOWN} | ` +
        `quota ${metrics.speakerGateRejections.SEGMENT_QUOTA} | ` +
        `fenêtre ${metrics.speakerGateRejections.SLIDING_REFUSED}`,
    );
  }
}

/**
 * Rapport structuré, à clés **ASCII**.
 *
 * Il contient tout ce qu'il faut pour écrire `docs/balance-report.md` sans relancer une campagne :
 * les constantes réellement appliquées, les seuils avec leur verdict, les métriques complètes et le
 * chronométrage. Le format suit les conventions usuelles (`camelCase`, unités dans le nom quand
 * elles ne sont pas évidentes) pour rester lisible par un outil.
 */
function buildJsonReport(
  options: CliOptions,
  seeds: readonly string[],
  metrics: BalanceMetrics,
  elapsedMs: number,
  replay: ReturnType<typeof measureReproducibility> | null,
): unknown {
  const criteria = balanceCriteria(metrics);
  return {
    tool: 'chaos-race-balance',
    step: 'P010',
    corpus: {
      prefix: options.corpusPrefix,
      seeds: options.seeds,
      firstSeed: seeds[0] ?? null,
      lastSeed: seeds[seeds.length - 1] ?? null,
    },
    timing: {
      elapsedMs: Number(elapsedMs.toFixed(1)),
      msPerRace: Number((elapsedMs / options.seeds).toFixed(3)),
    },
    constants: {
      dtS: RACE_CONFIG.DT_S,
      totalSteps: RACE_CONFIG.TOTAL_STEPS,
      totalSimS: RACE_CONFIG.TOTAL_SIM_S,
      speedBase: SPEED.BASE,
      speedMin: SPEED.MIN,
      speedMax: SPEED.MAX,
      maxAccel: SPEED.MAX_ACCEL,
      maxDecel: SPEED.MAX_DECEL,
      drift: { ...DRIFT },
      surge: { ...SURGE },
      event: { ...GAME_CONFIG.EVENT },
      events: EVENT_CATALOG.map((definition) => ({ ...definition })),
      speaker: { ...SPEAKER_POLICY },
      leaderCheckS: LEADER_CHECK_S,
      speakerTargetMin: SPEAKER_TARGET_MIN,
      speakerTargetMax: SPEAKER_TARGET_MAX,
    },
    criteria: criteria.map((criterion) => ({ ...criterion })),
    criteriaPassed: criteria.filter((criterion) => criterion.pass).length,
    criteriaTotal: criteria.length,
    metrics: {
      ...metrics,
      // Les distributions sont figées : on les recopie pour que `JSON.stringify` reste trivial.
      gap1to6: { ...metrics.gap1to6 },
      gap1to2: { ...metrics.gap1to2 },
      leaderChanges: { ...metrics.leaderChanges },
      overtakes: { ...metrics.overtakes },
      speakerLines: metrics.speakerLines === null ? null : { ...metrics.speakerLines },
    },
    replay:
      replay === null
        ? null
        : {
            seeds: replay.seeds,
            identicalDistances: replay.identicalDistances,
            identicalRanking: replay.identicalRanking,
            exactSteps: replay.exactSteps,
            mismatches: [...replay.mismatches],
          },
  };
}

/** Résultat de la ligne de commande : code de sortie et rapport structuré éventuel. */
export interface BalanceCliResult {
  readonly exitCode: number;
  /** Rapport structuré à écrire, ou `null` si `--json` n'a pas été demandé. */
  readonly report: unknown | null;
  /** Chemin demandé pour le rapport, ou `null`. */
  readonly jsonPath: string | null;
}

/** Exécute la campagne complète. `exitCode` vaut `1` si un critère §13 échoue. */
export function runBalanceWithReport(argv: readonly string[]): BalanceCliResult {
  const options = parseArgs(argv);
  if (options === 'help') {
    console.log(HELP);
    return { exitCode: 0, report: null, jsonPath: null };
  }

  const seeds = corpusSeeds(options.seeds, options.corpusPrefix);

  console.log('Chaos Race — harnais d’équilibrage (P010)');
  console.log(
    `corpus « ${options.corpusPrefix} » : ${options.seeds} seeds déterministes | ` +
      `première ${seeds[0] ?? '—'} | dernière ${seeds[seeds.length - 1] ?? '—'}`,
  );
  console.log(
    `DT = ${RACE_CONFIG.DT_S} s | ${RACE_CONFIG.TOTAL_STEPS} pas par course | ` +
      `SPEED.BASE = ${SPEED.BASE} m/s | RATE_PER_S = ${GAME_CONFIG.EVENT.RATE_PER_S}`,
  );
  console.log(
    `speaker : minImportance ${SPEAKER_POLICY.minImportance} | ` +
      `cooldown global ${SPEAKER_POLICY.globalCooldownS} s | ` +
      `quota/segment ${SPEAKER_POLICY.maxLinesPerSegment}`,
  );

  const startedAt = performance.now();
  const campaign = runBalanceCampaign(seeds, { releaseDelayS: options.releaseDelayS });
  const elapsedMs = performance.now() - startedAt;

  printMetrics(campaign.metrics);

  let replay: ReturnType<typeof measureReproducibility> | null = null;
  if (options.replayCheck) {
    const replaySeeds = seeds.slice(0, Math.min(REPLAY_SEEDS, seeds.length));
    replay = measureReproducibility(replaySeeds);
    console.log('');
    console.log('=== Reproductibilité (rejeu strict) ===');
    console.log(
      `${replay.identicalDistances}/${replay.seeds} distances identiques bit à bit | ` +
        `${replay.identicalRanking}/${replay.seeds} classements identiques | ` +
        `${replay.exactSteps}/${replay.seeds} courses à ${RACE_CONFIG.TOTAL_STEPS} pas`,
    );
    if (replay.mismatches.length > 0) {
      console.log(`seeds divergentes : ${replay.mismatches.join(', ')}`);
    }
  }

  const report =
    options.jsonPath === null
      ? null
      : buildJsonReport(options, seeds, campaign.metrics, elapsedMs, replay);

  const criteria = balanceCriteria(campaign.metrics);
  const failed = criteria.filter((criterion) => !criterion.pass);
  console.log('');
  console.log(
    `Durée : ${(elapsedMs / 1000).toFixed(2)} s pour ${options.seeds} courses ` +
      `(${fixed(elapsedMs / options.seeds, 2)} ms/course).`,
  );
  console.log(
    failed.length === 0
      ? `Résultat : ${criteria.length}/${criteria.length} critères §13 conformes.`
      : `Résultat : ${failed.length} critère(s) hors plage : ${failed
          .map((criterion) => criterion.label)
          .join(', ')}.`,
  );

  return { exitCode: failed.length === 0 ? 0 : 1, report, jsonPath: options.jsonPath };
}

/** Exécute la campagne complète et renvoie le code de sortie (`1` si un critère §13 échoue). */
export function runBalanceCli(argv: readonly string[]): number {
  return runBalanceWithReport(argv).exitCode;
}
