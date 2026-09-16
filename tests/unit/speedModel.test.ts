import { describe, expect, it } from 'vitest';

import { GAME_CONFIG, RACE_CONFIG, SPEED } from '../../src/core/config';
import { computeTargetSpeed, integratePosition, integrateSpeed } from '../../src/core/speedModel';
import type { CharacterState } from '../../src/core/types';

const EPS = 1e-12;
const DT = RACE_CONFIG.DT_S;
const ACCEL_STEP = SPEED.MAX_ACCEL * DT;
const DECEL_STEP = SPEED.MAX_DECEL * DT;

function character(overrides: Partial<CharacterState> = {}): CharacterState {
  return {
    id: 'c0',
    x: 0,
    v: SPEED.BASE,
    drift: 0,
    surge: 0,
    eventBonus: 0,
    activeEvent: null,
    ...overrides,
  };
}

describe('computeTargetSpeed', () => {
  it('vaut SPEED.BASE quand la dérive est nulle', () => {
    expect(computeTargetSpeed(character(), GAME_CONFIG)).toBe(SPEED.BASE);
  });

  it('applique la dérive de façon relative', () => {
    expect(computeTargetSpeed(character({ drift: 0.2 }), GAME_CONFIG)).toBe(SPEED.BASE * 1.2);
    expect(computeTargetSpeed(character({ drift: -0.2 }), GAME_CONFIG)).toBe(SPEED.BASE * 0.8);
    expect(computeTargetSpeed(character({ drift: 0.05 }), GAME_CONFIG)).toBe(SPEED.BASE * 1.05);
  });

  it('est symétrique : une dérive opposée produit l’écart opposé', () => {
    const fast = computeTargetSpeed(character({ drift: 0.11 }), GAME_CONFIG);
    const slow = computeTargetSpeed(character({ drift: -0.11 }), GAME_CONFIG);

    expect(fast - SPEED.BASE).toBeCloseTo(SPEED.BASE - slow, 12);
  });

  it('ignore encore surge et eventBonus : ils appartiennent à P007 et P008', () => {
    const plain = computeTargetSpeed(character(), GAME_CONFIG);
    const loaded = computeTargetSpeed(
      character({ surge: 0.35, eventBonus: 0.75 }),
      GAME_CONFIG,
    );

    // Garde-fou : brancher l'un ou l'autre ici introduirait une règle de jeu non calibrée.
    expect(loaded).toBe(plain);
  });
});

describe('integrateSpeed', () => {
  it('monte au maximum de MAX_ACCEL × DT par pas', () => {
    // Comparaison à l'expression exacte, pas à `ACCEL_STEP` : `12 + 0,166…  − 12` perd des bits
    // par annulation, ce qui n'a rien à voir avec une erreur de rampe.
    expect(integrateSpeed(SPEED.BASE, SPEED.BASE + 100, GAME_CONFIG, DT)).toBe(
      SPEED.BASE + ACCEL_STEP,
    );
  });

  it('descend au maximum de MAX_DECEL × DT par pas — pas de MAX_ACCEL en descente', () => {
    const next = integrateSpeed(SPEED.BASE, 0, GAME_CONFIG, DT);
    const delta = next - SPEED.BASE;

    expect(next).toBe(SPEED.BASE - DECEL_STEP);
    expect(-delta).toBeGreaterThan(ACCEL_STEP);
    expect(-delta).toBeLessThanOrEqual(DECEL_STEP + EPS);
  });

  it('atteint exactement la cible quand elle est à portée d’un pas', () => {
    expect(integrateSpeed(SPEED.BASE, SPEED.BASE + 0.001, GAME_CONFIG, DT)).toBe(
      SPEED.BASE + 0.001,
    );
    expect(integrateSpeed(SPEED.BASE, SPEED.BASE - 0.001, GAME_CONFIG, DT)).toBe(
      SPEED.BASE - 0.001,
    );
  });

  it('ne change rien quand la vitesse est déjà la cible', () => {
    expect(integrateSpeed(SPEED.BASE, SPEED.BASE, GAME_CONFIG, DT)).toBe(SPEED.BASE);
  });

  it('écrête dans [SPEED.MIN, SPEED.MAX], même avec une cible absurde', () => {
    let v = SPEED.BASE;

    for (let step = 0; step < 1000; step += 1) {
      v = integrateSpeed(v, 1e9, GAME_CONFIG, DT);
    }
    expect(v).toBe(SPEED.MAX);

    for (let step = 0; step < 1000; step += 1) {
      v = integrateSpeed(v, -1e9, GAME_CONFIG, DT);
    }
    expect(v).toBe(SPEED.MIN);
  });

  it('reste dans les bornes sur toutes les cibles atteignables par le drift', () => {
    for (const drift of [-0.2, -0.13, 0, 0.13, 0.2]) {
      const target = computeTargetSpeed(character({ drift }), GAME_CONFIG);
      const v = integrateSpeed(SPEED.BASE, target, GAME_CONFIG, DT);
      expect(v).toBeGreaterThanOrEqual(SPEED.MIN);
      expect(v).toBeLessThanOrEqual(SPEED.MAX);
    }
  });
});

describe('integratePosition', () => {
  it('applique exactement x_next = x + v × DT', () => {
    expect(integratePosition(100, SPEED.BASE, DT)).toBe(100 + SPEED.BASE * DT);
    expect(integratePosition(0, 7.5, DT)).toBe(7.5 * DT);
  });

  it('ne bouge pas une position à vitesse nulle', () => {
    expect(integratePosition(42.5, 0, DT)).toBe(42.5);
  });

  it('est strictement croissante pour une vitesse positive', () => {
    let x = 0;
    for (let step = 0; step < 500; step += 1) {
      const next = integratePosition(x, SPEED.BASE, DT);
      expect(next).toBeGreaterThan(x);
      x = next;
    }
  });

  it('n’ajoute que v × DT, quelle que soit la position de départ', () => {
    // Aucun rattrapage, aucun recentrage, aucun plafond d'arrivée : le delta ne dépend pas de `x`.
    for (const x of [0, 10, 1000, 100_000]) {
      expect(integratePosition(x, SPEED.BASE, DT)).toBe(x + SPEED.BASE * DT);
    }
  });
});
