/**
 * Conversion entre une seed 32 bits et sa forme affichable.
 *
 * La seed visible est une chaîne de 8 caractères en Base32 Crockford, choisie parce qu'elle évite
 * les caractères ambigus à la lecture comme à la recopie (voir `GAME_DESIGN.md` §10).
 */

import { hash32 } from './rng';

/** Alphabet Base32 Crockford : 32 symboles, sans I, L, O ni U. */
export const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Nombre de caractères d'une seed affichée. */
export const SEED_TEXT_LENGTH = 8;

/**
 * Convertit un entier 32 bits en seed affichable.
 *
 * 8 caractères représentent 40 bits, donc tout entier 32 bits y tient sans perte.
 */
export function seedToText(seed: number): string {
  let value = seed >>> 0;
  let text = '';
  for (let index = 0; index < SEED_TEXT_LENGTH; index += 1) {
    text = CROCKFORD_ALPHABET.charAt(value % 32) + text;
    value = Math.floor(value / 32);
  }
  return text;
}

/**
 * Convertit une seed saisie en entier 32 bits.
 *
 * Toute chaîne est acceptée : une seed qui n'est pas au format affichable est hachée. Deux textes
 * différents donnent donc deux courses différentes, sans qu'aucune saisie ne puisse être rejetée.
 */
export function normalizeSeed(text: string): number {
  return hash32(text);
}
