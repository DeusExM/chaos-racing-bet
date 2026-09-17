import type { CharacterId } from '../core/types';
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
}

export type { HudDebugSnapshot };
export type { SubtitleLineView };

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
