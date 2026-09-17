/**
 * Formatage **des nombres visibles** — module unique de présentation.
 *
 * Règle de fond : **l'arrondi d'affichage n'est jamais celui de la simulation**. Ce module ne
 * modifie aucune valeur : il n'en produit qu'un texte. La valeur brute reste disponible partout
 * ailleurs (modèle du HUD, `data-*` des tests, panneau de debug), ce qui permet aux tests de
 * comparer des nombres exacts tout en garantissant qu'aucun joueur ne lise jamais
 * `35.93333333333333 %` ni `6.133333333333333 s`.
 *
 * Deux principes gouvernent les arrondis, et ils sont volontairement simples :
 *
 * 1. **Une durée, un pourcentage, un compte, un rang s'affichent sans décimale** : `6 s`, `36 %`,
 *    `4 dépassements`, `2e`. Une précision au dixième sur ces valeurs n'apporte rien au spectateur
 *    et fabrique du bruit visuel.
 * 2. **Une distance et un écart s'affichent au décimètre** : `3,2 m`. C'est l'unité qui rend deux
 *    écarts comparables à l'œil pendant une course.
 *
 * **Seule exception, portée par le HUD** : le **chrono** de course (`formatSimTime`) garde une
 * décimale, parce que c'est un compteur vivant que le spectateur regarde défiler. Les durées
 * *racontées* — textes du speaker, instant d'un checkpoint — sont des mesures : elles s'affichent
 * entières (`20 s`) ou tronquées au mètre, jamais avec une traîne flottante.
 *
 * Ce module vit dans `render/` parce que c'est la couche de présentation, et il est importé aussi
 * par `app/strings.fr.ts` (textes du speaker) : le sens `app/ → render/` est autorisé par
 * `AGENTS.md` §4, alors que `render/ → app/` ne l'est pas. `core/`, `sim/` et `speaker/` ne le
 * connaissent pas : aucun calcul ne dépend d'un arrondi d'affichage.
 */

/** Espace insécable : sépare un nombre de son unité dans le HUD, où un retour à la ligne serait faux. */
export const NBSP = '\u00A0';

/** Séparateur par défaut des textes de commentaire : une espace ordinaire, qui se replie proprement. */
export const PLAIN_SPACE = ' ';

/**
 * Chiffres après la virgule selon la **nature** de la valeur affichée.
 *
 * Les regrouper ici rend impossible l'apparition d'une décimale parasite : un appelant qui veut
 * afficher une durée n'a pas de nombre à choisir, il appelle `formatSecondsFr`.
 */
export const DISPLAY_DECIMALS = Object.freeze({
  /** Durée, pourcentage, compte, rang : aucune décimale. */
  INTEGER: 0,
  /** Distance, écart, vitesse : une décimale. */
  METRES: 1,
});

/**
 * Arrondit **pour l'affichage seulement**, par la représentation décimale (`toFixed`).
 *
 * `toFixed` est utilisé ici parce que c'est exactement la sémantique voulue : un arrondi décimal
 * reproductible d'un moteur à l'autre. La simulation, elle, n'arrondit jamais.
 */
function roundForDisplay(value: number, decimals: number): string {
  if (!Number.isFinite(value)) {
    return '—';
  }
  return value.toFixed(decimals);
}

/** Nombre décimal à la française : `6,1` (point décimal remplacé, jamais de séparateur de milliers). */
export function formatDecimalFr(value: number, decimals: number = DISPLAY_DECIMALS.METRES): string {
  return roundForDisplay(value, decimals).replace('.', ',');
}

/**
 * Compte entier : `4`.
 *
 * Un compte publié par un fait est un entier, mais il ne faut pas dépendre de cette promesse pour
 * l'affichage : `Math.round` protège d'un `3.9999999999999996` sans jamais transformer un compte en
 * texte illisible.
 */
export function formatCountFr(value: number): string {
  return String(Math.round(value));
}

/** Valeur et unité : `6 s`, `3,2 m`. Le séparateur est choisi par l'appelant (texte ou HUD). */
export function formatUnitFr(
  value: number,
  unit: string,
  decimals: number = DISPLAY_DECIMALS.INTEGER,
  separator: string = PLAIN_SPACE,
): string {
  return `${formatDecimalFr(value, decimals)}${separator}${unit}`;
}

/** Durée : `6 s` — jamais de décimale, même si le noyau en porte. */
export function formatSecondsFr(value: number, separator: string = PLAIN_SPACE): string {
  return formatUnitFr(value, 's', DISPLAY_DECIMALS.INTEGER, separator);
}

/** Distance : `3,2 m`. */
export function formatMetresFr(value: number, separator: string = PLAIN_SPACE): string {
  return formatUnitFr(value, 'm', DISPLAY_DECIMALS.METRES, separator);
}

/**
 * Distance **tronquée** au mètre : jamais arrondie au plus proche, donc jamais surestimée.
 *
 * C'est la règle des relevés de checkpoint : « au moins 212 m parcourus » est une mesure exacte,
 * « 213 m » après arrondi serait une valeur inventée.
 */
export function formatTruncatedMetresFr(value: number, separator: string = PLAIN_SPACE): string {
  return `${String(Math.floor(value))}${separator}m`;
}

/** Pourcentage : `36 %` — jamais de décimale. */
export function formatPercentFr(value: number, separator: string = PLAIN_SPACE): string {
  return formatUnitFr(value, '%', DISPLAY_DECIMALS.INTEGER, separator);
}

/** Écart signé en mètres : `+3,2 m`, `0,0 m` pour le leader (jamais `-0,0 m`). */
export function formatSignedMetresFr(value: number, separator: string = PLAIN_SPACE): string {
  const magnitude = formatMetresFr(Math.abs(value), separator);
  return value > 0 ? `+${magnitude}` : magnitude;
}

/** Écart signé en secondes : `+0,3 s`, `0,0 s` pour le leader. */
export function formatSignedSecondsFr(value: number, separator: string = PLAIN_SPACE): string {
  const magnitude = formatUnitFr(Math.abs(value), 's', DISPLAY_DECIMALS.METRES, separator);
  return value > 0 ? `+${magnitude}` : magnitude;
}
