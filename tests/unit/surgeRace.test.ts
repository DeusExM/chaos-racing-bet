import { describe, expect, it } from 'vitest';

import { CHARACTER_IDS } from '../../src/core/characters';
import { GAME_CONFIG, RACE_CONFIG, SPEED, SQRT_DT } from '../../src/core/config';
import { RaceEngine } from '../../src/core/engine';
import { gaussianFrom, stepOrnsteinUhlenbeck } from '../../src/core/math';
import type { OrnsteinUhlenbeckParams } from '../../src/core/math';
import { forkStream } from '../../src/core/rng';
import { normalizeSeed } from '../../src/core/seed';
import { computeTargetSpeed, integrateSpeed } from '../../src/core/speedModel';
import type { SurgeState } from '../../src/core/surges';
import { createSurgeState, intervalMaxS, stepSurge, surgeParams } from '../../src/core/surges';
import type { CharacterId } from '../../src/core/types';
import { RaceSimulation } from '../../src/sim/RaceSimulation';
import { SIM_CONFIG, SIM_FAST_CONFIG } from '../../src/sim/config';

/**
 * P007 — les surges **dans la course**, au niveau du moteur et de la simulation.
 *
 * Le planning lui-même est testé dans `surges.test.ts`. Ici, on vérifie le contrat du moteur : quel
 * surge est appliqué, à quel pas exactement, par quel chemin (la rampe), et surtout que les pauses
 * réelles de P006 restent totalement neutres — un surge ne « s'use » pas pendant qu'on regarde
 * ailleurs.
 */

const SEED = 'POULET42';
const DT = RACE_CONFIG.DT_S;
const TOTAL_STEPS = RACE_CONFIG.TOTAL_STEPS;
const PARAMS = surgeParams(GAME_CONFIG);
const MAX_UP = SPEED.MAX_ACCEL * DT;
const MAX_DOWN = SPEED.MAX_DECEL * DT;
const EPS = 1e-12;

/** Un planning indépendant, reconstruit depuis le seul flux `surge:<charId>`. */
function scheduler(seed: string, id: CharacterId): { stream: ReturnType<typeof forkStream>; state: SurgeState } {
  const stream = forkStream(normalizeSeed(seed), `surge:${id}`);
  return { stream, state: createSurgeState(stream, PARAMS) };
}

/**
 * Cherche une seed et un personnage dont un surge est **actif** au pas demandé.
 *
 * La recherche est déterministe et refaite à l'identique à chaque exécution ; elle sert à fabriquer
 * le cas intéressant — un surge qui traverse une borne de checkpoint — plutôt que de l'espérer.
 */
function findActiveSurgeAt(step: number): {
  readonly seed: string;
  readonly id: CharacterId;
  readonly magnitude: number;
  readonly endStep: number;
} {
  for (let index = 0; index < 60; index += 1) {
    const seed = `SURGECP${String(index).padStart(2, '0')}`;
    for (const id of CHARACTER_IDS) {
      const { stream, state } = scheduler(seed, id);
      for (let current = 1; current <= step; current += 1) {
        const magnitude = stepSurge(state, stream, PARAMS, current);
        if (current === step && magnitude !== 0 && state.endStep !== null) {
          return { seed, id, magnitude, endStep: state.endStep };
        }
      }
    }
  }
  throw new Error(`Aucun surge actif au pas ${step} dans les seeds essayées.`);
}

describe('le moteur applique exactement le planning tiré', () => {
  it('publie, à chaque pas, la magnitude du flux surge:<charId>', () => {
    const engine = new RaceEngine(SEED);
    const schedules = CHARACTER_IDS.map((id) => scheduler(SEED, id));
    let mismatches = 0;

    for (let step = 1; step <= TOTAL_STEPS; step += 1) {
      engine.step();
      const characters = engine.getState().characters;

      schedules.forEach((schedule, index) => {
        const expected = stepSurge(schedule.state, schedule.stream, PARAMS, step);
        if (characters[index]?.surge !== expected) {
          mismatches += 1;
        }
      });
    }

    // Le moteur et un planning reconstruit à part doivent coïncider sur 10 800 pas × 6 personnages.
    expect(mismatches).toBe(0);
  });

  it('utilise le surge du pas courant dans la vitesse cible du même pas', () => {
    const engine = new RaceEngine(SEED);
    let previousV = CHARACTER_IDS.map(() => SPEED.BASE);
    let mismatches = 0;

    for (let step = 1; step <= TOTAL_STEPS; step += 1) {
      engine.step();
      const characters = engine.getState().characters;

      characters.forEach((character, index) => {
        // Reconstruction avec les valeurs **publiées** : si le moteur avait utilisé la dérive ou le
        // surge d'un autre pas, l'égalité au bit près échouerait.
        const target = computeTargetSpeed(character, GAME_CONFIG);
        const expected = integrateSpeed(previousV[index] ?? SPEED.BASE, target, GAME_CONFIG, DT);
        if (expected !== character.v) {
          mismatches += 1;
        }
      });

      previousV = characters.map((character) => character.v);
    }

    expect(mismatches).toBe(0);
  });

  it('démarre un surge exactement au pas annoncé par le planning', () => {
    const engine = new RaceEngine(SEED);
    const schedule = scheduler(SEED, 'c0');
    const index = CHARACTER_IDS.indexOf('c0');
    let firstStart: number | null = null;
    let magnitudeAtStart = 0;

    for (let step = 1; step <= 3000; step += 1) {
      const previousNextStart = schedule.state.nextStartStep;
      const magnitude = stepSurge(schedule.state, schedule.stream, PARAMS, step);
      engine.step();

      if (schedule.state.nextStartStep !== previousNextStart && firstStart === null) {
        firstStart = step;
        magnitudeAtStart = magnitude;
        // Le pas de départ subit déjà le surge, dans le moteur comme dans le planning.
        expect(engine.getState().characters[index]?.surge).toBe(magnitude);
        expect(magnitude).not.toBe(0);
      }
    }

    expect(firstStart).not.toBeNull();
    expect(magnitudeAtStart).not.toBe(0);
  });

  it('n’a jamais deux surges en même temps : la magnitude reste constante pendant tout un surge', () => {
    const engine = new RaceEngine(SEED);
    const schedules = CHARACTER_IDS.map((id) => scheduler(SEED, id));
    let blocks = 0;
    let changes = 0;
    let previous = CHARACTER_IDS.map(() => 0);

    for (let step = 1; step <= TOTAL_STEPS; step += 1) {
      engine.step();
      const characters = engine.getState().characters;

      characters.forEach((character, index) => {
        const schedule = schedules[index];
        if (schedule === undefined) {
          throw new Error('planning manquant');
        }

        const previousNextStart = schedule.state.nextStartStep;
        const expected = stepSurge(schedule.state, schedule.stream, PARAMS, step);
        const startedNow = schedule.state.nextStartStep !== previousNextStart;

        if (startedNow) {
          blocks += 1;
        }

        // Le moteur doit publier exactement la magnitude attendue…
        if (character.surge !== expected) {
          changes += 1;
          return;
        }

        // … et ne la changer qu'en démarrant un nouveau surge ou en terminant le courant, jamais au
        // milieu d'un surge actif. Une fin (magnitude → 0) et un enchaînement direct (fin d'un surge
        // et début du suivant au même pas) sont donc légitimes : ils sont reconnus comme tels.
        const endedNow = expected === 0 && (previous[index] ?? 0) !== 0;
        if (expected !== (previous[index] ?? 0) && !startedNow && !endedNow) {
          changes += 1;
        }
      });

      previous = characters.map((character) => character.surge);
    }

    expect(blocks).toBeGreaterThan(60);
    expect(changes).toBe(0);
  });
});

describe('progressivité et bornes, surges compris', () => {
  it('respecte la rampe directionnelle à chaque pas, y compris aux frontières de surge', () => {
    const engine = new RaceEngine(SEED);
    let previousV = CHARACTER_IDS.map(() => SPEED.BASE);
    let previousSurge = CHARACTER_IDS.map(() => 0);
    let boundarySteps = 0;
    let violations = 0;
    let outOfBounds = 0;

    for (let step = 1; step <= TOTAL_STEPS; step += 1) {
      engine.step();
      const characters = engine.getState().characters;

      characters.forEach((character, index) => {
        const delta = character.v - (previousV[index] ?? SPEED.BASE);
        if (delta >= 0 ? delta > MAX_UP + EPS : -delta > MAX_DOWN + EPS) {
          violations += 1;
        }
        if (character.v < SPEED.MIN || character.v > SPEED.MAX) {
          outOfBounds += 1;
        }

        const before = previousSurge[index] ?? 0;
        if ((character.surge !== 0) !== (before !== 0)) {
          boundarySteps += 1;
        }
      });

      previousV = characters.map((character) => character.v);
      previousSurge = characters.map((character) => character.surge);
    }

    // Les démarrages et les fins de surge sont nombreux : la rampe est donc réellement éprouvée.
    expect(boundarySteps).toBeGreaterThan(100);
    expect(violations).toBe(0);
    expect(outOfBounds).toBe(0);
  });
});

describe('pauses : aucun temps simulé, donc aucun surge consommé', () => {
  it('ne consomme pas la durée d’un surge actif pendant une pause de checkpoint de 30 s', () => {
    const checkpointStep = RACE_CONFIG.STEPS_PER_SEGMENT;
    const found = findActiveSurgeAt(checkpointStep);
    const index = CHARACTER_IDS.indexOf(found.id);
    const reference = new RaceEngine(found.seed).runToCompletion();

    const simulation = new RaceSimulation(found.seed, { ...SIM_CONFIG, maxStepsPerFrame: 100_000 });
    simulation.start();
    simulation.update(SIM_CONFIG.countdownRealS * 1000);
    simulation.update(RACE_CONFIG.SEGMENT_DURATION_S * 1000);

    expect(simulation.phase).toBe('checkpointPause');
    expect(simulation.view.steps).toBe(checkpointStep);
    expect(simulation.view.characters[index]?.surge).toBe(found.magnitude);

    // 30 secondes réelles d'attente : ni pas, ni temps simulé, ni consommation du flux de surge.
    simulation.update(30_000);
    expect(simulation.phase).toBe('running');
    expect(simulation.view.steps).toBe(checkpointStep);
    expect(simulation.view.characters[index]?.surge).toBe(found.magnitude);

    // Le surge possède toujours ses pas restants : il se termine exactement au pas prévu au départ.
    // Les frames sont volontairement minuscules pour qu'un `update()` ne puisse jamais exécuter deux
    // pas à la fois : la frontière est donc mesurée au pas près.
    let guard = 0;
    while (simulation.view.characters[index]?.surge !== 0) {
      simulation.update(1000 / 480);
      guard += 1;
      if (guard > 5000) {
        throw new Error('Le surge ne se termine jamais après la pause.');
      }
    }

    expect(simulation.view.steps).toBe(found.endStep);
    // Le surge avait bien une durée simulée restante significative après la borne : c'est ce qui
    // rend la vérification utile.
    expect(found.endStep - checkpointStep).toBeGreaterThan(10);

    // Et la course entière reste identique au noyau seul.
    let finishGuard = 0;
    while (simulation.phase !== 'finished') {
      simulation.update(60_000);
      finishGuard += 1;
      if (finishGuard > 1000) {
        throw new Error('La course ne se termine jamais.');
      }
    }

    expect(simulation.view.steps).toBe(TOTAL_STEPS);
    expect(simulation.view.tSim).toBe(RACE_CONFIG.TOTAL_SIM_S);
    const distances = simulation.view.characters.map((character) => character.x);
    distances.forEach((distance, position) => {
      expect(Object.is(distance, reference.distances[position]), `${CHARACTER_IDS[position]}`).toBe(
        true,
      );
    });
  });

  it('gèle un surge actif pendant une pause utilisateur de 30 s', () => {
    const found = findActiveSurgeAt(1000);
    const index = CHARACTER_IDS.indexOf(found.id);

    const simulation = new RaceSimulation(found.seed, { ...SIM_CONFIG, maxStepsPerFrame: 100_000 });
    simulation.start();
    simulation.update(SIM_CONFIG.countdownRealS * 1000);

    // On avance jusqu'à ce que le surge soit actif, puis on suspend la course.
    let guard = 0;
    while (simulation.view.characters[index]?.surge === 0) {
      simulation.update(1000 / 60);
      guard += 1;
      if (guard > 5000) {
        throw new Error('Surge jamais actif.');
      }
    }

    const before = {
      steps: simulation.view.steps,
      surge: simulation.view.characters[index]?.surge,
      xs: simulation.view.characters.map((character) => character.x),
    };

    simulation.toggleUserPause();
    expect(simulation.phase).toBe('userPaused');
    simulation.update(30_000);

    expect(simulation.phase).toBe('userPaused');
    expect(simulation.view.steps).toBe(before.steps);
    expect(simulation.view.characters[index]?.surge).toBe(before.surge);
    simulation.view.characters.forEach((character, position) => {
      expect(Object.is(character.x, before.xs[position])).toBe(true);
    });

    simulation.toggleUserPause();
    expect(simulation.phase).toBe('running');
    simulation.update(1000 / 60);
    expect(simulation.view.steps).toBeGreaterThan(before.steps);
  });

  it('reste neutre en mode test accéléré comme en mode normal', () => {
    // Les presets réels sont conservés : en mode normal le plafond est de 5 pas par frame, ce qui
    // demande beaucoup plus d'`update()` pour finir la course. Le plafond ne change que le rythme,
    // jamais le résultat — c'est précisément ce que ce test vérifie.
    const play = (simulation: RaceSimulation): readonly number[] => {
      simulation.start();
      let guard = 0;
      while (simulation.phase !== 'finished') {
        simulation.update(60_000);
        guard += 1;
        if (guard > 20_000) {
          throw new Error('La course ne se termine jamais.');
        }
      }
      return simulation.view.characters.map((character) => character.x);
    };

    const normal = play(new RaceSimulation(SEED));
    const fast = play(new RaceSimulation(SEED, SIM_FAST_CONFIG));

    expect(fast).toHaveLength(normal.length);
    fast.forEach((distance, index) => {
      expect(Object.is(distance, normal[index]), `${CHARACTER_IDS[index]}`).toBe(true);
    });
  });
});

describe('espérance des constantes de surge', () => {
  it('produit un biais positif conforme à l’espérance algébrique de GAME_DESIGN §6.4', () => {
    // Moyenne temporelle du surge : `E[magnitude] × E[durée] / E[intervalle]`, entièrement dérivée
    // des constantes documentées. C'est cette grandeur — et non la vitesse, que la rampe retarde un
    // peu — qui doit coller à l'algèbre.
    const races = 24;
    let total = 0;
    let steps = 0;

    for (let race = 0; race < races; race += 1) {
      const engine = new RaceEngine(`BIAIS${String(race).padStart(3, '0')}`);
      for (let step = 1; step <= TOTAL_STEPS; step += 1) {
        engine.step();
        for (const character of engine.getState().characters) {
          total += character.surge;
        }
        steps += CHARACTER_IDS.length;
      }
    }

    const measured = total / steps;
    const surge = GAME_CONFIG.SURGE;
    const perSurge =
      (1 - surge.BRAKE_PROBABILITY) * ((surge.MAGNITUDE_MIN + surge.MAGNITUDE_MAX) / 2) -
      surge.BRAKE_PROBABILITY * ((surge.MAGNITUDE_BRAKE_MIN + surge.MAGNITUDE_BRAKE_MAX) / 2);
    const duty =
      ((surge.DURATION_MIN_S + surge.DURATION_MAX_S) / 2) /
      ((surge.INTERVAL_MIN_S + intervalMaxS(GAME_CONFIG)) / 2);
    const expected = perSurge * duty;

    expect(perSurge).toBeGreaterThan(0);
    expect(duty).toBeGreaterThan(0);
    expect(duty).toBeLessThan(1);
    expect(measured).toBeGreaterThan(0);
    expect(Math.abs(measured - expected) / expected).toBeLessThan(0.2);
  }, 120_000);
});

describe('reproductibilité', () => {
  it('rejoue exactement les mêmes surges et le même résultat pour la même seed', () => {
    const first = new RaceEngine(SEED);
    const second = new RaceEngine(SEED);
    let different = 0;

    for (let step = 1; step <= TOTAL_STEPS; step += 1) {
      first.step();
      second.step();
      const a = first.getState();
      const b = second.getState();
      a.characters.forEach((character, index) => {
        if (!Object.is(character.surge, b.characters[index]?.surge)) {
          different += 1;
        }
      });
    }

    expect(different).toBe(0);
    expect(first.getState().characters.map((character) => character.x)).toEqual(
      second.getState().characters.map((character) => character.x),
    );
  });

  it('change de planning après reset avec une autre seed, et le reproduit après reset identique', () => {
    const engine = new RaceEngine(SEED);
    const surgesOf = (): readonly number[] => {
      const values: number[] = [];
      for (let step = 0; step < 3000; step += 1) {
        engine.step();
        values.push(engine.getState().characters[0]?.surge ?? 0);
      }
      return values;
    };

    const reference = surgesOf();
    engine.reset(SEED);
    expect(surgesOf()).toEqual(reference);

    engine.reset('BANAN4X2');
    expect(surgesOf()).not.toEqual(reference);
  });

  it('ne décale pas la dérive de c0 : elle reste celle de son propre flux', () => {
    // Le drift de c0 doit rester exactement celui de `drift:c0`, surges ou pas : c'est ce qui permet
    // d'activer P007 sans invalider une seule dérive de P004. On le vérifie en reconstruisant la
    // suite de dérive à part, depuis le seul flux de drift.
    const engine = new RaceEngine(SEED);
    const stream = forkStream(normalizeSeed(SEED), 'drift:c0');
    const params: OrnsteinUhlenbeckParams = {
      dt: DT,
      theta: GAME_CONFIG.DRIFT.THETA,
      sigma: GAME_CONFIG.DRIFT.SIGMA,
      sqrtDt: SQRT_DT,
      clampValue: GAME_CONFIG.DRIFT.CLAMP,
    };

    let drift = 0;
    let mismatches = 0;

    for (let step = 1; step <= 5000; step += 1) {
      engine.step();
      drift = stepOrnsteinUhlenbeck(drift, gaussianFrom(stream), params);
      if (engine.getState().characters[0]?.drift !== drift) {
        mismatches += 1;
      }
    }

    // Si consommer `surge:c0` décalait `drift:c0`, les deux suites divergeraient dès le premier pas.
    expect(mismatches).toBe(0);
  });
});
