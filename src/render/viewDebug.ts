import type { CharacterId } from '../core/types';
import type { FinishDebugSnapshot } from './view/FinishPanel';
import type { HudDebugSnapshot } from './view/Hud';
import type { SubtitleLineView } from './view/subtitleModel';

/**
 * Debug du **rendu** : `window.__CHAOS_RACE_VIEW__`.
 *
 * Rien de ce qui est dessiné dans un canvas n'est interrogeable depuis le DOM. Sans cette surface,
 * il serait impossible de vérifier qu'un sprite suit réellement la distance du noyau, ni que les
 * positions écran restent dans l'ordre du classement — c'est-à-dire exactement ce qu'un test
 * visuel doit prouver.
 *
 * Elle est **en lecture seule** : elle ne renvoie que des positions déjà dessinées et un cadrage,
 * et n'expose aucun moyen d'écrire dans quoi que ce soit.
 */

export interface SpriteView {
  readonly id: CharacterId;
  readonly screenX: number;
  readonly screenY: number;
  /** Taille réellement dessinée, en pixels logiques du canvas. */
  readonly size: number;
  /**
   * Vrai si le personnage est réellement dessiné dans cette frame.
   *
   * Un personnage sorti du champ de la caméra est masqué — son marqueur de bord le représente — pour
   * qu'aucun sprite ne soit dessiné sous la bande réservée au classement (passe corrective 2).
   */
  readonly drawn: boolean;
}

export type { HudDebugSnapshot };
export type { SubtitleLineView };
export type { FinishDebugSnapshot };

export interface CameraView {
  /** Bord gauche de la fenêtre, en mètres. */
  readonly leftM: number;
  /** Largeur de la fenêtre, en mètres. */
  readonly windowM: number;
}

export interface ChaosRaceViewDebugApi {
  sprites(): readonly SpriteView[];
  camera(): CameraView;
  /**
   * Texte réellement dessiné dans le bandeau de commentaire, `''` quand il est masqué.
   *
   * Sans cette lecture, un test ne pourrait prouver qu'une réplique a **vraiment** été affichée :
   * un canvas n'est pas interrogeable depuis le DOM.
   */
  subtitle(): string;
  /**
   * Réplique réellement affichée, **avec le fait mesuré qui l'a produite** (P012).
   *
   * C'est cette lecture qui rend vérifiable la DoD « le texte correspond à un fait réel » : un test
   * peut recalculer le texte attendu à partir du fait et de sa variante, au lieu de constater qu'un
   * texte quelconque est apparu. `null` quand aucune réplique n'est affichée.
   */
  subtitleLine(): SubtitleLineView | null;
  /**
   * Modèle réellement affiché par le HUD à la dernière frame.
   *
   * C'est la lecture qui rend vérifiable la DoD du HUD : un test compare ce que le HUD a affiché —
   * ordre du classement, écarts, positions des marqueurs — à l'état du noyau lu **dans la même
   * frame**. Il ne s'agit pas d'une seconde source de vérité : c'est le modèle de la frame affichée,
   * et `null` tant qu'aucune frame n'a été affichée.
   */
  hud(): HudDebugSnapshot | null;
  /**
   * Chemin de copie de la seed, avec son résultat réel.
   *
   * Il existe pour qu'un test puisse exercer la **dégradation** : quand l'API Clipboard est absente
   * ou refusée, la copie doit retomber sur la sélection et ne jamais prétendre avoir réussi. Le
   * hook ne modifie rien — il appelle exactement l'action du bouton.
   */
  hudCopy(): Promise<boolean>;
  /** Vrai tant que la confirmation de copie est affichée. */
  hudCopyConfirmed(): boolean;
  /**
   * Distances **de rendu** réellement utilisées pour placer les sprites.
   *
   * En course, ce sont exactement les distances du noyau. Après l'arrivée, le rendu leur ajoute une
   * courte inertie purement visuelle (`finishModel.ts`) : ce hook permet donc de prouver que
   * l'animation continue **sans** qu'un seul pas de simulation soit exécuté, et que le noyau, lui,
   * ne bouge plus.
   */
  visualDistances(): readonly number[];
  /**
   * Écran d'arrivée réellement affiché (P013), `null` tant que la course n'est pas terminée.
   *
   * Il expose le classement final **tel qu'il est présenté** — ordre, distances, écarts, mention de
   * photo finish — pour qu'un test puisse le comparer au classement du noyau lu au même instant, et
   * vérifier que les deux ne peuvent pas diverger.
   */
  finish(): FinishDebugSnapshot | null;
  /**
   * Badges de retour d'événement réellement affichés (passe corrective).
   *
   * Chaque entrée porte le personnage **et l'occurrence d'événement** (`type@départ`) qui l'a
   * produite : un test peut donc vérifier qu'un badge correspond à un événement du noyau, et qu'il
   * disparaît quand cet événement se termine — sans jamais avoir à croire une animation sur parole.
   */
  eventFeedback(): readonly EventFeedbackDebugSnapshot[];
  /**
   * Géométrie de la **piste** et de la bande réservée au classement, en pixels logiques du canvas.
   *
   * C'est la lecture qui rend vérifiable la séparation des zones (passe corrective 2) : un test E2E
   * compare le rectangle du classement, converti en pixels logiques, à cette bande — et peut donc
   * prouver qu'aucun personnage n'est dessiné dessous, au lieu de constater une capture d'écran.
   */
  track(): TrackViewportDebugSnapshot;
  /**
   * Relecture en cours (passe corrective 2), ou `null` hors pause manuelle.
   *
   * Elle expose l'instant consulté **et** l'instant réel de la pause, tous deux en pas du noyau :
   * un test peut donc vérifier que le curseur est borné, que l'affichage suit le curseur, et que la
   * reprise repart de l'instant réel.
   */
  replay(): ReplayDebugSnapshot | null;
}

/** Occurrence d'événement affichée par la couche de retour visuel. */
export interface EventFeedbackDebugSnapshot {
  readonly id: CharacterId;
  readonly occurrence: string;
}

/** Zones de l'arène : piste utilisable et bande réservée au classement, en pixels logiques. */
export interface TrackViewportDebugSnapshot {
  /** Largeur de l'arène, en pixels logiques : `VIEW.BASE_WIDTH`. */
  readonly arenaWidth: number;
  /** Hauteur de l'arène, en pixels logiques : `VIEW.BASE_HEIGHT`. */
  readonly arenaHeight: number;
  /** Largeur de la piste, en pixels logiques : l'arène moins la bande réservée. */
  readonly trackWidth: number;
  /** Vrai quand l'interface est en mode téléphone paysage (classement masqué pendant la course). */
  readonly compact: boolean;
}

/** Relecture en cours : instants consulté et réel, en pas de simulation. */
export interface ReplayDebugSnapshot {
  readonly viewedStep: number;
  readonly pauseStep: number;
  readonly visible: boolean;
}

declare global {
  interface Window {
    __CHAOS_RACE_VIEW__?: ChaosRaceViewDebugApi;
  }
}

/** Installe la surface de debug du rendu. */
export function installViewDebug(api: ChaosRaceViewDebugApi): void {
  window.__CHAOS_RACE_VIEW__ = api;
}
