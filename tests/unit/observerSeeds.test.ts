import { describe, expect, it } from 'vitest';

import { CHARACTER_IDS } from '../../src/core/characters';
import { FACT, LEADER, RACE_CONFIG } from '../../src/core/config';
import { RaceEngine } from '../../src/core/engine';
import { OvertakeTracker } from '../../src/core/overtakes';
import { computeRanks } from '../../src/core/ranking';
import type { ActiveEvent, CharacterId, EventId, RaceFact, RaceFactType } from '../../src/core/types';

/**
 * P009-A : véracité des faits sur de vraies courses.
 *
 * L'auditeur rejoue chaque course pas à pas et tient **sa propre** mesure, recomposée indépendamment
 * de l'observateur : classement (par `computeRanks`), écarts P1–P2 et P1–P3, rangs occupés dans les
 * fenêtres de 5, 10 et 30 s, et événements actifs (magnitude, durée, début réel, rang au tirage).
 * Chaque fait publié doit être exactement recomposable à partir de cette mesure — type, personnages,
 * magnitudes, instant et importance. Un fait non mesurable est un échec ; deux faits identiques au
 * même instant aussi.
 *
 * Une exception assumée : les **dépassements** viennent du même `OvertakeTracker` que l'observateur,
 * parce que c'est le contrat de conception — une seule source de dépassements pour toute la course.
 * Ce test ne revalide donc pas l'hystérésis elle-même : il vérifie que l'agrégation par fenêtre et le
 * fait publié en découlent exactement. L'hystérésis et son contrat d'ordre sont validés séparément par
 * `tests/unit/overtakes.test.ts`, et la granularité par pas par `tests/unit/raceSeeds.test.ts`.
 */

const DT = RACE_CONFIG.DT_S;
const COUNT = CHARACTER_IDS.length;
const SEED_COUNT = 200;

/** Fenêtres du design, exprimées en pas (arithmétique entière, jamais en flottants de temps). */
const RANK_WINDOW = Math.round(FACT.LAST_COMEBACK_WINDOW_S / DT); // 30 s
const RANK_RING = RANK_WINDOW + 1; // la fenêtre est inclusive, comme `worstRankWithin`
const BIG_WINDOW = Math.round(FACT.BIG_COMEBACK_WINDOW_S / DT); // 10 s
const STREAK_WINDOW = Math.round(FACT.OVERTAKE_STREAK_WINDOW_S / DT); // 5 s
const CLOSE_WINDOW = Math.round(FACT.CLOSE_RACE_MIN_DURATION_S / DT); // 5 s
const DEBOUNCE_STEPS = Math.round(LEADER.DEBOUNCE_S / DT); // 45 pas

const BONUS_EVENTS: readonly EventId[] = ['TURBO', 'MEGA_TURBO', 'RACCOURCI'];
const MALUS_EVENTS: readonly EventId[] = ['CHUTE', 'SIESTE', 'VENT_DE_FACE'];
const FACT_TYPES: readonly RaceFactType[] = [
  'LEADER_CHANGE',
  'BIG_COMEBACK',
  'OVERTAKE_STREAK',
  'BIG_BONUS',
  'LEADER_MALUS',
  'CLOSE_RACE',
  'LAST_COMEBACK',
  'CHECKPOINT_SPLIT',
  'FINISH',
  'PHOTO_FINISH',
];

/** Seeds canoniques déterministes : distinctes, stables d'une exécution à l'autre. */
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

type Snapshot = ReturnType<RaceEngine['getState']>;

/** Mesure indépendante d'une course (dépassements exceptés : même `OvertakeTracker`, cf. en-tête). */
class FactAuditor {
  readonly counts: Partial<Record<RaceFactType, number>> = {};
  readonly splitTimes: number[] = [];

  private readonly rankRing = new Int8Array(RANK_RING * COUNT);
  private readonly gapRing = new Float64Array(CLOSE_WINDOW);
  private readonly streakRing = new Int32Array(STREAK_WINDOW * COUNT);
  private readonly streakTotals = new Int32Array(COUNT);
  private readonly ranks = new Int32Array(COUNT);
  private readonly previousRanks = new Int32Array(COUNT);
  private readonly distances: number[] = new Array<number>(COUNT).fill(0);
  private readonly events: (ActiveEvent | null)[] = new Array<ActiveEvent | null>(COUNT).fill(null);
  private readonly previousEventId: (EventId | null)[] = new Array<EventId | null>(COUNT).fill(null);
  private readonly previousEventStart: number[] = new Array<number>(COUNT).fill(0);
  private readonly tracker = new OvertakeTracker();
  private readonly signatures = new Set<string>();

  private steps = 0;
  private leaderChanges = 0;
  private lastLeaderChangeStep = 0;
  private leaderChangesAtCheckpoint = 0;
  private arrivals = 0;
  private problems: string[] = [];

  constructor(private readonly seed: string) {}

  /** Le seul message d'échec : toujours situé dans une seed et à un pas précis. */
  private fail(message: string): never {
    throw new Error(`${this.seed} au pas ${this.steps} : ${message}`);
  }

  private exactly(condition: boolean, message: string): void {
    if (!condition) {
      this.problems.push(message);
    }
  }

  /** Index de roster d'un identifiant officiel. */
  private indexOf(id: CharacterId): number {
    const index = CHARACTER_IDS.indexOf(id);
    if (index < 0) {
      this.fail(`identifiant hors roster « ${id} »`);
    }
    return index;
  }

  private rankOf(id: CharacterId): number {
    return this.ranks[this.indexOf(id)] ?? 0;
  }

  private xOf(id: CharacterId): number {
    return this.distances[this.indexOf(id)] ?? 0;
  }

  private rankIndexAt(position: number): number {
    for (let index = 0; index < COUNT; index += 1) {
      if ((this.ranks[index] ?? 0) === position + 1) {
        return index;
      }
    }
    this.fail(`aucun personnage au rang ${position + 1}`);
  }

  private idAt(position: number): CharacterId {
    const id = CHARACTER_IDS[this.rankIndexAt(position)];
    if (id === undefined) {
      return this.fail(`position ${position} hors roster`);
    }
    return id;
  }

  /** Meilleur rang occupé par `index` sur les `windowSteps` derniers pas (fenêtre inclusive). */
  private worstRankWithin(index: number, windowSteps: number): number {
    const span = Math.min(windowSteps + 1, this.steps, RANK_RING);
    let worst = 0;
    for (let offset = 0; offset < span; offset += 1) {
      const slot = (this.steps - offset - 1) % RANK_RING;
      const rank = this.rankRing[slot * COUNT + index] ?? 0;
      if (rank > worst) {
        worst = rank;
      }
    }
    return worst;
  }

  /** Le rang 1 a-t-il été tenu par `index` pendant les `span` derniers pas, sans interruption ? */
  private heldRankOne(index: number, span: number): boolean {
    const steps = Math.min(span, this.steps);
    for (let offset = 0; offset < steps; offset += 1) {
      const slot = (this.steps - offset - 1) % RANK_RING;
      if ((this.rankRing[slot * COUNT + index] ?? 0) !== 1) {
        return false;
      }
    }
    return steps > 0;
  }

  private gapHeldBelow(limit: number): boolean {
    const steps = Math.min(CLOSE_WINDOW, this.steps);
    for (let offset = 0; offset < steps; offset += 1) {
      const slot = (this.steps - offset - 1) % CLOSE_WINDOW;
      if ((this.gapRing[slot] ?? 0) > limit) {
        return false;
      }
    }
    return steps >= CLOSE_WINDOW;
  }

  /** Consigne l'état du pas `steps`, puis met à jour son propre historique. */
  advance(state: Snapshot, steps: number): void {
    // Ce que l'observateur avait en mémoire **avant** ce pas : c'est la photographie qu'il lit pour
    // le rang « au moment du tirage » et pour décider qu'un événement démarre réellement. Le premier
    // pas part donc des mêmes valeurs neutres que lui (rangs à zéro, aucun événement).
    this.previousRanks.set(this.ranks);
    for (let index = 0; index < COUNT; index += 1) {
      const previous = this.events[index] ?? null;
      this.previousEventId[index] = previous === null ? null : previous.id;
      this.previousEventStart[index] = previous === null ? 0 : previous.startSimS;
    }

    const distances = state.characters.map((character) => character.x);
    const ids = state.characters.map((character) => character.id);
    const ranks = computeRanks(distances, ids);

    for (let index = 0; index < COUNT; index += 1) {
      const id = ids[index];
      const distance = distances[index];
      const rank = ranks[index];
      if (id === undefined || distance === undefined || rank === undefined) {
        throw new RangeError(`${this.seed} : état incomplet à l'index ${index}.`);
      }
      if (id !== CHARACTER_IDS[index]) {
        throw new RangeError(`${this.seed} : roster hors ordre officiel à l'index ${index}.`);
      }
      this.distances[index] = distance;
      this.ranks[index] = rank;
      this.events[index] = state.characters[index]?.activeEvent ?? null;
      this.rankRing[((steps - 1) % RANK_RING) * COUNT + index] = rank;
    }

    const sorted = [...distances].sort((a, b) => b - a);
    this.gapRing[(steps - 1) % CLOSE_WINDOW] = (sorted[0] ?? 0) - (sorted[2] ?? 0);

    const slot = (steps - 1) % STREAK_WINDOW;
    for (let index = 0; index < COUNT; index += 1) {
      this.streakTotals[index] = (this.streakTotals[index] ?? 0) - (this.streakRing[slot * COUNT + index] ?? 0);
      this.streakRing[slot * COUNT + index] = 0;
    }
    for (const overtake of this.tracker.observe(distances, ids)) {
      const index = this.indexOf(overtake.overtaker);
      const cell = slot * COUNT + index;
      this.streakRing[cell] = (this.streakRing[cell] ?? 0) + 1;
      this.streakTotals[index] = (this.streakTotals[index] ?? 0) + 1;
    }

    this.steps = steps;
  }

  /** Vérifie tous les faits publiés pour le pas courant. */
  audit(facts: readonly RaceFact[], tSim: number): void {
    for (const fact of facts) {
      this.counts[fact.type] = (this.counts[fact.type] ?? 0) + 1;

      const signature = `${fact.type}|${fact.tSim}|${fact.characterIds.join(',')}`;
      if (this.signatures.has(signature)) {
        this.fail(`deux faits identiques au même instant : ${signature}`);
      }
      this.signatures.add(signature);

      this.auditShape(fact, tSim);
      this.auditSemantics(fact, tSim);
    }
  }

  private auditShape(fact: RaceFact, tSim: number): void {
    this.exactly(fact.tSim === tSim, `${fact.type} : tSim ${fact.tSim} au lieu de ${tSim}`);
    this.exactly(
      fact.characterIds.length >= 1 && fact.characterIds.length <= COUNT,
      `${fact.type} : ${fact.characterIds.length} personnages`,
    );
    this.exactly(
      new Set(fact.characterIds).size === fact.characterIds.length,
      `${fact.type} : personnages répétés`,
    );
    for (const id of fact.characterIds) {
      this.exactly(CHARACTER_IDS.includes(id), `${fact.type} : personnage hors roster « ${id} »`);
    }
    this.exactly(
      fact.magnitudes.length >= 1 && fact.magnitudes.every((value) => Number.isFinite(value)),
      `${fact.type} : magnitudes non finies`,
    );
    this.exactly(
      Number.isFinite(fact.importance) && fact.importance >= 0 && fact.importance <= 100,
      `${fact.type} : importance ${fact.importance} hors [0, 100]`,
    );
    this.exactly(fact.textKey.startsWith('fact.'), `${fact.type} : clé « ${fact.textKey} »`);
    this.exactly(!/\s/.test(fact.textKey), `${fact.type} : clé avec espace`);
  }

  private auditSemantics(fact: RaceFact, tSim: number): void {
    const character = fact.characterIds[0];
    if (character === undefined) {
      return;
    }
    const index = this.indexOf(character);
    const rank = this.rankOf(character);

    switch (fact.type) {
      case 'LEADER_CHANGE': {
        const previousLeader = fact.characterIds[1];
        this.exactly(rank === 1, `LEADER_CHANGE : ${character} n'est pas 1er`);
        const margin = this.xOf(character) - this.xOf(this.secondId(index));
        this.exactly(fact.magnitudes[0] === margin, `LEADER_CHANGE : marge ${fact.magnitudes[0]} ≠ ${margin}`);
        this.exactly(margin >= LEADER.MIN_MARGIN, `LEADER_CHANGE : marge ${margin} < ${LEADER.MIN_MARGIN}`);
        this.exactly(
          previousLeader !== undefined && previousLeader !== character,
          'LEADER_CHANGE : ancien leader identique au nouveau',
        );
        this.exactly(
          this.heldRankOne(index, DEBOUNCE_STEPS),
          `LEADER_CHANGE : ${character} n'a pas tenu le rang 1 pendant ${LEADER.DEBOUNCE_S} s`,
        );
        // `magnitudes[1]` est le règne du leader **sortant** : du pas de sa propre confirmation (ou du
        // départ de la course pour le premier) au pas de confirmation courant.
        const reignS = (this.steps - this.lastLeaderChangeStep) * DT;
        this.exactly(
          fact.magnitudes[1] === reignS,
          `LEADER_CHANGE : règne ${fact.magnitudes[1]} s ≠ ${reignS} s`,
        );
        this.exactly(
          fact.importance ===
            FACT.LEADER_CHANGE_IMPORTANCE + Math.min(FACT.LEADER_CHANGE_MAX_REIGN_BONUS, reignS),
          `LEADER_CHANGE : importance ${fact.importance}`,
        );
        this.lastLeaderChangeStep = this.steps;
        this.leaderChanges += 1;
        break;
      }

      case 'BIG_COMEBACK': {
        const worst = this.worstRankWithin(index, BIG_WINDOW);
        const gain = worst - rank;
        this.exactly(gain >= FACT.BIG_COMEBACK_PLACES, `BIG_COMEBACK : gain ${gain}`);
        this.exactly(fact.magnitudes[0] === gain, `BIG_COMEBACK : magnitudes[0] ${fact.magnitudes[0]} ≠ ${gain}`);
        this.exactly(fact.magnitudes[1] === rank, `BIG_COMEBACK : magnitudes[1] ${fact.magnitudes[1]} ≠ ${rank}`);
        this.exactly(
          fact.importance ===
            FACT.BIG_COMEBACK_IMPORTANCE + FACT.BIG_COMEBACK_BONUS_PER_PLACE * (gain - FACT.BIG_COMEBACK_PLACES),
          `BIG_COMEBACK : importance ${fact.importance}`,
        );
        break;
      }

      case 'OVERTAKE_STREAK': {
        const count = this.streakTotals[index] ?? 0;
        this.exactly(
          count >= FACT.OVERTAKE_STREAK_MIN,
          `OVERTAKE_STREAK : ${count} dépassements seulement`,
        );
        this.exactly(fact.magnitudes[0] === count, `OVERTAKE_STREAK : ${fact.magnitudes[0]} ≠ ${count}`);
        this.exactly(
          fact.importance ===
            FACT.OVERTAKE_STREAK_IMPORTANCE +
              FACT.OVERTAKE_STREAK_BONUS_PER_OVERTAKE * (count - FACT.OVERTAKE_STREAK_MIN),
          `OVERTAKE_STREAK : importance ${fact.importance}`,
        );
        break;
      }

      case 'BIG_BONUS':
      case 'LEADER_MALUS': {
        const bonus = fact.type === 'BIG_BONUS';
        const event = this.events[index];
        const allowed = bonus ? BONUS_EVENTS : MALUS_EVENTS;
        this.exactly(event !== null && event !== undefined, `${fact.type} : aucun événement actif sur ${character}`);
        if (event === null || event === undefined) {
          break;
        }
        this.exactly(allowed.includes(event.id), `${fact.type} : événement ${event.id}`);
        this.exactly(
          event.target === character,
          `${fact.type} : événement ciblant ${event.target} attribué à ${character}`,
        );
        this.exactly(
          this.previousEventId[index] !== event.id || this.previousEventStart[index] !== event.startSimS,
          `${fact.type} : ${event.id} déjà actif au pas précédent ` +
            `(${String(this.previousEventId[index])} @ ${this.previousEventStart[index]} s, ` +
            `fait à ${tSim} s, début ${event.startSimS} s)`,
        );
        this.exactly(
          Math.abs(event.startSimS - (tSim - DT)) < 1e-9,
          `${fact.type} : début réel à ${event.startSimS} s, fait à ${tSim} s`,
        );
        this.exactly(fact.magnitudes[0] === event.magnitude, `${fact.type} : magnitude ${fact.magnitudes[0]}`);
        this.exactly(fact.magnitudes[1] === event.durationS, `${fact.type} : durée ${fact.magnitudes[1]}`);
        const rankAtDraw = this.previousRanks[index] ?? 0;
        this.exactly(fact.magnitudes[2] === rankAtDraw, `${fact.type} : rang au tirage ${fact.magnitudes[2]} ≠ ${rankAtDraw}`);
        if (bonus) {
          this.exactly(
            fact.importance ===
              FACT.BIG_BONUS_IMPORTANCE +
                (rankAtDraw === 1 ? FACT.BIG_BONUS_LEADER_BONUS : 0) +
                (rankAtDraw === COUNT ? FACT.BIG_BONUS_LAST_BONUS : 0),
            `BIG_BONUS : importance ${fact.importance}`,
          );
        } else {
          this.exactly(rankAtDraw === 1, `LEADER_MALUS : ${character} n'était pas leader au tirage`);
          this.exactly(
            fact.importance ===
              FACT.LEADER_MALUS_IMPORTANCE + (event.id === 'SIESTE' ? FACT.LEADER_MALUS_SIESTE_BONUS : 0),
            `LEADER_MALUS : importance ${fact.importance}`,
          );
        }
        break;
      }

      case 'CLOSE_RACE': {
        const third = fact.characterIds[1];
        if (third === undefined) {
          this.fail('CLOSE_RACE : aucun 3e');
        }
        const gap = this.xOf(character) - this.xOf(third);
        this.exactly(gap <= FACT.CLOSE_RACE_MAX_GAP_M, `CLOSE_RACE : écart ${gap}`);
        this.exactly(fact.magnitudes[0] === gap, `CLOSE_RACE : magnitudes[0] ${fact.magnitudes[0]} ≠ ${gap}`);
        this.exactly(
          fact.magnitudes[1] === CLOSE_WINDOW * DT,
          `CLOSE_RACE : durée ${fact.magnitudes[1]}`,
        );
        this.exactly(
          this.gapHeldBelow(FACT.CLOSE_RACE_MAX_GAP_M),
          'CLOSE_RACE : les 5 s ne sont pas toutes sous le seuil',
        );
        this.exactly(this.rankOf(character) === 1, 'CLOSE_RACE : le 1er n’est pas le leader');
        this.exactly(this.rankOf(third) === 3, 'CLOSE_RACE : le 2e n’est pas 3e');
        this.exactly(fact.importance === FACT.CLOSE_RACE_IMPORTANCE, `CLOSE_RACE : importance ${fact.importance}`);
        break;
      }

      case 'LAST_COMEBACK': {
        const worst = this.worstRankWithin(index, RANK_WINDOW);
        const gain = worst - rank;
        this.exactly(
          (worst === COUNT && rank <= FACT.LAST_COMEBACK_RANK) || gain >= FACT.LAST_COMEBACK_PLACES,
          `LAST_COMEBACK : rang ${rank}, pire ${worst}`,
        );
        this.exactly(fact.magnitudes[0] === gain, `LAST_COMEBACK : magnitudes[0] ${fact.magnitudes[0]} ≠ ${gain}`);
        this.exactly(fact.magnitudes[1] === rank, `LAST_COMEBACK : magnitudes[1] ${fact.magnitudes[1]} ≠ ${rank}`);
        this.exactly(fact.importance === FACT.LAST_COMEBACK_IMPORTANCE, `LAST_COMEBACK : importance ${fact.importance}`);
        break;
      }

      case 'CHECKPOINT_SPLIT': {
        const expectedTimes: readonly number[] = [45, 90, 135];
        this.exactly(expectedTimes.includes(tSim), `CHECKPOINT_SPLIT : borne ${tSim}`);
        const order: CharacterId[] = [];
        for (let position = 0; position < COUNT; position += 1) {
          order.push(this.idAt(position));
        }
        this.exactly(
          fact.characterIds.join(',') === order.join(','),
          `CHECKPOINT_SPLIT : classement ${fact.characterIds.join(',')} ≠ ${order.join(',')}`,
        );
        this.exactly(
          fact.magnitudes.join(',') === order.map((id) => this.xOf(id)).join(','),
          'CHECKPOINT_SPLIT : distances publiées différentes des distances mesurées',
        );
        const leaderChanged = this.leaderChanges > this.leaderChangesAtCheckpoint;
        this.leaderChangesAtCheckpoint = this.leaderChanges;
        const gap = (fact.magnitudes[0] ?? 0) - (fact.magnitudes[1] ?? 0);
        this.exactly(fact.magnitudes.length === COUNT, `CHECKPOINT_SPLIT : ${fact.magnitudes.length} distances`);
        this.exactly(
          fact.importance ===
            FACT.CHECKPOINT_SPLIT_IMPORTANCE +
              (leaderChanged ? FACT.CHECKPOINT_SPLIT_LEADER_CHANGE_BONUS : 0) +
              (gap < FACT.CHECKPOINT_SPLIT_CLOSE_GAP_M ? FACT.CHECKPOINT_SPLIT_CLOSE_BONUS : 0),
          `CHECKPOINT_SPLIT : importance ${fact.importance} (leader changé : ${leaderChanged}, écart ${gap})`,
        );
        this.splitTimes.push(tSim);
        break;
      }

      case 'FINISH':
      case 'PHOTO_FINISH': {
        const second = fact.characterIds[1];
        if (second === undefined) {
          this.fail(`${fact.type} : aucun 2e`);
        }
        this.exactly(tSim === RACE_CONFIG.TOTAL_SIM_S, `${fact.type} : tSim ${tSim}`);
        this.exactly(this.rankOf(character) === 1, `${fact.type} : le 1er n’est pas le leader`);
        this.exactly(this.rankOf(second) === 2, `${fact.type} : le 2e n’est pas 2e`);
        const leaderDistance = this.xOf(character);
        const secondDistance = this.xOf(second);
        const gap = leaderDistance - secondDistance;
        this.exactly(fact.magnitudes[0] === gap, `${fact.type} : écart ${fact.magnitudes[0]} ≠ ${gap}`);
        this.exactly(fact.magnitudes[1] === leaderDistance, `${fact.type} : distance du 1er`);
        this.exactly(fact.magnitudes[2] === secondDistance, `${fact.type} : distance du 2e`);
        const photo = gap < FACT.PHOTO_ARRIVAL_MAX_GAP_M;
        this.exactly(
          fact.type === (photo ? 'PHOTO_FINISH' : 'FINISH'),
          `${fact.type} : écart ${gap} pour un seuil de ${FACT.PHOTO_ARRIVAL_MAX_GAP_M} m`,
        );
        this.exactly(
          fact.importance === (photo ? FACT.PHOTO_ARRIVAL_IMPORTANCE : FACT.ARRIVAL_IMPORTANCE),
          `${fact.type} : importance ${fact.importance}`,
        );
        this.arrivals += 1;
        break;
      }
    }
  }

  /** Deuxième personnage du classement, en excluant `index`. */
  private secondId(index: number): CharacterId {
    for (let other = 0; other < COUNT; other += 1) {
      if (other !== index && (this.ranks[other] ?? 0) === 2) {
        const id = CHARACTER_IDS[other];
        if (id === undefined) {
          break;
        }
        return id;
      }
    }
    return this.fail('aucun 2e au classement');
  }

  /** Fin de course : exactement trois splits et une seule arrivée. */
  finish(): void {
    const problems = [...this.problems];
    this.problems = [];
    if (problems.length > 0) {
      throw new Error(`${this.seed} : ${problems.join(' | ')}`);
    }
    if (this.splitTimes.length !== 3) {
      throw new Error(`${this.seed} : ${this.splitTimes.length} splits (${this.splitTimes.join(', ')})`);
    }
    if (this.arrivals !== 1) {
      throw new Error(`${this.seed} : ${this.arrivals} faits d'arrivée`);
    }
    if (this.steps !== RACE_CONFIG.TOTAL_STEPS) {
      throw new Error(`${this.seed} : ${this.steps} pas`);
    }
  }
}

/** Rejoue `seeds` en auditant chaque fait, et renvoie les compteurs agrégés. */
function auditSeeds(seeds: readonly string[]): Partial<Record<RaceFactType, number>> {
  const totals: Partial<Record<RaceFactType, number>> = {};

  for (const seed of seeds) {
    const engine = new RaceEngine(seed);
    const auditor = new FactAuditor(seed);

    for (let step = 1; step <= RACE_CONFIG.TOTAL_STEPS; step += 1) {
      engine.step();
      const facts = engine.drainFacts();
      const state = engine.getState();
      if (state.steps !== step) {
        throw new Error(`${seed} : état au pas ${state.steps} alors que la boucle est au pas ${step}`);
      }
      auditor.advance(state, step);
      if (facts.length > 0) {
        auditor.audit(facts, state.tSim);
      }
    }

    auditor.finish();
    for (const type of FACT_TYPES) {
      totals[type] = (totals[type] ?? 0) + (auditor.counts[type] ?? 0);
    }
  }

  return totals;
}

describe('véracité des faits sur 200 seeds', () => {
  it('recompose chaque fait à partir de la seule mesure de la course', () => {
    const seeds = canonicalSeeds(SEED_COUNT);
    expect(new Set(seeds).size).toBe(SEED_COUNT);
    expect(seeds.every((seed) => seed.length === 8)).toBe(true);

    const started = Date.now();
    const totals = auditSeeds(seeds);
    const elapsed = Date.now() - started;

    const summary = FACT_TYPES.map((type) => `${type}=${totals[type] ?? 0}`).join(' ');
    console.log(
      `[P009-A] ${SEED_COUNT} courses conformes (${(elapsed / 1000).toFixed(1)} s) ; ` +
        `${RACE_CONFIG.TOTAL_STEPS * SEED_COUNT} pas ; ${summary} ; anomalies=0`,
    );

    // Les faits structurels sont certains ; les faits d'épisode doivent au moins exister.
    expect(totals.CHECKPOINT_SPLIT).toBe(3 * SEED_COUNT);
    expect((totals.FINISH ?? 0) + (totals.PHOTO_FINISH ?? 0)).toBe(SEED_COUNT);
    expect(totals.LEADER_CHANGE ?? 0).toBeGreaterThan(0);
    expect(totals.OVERTAKE_STREAK ?? 0).toBeGreaterThan(0);
    expect(totals.BIG_BONUS ?? 0).toBeGreaterThan(0);
    expect(totals.BIG_COMEBACK ?? 0).toBeGreaterThan(0);
  });
});
