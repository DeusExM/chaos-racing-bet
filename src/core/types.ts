/**
 * Vocabulaire partagé du noyau.
 *
 * Ce module ne contient **aucun code exécutable** et n'importe rien : il décrit la forme de l'état
 * de la course, pas son comportement. Toutes les durées qui y figurent sont du **temps simulé**
 * (secondes) ; les durées réelles (compte à rebours, durée d'une pause, accélération du mode test)
 * vivent dans `SIM_CONFIG`, côté `src/sim/`, et n'atteignent jamais le noyau.
 */

/**
 * Identifiant stable d'un personnage.
 *
 * La V1 compte exactement 6 personnages. Cet index est le départage déterministe des égalités de
 * distance et l'ordre d'itération de la physique : il ne change jamais, même quand les noms
 * définitifs seront choisis (P014). `characters.ts` est la source de vérité **côté données** ; un
 * test vérifie que le roster correspond exactement à cette liste.
 */
export type CharacterId = 'c0' | 'c1' | 'c2' | 'c3' | 'c4' | 'c5';

/**
 * Phase de la course, du point de vue du noyau.
 *
 * Le noyau ne connaît que trois situations : pas encore partie, en cours (avec le segment courant),
 * terminée. Il n'existe **volontairement aucun** état de pause ni de compte à rebours ici : une
 * pause réelle consiste simplement, pour `RaceSimulation`, à ne plus appeler le moteur, si bien que
 * `tSim`, `x` et `v` sont strictement gelés sans que le noyau ait à le savoir.
 */
export type RacePhase =
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'running';
      /** Index du segment courant, de 0 à `RACE_CONFIG.SEGMENT_COUNT - 1`. */
      readonly segment: number;
      /** Temps simulé écoulé depuis le début du segment courant, en secondes. */
      readonly segmentElapsedS: number;
    }
  | { readonly kind: 'finished' };

/**
 * État d'un personnage à un instant donné.
 *
 * Aucun champ `rank` : le classement n'est **jamais** stocké, il est recalculé à partir des seules
 * distances par `ranking.ts`. Aucun champ de caractéristique permanente non plus : les 6
 * personnages partagent la même configuration, leurs écarts ne viennent que du hasard.
 */
export interface CharacterState {
  readonly id: CharacterId;
  /** Distance parcourue depuis le départ, en mètres. Seule source du classement. */
  readonly x: number;
  /** Vitesse instantanée, en m/s. */
  readonly v: number;
  /** Dérive permanente courante (processus d'Ornstein–Uhlenbeck), sans unité. */
  readonly drift: number;
  /** Surge courant, sans unité. Vaut `0` quand aucun surge n'est actif. */
  readonly surge: number;
  /** Modulation d'événement courante, sans unité. Vaut `0` quand aucun événement n'est actif. */
  readonly event: number;
}

/** État complet du noyau à un instant donné. */
export interface RaceState {
  readonly phase: RacePhase;
  /** Temps simulé écoulé depuis le départ, en secondes. */
  readonly tSim: number;
  /** Les personnages, dans l'ordre du roster : cet ordre est l'ordre d'itération de la physique. */
  readonly characters: readonly CharacterState[];
}

/** Un événement rare en cours d'application. */
export interface ActiveEvent {
  /**
   * Type d'événement. Le catalogue normatif — et donc la liste fermée des valeurs possibles — est
   * livré avec le planificateur, dans `src/core/events.ts` ; le noyau ne peut pas encore le citer.
   */
  readonly id: string;
  readonly target: CharacterId;
  /** Instant simulé du déclenchement, en secondes. */
  readonly startSimS: number;
  /** Durée **simulée** de l'événement, en secondes. */
  readonly durationS: number;
  /** Magnitude relative appliquée à la vitesse cible du personnage. */
  readonly magnitude: number;
}

/** Les 10 faits commentables de la V1. */
export type RaceFactType =
  | 'LEADER_CHANGE'
  | 'BIG_COMEBACK'
  | 'OVERTAKE_STREAK'
  | 'BIG_BONUS'
  | 'LEADER_MALUS'
  | 'CLOSE_RACE'
  | 'LAST_COMEBACK'
  | 'CHECKPOINT_SPLIT'
  | 'FINISH'
  | 'PHOTO_FINISH';

/**
 * Fait mesuré pendant la course — **seule** entrée autorisée du speaker.
 *
 * Un fait n'existe que si la variation d'état correspondante a réellement eu lieu : c'est ce qui
 * garantit que le speaker ne peut rien inventer. Les `magnitudes` sont les valeurs réellement
 * mesurées, jamais des valeurs de décoration.
 */
export interface RaceFact {
  readonly type: RaceFactType;
  /** Instant simulé de l'observation, en secondes. */
  readonly tSim: number;
  readonly characterIds: readonly CharacterId[];
  readonly magnitudes: readonly number[];
  /** Importance de 0 à 100 : sous `SPEAK.MIN_IMPORTANCE`, le fait n'est pas commenté. */
  readonly importance: number;
  /** Clé de texte à résoudre dans `src/app/strings.fr.ts` : aucun texte en dur dans le noyau. */
  readonly textKey: string;
}

/** Résultat final d'une course, figé à `RACE_CONFIG.TOTAL_SIM_S`. */
export interface RaceResult {
  /** Temps simulé atteint en fin de course : toujours `RACE_CONFIG.TOTAL_SIM_S`. */
  readonly tSim: number;
  /** Classement final, du 1er au dernier. Dérivé des seules distances. */
  readonly ranking: readonly CharacterId[];
  /** Distance parcourue par chaque personnage, alignée sur l'ordre du roster. */
  readonly distances: readonly number[];
}
