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
  /**
   * Hauteur affichée d'un personnage, en pixels logiques, pour l'arène de référence (1280×720).
   *
   * C'est la hauteur de l'**image** : les illustrations comportent une marge transparente de 4 à 11 %,
   * donc la silhouette visible mesure 65 à 70 px, pour une cible d'environ 68 px. La largeur n'est
   * jamais une constante : elle se déduit du ratio de la texture, si bien qu'une image n'est jamais
   * écrasée en carré et que la résolution du fichier n'est jamais une taille d'affichage.
   *
   * Les fichiers servis font 320 px de haut (`tools/optimizeCharacterAssets.mjs`) : le rendu les
   * réduit ici, mais garde de la marge pour les écrans à haute densité, où le canvas est agrandi.
   */
  readonly CHARACTER_HEIGHT_PX: number;
  /**
   * Hauteur affichée **minimale** d'un personnage, en pixels logiques.
   *
   * Plancher de lisibilité si la hauteur logique de l'arène changeait un jour : il conserve la même
   * proportion que l'ancien minimum (≈ 40 % de la hauteur nominale) et ne s'applique jamais sur
   * l'arène de référence.
   */
  readonly CHARACTER_MIN_HEIGHT_PX: number;
  /** Espacement des repères de distance du décor, en mètres. */
  readonly TRACK_TICK_STEP_M: number;
  /** Espacement des repères de distance **chiffrés**, en mètres. */
  readonly TRACK_LABEL_STEP_M: number;
  /** Nombre de libellés réutilisés par le décor (le pool n'est jamais agrandi en cours de course). */
  readonly TRACK_LABEL_POOL: number;
  /** Marge, en pixels, avant qu'un personnage soit signalé comme hors fenêtre. */
  readonly EDGE_MARGIN_PX: number;
  /**
   * Largeur de la **piste**, en fraction de la largeur de l'arène (passe corrective 2).
   *
   * La bande restante (`1 − TRACK_WIDTH_RATIO`) est **réservée au classement permanent** : les
   * sprites, la caméra, le décor et les badges d'événement n'y entrent jamais. Le classement ne
   * recouvre donc plus les personnages — ce n'est pas une question de chance ou de résolution, c'est
   * une séparation de zones.
   *
   * La même fraction vit côté CSS (`--hud-sidebar-width`), puisque le classement est du HTML posé
   * sur l'arène : les deux valeurs doivent rester cohérentes, et c'est le test E2E de géométrie
   * (`tests/e2e/hud.spec.ts`) qui le vérifie aux trois résolutions de référence.
   */
  readonly TRACK_WIDTH_RATIO: number;
  /**
   * Hauteur de fenêtre, en pixels CSS, sous laquelle l'interface passe en mode **téléphone paysage**.
   *
   * Elle sert à deux décisions du rendu : masquer le classement permanent pendant la course et rendre
   * toute la largeur à la piste. La même valeur vit dans la requête média de `styles.css`.
   */
  readonly COMPACT_VIEWPORT_MAX_HEIGHT_PX: number;
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
  /**
   * Durée d'affichage minimale d'une réplique, en millisecondes de temps **réel**.
   *
   * Les trois constantes de durée ci-dessous ont été **mesurées** sur le catalogue réel (passe
   * corrective §8) : les 52 répliques françaises font de 46 à 98 caractères, médiane 74. Avec les
   * anciennes valeurs (`2 000 + 45 × n`, plafond `5 200`), **30 répliques sur 52** étaient écrasées
   * au plafond : l'adaptation à la longueur ne servait plus à rien, et les plus longues s'affichaient
   * à ≈ 19 caractères par seconde, au-dessus de la vitesse de lecture confortable.
   *
   * Les valeurs retenues (`800 + 60 × n`, plafond `5 800`) donnent 3,56 s pour la plus courte,
   * 5,24 s pour la médiane et 5,80 s pour la plus longue, soit 13 à 17 caractères par seconde —
   * sous le plafond usuel de 20 caractères par seconde, et sous les 17 cps des sous-titres destinés
   * à un large public. La durée reste du **temps réel** : elle ne touche ni un cooldown du speaker,
   * ni la sélection des lignes, ni `tSim`.
   */
  readonly SUBTITLE_MIN_MS: number;
  /** Durée d'affichage ajoutée par caractère de la réplique, en millisecondes. */
  readonly SUBTITLE_PER_CHAR_MS: number;
  /** Durée d'affichage maximale d'une réplique, en millisecondes. */
  readonly SUBTITLE_MAX_MS: number;
  /** Durée d'apparition du bandeau, en millisecondes réelles. */
  readonly SUBTITLE_FADE_IN_MS: number;
  /** Durée de disparition du bandeau, en millisecondes réelles. */
  readonly SUBTITLE_FADE_OUT_MS: number;
  /**
   * Durée de la décélération **visuelle** qui suit l'arrivée, en millisecondes réelles (P013).
   *
   * Elle n'existe que dans le rendu : après `FINISHED`, le noyau ne fait plus aucun pas, et cette
   * durée ne fait que donner l'impression que la meute ralentit puis s'arrête. Elle est volontairement
   * courte — c'est une transition, pas une seconde course.
   */
  readonly FINISH_DECELERATION_MS: number;
  /** Nombre de marcheurs mis en avant sur le podium (P013) : le top 3. */
  readonly FINISH_PODIUM_SIZE: number;
}

/** Constante d'implémentation : `720 = 12 × 60`, calculée pour ne pas être recopiée à la main. */
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
  CHARACTER_HEIGHT_PX: 73,
  CHARACTER_MIN_HEIGHT_PX: 30,
  TRACK_TICK_STEP_M: 50,
  TRACK_LABEL_STEP_M: 250,
  TRACK_LABEL_POOL: 4,
  EDGE_MARGIN_PX: 22,
  TRACK_WIDTH_RATIO: 0.78,
  COMPACT_VIEWPORT_MAX_HEIGHT_PX: 560,
  SUBTITLE_FONT_PX: 24,
  SUBTITLE_NAME_FONT_PX: 22,
  SUBTITLE_QUEUE_FONT_PX: 15,
  SUBTITLE_PADDING_PX: 12,
  SUBTITLE_MAX_WIDTH_RATIO: 0.5,
  SUBTITLE_TOP_OFFSET_PX: 52,
  SUBTITLE_NAME_GAP_PX: 6,
  SUBTITLE_MIN_MS: 800,
  SUBTITLE_PER_CHAR_MS: 60,
  SUBTITLE_MAX_MS: 5800,
  SUBTITLE_FADE_IN_MS: 160,
  SUBTITLE_FADE_OUT_MS: 220,
  FINISH_DECELERATION_MS: 1200,
  FINISH_PODIUM_SIZE: 3,
});

/** Ordonnée écran d'une voie, répartie uniformément entre les deux ratios du décor. */
export function laneY(index: number, heightPx: number): number {
  const top = heightPx * VIEW.LANE_TOP_RATIO;
  const bottom = heightPx * VIEW.LANE_BOTTOM_RATIO;
  const span = CHARACTER_IDS.length - 1;
  return span === 0 ? top : top + ((bottom - top) * index) / span;
}
