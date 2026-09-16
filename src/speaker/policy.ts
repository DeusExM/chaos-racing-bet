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
  segmentDurationS: 45,
  segmentCount: 4,
  minWindowAvgS: 5.0,
  windowS: 30,
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