/**
 * Seed affichée et seed interne.
 *
 * La **seed affichée est la source de vérité** : c'est elle qu'on lit à l'écran, qu'on recopie dans
 * `?seed=` et qu'on partage. La seed interne 32 bits qui alimente les streams aléatoires en est
 * dérivée par hachage, toujours par la même règle et pour toutes les entrées.
 */

import { hash32 } from './rng';

/** Alphabet Base32 Crockford : 32 symboles, sans I, L, O ni U. */
export const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Nombre de caractères d'une seed affichée. */
export const SEED_TEXT_LENGTH = 8;

/**
 * Convertit des octets aléatoires en seed affichable.
 *
 * 256 est un multiple de 32 : prendre `octet % 32` répartit donc exactement les 32 symboles, sans
 * biais de modulo. Chaque caractère porte 5 bits utiles, soit 40 bits d'entropie pour une seed.
 */
export function seedTextFromBytes(bytes: Uint8Array): string {
  if (bytes.length < SEED_TEXT_LENGTH) {
    throw new RangeError(
      `seedTextFromBytes : ${SEED_TEXT_LENGTH} octets attendus au minimum, ${bytes.length} reçus.`,
    );
  }

  let text = '';
  for (let index = 0; index < SEED_TEXT_LENGTH; index += 1) {
    text += CROCKFORD_ALPHABET.charAt((bytes[index] ?? 0) % 32);
  }
  return text;
}

/** Vrai si le texte a exactement la forme d'une seed affichable. */
export function isCanonicalSeedText(text: string): boolean {
  if (text.length !== SEED_TEXT_LENGTH) {
    return false;
  }
  for (let index = 0; index < text.length; index += 1) {
    if (!CROCKFORD_ALPHABET.includes(text.charAt(index))) {
      return false;
    }
  }
  return true;
}

/**
 * Réduit une seed saisie à la seed interne 32 bits.
 *
 * Une seule règle pour toutes les entrées : le texte est haché, qu'il ait ou non la forme
 * affichable. Recopier une seed affichée dans `?seed=` redonne donc toujours exactement la même
 * seed interne, et par conséquent la même course.
 *
 * La réduction de 40 bits (8 caractères) vers 32 bits n'est pas injective : deux textes différents
 * peuvent produire la même seed interne. C'est admis, et jamais nié.
 */
export function normalizeSeed(text: string): number {
  return hash32(text);
}
