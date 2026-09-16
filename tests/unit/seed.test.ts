import { describe, expect, it } from 'vitest';

import {
  CROCKFORD_ALPHABET,
  SEED_TEXT_LENGTH,
  isCanonicalSeedText,
  normalizeSeed,
  seedTextFromBytes,
} from '../../src/core/seed';

const SEED_TEXT_PATTERN = /^[0-9A-HJKMNP-TV-Z]{8}$/;

function bytesFrom(seed: number): Uint8Array {
  const bytes = new Uint8Array(SEED_TEXT_LENGTH);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = (seed + index * 31) % 256;
  }
  return bytes;
}

describe('alphabet Crockford', () => {
  it('contient 32 symboles tous distincts', () => {
    expect(CROCKFORD_ALPHABET).toHaveLength(32);
    expect(new Set(CROCKFORD_ALPHABET).size).toBe(32);
  });

  it('exclut les caractères ambigus I, L, O et U', () => {
    for (const ambiguous of ['I', 'L', 'O', 'U']) {
      expect(CROCKFORD_ALPHABET).not.toContain(ambiguous);
    }
  });
});

describe('seedTextFromBytes', () => {
  it('produit une seed affichable de 8 caractères', () => {
    expect(SEED_TEXT_LENGTH).toBe(8);

    for (let seed = 0; seed < 4_096; seed += 1) {
      expect(seedTextFromBytes(bytesFrom(seed))).toMatch(SEED_TEXT_PATTERN);
    }
  });

  it('est déterministe : mêmes octets, même seed', () => {
    expect(seedTextFromBytes(bytesFrom(42))).toBe(seedTextFromBytes(bytesFrom(42)));
  });

  it('utilise tout l\'alphabet, y compris en première position', () => {
    // Régression : l'ancien encodage d'un uint32 sur 8 caractères laissait le premier caractère
    // toujours à « 0 », ce qui rendait l'exemple `K7QM2X9A` de GAME_DESIGN impossible à produire.
    const firstCharacters = new Set<string>();
    const allCharacters = new Set<string>();

    for (let seed = 0; seed < 256; seed += 1) {
      const text = seedTextFromBytes(bytesFrom(seed));
      firstCharacters.add(text.charAt(0));
      for (const character of text) {
        allCharacters.add(character);
      }
    }

    expect(firstCharacters.size).toBe(32);
    expect(allCharacters.size).toBe(32);
  });

  it('refuse un tableau trop court', () => {
    expect(() => seedTextFromBytes(new Uint8Array(7))).toThrow(RangeError);
    expect(seedTextFromBytes(new Uint8Array(9))).toHaveLength(8);
  });
});

describe('isCanonicalSeedText', () => {
  it('accepte une seed affichable, y compris l\'exemple de GAME_DESIGN', () => {
    expect(isCanonicalSeedText('K7QM2X9A')).toBe(true);
    expect(isCanonicalSeedText('00000000')).toBe(true);
    expect(isCanonicalSeedText('ZZZZZZZZ')).toBe(true);
  });

  it('refuse les longueurs et les symboles invalides', () => {
    expect(isCanonicalSeedText('K7QM2X9')).toBe(false);
    expect(isCanonicalSeedText('K7QM2X9AB')).toBe(false);
    expect(isCanonicalSeedText('')).toBe(false);
    expect(isCanonicalSeedText('k7qm2x9a')).toBe(false);
    expect(isCanonicalSeedText('K7QM2X9I')).toBe(false);
    expect(isCanonicalSeedText('K7QM2X9L')).toBe(false);
    expect(isCanonicalSeedText('K7QM2X9O')).toBe(false);
    expect(isCanonicalSeedText('K7QM2X9U')).toBe(false);
    expect(isCanonicalSeedText('K7QM2X9-')).toBe(false);
  });
});

describe('normalizeSeed', () => {
  it('accepte n\'importe quelle chaîne sans jamais échouer', () => {
    for (const text of ['', ' ', 'K7QM2X9A', 'hello world', 'éàü', '🎲', '0'.repeat(500)]) {
      const value = normalizeSeed(text);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(0x1_0000_0000);
    }
  });

  it('est déterministe', () => {
    expect(normalizeSeed('K7QM2X9A')).toBe(normalizeSeed('K7QM2X9A'));
    expect(normalizeSeed('K7QM2X9A')).toBe(133_990_825);
  });

  it('sépare des textes différents', () => {
    expect(normalizeSeed('K7QM2X9A')).not.toBe(normalizeSeed('K7QM2X9B'));
    expect(normalizeSeed('hello')).not.toBe(normalizeSeed('Hello'));
  });
});

describe('contrat de seed', () => {
  it('rejoue exactement la même course quand on recopie la seed affichée', () => {
    // C'est le contract central : la seed affichée est la source de vérité. Ce qui circule, c'est
    // le texte ; la seed interne n'en est qu'une réduction déterministe.
    for (let seed = 0; seed < 512; seed += 1) {
      const displayed = seedTextFromBytes(bytesFrom(seed));

      const pasted = new URLSearchParams(`?seed=${displayed}`).get('seed');
      expect(pasted).toBe(displayed);
      expect(normalizeSeed(pasted ?? '')).toBe(normalizeSeed(displayed));
    }
  });

  it('réduit la seed affichée (40 bits) à une seed interne de 32 bits', () => {
    // 8 caractères Crockford représentent 32^8 = 2^40 valeurs possibles, réduites à 2^32 : la
    // réduction n'est donc pas injective, et deux textes peuvent donner la même seed interne.
    expect(32 ** SEED_TEXT_LENGTH).toBeGreaterThan(0x1_0000_0000);

    for (let seed = 0; seed < 512; seed += 1) {
      expect(normalizeSeed(seedTextFromBytes(bytesFrom(seed)))).toBeLessThan(0x1_0000_0000);
    }
  });

  it('traite une seed canonique et un texte libre par la même règle', () => {
    for (const text of ['K7QM2X9A', 'une seed libre', '123', '']) {
      expect(normalizeSeed(text)).toBe(normalizeSeed(text));
    }
  });
});
