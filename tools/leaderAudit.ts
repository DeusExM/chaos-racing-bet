/**
 * Audit statistique des **leaders aux bornes** — `npm run balance:leaders`.
 *
 * ## Pourquoi cet outil existe
 *
 * Un test joueur a donné l'impression que « le même personnage est souvent premier à 20 s, à 40 s et à
 * l'arrivée ». Un échantillon de trois courses ne prouve rien : cet outil mesure le comportement réel
 * sur un **gros corpus déterministe** (10 000 seeds par défaut), sans rien changer au jeu. Il ne
 * modifie aucune constante, ne consomme aucun tirage en dehors des courses qu'il rejoue, et ne touche
 * ni au RNG ni au classement : c'est un **instrument de mesure**, pas une règle.
 *
 * ## Ce qu'il mesure, et avec quelle source
 *
 * * le **leader exact** à 20 s, 40 s et 60 s (`RACE_CONFIG` : `SEGMENT_DURATION_S`, son double, et
 *   `TOTAL_SIM_S` — jamais des valeurs recopiées) ;
 * * le **vainqueur**, par le classement officiel (`core/ranking.ts`, `computeRanks`) ;
 * * les **changements de leader** bruts, comptés pas à pas avec la même convention que le harnais
 *   d'équilibrage (`balanceStats.observeRace`), pour être comparable à la référence `8,308` ;
 * * les **parts par personnage**, l'écart à `1/6`, le χ² d'uniformité et le z le plus défavorable ;
 * * les **matrices de transition** 20 → 40 s et 40 → 60 s, avec leur χ² d'indépendance ;
 * * la **persistance** : même leader aux trois bornes, exactement deux leaders distincts, trois
 *   leaders distincts ;
 * * des **contrôles de corpus** : les 10 000 seeds produisent-elles des courses différentes ?
 * * des **contrôles de flux RNG** : les streams `drift:<id>`, `surge:<id>`, `events:global`,
 *   `speaker:lines` et `cosmetic` sont-ils réellement indépendants, et le moteur les utilise-t-il
 *   bien par personnage ?
 *
 * ## Ce qu'il ne fait pas
 *
 * Il **ne conclut pas** à un bug sur une variation statistique : la persistance d'un leader est
 * attendue (un coureur qui a pris de l'avance a une probabilité réelle de rester devant). Ce que
 * l'outil peut détecter, ce sont des anomalies **structurelles** : un personnage systématiquement
 * favorisé (χ² hors table), des streams partagés ou corrélés, un corpus dégénéré (courses
 * identiques), une reproductibilité cassée.
 *
 * Le module n'importe rien de Node (le projet n'a pas `@types/node`) : c'est
 * `tools/leaderAuditRunner.mjs` qui écrit les rapports sur disque.
 */

import { CHARACTER_IDS } from '../src/core/characters';
import { RACE_CONFIG } from '../src/core/config';
import { RaceEngine } from '../src/core/engine';
import { computeRanks } from '../src/core/ranking';
import { forkStream } from '../src/core/rng';
import { normalizeSeed } from '../src/core/seed';
import type { CharacterId } from '../src/core/types';

import { corpusSeeds, measureReproducibility } from './balanceStats';

/** Taille par défaut du corpus d'audit. */
export const DEFAULT_AUDIT_SEEDS = 10_000;

/**
 * Sous-corpus servant à **recomparer aux références publiées** de la version 60 s.
 *
 * Ces références (victoires 15,3–18,4 %, changements de leader 8,308, leader à 40 s vainqueur
 * 63,20 %) ont été mesurées sur le corpus canonique de **1000 seeds**. Comme `corpusSeeds(n)` est un
 * préfixe (`corpusSeeds(10000)` commence par les 1000 mêmes seeds), les comparer directement est
 * légitime — et c'est le contrôle le plus direct de « rien n'a changé ».
 */
export const DEFAULT_REFERENCE_SEEDS = 1_000;

/** Seeds utilisées pour les contrôles **comportementaux** des flux (dérive, surge) : coûteux. */
export const DEFAULT_BEHAVIOR_SEEDS = 200;

/** Préfixe du corpus, celui du harnais d'équilibrage : les deux outils mesurent le même monde. */
export const DEFAULT_AUDIT_CORPUS = 'balance-p010';

export const DEFAULT_AUDIT_JSON = '.tmp/leader-audit.json';
export const DEFAULT_AUDIT_TEXT = '.tmp/leader-audit.txt';

/**
 * Bornes de mesure, **dérivées** de `RACE_CONFIG`.
 *
 * La course dure `TOTAL_SIM_S` (60 s) et compte `SEGMENT_COUNT` segments de `SEGMENT_DURATION_S`
 * (20 s) : les bornes sont donc la fin de chaque segment intermédiaire, puis l'arrivée. Il n'existe
 * pas de « checkpoint 3 » : la troisième borne **est** l'arrivée.
 */
export const LEADER_BOUNDS_S: readonly number[] = Object.freeze([
  RACE_CONFIG.SEGMENT_DURATION_S,
  2 * RACE_CONFIG.SEGMENT_DURATION_S,
  RACE_CONFIG.TOTAL_SIM_S,
]);

/** Libellés des bornes, pour les rapports. */
export const LEADER_BOUND_LABELS: readonly string[] = Object.freeze(
  LEADER_BOUNDS_S.map((seconds) => `${String(seconds)} s`),
);

/**
 * Valeurs critiques de χ², recopiées de la table usuelle (aucune fonction transcendante n'est
 * nécessaire, et le projet n'en utilise pas dans `core/`).
 *
 * `5` degrés de liberté = 6 personnages − 1 ; `9` = 10 classes d'uniformité − 1 ; `25` = (6−1)² pour
 * l'indépendance d'une matrice de transition 6 × 6.
 */
const CHI2_5DF_AT_05 = 11.07;
const CHI2_5DF_AT_01 = 15.09;
const CHI2_9DF_AT_05 = 16.92;
const CHI2_25DF_AT_05 = 37.65;

/**
 * Seuil **corrigé** pour les 15 flux RNG (Bonferroni : α = 0,05/15 ≈ 0,0033, arrondi au seuil
 * tabulé `p = 0,001`). Sans cette correction, un seuil à 5 % par flux donnerait une fausse alerte
 * dans plus d'une exécution sur deux (`1 − 0,95¹⁵ ≈ 54 %`) : l'outil crierait au loup une fois sur
 * deux, ce qui est exactement ce qu'un instrument de mesure ne doit pas faire.
 */
const CHI2_9DF_AT_0001 = 27.88;

/**
 * Seuil du z de couplage des dérives (15 paires comparées).
 *
 * `z = 4` correspond à `p ≈ 6 × 10⁻⁵` par paire, soit `≈ 0,1 %` pour la famille des 15 paires : un
 * flux partagé le dépasse largement (il donne un z infini, l'écart-type s'effondrant à zéro), tandis
 * qu'une série indépendante ne l'atteint pratiquement jamais.
 */
const DRIFT_Z_THRESHOLD = 4;

/**
 * Nombre minimal de courses pour que le z de couplage ait un sens.
 *
 * Un écart-type estimé sur deux ou trois courses est trop instable pour servir de dénominateur : le z
 * exploserait au hasard. En dessous de ce seuil, la paire est simplement **non testée** (z nul), et le
 * contrôle structurel (`forkStream` par personnage, séries distinctes) reste, lui, toujours actif.
 */
const MIN_DRIFT_CORRELATION_COURSES = 20;

/**
 * Seuil de z pour **6 comparaisons simultanées** à 5 % (correction de Bonferroni : α/6 = 0,00833,
 * bilatéral). Un |z| au-delà est signalé comme anomalie de part, pas comme bug.
 */
const Z_BONFERRONI_6 = 2.638;

/** Nombre de tirages comparés entre deux streams avant de conclure qu'ils sont identiques. */
const IDENTICAL_SEQUENCE_DRAWS = 8;

/** Une course auditée : les trois leaders, le vainqueur et les compteurs de course. */
export interface LeaderAuditRace {
  readonly seed: string;
  /** Leader observé à chaque borne, dans l'ordre de `LEADER_BOUNDS_S` (`null` si non observée). */
  readonly leaders: readonly (CharacterId | null)[];
  readonly winner: CharacterId;
  /** Changements **bruts** du porteur du rang 1, même convention que le harnais d'équilibrage. */
  readonly leaderChanges: number;
  /** Nombre de leaders distincts sur les trois bornes : `1`, `2` ou `3`. */
  readonly distinctLeaders: number;
  /** Distances finales, dans l'ordre du roster : sert au contrôle « courses différentes ». */
  readonly distances: readonly number[];
  /** Le suivi pas à pas et le classement officiel désignent-ils le même leader aux trois bornes ? */
  readonly leaderConsistent: boolean;
  /** Nombre de pas réellement exécutés (`3600` attendu). */
  readonly steps: number;
  /** Instant simulé final (`60` attendu). */
  readonly tSim: number;
}

/** Index du porteur du rang 1, égalité départagée par index croissant (politique `ascendingId`). */
function leaderIndexFrom(
  characters: readonly { readonly id: CharacterId; readonly x: number }[],
  slotOf: ReadonlyMap<CharacterId, number>,
): number {
  let leaderIndex = 0;
  let leaderX = Number.NEGATIVE_INFINITY;
  for (const character of characters) {
    if (character.x > leaderX) {
      leaderX = character.x;
      leaderIndex = slotOf.get(character.id) ?? 0;
    }
  }
  return leaderIndex;
}

/**
 * Joue une course complète et relève les leaders aux trois bornes.
 *
 * Aucune pause, aucun rendu, aucun speaker : c'est la course du noyau, telle que le classement la
 * voit. Le suivi pas à pas est **vérifié** contre `computeRanks` à chaque borne — si les deux
 * divergeaient, `leaderConsistent` passerait à `false` et le rapport le dirait.
 */
export function auditRace(seed: string): LeaderAuditRace {
  const engine = new RaceEngine(seed);
  const ids = CHARACTER_IDS;
  const count = ids.length;
  const slotOf = new Map<CharacterId, number>(ids.map((id, index) => [id, index]));
  const xs = new Array<number>(count).fill(0);

  const leaders: (CharacterId | null)[] = LEADER_BOUNDS_S.map(() => null);
  let leaderConsistent = true;
  let leaderChanges = 0;

  let state = engine.getState();
  let previousLeader = leaderIndexFrom(state.characters, slotOf);

  while (state.phase.kind !== 'finished') {
    engine.step();
    state = engine.getState();

    let leaderIndex = 0;
    for (const character of state.characters) {
      const index = slotOf.get(character.id) ?? 0;
      const x = character.x;
      xs[index] = x;
      if (x > (xs[leaderIndex] ?? 0)) {
        leaderIndex = index;
      }
    }

    if (leaderIndex !== previousLeader) {
      leaderChanges += 1;
    }
    previousLeader = leaderIndex;

    for (const [boundIndex, boundS] of LEADER_BOUNDS_S.entries()) {
      if (leaders[boundIndex] !== null || state.tSim < boundS) {
        continue;
      }
      leaders[boundIndex] = ids[leaderIndex] ?? null;
      // Contrôle indépendant : le classement officiel doit désigner le même leader.
      if (computeRanks(xs, ids).indexOf(1) !== leaderIndex) {
        leaderConsistent = false;
      }
    }
  }

  // Distances finales, remises dans l'ordre du roster.
  for (const character of state.characters) {
    xs[slotOf.get(character.id) ?? 0] = character.x;
  }
  const officialIndex = computeRanks(xs, ids).indexOf(1);
  const officialLeader = ids[officialIndex];
  if (officialLeader === undefined) {
    throw new RangeError(`Classement sans leader pour la seed « ${seed} ».`);
  }
  if (leaders[LEADER_BOUNDS_S.length - 1] !== officialLeader) {
    // L'arrivée **est** la troisième borne : le leader à 60 s et le vainqueur ne peuvent pas diverger.
    leaderConsistent = false;
  }

  const distinctLeaders = new Set(leaders.filter((leader) => leader !== null)).size;

  return Object.freeze({
    seed,
    leaders: Object.freeze([...leaders]),
    winner: officialLeader,
    leaderChanges,
    distinctLeaders,
    distances: Object.freeze([...xs]),
    leaderConsistent,
    steps: state.steps,
    tSim: state.tSim,
  });
}

/** Options de campagne d'audit. */
export interface LeaderAuditOptions {
  /** Appelé après chaque course : permet d'afficher une progression sans polluer le rapport. */
  readonly onRace?: (index: number, total: number) => void;
}

/** Joue le corpus entier, seed par seed, dans l'ordre. */
export function runLeaderAudit(
  seeds: readonly string[],
  options: LeaderAuditOptions = {},
): readonly LeaderAuditRace[] {
  if (seeds.length === 0) {
    throw new RangeError('runLeaderAudit : corpus vide.');
  }
  const races: LeaderAuditRace[] = [];
  for (const [index, seed] of seeds.entries()) {
    races.push(auditRace(seed));
    options.onRace?.(index + 1, seeds.length);
  }
  return Object.freeze(races);
}

// ---------------------------------------------------------------------------------------------
// Statistiques
// ---------------------------------------------------------------------------------------------

/** Parts observées d'une catégorie à six modalités, avec les tests d'uniformité associés. */
export interface CharacterShares {
  readonly counts: readonly number[];
  /** Parts en pourcentage, dans l'ordre du roster. */
  readonly shares: readonly number[];
  /** Part attendue sous l'hypothèse « les six personnages sont équivalents », en pourcentage. */
  readonly expectedShare: number;
  /** Écart à `1/6`, en points de pourcentage. */
  readonly deviations: readonly number[];
  readonly chiSquare: number;
  readonly degreesOfFreedom: number;
  readonly criticalChiSquare05: number;
  readonly criticalChiSquare01: number;
  /** z le plus défavorable (valeur absolue), et le personnage concerné. */
  readonly maxAbsZ: number;
  readonly maxAbsZCharacter: CharacterId | null;
  /** Seuil de z au-delà duquel un écart n'est plus attribuable au hasard (Bonferroni, 6 tests). */
  readonly zThreshold: number;
  /** Vrai si χ² reste sous la valeur critique à 5 % : lecture conventionnelle. */
  readonly uniform: boolean;
  /**
   * Vrai si χ² dépasse la valeur critique à **1 %**.
   *
   * C'est ce seuil — et non celui à 5 % — qui déclenche une alerte : l'audit teste quatre tables
   * (trois bornes et le vainqueur), donc un seuil à 5 % par table produirait une fausse alerte dans
   * près d'une exécution sur cinq.
   */
  readonly beyondChance: boolean;
  /** Vrai si un personnage dépasse le seuil de z corrigé (Bonferroni, 6 comparaisons). */
  readonly anyOutlier: boolean;
}

/** Test d'uniformité sur les six personnages, pour une table de comptes. */
export function characterShares(counts: readonly number[], total: number): CharacterShares {
  if (total <= 0) {
    throw new RangeError('characterShares : total nul.');
  }
  const expected = total / counts.length;
  let chiSquare = 0;
  let maxAbsZ = 0;
  let maxAbsZCharacter: CharacterId | null = null;

  const shares = counts.map((value) => (value / total) * 100);
  const deviations = shares.map((share) => share - 100 / counts.length);

  for (const [index, value] of counts.entries()) {
    const delta = value - expected;
    chiSquare += (delta * delta) / expected;
    const share = value / total;
    const standardError = Math.sqrt((share * (1 - share)) / total);
    const z = standardError === 0 ? 0 : (share - 1 / counts.length) / standardError;
    if (Math.abs(z) > maxAbsZ) {
      maxAbsZ = Math.abs(z);
      maxAbsZCharacter = CHARACTER_IDS[index] ?? null;
    }
  }

  return Object.freeze({
    counts: Object.freeze([...counts]),
    shares: Object.freeze(shares),
    expectedShare: 100 / counts.length,
    deviations: Object.freeze(deviations),
    chiSquare,
    degreesOfFreedom: counts.length - 1,
    criticalChiSquare05: CHI2_5DF_AT_05,
    criticalChiSquare01: CHI2_5DF_AT_01,
    maxAbsZ,
    maxAbsZCharacter,
    zThreshold: Z_BONFERRONI_6,
    uniform: chiSquare <= CHI2_5DF_AT_05,
    beyondChance: chiSquare > CHI2_5DF_AT_01,
    anyOutlier: maxAbsZ > Z_BONFERRONI_6,
  });
}

/** Matrice de transition entre deux bornes, avec son test d'indépendance. */
export interface TransitionMatrix {
  readonly fromLabel: string;
  readonly toLabel: string;
  /** `counts[from][to]` : nombre de courses où le leader de `from` devient celui de `to`. */
  readonly counts: readonly (readonly number[])[];
  readonly rowTotals: readonly number[];
  readonly columnTotals: readonly number[];
  /** Persistance : part des courses où le leader ne change pas entre les deux bornes, en %. */
  readonly persistencePercent: number;
  readonly chiSquareIndependence: number;
  readonly degreesOfFreedom: number;
  readonly criticalChiSquare05: number;
  /** Vrai si χ² reste sous la valeur critique : les deux bornes sont alors indépendantes. */
  readonly independent: boolean;
}

/** Construit la matrice de transition entre deux index de bornes. */
export function transitionMatrix(
  races: readonly LeaderAuditRace[],
  from: number,
  to: number,
): TransitionMatrix {
  const size = CHARACTER_IDS.length;
  const counts: number[][] = Array.from({ length: size }, () => new Array<number>(size).fill(0));
  const rowTotals = new Array<number>(size).fill(0);
  const columnTotals = new Array<number>(size).fill(0);
  let persistence = 0;
  let total = 0;

  for (const race of races) {
    const fromId = race.leaders[from] ?? null;
    const toId = race.leaders[to] ?? null;
    if (fromId === null || toId === null) {
      continue;
    }
    const row = CHARACTER_IDS.indexOf(fromId);
    const column = CHARACTER_IDS.indexOf(toId);
    if (row < 0 || column < 0) {
      continue;
    }
    const rowValues = counts[row];
    if (rowValues === undefined) {
      continue;
    }
    rowValues[column] = (rowValues[column] ?? 0) + 1;
    rowTotals[row] = (rowTotals[row] ?? 0) + 1;
    columnTotals[column] = (columnTotals[column] ?? 0) + 1;
    total += 1;
    if (row === column) {
      persistence += 1;
    }
  }

  let chiSquare = 0;
  for (const [row, rowValues] of counts.entries()) {
    const rowTotal = rowTotals[row] ?? 0;
    if (rowTotal === 0) {
      continue;
    }
    for (const [column, observed] of rowValues.entries()) {
      const expected = (rowTotal * (columnTotals[column] ?? 0)) / total;
      if (expected <= 0) {
        continue;
      }
      const delta = observed - expected;
      chiSquare += (delta * delta) / expected;
    }
  }

  return Object.freeze({
    fromLabel: LEADER_BOUND_LABELS[from] ?? String(from),
    toLabel: LEADER_BOUND_LABELS[to] ?? String(to),
    counts: Object.freeze(counts.map((row) => Object.freeze([...row]))),
    rowTotals: Object.freeze(rowTotals),
    columnTotals: Object.freeze(columnTotals),
    persistencePercent: total === 0 ? 0 : (persistence / total) * 100,
    chiSquareIndependence: chiSquare,
    degreesOfFreedom: (size - 1) * (size - 1),
    criticalChiSquare05: CHI2_25DF_AT_05,
    independent: chiSquare <= CHI2_25DF_AT_05,
  });
}

/** Contrôles de corpus : les seeds produisent-elles des courses réellement différentes ? */
export interface CorpusCheck {
  readonly seeds: number;
  readonly distinctSeeds: number;
  readonly distinctDistanceVectors: number;
  readonly distinctRankings: number;
  readonly distinctLeaderTriples: number;
  readonly distinctWinners: number;
  readonly exactSteps: boolean;
  readonly finishedAtTotalSimS: boolean;
  /** Le suivi pas à pas et le classement officiel concordent-ils sur **toutes** les courses ? */
  readonly leaderConsistentEverywhere: boolean;
  /** Toutes les courses sont-elles distinctes (vecteurs de distance deux à deux différents) ? */
  readonly allRacesDistinct: boolean;
}

/** Contrôles de corpus sur les courses déjà jouées. */
export function corpusCheck(races: readonly LeaderAuditRace[]): CorpusCheck {
  const seeds = new Set<string>();
  const distances = new Set<string>();
  const rankings = new Set<string>();
  const leaderTriples = new Set<string>();
  const winners = new Set<string>();

  for (const race of races) {
    seeds.add(race.seed);
    distances.add(race.distances.join('|'));
    rankings.add(
      [...CHARACTER_IDS]
        .map((id, index) => ({ id, x: race.distances[index] ?? 0 }))
        .sort((left, right) => (right.x !== left.x ? right.x - left.x : left.id < right.id ? -1 : 1))
        .map((entry) => entry.id)
        .join(','),
    );
    leaderTriples.add(race.leaders.join(','));
    winners.add(race.winner);
  }

  return Object.freeze({
    seeds: races.length,
    distinctSeeds: seeds.size,
    distinctDistanceVectors: distances.size,
    distinctRankings: rankings.size,
    distinctLeaderTriples: leaderTriples.size,
    distinctWinners: winners.size,
    exactSteps: races.every((race) => race.steps === RACE_CONFIG.TOTAL_STEPS),
    finishedAtTotalSimS: races.every((race) => race.tSim === RACE_CONFIG.TOTAL_SIM_S),
    leaderConsistentEverywhere: races.every((race) => race.leaderConsistent),
    allRacesDistinct: distances.size === races.length && seeds.size === races.length,
  });
}

// ---------------------------------------------------------------------------------------------
// Contrôles des flux RNG
// ---------------------------------------------------------------------------------------------

/** Corrélation de Pearson entre deux séries de même longueur. */
export function correlation(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length) {
    throw new RangeError('correlation : séries de longueurs différentes.');
  }
  const count = left.length;
  if (count < 2) {
    return 0;
  }
  let sumLeft = 0;
  let sumRight = 0;
  for (let index = 0; index < count; index += 1) {
    sumLeft += left[index] ?? 0;
    sumRight += right[index] ?? 0;
  }
  const meanLeft = sumLeft / count;
  const meanRight = sumRight / count;
  let covariance = 0;
  let varianceLeft = 0;
  let varianceRight = 0;
  for (let index = 0; index < count; index += 1) {
    const deltaLeft = (left[index] ?? 0) - meanLeft;
    const deltaRight = (right[index] ?? 0) - meanRight;
    covariance += deltaLeft * deltaRight;
    varianceLeft += deltaLeft * deltaLeft;
    varianceRight += deltaRight * deltaRight;
  }
  if (varianceLeft === 0 || varianceRight === 0) {
    return 0;
  }
  return covariance / Math.sqrt(varianceLeft * varianceRight);
}

/** χ² d'uniformité d'une série de flottants `[0, 1)` répartis en `bins` classes. */
export function uniformityChiSquare(values: readonly number[], bins = 10): number {
  const counts = new Array<number>(bins).fill(0);
  for (const value of values) {
    const index = Math.min(bins - 1, Math.max(0, Math.floor(value * bins)));
    counts[index] = (counts[index] ?? 0) + 1;
  }
  const expected = values.length / bins;
  let chiSquare = 0;
  for (const observed of counts) {
    const delta = observed - expected;
    chiSquare += (delta * delta) / expected;
  }
  return chiSquare;
}

/**
 * Labels des flux prévus par `GAME_DESIGN.md` §10 et `core/rng.ts`.
 *
 * Ils sont écrits ici — et non importés du moteur, qui les garde privés — mais l'audit ne s'en
 * contente pas : `engineStreamsAudit()` vérifie **comportementalement** que le moteur utilise bien un
 * flux par personnage (les dérives de deux coureurs ne peuvent pas être identiques).
 */
export const RNG_STREAM_LABELS: readonly string[] = Object.freeze([
  ...CHARACTER_IDS.map((id) => `drift:${id}`),
  ...CHARACTER_IDS.map((id) => `surge:${id}`),
  'events:global',
  'speaker:lines',
  'cosmetic',
]);

/** Résultat de l'audit des flux RNG : structurel (streams) puis comportemental (moteur). */
export interface RngAudit {
  readonly labels: readonly string[];
  readonly samplesPerStream: number;
  /** Paires de flux dont les premiers tirages sont **identiques** : doit être vide. */
  readonly identicalSequencePairs: readonly string[];
  readonly maxAbsCorrelation: number;
  readonly maxAbsCorrelationPair: string | null;
  /** Seuil au-delà duquel une corrélation n'est plus attribuable au hasard (`4 / √n`). */
  readonly correlationThreshold: number;
  readonly uniformityChiSquare: Readonly<Record<string, number>>;
  /** Valeur critique à 5 % pour 9 degrés de liberté (lecture conventionnelle). */
  readonly uniformityCritical05: number;
  /** Valeur critique **corrigée** (15 flux, Bonferroni) : c'est elle qui déclenche une alerte. */
  readonly uniformityCriticalCorrected: number;
  readonly uniformityAnomalies: readonly string[];
  readonly distinctFirstDraws: Readonly<Record<string, number>>;
  /** Consommer un flux ne décale-t-il pas les autres ? (propriété structurelle de `forkStream`.) */
  readonly independentConsumption: boolean;
  /** Seeds utilisées pour les contrôles comportementaux. */
  readonly behaviorSeeds: number;
  /** Les séries de dérive des six personnages sont-elles deux à deux différentes ? */
  readonly engineDriftStreamsDistinct: boolean;
  /**
   * Pire paire de personnages pour la corrélation de leurs dérives, et son z.
   *
   * Le z est **auto-calibré** : `|moyenne| / (écart-type observé / √courses)`. Sous l'hypothèse de
   * flux indépendants il reste petit ; un flux partagé le rend énorme. Voir `engineStreamsAudit`.
   */
  readonly driftWorstPair: string | null;
  readonly driftWorstMean: number;
  readonly driftWorstZ: number;
  /** Seuil du z au-delà duquel le couplage n'est plus attribuable au hasard (15 paires, α ≈ 0,1 %). */
  readonly driftZThreshold: number;
  /** Corrélation maximale observée sur une course (valeur extrême, informative seulement). */
  readonly maxAbsDriftCorrelation: number;
  /** Les séries de surge non nulles des six personnages sont-elles deux à deux différentes ? */
  readonly engineSurgeStreamsDistinct: boolean;
  /** Les six personnages ont-ils tous produit au moins un surge sur le sous-corpus ? */
  readonly everyCharacterSurged: boolean;
}

/** Vrai si les deux suites de tirages coïncident sur leurs premiers éléments. */
function sameSequence(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Audit des flux : indépendance **structurelle** (les streams eux-mêmes) puis **comportementale**
 * (ce que le moteur en fait).
 */
export function auditRngStreams(
  seeds: readonly string[],
  options: { readonly behaviorSeeds?: number } = {},
): RngAudit {
  if (seeds.length === 0) {
    throw new RangeError('auditRngStreams : corpus vide.');
  }

  const samples = new Map<string, number[]>();
  const firstDraws = new Map<string, number[]>();
  for (const label of RNG_STREAM_LABELS) {
    samples.set(label, []);
    firstDraws.set(label, []);
  }

  for (const seed of seeds) {
    const seedValue = normalizeSeed(seed);
    for (const label of RNG_STREAM_LABELS) {
      const stream = forkStream(seedValue, label);
      const values = samples.get(label);
      if (values === undefined) {
        continue;
      }
      values.push(stream.nextFloat());
      firstDraws.get(label)?.push(stream.next());
    }
  }

  // Les premiers tirages servent aux deux usages : séquence et uniformité. On reprend une suite
  // complète pour la comparaison « identique ou non », qui doit porter sur plusieurs tirages.
  const sequences = new Map<string, number[]>();
  for (const label of RNG_STREAM_LABELS) {
    const stream = forkStream(normalizeSeed(seeds[0] ?? ''), label);
    const values: number[] = [];
    for (let index = 0; index < IDENTICAL_SEQUENCE_DRAWS; index += 1) {
      values.push(stream.nextFloat());
    }
    sequences.set(label, values);
  }

  const identicalSequencePairs: string[] = [];
  let maxAbsCorrelation = 0;
  let maxAbsCorrelationPair: string | null = null;
  for (const [leftIndex, leftLabel] of RNG_STREAM_LABELS.entries()) {
    for (const rightLabel of RNG_STREAM_LABELS.slice(leftIndex + 1)) {
      const leftSequence = sequences.get(leftLabel) ?? [];
      const rightSequence = sequences.get(rightLabel) ?? [];
      if (sameSequence(leftSequence, rightSequence)) {
        identicalSequencePairs.push(`${leftLabel} = ${rightLabel}`);
      }
      const value = Math.abs(
        correlation(samples.get(leftLabel) ?? [], samples.get(rightLabel) ?? []),
      );
      if (value > maxAbsCorrelation) {
        maxAbsCorrelation = value;
        maxAbsCorrelationPair = `${leftLabel} / ${rightLabel}`;
      }
    }
  }

  const uniformityChiSquare: Record<string, number> = {};
  const uniformityAnomalies: string[] = [];
  const distinctFirstDraws: Record<string, number> = {};
  for (const label of RNG_STREAM_LABELS) {
    const chiSquare = uniformityChiSquareOf(samples.get(label) ?? []);
    uniformityChiSquare[label] = chiSquare;
    if (chiSquare > CHI2_9DF_AT_0001) {
      uniformityAnomalies.push(label);
    }
    distinctFirstDraws[label] = new Set(firstDraws.get(label) ?? []).size;
  }

  // Indépendance de consommation : tirer 100 valeurs d'un flux ne doit rien changer au premier tirage
  // d'un **autre** flux, ni au premier tirage d'une instance neuve du même flux.
  const probeSeed = normalizeSeed(seeds[0] ?? '');
  const reference = forkStream(probeSeed, 'drift:c0').next();
  const consumer = forkStream(probeSeed, 'drift:c0');
  for (let index = 0; index < 100; index += 1) {
    consumer.next();
  }
  const afterConsumption = forkStream(probeSeed, 'drift:c0').next();
  const otherStream = forkStream(probeSeed, 'drift:c1').next();
  const otherReference = forkStream(probeSeed, 'drift:c1').next();
  const independentConsumption =
    reference === afterConsumption && otherStream === otherReference;

  const behavior = engineStreamsAudit(seeds.slice(0, options.behaviorSeeds ?? DEFAULT_BEHAVIOR_SEEDS));

  return Object.freeze({
    labels: RNG_STREAM_LABELS,
    samplesPerStream: seeds.length,
    identicalSequencePairs: Object.freeze(identicalSequencePairs),
    maxAbsCorrelation,
    maxAbsCorrelationPair,
    correlationThreshold: 4 / Math.sqrt(seeds.length),
    uniformityChiSquare: Object.freeze(uniformityChiSquare),
    uniformityCritical05: CHI2_9DF_AT_05,
    uniformityCriticalCorrected: CHI2_9DF_AT_0001,
    uniformityAnomalies: Object.freeze(uniformityAnomalies),
    distinctFirstDraws: Object.freeze(distinctFirstDraws),
    independentConsumption,
    behaviorSeeds: Math.min(seeds.length, options.behaviorSeeds ?? DEFAULT_BEHAVIOR_SEEDS),
    engineDriftStreamsDistinct: behavior.driftDistinct,
    driftWorstPair: behavior.driftWorstPair,
    driftWorstMean: behavior.driftWorstMean,
    driftWorstZ: behavior.driftWorstZ,
    driftZThreshold: DRIFT_Z_THRESHOLD,
    maxAbsDriftCorrelation: behavior.maxAbsDriftCorrelation,
    engineSurgeStreamsDistinct: behavior.surgeDistinct,
    everyCharacterSurged: behavior.everyCharacterSurged,
  });
}

/** Petit utilitaire nommé : applique le χ² d'uniformité à une série de tirages. */
function uniformityChiSquareOf(values: readonly number[]): number {
  return uniformityChiSquare(values);
}

/** Résultat des contrôles comportementaux : le moteur utilise-t-il un flux par personnage ? */
interface EngineStreamsAudit {
  readonly driftDistinct: boolean;
  /** Pire paire de personnages, au sens de la corrélation moyenne de leurs dérives. */
  readonly driftWorstPair: string | null;
  /** Corrélation **moyenne** (signée) de cette pire paire, sur toutes les courses du sous-corpus. */
  readonly driftWorstMean: number;
  /** z de cette moyenne : `|moyenne| / (écart-type observé / √courses)`. */
  readonly driftWorstZ: number;
  /**
   * Corrélation **maximale** observée sur une course et une paire (valeur extrême, informative).
   *
   * Sur 200 courses × 15 paires, le maximum d'une statistique centrée est mécaniquement élevé : une
   * dérive est un processus à mémoire, donc les échantillons d'une course ne sont pas indépendants et
   * le maximum attendu vaut plusieurs écarts-types. Le publier évite de le prendre pour une anomalie.
   */
  readonly maxAbsDriftCorrelation: number;
  readonly surgeDistinct: boolean;
  readonly everyCharacterSurged: boolean;
}

/**
 * Contrôle **comportemental** : deux coureurs ne peuvent pas partager leur flux de dérive.
 *
 * Si les six personnages consommaient le même flux, leurs dérives seraient tirées au même rythme avec
 * les mêmes valeurs : les séries seraient identiques (corrélation `1`). On relève donc la dérive
 * publiée par le noyau pour chaque personnage, à pas constant, et on compare les six séries.
 *
 * La corrélation est calculée **à l'intérieur de chaque course**, jamais sur des séries mises bout à
 * bout : chaque course repart d'une dérive nulle pour tout le monde, et recoller les courses
 * fabriquerait une corrélation artificielle entre personnages (tous « repartent » au même instant).
 *
 * ## Pourquoi un z, et pas un seuil fixe sur la corrélation
 *
 * Une corrélation mesurée sur une course est **bruitée** : la dérive est un processus à mémoire, donc
 * les 360 points d'une course valent bien moins que 360 observations indépendantes. Un seuil fixe du
 * type `4/√n` se trompe deux fois : il laisse passer un couplage réel sur une paire, et il crie au
 * loup sur le maximum d'un grand nombre de tirages. La statistique retenue est donc **auto-calibrée** :
 * pour chaque paire, on moyenne les corrélations des courses, puis on divise cette moyenne par
 * l'écart-type **observé** de ces corrélations, divisé par `√courses`. C'est un z de Student : sous
 * l'hypothèse « flux indépendants », il reste petit quel que soit le bruit du processus, alors qu'un
 * flux partagé le rend énorme (les corrélations valent `1` à chaque course, donc l'écart-type tend
 * vers `0` et la moyenne vers `1`).
 */
function engineStreamsAudit(seeds: readonly string[]): EngineStreamsAudit {
  const ids = CHARACTER_IDS;
  const slotOf = new Map<CharacterId, number>(ids.map((id, index) => [id, index]));
  const pairCount = (ids.length * (ids.length - 1)) / 2;
  const pairValues: number[][] = Array.from({ length: pairCount }, () => []);
  const pairLabels: string[] = [];
  for (const [index, id] of ids.entries()) {
    for (const other of ids.slice(index + 1)) {
      pairLabels.push(`${id}/${other}`);
    }
  }

  let everyCharacterSurged = true;
  let driftDistinct = true;
  let surgeDistinct = true;
  let maxAbsDriftCorrelation = 0;

  for (const seed of seeds) {
    const engine = new RaceEngine(seed);
    const driftSeries: number[][] = ids.map(() => []);
    const surgeValues: number[][] = ids.map(() => []);
    let state = engine.getState();
    let step = 0;

    while (state.phase.kind !== 'finished') {
      engine.step();
      state = engine.getState();
      step += 1;
      // Un point sur dix suffit à détecter un flux partagé, et garde l'audit rapide.
      if (step % 10 !== 0) {
        continue;
      }
      for (const character of state.characters) {
        const index = slotOf.get(character.id) ?? 0;
        (driftSeries[index] ?? []).push(character.drift);
        if (character.surge !== 0) {
          (surgeValues[index] ?? []).push(character.surge);
        }
      }
    }

    for (const [index, series] of surgeValues.entries()) {
      if (series.length === 0) {
        everyCharacterSurged = false;
      }
      for (const other of surgeValues.slice(index + 1)) {
        if (series.length > 0 && sameSequence(series, other)) {
          surgeDistinct = false;
        }
      }
    }

    let pair = 0;
    for (const [index, series] of driftSeries.entries()) {
      for (const other of driftSeries.slice(index + 1)) {
        if (sameSequence(series, other)) {
          driftDistinct = false;
        }
        // Corrélation **signée** : sous l'hypothèse d'indépendance, sa moyenne tend vers zéro.
        const value = correlation(series, other);
        maxAbsDriftCorrelation = Math.max(maxAbsDriftCorrelation, Math.abs(value));
        (pairValues[pair] ?? []).push(value);
        pair += 1;
      }
    }
  }

  let driftWorstPair: string | null = null;
  let driftWorstMean = 0;
  let driftWorstZ = 0;
  for (const [pair, values] of pairValues.entries()) {
    const count = values.length;
    if (count < MIN_DRIFT_CORRELATION_COURSES) {
      continue;
    }
    const mean = values.reduce((sum, value) => sum + value, 0) / count;
    const variance =
      values.reduce((sum, value) => sum + (value - mean) * (value - mean), 0) / (count - 1);
    const standardDeviation = Math.sqrt(variance);
    // Écart-type nul : toutes les courses donnent la même corrélation. Soit elle est nulle (séries
    // indépendantes), soit elle vaut `1` — et c'est alors exactement le signe d'un flux partagé.
    const z =
      standardDeviation > 1e-9
        ? Math.abs(mean) / (standardDeviation / Math.sqrt(count))
        : Math.abs(mean) > 0.5
          ? Number.POSITIVE_INFINITY
          : 0;
    if (z > driftWorstZ) {
      driftWorstZ = z;
      driftWorstMean = Math.abs(mean);
      driftWorstPair = pairLabels[pair] ?? null;
    }
  }

  return {
    driftDistinct,
    driftWorstPair,
    driftWorstMean,
    driftWorstZ,
    maxAbsDriftCorrelation,
    surgeDistinct,
    everyCharacterSurged,
  };
}

// ---------------------------------------------------------------------------------------------
// Synthèse
// ---------------------------------------------------------------------------------------------

/** Références publiées de la version 60 s, à ne pas confondre avec des seuils. */
export interface AuditReferences {
  readonly winShareMinPercent: number;
  readonly winShareMaxPercent: number;
  readonly leaderChangesMean: number;
  readonly leaderAtCheckWinRatePercent: number;
  readonly reproducibilitySeeds: number;
}

/** Les références du document, recopiées telles quelles (ce sont des mesures, pas des règles). */
export const AUDIT_REFERENCES: AuditReferences = Object.freeze({
  winShareMinPercent: 15.3,
  winShareMaxPercent: 18.4,
  leaderChangesMean: 8.308,
  leaderAtCheckWinRatePercent: 63.2,
  reproducibilitySeeds: 100,
});

/** Une comparaison à une référence, avec son verdict. */
export interface ReferenceCheck {
  readonly label: string;
  readonly reference: string;
  readonly measured: string;
  readonly withinReference: boolean;
  /**
   * Vrai si le sous-corpus est assez grand pour que la comparaison ait du sens.
   *
   * Les références publiées ont été mesurées sur **1000 seeds** ; comparer un sous-corpus plus petit
   * produirait des écarts qui ne disent rien du jeu (la dispersion des parts décroît en `1/√n`). Un
   * écart sur une comparaison non comparable est **indicatif**, jamais une anomalie.
   */
  readonly comparable: boolean;
}

/** Synthèse complète de l'audit. */
export interface LeaderAuditSummary {
  readonly seeds: number;
  readonly boundsS: readonly number[];
  readonly boundLabels: readonly string[];
  readonly leadersPerBound: readonly CharacterShares[];
  readonly winnerShares: CharacterShares;
  readonly sameLeaderAllBounds: number;
  readonly sameLeaderAllBoundsPercent: number;
  readonly exactlyTwoLeaders: number;
  readonly exactlyTwoLeadersPercent: number;
  readonly threeDistinctLeaders: number;
  readonly threeDistinctLeadersPercent: number;
  readonly leader20EqualsLeader40: number;
  readonly leader40EqualsWinner: number;
  readonly leader20EqualsWinner: number;
  readonly leader40EqualsWinnerPercent: number;
  readonly transitions: readonly TransitionMatrix[];
  readonly leaderChangesMean: number;
  readonly leaderChangesMin: number;
  readonly leaderChangesMax: number;
  readonly corpus: CorpusCheck;
  readonly rng: RngAudit;
  readonly references: readonly ReferenceCheck[];
  readonly referenceSeedCount: number;
  readonly referenceWinShares: readonly number[];
  readonly referenceLeaderChangesMean: number;
  readonly referenceLeader40WinRate: number;
  readonly reproducibility: { readonly seeds: number; readonly identical: number };
}

/** Synthèse d'un corpus déjà joué. */
export function summarizeLeaderAudit(
  races: readonly LeaderAuditRace[],
  options: {
    readonly referenceRaces?: readonly LeaderAuditRace[];
    readonly rng?: RngAudit;
    readonly reproducibility?: { readonly seeds: number; readonly identical: number };
  } = {},
): LeaderAuditSummary {
  const total = races.length;
  if (total === 0) {
    throw new RangeError('summarizeLeaderAudit : corpus vide.');
  }

  const leaderCountsPerBound = LEADER_BOUNDS_S.map(() => new Array<number>(CHARACTER_IDS.length).fill(0));
  const winnerCounts = new Array<number>(CHARACTER_IDS.length).fill(0);
  let sameLeaderAllBounds = 0;
  let exactlyTwoLeaders = 0;
  let threeDistinctLeaders = 0;
  let leader20EqualsLeader40 = 0;
  let leader40EqualsWinner = 0;
  let leader20EqualsWinner = 0;
  const changes: number[] = [];

  for (const race of races) {
    for (const [boundIndex, leader] of race.leaders.entries()) {
      if (leader === null) {
        continue;
      }
      const index = CHARACTER_IDS.indexOf(leader);
      const counts = leaderCountsPerBound[boundIndex];
      if (index >= 0 && counts !== undefined) {
        counts[index] = (counts[index] ?? 0) + 1;
      }
    }
    const winnerIndex = CHARACTER_IDS.indexOf(race.winner);
    if (winnerIndex >= 0) {
      winnerCounts[winnerIndex] = (winnerCounts[winnerIndex] ?? 0) + 1;
    }

    if (race.distinctLeaders === 1) {
      sameLeaderAllBounds += 1;
    } else if (race.distinctLeaders === 2) {
      exactlyTwoLeaders += 1;
    } else if (race.distinctLeaders === 3) {
      threeDistinctLeaders += 1;
    }

    const [at20, at40, at60] = race.leaders;
    if (at20 !== undefined && at20 === at40) {
      leader20EqualsLeader40 += 1;
    }
    if (at40 !== undefined && at40 === at60) {
      leader40EqualsWinner += 1;
    }
    if (at20 !== undefined && at20 === at60) {
      leader20EqualsWinner += 1;
    }
    changes.push(race.leaderChanges);
  }

  const referenceRaces = options.referenceRaces ?? [];
  const referenceWinCounts = new Array<number>(CHARACTER_IDS.length).fill(0);
  let referenceLeader40Wins = 0;
  let referenceChanges = 0;
  for (const race of referenceRaces) {
    const winnerIndex = CHARACTER_IDS.indexOf(race.winner);
    if (winnerIndex >= 0) {
      referenceWinCounts[winnerIndex] = (referenceWinCounts[winnerIndex] ?? 0) + 1;
    }
    const at40 = race.leaders[1] ?? null;
    if (at40 !== null && at40 === race.winner) {
      referenceLeader40Wins += 1;
    }
    referenceChanges += race.leaderChanges;
  }
  const referenceTotal = referenceRaces.length;

  const winShares = characterShares(winnerCounts, total);
  const references: ReferenceCheck[] = [];
  const comparable = referenceTotal >= AUDIT_REFERENCES.reproducibilitySeeds;
  // Les parts mesurées valent par exemple 18,400000000000002 % : la comparaison à une référence
  // arrondie au dixième se fait donc avec une tolérance d'un centième de point, pas au bit.
  const epsilon = 0.01;
  if (referenceTotal > 0) {
    const referenceShares = referenceWinCounts.map((value) => (value / referenceTotal) * 100);
    const minShare = Math.min(...referenceShares);
    const maxShare = Math.max(...referenceShares);
    references.push(
      Object.freeze({
        label: 'Victoires par personnage (min/max)',
        reference: `${AUDIT_REFERENCES.winShareMinPercent.toFixed(1)} – ${AUDIT_REFERENCES.winShareMaxPercent.toFixed(1)} %`,
        measured: `${minShare.toFixed(2)} – ${maxShare.toFixed(2)} %`,
        withinReference:
          minShare >= AUDIT_REFERENCES.winShareMinPercent - epsilon &&
          maxShare <= AUDIT_REFERENCES.winShareMaxPercent + epsilon,
        comparable,
      }),
    );
    const meanChanges = referenceChanges / referenceTotal;
    references.push(
      Object.freeze({
        label: 'Changements de leader (moyenne)',
        reference: AUDIT_REFERENCES.leaderChangesMean.toFixed(3),
        measured: meanChanges.toFixed(3),
        withinReference: Math.abs(meanChanges - AUDIT_REFERENCES.leaderChangesMean) < 0.05,
        comparable,
      }),
    );
    const leader40WinRate = (referenceLeader40Wins / referenceTotal) * 100;
    references.push(
      Object.freeze({
        label: 'Leader à 40 s vainqueur',
        reference: `${AUDIT_REFERENCES.leaderAtCheckWinRatePercent.toFixed(2)} %`,
        measured: `${leader40WinRate.toFixed(2)} %`,
        withinReference:
          Math.abs(leader40WinRate - AUDIT_REFERENCES.leaderAtCheckWinRatePercent) < 0.5,
        comparable,
      }),
    );
  }
  const reproducibility = options.reproducibility ?? { seeds: 0, identical: 0 };
  if (reproducibility.seeds > 0) {
    references.push(
      Object.freeze({
        label: 'Reproductibilité bit à bit',
        reference: `${String(AUDIT_REFERENCES.reproducibilitySeeds)}/${String(AUDIT_REFERENCES.reproducibilitySeeds)}`,
        measured: `${String(reproducibility.identical)}/${String(reproducibility.seeds)}`,
        withinReference: reproducibility.identical === reproducibility.seeds,
        comparable: true,
      }),
    );
  }

  return Object.freeze({
    seeds: total,
    boundsS: LEADER_BOUNDS_S,
    boundLabels: LEADER_BOUND_LABELS,
    leadersPerBound: Object.freeze(leaderCountsPerBound.map((counts) => characterShares(counts, total))),
    winnerShares: winShares,
    sameLeaderAllBounds,
    sameLeaderAllBoundsPercent: (sameLeaderAllBounds / total) * 100,
    exactlyTwoLeaders,
    exactlyTwoLeadersPercent: (exactlyTwoLeaders / total) * 100,
    threeDistinctLeaders,
    threeDistinctLeadersPercent: (threeDistinctLeaders / total) * 100,
    leader20EqualsLeader40,
    leader40EqualsWinner,
    leader20EqualsWinner,
    leader40EqualsWinnerPercent: (leader40EqualsWinner / total) * 100,
    transitions: Object.freeze([transitionMatrix(races, 0, 1), transitionMatrix(races, 1, 2)]),
    leaderChangesMean: changes.reduce((sum, value) => sum + value, 0) / total,
    leaderChangesMin: Math.min(...changes),
    leaderChangesMax: Math.max(...changes),
    corpus: corpusCheck(races),
    rng:
      options.rng ??
      Object.freeze({
        labels: RNG_STREAM_LABELS,
        samplesPerStream: 0,
        identicalSequencePairs: Object.freeze([]),
        maxAbsCorrelation: 0,
        maxAbsCorrelationPair: null,
        correlationThreshold: 0,
        uniformityChiSquare: Object.freeze({}),
        uniformityCritical05: CHI2_9DF_AT_05,
        uniformityCriticalCorrected: CHI2_9DF_AT_0001,
        uniformityAnomalies: Object.freeze([]),
        distinctFirstDraws: Object.freeze({}),
        independentConsumption: false,
        behaviorSeeds: 0,
        engineDriftStreamsDistinct: false,
        driftWorstPair: null,
        driftWorstMean: 0,
        driftWorstZ: 0,
        driftZThreshold: DRIFT_Z_THRESHOLD,
        maxAbsDriftCorrelation: 0,
        driftCorrelationThreshold: 0,
        engineSurgeStreamsDistinct: false,
        everyCharacterSurged: false,
      }),
    references: Object.freeze(references),
    referenceSeedCount: referenceTotal,
    referenceWinShares: Object.freeze(referenceWinCounts.map((value) => (referenceTotal === 0 ? 0 : (value / referenceTotal) * 100))),
    referenceLeaderChangesMean: referenceTotal === 0 ? 0 : referenceChanges / referenceTotal,
    referenceLeader40WinRate: referenceTotal === 0 ? 0 : (referenceLeader40Wins / referenceTotal) * 100,
    reproducibility: Object.freeze({ ...reproducibility }),
  });
}

// ---------------------------------------------------------------------------------------------
// Rapports
// ---------------------------------------------------------------------------------------------

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

function padStart(text: string, width: number): string {
  return text.length >= width ? text : ' '.repeat(width - text.length) + text;
}

/** Ligne d'une table de parts : comptes, pourcentage, écart à 1/6 et z. */
function shareRow(label: string, shares: CharacterShares, total: number): string {
  const parts = CHARACTER_IDS.map((id, index) => {
    const share = shares.shares[index] ?? 0;
    const deviation = shares.deviations[index] ?? 0;
    return `${id} ${share.toFixed(2)} % (${deviation >= 0 ? '+' : ''}${deviation.toFixed(2)})`;
  });
  return `${pad(label, 10)}${padStart(String(total), 7)}  ${parts.join(' | ')}`;
}

/** Matrice de transition, en compte, avec en-tête et totaux de ligne. */
function matrixLines(matrix: TransitionMatrix): readonly string[] {
  const lines: string[] = [];
  lines.push(
    `  ${matrix.fromLabel} → ${matrix.toLabel} : persistance ${matrix.persistencePercent.toFixed(2)} % | ` +
      `χ² indépendance ${matrix.chiSquareIndependence.toFixed(2)} (seuil ${matrix.criticalChiSquare05.toFixed(2)}, ${String(matrix.degreesOfFreedom)} ddl) → ` +
      `${matrix.independent ? 'indépendantes' : 'dépendantes (attendu : persistance)'}`,
  );
  lines.push(`  ${pad('de \\ vers', 10)}${CHARACTER_IDS.map((id) => padStart(id, 8)).join('')}${padStart('total', 9)}`);
  for (const [row, values] of matrix.counts.entries()) {
    const id = CHARACTER_IDS[row] ?? `#${String(row)}`;
    lines.push(
      `  ${pad(id, 10)}${values.map((value) => padStart(String(value), 8)).join('')}` +
        `${padStart(String(matrix.rowTotals[row] ?? 0), 9)}`,
    );
  }
  return lines;
}

/** Rapport texte, compact et réutilisable : c'est la sortie destinée à l'humain. */
export function renderLeaderAuditText(summary: LeaderAuditSummary, elapsedMs: number): string {
  const lines: string[] = [];
  const percent = (value: number): string => `${value.toFixed(2)} %`;

  lines.push('Chaos Race — audit des leaders aux bornes (passe de vérification)');
  lines.push(
    `corpus : ${String(summary.seeds)} seeds déterministes | bornes ${summary.boundLabels.join(' / ')} | ` +
      `DT = ${String(RACE_CONFIG.DT_S)} s | ${String(RACE_CONFIG.TOTAL_STEPS)} pas par course`,
  );
  lines.push(
    `durée : ${(elapsedMs / 1000).toFixed(1)} s (${(elapsedMs / summary.seeds).toFixed(2)} ms/course)`,
  );

  lines.push('');
  lines.push('=== Leaders observés à chaque borne (part de chaque personnage) ===');
  lines.push(`${pad('borne', 10)}${padStart('courses', 7)}  ${CHARACTER_IDS.join(' | ')}`);
  for (const [boundIndex, shares] of summary.leadersPerBound.entries()) {
    lines.push(shareRow(summary.boundLabels[boundIndex] ?? '?', shares, summary.seeds));
    lines.push(
      `  χ²(5) = ${shares.chiSquare.toFixed(2)} (seuil 5 % : ${shares.criticalChiSquare05.toFixed(2)}, 1 % : ${shares.criticalChiSquare01.toFixed(2)}) | ` +
        `max |z| = ${shares.maxAbsZ.toFixed(2)} (${shares.maxAbsZCharacter ?? '—'}, seuil ${shares.zThreshold.toFixed(3)}) → ` +
        `${shares.uniform ? 'uniforme' : 'NON UNIFORME'}${shares.anyOutlier ? ' | écart individuel signalé' : ''}`,
    );
  }
  lines.push(shareRow('vainqueur', summary.winnerShares, summary.seeds));
  lines.push(
    `  χ²(5) = ${summary.winnerShares.chiSquare.toFixed(2)} | max |z| = ${summary.winnerShares.maxAbsZ.toFixed(2)} ` +
      `(${summary.winnerShares.maxAbsZCharacter ?? '—'}) → ${summary.winnerShares.uniform ? 'uniforme' : 'NON UNIFORME'}`,
  );

  lines.push('');
  lines.push('=== Persistance du leader ===');
  lines.push(
    `même leader aux 3 bornes : ${String(summary.sameLeaderAllBounds)} (${percent(summary.sameLeaderAllBoundsPercent)})`,
  );
  lines.push(
    `exactement 2 leaders distincts : ${String(summary.exactlyTwoLeaders)} (${percent(summary.exactlyTwoLeadersPercent)})`,
  );
  lines.push(
    `3 leaders distincts : ${String(summary.threeDistinctLeaders)} (${percent(summary.threeDistinctLeadersPercent)})`,
  );
  lines.push(
    `leader 20 s = leader 40 s : ${String(summary.leader20EqualsLeader40)} (${percent((summary.leader20EqualsLeader40 / summary.seeds) * 100)})`,
  );
  lines.push(
    `leader 40 s = vainqueur : ${String(summary.leader40EqualsWinner)} (${percent(summary.leader40EqualsWinnerPercent)})`,
  );
  lines.push(
    `leader 20 s = vainqueur : ${String(summary.leader20EqualsWinner)} (${percent((summary.leader20EqualsWinner / summary.seeds) * 100)})`,
  );

  lines.push('');
  lines.push('=== Matrices de transition du leader ===');
  for (const matrix of summary.transitions) {
    lines.push(...matrixLines(matrix));
  }

  lines.push('');
  lines.push('=== Changements de leader (mesure comparable à §13) ===');
  lines.push(
    `moyenne ${summary.leaderChangesMean.toFixed(3)} | min ${String(summary.leaderChangesMin)} | max ${String(summary.leaderChangesMax)}`,
  );

  lines.push('');
  lines.push('=== Contrôles de corpus ===');
  const corpus = summary.corpus;
  lines.push(
    `seeds ${String(corpus.seeds)} | distinctes ${String(corpus.distinctSeeds)} | vecteurs de distance distincts ${String(corpus.distinctDistanceVectors)} | ` +
      `classements distincts ${String(corpus.distinctRankings)}`,
  );
  lines.push(
    `triplets de leaders distincts ${String(corpus.distinctLeaderTriples)} | vainqueurs distincts ${String(corpus.distinctWinners)} | ` +
      `courses toutes différentes : ${corpus.allRacesDistinct ? 'oui' : 'NON'}`,
  );
  lines.push(
    `pas exactement ${String(RACE_CONFIG.TOTAL_STEPS)} : ${corpus.exactSteps ? 'oui' : 'NON'} | ` +
      `arrivée à ${String(RACE_CONFIG.TOTAL_SIM_S)} s : ${corpus.finishedAtTotalSimS ? 'oui' : 'NON'} | ` +
      `leader pas-à-pas = classement officiel : ${corpus.leaderConsistentEverywhere ? 'oui' : 'NON'}`,
  );

  lines.push('');
  lines.push('=== Flux RNG ===');
  const rng = summary.rng;
  lines.push(
    `streams ${String(rng.labels.length)} | échantillons par stream ${String(rng.samplesPerStream)} | ` +
      `paires identiques ${String(rng.identicalSequencePairs.length)}`,
  );
  lines.push(
    `corrélation |r| max ${rng.maxAbsCorrelation.toFixed(4)} (${rng.maxAbsCorrelationPair ?? '—'}, seuil ${rng.correlationThreshold.toFixed(4)}) | ` +
      `uniformité χ²(9) max ${Math.max(0, ...Object.values(rng.uniformityChiSquare)).toFixed(2)} ` +
      `(seuil 5 % ${rng.uniformityCritical05.toFixed(2)}, seuil corrigé ${rng.uniformityCriticalCorrected.toFixed(2)})`,
  );
  lines.push(
    `consommation indépendante : ${rng.independentConsumption ? 'oui' : 'NON'} | ` +
      `dérives des 6 personnages distinctes : ${rng.engineDriftStreamsDistinct ? 'oui' : 'NON'} ` +
      `(couplage z max ${rng.driftWorstZ.toFixed(2)} sur ${rng.driftWorstPair ?? '—'}, moyenne |r| ${rng.driftWorstMean.toFixed(4)}, ` +
      `seuil z ${rng.driftZThreshold.toFixed(2)} ; maximum instantané ${rng.maxAbsDriftCorrelation.toFixed(4)}) | ` +
      `surges distincts : ${rng.engineSurgeStreamsDistinct ? 'oui' : 'NON'}`,
  );
  if (rng.uniformityAnomalies.length > 0) {
    lines.push(`streams hors uniformité : ${rng.uniformityAnomalies.join(', ')}`);
  }

  if (summary.references.length > 0) {
    lines.push('');
    lines.push(
      `=== Comparaison aux références 60 s (sous-corpus de ${String(summary.referenceSeedCount)} seeds) ===`,
    );
    for (const check of summary.references) {
      const status = check.withinReference ? 'OK   ' : check.comparable ? 'ÉCART' : 'indic';
      lines.push(
        `${status} ${pad(check.label, 34)} mesuré ${padStart(check.measured, 18)}   référence ${check.reference}`,
      );
    }
    lines.push(
      `victoires par personnage (sous-corpus) : ${CHARACTER_IDS.map(
        (id, index) => `${id} ${(summary.referenceWinShares[index] ?? 0).toFixed(2)} %`,
      ).join(' | ')}`,
    );
  }

  return lines.join('\n');
}

/** Rapport structuré, à clés **ASCII**, pour un usage machine. */
export function buildLeaderAuditJson(summary: LeaderAuditSummary, elapsedMs: number): unknown {
  const shares = (table: CharacterShares): unknown => ({
    counts: [...table.counts],
    sharesPercent: table.shares.map((value) => Number(value.toFixed(4))),
    expectedSharePercent: Number(table.expectedShare.toFixed(4)),
    deviationsPoints: table.deviations.map((value) => Number(value.toFixed(4))),
    chiSquare: Number(table.chiSquare.toFixed(4)),
    degreesOfFreedom: table.degreesOfFreedom,
    criticalChiSquare05: table.criticalChiSquare05,
    criticalChiSquare01: table.criticalChiSquare01,
    maxAbsZ: Number(table.maxAbsZ.toFixed(4)),
    maxAbsZCharacter: table.maxAbsZCharacter,
    zThreshold: table.zThreshold,
    uniform: table.uniform,
    beyondChance: table.beyondChance,
    anyOutlier: table.anyOutlier,
  });

  return {
    tool: 'chaos-race-leader-audit',
    step: 'P013-verification',
    corpus: {
      seeds: summary.seeds,
      boundsS: [...summary.boundsS],
      dtS: RACE_CONFIG.DT_S,
      totalSteps: RACE_CONFIG.TOTAL_STEPS,
    },
    timing: {
      elapsedMs: Number(elapsedMs.toFixed(1)),
      msPerRace: Number((elapsedMs / summary.seeds).toFixed(3)),
    },
    leadersPerBound: summary.leadersPerBound.map((table) => shares(table)),
    winnerShares: shares(summary.winnerShares),
    persistence: {
      sameLeaderAllBounds: summary.sameLeaderAllBounds,
      sameLeaderAllBoundsPercent: Number(summary.sameLeaderAllBoundsPercent.toFixed(4)),
      exactlyTwoLeaders: summary.exactlyTwoLeaders,
      exactlyTwoLeadersPercent: Number(summary.exactlyTwoLeadersPercent.toFixed(4)),
      threeDistinctLeaders: summary.threeDistinctLeaders,
      threeDistinctLeadersPercent: Number(summary.threeDistinctLeadersPercent.toFixed(4)),
      leader20EqualsLeader40: summary.leader20EqualsLeader40,
      leader40EqualsWinner: summary.leader40EqualsWinner,
      leader40EqualsWinnerPercent: Number(summary.leader40EqualsWinnerPercent.toFixed(4)),
      leader20EqualsWinner: summary.leader20EqualsWinner,
    },
    transitions: summary.transitions.map((matrix) => ({
      from: matrix.fromLabel,
      to: matrix.toLabel,
      counts: matrix.counts.map((row) => [...row]),
      rowTotals: [...matrix.rowTotals],
      columnTotals: [...matrix.columnTotals],
      persistencePercent: Number(matrix.persistencePercent.toFixed(4)),
      chiSquareIndependence: Number(matrix.chiSquareIndependence.toFixed(4)),
      degreesOfFreedom: matrix.degreesOfFreedom,
      criticalChiSquare05: matrix.criticalChiSquare05,
      independent: matrix.independent,
    })),
    leaderChanges: {
      mean: Number(summary.leaderChangesMean.toFixed(4)),
      min: summary.leaderChangesMin,
      max: summary.leaderChangesMax,
    },
    corpusChecks: { ...summary.corpus },
    rngChecks: {
      labels: [...summary.rng.labels],
      samplesPerStream: summary.rng.samplesPerStream,
      identicalSequencePairs: [...summary.rng.identicalSequencePairs],
      maxAbsCorrelation: Number(summary.rng.maxAbsCorrelation.toFixed(6)),
      maxAbsCorrelationPair: summary.rng.maxAbsCorrelationPair,
      correlationThreshold: Number(summary.rng.correlationThreshold.toFixed(6)),
      uniformityChiSquare: { ...summary.rng.uniformityChiSquare },
      uniformityCritical05: summary.rng.uniformityCritical05,
      uniformityCriticalCorrected: summary.rng.uniformityCriticalCorrected,
      uniformityAnomalies: [...summary.rng.uniformityAnomalies],
      distinctFirstDraws: { ...summary.rng.distinctFirstDraws },
      independentConsumption: summary.rng.independentConsumption,
      behaviorSeeds: summary.rng.behaviorSeeds,
      engineDriftStreamsDistinct: summary.rng.engineDriftStreamsDistinct,
      driftWorstPair: summary.rng.driftWorstPair,
      driftWorstMean: Number(summary.rng.driftWorstMean.toFixed(6)),
      driftWorstZ: Number.isFinite(summary.rng.driftWorstZ)
        ? Number(summary.rng.driftWorstZ.toFixed(4))
        : 'infinite',
      driftZThreshold: summary.rng.driftZThreshold,
      maxAbsDriftCorrelation: Number(summary.rng.maxAbsDriftCorrelation.toFixed(6)),
      engineSurgeStreamsDistinct: summary.rng.engineSurgeStreamsDistinct,
      everyCharacterSurged: summary.rng.everyCharacterSurged,
    },
    references: {
      measuredOnSeeds: summary.referenceSeedCount,
      winSharesPercent: summary.referenceWinShares.map((value) => Number(value.toFixed(4))),
      leaderChangesMean: Number(summary.referenceLeaderChangesMean.toFixed(4)),
      leader40WinRatePercent: Number(summary.referenceLeader40WinRate.toFixed(4)),
      reproducibility: { ...summary.reproducibility },
      checks: summary.references.map((check) => ({ ...check })),
    },
    conclusion: conclusionLines(summary),
  };
}

/**
 * Conclusion **factuelle** : ce qui est détecté, et ce qui ne l'est pas.
 *
 * Aucune variation statistique n'est présentée comme un bug : seules les anomalies **structurelles**
 * (χ² hors table, streams partagés, corpus dégénéré, reproductibilité cassée) sont signalées.
 */
export function conclusionLines(summary: LeaderAuditSummary): readonly string[] {
  const lines: string[] = [];
  const anomalies: string[] = [];

  for (const [index, table] of summary.leadersPerBound.entries()) {
    if (table.beyondChance || table.anyOutlier) {
      anomalies.push(
        `part de leader non uniforme à ${summary.boundLabels[index] ?? '?'} (χ² = ${table.chiSquare.toFixed(2)}, max |z| = ${table.maxAbsZ.toFixed(2)})`,
      );
    }
  }
  if (summary.winnerShares.beyondChance || summary.winnerShares.anyOutlier) {
    anomalies.push(
      `taux de victoire non uniforme (χ² = ${summary.winnerShares.chiSquare.toFixed(2)}, max |z| = ${summary.winnerShares.maxAbsZ.toFixed(2)})`,
    );
  }
  if (!summary.corpus.allRacesDistinct) {
    anomalies.push('corpus dégénéré : des courses distinctes ont des distances identiques');
  }
  if (!summary.corpus.leaderConsistentEverywhere) {
    anomalies.push('le suivi pas à pas et le classement officiel divergent sur au moins une course');
  }
  if (summary.rng.identicalSequencePairs.length > 0) {
    anomalies.push(`streams RNG partagés : ${summary.rng.identicalSequencePairs.join(', ')}`);
  }
  if (summary.rng.maxAbsCorrelation > summary.rng.correlationThreshold) {
    anomalies.push(
      `corrélation entre streams RNG (|r| = ${summary.rng.maxAbsCorrelation.toFixed(4)} > ${summary.rng.correlationThreshold.toFixed(4)})`,
    );
  }
  if (summary.rng.uniformityAnomalies.length > 0) {
    anomalies.push(`streams RNG non uniformes : ${summary.rng.uniformityAnomalies.join(', ')}`);
  }
  if (!summary.rng.independentConsumption) {
    anomalies.push('consommer un stream décale un autre stream');
  }
  if (!summary.rng.engineDriftStreamsDistinct) {
    anomalies.push('deux personnages partagent leur flux de dérive');
  }
  if (summary.rng.driftWorstZ > summary.rng.driftZThreshold) {
    anomalies.push(
      `dérives corrélées entre personnages (z = ${summary.rng.driftWorstZ.toFixed(2)} sur ${summary.rng.driftWorstPair ?? '—'})`,
    );
  }
  if (!summary.rng.engineSurgeStreamsDistinct) {
    anomalies.push('deux personnages partagent leur flux de surge');
  }
  for (const check of summary.references) {
    if (!check.withinReference && check.comparable) {
      anomalies.push(`référence hors plage : ${check.label} (${check.measured} vs ${check.reference})`);
    }
  }

  if (anomalies.length === 0) {
    lines.push(
      'Aucune anomalie structurelle détectée : parts par personnage compatibles avec 1/6, ' +
        'streams RNG indépendants, corpus entièrement distinct, reproductibilité intacte.',
    );
  } else {
    lines.push('Anomalies structurelles détectées :');
    for (const anomaly of anomalies) {
      lines.push(`- ${anomaly}`);
    }
  }
  lines.push(
    `Persistance mesurée : ${summary.sameLeaderAllBoundsPercent.toFixed(2)} % des courses ont le même leader aux trois bornes, ` +
      `${summary.threeDistinctLeadersPercent.toFixed(2)} % en ont trois différents — c'est une propriété de la course, ` +
      'pas un défaut : elle est attendue tant que les parts par personnage restent uniformes.',
  );
  return Object.freeze(lines);
}

// ---------------------------------------------------------------------------------------------
// Ligne de commande
// ---------------------------------------------------------------------------------------------

/** Options de la ligne de commande. */
export interface LeaderAuditCliOptions {
  readonly seeds: number;
  readonly referenceSeeds: number;
  readonly behaviorSeeds: number;
  readonly corpusPrefix: string;
  readonly jsonPath: string;
  readonly textPath: string;
  readonly replayCheck: boolean;
}

const AUDIT_HELP = [
  'Usage : npm run balance:leaders -- [options]',
  '',
  `  --seeds=<n>            nombre de seeds du corpus (défaut : ${String(DEFAULT_AUDIT_SEEDS)})`,
  `  --reference-seeds=<n>  sous-corpus comparé aux références (défaut : ${String(DEFAULT_REFERENCE_SEEDS)})`,
  `  --behavior-seeds=<n>   seeds des contrôles de flux comportementaux (défaut : ${String(DEFAULT_BEHAVIOR_SEEDS)})`,
  `  --corpus=<prefixe>     préfixe du corpus déterministe (défaut : ${DEFAULT_AUDIT_CORPUS})`,
  `  --json=<chemin>        rapport structuré (défaut : ${DEFAULT_AUDIT_JSON})`,
  `  --text=<chemin>        rapport texte (défaut : ${DEFAULT_AUDIT_TEXT})`,
  '  --no-replay-check      saute le contrôle de reproductibilité bit à bit',
  '',
].join('\n');

/** Analyse les arguments. Lève une `RangeError` explicite sur une entrée invalide. */
export function parseLeaderAuditArgs(argv: readonly string[]): LeaderAuditCliOptions | 'help' {
  let seeds = DEFAULT_AUDIT_SEEDS;
  let referenceSeeds = DEFAULT_REFERENCE_SEEDS;
  let behaviorSeeds = DEFAULT_BEHAVIOR_SEEDS;
  let corpusPrefix = DEFAULT_AUDIT_CORPUS;
  let jsonPath = DEFAULT_AUDIT_JSON;
  let textPath = DEFAULT_AUDIT_TEXT;
  let replayCheck = true;

  const integer = (value: string, label: string): number => {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new RangeError(`${label} attend un entier ≥ 1 (reçu : ${value}).`);
    }
    return parsed;
  };

  for (const argument of argv) {
    if (argument.startsWith('--seeds=')) {
      seeds = integer(argument.slice('--seeds='.length), '--seeds');
      continue;
    }
    if (argument.startsWith('--reference-seeds=')) {
      referenceSeeds = integer(argument.slice('--reference-seeds='.length), '--reference-seeds');
      continue;
    }
    if (argument.startsWith('--behavior-seeds=')) {
      behaviorSeeds = integer(argument.slice('--behavior-seeds='.length), '--behavior-seeds');
      continue;
    }
    if (argument.startsWith('--corpus=')) {
      corpusPrefix = argument.slice('--corpus='.length);
      continue;
    }
    if (argument.startsWith('--json=')) {
      jsonPath = argument.slice('--json='.length);
      continue;
    }
    if (argument.startsWith('--text=')) {
      textPath = argument.slice('--text='.length);
      continue;
    }
    if (argument === '--no-replay-check') {
      replayCheck = false;
      continue;
    }
    if (argument === '--help' || argument === '-h') {
      return 'help';
    }
    throw new RangeError(`Argument inconnu : ${argument}.`);
  }

  return { seeds, referenceSeeds, behaviorSeeds, corpusPrefix, jsonPath, textPath, replayCheck };
}

/** Résultat de la ligne de commande : code de sortie et rapports à écrire. */
export interface LeaderAuditCliResult {
  readonly exitCode: number;
  readonly text: string;
  readonly report: unknown;
  readonly jsonPath: string;
  readonly textPath: string;
}

/**
 * Exécute l'audit complet.
 *
 * Le code de sortie vaut `1` **uniquement** si une anomalie structurelle est détectée : une variation
 * statistique normale ne fait pas échouer l'outil.
 */
export function runLeaderAuditWithReport(argv: readonly string[]): LeaderAuditCliResult {
  const options = parseLeaderAuditArgs(argv);
  if (options === 'help') {
    console.log(AUDIT_HELP);
    return {
      exitCode: 0,
      text: AUDIT_HELP,
      report: null,
      jsonPath: DEFAULT_AUDIT_JSON,
      textPath: DEFAULT_AUDIT_TEXT,
    };
  }

  const seeds = corpusSeeds(options.seeds, options.corpusPrefix);
  console.log('Chaos Race — audit des leaders aux bornes');
  console.log(
    `corpus « ${options.corpusPrefix} » : ${String(options.seeds)} seeds | ` +
      `première ${seeds[0] ?? '—'} | dernière ${seeds[seeds.length - 1] ?? '—'}`,
  );

  const startedAt = performance.now();
  const races = runLeaderAudit(seeds, {
    onRace: (index, total) => {
      if (index % 2_000 === 0 || index === total) {
        console.log(`  … ${String(index)}/${String(total)} courses`);
      }
    },
  });
  const elapsedMs = performance.now() - startedAt;

  const referenceRaces = races.slice(0, Math.min(options.referenceSeeds, races.length));
  const reproducibility = options.replayCheck
    ? (() => {
        const measured = measureReproducibility(seeds.slice(0, AUDIT_REFERENCES.reproducibilitySeeds));
        return { seeds: measured.seeds, identical: measured.identicalDistances };
      })()
    : { seeds: 0, identical: 0 };

  const rng = auditRngStreams(seeds, { behaviorSeeds: options.behaviorSeeds });
  const summary = summarizeLeaderAudit(races, { referenceRaces, rng, reproducibility });
  const text = renderLeaderAuditText(summary, elapsedMs);
  const report = buildLeaderAuditJson(summary, elapsedMs);

  console.log('');
  console.log(text);
  const conclusion = conclusionLines(summary);
  const hasAnomaly = conclusion[0]?.startsWith('Anomalies') ?? false;

  return {
    exitCode: hasAnomaly ? 1 : 0,
    text,
    report,
    jsonPath: options.jsonPath,
    textPath: options.textPath,
  };
}
