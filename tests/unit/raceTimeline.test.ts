import { describe, expect, it } from 'vitest';

import { CHARACTER_IDS } from '../../src/core/characters';
import { RACE_CONFIG } from '../../src/core/config';
import { RaceEngine } from '../../src/core/engine';
import { computeRanks } from '../../src/core/ranking';
import { RaceSimulation } from '../../src/sim/RaceSimulation';
import { SIM_CONFIG, SIM_FAST_CONFIG } from '../../src/sim/config';
import type { SimConfig } from '../../src/sim/types';

/**
 * P006, côté **temps réel** : compte à rebours, pauses de checkpoint, pause utilisateur.
 *
 * Tout est piloté par du `realDt` injecté : aucun test n'attend réellement 3 secondes. C'est possible
 * parce que `RaceSimulation` ne lit jamais l'horloge — elle reçoit le temps écoulé, ce qui rend la
 * ligne temporelle entièrement déterministe et testable en quelques millisecondes.
 */

const SEED = 'POULET42';

/** Une frame nominale à 60 images par seconde, en millisecondes. */
const NOMINAL_FRAME_MS = 1000 / 60;

/**
 * Plafond volontairement énorme : ces tests veulent atteindre une borne **en une seule frame**, pour
 * observer exactement ce qui se passe quand une frame dépasse un checkpoint. Ce n'est pas la
 * configuration du jeu, seulement un moyen de fabriquer le cas à tester.
 */
const BULK: SimConfig = Object.freeze({ ...SIM_CONFIG, maxStepsPerFrame: 100_000 });

/** Le même, en mode test accéléré. */
const BULK_FAST: SimConfig = Object.freeze({ ...SIM_FAST_CONFIG, maxStepsPerFrame: 100_000 });

function distancesOf(simulation: RaceSimulation): readonly number[] {
  return simulation.view.characters.map((character) => character.x);
}

interface CoreFingerprint {
  readonly steps: number;
  readonly tSim: number;
  readonly xs: readonly number[];
  readonly vs: readonly number[];
  readonly drifts: readonly number[];
}

/** Empreinte **bit à bit** du noyau : c'est elle qui doit être identique pendant une pause. */
function fingerprint(simulation: RaceSimulation): CoreFingerprint {
  const state = simulation.view;
  return {
    steps: state.steps,
    tSim: state.tSim,
    xs: state.characters.map((character) => character.x),
    vs: state.characters.map((character) => character.v),
    drifts: state.characters.map((character) => character.drift),
  };
}

function expectSameFingerprint(
  expected: CoreFingerprint,
  actual: CoreFingerprint,
  label: string,
): void {
  expect(actual.steps, `${label} : nombre de pas`).toBe(expected.steps);
  expect(Object.is(actual.tSim, expected.tSim), `${label} : tSim`).toBe(true);
  for (const [index, x] of expected.xs.entries()) {
    expect(Object.is(actual.xs[index], x), `${label} : x[${index}]`).toBe(true);
    expect(Object.is(actual.vs[index], expected.vs[index]), `${label} : v[${index}]`).toBe(true);
    expect(Object.is(actual.drifts[index], expected.drifts[index]), `${label} : drift[${index}]`).toBe(
      true,
    );
  }
}

function expectSameDoubles(actual: readonly number[], expected: readonly number[]): void {
  expect(actual).toHaveLength(expected.length);
  for (const [index, value] of actual.entries()) {
    expect(Object.is(value, expected[index]), `index ${index} : ${value} ≠ ${expected[index]}`).toBe(
      true,
    );
  }
}

/** Joue la course jusqu'au bout, image par image, en purgeant le compte à rebours. */
function playToEnd(simulation: RaceSimulation, frameMs: number): void {
  simulation.start();
  let guard = 0;
  while (simulation.phase !== 'finished') {
    simulation.update(frameMs);
    guard += 1;
    if (guard > 200_000) {
      throw new Error('La simulation ne se termine jamais.');
    }
  }
}

/**
 * Amène la course jusqu'à la pause du checkpoint demandé.
 *
 * La frame qui franchit la borne est **volontairement trop longue** : elle contient cinq secondes
 * simulées de plus que nécessaire, donc plusieurs centaines de pas « payés d'avance ». C'est
 * exactement la situation où un rattrapage apparaîtrait à la reprise si l'accumulateur n'était pas
 * recalé.
 */
function reachCheckpoint(simulation: RaceSimulation, checkpoint: number): void {
  simulation.start();
  simulation.update(SIM_CONFIG.countdownRealS * 1000);
  expect(simulation.phase).toBe('running');

  // Une frame ne peut franchir qu'**une** borne : la simulation s'arrête au premier checkpoint
  // rencontré. Pour atteindre le suivant, il faut donc reprendre la pause précédente.
  for (let index = 1; index <= checkpoint; index += 1) {
    const targetS = index * RACE_CONFIG.SEGMENT_DURATION_S;
    simulation.update((targetS + 5) * 1000);

    expect(simulation.phase).toBe('checkpointPause');
    expect(simulation.checkpoint).toBe(index);
    expect(simulation.view.steps).toBe(index * RACE_CONFIG.STEPS_PER_SEGMENT);
    expect(simulation.view.tSim).toBe(targetS);

    if (index < checkpoint) {
      simulation.update(SIM_CONFIG.checkpointPauseRealS * 1000);
    }
  }
}

describe('compte à rebours réel', () => {
  it('ne fait pas avancer le noyau pendant les 3 secondes réelles', () => {
    const simulation = new RaceSimulation(SEED);
    simulation.start();
    expect(simulation.phase).toBe('countdown');

    const before = fingerprint(simulation);
    simulation.update(2900);
    expect(simulation.phase).toBe('countdown');
    expectSameFingerprint(before, fingerprint(simulation), 'pendant le compte à rebours');

    // La frame suivante franchit la fin du compte à rebours (il restait 0,1 s).
    simulation.update(200);
    expect(simulation.phase).toBe('running');

    // Le reliquat de cette frame ne devient **pas** des pas : aucun rattrapage au départ.
    expect(simulation.view.steps).toBe(0);
    expect(simulation.view.tSim).toBe(0);
  });

  it('démarre immédiatement quand le compte à rebours vaut 0 (mode test)', () => {
    const simulation = new RaceSimulation(SEED, SIM_FAST_CONFIG);
    simulation.start();

    expect(simulation.phase).toBe('running');
    expect(simulation.view.steps).toBe(0);

    // Une frame d'une seconde demanderait 1200 pas : le plafond les bride à 100, et le reliquat est
    // conservé pour les frames suivantes — aucun pas n'est perdu, aucun n'est exécuté trop vite.
    simulation.update(1000);
    expect(simulation.view.steps).toBe(SIM_FAST_CONFIG.maxStepsPerFrame);

    simulation.update(1000);
    expect(simulation.view.steps).toBe(2 * SIM_FAST_CONFIG.maxStepsPerFrame);
  });

  it('n’est pas relancé par un second start()', () => {
    const simulation = new RaceSimulation(SEED);
    simulation.start();
    simulation.update(1000);
    simulation.start();

    expect(simulation.phase).toBe('countdown');
    // Le compte à rebours n'a pas redémarré : 2 s restantes, il se termine donc sur 2 s de plus.
    simulation.update(2000);
    expect(simulation.phase).toBe('running');
  });
});

describe('pause de checkpoint', () => {
  it('s’arrête pile sur chaque borne, aux trois checkpoints', () => {
    for (const checkpoint of [1, 2, 3]) {
      const simulation = new RaceSimulation(SEED, BULK);
      reachCheckpoint(simulation, checkpoint);
      expect(simulation.checkpoint).toBe(checkpoint);
    }
  });

  it('gèle le noyau bit à bit pendant toute la pause', () => {
    const simulation = new RaceSimulation(SEED, BULK);
    reachCheckpoint(simulation, 1);

    const frozen = fingerprint(simulation);
    simulation.update(500);
    expect(simulation.phase).toBe('checkpointPause');
    expectSameFingerprint(frozen, fingerprint(simulation), 'après 0,5 s de pause');

    simulation.update(1000);
    expectSameFingerprint(frozen, fingerprint(simulation), 'après 1,5 s de pause');

    simulation.update(1499);
    expect(simulation.phase).toBe('checkpointPause');
    expectSameFingerprint(frozen, fingerprint(simulation), 'après 2,999 s de pause');
  });

  it('reprend automatiquement, sans rattrapage brutal', () => {
    const simulation = new RaceSimulation(SEED, BULK);
    reachCheckpoint(simulation, 2);
    const stepsAtPause = simulation.view.steps;

    simulation.update(SIM_CONFIG.checkpointPauseRealS * 1000);
    expect(simulation.phase).toBe('running');
    expect(simulation.checkpoint).toBeNull();
    // La pause n'a produit aucun pas : on repart exactement de la borne.
    expect(simulation.view.steps).toBe(stepsAtPause);

    // Une seconde réelle plus tard : 60 pas, et surtout pas les centaines de pas « payés d'avance »
    // par la frame qui a franchi la borne.
    simulation.update(1000);
    expect(simulation.view.steps).toBe(stepsAtPause + 60);
  });

  it('dure exactement 3 s réelles en mode normal', () => {
    const simulation = new RaceSimulation(SEED, BULK);
    reachCheckpoint(simulation, 1);

    simulation.update(2999);
    expect(simulation.phase).toBe('checkpointPause');
    simulation.update(2);
    expect(simulation.phase).toBe('running');
  });

  it('dure exactement 0,2 s réelle en mode test', () => {
    const simulation = new RaceSimulation(SEED, BULK_FAST);
    simulation.start();
    expect(simulation.phase).toBe('running');

    // 45 s simulées à `timeScale = 20` = 2,25 s réelles ; on dépasse volontairement.
    simulation.update(2750);
    expect(simulation.phase).toBe('checkpointPause');
    expect(simulation.view.steps).toBe(RACE_CONFIG.STEPS_PER_SEGMENT);

    simulation.update(199);
    expect(simulation.phase).toBe('checkpointPause');
    simulation.update(2);
    expect(simulation.phase).toBe('running');
  });
});

describe('aucune dette de simulation', () => {
  it('ne rattrape pas le temps réel passé en pause de checkpoint', () => {
    const simulation = new RaceSimulation(SEED, BULK);
    reachCheckpoint(simulation, 1);
    const stepsAtPause = simulation.view.steps;

    // Le MJ ne fait rien pendant une minute entière : la pause se termine, rien d'autre.
    simulation.update(60_000);
    expect(simulation.phase).toBe('running');
    expect(simulation.view.steps).toBe(stepsAtPause);

    // Puis exactement une seconde de course : exactement 60 pas.
    simulation.update(1000);
    expect(simulation.view.steps).toBe(stepsAtPause + 60);
  });

  it('ne rattrape pas le temps réel passé en pause utilisateur', () => {
    const simulation = new RaceSimulation(SEED, BULK);
    simulation.start();
    simulation.update(SIM_CONFIG.countdownRealS * 1000);
    simulation.update(10_000);
    const stepsBeforePause = simulation.view.steps;

    simulation.toggleUserPause();
    simulation.update(60_000);
    expect(simulation.phase).toBe('userPaused');
    expect(simulation.view.steps).toBe(stepsBeforePause);

    simulation.toggleUserPause();
    simulation.update(1000);
    expect(simulation.view.steps).toBe(stepsBeforePause + 60);
  });

  it('jette le reliquat de la frame qui franchit la borne, et rien de plus', () => {
    // Deux courses identiques, à la différence près que l'une franchit la borne avec une frame
    // énorme et l'autre avec une frame juste suffisante : après la pause, les deux doivent repartir
    // de la même frontière.
    const overshooting = new RaceSimulation(SEED, BULK);
    reachCheckpoint(overshooting, 1);
    overshooting.update(SIM_CONFIG.checkpointPauseRealS * 1000);

    const exact = new RaceSimulation(SEED, BULK);
    exact.start();
    exact.update(SIM_CONFIG.countdownRealS * 1000);
    exact.update(45_000);
    expect(exact.phase).toBe('checkpointPause');
    exact.update(SIM_CONFIG.checkpointPauseRealS * 1000);

    expect(overshooting.view.steps).toBe(exact.view.steps);
    expectSameDoubles(distancesOf(overshooting), distancesOf(exact));
  });
});

describe('pause utilisateur', () => {
  it('fige la course, sans consommer de temps simulé ni de tirage', () => {
    const simulation = new RaceSimulation(SEED, BULK);
    simulation.start();
    simulation.update(SIM_CONFIG.countdownRealS * 1000);
    simulation.update(20_000);
    expect(simulation.phase).toBe('running');
    expect(simulation.view.steps).toBe(1200);

    simulation.toggleUserPause();
    expect(simulation.phase).toBe('userPaused');

    const frozen = fingerprint(simulation);
    for (let index = 0; index < 5; index += 1) {
      simulation.update(5000);
    }
    expect(simulation.phase).toBe('userPaused');
    expectSameFingerprint(frozen, fingerprint(simulation), 'pendant la pause utilisateur');

    simulation.toggleUserPause();
    expect(simulation.phase).toBe('running');
    simulation.update(1000);
    expect(simulation.view.steps).toBe(1200 + 60);
  });

  it('suspend le compte à rebours sans le consommer', () => {
    const simulation = new RaceSimulation(SEED);
    simulation.start();
    simulation.update(1000);
    expect(simulation.phase).toBe('countdown');

    simulation.toggleUserPause();
    expect(simulation.phase).toBe('userPaused');
    simulation.update(20_000);
    expect(simulation.phase).toBe('userPaused');

    simulation.toggleUserPause();
    expect(simulation.phase).toBe('countdown');

    // Il restait 2 s : 20 s d'attente ne les ont pas entamées.
    simulation.update(1900);
    expect(simulation.phase).toBe('countdown');
    simulation.update(200);
    expect(simulation.phase).toBe('running');
  });

  it('suspend une pause de checkpoint sans la consommer', () => {
    const simulation = new RaceSimulation(SEED, BULK);
    reachCheckpoint(simulation, 3);

    simulation.toggleUserPause();
    expect(simulation.phase).toBe('userPaused');
    simulation.update(20_000);
    expect(simulation.phase).toBe('userPaused');

    simulation.toggleUserPause();
    expect(simulation.phase).toBe('checkpointPause');
    expect(simulation.checkpoint).toBe(3);

    // Les 3 s de la pause de checkpoint restent dues en entier.
    simulation.update(2900);
    expect(simulation.phase).toBe('checkpointPause');
    simulation.update(200);
    expect(simulation.phase).toBe('running');
  });

  it('reste sans effet sur une course qui n’a pas commencé ou qui est finie', () => {
    const idle = new RaceSimulation(SEED);
    idle.toggleUserPause();
    expect(idle.phase).toBe('idle');

    const done = new RaceSimulation(SEED);
    done.runToCompletion();
    done.toggleUserPause();
    expect(done.phase).toBe('finished');
  });
});

describe('course complète', () => {
  it('suit l’ordre exact des phases', () => {
    const simulation = new RaceSimulation(SEED, BULK);
    const timeline: string[] = [];

    simulation.start();
    timeline.push(simulation.phase);
    while (simulation.phase !== 'finished') {
      simulation.update(1000);
      timeline.push(simulation.phase);
    }

    // Les répétitions d'une même phase sont compressées : on lit la suite des transitions.
    const compressed: string[] = [];
    for (const phase of timeline) {
      if (compressed[compressed.length - 1] !== phase) {
        compressed.push(phase);
      }
    }

    expect(compressed).toEqual([
      'countdown',
      'running',
      'checkpointPause',
      'running',
      'checkpointPause',
      'running',
      'checkpointPause',
      'running',
      'finished',
    ]);
  });

  it('parcourt les quatre segments dans l’ordre, entre les pauses', () => {
    const simulation = new RaceSimulation(SEED, BULK);
    const segments: number[] = [];

    simulation.start();
    while (simulation.phase !== 'finished') {
      const phase = simulation.view.phase;
      if (phase.kind === 'running' && segments[segments.length - 1] !== phase.segment) {
        segments.push(phase.segment);
      }
      simulation.update(1000);
    }

    expect(segments).toEqual([1, 2, 3, 4]);
  });

  it('atteint exactement 10800 pas et tSim = 180, compte à rebours et pauses compris', () => {
    const simulation = new RaceSimulation(SEED);
    playToEnd(simulation, NOMINAL_FRAME_MS);

    expect(simulation.view.steps).toBe(RACE_CONFIG.TOTAL_STEPS);
    expect(simulation.view.tSim).toBe(RACE_CONFIG.TOTAL_SIM_S);
    expect(simulation.phase).toBe('finished');
  });

  it('donne des distances finales identiques au bit près au noyau seul', () => {
    const simulation = new RaceSimulation(SEED);
    playToEnd(simulation, NOMINAL_FRAME_MS);

    const reference = new RaceEngine(SEED).runToCompletion();
    expectSameDoubles(distancesOf(simulation), reference.distances);
  });

  it('reste inchangée après une pause utilisateur en pleine course', () => {
    const paused = new RaceSimulation(SEED);
    paused.start();
    let guard = 0;
    let pausedOnce = false;
    while (paused.phase !== 'finished') {
      if (!pausedOnce && paused.view.steps >= 1000) {
        paused.toggleUserPause();
        expect(paused.phase).toBe('userPaused');
        paused.update(4000);
        paused.update(4000);
        paused.toggleUserPause();
        pausedOnce = true;
      }
      paused.update(NOMINAL_FRAME_MS);
      guard += 1;
      if (guard > 200_000) {
        throw new Error('La simulation ne se termine jamais.');
      }
    }
    expect(pausedOnce).toBe(true);
    expect(paused.view.steps).toBe(RACE_CONFIG.TOTAL_STEPS);

    const reference = new RaceEngine(SEED).runToCompletion();
    expectSameDoubles(distancesOf(paused), reference.distances);
  });

  it('donne le même résultat en mode normal et en mode test accéléré', () => {
    const normal = new RaceSimulation(SEED);
    const fast = new RaceSimulation(SEED, SIM_FAST_CONFIG);
    playToEnd(normal, NOMINAL_FRAME_MS);
    playToEnd(fast, NOMINAL_FRAME_MS);

    expect(fast.view.steps).toBe(normal.view.steps);
    expectSameDoubles(distancesOf(fast), distancesOf(normal));
    expect(computeRanks(distancesOf(fast), CHARACTER_IDS)).toEqual(
      computeRanks(distancesOf(normal), CHARACTER_IDS),
    );

    const reference = new RaceEngine(SEED).runToCompletion();
    expectSameDoubles(distancesOf(fast), reference.distances);
  });

  it('ne dort pas : runToCompletion ignore compte à rebours et pauses', () => {
    const simulation = new RaceSimulation(SEED);
    const startedAt = Date.now();
    const result = simulation.runToCompletion();

    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect(simulation.phase).toBe('finished');
    expect(result.tSim).toBe(RACE_CONFIG.TOTAL_SIM_S);
    expect(simulation.view.steps).toBe(RACE_CONFIG.TOTAL_STEPS);
    expectSameDoubles(result.distances, new RaceEngine(SEED).runToCompletion().distances);
  });
});
