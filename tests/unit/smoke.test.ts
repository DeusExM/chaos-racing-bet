import { describe, expect, it } from 'vitest';

import { clamp } from '../../src/core/math';

describe('clamp', () => {
  it("laisse passer une valeur déjà dans l'intervalle", () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });

  it('ramène aux bornes les valeurs hors intervalle', () => {
    expect(clamp(-3, 0, 10)).toBe(0);
    expect(clamp(42, 0, 10)).toBe(10);
  });

  it('accepte les bornes elles-mêmes', () => {
    expect(clamp(0, 0, 10)).toBe(0);
    expect(clamp(10, 0, 10)).toBe(10);
  });

  it('refuse des bornes inversées', () => {
    expect(() => clamp(1, 10, 0)).toThrow(RangeError);
  });
});
