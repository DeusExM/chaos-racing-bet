/**
 * Vocabulaire partagé du noyau.
 *
 * Ce module ne contient **aucun code exécutable** et n'importe rien : il décrit la forme de l'état
 * de la course, pas son comportement. Toutes les durées qui y figurent sont du **temps simulé**
 * (secondes) ; les durées réelles (compte à rebours, durée d'une pause, accélération du mode test)
 * vivent dans `SimConfig`, côté `src/sim/`, et n'atteignent jamais le noyau.
 *
 * La forme exacte de `RacePhase`, `CharacterState` et `RaceState` est un **contrat** : elle est fixée
 * par `ROADMAP.md` §A.4, et `tests/unit/types.test.ts` refuse toute divergence silencieuse.
 * Ici, seuls les champs qui ne doivent jamais être réaffectés sont `readonly` ; `x`, `v`, `tSim` et
 * `steps` sont au contraire faits pour être avancés pas à pas par le moteur.
 */

/**
 * Identifiant stable d'un personnage.
 *
 * Le **roster** de la V1 compte exactement 6 personnages, mais une course peut n'en aligner que 3, 4
 * ou 5 (`core/participants.ts`) : l'effectif d'une course est donc distinct du roster, et cet index
 * reste l'ordre **canonique** du roster — c'est lui qui départage les égalités de distance et qui
 * fixe l'ordre d'itération de la physique, même quand un personnage ne court pas. Il ne change jamais,
 * même quand les noms définitifs seront choisis (P014). `characters.ts` est la source de vérité
 * **côté données** ; un test vérifie que le roster correspond exactement à cette liste.
 */
export type CharacterId = 'c0' | 'c1' | 'c2' | 'c3' | 'c4' | 'c5';

/**
 * Phase de la course, du point de vue du noyau.
 *
 * Le noyau ne connaît que trois situations : pas encore partie, en cours (avec le segment courant),
 * terminée. Il n'existe **volontairement aucun** état de pause ni de compte à rebours ici : une
 * pause réelle consiste simplement, pour `RaceSimulation`, à ne plus appeler le moteur, si bien que
 * `tSim`, `x` et `v` sont strictement gelés sans que le noyau ait à le savoir.
 *
 * Le type de l'état temps réel — `idle` / `countdown` / `running` / `checkpointPause` /
 * `userPaused` / `finished` — vit dans `src/sim/` et n'a **rien** à voir avec cette union-ci.
 */
export type RacePhase =
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'running';
      /**
       * Numéro **humain** du segment courant, de `1` à `SEGMENT_COUNT` — et non un index.
       *
       * Attention à ne pas confondre avec `track.segmentIndexAt(tSim)`, qui reste fondé sur zéro
       * (`0..2`). Le moteur passe de l'un à l'autre par `segmentIndexAt(tSim) + 1`.
       */
      readonly segment: 1 | 2 | 3;
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
  x: number;
  /** Vitesse instantanée, en m/s. */
  v: number;
  /** Dérive permanente courante (processus d'Ornstein–Uhlenbeck), sans unité. */
  drift: number;
  /** Surge courant, sans unité. Vaut `0` quand aucun surge n'est actif. */
  surge: number;
  /**
   * Modulation de vitesse apportée par l'événement en cours, sans unité. Vaut `0` quand aucun
   * événement n'est actif. Champ distinct de `activeEvent`, qui porte la fiche de l'événement.
   */
  eventBonus: number;
  /** Événement rare en cours sur ce personnage, ou `null`. Un seul à la fois. */
  activeEvent: ActiveEvent | null;
}

/** État complet du noyau à un instant donné. */
export interface RaceState {
  /** Seed **affichée** (8 caractères Base32 Crockford) : la source de vérité du rejeu. */
  readonly seed: string;
  /** Seed interne 32 bits, dérivée de la seed affichée. */
  readonly seedValue: number;
  /** Temps simulé écoulé depuis le départ, en secondes. */
  tSim: number;
  /** Nombre de pas de `DT_S` déjà exécutés. Une course complète en compte `TOTAL_STEPS`. */
  steps: number;
  phase: RacePhase;
  /** Les personnages, dans l'ordre du roster : cet ordre **est** l'ordre des index stables. */
  characters: readonly CharacterState[];
}

/**
 * Les 7 événements rares du catalogue V1 (`GAME_DESIGN.md` §7.1).
 *
 * Seule la **liste fermée** des identifiants vit ici, avec le vocabulaire : le catalogue normatif
 * (poids, magnitudes, durées) est livré par le planificateur, dans `src/core/events.ts`, et un test
 * vérifie que les deux listes coïncident exactement.
 */
export type EventId =
  | 'TURBO'
  | 'CHUTE'
  | 'VENT_DE_FACE'
  | 'RACCOURCI'
  | 'POULET'
  | 'SIESTE'
  | 'MEGA_TURBO';

/** Un événement rare en cours d'application. */
export interface ActiveEvent {
  /** Type d'événement, dans la liste fermée du catalogue. */
  readonly id: EventId;
  /** Personnage qui subit l'événement. */
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
