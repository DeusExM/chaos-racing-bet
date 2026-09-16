/**
 * Toutes les constantes de jeu de la V1, en un seul endroit.
 *
 * Chaque valeur est la copie exacte de `GAME_DESIGN.md` : si l'une d'elles change, le document
 * change en même temps que ce fichier. Aucune valeur magique ne doit apparaître ailleurs dans le
 * noyau.
 *
 * Deux règles structurelles gouvernent ce module :
 *
 * 1. **Aucune durée réelle, aucune distance d'arrivée.** Le noyau ne connaît que du temps simulé ;
 *    tout ce qui se compte en secondes réelles appartient à `SIM_CONFIG`, côté `src/sim/`.
 * 2. **Aucune fonction transcendante.** `Math.sqrt` et compagnie ne sont pas correctement arrondies
 *    par la norme ECMAScript : leur dernier bit peut différer d'un moteur JavaScript à l'autre, ce
 *    qui casserait la reproductibilité. Une constante qui en dépend est donc **pré-calculée à la
 *    main** et figée ici, jamais recalculée à l'exécution.
 *
 * Les objets exportés sont figés. Comme toutes leurs valeurs sont des primitives, un simple
 * `Object.freeze` suffit à les rendre **profondément** immuables : il n'existe aucune sous-structure
 * encore modifiable.
 */

/** Forme des constantes de temps simulé. */
export interface RaceTimeConfig {
  readonly SEGMENT_COUNT: number;
  readonly SEGMENT_DURATION_S: number;
  readonly TOTAL_SIM_S: number;
  readonly DT_S: number;
  readonly STEPS_PER_SEGMENT: number;
  readonly TOTAL_STEPS: number;
}

/** Vitesses et rampes. */
export interface SpeedConfig {
  readonly BASE: number;
  readonly MIN: number;
  readonly MAX: number;
  readonly MAX_ACCEL: number;
  readonly MAX_DECEL: number;
}

/** Dérive permanente. */
export interface DriftConfig {
  readonly THETA: number;
  readonly SIGMA: number;
  readonly CLAMP: number;
  readonly STATIONARY_SD: number;
}

/** Surges. */
export interface SurgeConfig {
  readonly INTERVAL_MEAN_S: number;
  readonly INTERVAL_MIN_S: number;
  readonly DURATION_MIN_S: number;
  readonly DURATION_MAX_S: number;
  readonly MAGNITUDE_MIN: number;
  readonly MAGNITUDE_MAX: number;
  readonly BRAKE_PROBABILITY: number;
  readonly MAGNITUDE_BRAKE_MIN: number;
  readonly MAGNITUDE_BRAKE_MAX: number;
}

/** Planificateur d'événements rares. */
export interface EventConfig {
  readonly RATE_PER_S: number;
  readonly GLOBAL_COOLDOWN_S: number;
  readonly CHAR_COOLDOWN_S: number;
  readonly MAX_PER_CHARACTER: number;
  readonly MAX_ACTIVE_PER_CHARACTER: number;
}

/** Classement. La politique de départage est un littéral, pour rester exhaustive à la compilation. */
export interface RankConfig {
  readonly TIE_BREAK: 'ascendingId';
}

/** Observation des dépassements. */
export interface OvertakeConfig {
  readonly MIN_MARGIN: number;
}

/** Observation des changements de leader. */
export interface LeaderConfig {
  readonly DEBOUNCE_S: number;
  readonly MIN_MARGIN: number;
}

/** Discipline de parole du speaker. */
export interface SpeakConfig {
  readonly MIN_IMPORTANCE: number;
  readonly GLOBAL_COOLDOWN_S: number;
  readonly PREEMPT_IMPORTANCE: number;
  readonly INTERRUPT_DELTA: number;
  readonly QUEUE_MAX: number;
  readonly MAX_LINES_PER_SEGMENT: number;
  readonly MIN_WINDOW_AVG_S: number;
}

/** Temps simulé de la course. Le noyau ignore tout du temps réel. */
export const RACE_CONFIG: RaceTimeConfig = Object.freeze({
  /** Nombre de segments. */
  SEGMENT_COUNT: 4,
  /** Durée **simulée** d'un segment, en secondes. */
  SEGMENT_DURATION_S: 45,
  /** `SEGMENT_COUNT × SEGMENT_DURATION_S`. Fin de course : c'est le **seul** critère d'arrêt. */
  TOTAL_SIM_S: 180,
  /** Pas fixe de simulation, en secondes. `RaceEngine.step()` ne prend aucun autre argument. */
  DT_S: 1 / 60,
  /** `SEGMENT_DURATION_S / DT_S`. */
  STEPS_PER_SEGMENT: 2700,
  /** `TOTAL_SIM_S / DT_S` : nombre de pas d'une course complète, pauses comprises. */
  TOTAL_STEPS: 10800,
});

/** Vitesses et rampes. `BASE` est identique pour les 6 personnages : aucun n'a d'avantage. */
export const SPEED: SpeedConfig = Object.freeze({
  BASE: 12.0,
  MIN: 3.0,
  MAX: 48.0,
  MAX_ACCEL: 10.0,
  MAX_DECEL: 12.0,
});

/**
 * Dérive permanente (Ornstein–Uhlenbeck) — la seule source des premiers dépassements naturels.
 *
 * `STATIONARY_SD` vaut `SIGMA / √(2 × THETA)`, **pré-calculé** : le noyau n'a pas le droit d'appeler
 * `Math.sqrt`. `validateConfig()` vérifie tout de même la relation par une identité algébrique
 * équivalente — `STATIONARY_SD² × 2 × THETA = SIGMA²` — qui n'utilise que des multiplications.
 */
export const DRIFT: DriftConfig = Object.freeze({
  /** Rappel vers zéro, par seconde. */
  THETA: 0.25,
  /** Amplitude du bruit, par racine de seconde. */
  SIGMA: 0.09,
  /** Dérive maximale, en valeur relative (±20 %). */
  CLAMP: 0.2,
  /** Écart-type stationnaire du processus, valeur figée (≈ 0,127). */
  STATIONARY_SD: 0.12727922061357855,
});

/** Surges : petites variations temporaires, une seule active par personnage à la fois. */
export const SURGE: SurgeConfig = Object.freeze({
  INTERVAL_MEAN_S: 9.0,
  INTERVAL_MIN_S: 4.0,
  DURATION_MIN_S: 1.5,
  DURATION_MAX_S: 4.0,
  MAGNITUDE_MIN: 0.1,
  MAGNITUDE_MAX: 0.35,
  BRAKE_PROBABILITY: 0.45,
  MAGNITUDE_BRAKE_MIN: 0.1,
  MAGNITUDE_BRAKE_MAX: 0.3,
});

/**
 * Planificateur d'événements rares.
 *
 * Le **catalogue** des événements (magnitudes, durées, poids) ne vit pas ici : il arrive avec le
 * planificateur, dans `src/core/events.ts`. Ces valeurs-ci ne décrivent que la fréquence et les
 * cooldowns.
 */
export const EVENT: EventConfig = Object.freeze({
  /** Taux global, en événements par seconde simulée. */
  RATE_PER_S: 1 / 14,
  /** Délai minimal entre deux événements, tous personnages confondus. */
  GLOBAL_COOLDOWN_S: 4.0,
  /** Délai minimal entre deux événements subis par le même personnage. */
  CHAR_COOLDOWN_S: 8.0,
  /** Plafond d'événements par personnage et par course. */
  MAX_PER_CHARACTER: 5,
  /** Nombre maximal d'événements simultanés sur un même personnage. */
  MAX_ACTIVE_PER_CHARACTER: 1,
});

/**
 * Classement.
 *
 * Il n'existe ici **aucun seuil numérique** : le classement est une conséquence directe des
 * distances, sans marge, sans lissage et sans correction. La seule règle qui mérite d'être nommée
 * est le départage des égalités strictes, qui doit rester déterministe.
 */
export const RANK: RankConfig = Object.freeze({
  /**
   * Égalité de distance : le plus petit identifiant (index croissant) obtient le meilleur rang.
   * Une seule politique est autorisée — tout autre choix rendrait le classement dépendant de
   * l'ordre d'itération ou de l'historique.
   */
  TIE_BREAK: 'ascendingId',
});

/** Observation des dépassements. Ce sont des règles de **constat**, elles n'écrivent jamais dans `x`. */
export const OVERTAKE: OvertakeConfig = Object.freeze({
  /** Marge minimale pour compter un dépassement, en mètres. Filtre le bruit numérique. */
  MIN_MARGIN: 0.5,
});

/** Observation des changements de leader. Règles de constat, sans effet sur la simulation. */
export const LEADER: LeaderConfig = Object.freeze({
  /** Durée pendant laquelle le nouveau leader doit se maintenir pour être reconnu. */
  DEBOUNCE_S: 0.75,
  /** Avance minimale du nouveau leader, en mètres. */
  MIN_MARGIN: 1.0,
});

/** Discipline de parole du speaker. Le speaker ne décide jamais de ce qui se passe. */
export const SPEAK: SpeakConfig = Object.freeze({
  /** Sous cette importance, un fait n'est pas commenté. */
  MIN_IMPORTANCE: 45,
  /** Silence minimal entre deux prises de parole. */
  GLOBAL_COOLDOWN_S: 6.0,
  /** Au-delà, un fait peut court-circuiter le cooldown global. */
  PREEMPT_IMPORTANCE: 85,
  /** Une réplique en cours est coupée si la nouvelle la dépasse d'au moins cette valeur. */
  INTERRUPT_DELTA: 20,
  /** Au-delà, la réplique la moins importante est jetée. */
  QUEUE_MAX: 3,
  /** Quota dur de répliques par segment. */
  MAX_LINES_PER_SEGMENT: 12,
  /** Moyenne minimale d'écart sur la fenêtre glissante. */
  MIN_WINDOW_AVG_S: 5.0,
});

/** Vue agrégée de toutes les constantes, utilisée par `validateConfig()`. */
export interface GameConfig {
  readonly RACE: RaceTimeConfig;
  readonly SPEED: SpeedConfig;
  readonly DRIFT: DriftConfig;
  readonly SURGE: SurgeConfig;
  readonly EVENT: EventConfig;
  readonly RANK: RankConfig;
  readonly OVERTAKE: OvertakeConfig;
  readonly LEADER: LeaderConfig;
  readonly SPEAK: SpeakConfig;
}

/** Toutes les constantes réunies, figées. Chaque membre est déjà figé individuellement. */
export const GAME_CONFIG: GameConfig = Object.freeze({
  RACE: RACE_CONFIG,
  SPEED,
  DRIFT,
  SURGE,
  EVENT,
  RANK,
  OVERTAKE,
  LEADER,
  SPEAK,
});

/**
 * Tolérance relative des comparaisons entre constantes dérivées.
 *
 * Elle n'existe que pour la relation `STATIONARY_SD² × 2 × THETA = SIGMA²` : sur les valeurs
 * actuelles l'égalité est **exacte**, mais une constante dérivée réécrite avec un chiffre de moins
 * doit rester acceptable. Elle ne sert à aucune comparaison de jeu.
 */
const CONSTANT_RELATIVE_TOLERANCE = 1e-12;

function requireFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${label} doit être un nombre fini (reçu : ${value}).`);
  }
}

function requirePositive(value: number, label: string): void {
  requireFinite(value, label);
  if (value <= 0) {
    throw new RangeError(`${label} doit être strictement positif (reçu : ${value}).`);
  }
}

function requireNonNegative(value: number, label: string): void {
  requireFinite(value, label);
  if (value < 0) {
    throw new RangeError(`${label} doit être positif ou nul (reçu : ${value}).`);
  }
}

function requireIntegerAtLeast(value: number, minimum: number, label: string): void {
  requireFinite(value, label);
  if (!Number.isInteger(value) || value < minimum) {
    throw new RangeError(`${label} doit être un entier supérieur ou égal à ${minimum} (reçu : ${value}).`);
  }
}

function requireAtMost(value: number, maximum: number, label: string): void {
  requireFinite(value, label);
  if (value > maximum) {
    throw new RangeError(`${label} doit être inférieur ou égal à ${maximum} (reçu : ${value}).`);
  }
}

function requireOrder(minimum: number, maximum: number, label: string): void {
  requireFinite(minimum, `${label} (borne basse)`);
  requireFinite(maximum, `${label} (borne haute)`);
  if (minimum > maximum) {
    throw new RangeError(`${label} : la borne basse ${minimum} dépasse la borne haute ${maximum}.`);
  }
}

function requireCloseTo(actual: number, expected: number, label: string): void {
  requireFinite(actual, label);
  requireFinite(expected, `${label} (valeur attendue)`);
  const magnitude = Math.abs(expected) > 1 ? Math.abs(expected) : 1;
  if (Math.abs(actual - expected) > CONSTANT_RELATIVE_TOLERANCE * magnitude) {
    throw new RangeError(`${label} : ${actual} s'écarte de la valeur attendue ${expected}.`);
  }
}

/**
 * Vérifie la cohérence interne d'un jeu de constantes.
 *
 * Les relations dérivées sont testées sous forme **multiplicative** (`TOTAL_STEPS × DT_S =
 * TOTAL_SIM_S`) plutôt que par division : la multiplication est exacte ici, tandis qu'une division
 * peut laisser un dernier bit douteux. Lève une `RangeError` au premier problème rencontré.
 *
 * `RaceEngine` l'appellera à sa construction ; les tests l'appellent directement, y compris avec des
 * configurations volontairement incohérentes pour vérifier qu'elles sont bien rejetées.
 */
export function validateConfig(config: GameConfig = GAME_CONFIG): void {
  const { RACE, SPEED: S, DRIFT: D, SURGE: G, EVENT: E, OVERTAKE: O, LEADER: L, SPEAK: K } = config;

  requireIntegerAtLeast(RACE.SEGMENT_COUNT, 1, 'RACE_CONFIG.SEGMENT_COUNT');
  requirePositive(RACE.SEGMENT_DURATION_S, 'RACE_CONFIG.SEGMENT_DURATION_S');
  requirePositive(RACE.TOTAL_SIM_S, 'RACE_CONFIG.TOTAL_SIM_S');
  requirePositive(RACE.DT_S, 'RACE_CONFIG.DT_S');
  requireIntegerAtLeast(RACE.STEPS_PER_SEGMENT, 1, 'RACE_CONFIG.STEPS_PER_SEGMENT');
  requireIntegerAtLeast(RACE.TOTAL_STEPS, 1, 'RACE_CONFIG.TOTAL_STEPS');

  requireCloseTo(
    RACE.SEGMENT_COUNT * RACE.SEGMENT_DURATION_S,
    RACE.TOTAL_SIM_S,
    'RACE_CONFIG : SEGMENT_COUNT × SEGMENT_DURATION_S doit valoir TOTAL_SIM_S',
  );
  requireCloseTo(
    RACE.STEPS_PER_SEGMENT * RACE.DT_S,
    RACE.SEGMENT_DURATION_S,
    'RACE_CONFIG : STEPS_PER_SEGMENT × DT_S doit valoir SEGMENT_DURATION_S',
  );
  requireCloseTo(
    RACE.TOTAL_STEPS * RACE.DT_S,
    RACE.TOTAL_SIM_S,
    'RACE_CONFIG : TOTAL_STEPS × DT_S doit valoir TOTAL_SIM_S',
  );
  // Cette relation ne fait intervenir que des entiers : l'égalité doit être exacte, pas approchée.
  if (RACE.SEGMENT_COUNT * RACE.STEPS_PER_SEGMENT !== RACE.TOTAL_STEPS) {
    throw new RangeError(
      `RACE_CONFIG : SEGMENT_COUNT × STEPS_PER_SEGMENT (${RACE.SEGMENT_COUNT * RACE.STEPS_PER_SEGMENT}) doit valoir exactement TOTAL_STEPS (${RACE.TOTAL_STEPS}).`,
    );
  }

  requirePositive(S.BASE, 'SPEED.BASE');
  requirePositive(S.MIN, 'SPEED.MIN');
  requirePositive(S.MAX, 'SPEED.MAX');
  requirePositive(S.MAX_ACCEL, 'SPEED.MAX_ACCEL');
  requirePositive(S.MAX_DECEL, 'SPEED.MAX_DECEL');
  if (S.MIN > S.BASE) {
    throw new RangeError(`SPEED : MIN (${S.MIN}) ne peut pas dépasser BASE (${S.BASE}).`);
  }
  if (S.MAX < S.BASE) {
    throw new RangeError(`SPEED : MAX (${S.MAX}) ne peut pas être inférieur à BASE (${S.BASE}).`);
  }

  requirePositive(D.THETA, 'DRIFT.THETA');
  requirePositive(D.SIGMA, 'DRIFT.SIGMA');
  requirePositive(D.CLAMP, 'DRIFT.CLAMP');
  requirePositive(D.STATIONARY_SD, 'DRIFT.STATIONARY_SD');
  requireAtMost(D.CLAMP, 1, 'DRIFT.CLAMP');
  if (D.STATIONARY_SD >= D.CLAMP) {
    throw new RangeError(
      `DRIFT : STATIONARY_SD (${D.STATIONARY_SD}) doit rester sous CLAMP (${D.CLAMP}), sinon la dérive serait écrêtée en permanence.`,
    );
  }
  requireCloseTo(
    D.STATIONARY_SD * D.STATIONARY_SD * 2 * D.THETA,
    D.SIGMA * D.SIGMA,
    'DRIFT : STATIONARY_SD² × 2 × THETA doit valoir SIGMA² (constante pré-calculée incohérente)',
  );

  requirePositive(G.INTERVAL_MEAN_S, 'SURGE.INTERVAL_MEAN_S');
  requirePositive(G.INTERVAL_MIN_S, 'SURGE.INTERVAL_MIN_S');
  requireOrder(G.INTERVAL_MIN_S, G.INTERVAL_MEAN_S, 'SURGE : INTERVAL_MIN_S / INTERVAL_MEAN_S');
  requirePositive(G.DURATION_MIN_S, 'SURGE.DURATION_MIN_S');
  requirePositive(G.DURATION_MAX_S, 'SURGE.DURATION_MAX_S');
  requireOrder(G.DURATION_MIN_S, G.DURATION_MAX_S, 'SURGE : DURATION_MIN_S / DURATION_MAX_S');
  requirePositive(G.MAGNITUDE_MIN, 'SURGE.MAGNITUDE_MIN');
  requirePositive(G.MAGNITUDE_MAX, 'SURGE.MAGNITUDE_MAX');
  requireOrder(G.MAGNITUDE_MIN, G.MAGNITUDE_MAX, 'SURGE : MAGNITUDE_MIN / MAGNITUDE_MAX');
  requireNonNegative(G.BRAKE_PROBABILITY, 'SURGE.BRAKE_PROBABILITY');
  requireAtMost(G.BRAKE_PROBABILITY, 1, 'SURGE.BRAKE_PROBABILITY');
  requirePositive(G.MAGNITUDE_BRAKE_MIN, 'SURGE.MAGNITUDE_BRAKE_MIN');
  requirePositive(G.MAGNITUDE_BRAKE_MAX, 'SURGE.MAGNITUDE_BRAKE_MAX');
  requireOrder(
    G.MAGNITUDE_BRAKE_MIN,
    G.MAGNITUDE_BRAKE_MAX,
    'SURGE : MAGNITUDE_BRAKE_MIN / MAGNITUDE_BRAKE_MAX',
  );

  requirePositive(E.RATE_PER_S, 'EVENT.RATE_PER_S');
  requireNonNegative(E.GLOBAL_COOLDOWN_S, 'EVENT.GLOBAL_COOLDOWN_S');
  requireNonNegative(E.CHAR_COOLDOWN_S, 'EVENT.CHAR_COOLDOWN_S');
  requireIntegerAtLeast(E.MAX_PER_CHARACTER, 1, 'EVENT.MAX_PER_CHARACTER');
  requireIntegerAtLeast(E.MAX_ACTIVE_PER_CHARACTER, 1, 'EVENT.MAX_ACTIVE_PER_CHARACTER');

  requireNonNegative(O.MIN_MARGIN, 'OVERTAKE.MIN_MARGIN');

  requireNonNegative(L.DEBOUNCE_S, 'LEADER.DEBOUNCE_S');
  requireNonNegative(L.MIN_MARGIN, 'LEADER.MIN_MARGIN');

  requireNonNegative(K.MIN_IMPORTANCE, 'SPEAK.MIN_IMPORTANCE');
  requireAtMost(K.MIN_IMPORTANCE, 100, 'SPEAK.MIN_IMPORTANCE');
  requireNonNegative(K.PREEMPT_IMPORTANCE, 'SPEAK.PREEMPT_IMPORTANCE');
  requireAtMost(K.PREEMPT_IMPORTANCE, 100, 'SPEAK.PREEMPT_IMPORTANCE');
  if (K.PREEMPT_IMPORTANCE < K.MIN_IMPORTANCE) {
    throw new RangeError(
      `SPEAK : PREEMPT_IMPORTANCE (${K.PREEMPT_IMPORTANCE}) ne peut pas être sous MIN_IMPORTANCE (${K.MIN_IMPORTANCE}).`,
    );
  }
  requireNonNegative(K.GLOBAL_COOLDOWN_S, 'SPEAK.GLOBAL_COOLDOWN_S');
  requireNonNegative(K.INTERRUPT_DELTA, 'SPEAK.INTERRUPT_DELTA');
  requireIntegerAtLeast(K.QUEUE_MAX, 1, 'SPEAK.QUEUE_MAX');
  requireIntegerAtLeast(K.MAX_LINES_PER_SEGMENT, 1, 'SPEAK.MAX_LINES_PER_SEGMENT');
  requireNonNegative(K.MIN_WINDOW_AVG_S, 'SPEAK.MIN_WINDOW_AVG_S');
}
