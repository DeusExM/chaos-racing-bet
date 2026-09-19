import { CHARACTERS } from '../core/characters';
import { RACE_CONFIG } from '../core/config';
import type { ActiveEvent, CharacterState, RaceState } from '../core/types';

/**
 * Historique compact d'une course, pour **revoir** ce qui vient de se passer.
 *
 * ## Pourquoi il vit dans `sim/`
 *
 * L'historique est produit par la seule couche qui exécute les pas (`RaceSimulation`) : il enregistre
 * ce que le noyau a réellement calculé, au moment où il le calcule. Il ne calcule rien lui-même, ne
 * tire aucun nombre aléatoire et ne touche à aucun état de course : c'est un **enregistreur**, pas un
 * second moteur. Le rendu le lit ensuite, en lecture seule.
 *
 * ## Ce qui est enregistré, et rien de plus
 *
 * Le rendu a besoin de très peu de choses pour redessiner un instant passé :
 *
 * | donnée | forme | taille |
 * |---|---|---|
 * | distance des partants, à chaque pas | `Float64Array` de `3601 × N` (`172,8 Ko` à six) |
 * | événements rares, par **intervalles** de pas | tableau de fiches (une par occurrence) | quelques centaines d'octets |
 *
 * Tout le reste se **déduit** de l'index de pas : `tSim = steps × DT_S`, le segment vient de
 * `core/track.ts`, le classement se recalcule à partir des distances enregistrées (une seule source
 * de classement, `ranking.ts`). Aucun sprite, aucun élément DOM, aucun objet Phaser n'est conservé :
 * un historique de 3601 instants tient donc dans moins de 200 Ko, et il est **alloué une fois** à la
 * construction, jamais par pas.
 *
 * Les événements rares sont stockés sous forme d'**intervalles** plutôt que d'un tableau par pas :
 * une occurrence par personnage est une suite contiguë de pas, et il n'y en a qu'une poignée par
 * course. Un tableau par pas coûterait 43 Ko de plus pour la même information.
 *
 * ## Ce que l'historique ne fait jamais
 *
 * Il ne rembobine pas le noyau : consulter un instant passé ne réexécute aucun pas, ne rejoue aucun
 * tirage et ne modifie ni `x`, ni `v`, ni le classement, ni les faits déjà produits. C'est ce qui
 * garantit qu'une course consultée puis reprise se termine **exactement** comme une course qui n'a
 * jamais été mise en pause.
 */

/** Instant passé restituable au rendu : distances et événements actifs, rien d'autre. */
export interface ReplayFrame {
  /** Nombre de pas de l'instant consulté. */
  readonly steps: number;
  /** Instant simulé correspondant, en secondes. */
  readonly tSim: number;
  /** Distance de chaque personnage, dans l'ordre du roster. */
  readonly distances: readonly number[];
  /** Événement rare actif sur chaque personnage à cet instant (`null` si aucun). */
  readonly events: readonly (ActiveEvent | null)[];
}

/** Une occurrence d'événement rare, sous forme d'intervalle de pas `[startStep, endStep[`. */
interface EventInterval {
  readonly characterIndex: number;
  readonly event: ActiveEvent;
  readonly startStep: number;
  /** Premier pas **après** la fin de l'événement. */
  endStep: number;
}

/**
 * Estimation documentée du coût d'une fiche d'intervalle en mémoire (objet JS de 4 champs, dont une
 * fiche d'événement de 5 champs). Elle sert au test de taille, jamais au rendu.
 */
const EVENT_INTERVAL_BYTES = 200;

/** Nombre maximal d'intervalles conservés : garde-fou, jamais atteint par une course réelle. */
export const MAX_EVENT_INTERVALS = 256;

export class ReplayHistory {
  /** Nombre d'instants enregistrables : le pas `0` **et** les `TOTAL_STEPS` pas de la course. */
  static readonly CAPACITY = RACE_CONFIG.TOTAL_STEPS + 1;

  /** Distances de tous les personnages, pas par pas, en `Float64Array` (valeur exacte du noyau). */
  private readonly distanceValues: Float64Array;

  /** Occurrences d'événements, dans l'ordre d'apparition. */
  private readonly intervals: EventInterval[] = [];

  /** Index de l'intervalle ouvert par personnage, ou `null` : détecte début et fin sans table par pas. */
  private readonly openIntervals: (number | null)[];

  /**
   * Nombre de partants enregistrés.
   *
   * Il est **fixé à la construction** : l'historique appartient à une course, et une course ne change
   * pas d'effectif. Un changement de nombre de coureurs reconstruit donc l'historique (voir
   * `RaceSimulation`), plutôt que de le redimensionner en place.
   */
  private readonly participants: number;

  /** Nombre d'instants déjà enregistrés : `recordedSteps` vaut aussi le prochain pas attendu. */
  private recordedSteps = 0;

  constructor(participants: number = CHARACTERS.length) {
    if (!Number.isInteger(participants) || participants < 1) {
      throw new RangeError(`Nombre de partants invalide pour l'historique : ${participants}.`);
    }
    this.participants = participants;
    this.distanceValues = new Float64Array(ReplayHistory.CAPACITY * participants);
    this.openIntervals = new Array<number | null>(participants).fill(null);
  }

  /** Nombre de partants couverts par l'historique. */
  get participantCount(): number {
    return this.participants;
  }

  /** Nombre d'instants que l'historique peut contenir. */
  get capacity(): number {
    return ReplayHistory.CAPACITY;
  }

  /** Nombre d'instants réellement enregistrés depuis le dernier `reset()`. */
  get recorded(): number {
    return this.recordedSteps;
  }

  /** Dernier pas enregistré, ou `null` si l'historique est vide. */
  get lastStep(): number | null {
    return this.recordedSteps === 0 ? null : this.recordedSteps - 1;
  }

  /** Nombre d'occurrences d'événements conservées. */
  get eventCount(): number {
    return this.intervals.length;
  }

  /**
   * Taille occupée, en octets, tableaux typés **et** fiches d'événements.
   *
   * C'est la mesure qui garantit qu'un historique complet reste petit : elle est vérifiée par un test
   * unitaire, et non supposée.
   */
  get byteLength(): number {
    return this.distanceValues.byteLength + this.intervals.length * EVENT_INTERVAL_BYTES;
  }

  /**
   * Enregistre un instant. Doit être appelé **une fois par pas**, dans l'ordre, en commençant par le
   * pas `0` — l'ordre est vérifié : un enregistrement manquant ou rejoué est une erreur de câblage,
   * pas une situation à rattraper silencieusement.
   */
  record(state: Readonly<RaceState>): void {
    const step = state.steps;
    if (step !== this.recordedSteps) {
      throw new RangeError(
        `ReplayHistory attend le pas ${String(this.recordedSteps)} (reçu : ${String(step)}).`,
      );
    }
    if (step >= ReplayHistory.CAPACITY) {
      throw new RangeError(
        `ReplayHistory ne peut pas enregistrer le pas ${String(step)} (capacité ${String(ReplayHistory.CAPACITY)}).`,
      );
    }

    const base = step * this.participants;
    for (let index = 0; index < state.characters.length; index += 1) {
      this.distanceValues[base + index] = state.characters[index]?.x ?? 0;
      this.trackEvent(index, state.characters[index] ?? null, step);
    }

    this.recordedSteps = step + 1;
  }

  /** Oublie tout : appelé au redémarrage d'une course, pour ne jamais mélanger deux courses. */
  reset(): void {
    this.recordedSteps = 0;
    this.intervals.length = 0;
    this.openIntervals.fill(null);
  }

  /**
   * Instant passé, ou `null` si ce pas n'a pas été enregistré.
   *
   * Un pas hors de `[0, recorded − 1]` est refusé : le rendu ne peut donc pas afficher un instant qui
   * n'a jamais existé. Aucune extrapolation, aucune interpolation : c'est une lecture.
   */
  frameAt(step: number): ReplayFrame | null {
    if (!Number.isInteger(step) || step < 0 || step >= this.recordedSteps) {
      return null;
    }

    const base = step * this.participants;
    const distances: number[] = [];
    for (let index = 0; index < this.participants; index += 1) {
      distances.push(this.distanceValues[base + index] ?? 0);
    }

    const events: (ActiveEvent | null)[] = new Array<ActiveEvent | null>(this.participants).fill(null);
    for (const interval of this.intervals) {
      if (interval.startStep <= step && step < interval.endStep) {
        events[interval.characterIndex] = interval.event;
      }
    }

    return {
      steps: step,
      tSim: step * RACE_CONFIG.DT_S,
      distances,
      events,
    };
  }

  /**
   * Ouvre, ferme ou laisse courir l'intervalle d'événement d'un personnage.
   *
   * La comparaison porte sur la **fiche** de l'événement (`id` et `startSimS`) : deux occurrences
   * successives du même événement restent donc deux intervalles distincts, exactement comme le badge
   * du rendu les distingue.
   */
  private trackEvent(index: number, character: CharacterState | null, step: number): void {
    const active = character?.activeEvent ?? null;
    const openIndex = this.openIntervals[index] ?? null;
    const open = openIndex === null ? null : (this.intervals[openIndex] ?? null);

    if (open !== null && active !== null && sameEvent(open.event, active)) {
      return;
    }

    if (openIndex !== null && open !== null) {
      this.intervals[openIndex] = { ...open, endStep: step };
      this.openIntervals[index] = null;
    }

    if (active === null) {
      return;
    }

    if (this.intervals.length >= MAX_EVENT_INTERVALS) {
      // Garde-fou : une course réelle en compte quelques-unes. Au-delà, on cesse d'enregistrer plutôt
      // que de faire croître la mémoire sans borne — et le rendu n'affiche simplement plus ce badge.
      return;
    }

    this.intervals.push({
      characterIndex: index,
      event: { ...active },
      startStep: step,
      endStep: ReplayHistory.CAPACITY,
    });
    this.openIntervals[index] = this.intervals.length - 1;
  }
}

/** Deux fiches désignent-elles la même occurrence ? L'identité est `id` + instant de départ. */
function sameEvent(left: ActiveEvent, right: ActiveEvent): boolean {
  return left.id === right.id && left.startSimS === right.startSimS;
}
