import { CHARACTER_IDS } from '../core/characters';
import { RACE_CONFIG, SPEED } from '../core/config';

/**
 * Constantes de **présentation**.
 *
 * Aucune de ces valeurs n'est une règle de jeu : elles ne sont lues ni par `src/core/`, ni par
 * `src/sim/`, et les modifier ne peut pas changer le résultat d'une course. `GAME_DESIGN.md` §5
 * décrit ce que le rendu a le droit de faire.
 */
export interface ViewConfig {
  /** Largeur logique du canvas. */
  readonly BASE_WIDTH: number;
  /** Hauteur logique du canvas. */
  readonly BASE_HEIGHT: number;
  /**
   * Longueur qu'aurait la piste si tout le monde courait exactement à `SPEED.BASE`.
   *
   * Sert **uniquement** au décor et à l'échelle. Ce n'est **pas** une ligne d'arrivée : un
   * personnage peut la dépasser ou ne jamais l'atteindre, sans que cela change quoi que ce soit.
   */
  readonly NOMINAL_SCALE_M: number;
  /** Largeur minimale de la fenêtre de caméra, en mètres. */
  readonly CAMERA_WINDOW_MIN_M: number;
  /** Largeur maximale de la fenêtre de caméra, en mètres (`GAME_DESIGN.md` §5). */
  readonly CAMERA_WINDOW_MAX_M: number;
  /** Facteur appliqué à l'écart entre le premier et le dernier pour choisir la fenêtre. */
  readonly CAMERA_SPREAD_FACTOR: number;
  /** Marge ajoutée à l'écart, en mètres, pour que personne ne colle aux bords. */
  readonly CAMERA_SPREAD_MARGIN_M: number;
  /** Lissage de la caméra : `1` = aucune inertie, `0` = figée. */
  readonly CAMERA_SMOOTHING: number;
  /** Position verticale de la première voie, en fraction de la hauteur. */
  readonly LANE_TOP_RATIO: number;
  /** Position verticale de la dernière voie, en fraction de la hauteur. */
  readonly LANE_BOTTOM_RATIO: number;
  /** Taille d'un personnage, en pixels. */
  readonly CHARACTER_SIZE_PX: number;
  /** Espacement des repères de distance du décor, en mètres. */
  readonly TRACK_TICK_STEP_M: number;
  /** Espacement des repères de distance **chiffrés**, en mètres. */
  readonly TRACK_LABEL_STEP_M: number;
  /** Nombre de libellés réutilisés par le décor (le pool n'est jamais agrandi en cours de course). */
  readonly TRACK_LABEL_POOL: number;
  /** Marge, en pixels, avant qu'un personnage soit signalé comme hors fenêtre. */
  readonly EDGE_MARGIN_PX: number;
  /**
   * Taille de la police du commentaire, en pixels de la scène (le canvas est mis à l'échelle).
   *
   * Le bandeau est **dessiné dans le canvas**, donc solidaire de l'arène : il ne peut pas se
   * désynchroniser du décor. Sa lisibilité aux petites tailles vient de cette taille de police, pas
   * d'une mise en page HTML séparée.
   */
  readonly SUBTITLE_FONT_PX: number;
  /** Taille de police du nom du personnage mis en avant, en pixels de la scène. */
  readonly SUBTITLE_NAME_FONT_PX: number;
  /** Taille de police de l'indicateur de file d'attente, en pixels de la scène. */
  readonly SUBTITLE_QUEUE_FONT_PX: number;
  /** Marge intérieure du bandeau, en pixels de la scène. */
  readonly SUBTITLE_PADDING_PX: number;
  /** Largeur maximale du bandeau, en fraction de la largeur de la scène. */
  readonly SUBTITLE_MAX_WIDTH_RATIO: number;
  /** Distance entre le haut de la scène et le haut du bandeau, en pixels de la scène. */
  readonly SUBTITLE_TOP_OFFSET_PX: number;
  /** Espace vertical entre le nom mis en avant et la réplique, en pixels de la scène. */
  readonly SUBTITLE_NAME_GAP_PX: number;
  /** Durée d'affichage minimale d'une réplique, en millisecondes de temps **réel**. */
  readonly SUBTITLE_MIN_MS: number;
  /** Durée d'affichage ajoutée par caractère de la réplique, en millisecondes. */
  readonly SUBTITLE_PER_CHAR_MS: number;
  /** Durée d'affichage maximale d'une réplique, en millisecondes. */
  readonly SUBTITLE_MAX_MS: number;
  /** Durée d'apparition du bandeau, en millisecondes réelles. */
  readonly SUBTITLE_FADE_IN_MS: number;
  /** Durée de disparition du bandeau, en millisecondes réelles. */
  readonly SUBTITLE_FADE_OUT_MS: number;
}

/** Constante d'implémentation : `2160 = 12 × 180`, calculée pour ne pas être recopiée à la main. */
const NOMINAL_SCALE_M = SPEED.BASE * RACE_CONFIG.TOTAL_SIM_S;

export const VIEW: ViewConfig = Object.freeze({
  BASE_WIDTH: 1280,
  BASE_HEIGHT: 720,
  NOMINAL_SCALE_M,
  CAMERA_WINDOW_MIN_M: 100,
  CAMERA_WINDOW_MAX_M: 260,
  CAMERA_SPREAD_FACTOR: 1.35,
  CAMERA_SPREAD_MARGIN_M: 30,
  CAMERA_SMOOTHING: 0.15,
  LANE_TOP_RATIO: 0.24,
  LANE_BOTTOM_RATIO: 0.86,
  CHARACTER_SIZE_PX: 44,
  TRACK_TICK_STEP_M: 50,
  TRACK_LABEL_STEP_M: 250,
  TRACK_LABEL_POOL: 4,
  EDGE_MARGIN_PX: 22,
  SUBTITLE_FONT_PX: 24,
  SUBTITLE_NAME_FONT_PX: 22,
  SUBTITLE_QUEUE_FONT_PX: 15,
  SUBTITLE_PADDING_PX: 12,
  SUBTITLE_MAX_WIDTH_RATIO: 0.5,
  SUBTITLE_TOP_OFFSET_PX: 52,
  SUBTITLE_NAME_GAP_PX: 6,
  SUBTITLE_MIN_MS: 2000,
  SUBTITLE_PER_CHAR_MS: 45,
  SUBTITLE_MAX_MS: 5200,
  SUBTITLE_FADE_IN_MS: 160,
  SUBTITLE_FADE_OUT_MS: 220,
});

/** Ordonnée écran d'une voie, répartie uniformément entre les deux ratios du décor. */
export function laneY(index: number, heightPx: number): number {
  const top = heightPx * VIEW.LANE_TOP_RATIO;
  const bottom = heightPx * VIEW.LANE_BOTTOM_RATIO;
  const span = CHARACTER_IDS.length - 1;
  return span === 0 ? top : top + ((bottom - top) * index) / span;
}
