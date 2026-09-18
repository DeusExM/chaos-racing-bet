import { VIEW } from './viewConfig';

/**
 * Format d'affichage : décisions de **présentation** prises à partir de la fenêtre réelle.
 *
 * ## Pourquoi ces deux fonctions vivent ensemble
 *
 * Le format « petit paysage » (téléphone tenu à l'horizontale) change trois choses, et elles doivent
 * rester cohérentes : la requête média de `styles.css` (mise en page), la taille logique de l'arène
 * (voir `arenaBaseSize`) et la géométrie des voies (`viewConfig.laneY`). Le seuil est donc unique
 * (`VIEW.COMPACT_VIEWPORT_MAX_HEIGHT_PX`) et il est lu ici, jamais recopié.
 *
 * ## Ce que ce module ne décide pas
 *
 * Rien de ce qui touche à la course : ni distance, ni vitesse, ni classement. `arenaBaseSize` ne fait
 * que choisir un **cadrage** ; `isCompactViewport` ne fait que lire la fenêtre.
 */

/** Vrai si la fenêtre est un petit écran paysage (téléphone). */
export function isCompactViewport(): boolean {
  return window.matchMedia(`(max-height: ${String(VIEW.COMPACT_VIEWPORT_MAX_HEIGHT_PX)}px)`).matches;
}

/** Taille logique de l'arène, en pixels du canvas. */
export interface ArenaSize {
  readonly width: number;
  readonly height: number;
}

/**
 * Taille logique de l'arène pour une boîte d'affichage donnée.
 *
 * ## Pourquoi la largeur logique dépend de la boîte en petit paysage
 *
 * Sur ce format, l'écran est partagé entre la **piste** (à gauche) et la **colonne du HUD** (à
 * droite) : la piste n'a donc plus le rapport 16:9 de l'arène de bureau. Avec `Scale.FIT`, garder
 * 1280×720 laisserait des bandes vides en haut et en bas de la piste, et surtout le canvas ne
 * coïnciderait plus avec la colonne de la grille du HUD qui lui fait face : les badges d'événement,
 * positionnés en pourcentage de la piste, seraient décalés.
 *
 * La hauteur logique reste `BASE_HEIGHT` : toute la géométrie verticale (voies, rangs, offsets)
 * garde donc exactement le même sens qu'en 1280×720, et seule la correspondance horizontale entre
 * mètres et pixels change — ce qui est précisément ce que fait déjà la caméra, qui reçoit la largeur
 * de piste en paramètre.
 *
 * Fonction **pure** : elle ne lit ni `window` ni le DOM, et se teste donc sans navigateur.
 */
export function arenaBaseSize(
  boxWidthPx: number,
  boxHeightPx: number,
  compact: boolean,
): ArenaSize {
  if (!compact || boxWidthPx <= 0 || boxHeightPx <= 0) {
    return { width: VIEW.BASE_WIDTH, height: VIEW.BASE_HEIGHT };
  }

  const ratio = boxWidthPx / boxHeightPx;
  return {
    width: Math.max(Math.round(VIEW.BASE_HEIGHT * ratio), VIEW.COMPACT_MIN_BASE_WIDTH),
    height: VIEW.BASE_HEIGHT,
  };
}

/**
 * Orientation d'une fenêtre, dans le sens où les requêtes média de `styles.css` l'entendent.
 *
 * Le carré est traité comme du **paysage** : c'est le cas où l'écran est le plus large possible sans
 * être plus haut que large, donc celui où la piste a le plus de place. Aucun téléphone réel n'est
 * carré, cette branche n'existe que pour rendre la fonction totale.
 */
export type ViewportOrientation = 'portrait' | 'landscape';

/** Orientation déduite de la taille de **mise en page** (celle que lisent les requêtes média). */
export function orientationOf(layoutWidth: number, layoutHeight: number): ViewportOrientation {
  return layoutWidth < layoutHeight ? 'portrait' : 'landscape';
}

/**
 * Vrai quand l'écran est un **téléphone tenu droit** : la course ne s'y joue pas.
 *
 * ## Pourquoi la largeur, et pas seulement l'orientation
 *
 * Une fenêtre de bureau étroite et haute est « en portrait » elle aussi. La bloquer serait une
 * régression : le seuil de largeur reprend donc exactement celui du format « petit paysage »
 * (`VIEW.COMPACT_VIEWPORT_MAX_HEIGHT_PX`) — dans les deux cas, c'est le **côté court** de l'écran qui
 * décide, et la constante est lue, jamais recopiée. Un téléphone tenu droit (390 × 844) est donc
 * bloqué, une fenêtre de bureau haute (700 × 900) ne l'est pas.
 *
 * Fonction **pure** : elle ne lit ni `window` ni le DOM.
 */
export function isPortraitPhone(layoutWidth: number, layoutHeight: number): boolean {
  return (
    orientationOf(layoutWidth, layoutHeight) === 'portrait' &&
    layoutWidth <= VIEW.COMPACT_VIEWPORT_MAX_HEIGHT_PX
  );
}