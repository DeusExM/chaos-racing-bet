/**
 * Borne `value` dans l'intervalle `[min, max]`.
 *
 * Première fonction pure du noyau, présente dès P001 uniquement pour donner au test
 * fumigène une cible réelle. Le reste de `src/core/math.ts` (approach, OU, gaussienne)
 * appartient à P004.
 *
 * @throws RangeError si les bornes sont inversées : c'est une erreur de programmation,
 *         pas une donnée d'entrée valide, et elle doit être visible immédiatement.
 */
export function clamp(value: number, min: number, max: number): number {
  if (min > max) {
    throw new RangeError(`clamp : bornes inversées (min=${min}, max=${max}).`);
  }
  return Math.min(Math.max(value, min), max);
}
