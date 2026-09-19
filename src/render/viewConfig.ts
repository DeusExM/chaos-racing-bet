import { MAX_PARTICIPANTS } from '../core/participants';
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
  /**
   * Position verticale de la première voie, en fraction de la hauteur.
   *
   * La passe de finition 2D a étendu la zone des voies vers le haut et le bas (`0,24 / 0,86` →
   * `0,20 / 0,90`) : le nom ne consomme plus de hauteur au-dessus des sprites (il est posé derrière
   * eux, dans le sens de la course), donc l'espace noir entre les voies peut se réduire au profit de
   * personnages plus grands. Le HUD du haut, lui, vit **au-dessus** du canvas : rien ne se recouvre.
   */
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
   * C'est la hauteur de l'**image** : les illustrations comportent une marge transparente de 4,4 à
   * 10,6 %, donc la silhouette visible mesure 82 à 88 px à cette hauteur. La largeur n'est jamais une
   * constante : elle se déduit du ratio de la texture, si bien qu'une image n'est jamais écrasée en
   * carré et que la résolution du fichier n'est jamais une taille d'affichage.
   *
   * Les fichiers servis font 320 px de haut (`tools/optimizeCharacterAssets.mjs`) : le rendu les
   * réduit ici, mais garde de la marge pour les écrans à haute densité, où le canvas est agrandi.
   *
   * La passe de finition 2D a repris ici le principe du téléphone : le nom vit dans la voie, derrière
   * le personnage, donc aucune hauteur n'est réservée au-dessus du sprite et la taille peut grandir
   * (73 → 92 px). L'écart entre deux voies vaut 100,8 px logiques ; à 92 px, il reste 12,8 px entre
   * les silhouettes **visibles** (marges transparentes comprises), ce qui garde six voies nettement
   * séparées en 1280×720 comme en 1920×1080 — la géométrie logique est la même dans les deux cas.
   */
  readonly CHARACTER_HEIGHT_PX: number;
  /**
   * Hauteur affichée d'un personnage **en petit paysage**, en pixels logiques.
   *
   * Le test joueur sur iPhone a jugé les personnages encore trop petits : le titre, les marges
   * extérieures et le HUD supérieur libèrent de la hauteur, et les voies s'étendent
   * (`COMPACT_LANE_TOP_RATIO` / `COMPACT_LANE_BOTTOM_RATIO`) pour accueillir cette hauteur.
   *
   * Le nom n'est plus dessiné **au-dessus** du personnage en petit paysage : il est posé **derrière
   * lui dans le sens de la course** (à sa gauche, sur l'axe de la voie : voir `characterNameX`). Il ne
   * consomme donc plus aucune hauteur, et la seule contrainte qui reste est « deux silhouettes
   * voisines ne se touchent pas ». L'écart entre deux voies vaut 115,2 px logiques ; à 106 px, les
   * cadres laissent 9,2 px et les silhouettes visibles (89,7 % à 95,6 % du cadre) en laissent 14 à
   * 20 : c'est la plus grande valeur de la fourchette demandée (104–106) qui garde une séparation
   * franche, et elle réduit l'espace noir entre les voies.
   */
  readonly CHARACTER_HEIGHT_COMPACT_PX: number;
  /**
   * Taille de police du nom affiché derrière un personnage, en pixels de la scène.
   *
   * Le nom est désormais posé dans la voie, à côté du sprite, dans les deux formats : il ne se
   * partage plus l'espace vertical avec lui, et la taille a été alignée sur les personnages plus
   * grands (14 → 16 px logiques, soit ≈ 12 px CSS en 1280×720).
   *
   * Sur un téléphone, le canvas est réduit à ≈ 0,54 : la police nominale donnerait ≈ 8,6 px CSS, sous
   * le plancher de lisibilité. La valeur compacte est donc plus grande en pixels logiques pour rendre
   * ≈ 11 px CSS.
   */
  readonly CHARACTER_NAME_FONT_PX: number;
  /** Taille de police du nom au-dessus d'un personnage en petit paysage, en pixels de la scène. */
  readonly CHARACTER_NAME_FONT_COMPACT_PX: number;
  /**
   * Espace entre la fin du nom et le début du sprite, en pixels logiques (les deux formats).
   *
   * Le nom est posé **derrière** le personnage au sens de la course — à sa gauche, puisque la course
   * va de gauche à droite — et cet espace garantit qu'il n'est jamais recouvert par l'illustration.
   */
  readonly CHARACTER_NAME_GAP_PX: number;
  /**
   * Espace entre la fin du badge d'événement et le début du sprite, en pixels logiques.
   *
   * Les mots `TURBO !`, `BONUS !`, `MALUS !` suivent la même règle que le nom : dans la voie, à
   * gauche du personnage, sans jamais fusionner avec l'image.
   */
  readonly EVENT_BADGE_GAP_PX: number;
  /**
   * Profondeur de dessin du **premier** personnage : les suivants sont posés un cran au-dessus.
   *
   * Les voies sont dessinées dans l'ordre du roster, donc un personnage de la voie du bas passe
   * devant celui de la voie du haut quand deux silhouettes se croisent.
   */
  readonly CHARACTER_SPRITE_DEPTH_BASE: number;
  /**
   * Profondeur de dessin des **effets** d'événement (halo, traînée) : sous tous les sprites.
   *
   * Un bonus ou un malus se voit autour et derrière le personnage concerné, jamais devant un autre
   * coureur : les effets sont donc posés plus bas que le premier sprite.
   */
  readonly CHARACTER_EFFECT_DEPTH_BASE: number;
  /**
   * Profondeur du nom, dans les deux formats.
   *
   * Elle est **au-dessus** des sprites : le nom n'est jamais derrière le personnage en profondeur. Il
   * n'en a pas besoin non plus, puisqu'il est posé à côté de lui, jamais dessous (micro-correction :
   * « derrière » veut dire derrière dans le sens de la course, pas sous l'image).
   */
  readonly CHARACTER_NAME_DEPTH: number;
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
  LANE_TOP_RATIO: 0.2,
  LANE_BOTTOM_RATIO: 0.9,
  COMPACT_LANE_TOP_RATIO: 0.1,
  COMPACT_LANE_BOTTOM_RATIO: 0.9,
  CHARACTER_HEIGHT_PX: 92,
  CHARACTER_HEIGHT_COMPACT_PX: 106,
  CHARACTER_NAME_FONT_PX: 16,
  CHARACTER_NAME_FONT_COMPACT_PX: 20,
  CHARACTER_NAME_GAP_PX: 10,
  EVENT_BADGE_GAP_PX: 8,
  CHARACTER_SPRITE_DEPTH_BASE: 10,
  CHARACTER_EFFECT_DEPTH_BASE: 8,
  CHARACTER_NAME_DEPTH: 60,
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
 *
 * La **bande** ne dépend pas de l'effectif : c'est la zone que le format réserve à la course (le HUD
 * du haut, sur bureau, n'y entre jamais). Ce qui dépend de l'effectif, c'est la **taille** des
 * personnages à l'intérieur de cette bande — voir `characterHeightPx`.
 */
export function laneRatios(compact: boolean): { readonly top: number; readonly bottom: number } {
  return compact
    ? { top: VIEW.COMPACT_LANE_TOP_RATIO, bottom: VIEW.COMPACT_LANE_BOTTOM_RATIO }
    : { top: VIEW.LANE_TOP_RATIO, bottom: VIEW.LANE_BOTTOM_RATIO };
}

/**
 * Part du cadre occupée par la silhouette visible, dans le cas le plus défavorable.
 *
 * Mesurée sur les fichiers réellement servis (`tools/optimizeCharacterAssets.mjs`) : la silhouette la
 * plus haute occupe 95,6 % de la hauteur du cadre, le reste étant transparent. C'est cette fraction —
 * et non 100 % — qui décide de la séparation **visible** entre deux voies voisines : deux cadres qui
 * se touchent peuvent donner deux silhouettes nettement séparées.
 */
const MAX_VISIBLE_FRACTION = 0.956;

/**
 * Séparation **visible** minimale entre deux silhouettes voisines, en pixels logiques.
 *
 * C'est la contrainte de lisibilité du projet (elle existait déjà pour six coureurs) : en dessous,
 * l'œil ne distingue plus deux voies, même si les cadres ne se recouvrent pas.
 */
const MIN_VISIBLE_GAP_PX = 10;

/** Effectif de référence : le roster complet, dont la taille des personnages est **figée**. */
const REFERENCE_PARTICIPANTS = MAX_PARTICIPANTS;

/**
 * Hauteur d'affichage d'un personnage, en pixels logiques, selon le format **et l'effectif**.
 *
 * ## Pourquoi la taille dépend du nombre de coureurs
 *
 * La bande des voies est la même ressource pour tout le monde : à trois coureurs, chacun dispose de
 * deux fois plus d'espace vertical qu'à six. Laisser les sprites à leur taille « six » gaspillerait
 * cet espace — c'est exactement ce que corrige cette fonction.
 *
 * ## La valeur retenue est la plus grande qui tienne, jamais un réglage arbitraire
 *
 * Pour un effectif donné, la hauteur est la **plus grande** valeur qui respecte les trois contraintes
 * mesurables du projet, dans cet ordre :
 *
 * 1. `séparation visible ≥ MIN_VISIBLE_GAP_PX`, mesurée sur la silhouette réelle
 *    (`MAX_VISIBLE_FRACTION`) et non sur le cadre ;
 * 2. le **cadre** de la première voie reste dans l'arène (`centre − h/2 ≥ 0`) ;
 * 3. le cadre de la dernière voie aussi (`centre + h/2 ≤ BASE_HEIGHT`).
 *
 * Ces contraintes se lisent directement : `h ≤ (espacement − 10) / 0,956` et
 * `h ≤ 2 × min(haut de bande, bas d'arène − bas de bande)`. Aucune constante n'est ajoutée à la main.
 *
 * ## À six coureurs, rien ne change
 *
 * L'effectif de référence court avec **exactement** les constantes historiques
 * (`CHARACTER_HEIGHT_PX`, `CHARACTER_HEIGHT_COMPACT_PX`) : elles sont plus petites que le maximum
 * autorisé par les contraintes ci-dessus, et c'est ce qui garantit qu'une course à six reste, au
 * pixel près, celle d'avant cette fonctionnalité.
 */
export function characterHeightPx(participants: number, compact: boolean): number {
  const reference = compact ? VIEW.CHARACTER_HEIGHT_COMPACT_PX : VIEW.CHARACTER_HEIGHT_PX;
  const count = Math.min(Math.max(Math.trunc(participants), 2), REFERENCE_PARTICIPANTS);
  if (count >= REFERENCE_PARTICIPANTS) {
    return reference;
  }

  const ratios = laneRatios(compact);
  const bandTop = VIEW.BASE_HEIGHT * ratios.top;
  const bandBottom = VIEW.BASE_HEIGHT * ratios.bottom;
  const spacing = (bandBottom - bandTop) / (count - 1);

  const separationBound = (spacing - MIN_VISIBLE_GAP_PX) / MAX_VISIBLE_FRACTION;
  const canvasBound = 2 * Math.min(bandTop, VIEW.BASE_HEIGHT - bandBottom);

  return Math.max(reference, Math.floor(Math.min(separationBound, canvasBound)));
}

/**
 * Taille de police du nom d'un personnage, en pixels logiques, selon le format et l'effectif.
 *
 * Elle suit la **même proportion** que sur l'effectif de référence : un personnage deux fois plus
 * grand porte un nom deux fois plus grand, donc le rapport entre le texte et la silhouette ne dépend
 * jamais du nombre de coureurs. À six, la valeur est exactement la constante historique.
 */
export function characterNameFontPx(participants: number, compact: boolean): number {
  const reference = compact ? VIEW.CHARACTER_NAME_FONT_COMPACT_PX : VIEW.CHARACTER_NAME_FONT_PX;
  const referenceHeight = compact ? VIEW.CHARACTER_HEIGHT_COMPACT_PX : VIEW.CHARACTER_HEIGHT_PX;
  const height = characterHeightPx(participants, compact);
  if (height === referenceHeight) {
    return reference;
  }
  return Math.round((reference * height) / referenceHeight);
}

/**
 * Ordonnée du nom d'un personnage : l'axe de sa voie, dans les deux formats.
 *
 * Le nom vit **dans la voie** et non plus au-dessus de la tête : il ne réserve donc aucune hauteur
 * au-dessus du sprite, ce qui permet d'agrandir les personnages sans rapprocher les voies. Le format
 * n'entre plus dans cette décision — c'est la même règle sur un téléphone et sur un bureau.
 */
export function characterNameY(centerY: number): number {
  return centerY;
}

/**
 * Abscisse du nom d'un personnage : **à gauche** du sprite, dans les deux formats.
 *
 * Le nom est posé **derrière** le personnage au sens de la course : la course va de gauche à droite,
 * donc le nom est à gauche du sprite, séparé de lui par `CHARACTER_NAME_GAP_PX`. Le texte n'est ainsi
 * jamais recouvert par l'illustration — ce que la formulation « derrière le personnage » ne voulait
 * pas dire : il ne s'agit pas d'une profondeur de dessin, mais d'une position sur la piste.
 */
export function characterNameX(centerX: number, widthPx: number): number {
  return centerX - widthPx / 2 - VIEW.CHARACTER_NAME_GAP_PX;
}

/**
 * Origine du texte du nom : ancré par son bord **droit**, centré verticalement sur l'axe de la voie.
 *
 * Son bord droit tombe donc exactement à `characterNameX`, quelle que soit la longueur du nom : un
 * nom long s'étend vers l'arrière, jamais vers le personnage.
 */
export function characterNameOrigin(): { readonly x: number; readonly y: number } {
  return { x: 1, y: 0.5 };
}

/**
 * Ordonnée écran d'une voie, répartie uniformément entre les deux ratios du format courant.
 *
 * `participants` est le nombre de **partants** de la course : c'est lui qui décide de l'espacement.
 * Il est obligatoire, et non optionnel : un appelant qui l'oublierait dessinerait six voies pour une
 * course à trois, ce qui est exactement le genre d'erreur silencieuse que ce paramètre interdit.
 *
 * À six partants, l'expression est **identique** à celle d'avant cette fonctionnalité
 * (`span = 5`), donc les positions restent bit à bit les mêmes.
 */
export function laneY(
  index: number,
  heightPx: number,
  compact: boolean,
  participants: number,
): number {
  const ratios = laneRatios(compact);
  const top = heightPx * ratios.top;
  const bottom = heightPx * ratios.bottom;
  const span = Math.max(1, Math.trunc(participants) - 1);
  return span === 1 ? top : top + ((bottom - top) * index) / span;
}
