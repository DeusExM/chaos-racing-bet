import { describe, expect, it } from 'vitest';

import { RngStream, forkStream, hash32, sfc32, splitmix32 } from '../../src/core/rng';

const SEED = 123_456_789;
const DRAWS = 100_000;

function collect(stream: RngStream, count: number, draw: (source: RngStream) => number): number[] {
  const values: number[] = [];
  for (let index = 0; index < count; index += 1) {
    values.push(draw(stream));
  }
  return values;
}

function mean(values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    total += value;
  }
  return total / values.length;
}

function variance(values: readonly number[]): number {
  const average = mean(values);
  let total = 0;
  for (const value of values) {
    total += (value - average) ** 2;
  }
  return total / values.length;
}

describe('hash32', () => {
  it('donne toujours la même valeur pour la même entrée', () => {
    expect(hash32('K7QM2X9A')).toBe(hash32('K7QM2X9A'));
    expect(hash32('K7QM2X9A')).toBe(133_990_825);
  });

  it('renvoie un entier 32 bits non signé', () => {
    for (const text of ['', 'a', 'chaos race', 'K7QM2X9A', 'éàü', '🎲']) {
      const value = hash32(text);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(0x1_0000_0000);
    }
  });

  it('sépare des entrées proches', () => {
    expect(hash32('drift:c0')).not.toBe(hash32('drift:c1'));
    expect(hash32('seed')).not.toBe(hash32('seed '));
  });
});

describe('splitmix32 et sfc32', () => {
  it('produisent des suites déterministes', () => {
    const first = splitmix32(1);
    const second = splitmix32(1);
    expect([first(), first(), first()]).toEqual([second(), second(), second()]);

    const sfcA = sfc32(1, 2, 3, 4);
    const sfcB = sfc32(1, 2, 3, 4);
    expect([sfcA(), sfcA(), sfcA()]).toEqual([sfcB(), sfcB(), sfcB()]);
  });
});

describe('reproductibilité des streams', () => {
  it('produit 10 000 valeurs identiques pour la même seed et le même label', () => {
    const first = collect(forkStream(SEED, 'drift:c0'), 10_000, (source) => source.next());
    const second = collect(forkStream(SEED, 'drift:c0'), 10_000, (source) => source.next());

    expect(first).toHaveLength(10_000);
    expect(first).toEqual(second);
  });

  it('produit des séquences différentes pour des seeds différentes', () => {
    const first = collect(forkStream(SEED, 'drift:c0'), 1_000, (source) => source.next());
    const second = collect(forkStream(SEED + 1, 'drift:c0'), 1_000, (source) => source.next());

    const differences = first.filter((value, index) => value !== second[index]).length;
    expect(differences).toBeGreaterThan(990);
  });

  it('produit des séquences différentes pour des labels différents', () => {
    const first = collect(forkStream(SEED, 'drift:c0'), 1_000, (source) => source.next());
    const second = collect(forkStream(SEED, 'surge:c0'), 1_000, (source) => source.next());

    expect(first).not.toEqual(second);
  });
});

describe('indépendance des streams', () => {
  it("consommer un stream ne décale pas la séquence d'un autre", () => {
    const reference = collect(forkStream(SEED, 'events:global'), 1_000, (source) => source.next());

    const drift = forkStream(SEED, 'drift:c0');
    for (let index = 0; index < 1_000; index += 1) {
      drift.next();
    }

    const afterConsumption = collect(
      forkStream(SEED, 'events:global'),
      1_000,
      (source) => source.next(),
    );
    expect(afterConsumption).toEqual(reference);
  });

  it("ne dépend pas de l'ordre d'appel entre deux streams", () => {
    const drift = forkStream(SEED, 'drift:c0');
    const events = forkStream(SEED, 'events:global');

    const interleavedDrift: number[] = [];
    const interleavedEvents: number[] = [];
    for (let index = 0; index < 1_000; index += 1) {
      interleavedDrift.push(drift.next());
      interleavedEvents.push(events.next());
    }

    expect(interleavedDrift).toEqual(
      collect(forkStream(SEED, 'drift:c0'), 1_000, (source) => source.next()),
    );
    expect(interleavedEvents).toEqual(
      collect(forkStream(SEED, 'events:global'), 1_000, (source) => source.next()),
    );
  });
});

describe('distributions', () => {
  it('respecte la loi uniforme sur nextFloat', () => {
    const values = collect(forkStream(SEED, 'test:uniform'), DRAWS, (source) => source.nextFloat());

    for (const value of values) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }

    expect(mean(values)).toBeGreaterThanOrEqual(0.49);
    expect(mean(values)).toBeLessThanOrEqual(0.51);
    expect(Math.abs(variance(values) - 1 / 12)).toBeLessThan(0.002);
  });

  it('respecte la loi normale centrée réduite sur nextGaussian', () => {
    const values = collect(
      forkStream(SEED, 'test:gaussian'),
      DRAWS,
      (source) => source.nextGaussian(),
    );

    const average = mean(values);
    const standardDeviation = Math.sqrt(variance(values));

    expect(Math.abs(average)).toBeLessThan(0.02);
    expect(Math.abs(standardDeviation - 1)).toBeLessThan(0.02);
  });

  it('respecte les poids de weightedPick à 2 % près', () => {
    const items = ['TURBO', 'CHUTE', 'VENT_FACE', 'RACCOURCI'] as const;
    const weights = [22, 20, 18, 12];
    const total = weights.reduce((sum, weight) => sum + weight, 0);

    const counts = new Map<string, number>(items.map((item) => [item, 0]));
    const stream = forkStream(SEED, 'test:weighted');
    for (let index = 0; index < DRAWS; index += 1) {
      const picked = stream.weightedPick(items, weights);
      counts.set(picked, (counts.get(picked) ?? 0) + 1);
    }

    for (const [index, item] of items.entries()) {
      const expected = (weights[index] ?? 0) / total;
      const observed = (counts.get(item) ?? 0) / DRAWS;
      expect(Math.abs(observed - expected)).toBeLessThan(0.02 * expected);
    }
  });
});

describe('tirages discrets', () => {
  it('borne nextInt de façon inclusive', () => {
    const stream = forkStream(SEED, 'test:int');
    const seen = new Set<number>();
    let minimum = Number.POSITIVE_INFINITY;
    let maximum = Number.NEGATIVE_INFINITY;

    for (let index = 0; index < 20_000; index += 1) {
      const value = stream.nextInt(3, 7);
      minimum = Math.min(minimum, value);
      maximum = Math.max(maximum, value);
      seen.add(value);
    }

    expect(minimum).toBe(3);
    expect(maximum).toBe(7);
    expect([...seen].sort((left, right) => left - right)).toEqual([3, 4, 5, 6, 7]);
  });

  it('refuse des bornes invalides', () => {
    const stream = forkStream(SEED, 'test:int');
    expect(() => stream.nextInt(5, 1)).toThrow(RangeError);
    expect(() => stream.nextInt(0.5, 3)).toThrow(TypeError);
    expect(() => stream.nextInt(0, 0x1_0000_0001)).toThrow(RangeError);
  });

  it('finit par choisir chaque élément avec pick', () => {
    const items = ['a', 'b', 'c', 'd'] as const;
    const stream = forkStream(SEED, 'test:pick');
    const seen = new Set<string>();

    for (let index = 0; index < 1_000; index += 1) {
      seen.add(stream.pick(items));
    }

    expect([...seen].sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('refuse les entrées incohérentes', () => {
    const stream = forkStream(SEED, 'test:invalid');
    expect(() => stream.pick([])).toThrow(RangeError);
    expect(() => stream.weightedPick([], [])).toThrow(RangeError);
    expect(() => stream.weightedPick(['a', 'b'], [1])).toThrow(RangeError);
    expect(() => stream.weightedPick(['a', 'b'], [1, -1])).toThrow(RangeError);
    expect(() => stream.weightedPick(['a', 'b'], [0, 0])).toThrow(RangeError);
  });
});

describe("verrouillage de l'algorithme", () => {
  it('conserve les mêmes tirages pour une seed et un label donnés', () => {
    // Ces valeurs décrivent le générateur lui-même, pas le résultat d'une course : elles
    // détectent toute modification accidentelle des constantes ou des opérations, qui
    // casserait la reproductibilité de toutes les courses déjà partagées.
    const stream = forkStream(0, 'lock');
    expect([stream.next(), stream.next(), stream.next(), stream.next()]).toEqual([
      263_522_509, 2_789_401_385, 4_190_843_444, 119_588_659,
    ]);
  });
});
