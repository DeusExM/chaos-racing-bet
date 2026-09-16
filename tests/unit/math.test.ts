import { describe, expect, it } from 'vitest';

import { CHARACTER_IDS } from '../../src/core/characters';
import { DRIFT, RACE_CONFIG, SPEED, SQRT_DT } from '../../src/core/config';
import { approach, gaussianFrom, lerp, stepOrnsteinUhlenbeck } from '../../src/core/math';
import type { OrnsteinUhlenbeckParams } from '../../src/core/math';
import { forkStream } from '../../src/core/rng';
import { normalizeSeed } from '../../src/core/seed';

/**
 * Tests des primitives mathématiques de P004. `clamp` est couvert par `smoke.test.ts`.
 *
 * Comparaisons flottantes : les bornes de rampe sont atteintes par des produits et des sommes, donc
 * une marge infime (`EPS`) évite qu'un arrondi légitime soit pris pour un dépassement.
 */
const EPS = 1e-12;

const DT = RACE_CONFIG.DT_S;
const ACCEL_STEP = SPEED.MAX_ACCEL * DT;
const DECEL_STEP = SPEED.MAX_DECEL * DT;

const OU_PARAMS: OrnsteinUhlenbeckParams = {
  dt: DT,
  theta: DRIFT.THETA,
  sigma: DRIFT.SIGMA,
  sqrtDt: SQRT_DT,
  clampValue: DRIFT.CLAMP,
};

describe('lerp', () => {
  it('interpole entre deux valeurs', () => {
    expect(lerp(0, 10, 0.5)).toBe(5);
    expect(lerp(10, 0, 0.25)).toBe(7.5);
    expect(lerp(-4, 4, 0.75)).toBe(2);
  });

  it('retourne exactement les bornes aux extrémités', () => {
    expect(lerp(3, 17, 0)).toBe(3);
    expect(lerp(3, 17, 1)).toBe(17);
  });

  it('autorise l’extrapolation hors de [0, 1]', () => {
    expect(lerp(0, 10, 2)).toBe(20);
    expect(lerp(0, 10, -0.5)).toBe(-5);
  });

  it('reste exact sur une valeur constante', () => {
    expect(lerp(7, 7, 0.42)).toBe(7);
  });
});

describe('gaussianFrom', () => {
  it('délègue au générateur unique du noyau, sans second algorithme', () => {
    const viaHelper = forkStream(normalizeSeed('GAUSS'), 'test:gauss');
    const direct = forkStream(normalizeSeed('GAUSS'), 'test:gauss');

    for (let index = 0; index < 200; index += 1) {
      expect(gaussianFrom(viaHelper)).toBe(direct.nextGaussian());
    }
  });

  it('consomme exactement un tirage par appel', () => {
    const consumed = forkStream(normalizeSeed('GAUSS'), 'test:count');
    const witness = forkStream(normalizeSeed('GAUSS'), 'test:count');

    gaussianFrom(consumed);
    witness.nextGaussian();

    // Si `gaussianFrom` consommait un nombre de tirages différent, la suite du flux divergerait.
    expect(consumed.next()).toBe(witness.next());
  });

  it('reste dans les bornes de l’approximation déterministe (somme de 12 uniformes)', () => {
    const stream = forkStream(normalizeSeed('GAUSS'), 'test:bounds');
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    const count = 20_000;

    for (let index = 0; index < count; index += 1) {
      const value = gaussianFrom(stream);
      min = Math.min(min, value);
      max = Math.max(max, value);
      sum += value;
    }

    // 12 uniformes centrées : la somme appartient nécessairement à [−6, +6].
    expect(min).toBeGreaterThanOrEqual(-6);
    expect(max).toBeLessThanOrEqual(6);
    expect(Math.abs(sum / count)).toBeLessThan(0.1);
  });

  it('produit deux suites identiques pour deux flux de même nom', () => {
    const a = forkStream(normalizeSeed('GAUSS'), 'test:same');
    const b = forkStream(normalizeSeed('GAUSS'), 'test:same');

    for (let index = 0; index < 50; index += 1) {
      expect(gaussianFrom(a)).toBe(gaussianFrom(b));
    }
  });
});

describe('stepOrnsteinUhlenbeck', () => {
  it('applique exactement la formule du GAME_DESIGN §6.3', () => {
    const drift = 0.07;
    const gaussian = 1.3;
    const expected =
      drift - DRIFT.THETA * drift * DT + DRIFT.SIGMA * SQRT_DT * gaussian;

    expect(stepOrnsteinUhlenbeck(drift, gaussian, OU_PARAMS)).toBe(expected);
  });

  it('ne bouge pas à drift nul et bruit nul', () => {
    expect(stepOrnsteinUhlenbeck(0, 0, OU_PARAMS)).toBe(0);
  });

  it('ramène le drift vers zéro quand le bruit est nul', () => {
    const next = stepOrnsteinUhlenbeck(DRIFT.CLAMP, 0, OU_PARAMS);
    expect(next).toBeLessThan(DRIFT.CLAMP);
    expect(next).toBeGreaterThan(0);
  });

  it('écrête à ±CLAMP, jamais au-delà', () => {
    expect(stepOrnsteinUhlenbeck(0, 1000, OU_PARAMS)).toBe(DRIFT.CLAMP);
    expect(stepOrnsteinUhlenbeck(0, -1000, OU_PARAMS)).toBe(-DRIFT.CLAMP);
  });

  it('ne franchit jamais ±CLAMP sur une longue suite réelle', () => {
    const stream = forkStream(normalizeSeed('OU'), 'drift:c0');
    let drift = 0;
    let violations = 0;
    let maxAbs = 0;

    for (let step = 0; step < 50_000; step += 1) {
      drift = stepOrnsteinUhlenbeck(drift, gaussianFrom(stream), OU_PARAMS);
      maxAbs = Math.max(maxAbs, Math.abs(drift));
      if (Math.abs(drift) > DRIFT.CLAMP) {
        violations += 1;
      }
    }

    expect(violations).toBe(0);
    expect(maxAbs).toBeLessThanOrEqual(DRIFT.CLAMP);
    // Le processus doit réellement explorer son domaine, pas rester collé à zéro.
    expect(maxAbs).toBeGreaterThan(0.15);
  });

  it('utilise √DT pré-calculé, exactement égal à DT au carré', () => {
    // Vérification algébrique : on ne calcule jamais de racine, on élève au carré.
    expect(SQRT_DT * SQRT_DT).toBeCloseTo(DT, 12);
  });
});

describe('drift — statistiques stationnaires', () => {
  /**
   * Nombre de tirages agrégés.
   *
   * Un **seul** processus de 30 000 pas ne suffit pas à vérifier `moyenne ≈ 0 (±0,01)` : l'écart-type
   * de sa moyenne vaut ≈ 0,0126 (temps de corrélation `1/THETA = 4 s`), donc le seuil serait franchi
   * une fois sur deux par simple bruit. On agrège donc des processus **indépendants** — 6
   * personnages × 12 seeds — ce qui fait tomber cet écart-type à ≈ 0,0015.
   */
  const SEEDS = Array.from({ length: 12 }, (_, index) =>
    `DRIFTST${index}`.padEnd(8, 'X').slice(0, 8),
  );
  const STEPS_PER_RUN = 30_000;

  /**
   * Écart-type stationnaire **effectif** du drift, mesuré sur les 2 160 000 tirages ci-dessous.
   *
   * Il est inférieur au `DRIFT.STATIONARY_SD` théorique (0,1273) parce que `CLAMP = 0,20` coupe à
   * 1,57 σ : l'écrêtage n'est pas un filet de sécurité lointain, il participe réellement à la
   * dynamique et comprime la distribution d'environ 22 %. Avec un écrêtage non contraignant, on
   * retrouve exactement la valeur théorique — c'est ce que vérifie le test suivant.
   */
  const EFFECTIVE_SD = 0.0997;

  interface Aggregate {
    readonly mean: number;
    readonly sd: number;
    readonly maxAbs: number;
    readonly count: number;
    readonly perCharacter: readonly number[];
  }

  function aggregate(clampValue: number): Aggregate {
    const params: OrnsteinUhlenbeckParams = { ...OU_PARAMS, clampValue };
    const perCharacter: number[] = [];
    let sum = 0;
    let sumSq = 0;
    let count = 0;
    let maxAbs = 0;

    for (const id of CHARACTER_IDS) {
      let cSum = 0;
      let cSumSq = 0;
      let cCount = 0;

      for (const seed of SEEDS) {
        const stream = forkStream(normalizeSeed(seed), `drift:${id}`);
        let drift = 0;
        for (let step = 0; step < STEPS_PER_RUN; step += 1) {
          drift = stepOrnsteinUhlenbeck(drift, gaussianFrom(stream), params);
          maxAbs = Math.max(maxAbs, Math.abs(drift));
          cSum += drift;
          cSumSq += drift * drift;
          cCount += 1;
        }
      }

      const cMean = cSum / cCount;
      perCharacter.push(Math.sqrt(cSumSq / cCount - cMean * cMean));
      sum += cSum;
      sumSq += cSumSq;
      count += cCount;
    }

    const mean = sum / count;
    return { mean, sd: Math.sqrt(sumSq / count - mean * mean), maxAbs, count, perCharacter };
  }

  it('reste centré, borné et d’écart-type stable sur 2 160 000 tirages', () => {
    const stats = aggregate(DRIFT.CLAMP);

    expect(stats.count).toBe(SEEDS.length * CHARACTER_IDS.length * STEPS_PER_RUN);
    expect(Math.abs(stats.mean)).toBeLessThan(0.01);
    expect(stats.maxAbs).toBeLessThanOrEqual(DRIFT.CLAMP);

    const relativeSd = Math.abs(stats.sd - EFFECTIVE_SD) / EFFECTIVE_SD;
    expect(relativeSd).toBeLessThan(0.15);

    // Aucun personnage ne dérive différemment : les 6 flux ont la même loi.
    for (const characterSd of stats.perCharacter) {
      expect(Math.abs(characterSd - stats.sd) / stats.sd).toBeLessThan(0.15);
    }
  });

  it('retrouve exactement l’écart-type théorique SIGMA / √(2·THETA) sans écrêtage', () => {
    // Diagnostic : si l'écrêtage devient non contraignant, le processus doit retrouver la valeur
    // normative du GAME_DESIGN §6.3. C'est la preuve que l'étape d'Ornstein–Uhlenbeck et le bruit
    // sont correctement calibrés, et que l'écart observé plus haut vient bien de `CLAMP`.
    const theoretical = DRIFT.SIGMA / Math.sqrt(2 * DRIFT.THETA);
    const stats = aggregate(10);

    expect(theoretical).toBeCloseTo(DRIFT.STATIONARY_SD, 12);
    expect(Math.abs(stats.sd - theoretical) / theoretical).toBeLessThan(0.15);
    expect(Math.abs(stats.mean)).toBeLessThan(0.01);
  });
});

describe('approach — progressivité directionnelle', () => {
  it('borne la montée par MAX_ACCEL × DT et la descente par MAX_DECEL × DT sur 50 000 cas', () => {
    const stream = forkStream(normalizeSeed('APPROACH'), 'test:approach');
    let upViolations = 0;
    let downViolations = 0;
    let overshoots = 0;
    let upward = 0;
    let downward = 0;
    let rampBoundHits = 0;
    const cases = 50_000;

    for (let index = 0; index < cases; index += 1) {
      const current = lerp(-500, 500, stream.nextFloat());
      const target = lerp(-2000, 2000, stream.nextFloat());
      const next = approach(current, target, SPEED.MAX_ACCEL, SPEED.MAX_DECEL, DT);
      const delta = next - current;

      if (delta >= 0) {
        upward += 1;
        if (delta > ACCEL_STEP + EPS) {
          upViolations += 1;
        }
      } else {
        downward += 1;
        if (-delta > DECEL_STEP + EPS) {
          downViolations += 1;
        }
      }

      if (Math.abs(Math.abs(delta) - ACCEL_STEP) < EPS || Math.abs(Math.abs(delta) - DECEL_STEP) < EPS) {
        rampBoundHits += 1;
      }

      // La cible n'est jamais franchie : on s'arrête dessus, on ne la dépasse pas.
      if (target >= current ? next > target + EPS : next < target - EPS) {
        overshoots += 1;
      }
    }

    expect(upViolations).toBe(0);
    expect(downViolations).toBe(0);
    expect(overshoots).toBe(0);
    // Les deux branches, et la saturation de rampe, doivent réellement être exercées.
    expect(upward).toBeGreaterThan(cases / 4);
    expect(downward).toBeGreaterThan(cases / 4);
    expect(rampBoundHits).toBeGreaterThan(cases / 2);
  });

  it('atteint exactement la cible quand elle est proche', () => {
    expect(approach(10, 10.01, SPEED.MAX_ACCEL, SPEED.MAX_DECEL, DT)).toBe(10.01);
    expect(approach(10, 9.99, SPEED.MAX_ACCEL, SPEED.MAX_DECEL, DT)).toBe(9.99);
    expect(approach(10, 10, SPEED.MAX_ACCEL, SPEED.MAX_DECEL, DT)).toBe(10);
  });

  it('autorise une descente plus raide qu’une montée — non-régression de la correction', () => {
    // Si MAX_ACCEL était appliqué aux deux directions, la descente serait bornée à ACCEL_STEP.
    const rise = approach(0, 1000, SPEED.MAX_ACCEL, SPEED.MAX_DECEL, DT);
    const fall = approach(0, -1000, SPEED.MAX_ACCEL, SPEED.MAX_DECEL, DT);

    expect(rise).toBe(ACCEL_STEP);
    expect(fall).toBe(-DECEL_STEP);
    expect(-fall).toBeGreaterThan(ACCEL_STEP);
    expect(-fall).toBeLessThanOrEqual(DECEL_STEP + EPS);
    // Écart volontaire entre les deux limites : la config doit le conserver.
    expect(SPEED.MAX_DECEL).not.toBe(SPEED.MAX_ACCEL);
  });

  it('n’avance pas quand le pas de temps est nul', () => {
    expect(approach(10, 1000, SPEED.MAX_ACCEL, SPEED.MAX_DECEL, 0)).toBe(10);
  });
});
