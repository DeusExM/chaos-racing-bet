import { describe, expect, it } from 'vitest';

import {
  CROCKFORD_ALPHABET,
  SEED_TEXT_LENGTH,
  normalizeSeed,
  seedToText,
} from '../../src/core/seed';

const SEED_TEXT_PATTERN = /^[0-9A-HJKMNP-TV-Z]{8}$/;

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

describe('seedToText', () => {
  it('produit toujours 8 caractères', () => {
    expect(SEED_TEXT_LENGTH).toBe(8);
    expect(seedToText(0)).toHaveLength(8);
    expect(seedToText(0xffff_ffff)).toHaveLength(8);
  });

  it('encode les valeurs connues', () => {
    expect(seedToText(0)).toBe('00000000');
    expect(seedToText(1)).toBe('00000001');
    expect(seedToText(31)).toBe('0000000Z');
    expect(seedToText(32)).toBe('00000010');
  });

  it('ne produit que des symboles de l\'alphabet', () => {
    for (let seed = 0; seed < 4_096; seed += 1) {
      expect(seedToText(seed)).toMatch(SEED_TEXT_PATTERN);
    }
    for (const seed of [0xffff_ffff, 0x8000_0000, 0x1234_5678, 133_990_825, 0x0f0f_0f0f]) {
      expect(seedToText(seed)).toMatch(SEED_TEXT_PATTERN);
    }
  });

  it('donne deux textes différents à deux entiers différents', () => {
    const seen = new Set<string>();
    for (let seed = 0; seed < 4_096; seed += 1) {
      seen.add(seedToText(seed));
    }
    expect(seen.size).toBe(4_096);
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

  it('accepte indifféremment une seed canonique et un texte libre', () => {
    const canonical = seedToText(133_990_825);
    expect(canonical).toMatch(SEED_TEXT_PATTERN);
    expect(typeof normalizeSeed(canonical)).toBe('number');
    expect(typeof normalizeSeed('n\'importe quoi')).toBe('number');
  });
});
