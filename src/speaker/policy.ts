import type { RaceFactType } from '../core/types';

/**
 * Politique de parole : **source de vérité unique** des constantes de `GAME_DESIGN.md` §9.3.
 *
 * Elle est regroupée dans un objet injecté dans le speaker, et non lue depuis `src/core/config.ts` :
 * la frontière de P009 impose que `src/speaker/**` ne dépende du noyau que par ses **types**. Le
 * speaker reçoit donc ses règles de discipline de parole sous forme de données, exactement comme il
 * reçoit ses faits — il n'a aucun accès au moteur, à ses constantes de course, ni à son horloge.
 *
 * Les valeurs de `SPEAK` et des cooldowns par type sont recopiées **ici et une seule fois**. Le test
 * `tests/unit/speaker.test.ts` les compare à `GAME_DESIGN.md` §9.3 *via* `src/core/config.ts` : deux
 * copies divergentes font échouer le test, donc la duplication est vérifiée, pas silencieuse.
 */

/** Cooldown par type de fait, en secondes simulées, depuis la dernière réplique **réellement démarrée**. */
export type TypeCooldowns = Readonly<Record<RaceFactType, number>>;

/**
 * Cooldowns de §9.3. `FINISH` et `PHOTO_FINISH` valent `0` : un fait d'arrivée n'est jamais empêché
 * par son propre type, et `PHOTO_FINISH` (qui **remplace** `FINISH` dans P009-A) n'a aucun cooldown
 * artificiel susceptible de bloquer la réplique finale.
 */
export const SPEAKER_TYPE_COOLDOWN_S: TypeCooldowns = Object.freeze({
  LEADER_CHANGE: 12,
  BIG_COMEBACK: 15,
  OVERTAKE_STREAK: 12,
  BIG_BONUS: 8,
  LEADER_MALUS: 10,
  CLOSE_RACE: 25,
  LAST_COMEBACK: 20,
  CHECKPOINT_SPLIT: 5,
  FINISH: 0,
  PHOTO_FINISH: 0,
});

/** Politique complète du speaker : tout ce dont il a besoin pour décider, et rien de plus. */
export interface SpeakerPolicy {
  /** Sous cette importance, un fait est rejeté **avant** mise en file. */
  readonly minImportance: number;
  /** Silence minimum entre deux prises de parole. */
  readonly globalCooldownS: number;
  /** À partir de cette importance, un fait peut court-circuiter le **cooldown global** uniquement. */
  readonly preemptImportance: number;
  /** Une réplique en cours est coupée si `newImp ≥ currentImp + interruptDelta`. */
  readonly interruptDelta: number;
  /** Nombre maximal de candidats en attente. */
  readonly queueMax: number;
  /** Quota dur de répliques démarrées par segment. */
  readonly maxLinesPerSegment: number;
  /** Durée **simulée** d'un segment, en secondes : découpe le quota (aucun segment accidentel). */
  readonly segmentDurationS: number;
  /** Nombre de segments de la course : borne supérieure de l'index de segment. */
  readonly segmentCount: number;
  /** Moyenne minimale d'écart entre prises de parole sur la fenêtre glissante. */
  readonly minWindowAvgS: number;
  /** Largeur de la fenêtre glissante de densité, en secondes. */
  readonly windowS: number;
  /**
   * Âge maximal, en secondes **simulées**, d'un fait en attente avant d'être jeté.
   *
   * Sans cette borne, un candidat bloqué par son cooldown de type pouvait rester en file jusqu'à la
   * fin de la course et être prononcé une trentaine de secondes plus tard : la réplique décrivait
   * alors une position qui n'était plus vraie (passe corrective 2, seed `KR7Z8NAR`). Un fait qui a
   * attendu plus longtemps que cette durée n'est **jamais** prononcé.
   */
  readonly factMaxAgeS: number;
  /**
   * Âge maximal, en secondes **simulées**, d'un fait qui **revendique une position** (voir
   * `claims.ts`).
   *
   * Il vaut **zéro**, et c'est le cœur du correctif de la passe corrective 2 : une position ne se
   * commente qu'**à l'instant où elle est mesurée**. Une place au classement change en quelques
   * dixièmes de seconde, donc toute attente — même d'une seconde — peut transformer « voilà le 1er »
   * en mensonge. Mesure sur 200 seeds (course réelle, cadence d'affichage comprise, classement
   * vérifié pas à pas) :
   *
   * | borne | répliques / course | revendications de position | fausses |
   * | ----- | ------------------ | -------------------------- | ------- |
   * | 0 s   | 7,54               | 585                        | **0**   |
   * | 1 s   | 7,66               | 700                        | 17      |
   * | 3 s   | 7,89               | 822                        | 62      |
   * | 12 s  | 8,29               | 1029                       | 301     |
   *
   * À zéro, la revendication est prononcée au pas même de la mesure : sa preuve est donc valable par
   * construction, et non « statistiquement ». Le coût est de 9 % de répliques, et il porte
   * exactement sur les annonces qui auraient été fausses ou périmées.
   */
  readonly rankFactMaxAgeS: number;
  /** Durée pendant laquelle un fait identique à un fait déjà **prononcé** est supprimé. */
  readonly dedupWindowS: number;
  /** Pas de quantification des magnitudes : nombre de tranches par unité. */
  readonly magnitudeBucketResolution: number;
  readonly typeCooldownS: TypeCooldowns;
  /** Secondes par pas : **seule** conversion temps → pas autorisée dans le speaker. */
  readonly dtS: number;
}

/** Politique V1, conforme à `GAME_DESIGN.md` §9.3. */
export const SPEAKER_POLICY: SpeakerPolicy = Object.freeze({
  minImportance: 45,
  globalCooldownS: 6.0,
  preemptImportance: 85,
  interruptDelta: 20,
  queueMax: 3,
  maxLinesPerSegment: 12,
  segmentDurationS: 20,
  segmentCount: 3,
  minWindowAvgS: 5.0,
  windowS: 30,
  // Recopié de `SPEAK.FACT_MAX_AGE_S` : le speaker n'importe pas le noyau, mais la copie est vérifiée
  // par `tests/unit/speaker.test.ts` contre `src/core/config.ts`.
  factMaxAgeS: 12.0,
  rankFactMaxAgeS: 0.0,
  dedupWindowS: 10,
  magnitudeBucketResolution: 4,
  typeCooldownS: SPEAKER_TYPE_COOLDOWN_S,
  // `RACE_CONFIG.DT_S` recopié : le speaker n'importe pas le noyau, il ne convertit que des
  // secondes en pas pour ses fenêtres glissantes (arithmétique entière, comme l'observateur).
  dtS: 1 / 60,
});

/** Secondes → pas entiers, avec la même convention d'arrondi que l'observateur de faits. */
export function stepsForSeconds(policy: SpeakerPolicy, seconds: number): number {
  return Math.round(seconds / policy.dtS);
}