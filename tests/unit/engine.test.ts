import { describe, expect, it } from 'vitest';

import { CHARACTER_IDS } from '../../src/core/characters';
import type { GameConfig } from '../../src/core/config';
import { DRIFT, GAME_CONFIG, RACE_CONFIG, SPEED, SQRT_DT } from '../../src/core/config';
import { RaceEngine } from '../../src/core/engine';
import { gaussianFrom, stepOrnsteinUhlenbeck } from '../../src/core/math';
import type { OrnsteinUhlenbeckParams } from '../../src/core/math';
import { forkStream } from '../../src/core/rng';
import { normalizeSeed } from '../../src/core/seed';
import { computeTargetSpeed, integratePosition, integrateSpeed } from '../../src/core/speedModel';
import type { CharacterState } from '../../src/core/types';

/** Égalité de types, évaluée par le compilateur : voir `types.test.ts`. */
type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

const DT = RACE_CONFIG.DT_S;
const SEED = 'K7QM2X9A';
const ACCEL_STEP = SPEED.MAX_ACCEL * DT;
const DECEL_STEP = SPEED.MAX_DECEL * DT;

/** `step()` ne prend **aucun** argument : aucun `dt` externe n'est donc injectable. */
const stepTakesNoArgument: Equals<Parameters<RaceEngine['step']>, []> = true;

/** Même config, vitesses mises à l'échelle : sert à prouver que la distance ne décide de rien. */
function withScaledSpeed(factor: number): GameConfig {
  return {
    ...GAME_CONFIG,
    SPEED: {
      ...GAME_CONFIG.SPEED,
      MIN: GAME_CONFIG.SPEED.MIN * factor,
      BASE: GAME_CONFIG.SPEED.BASE * factor,
      MAX: GAME_CONFIG.SPEED.MAX * factor,
    },
  };
}

describe('construction et état initial', () => {
  it('aligne les 6 personnages sur la ligne de départ, tous strictement identiques', () => {
    const state = new RaceEngine(SEED).getState();

    expect(state.characters.map((character) => character.id)).toEqual(CHARACTER_IDS);
    for (const character of state.characters) {
      expect(character.x).toBe(0);
      expect(character.v).toBe(SPEED.BASE);
      expect(character.drift).toBe(0);
      expect(character.surge).toBe(0);
      expect(character.eventBonus).toBe(0);
      expect(character.activeEvent).toBeNull();
    }
  });

  it('démarre à tSim = 0, steps = 0, en phase idle', () => {
    const state = new RaceEngine(SEED).getState();

    expect(state.tSim).toBe(0);
    expect(state.steps).toBe(0);
    expect(state.phase).toEqual({ kind: 'idle' });
  });

  it('expose la seed affichée et sa valeur 32 bits', () => {
    const state = new RaceEngine(SEED).getState();

    expect(state.seed).toBe(SEED);
    expect(state.seedValue).toBe(normalizeSeed(SEED));
  });

  it('ne produit aucun fait avant la course', () => {
    const engine = new RaceEngine(SEED);

    expect(engine.drainFacts()).toEqual([]);

    // P006 : une course complète produit exactement les trois splits de checkpoint, et rien d'autre.
    engine.runToCompletion();
    const facts = engine.drainFacts();
    expect(facts.map((fact) => fact.type)).toEqual([
      'CHECKPOINT_SPLIT',
      'CHECKPOINT_SPLIT',
      'CHECKPOINT_SPLIT',
    ]);
  });

  it('refuse une configuration incohérente', () => {
    const broken: GameConfig = { ...GAME_CONFIG, SPEED: { ...GAME_CONFIG.SPEED, BASE: -1 } };
    expect(() => new RaceEngine(SEED, broken)).toThrow(RangeError);
  });
});

describe('step() avance d’un pas fixe, sans argument', () => {
  it('ne prend aucun argument, ni au type ni à l’exécution', () => {
    expect(stepTakesNoArgument).toBe(true);
    expect(RaceEngine.prototype.step).toHaveLength(0);
  });

  it('avance d’exactement DT par appel', () => {
    const engine = new RaceEngine(SEED);
    engine.step();
    const state = engine.getState();

    expect(state.steps).toBe(1);
    expect(state.tSim).toBe(DT);
  });

  it('tombe exactement sur 45, 90, 135 et 180 secondes', () => {
    // Contrat P003 : `tSim = steps × DT_S` par multiplication. Une accumulation flottante
    // donnerait 44.99999999999873 puis 180.00000000003539 et raterait les checkpoints.
    const engine = new RaceEngine(SEED);
    const marks: readonly (readonly [number, number])[] = [
      [2700, 45],
      [5400, 90],
      [8100, 135],
      [10_800, 180],
    ];

    for (const [steps, seconds] of marks) {
      while (engine.getState().steps < steps) {
        engine.step();
      }
      const state = engine.getState();
      expect(state.steps).toBe(steps);
      expect(state.tSim).toBe(seconds);
    }
  });
});

describe('phase', () => {
  it('passe en running dès le premier pas, avec un segment en base 1', () => {
    const engine = new RaceEngine(SEED);
    engine.step();

    expect(engine.getState().phase).toEqual({
      kind: 'running',
      segment: 1,
      segmentElapsedS: DT,
    });
  });

  it('change de segment exactement aux bornes de 45 s, sans jamais dépasser 4', () => {
    const engine = new RaceEngine(SEED);
    const seen = new Set<number>();
    const kinds = new Set<string>();

    for (let step = 0; step < RACE_CONFIG.TOTAL_STEPS; step += 1) {
      engine.step();
      const phase = engine.getState().phase;
      kinds.add(phase.kind);
      if (phase.kind === 'running') {
        seen.add(phase.segment);
      }
    }

    expect([...seen].sort()).toEqual([1, 2, 3, 4]);
    // Aucun état de pause, de checkpoint ou de compte à rebours n'existe dans le noyau.
    expect([...kinds].sort()).toEqual(['finished', 'running']);
  });

  it('repasse le temps du segment à zéro à chaque borne', () => {
    const engine = new RaceEngine(SEED);
    while (engine.getState().steps < 2700) {
      engine.step();
    }

    expect(engine.getState().phase).toEqual({
      kind: 'running',
      segment: 2,
      segmentElapsedS: 0,
    });
  });
});

describe('fin de course uniquement par le temps', () => {
  it('fait exactement 10 800 pas et tSim = 180', () => {
    const engine = new RaceEngine(SEED);
    const result = engine.runToCompletion();
    const state = engine.getState();

    expect(state.steps).toBe(RACE_CONFIG.TOTAL_STEPS);
    expect(state.steps).toBe(10_800);
    expect(state.tSim).toBe(RACE_CONFIG.TOTAL_SIM_S);
    expect(state.tSim).toBe(180);
    expect(state.phase).toEqual({ kind: 'finished' });
    expect(result.tSim).toBe(180);
    expect(result.ranking).toHaveLength(6);
    expect(result.distances).toHaveLength(6);
  });

  it('se termine au même pas avec des vitesses divisées par 10', () => {
    const engine = new RaceEngine(SEED, withScaledSpeed(0.1));
    const result = engine.runToCompletion();

    expect(engine.getState().steps).toBe(10_800);
    expect(engine.getState().tSim).toBe(180);
    // Nominal 216 m, plus la dérive : la distance n'a aucune influence sur la fin.
    expect(Math.max(...result.distances)).toBeLessThan(240);
  });

  it('se termine au même pas avec des vitesses multipliées par 10', () => {
    const engine = new RaceEngine(SEED, withScaledSpeed(10));
    const result = engine.runToCompletion();

    expect(engine.getState().steps).toBe(10_800);
    expect(engine.getState().tSim).toBe(180);
    // Plus de 21 km parcourus : aucune distance n'est écrasée ni plafonnée à une valeur d'arrivée.
    expect(Math.max(...result.distances)).toBeGreaterThan(20_000);
  });

  it('classe les personnages par distance décroissante', () => {
    const result = new RaceEngine(SEED).runToCompletion();
    const distances = new Map(result.distances.map((distance, index) => [CHARACTER_IDS[index], distance]));

    for (let rank = 1; rank < result.ranking.length; rank += 1) {
      const ahead = distances.get(result.ranking[rank - 1] ?? 'c0') ?? 0;
      const behind = distances.get(result.ranking[rank] ?? 'c0') ?? 0;
      expect(ahead).toBeGreaterThanOrEqual(behind);
    }
  });
});

describe('après finished, step() ne fait plus rien', () => {
  it('gèle steps, tSim, phase, distances, vitesses et dérives', () => {
    const engine = new RaceEngine(SEED);
    engine.runToCompletion();
    const before = engine.getState();

    for (let call = 0; call < 1000; call += 1) {
      engine.step();
    }
    const after = engine.getState();

    expect(after.steps).toBe(before.steps);
    expect(after.tSim).toBe(before.tSim);
    expect(after.phase).toEqual(before.phase);
    expect(after.characters).toEqual(before.characters);
  });
});

describe('la position ne change que par l’intégration de la vitesse', () => {
  it('vérifie x(t) = x(t−1) + v(t) × DT à chaque pas, sur 3000 pas', () => {
    const engine = new RaceEngine(SEED);
    let positionViolations = 0;
    let accelViolations = 0;
    let decelViolations = 0;
    let speedBoundViolations = 0;
    let driftBoundViolations = 0;
    let rampHits = 0;
    let checked = 0;
    const steps = 3000;

    for (let step = 0; step < steps; step += 1) {
      const before = engine.getState();
      engine.step();
      const after = engine.getState();

      for (const [index, character] of after.characters.entries()) {
        const previous = before.characters[index];
        if (previous === undefined) {
          continue;
        }
        checked += 1;

        // Invariant §5.4 : aucune téléportation, aucun recentrage, aucun décalage.
        if (character.x !== integratePosition(previous.x, character.v, DT)) {
          positionViolations += 1;
        }

        // Invariant §5.7 : progressivité directionnelle, deux limites distinctes.
        const delta = character.v - previous.v;
        if (delta >= 0) {
          if (delta > ACCEL_STEP + 1e-12) {
            accelViolations += 1;
          }
        } else if (-delta > DECEL_STEP + 1e-12) {
          decelViolations += 1;
        }
        if (Math.abs(Math.abs(delta) - DECEL_STEP) < 1e-12) {
          rampHits += 1;
        }

        if (character.v < SPEED.MIN || character.v > SPEED.MAX) {
          speedBoundViolations += 1;
        }
        if (Math.abs(character.drift) > DRIFT.CLAMP) {
          driftBoundViolations += 1;
        }
      }
    }

    expect(checked).toBe(steps * 6);
    expect(positionViolations).toBe(0);
    expect(accelViolations).toBe(0);
    expect(decelViolations).toBe(0);
    expect(speedBoundViolations).toBe(0);
    expect(driftBoundViolations).toBe(0);
    // La rampe de décélération doit réellement être atteinte, sinon le test ne prouve rien.
    expect(rampHits).toBeGreaterThan(0);
  });
});

describe('déterminisme et reproductibilité', () => {
  it('donne des distances identiques bit à bit pour la même seed', () => {
    const first = new RaceEngine(SEED).runToCompletion();
    const second = new RaceEngine(SEED).runToCompletion();

    expect(first.distances).toEqual(second.distances);
    // Comparaison au niveau du bit : `toEqual` suffit pour des doubles finis, ceci le rend explicite.
    expect(new Float64Array(first.distances)).toEqual(new Float64Array(second.distances));
    expect(first.ranking).toEqual(second.ranking);
    expect(first.tSim).toBe(second.tSim);
  });

  it('donne un résultat différent pour une seed différente', () => {
    const first = new RaceEngine('K7QM2X9A').runToCompletion();
    const second = new RaceEngine('ZZZZZZZZ').runToCompletion();

    expect(first.distances).not.toEqual(second.distances);
  });

  it('rejoue exactement la même course après reset avec la même seed', () => {
    const engine = new RaceEngine('RACEWAY1');
    const first = engine.runToCompletion();

    engine.reset('RACEWAY1');
    expect(engine.getState().steps).toBe(0);
    const second = engine.runToCompletion();

    expect(second.distances).toEqual(first.distances);
    expect(second.ranking).toEqual(first.ranking);
  });

  it('change de course après reset avec une autre seed', () => {
    const engine = new RaceEngine('RACEWAY1');
    const first = engine.runToCompletion();

    engine.reset('BANAN4X2');
    const state = engine.getState();
    expect(state.seed).toBe('BANAN4X2');
    expect(state.seedValue).toBe(normalizeSeed('BANAN4X2'));
    expect(state.steps).toBe(0);
    expect(state.characters.every((character) => character.x === 0)).toBe(true);

    expect(engine.runToCompletion().distances).not.toEqual(first.distances);
  });
});

describe('indépendance des flux aléatoires', () => {
  it('fait évoluer c0 exactement comme s’il courait seul', () => {
    const engine = new RaceEngine(SEED);
    const stream = forkStream(normalizeSeed(SEED), 'drift:c0');
    const params: OrnsteinUhlenbeckParams = {
      dt: DT,
      theta: DRIFT.THETA,
      sigma: DRIFT.SIGMA,
      sqrtDt: SQRT_DT,
      clampValue: DRIFT.CLAMP,
    };

    let drift = 0;
    let v = SPEED.BASE;
    let x = 0;
    let violations = 0;

    for (let step = 0; step < 4000; step += 1) {
      engine.step();

      // Reconstruction indépendante, avec le seul flux de c0.
      drift = stepOrnsteinUhlenbeck(drift, gaussianFrom(stream), params);
      const probe: CharacterState = {
        id: 'c0',
        x,
        v,
        drift,
        surge: 0,
        eventBonus: 0,
        activeEvent: null,
      };
      v = integrateSpeed(v, computeTargetSpeed(probe, GAME_CONFIG), GAME_CONFIG, DT);
      x = integratePosition(x, v, DT);

      const character = engine.getState().characters[0];
      if (character?.x !== x || character.v !== v || character.drift !== drift) {
        violations += 1;
      }
    }

    // Si consommer les flux de c1..c5 décalait celui de c0, les deux suites divergeraient.
    expect(violations).toBe(0);
  });
});

describe('équivalence des 6 personnages', () => {
  /**
   * Le DoD demande « sur 200 000 pas ». On en fait volontairement beaucoup plus.
   *
   * La vitesse moyenne d'une course vaut exactement `x_final / tSim` : c'est la moyenne temporelle
   * des 10 800 vitesses, donc une mesure gratuite et exacte. Mais l'écart-type de cette moyenne sur
   * **une** course est de 2,1 %, ce qui laisse ±1,5 % à seulement 3 σ après 19 courses : un test
   * fragile, et effectivement franchi par une seed sur le premier jeu essayé. Sur 96 courses
   * (1 036 800 pas), l'écart-type tombe à 0,21 % et le seuil devient inatteignable par le hasard.
   */
  it('garde la vitesse moyenne de chaque personnage dans SPEED.BASE ± 1,5 %', () => {
    const races = 96;
    const totals = CHARACTER_IDS.map(() => 0);

    for (let race = 0; race < races; race += 1) {
      const engine = new RaceEngine(`EQUIV${String(race).padStart(3, '0')}`);
      const result = engine.runToCompletion();

      expect(engine.getState().steps).toBe(RACE_CONFIG.TOTAL_STEPS);
      result.distances.forEach((distance, index) => {
        totals[index] = (totals[index] ?? 0) + distance / result.tSim;
      });
    }

    const means = totals.map((total) => total / races);
    const grand = means.reduce((sum, mean) => sum + mean, 0) / means.length;

    for (const [index, mean] of means.entries()) {
      const relative = Math.abs(mean - SPEED.BASE) / SPEED.BASE;
      expect(relative, `${CHARACTER_IDS[index]} : ${(relative * 100).toFixed(3)} %`).toBeLessThan(
        0.015,
      );
    }

    // Moyenne globale : détecte un biais structurel, avec beaucoup plus de marge.
    expect(Math.abs(grand - SPEED.BASE) / SPEED.BASE).toBeLessThan(0.005);
    // Aucun id n'est favorisé : l'étendue entre personnages reste du niveau du bruit.
    expect(Math.max(...means) - Math.min(...means)).toBeLessThan(SPEED.BASE * 0.01);
  }, 120_000);
});

describe('photographie d’état', () => {
  it('renvoie un instantané figé : le rendu ne peut pas corrompre la simulation', () => {
    const engine = new RaceEngine(SEED);
    engine.step();
    const state = engine.getState();

    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.characters)).toBe(true);
    for (const character of state.characters) {
      expect(Object.isFrozen(character)).toBe(true);
    }
  });

  it('ne partage aucune référence mutable avec l’état interne', () => {
    const engine = new RaceEngine(SEED);
    engine.step();
    const first = engine.getState();
    engine.step();
    const second = engine.getState();

    // L'instantané pris plus tôt reste une photographie cohérente du passé.
    expect(first.steps).toBe(1);
    expect(first.tSim).toBe(DT);
    expect(second.steps).toBe(2);
    expect(second.tSim).toBe(2 * DT);
  });
});
