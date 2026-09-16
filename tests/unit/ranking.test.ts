import { describe, expect, it } from 'vitest';

import { SPEED } from '../../src/core/config';
import { computeRanks, gapMeters, gapSeconds, isLeaderChange, sortByRank } from '../../src/core/ranking';
import { forkStream } from '../../src/core/rng';
import type { CharacterId } from '../../src/core/types';

const IDS: readonly CharacterId[] = ['c0', 'c1', 'c2', 'c3', 'c4', 'c5'];

function idAt(index: number): CharacterId {
  const id = IDS[index];
  if (id === undefined) {
    throw new Error(`Index ${index} hors roster.`);
  }
  return id;
}

function at(values: readonly number[], index: number): number {
  const value = values[index];
  if (value === undefined) {
    throw new Error(`Index ${index} hors tableau.`);
  }
  return value;
}

describe('computeRanks', () => {
  it('classe par distance décroissante', () => {
    // c1 (30 m) devant c2 (20 m) devant c0 (10 m).
    expect(computeRanks([10, 30, 20], ['c0', 'c1', 'c2'])).toEqual([3, 1, 2]);
  });

  it('départage une égalité stricte par identifiant croissant', () => {
    expect(computeRanks([100, 100, 100], ['c0', 'c1', 'c2'])).toEqual([1, 2, 3]);
  });

  it('départage selon l’identifiant, jamais selon la position dans le tableau', () => {
    // Mêmes distances, mais les tableaux sont présentés dans l'ordre inverse : le classement par
    // personnage est identique, seul l'alignement des rangs change.
    expect(computeRanks([100, 100], ['c0', 'c1'])).toEqual([1, 2]);
    expect(computeRanks([100, 100], ['c1', 'c0'])).toEqual([2, 1]);
  });

  it('attribue exactement un rang 1 et des rangs contigus', () => {
    const random = forkStream(4_242_000, 'test:ranking-contiguity');
    let violations = 0;

    for (let round = 0; round < 2_000; round += 1) {
      const xs = IDS.map(() => random.nextInt(0, 12) * 3.5);
      const ranks = [...computeRanks(xs, IDS)].sort((a, b) => a - b);

      for (const [index, rank] of ranks.entries()) {
        if (rank !== index + 1) {
          violations += 1;
        }
      }
    }

    expect(violations).toBe(0);
  });

  it('gère les cas limites sans planter', () => {
    expect(computeRanks([], [])).toEqual([]);
    expect(computeRanks([7], ['c0'])).toEqual([1]);
  });
});

describe('classement dérivé des seules distances (test de propriété)', () => {
  it('vérifie sur 10 000 tableaux que rang_i < rang_j équivaut à « i devance j »', () => {
    const random = forkStream(20_260_214, 'test:ranking-property');
    let comparisons = 0;
    let violations = 0;

    for (let round = 0; round < 10_000; round += 1) {
      // Des entiers petits pour provoquer de nombreuses égalités exactes : c'est là que le
      // départage doit rester déterministe.
      const xs = IDS.map(() => random.nextInt(0, 8));
      const ranks = computeRanks(xs, IDS);

      for (const [i, xi] of xs.entries()) {
        for (const [j, xj] of xs.entries()) {
          if (i === j) {
            continue;
          }
          comparisons += 1;

          const iAhead = xi > xj || (xi === xj && idAt(i) < idAt(j));
          const rankI = at(ranks, i);
          const rankJ = at(ranks, j);
          if ((rankI < rankJ) !== iAhead) {
            violations += 1;
          }
        }
      }
    }

    expect(comparisons).toBe(10_000 * IDS.length * (IDS.length - 1));
    expect(violations).toBe(0);
  });

  it('donne le même classement quels que soient les appels qui l’entourent', () => {
    const xs = [42, 17, 42, 99, 17, 60];
    const reference = computeRanks(xs, IDS);

    computeRanks([1, 2, 3, 4, 5, 6], IDS);
    sortByRank(xs, IDS);
    computeRanks([...xs].reverse(), IDS);
    gapMeters(xs);

    expect(computeRanks(xs, IDS)).toEqual(reference);
    expect(computeRanks([...xs], IDS)).toEqual(reference);
  });

  it('donne le même résultat à chaque appel et ne modifie jamais les distances reçues', () => {
    const xs = [10, 30, 20, 30, 10, 0];
    const ids: readonly CharacterId[] = IDS;
    const xsBefore = [...xs];

    const first = computeRanks(xs, ids);
    sortByRank(xs, ids);
    gapMeters(xs);
    gapSeconds(xs);
    const second = computeRanks(xs, ids);

    expect(second).toEqual(first);
    expect(xs).toEqual(xsBefore);
    expect(ids).toEqual(['c0', 'c1', 'c2', 'c3', 'c4', 'c5']);
  });
});

describe('sortByRank', () => {
  it('ordonne les indices du premier au dernier', () => {
    // c1 (30 m) puis c2 (20 m) puis c0 (10 m).
    expect(sortByRank([10, 30, 20], ['c0', 'c1', 'c2'])).toEqual([1, 2, 0]);
  });

  it('reste cohérent avec computeRanks et stable entre deux appels', () => {
    const random = forkStream(777_000, 'test:ranking-sort-consistency');
    let violations = 0;

    for (let round = 0; round < 1_000; round += 1) {
      const xs = IDS.map(() => random.nextInt(0, 6));
      const order = sortByRank(xs, IDS);
      const ranks = computeRanks(xs, IDS);

      for (const [position, index] of order.entries()) {
        if (at(ranks, index) !== position + 1) {
          violations += 1;
        }
      }

      if (JSON.stringify(order) !== JSON.stringify(sortByRank(xs, IDS))) {
        violations += 1;
      }
    }

    expect(violations).toBe(0);
  });
});

describe('écarts', () => {
  it('mesure l’écart en mètres avec le leader', () => {
    expect(gapMeters([100, 60, 80])).toEqual([0, 40, 20]);
  });

  it('donne exactement zéro au leader et jamais une valeur négative', () => {
    expect(at(gapMeters([100, 60, 80]), 0)).toBe(0);

    const random = forkStream(9_001, 'test:ranking-gaps');
    let violations = 0;
    let leaders = 0;

    for (let round = 0; round < 1_000; round += 1) {
      const xs = IDS.map(() => random.nextFloat() * 2_000);
      let leaderDistance = Number.NEGATIVE_INFINITY;
      for (const x of xs) {
        if (x > leaderDistance) {
          leaderDistance = x;
        }
      }

      for (const [index, gap] of gapMeters(xs).entries()) {
        if (gap < 0) {
          violations += 1;
        }
        if (gap === 0 && at(xs, index) === leaderDistance) {
          leaders += 1;
        }
      }
    }

    expect(violations).toBe(0);
    expect(leaders).toBe(1_000);
  });

  it('exprime l’écart en secondes avec la vitesse de base', () => {
    const xs = [100, 60, 80];
    const expected = gapMeters(xs).map((gap) => gap / SPEED.BASE);

    expect(gapSeconds(xs)).toEqual(expected);
    expect(gapSeconds(xs)).toEqual([0, 40 / 12, 20 / 12]);
  });

  it('ne produit rien pour un peloton vide', () => {
    expect(gapMeters([])).toEqual([]);
    expect(gapSeconds([])).toEqual([]);
  });
});

describe('isLeaderChange', () => {
  it('signale un changement de leader', () => {
    expect(isLeaderChange([2, 1, 3], [1, 2, 3])).toBe(true);
  });

  it('ne signale rien quand le leader ne change pas', () => {
    expect(isLeaderChange([1, 2, 3], [1, 3, 2])).toBe(false);
    expect(isLeaderChange([2, 1, 3], [3, 1, 2])).toBe(false);
  });

  it('rejette un relevé sans rang 1', () => {
    expect(() => isLeaderChange([2, 2, 3], [1, 2, 3])).toThrow(RangeError);
  });
});

describe('robustesse des entrées', () => {
  it('refuse des tableaux de longueurs différentes', () => {
    expect(() => computeRanks([1, 2], ['c0'])).toThrow(RangeError);
    expect(() => isLeaderChange([1, 2], [1])).toThrow(RangeError);
  });

  it('refuse deux fois le même identifiant', () => {
    expect(() => computeRanks([1, 2], ['c0', 'c0'])).toThrow(/deux fois/);
  });

  it('refuse une distance non finie', () => {
    expect(() => computeRanks([1, Number.NaN], ['c0', 'c1'])).toThrow(RangeError);
    expect(() => gapMeters([1, Number.POSITIVE_INFINITY])).toThrow(RangeError);
  });

  it('refuse un rang qui n’est pas un entier positif', () => {
    expect(() => isLeaderChange([1, 0], [1, 2])).toThrow(RangeError);
    expect(() => isLeaderChange([1, 1.5], [1, 2])).toThrow(RangeError);
  });
});
