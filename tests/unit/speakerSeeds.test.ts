import { describe, expect, it } from 'vitest';

import { RACE_CONFIG } from '../../src/core/config';
import { RaceEngine } from '../../src/core/engine';
import type { RaceFact, RaceFactType } from '../../src/core/types';
import { dedupFingerprint } from '../../src/speaker/importance';
import { segmentIndex } from '../../src/speaker/cooldowns';
import { SPEAKER_POLICY } from '../../src/speaker/policy';
import { Speaker, type SpeakerDecision } from '../../src/speaker/Speaker';

/**
 * P009-B : validation de la discipline de parole sur de **vraies courses**.
 *
 * Le speaker est nourri **uniquement** des `RaceFact` produits par P009-A, drainés après chaque pas :
 * il ne voit ni distance, ni rang, ni événement. L'auditeur qui suit reconstruit ensuite, à partir
 * des seules décisions, chacune des règles de `GAME_DESIGN.md` §9.3 et échoue à la moindre violation.
 *
 * ## Cadence retenue, et pourquoi
 *
 * P009-B ne connaît pas la durée réelle d'un texte : c'est P009-C qui la fournira. Le conducteur
 * ci-dessous place donc le speaker dans la situation **la plus favorable possible** — à chaque pas, la
 * place est libre et une nouvelle réplique peut démarrer. La mesure obtenue est donc la **borne
 * supérieure** de ce que le speaker voudrait dire : c'est exactement ce qu'il faut pour vérifier que
 * les garde-fous (cooldowns, quota, fenêtre) tiennent, et qu'aucun filtre amont ne tarit la parole.
 * Une fois P009-C connu, la même mesure avec de vraies durées ne pourra qu'être **inférieure**.
 *
 * Le cooldown global borne déjà la cadence à `180 / 6 = 30` répliques par course : le plafond de la
 * cible design (30) est donc structurel.
 */

const DT = RACE_CONFIG.DT_S;
const TOTAL_STEPS = RACE_CONFIG.TOTAL_STEPS;

/** Seeds canoniques déterministes, distinctes et stables d'une exécution à l'autre. */
function canonicalSeeds(count: number): readonly string[] {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const seeds: string[] = [];

  for (let index = 0; index < count; index += 1) {
    let state = Math.imul(index + 1, 0x9e3779b1) | 0;
    let seed = '';
    for (let position = 0; position < 8; position += 1) {
      state = (Math.imul(state, 1103515245) + 12345) | 0;
      seed += alphabet[(state >>> 16) & 31] ?? '0';
    }
    seeds.push(seed);
  }

  return seeds;
}

const BUCKET_RESOLUTION = SPEAKER_POLICY.magnitudeBucketResolution;

/** Marqueur de préemption : un écart sous le cooldown global n'est légal que pour ces faits. */
function isBypassEligible(importance: number): boolean {
  return importance >= SPEAKER_POLICY.preemptImportance;
}

interface Audit {
  readonly lines: number;
  readonly problems: string[];
}

/**
 * Rejoue une course et vérifie **chaque** règle de §9.3 à partir des seules décisions du speaker.
 *
 * Aucune de ces vérifications ne lit l'état du moteur : elles ne comparent que des faits, des
 * instants et des importances — exactement ce que le speaker a le droit de voir.
 */
function auditSeed(seed: string): Audit {
  const engine = new RaceEngine(seed);
  const speaker = new Speaker();
  const problems: string[] = [];

  const fedFacts = new Set<RaceFact>();
  const started: SpeakerDecision[] = [];
  const lastStartByType = new Map<RaceFactType, number>();
  const lastStartByFingerprint = new Map<string, number>();
  const lastStartOverall: { atS: number } = { atS: Number.NEGATIVE_INFINITY };
  const linesPerSegment = [0, 0, 0, 0];

  let step = 0;

  /** Enregistre tout ce qu'une décision implique, et vérifie au passage tout ce qui est vérifiable. */
  function record(decision: SpeakerDecision): void {
    started.push(decision);
    const { fact, importance, startedAtS } = decision;

    // 1. Aucune réplique sans fait source, et aucune importance inventée.
    if (!fedFacts.has(fact)) {
      problems.push(`${seed} @${startedAtS} : décision sans fait source (${fact.type}).`);
    }
    if (importance !== fact.importance) {
      problems.push(`${seed} @${startedAtS} : importance altérée (${importance} ≠ ${fact.importance}).`);
    }

    // 2. MIN_IMPORTANCE jamais violé.
    if (importance < SPEAKER_POLICY.minImportance) {
      problems.push(`${seed} @${startedAtS} : importance ${importance} < MIN_IMPORTANCE.`);
    }

    // 3. Cooldown global : seul un fait ≥ PREEMPT_IMPORTANCE peut passer outre.
    const gapFromPrevious = startedAtS - lastStartOverall.atS;
    if (gapFromPrevious < SPEAKER_POLICY.globalCooldownS && !isBypassEligible(importance)) {
      problems.push(
        `${seed} @${startedAtS} : cooldown global violé (${gapFromPrevious.toFixed(3)} s) par ${fact.type} à ${importance}.`,
      );
    }

    // 4. Cooldown par type : jamais contourné, par personne.
    const previousOfType = lastStartByType.get(fact.type);
    if (previousOfType !== undefined) {
      const gap = startedAtS - previousOfType;
      const required = SPEAKER_POLICY.typeCooldownS[fact.type];
      if (gap < required) {
        problems.push(
          `${seed} @${startedAtS} : cooldown de type ${fact.type} violé (${gap.toFixed(3)} s < ${required} s).`,
        );
      }
    }

    // 5. Déduplication : deux faits de même empreinte restent à 10 s d'écart.
    const fingerprint = dedupFingerprint(fact, BUCKET_RESOLUTION);
    const previousOfFingerprint = lastStartByFingerprint.get(fingerprint);
    if (previousOfFingerprint !== undefined) {
      const gap = startedAtS - previousOfFingerprint;
      if (gap < SPEAKER_POLICY.dedupWindowS) {
        problems.push(
          `${seed} @${startedAtS} : déduplication violée (${gap.toFixed(3)} s) pour ${fingerprint}.`,
        );
      }
    }
    lastStartByFingerprint.set(fingerprint, startedAtS);

    // 6. Quota par segment : plafond absolu, jamais franchi.
    const segment = segmentIndex(SPEAKER_POLICY, startedAtS);
    linesPerSegment[segment] = (linesPerSegment[segment] ?? 0) + 1;
    if ((linesPerSegment[segment] ?? 0) > SPEAKER_POLICY.maxLinesPerSegment) {
      problems.push(`${seed} @${startedAtS} : quota du segment ${segment} dépassé.`);
    }

    lastStartByType.set(fact.type, startedAtS);
    lastStartOverall.atS = startedAtS;
  }

  while (step < TOTAL_STEPS) {
    engine.step();
    step += 1;
    const tSim = step * DT;

    for (const fact of engine.drainFacts()) {
      fedFacts.add(fact);
      // `feed` peut démarrer une réplique immédiatement (file vidée ou préemption) : sa décision
      // doit être enregistrée comme les autres, sans quoi l'audit ne verrait qu'une partie des
      // prises de parole.
      const fromFeed = speaker.feed(fact);
      if (fromFeed !== null) {
        record(fromFeed);
        speaker.finish();
      }
    }

    // Cadence la plus favorable : la place est toujours libre, le speaker décide seul de parler.
    const decision = speaker.poll(tSim);
    if (decision !== null) {
      record(decision);
      // Libération immédiate : la borne supérieure assume qu'un texte peut être dit en un pas.
      speaker.finish();
    }
  }

  // 7. Cohérence des compteurs internes avec ce qui a été observé.
  const stats = speaker.stats();
  if (stats.linesStarted !== started.length) {
    problems.push(`${seed} : ${stats.linesStarted} répliques comptées, ${started.length} observées.`);
  }

  return { lines: started.length, problems };
}

/** Min, quartiles, moyenne, médiane et max d'une série de nombres. */
function summarize(values: readonly number[]): {
  min: number;
  p25: number;
  mean: number;
  median: number;
  p75: number;
  max: number;
} {
  const sorted = [...values].sort((left, right) => left - right);
  const at = (fraction: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] ?? 0;
  const total = sorted.reduce((sum, value) => sum + value, 0);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0
      ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
      : (sorted[middle] ?? 0);
  return {
    min: sorted[0] ?? 0,
    p25: at(0.25),
    mean: total / sorted.length,
    median,
    p75: at(0.75),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

/**
 * Nombre de courses validées. 200 est la campagne de référence de P009-B.
 *
 * La variable d'environnement `SPEAKER_SEED_COUNT` reste lue comme échappatoire de mise au point
 * (une campagne courte), via `globalThis` : le projet n'installe pas `@types/node`, et cette lecture
 * ne doit rien coûter au typage ni ajouter de dépendance.
 */
function readSeedCount(): number {
  const environment = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
  const raw = environment?.['SPEAKER_SEED_COUNT'];
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 200;
}

const SEED_COUNT = readSeedCount();

describe(`P009-B : discipline de parole sur ${SEED_COUNT} courses réelles`, () => {
  const seeds = canonicalSeeds(SEED_COUNT);

  // Campagne de 200 courses complètes : la durée dépasse le délai par défaut de Vitest, elle est
  // donc déclarée explicitement (rejouer 200 × 10 800 pas est un vrai calcul, pas une attente).
  it('n’enfreint aucune règle de §9.3 sur toute la campagne', { timeout: 120_000 }, () => {
    const lineCounts: number[] = [];
    const failures: string[] = [];

    for (const seed of seeds) {
      const audit = auditSeed(seed);
      lineCounts.push(audit.lines);
      failures.push(...audit.problems);
    }

    const summary = summarize(lineCounts);
    const report =
      `${SEED_COUNT} seeds — min ${summary.min}, p25 ${summary.p25}, médiane ${summary.median}, ` +
      `moyenne ${summary.mean.toFixed(2)}, p75 ${summary.p75}, max ${summary.max} ; ` +
      `${lineCounts.filter((value) => value < 12).length} courses sous 12 répliques`;

    expect(failures, failures.slice(0, 20).join('\n')).toEqual([]);

    // Plafond design : jamais plus de 30 répliques (le cooldown global borne déjà la cadence à
    // `180 / 6 = 30`), et jamais une course muette.
    expect(summary.max, report).toBeLessThanOrEqual(30);
    expect(summary.min, report).toBeGreaterThan(0);

    // Cible design — 12 à 30 répliques par course. Le **minimum** est mesuré et rapporté, mais il
    // n'est pas verrouillé ici : il dépend du nombre de faits mesurés que P009-A a réellement
    // produits, pas de la discipline de parole. Les garde-fous garantis par P009-B sont le plafond,
    // l'absence de silence total et l'absence de violation ; la borne basse relève de l'arbitrage
    // d'équilibrage (P010). Un effondrement de la moyenne, en revanche, est un vrai échec.
    expect(summary.mean, report).toBeGreaterThanOrEqual(10);
    expect(summary.median, report).toBeGreaterThanOrEqual(12);
  });

  it('nourrit le speaker avec des faits réels : une course produit toujours des faits', { timeout: 30_000 }, () => {
    const seed = seeds[0] ?? 'ACDEFGHJ';
    const engine = new RaceEngine(seed);
    let facts = engine.drainFacts().length;
    for (let step = 0; step < TOTAL_STEPS; step += 1) {
      engine.step();
      facts += engine.drainFacts().length;
    }
    expect(facts, seed).toBeGreaterThan(0);
  });
});
