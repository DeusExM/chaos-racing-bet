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
   * Position verticale de la première voie **en petit paysage** (téléphone), en fraction de la hauteur.
   *
   * La passe responsive issue du test sur iPhone a supprimé, sur ce format, le titre, les marges
   * extérieures et le HUD supérieur : la zone des voies peut donc s'étendre vers le haut et le bas,
   * et les personnages grossir d'autant. Les deux ratios sont calculés pour que, à
   * `CHARACTER_HEIGHT_COMPACT_PX`, le nom de la première voie reste **entier** en haut du canvas et
   * qu'aucune silhouette ne touche la voie voisine (voir `tests/unit/laneGeometry.test.ts`).
   */
  readonly COMPACT_LANE_TOP_RATIO: number;
  /** Position verticale de la dernière voie en petit paysage, en fraction de la hauteur. */
  readonly COMPACT_LANE_BOTTOM_RATIO: number;
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
   * Hauteur affichée d'un personnage **en petit paysage**, en pixels logiques.
   *
   * Le test joueur sur iPhone a jugé les personnages encore trop petits : le titre, les marges
   * extérieures et le HUD supérieur libèrent de la hauteur, et les voies s'étendent
   * (`COMPACT_LANE_TOP_RATIO` / `COMPACT_LANE_BOTTOM_RATIO`) pour accueillir cette hauteur.
   *
   * La micro-correction finale a **sorti le nom de l'espace vertical du sprite** (il est désormais
   * dessiné dans la voie, sur l'axe du personnage : voir `characterNameY`). La contrainte n'est donc
   * plus « le nom tient au-dessus de la tête » mais « deux cadres voisins ne se touchent pas ». À
   * 100 px, l'écart entre deux voies (115,2 px logiques) laisse encore 15 px entre les cadres — et
   * davantage entre les silhouettes visibles, les images ayant 4 à 11 % de marge transparente. C'est
   * la plus grande valeur de la fourchette demandée (94–100) qui reste confortable.
   */
  readonly CHARACTER_HEIGHT_COMPACT_PX: number;
  /**
   * Taille de police du nom affiché au-dessus d'un personnage, en pixels de la scène.
   *
   * Sur un téléphone, le canvas est réduit à ≈ 0,54 : la police nominale donnerait ≈ 7,5 px CSS,
   * sous le plancher de lisibilité. La valeur compacte est donc plus grande en pixels logiques pour
   * rendre ≈ 11 px CSS.
   */
  readonly CHARACTER_NAME_FONT_PX: number;
  /** Taille de police du nom au-dessus d'un personnage en petit paysage, en pixels de la scène. */
  readonly CHARACTER_NAME_FONT_COMPACT_PX: number;
  /**
   * Épaisseur du contour du nom, en pixels, **quand il est dessiné derrière le personnage**.
   *
   * En petit paysage, le nom partage l'axe du sprite et passe donc sous lui : sans contour, la partie
   * recouverte se confondrait avec l'illustration et le nom deviendrait illisible. Le contour est
   * appliqué au texte, pas à sa boîte : il ne change aucune mesure de mise en page.
   */
  readonly CHARACTER_NAME_STROKE_PX: number;
  /** Couleur du contour du nom : celle du fond de l'arène, pour un détachement sans halo clair. */
  readonly CHARACTER_NAME_STROKE_COLOR: string;
  /**
   * Profondeur de dessin du **premier** personnage : les suivants sont posés un cran au-dessus.
   *
   * Les voies sont dessinées dans l'ordre du roster, donc un personnage de la voie du bas passe
   * devant celui de la voie du haut quand deux silhouettes se croisent.
   */
  readonly CHARACTER_SPRITE_DEPTH_BASE: number;
  /**
   * Profondeur du nom quand il est dessiné **derrière** le personnage (petit paysage).
   *
   * Elle est inférieure à `CHARACTER_SPRITE_DEPTH_BASE` : le nom est sous **tous** les sprites, et le
   * personnage peut donc passer devant une partie de son propre nom.
   */
  readonly CHARACTER_NAME_DEPTH_BEHIND: number;
  /** Profondeur du nom quand il est dessiné **au-dessus** du personnage (formats de bureau). */
  readonly CHARACTER_NAME_DEPTH_ABOVE: number;
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
   *
   * En **téléphone paysage**, la bande n'est plus dessinée dans le canvas : la place du classement est
   * prise hors du canvas, par la colonne HTML de `styles.css`. La piste occupe donc toute la largeur du
   * canvas, et cette fraction ne sert plus qu'au format de bureau.
   */
  readonly TRACK_WIDTH_RATIO: number;
  /**
   * Hauteur de fenêtre, en pixels CSS, sous laquelle l'interface passe en mode **téléphone paysage**.
   *
   * Elle sert à deux décisions du rendu : élargir les voies et agrandir les personnages, et adapter la
   * largeur logique du canvas à la piste (le HUD, lui, se range dans une **colonne** à droite, décrite
   * par la requête média de `styles.css`, qui lit la même hauteur).
   */
  readonly COMPACT_VIEWPORT_MAX_HEIGHT_PX: number;
  /**
   * Largeur logique **minimale** de l'arène en petit paysage.
   *
   * La largeur logique est déduite du rapport de la piste (`viewport.arenaBaseSize`), pour que la
   * piste et la colonne du HUD coïncident au pixel. Cette borne n'existe que pour les fenêtres
   * franchement étroites, où descendre plus bas rendrait les personnages démesurés par rapport à la
   * piste ; elle n'est jamais atteinte par un téléphone en paysage (rapport ≈ 2,1).
   */
  readonly COMPACT_MIN_BASE_WIDTH: number;
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
  COMPACT_LANE_TOP_RATIO: 0.1,
  COMPACT_LANE_BOTTOM_RATIO: 0.9,
  CHARACTER_HEIGHT_PX: 73,
  CHARACTER_HEIGHT_COMPACT_PX: 100,
  CHARACTER_NAME_FONT_PX: 14,
  CHARACTER_NAME_FONT_COMPACT_PX: 20,
  CHARACTER_NAME_STROKE_PX: 3,
  CHARACTER_NAME_STROKE_COLOR: '#05070f',
  CHARACTER_SPRITE_DEPTH_BASE: 10,
  CHARACTER_NAME_DEPTH_BEHIND: 5,
  CHARACTER_NAME_DEPTH_ABOVE: 60,
  CHARACTER_MIN_HEIGHT_PX: 30,
  TRACK_TICK_STEP_M: 50,
  TRACK_LABEL_STEP_M: 250,
  TRACK_LABEL_POOL: 4,
  EDGE_MARGIN_PX: 22,
  TRACK_WIDTH_RATIO: 0.78,
  COMPACT_VIEWPORT_MAX_HEIGHT_PX: 560,
  COMPACT_MIN_BASE_WIDTH: 760,
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

/**
 * Ratios de la zone des voies, selon le format.
 *
 * Une seule fonction décide : le décor (`TrackView`), les sprites et leurs noms (`CharacterSprite`)
 * l'appellent tous, donc les bandes de voie, les personnages, les noms et les repères de distance
 * restent alignés par construction, quel que soit le format.
 */
export function laneRatios(compact: boolean): { readonly top: number; readonly bottom: number } {
  return compact
    ? { top: VIEW.COMPACT_LANE_TOP_RATIO, bottom: VIEW.COMPACT_LANE_BOTTOM_RATIO }
    : { top: VIEW.LANE_TOP_RATIO, bottom: VIEW.LANE_BOTTOM_RATIO };
}

/** Hauteur d'affichage d'un personnage, en pixels logiques, selon le format. */
export function characterHeightPx(compact: boolean): number {
  return compact ? VIEW.CHARACTER_HEIGHT_COMPACT_PX : VIEW.CHARACTER_HEIGHT_PX;
}

/** Taille de police du nom d'un personnage, en pixels logiques, selon le format. */
export function characterNameFontPx(compact: boolean): number {
  return compact ? VIEW.CHARACTER_NAME_FONT_COMPACT_PX : VIEW.CHARACTER_NAME_FONT_PX;
}

/**
 * Ordonnée du nom d'un personnage, selon le format.
 *
 * En **petit paysage**, le nom est dessiné **dans la voie**, sur l'axe du personnage : il ne réserve
 * donc plus aucune hauteur au-dessus du sprite. C'est ce qui permet d'agrandir les personnages
 * (`CHARACTER_HEIGHT_COMPACT_PX`) sans rapprocher les voies : le nom et le personnage occupent la
 * même bande, et c'est le personnage qui passe devant (voir `characterNameDepth`).
 *
 * Sur les formats de bureau, rien ne change : le nom reste juste au-dessus de la tête.
 */
export function characterNameY(centerY: number, heightPx: number, compact: boolean): number {
  return compact ? centerY : centerY - heightPx / 2 - 2;
}

/** Profondeur du nom : sous les sprites en petit paysage, au-dessus d'eux ailleurs. */
export function characterNameDepth(compact: boolean): number {
  return compact ? VIEW.CHARACTER_NAME_DEPTH_BEHIND : VIEW.CHARACTER_NAME_DEPTH_ABOVE;
}

/** Épaisseur du contour du nom : il n'en a besoin que lorsqu'il passe **derrière** le personnage. */
export function characterNameStrokePx(compact: boolean): number {
  return compact ? VIEW.CHARACTER_NAME_STROKE_PX : 0;
}

/** Ordonnée écran d'une voie, répartie uniformément entre les deux ratios du format courant. */
export function laneY(index: number, heightPx: number, compact = false): number {
  const ratios = laneRatios(compact);
  const top = heightPx * ratios.top;
  const bottom = heightPx * ratios.bottom;
  const span = CHARACTER_IDS.length - 1;
  return span === 0 ? top : top + ((bottom - top) * index) / span;
}
