/**
 * Harnais d'équilibrage (P010) — **aucun navigateur, aucun Phaser, aucun DOM**.
 *
 * Ce module exécute des courses réelles via `RaceEngine.runToCompletion()` et agrège les métriques de
 * `GAME_DESIGN.md` §13. Il ne modifie **aucun** état du jeu : il ne fait que lire l'état publié par
 * le moteur, les faits de l'observateur et les décisions du speaker réel.
 *
 * Deux principes gouvernent la mesure, et ils sont la raison d'être de ce fichier :
 *
 * 1. **La mesure vient du noyau, jamais d'une reconstitution.** Les changements de leader et les
 *    dépassements sont relevés **pas à pas** : les dépassements avec `OvertakeTracker`, le porteur du
 *    rang 1 par la même règle de départage que `computeRanks` (`RANK.TIE_BREAK`) ; les événements
 *    sont relevés sur `CharacterState.activeEvent`, c'est-à-dire sur ce que le moteur a réellement
 *    appliqué.
 * 2. **Le speaker se mesure sur sa discipline déterministe, pas sur le framerate.** Le harnais
 *    libère chaque réplique immédiatement après son démarrage (`finish()`), ce qui est la borne
 *    **haute** du nombre de répliques : la durée d'affichage réelle (P009-C) ne peut que réduire ce
 *    nombre. Un quatrième mode (`releaseDelayS`) permet de mesurer l'effet d'une libération plus
 *    lente sans jamais toucher au temps réel.
 *
 * Le corpus de seeds est **dérivé** de son cardinal (`corpusSeeds(n)`), donc reproductible à
 * l'identique : relancer le harnais avec le même `n` rejoue exactement les mêmes courses.
 */

import { CHARACTER_IDS } from '../src/core/characters';
import { GAME_CONFIG, RACE_CONFIG, SPEED, type GameConfig } from '../src/core/config';
import { RaceEngine } from '../src/core/engine';
import type { EventDefinition } from '../src/core/events';
import { OvertakeTracker } from '../src/core/overtakes';
import { gapMeters } from '../src/core/ranking';
import { hash32 } from '../src/core/rng';
import { CROCKFORD_ALPHABET, SEED_TEXT_LENGTH, isCanonicalSeedText } from '../src/core/seed';
import type { CharacterId, EventId, RaceFact, RaceState } from '../src/core/types';
import type { GateVerdict } from '../src/speaker/cooldowns';
import { SPEAKER_POLICY, type SpeakerPolicy } from '../src/speaker/policy';
import { Speaker } from '../src/speaker/Speaker';

/**
 * Instant simulé du leader retenu pour le critère « le leader à `t = 135 s` gagne ».
 *
 * **135 s est le début du quatrième et dernier segment** (`SEGMENT.DURATION_S = 45 s`, quatre
 * segments), donc l'instant où le dernier quart de course commence — et non un instant choisi pour
 * arranger une statistique. P010 a d'abord mesuré 171 s (9 s avant l'arrivée) : le critère y était
 * hors plage (`88,10 %` pour une plage `55 % – 85 %`), parce qu'à 171 s l'avance médiane du leader
 * (38,7 m) domine déjà l'écart-type du chemin parcouru sur les 9 s restantes (22–27 m). À 135 s, le
 * résultat est mesuré, pas supposé — voir `docs/balance-report.md`.
 */
export const LEADER_CHECK_S = 135;

/** Un événement par type du catalogue. */
export type EventCounts = Readonly<Record<EventId, number>>;

/** Nombre de courses `< 12` et `> 30` répliques (constantes de lecture du rapport, pas des seuils). */
export const SPEAKER_TARGET_MIN = 12;
export const SPEAKER_TARGET_MAX = 30;

/** Métriques d'une course, telles que mesurées — jamais recalculées depuis autre chose. */
export interface BalanceRaceObservation {
  readonly seed: string;
  readonly distances: readonly number[];
  readonly ranking: readonly CharacterId[];
  readonly steps: number;
  readonly tSim: number;
  /** Écart P1–P6 à `tSim = 180 s`, en mètres. */
  readonly gap1to6: number;
  /** Écart P1–P2 à `tSim = 180 s`, en mètres. */
  readonly gap1to2: number;
  /** Leader à `tSim = 135 s`, ou `null` si l'instant n'a pas été observé. */
  readonly leaderAtCheck: CharacterId | null;
  readonly leaderChanges: number;
  readonly overtakes: number;
  readonly eventsTotal: number;
  readonly eventsPerCharacter: readonly number[];
  readonly eventsByType: EventCounts;
  /** Surges **bonus** (magnitude positive) par personnage. */
  readonly surgeBonuses: readonly number[];
  /** Surges **frein** (magnitude négative) par personnage. */
  readonly surgeBrakes: readonly number[];
  /** Vitesse moyenne sur toute la course, par personnage (`SPEED.BASE ± 1,5 %` de §13). */
  readonly meanSpeedPerCharacter: readonly number[];
  /** Distance finale par personnage, pour la moyenne par personnage. */
  readonly distancePerCharacter: readonly number[];
  /** Répliques du speaker démarrées sur la course (discipline déterministe). */
  readonly speakerLines: number;
  /** Refus par porte du speaker, du plus structurel au plus conjoncturel. */
  readonly speakerGateRejections: Readonly<Record<GateVerdict, number>>;
  /** Refus d'admission, avant toute mise en file. */
  readonly speakerRejections: Readonly<Record<'IMPORTANCE' | 'DEDUP' | 'QUEUE' | 'QUEUE_DROP', number>>;
  /** Le quota d'un segment a-t-il été atteint ? Diagnostic de saturation, jamais un critère §13. */
  readonly speakerQuotaSaturated: boolean;
  /** Candidats admis en file (donc au-dessus de `MIN_IMPORTANCE` et non dédupliqués). */
  readonly speakerAdmitted: number;
  /** Répliques préemptées par une plus importante. */
  readonly speakerPreempted: number;
  /** Instants de départ des répliques, en secondes simulées — pour l'analyse des écarts. */
  readonly speakerStartTimes: readonly number[];
  /** Instants de faits ayant donné lieu à une consultation de la file du speaker. */
  readonly speakerPolls: number;}

/** Options de campagne : toutes ont une valeur par défaut, aucune n'altère le noyau. */
export interface BalanceCampaignOptions {
  /** Politique du speaker. Par défaut celle de production. */
  readonly policy?: SpeakerPolicy;
  /** Libération de la réplique en cours, en secondes simulées. `0` = libération immédiate. */
  readonly releaseDelayS?: number;
  /** Mesurer la discipline du speaker (coûteux : deux machines à états par course). */
  readonly measureSpeaker?: boolean;
  /**
   * Cadence de consultation de la file du speaker, en **secondes simulées**. `0` (défaut) = à chaque
   * pas, soit la borne haute de densité.
   *
   * La cadence ne doit **jamais** être celle du rendu réel : `RaceSimulation` consulte le speaker à
   * chaque pas simulé, et la discipline de parole appartient au temps simulé. Un harnais qui ne
   * consulterait la file qu'à l'arrivée d'un fait mesurerait la densité des faits, pas celle du
   * speaker — deux choses différentes, et c'est la seconde que `GAME_DESIGN.md` §13 chiffre.
   */
  readonly pollIntervalS?: number;
  /**
   * Configuration du noyau. Par défaut `GAME_CONFIG`. Sert **uniquement** aux diagnostics de mise au
   * point (isoler la part d'un sous-système dans le biais) : jamais à faire varier une règle en
   * production, et jamais à publier un chiffre qui ne serait pas celui de `GAME_CONFIG`.
   */
  readonly config?: GameConfig;
  /**
   * Catalogue d'événements à mesurer. Par défaut `EVENT_CATALOG`. Comme `config`, il n'existe que
   * pour les diagnostics de mise au point : la campagne publiée mesure toujours le catalogue réel.
   */
  readonly catalog?: readonly EventDefinition[];
}

const EMPTY_EVENTS_BY_TYPE = (): Record<EventId, number> => ({
  TURBO: 0,
  CHUTE: 0,
  VENT_DE_FACE: 0,
  RACCOURCI: 0,
  POULET: 0,
  SIESTE: 0,
  MEGA_TURBO: 0,
});

const EMPTY_GATE_REJECTIONS = (): Record<GateVerdict, number> => ({
  ALLOWED: 0,
  SEGMENT_QUOTA: 0,
  TYPE_COOLDOWN: 0,
  GLOBAL_COOLDOWN: 0,
  SLIDING_REFUSED: 0,
});

const EMPTY_SPEAKER_REJECTIONS = (): Record<'IMPORTANCE' | 'DEDUP' | 'QUEUE' | 'QUEUE_DROP', number> => ({
  IMPORTANCE: 0,
  DEDUP: 0,
  QUEUE: 0,
  QUEUE_DROP: 0,
});

/** Somme de contrôle de l'état d'un personnage, pour compter les événements qui **démarrent**. */
interface ActiveEventStamp {
  readonly id: EventId;
  readonly startSimS: number;
}

/**
 * Corpus déterministe de `count` seeds affichables.
 *
 * Chaque seed est `hash32('<préfixe>:<index>')` écrit en Base32 Crockford sur 8 caractères : deux
 * appels avec le même `count` produisent exactement le même corpus, et deux `count` différents
 * partagent leur **préfixe** (le corpus de 1000 commence par celui de 300, par construction).
 */
export function corpusSeeds(count: number, prefix = 'balance-p010'): readonly string[] {
  if (!Number.isInteger(count) || count < 1) {
    throw new RangeError(`corpusSeeds : nombre de seeds invalide (${count}).`);
  }

  const seeds: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const value = hash32(`${prefix}:${index}`);
    let text = '';
    // 8 caractères × 5 bits = les 40 bits de poids faible du hachage, écrits sans biais de modulo.
    for (let character = 0; character < SEED_TEXT_LENGTH; character += 1) {
      const shift = (character * 5) % 32;
      const symbol = ((value >>> shift) ^ (character === 7 ? value >>> 4 : 0)) & 31;
      text += CROCKFORD_ALPHABET.charAt(symbol);
    }
    if (!isCanonicalSeedText(text)) {
      throw new RangeError(`corpusSeeds : seed non canonique générée (${text}).`);
    }
    seeds.push(text);
  }
  return Object.freeze(seeds);
}

/**
 * Joue une course complète et relève toutes les métriques d'équilibrage.
 *
 * Le relevé est fait **pas à pas**, ce qui est la granularité de référence de P009 : ni le rendu, ni
 * un échantillonnage ne peuvent manquer un aller-retour de rang.
 */
export function observeRace(seed: string, options: BalanceCampaignOptions = {}): BalanceRaceObservation {
  const policy = options.policy ?? SPEAKER_POLICY;
  const releaseDelayS = options.releaseDelayS ?? 0;
  const measureSpeaker = options.measureSpeaker ?? true;
  const pollIntervalS = options.pollIntervalS ?? 0;

  const engine = new RaceEngine(seed, options.config ?? GAME_CONFIG, {
    ...(options.catalog === undefined ? {} : { catalog: options.catalog }),
  });
  const tracker = new OvertakeTracker();
  const speaker = measureSpeaker ? new Speaker(policy) : null;

  const ids = CHARACTER_IDS;
  const count = ids.length;

  /**
   * Index **stable** de chaque personnage.
   *
   * L'identité d'un personnage est son `id`, jamais sa position dans `state.characters` : rien ne
   * garantit que ce tableau reste dans l'ordre de `CHARACTER_IDS` (aujourd'hui c'est le cas, mais
   * l'ordre est un détail d'implémentation du noyau, et le harnais ne doit pas en dépendre).
   * Toutes les mesures par personnage passent donc par cette table.
   */
  const slotOf = new Map<CharacterId, number>(ids.map((id, index) => [id, index]));

  const eventsByType = EMPTY_EVENTS_BY_TYPE();
  const gateRejections = EMPTY_GATE_REJECTIONS();
  const speakerRejections = EMPTY_SPEAKER_REJECTIONS();
  const eventsPerCharacter = new Array<number>(count).fill(0);
  const surgeBonuses = new Array<number>(count).fill(0);
  const surgeBrakes = new Array<number>(count).fill(0);
  const speedSums = new Array<number>(count).fill(0);
  const activeStamps: (ActiveEventStamp | null)[] = new Array<ActiveEventStamp | null>(count).fill(null);
  /**
   * Magnitude de surge **déjà comptée** par personnage.
   *
   * `CharacterState.surge` est republié à chaque pas tant que le surge dure : compter les pas
   * mesurerait une durée, pas un nombre de surges. On ne compte donc qu'un **démarrage**, c'est-à-dire
   * le passage de `0` à une magnitude non nulle — une magnitude ne peut pas changer en cours de
   * surge (`stepSurge` la tire une fois, au démarrage).
   */
  const countedSurgeMagnitudes = new Array<number>(count).fill(0);

  let steps = 0;
  let leaderChanges = 0;
  let overtakes = 0;
  let eventsTotal = 0;
  let leaderAtCheck: CharacterId | null = null;
  let releasePendingAtS: number | null = null;
  let quotaSaturated = false;
  let speakerAdmitted = 0;
  let speakerPreempted = 0;
  let speakerPolls = 0;
  let speakerLines = 0;
  let nextPollAtS = 0;
  const speakerStartTimes: number[] = [];

  /** Distances du pas courant, réutilisées d'un pas à l'autre (jamais conservées par l'appelant). */
  const xs = new Array<number>(count).fill(0);

  /**
   * Index du porteur du rang 1 au pas précédent.
   *
   * Le critère §13 « changements de leader » compte les changements **bruts** du porteur du rang 1
   * (la qualification par `LEADER.DEBOUNCE_S` de §8.3 est une notion de l'observateur de faits, elle
   * ne modifie ni le classement ni la course).
   */
  let previousLeaderIndex = leaderIndexFrom(engine.getState().characters, slotOf, count);

  while (engine.getState().phase.kind !== 'finished') {
    engine.step();
    steps += 1;

    const state = engine.getState();

    // **Un seul passage** par pas sur les personnages : distances, vitesse, surges, événements et
    // désignation du leader. Le harnais mesure 1000 courses par campagne, donc chaque allocation
    // évitée ici compte ; `xs` est réutilisé d'un pas à l'autre (`OvertakeTracker.observe` ne le
    // conserve pas).
    let leaderIndex = 0;
    for (const character of state.characters) {
      const index = slotOf.get(character.id) ?? 0;
      const x = character.x;
      xs[index] = x;
      if (x > (xs[leaderIndex] ?? 0)) {
        leaderIndex = index;
      }

      speedSums[index] = (speedSums[index] ?? 0) + character.v;

      // Surge : un seul comptage par surge démarré, bonus et frein distingués par le signe.
      const surge = character.surge;
      if (surge !== (countedSurgeMagnitudes[index] ?? 0)) {
        countedSurgeMagnitudes[index] = surge;
        if (surge > 0) {
          surgeBonuses[index] = (surgeBonuses[index] ?? 0) + 1;
        } else if (surge < 0) {
          surgeBrakes[index] = (surgeBrakes[index] ?? 0) + 1;
        }
      }

      // Événement : on ne compte que les **déclenchements**, pas les pas d'application. Un
      // déclenchement est reconnu à son `startSimS`, seule grandeur qui change d'un événement à
      // l'autre sur un même personnage (`MAX_ACTIVE_PER_CHARACTER = 1`).
      const active = character.activeEvent;
      const previous = activeStamps[index] ?? null;
      if (active !== null && (previous === null || previous.startSimS !== active.startSimS)) {
        eventsPerCharacter[index] = (eventsPerCharacter[index] ?? 0) + 1;
        eventsTotal += 1;
        eventsByType[active.id] = (eventsByType[active.id] ?? 0) + 1;
      }
      activeStamps[index] =
        active === null ? null : { id: active.id, startSimS: active.startSimS };
    }

    overtakes += tracker.observe(xs, ids).length;

    // Le porteur du rang 1 est celui de distance maximale, égalité départagée par index croissant —
    // exactement `RANK.TIE_BREAK = 'ascendingId'`, donc le même leader que `computeRanks` + rang 1,
    // sans trier six distances à chaque pas (10800 tris par course, ×1000 courses).
    if (leaderIndex !== previousLeaderIndex) {
      leaderChanges += 1;
    }
    previousLeaderIndex = leaderIndex;

    if (leaderAtCheck === null && state.tSim >= LEADER_CHECK_S) {
      leaderAtCheck = ids[leaderIndex] ?? null;
    }

    if (speaker !== null) {
      if (releasePendingAtS !== null && state.tSim >= releasePendingAtS) {
        speaker.finish();
        releasePendingAtS = null;
      }
      const facts = engine.drainFacts();
      if (facts.length > 0) {
        const before = speaker.totalLinesStarted();
        feedSpeaker(speaker, facts, gateRejections, speakerRejections);
        const started = speaker.totalLinesStarted() - before;
        speakerLines += started;
        for (let index = 0; index < started; index += 1) {
          speakerStartTimes.push(state.tSim);
        }
        if (started > 0) {
          if (releaseDelayS <= 0) {
            speaker.finish();
          } else {
            releasePendingAtS = state.tSim + releaseDelayS;
          }
        }
        const stats = speaker.stats();
        speakerAdmitted = stats.queued + stats.queuedDropped;
      }

      // Consultation de la file à **cadence simulée fixe**, indépendante de l'arrivée des faits — et
      // donc du framerate. C'est la cadence réelle de `RaceSimulation` : à chaque pas.
      if (state.tSim >= nextPollAtS) {
        nextPollAtS = state.tSim + pollIntervalS;
        const before = speaker.totalLinesStarted();
        const decision = speaker.poll(state.tSim);
        speakerPolls += 1;
        const started = speaker.totalLinesStarted() - before;
        if (started > 0) {
          speakerLines += started;
          speakerStartTimes.push(decision?.startedAtS ?? state.tSim);
          if (releaseDelayS <= 0) {
            speaker.finish();
          } else {
            releasePendingAtS = state.tSim + releaseDelayS;
          }
        }
      }
    }
  }

  const finalState = engine.getState();
  const finalXs = finalState.characters.map((character) => character.x);
  const result = engine.runToCompletion();
  if (speaker !== null) {
    speakerPreempted = speaker.stats().preempted;
  }
  // Écart P1–P6 : `gapMeters` est indexé **par personnage** et rend, pour chacun, son retard sur le
  // leader. L'écart entre le premier et le dernier est donc le **maximum** de ce tableau — et surtout
  // pas `gapMeters(xs)[5]`, qui serait le retard du personnage d'identifiant `c5` (nul quand `c5` est
  // lui-même leader). Écart P1–P2 : les deux plus grandes distances, par tri décroissant.
  const orderedXs = [...finalXs].sort((left, right) => right - left);
  const gap1to2 = (orderedXs[0] ?? 0) - (orderedXs[1] ?? 0);
  const gap1to6 = Math.max(0, ...gapMeters(finalXs));
  for (let segment = 0; segment < policy.segmentCount; segment += 1) {
    if (speaker !== null && speaker.linesInSegment(segment) >= policy.maxLinesPerSegment) {
      quotaSaturated = true;
    }
  }

  return Object.freeze({
    seed,
    distances: Object.freeze([...result.distances]),
    ranking: Object.freeze([...result.ranking]),
    steps,
    tSim: finalState.tSim,
    gap1to6,
    gap1to2,
    leaderAtCheck,
    leaderChanges,
    overtakes,
    eventsTotal,
    eventsPerCharacter: Object.freeze([...eventsPerCharacter]),
    eventsByType: Object.freeze({ ...eventsByType }),
    surgeBonuses: Object.freeze([...surgeBonuses]),
    surgeBrakes: Object.freeze([...surgeBrakes]),
    meanSpeedPerCharacter: Object.freeze(speedSums.map((sum) => sum / steps)),
    distancePerCharacter: Object.freeze(distanceByCharacter(finalState, slotOf, count)),
    speakerLines,
    speakerGateRejections: Object.freeze({ ...gateRejections }),
    speakerRejections: Object.freeze({ ...speakerRejections }),
    speakerQuotaSaturated: quotaSaturated,
    speakerAdmitted: speaker === null ? 0 : speakerAdmitted,
    speakerPreempted: speaker === null ? 0 : speakerPreempted,
    speakerStartTimes: Object.freeze([...speakerStartTimes]),
    speakerPolls,
  });
}

/**
 * Index du porteur du rang 1 pour un tableau de personnages, égalité départagée par index croissant.
 *
 * C'est exactement `RANK.TIE_BREAK = 'ascendingId'` appliqué à `CHARACTER_IDS` (dont l'ordre est
 * `c0 < c1 < … < c5`) : comparer les distances avec un `>` strict conserve le premier index en cas
 * d'égalité, donc le même leader que `computeRanks(...).indexOf(1)`.
 */
function leaderIndexFrom(
  characters: readonly { readonly id: CharacterId; readonly x: number }[],
  slotOf: ReadonlyMap<CharacterId, number>,
  count: number,
): number {
  let leaderIndex = 0;
  let leaderX = Number.NEGATIVE_INFINITY;
  for (const character of characters) {
    const index = slotOf.get(character.id) ?? 0;
    if (character.x > leaderX) {
      leaderX = character.x;
      leaderIndex = index;
    }
  }
  return leaderIndex < count ? leaderIndex : 0;
}

/**
 * Distances finales, rangées dans l'ordre de `CHARACTER_IDS` (et non dans l'ordre du tableau d'état).
 *
 * Le harnais ne doit pas dépendre de l'ordre de `state.characters` : il remet chaque distance à sa
 * place à partir de l'identifiant, comme pour toutes les autres mesures par personnage.
 */
function distanceByCharacter(
  state: Readonly<RaceState>,
  slotOf: ReadonlyMap<CharacterId, number>,
  count: number,
): readonly number[] {
  const distances = new Array<number>(count).fill(0);
  for (const character of state.characters) {
    distances[slotOf.get(character.id) ?? 0] = character.x;
  }
  return distances;
}

/**
 * Alimente le speaker avec les faits d'un pas, puis relâche la réplique selon le mode choisi.
 *
 * Le démarrage des répliques n'est **pas** décidé ici : la file est consultée séparément, à cadence
 * simulée fixe (`observeRace`), exactement comme le fait la simulation réelle. Chaque fait est
 * présenté individuellement — ils partagent tous le même instant simulé, donc l'ordre d'arrivée en
 * file reste celui des faits du noyau.
 */
function feedSpeaker(
  speaker: Speaker,
  facts: readonly RaceFact[],
  gateRejections: Record<GateVerdict, number>,
  speakerRejections: Record<'IMPORTANCE' | 'DEDUP' | 'QUEUE' | 'QUEUE_DROP', number>,
): void {
  const before = speaker.stats();
  for (const fact of facts) {
    speaker.feed(fact);
  }
  const after = speaker.stats();

  speakerRejections.IMPORTANCE += after.rejectedImportance - before.rejectedImportance;
  speakerRejections.DEDUP += after.deduplicated - before.deduplicated;
  speakerRejections.QUEUE += after.rejectedQueue - before.rejectedQueue;
  speakerRejections.QUEUE_DROP += after.queuedDropped - before.queuedDropped;
  const verdict = speaker.lastGateVerdict();
  if (verdict !== null && verdict !== 'ALLOWED') {
    gateRejections[verdict] += 1;
  }

  speaker.drain();
}

/** Statistiques descriptives d'une série, percentiles par interpolation linéaire. */
export interface Distribution {
  readonly min: number;
  readonly p5: number;
  readonly p25: number;
  readonly median: number;
  readonly p75: number;
  readonly p95: number;
  readonly max: number;
  readonly mean: number;
}

/** Distribution triée, percentiles interpolés (méthode linéaire, déterministe). */
export function distribution(values: readonly number[]): Distribution {
  if (values.length === 0) {
    throw new RangeError('distribution : série vide.');
  }
  const sorted = [...values].sort((left, right) => left - right);
  const last = sorted.length - 1;
  const at = (quantile: number): number => {
    const position = quantile * last;
    const low = Math.floor(position);
    const high = Math.min(low + 1, last);
    const weight = position - low;
    return (sorted[low] ?? 0) * (1 - weight) + (sorted[high] ?? 0) * weight;
  };
  const sum = sorted.reduce((total, value) => total + value, 0);

  return Object.freeze({
    min: sorted[0] ?? 0,
    p5: at(0.05),
    p25: at(0.25),
    median: at(0.5),
    p75: at(0.75),
    p95: at(0.95),
    max: sorted[last] ?? 0,
    mean: sum / sorted.length,
  });
}

/** Statistiques agrégées d'un corpus. */
export interface BalanceMetrics {
  readonly seedCount: number;
  readonly leaderCheckS: number;
  /** Toutes les courses ont-elles fait exactement `RACE_CONFIG.TOTAL_STEPS` pas ? */
  readonly exactSteps: boolean;
  readonly steps: number;

  readonly gap1to6: Distribution;
  readonly gap1to2: Distribution;
  readonly leaderAtCheckWinRate: number;

  readonly leaderChanges: Distribution;
  readonly leaderChangesMean: number;
  readonly overtakes: Distribution;
  readonly overtakesMean: number;

  readonly winsPerCharacter: readonly number[];
  readonly winRatePerCharacter: readonly number[];

  readonly eventsTotalMean: number;
  readonly eventsPerCharacterMean: readonly number[];
  readonly eventsPerCharacterShare: readonly number[];
  readonly eventsByTypePerRace: EventCounts;
  readonly eventsByTypeShare: Readonly<Record<EventId, number>>;

  readonly surgeBonusPerCharacterMean: readonly number[];
  readonly surgeBrakePerCharacterMean: readonly number[];
  readonly surgesPerCharacterMean: readonly number[];

  readonly meanSpeedPerCharacter: readonly number[];
  readonly meanDistancePerCharacter: readonly number[];
  /** Biais relatif de la vitesse moyenne de chaque personnage, en points de pourcentage. */
  readonly speedBiasPercentPerCharacter: readonly number[];
  /** Maximum des valeurs absolues ci-dessus : le critère §13 (`±1,5 %`) est évalué sur ce nombre. */
  readonly maxAbsSpeedBiasPercent: number;

  readonly speakerLines: Distribution | null;
  /** Courses sous la cible basse de §13 (`< 12` répliques). */
  readonly speakerLinesUnderTarget: number;
  /** Courses au-dessus de la cible haute de §13 (`> 30` répliques). */
  readonly speakerLinesOverTarget: number;
  /** Courses **muettes** (`0` réplique) : la traîne extrême de la distribution, publiée telle quelle. */
  readonly speakerLinesAtZero: number;
  readonly speakerGateRejections: Readonly<Record<GateVerdict, number>>;
  readonly speakerRejections: Readonly<Record<'IMPORTANCE' | 'DEDUP' | 'QUEUE' | 'QUEUE_DROP', number>>;
  readonly speakerQuotaSaturatedRaces: number;
}

function meanOf(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function sumByCharacter(
  observations: readonly BalanceRaceObservation[],
  select: (observation: BalanceRaceObservation) => readonly number[],
): readonly number[] {
  const totals = new Array<number>(CHARACTER_IDS.length).fill(0);
  for (const observation of observations) {
    const values = select(observation);
    for (const [index, value] of values.entries()) {
      totals[index] = (totals[index] ?? 0) + value;
    }
  }
  return totals;
}

/** Agrège un corpus de courses en métriques comparables aux seuils de `GAME_DESIGN.md` §13. */
export function aggregate(
  observations: readonly BalanceRaceObservation[],
  options: { readonly leaderCheckS?: number } = {},
): BalanceMetrics {
  if (observations.length === 0) {
    throw new RangeError('aggregate : corpus vide.');
  }

  const leaderCheckS = options.leaderCheckS ?? LEADER_CHECK_S;
  const count = CHARACTER_IDS.length;

  const wins = new Array<number>(count).fill(0);
  for (const observation of observations) {
    const winner = observation.ranking[0];
    if (winner !== undefined) {
      const index = CHARACTER_IDS.indexOf(winner);
      if (index >= 0) {
        wins[index] = (wins[index] ?? 0) + 1;
      }
    }
  }

  const eventsPerCharacterTotal = sumByCharacter(observations, (observation) => observation.eventsPerCharacter);
  const surgeBonusTotal = sumByCharacter(observations, (observation) => observation.surgeBonuses);
  const surgeBrakeTotal = sumByCharacter(observations, (observation) => observation.surgeBrakes);
  const speedTotal = sumByCharacter(observations, (observation) => observation.meanSpeedPerCharacter);
  const distanceTotal = sumByCharacter(observations, (observation) => observation.distancePerCharacter);

  const races = observations.length;
  const eventsPerCharacterMean = eventsPerCharacterTotal.map((total) => total / races);
  const eventsGrandTotal = eventsPerCharacterTotal.reduce((total, value) => total + value, 0);

  const eventsByTypePerRace = EMPTY_EVENTS_BY_TYPE();
  for (const observation of observations) {
    for (const [type, value] of Object.entries(observation.eventsByType)) {
      const key = type as EventId;
      eventsByTypePerRace[key] = (eventsByTypePerRace[key] ?? 0) + value / races;
    }
  }
  const eventsByTypeShare = EMPTY_EVENTS_BY_TYPE();
  const eventsByTypeTotal = Object.values(eventsByTypePerRace).reduce((total, value) => total + value, 0);
  for (const [type, value] of Object.entries(eventsByTypePerRace)) {
    const key = type as EventId;
    eventsByTypeShare[key] = eventsByTypeTotal === 0 ? 0 : (value / eventsByTypeTotal) * 100;
  }

  const meanSpeedPerCharacter = speedTotal.map((total) => total / races);
  const speedBiasPercentPerCharacter = meanSpeedPerCharacter.map(
    (speed) => ((speed - SPEED.BASE) / SPEED.BASE) * 100,
  );

  const gateRejections = EMPTY_GATE_REJECTIONS();
  const speakerRejections = EMPTY_SPEAKER_REJECTIONS();
  const speakerLinesValues: number[] = [];
  let speakerLinesUnderTarget = 0;
  let speakerLinesOverTarget = 0;
  let speakerLinesAtZero = 0;
  let speakerQuotaSaturatedRaces = 0;

  for (const observation of observations) {
    for (const [gate, value] of Object.entries(observation.speakerGateRejections)) {
      const key = gate as GateVerdict;
      gateRejections[key] = (gateRejections[key] ?? 0) + value;
    }
    for (const [stage, value] of Object.entries(observation.speakerRejections)) {
      const key = stage as 'IMPORTANCE' | 'DEDUP' | 'QUEUE' | 'QUEUE_DROP';
      speakerRejections[key] = (speakerRejections[key] ?? 0) + value;
    }
    speakerLinesValues.push(observation.speakerLines);
    if (observation.speakerLines < SPEAKER_TARGET_MIN) {
      speakerLinesUnderTarget += 1;
    }
    if (observation.speakerLines > SPEAKER_TARGET_MAX) {
      speakerLinesOverTarget += 1;
    }
    if (observation.speakerLines === 0) {
      speakerLinesAtZero += 1;
    }
    if (observation.speakerQuotaSaturated) {
      speakerQuotaSaturatedRaces += 1;
    }
  }

  const overtakesPerRace = observations.map((observation) => observation.overtakes);
  const leaderChangesPerRace = observations.map((observation) => observation.leaderChanges);
  const gaps1to6 = observations.map((observation) => observation.gap1to6);

  const leaderAtCheckWins = observations.filter(
    (observation) => observation.leaderAtCheck !== null && observation.ranking[0] === observation.leaderAtCheck,
  ).length;

  return Object.freeze({
    seedCount: races,
    leaderCheckS,
    exactSteps: observations.every((observation) => observation.steps === RACE_CONFIG.TOTAL_STEPS),
    steps: observations[0]?.steps ?? 0,

    gap1to6: distribution(gaps1to6),
    gap1to2: distribution(observations.map((observation) => observation.gap1to2)),
    leaderAtCheckWinRate: (leaderAtCheckWins / races) * 100,

    leaderChanges: distribution(leaderChangesPerRace),
    leaderChangesMean: meanOf(leaderChangesPerRace),
    overtakes: distribution(overtakesPerRace),
    overtakesMean: meanOf(overtakesPerRace),

    winsPerCharacter: Object.freeze([...wins]),
    winRatePerCharacter: Object.freeze(wins.map((value) => (value / races) * 100)),

    eventsTotalMean: meanOf(observations.map((observation) => observation.eventsTotal)),
    eventsPerCharacterMean: Object.freeze(eventsPerCharacterMean),
    eventsPerCharacterShare: Object.freeze(
      eventsPerCharacterTotal.map((total) =>
        eventsGrandTotal === 0 ? 0 : (total / eventsGrandTotal) * 100,
      ),
    ),
    eventsByTypePerRace: Object.freeze(eventsByTypePerRace),
    eventsByTypeShare: Object.freeze(eventsByTypeShare),

    surgeBonusPerCharacterMean: Object.freeze(surgeBonusTotal.map((total) => total / races)),
    surgeBrakePerCharacterMean: Object.freeze(surgeBrakeTotal.map((total) => total / races)),
    surgesPerCharacterMean: Object.freeze(
      surgeBonusTotal.map((total, index) => (total + (surgeBrakeTotal[index] ?? 0)) / races),
    ),

    meanSpeedPerCharacter: Object.freeze(meanSpeedPerCharacter),
    meanDistancePerCharacter: Object.freeze(distanceTotal.map((total) => total / races)),
    speedBiasPercentPerCharacter: Object.freeze(speedBiasPercentPerCharacter),
    maxAbsSpeedBiasPercent: Math.max(...speedBiasPercentPerCharacter.map((value) => Math.abs(value))),

    speakerLines: speakerLinesValues.some((value) => value > 0) ? distribution(speakerLinesValues) : null,
    speakerLinesUnderTarget,
    speakerLinesOverTarget,
    speakerLinesAtZero,
    speakerGateRejections: Object.freeze(gateRejections),
    speakerRejections: Object.freeze(speakerRejections),
    speakerQuotaSaturatedRaces,
  });
}

// ---------------------------------------------------------------------------------------------
// Campagne
// ---------------------------------------------------------------------------------------------

/** Une campagne terminée : les observations brutes (pour le rapport) et les métriques agrégées. */
export interface BalanceCampaignResult {
  readonly seeds: readonly string[];
  readonly observations: readonly BalanceRaceObservation[];
  readonly metrics: BalanceMetrics;
}

/**
 * Joue un corpus complet. Le corpus est **donné**, jamais tiré : deux campagnes sur la même liste
 * produisent exactement les mêmes courses, et `corpusSeeds(n)` fournit la liste standard.
 */
export function runBalanceCampaign(
  seeds: readonly string[],
  options: BalanceCampaignOptions = {},
): BalanceCampaignResult {
  if (seeds.length === 0) {
    throw new RangeError('runBalanceCampaign : corpus vide.');
  }

  const observations: BalanceRaceObservation[] = [];
  for (const seed of seeds) {
    observations.push(observeRace(seed, options));
  }

  const metrics = aggregate(observations, { leaderCheckS: LEADER_CHECK_S });
  return Object.freeze({
    seeds: Object.freeze([...seeds]),
    observations: Object.freeze(observations),
    metrics,
  });
}

/** Verdict d'un critère §13, avec la valeur mesurée et la plage attendue. */
export interface BalanceCriterion {
  /**
   * Identifiant **stable et ASCII** du critère.
   *
   * Le libellé français est destiné à l'humain (et change avec la rédaction) ; l'identifiant est
   * destiné aux rapports machine (`--json`) et aux tests, qui ne doivent pas casser parce qu'un
   * accent a bougé dans un titre.
   */
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly expected: string;
  readonly pass: boolean;
}

/** Vérifie un critère à deux bornes, bornes incluses. */
export function criterionInRange(
  id: string,
  label: string,
  value: number,
  min: number,
  max: number,
  format: (value: number) => string = (input) => input.toFixed(3),
): BalanceCriterion {
  return Object.freeze({
    id,
    label,
    value: format(value),
    expected: `[${format(min)} ; ${format(max)}]`,
    pass: value >= min && value <= max,
  });
}

/** Vérifie un critère minorant (`≥`) ou majorant (`≤`). */
export function criterionAtLeast(
  id: string,
  label: string,
  value: number,
  minimum: number,
  format: (value: number) => string = (input) => input.toFixed(3),
): BalanceCriterion {
  return Object.freeze({
    id,
    label,
    value: format(value),
    expected: `≥ ${format(minimum)}`,
    pass: value >= minimum,
  });
}

/** Vérifie un critère majorant (`≤`). */
export function criterionAtMost(
  id: string,
  label: string,
  value: number,
  maximum: number,
  format: (value: number) => string = (input) => input.toFixed(3),
): BalanceCriterion {
  return Object.freeze({
    id,
    label,
    value: format(value),
    expected: `≤ ${format(maximum)}`,
    pass: value <= maximum,
  });
}

/**
 * Critères de `GAME_DESIGN.md` §13, tels qu'ils sont écrits dans le document.
 *
 * Cette fonction est la **seule** définition des seuils : le script de campagne et le test
 * d'équilibrage l'appellent tous les deux, donc un seuil ne peut pas diverger entre les deux.
 */
export function balanceCriteria(metrics: BalanceMetrics): readonly BalanceCriterion[] {
  const integer = (value: number): string => value.toFixed(2);
  const percent = (value: number): string => `${value.toFixed(2)} %`;
  const meters = (value: number): string => `${value.toFixed(2)} m`;

  const criteria: BalanceCriterion[] = [
    criterionInRange('gap-p1p6-median', 'Écart P1–P6 (médiane)', metrics.gap1to6.median, 80, 260, meters),
    criterionAtLeast('gap-p1p6-p5', 'Écart P1–P6 (p5)', metrics.gap1to6.p5, 25, meters),
    criterionAtMost('gap-p1p6-p95', 'Écart P1–P6 (p95)', metrics.gap1to6.p95, 500, meters),
    criterionInRange(
      'leader-at-check-wins',
      `Leader à t=${metrics.leaderCheckS} s gagne`,
      metrics.leaderAtCheckWinRate,
      55,
      85,
      percent,
    ),
    criterionInRange(
      'leader-changes-mean',
      'Changements de leader (moyenne)',
      metrics.leaderChangesMean,
      6,
      20,
      integer,
    ),
    criterionAtLeast('overtakes-mean', 'Dépassements (moyenne)', metrics.overtakesMean, 25, integer),
    // §13 : « Répliques du speaker par course | 12 – 30 ». Comme les deux lignes voisines
    // (« Événements par course (moyenne) », « Surges par personnage »), la ligne se lit sur la
    // **moyenne** du corpus. La dispersion par course est publiée à part (et dans le rapport), parce
    // qu'une moyenne dans la plage ne dit rien des courses les plus pauvres en répliques.
    ...(metrics.speakerLines === null
      ? []
      : [
          criterionInRange(
            'speaker-lines-mean',
            'Répliques du speaker par course (moyenne)',
            metrics.speakerLines.mean,
            SPEAKER_TARGET_MIN,
            SPEAKER_TARGET_MAX,
            integer,
          ),
        ]),
    criterionInRange(
      'events-per-race-mean',
      'Événements par course (moyenne)',
      metrics.eventsTotalMean,
      10,
      16,
      integer,
    ),
    criterionAtMost(
      'events-per-character-max',
      'Événements par personnage (max)',
      Math.max(...metrics.eventsPerCharacterMean),
      5,
      integer,
    ),
    criterionAtLeast(
      'surges-per-character-min',
      'Surges par personnage (min)',
      Math.min(...metrics.surgesPerCharacterMean),
      14,
      integer,
    ),
    criterionAtMost(
      'surges-per-character-max',
      'Surges par personnage (max)',
      Math.max(...metrics.surgesPerCharacterMean),
      26,
      integer,
    ),
    criterionAtMost(
      'speed-bias-max-abs',
      'Vitesse moyenne : biais max |·|',
      metrics.maxAbsSpeedBiasPercent,
      1.5,
      percent,
    ),
    Object.freeze({
      id: 'steps-exact',
      label: 'Nombre de pas par course',
      value: metrics.exactSteps ? `${metrics.steps} exactement` : `${metrics.steps} (variable)`,
      expected: `${RACE_CONFIG.TOTAL_STEPS} exactement`,
      pass: metrics.exactSteps && metrics.steps === RACE_CONFIG.TOTAL_STEPS,
    }),
  ];

  for (const [index, rate] of metrics.winRatePerCharacter.entries()) {
    const id = CHARACTER_IDS[index] ?? `#${index}`;
    criteria.push(criterionInRange(`win-rate-${id}`, `Victoire ${id}`, rate, 12, 22, percent));
  }

  for (const [index, share] of metrics.eventsPerCharacterShare.entries()) {
    const id = CHARACTER_IDS[index] ?? `#${index}`;
    criteria.push(
      criterionInRange(`event-share-${id}`, `Part d'événements ${id}`, share, 10, 27, percent),
    );
  }

  return Object.freeze(criteria);
}

/** Résultat d'un contrôle de reproductibilité bit à bit. */
export interface ReproducibilityMeasurement {
  readonly seeds: number;
  readonly identicalDistances: number;
  readonly identicalRanking: number;
  readonly exactSteps: number;
  readonly mismatches: readonly string[];
}

/**
 * Rejoue chaque seed **deux fois** avec deux moteurs distincts et compare **bit à bit**.
 *
 * La comparaison est stricte (`Object.is`), pas une tolérance : c'est le critère §13 « 100/100 seeds
 * identiques bit à bit ». `runToCompletion()` est appelé après une première course complète, ce qui
 * vérifie au passage qu'un moteur déjà terminé ne consomme plus rien.
 */
export function measureReproducibility(seeds: readonly string[]): ReproducibilityMeasurement {
  let identicalDistances = 0;
  let identicalRanking = 0;
  let exactSteps = 0;
  const mismatches: string[] = [];

  for (const seed of seeds) {
    const firstEngine = new RaceEngine(seed);
    const first = firstEngine.runToCompletion();
    const secondEngine = new RaceEngine(seed);
    const second = secondEngine.runToCompletion();

    const distancesEqual =
      first.distances.length === second.distances.length &&
      first.distances.every((distance, index) => Object.is(distance, second.distances[index]));
    const rankingEqual =
      first.ranking.length === second.ranking.length &&
      first.ranking.every((id, index) => id === second.ranking[index]);
    const stepsEqual =
      firstEngine.getState().steps === RACE_CONFIG.TOTAL_STEPS &&
      secondEngine.getState().steps === RACE_CONFIG.TOTAL_STEPS;

    if (distancesEqual) {
      identicalDistances += 1;
    }
    if (rankingEqual) {
      identicalRanking += 1;
    }
    if (stepsEqual) {
      exactSteps += 1;
    }
    if (!distancesEqual || !rankingEqual || !stepsEqual) {
      mismatches.push(seed);
    }
  }

  return Object.freeze({
    seeds: seeds.length,
    identicalDistances,
    identicalRanking,
    exactSteps,
    mismatches: Object.freeze(mismatches),
  });
}
