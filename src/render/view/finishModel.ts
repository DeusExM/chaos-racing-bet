import type { CharacterId, RaceFact, RaceState } from '../../core/types';
import { leaderboardOf } from '../../sim/leaderboard';
import type { LeaderboardRow } from '../../sim/leaderboard';
import { VIEW } from '../viewConfig';

/**
 * Modèle **pur** de la fin de course (P013).
 *
 * ## La règle qui structure tout ce fichier
 *
 * Le classement final et les distances finales viennent **exclusivement** du noyau, à
 * `tSim = RACE_CONFIG.TOTAL_SIM_S` (60 s), au moment où la phase devient `finished`. Rien n'est
 * recalculé ici : l'ordre et les écarts sortent de `sim/leaderboard.ts`, qui s'appuie lui-même sur
 * `core/ranking.ts`. Ce module ne trie rien, ne compare aucune distance et ne connaît ni constante de
 * piste, ni repère de décor, ni position d'écran : c'est ce qui rend impossible qu'un podium
 * contredise le noyau.
 *
 * ## Deux objets, deux rôles
 *
 * * `FinishSnapshot` est la **photographie figée** de l'arrivée : distances, vitesses et classement
 *   du pas `TOTAL_STEPS`, copiés une fois et gelés. C'est elle, et elle seule, que l'affichage
 *   consomme ensuite — donc les valeurs montrées ne peuvent plus bouger, même si le rendu continue de
 *   vivre.
 * * `FinishModel` est la **présentation** de cette photographie : vainqueur, podium, liste complète,
 *   et la mention `PHOTO_FINISH` lorsqu'elle a réellement eu lieu.
 *
 * ## Décélération visuelle
 *
 * `deceleratedDistances()` ajoute aux distances figées une **inertie de rendu** qui rend le ralentissement
 * visible après l'arrivée. Il s'agit d'un décalage identique pour les six marcheurs, donc purement
 * décoratif : il n'écrit dans aucun état, ne consomme aucun hasard, ne touche ni `tSim` ni le compteur
 * de pas, et — parce qu'il est le même pour tous — il ne peut pas modifier l'ordre visuel du classement
 * figé. Aucune position d'écran n'est donc jamais un critère.
 */

/** Photographie figée de l'arrivée, prise au pas `TOTAL_STEPS`. */
export interface FinishSnapshot {
  readonly seed: string;
  /** Instant simulé de l'arrivée : toujours `TOTAL_SIM_S` (`60` s), lu dans le noyau. */
  readonly tSim: number;
  /** Nombre de pas de l'arrivée : toujours `TOTAL_STEPS` (`3600`), lu dans le noyau. */
  readonly steps: number;
  /** Distances finales, dans l'ordre du roster. */
  readonly distances: readonly number[];
  /** Vitesses finales, dans l'ordre du roster : elles ne servent qu'à la décélération visuelle. */
  readonly velocities: readonly number[];
  /** Classement final figé, du 1er au dernier — la seule source du podium. */
  readonly rows: readonly LeaderboardRow[];
  /** Vitesse d'inertie du rendu, en m/s : moyenne des vitesses finales mesurées. */
  readonly coastSpeed: number;
}

/** Mention de photo finish, dérivée du **fait réel** produit par le noyau. */
export interface FinishPhotoFinish {
  /** Écart P1–P2 mesuré par l'observateur, en mètres. */
  readonly gapMeters: number;
  readonly leaderId: CharacterId;
  readonly secondId: CharacterId;
}

/**
 * Une borne de la course, avec le leader observé à cet instant.
 *
 * `checkpoint` vaut `1` ou `2` pour un checkpoint intermédiaire, et `null` pour l'**arrivée** : c'est
 * la troisième borne, et il n'en existe pas d'autre (`RACE_CONFIG.SEGMENT_COUNT = 3`). Aucun
 * « checkpoint 3 » n'est donc jamais présenté.
 */
export interface FinishPassage {
  /** Numéro de checkpoint, ou `null` quand la borne est l'arrivée. */
  readonly checkpoint: number | null;
  /** Instant simulé réellement mesuré par le noyau (`20`, `40`, `60`). */
  readonly tSim: number;
  readonly characterId: CharacterId;
  readonly name: string;
}

/** Tout ce que l'écran d'arrivée présente, déjà dérivé du noyau. */
export interface FinishModel {
  readonly seed: string;
  readonly tSim: number;
  readonly steps: number;
  /** Premier du classement final, tel que le noyau le donne. */
  readonly winner: LeaderboardRow;
  /** Les `FINISH_PODIUM_SIZE` premiers, dans l'ordre du noyau. */
  readonly podium: readonly LeaderboardRow[];
  /** Les six marcheurs, dans l'ordre exact du classement final. */
  readonly rows: readonly LeaderboardRow[];
  /**
   * Passages en tête : les checkpoints **réellement observés**, puis l'arrivée.
   *
   * Les checkpoints viennent d'un relevé du classement au moment où le noyau annonçait la borne
   * (`passageModel.ts`), l'arrivée du classement final figé. Aucune de ces lignes n'est recalculée
   * depuis une position d'écran.
   */
  readonly passages: readonly FinishPassage[];
  /** `PHOTO_FINISH` a-t-il réellement eu lieu ? `null` sinon — aucune mention n'est alors affichée. */
  readonly photoFinish: FinishPhotoFinish | null;
}

/** Copie gelée d'une ligne de classement : la présentation ne peut pas la modifier. */
function frozenRow(row: LeaderboardRow): LeaderboardRow {
  return Object.freeze({ ...row });
}

/**
 * Capture l'instantané final du noyau.
 *
 * Refuse un état qui n'est pas `finished` : un « classement final » calculé en cours de course serait
 * une seconde source de vérité déguisée, et c'est exactement ce que P013 interdit.
 */
export function captureFinishSnapshot(state: Readonly<RaceState>): FinishSnapshot {
  if (state.phase.kind !== 'finished') {
    throw new RangeError(
      `Le classement final ne se capture qu'à l'arrivée (phase reçue : ${state.phase.kind}).`,
    );
  }

  const distances = Object.freeze(state.characters.map((character) => character.x));
  const velocities = Object.freeze(state.characters.map((character) => character.v));
  const rows = Object.freeze(leaderboardOf(state).map(frozenRow));

  for (const distance of distances) {
    if (!Number.isFinite(distance)) {
      throw new RangeError('Distance finale non finie : le classement ne peut pas être figé.');
    }
  }

  // La vitesse d'inertie est la moyenne des vitesses **réellement mesurées** à l'arrivée : le rendu
  // n'invente donc aucune vitesse, il ne fait que prolonger brièvement celles du dernier pas.
  const coastSpeed =
    velocities.reduce((total, speed) => total + speed, 0) / Math.max(1, velocities.length);

  return Object.freeze({
    seed: state.seed,
    tSim: state.tSim,
    steps: state.steps,
    distances,
    velocities,
    rows,
    coastSpeed,
  });
}

/**
 * Distance d'inertie parcourue `elapsedMs` après l'arrivée.
 *
 * La vitesse visuelle décroît linéairement de `coastSpeed` à `0` sur `FINISH_DECELERATION_MS`, donc
 * le décalage vaut `v·T·(1 − (1 − u)²)/2` avec `u = t/T`, borné à `v·T/2` une fois la transition
 * finie. Fonction pure, monotone, et strictement nulle à l'instant de l'arrivée.
 */
export function decelerationOffset(coastSpeed: number, elapsedMs: number): number {
  if (!Number.isFinite(coastSpeed) || coastSpeed <= 0) {
    return 0;
  }
  const durationMs = VIEW.FINISH_DECELERATION_MS;
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0 || durationMs <= 0) {
    return 0;
  }

  const progress = Math.min(1, elapsedMs / durationMs);
  const remaining = 1 - progress;
  return (coastSpeed * (durationMs / 1000) * (1 - remaining * remaining)) / 2;
}

/**
 * Distances **de rendu** après l'arrivée : celles du classement figé, plus une inertie commune.
 *
 * Le décalage est identique pour les six marcheurs : l'ordre visuel ne peut donc pas diverger de
 * l'ordre du noyau, et aucune position d'écran ne peut devenir un critère de victoire.
 */
export function deceleratedDistances(
  snapshot: FinishSnapshot,
  elapsedMs: number,
): readonly number[] {
  const offset = decelerationOffset(snapshot.coastSpeed, elapsedMs);
  if (offset === 0) {
    return snapshot.distances;
  }
  return Object.freeze(snapshot.distances.map((distance) => distance + offset));
}

/** Valeur mesurée d'un fait, refusée si elle est absente : un fait incomplet est un bug du noyau. */
function magnitudeAt(fact: RaceFact, index: number): number {
  const value = fact.magnitudes[index];
  if (value === undefined) {
    throw new RangeError(`Fait ${fact.type} : magnitude ${index} absente.`);
  }
  return value;
}

function characterAt(fact: RaceFact, index: number): CharacterId {
  const id = fact.characterIds[index];
  if (id === undefined) {
    throw new RangeError(`Fait ${fact.type} : personnage ${index} absent.`);
  }
  return id;
}

/**
 * Mention de photo finish, **ou `null`**.
 *
 * La seule source est le fait d'arrivée du noyau : `PHOTO_FINISH` signifie que l'écart P1–P2 mesuré
 * était sous le seuil du design, `FINISH` qu'il ne l'était pas. Aucun seuil n'est recalculé ici, donc
 * la mention ne peut pas apparaître sur une course qui ne l'a pas produite.
 */
export function photoFinishOf(arrival: RaceFact | null): FinishPhotoFinish | null {
  if (arrival === null || arrival.type !== 'PHOTO_FINISH') {
    return null;
  }
  return Object.freeze({
    gapMeters: magnitudeAt(arrival, 0),
    leaderId: characterAt(arrival, 0),
    secondId: characterAt(arrival, 1),
  });
}

/**
 * Assemble le modèle d'affichage de l'arrivée.
 *
 * Le podium est le **début** de la liste du noyau, pas une sélection : il ne décide donc jamais qui
 * gagne. Un instantané sans les six marcheurs est refusé plutôt que complété.
 *
 * Les `passages` reçus sont ceux **réellement observés** aux checkpoints (`passageModel.ts`) ; la
 * dernière ligne — l'arrivée — est ajoutée ici à partir du classement final figé, donc du même
 * vainqueur que le podium. L'ordre est celui des bornes, jamais un tri.
 */
export function buildFinishModel(
  snapshot: FinishSnapshot,
  arrival: RaceFact | null,
  passages: readonly FinishPassage[] = [],
): FinishModel {
  const winner = snapshot.rows[0];
  if (winner === undefined || snapshot.rows.length === 0) {
    throw new RangeError('Classement final vide : aucun vainqueur à présenter.');
  }

  const podiumSize = Math.max(1, Math.min(VIEW.FINISH_PODIUM_SIZE, snapshot.rows.length));
  const orderedPassages = [...passages].sort((left, right) => left.tSim - right.tSim);

  return Object.freeze({
    seed: snapshot.seed,
    tSim: snapshot.tSim,
    steps: snapshot.steps,
    winner,
    podium: Object.freeze(snapshot.rows.slice(0, podiumSize)),
    rows: snapshot.rows,
    passages: Object.freeze([
      ...orderedPassages,
      Object.freeze({
        checkpoint: null,
        tSim: snapshot.tSim,
        characterId: winner.id,
        name: winner.name,
      }),
    ]),
    photoFinish: photoFinishOf(arrival),
  });
}
