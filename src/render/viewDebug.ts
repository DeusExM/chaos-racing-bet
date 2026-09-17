import type { CharacterId } from '../core/types';

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
