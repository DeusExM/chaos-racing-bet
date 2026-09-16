import { describe, expect, it } from 'vitest';

import { CHARACTER_IDS } from '../../src/core/characters';
import { RACE_CONFIG, SPEED } from '../../src/core/config';
import { RaceSimulation } from '../../src/sim/RaceSimulation';
import { SIM_CONFIG, SIM_FAST_CONFIG, SIM_PRESETS } from '../../src/sim/config';
import { buildLeaderboard, leaderboardOf } from '../../src/sim/leaderboard';
import { createTestApi, testHooksEnabled } from '../../src/sim/testHooks';

const DT = RACE_CONFIG.DT_S;
const SEED = 'K7QM2X9A';

/** Une frame à 60 images par seconde, en millisecondes. */
const NOMINAL_FRAME_MS = 1000 / 60;

/** Joue une course image par image jusqu'au bout, comme le ferait la boucle d'affichage. */
function playWith(simulation: RaceSimulation, frameMs: number): readonly number[] {
  simulation.start();
  let guard = 0;
  while (simulation.phase !== 'finished') {
    simulation.update(frameMs);
    guard += 1;
    if (guard > 2_000_000) {
      throw new Error('La simulation ne se termine jamais.');
    }
  }
  return simulation.view.characters.map((character) => character.x);
}

function expectSameDoubles(actual: readonly number[], expected: readonly number[]): void {
  expect(actual).toHaveLength(expected.length);
  for (const [index, value] of actual.entries()) {
    expect(Object.is(value, expected[index]), `index ${index} : ${value}`).toBe(true);
  }
}

describe('presets de temps réel', () => {
  it('reprend les valeurs normatives du mode normal', () => {
    expect(SIM_PRESETS.normal).toBe(SIM_CONFIG);
    expect(SIM_CONFIG.countdownRealS).toBe(3.0);
    expect(SIM_CONFIG.checkpointPauseRealS).toBe(3.0);
    expect(SIM_CONFIG.timeScale).toBe(1);
    expect(SIM_CONFIG.maxStepsPerFrame).toBe(5);
  });

  it('reprend les valeurs normatives du mode test accéléré', () => {
    expect(SIM_PRESETS.fast).toBe(SIM_FAST_CONFIG);
    expect(SIM_FAST_CONFIG.countdownRealS).toBe(0);
    expect(SIM_FAST_CONFIG.checkpointPauseRealS).toBe(0.2);
    expect(SIM_FAST_CONFIG.timeScale).toBe(20);
    // GAME_DESIGN §11 : `TIME_SCALE × MAX_STEPS_PER_FRAME` du mode normal.
    expect(SIM_FAST_CONFIG.maxStepsPerFrame).toBe(
      SIM_FAST_CONFIG.timeScale * SIM_CONFIG.maxStepsPerFrame,
    );
  });

  it('laisse au mode test assez de pas par frame pour ne pas être bridé', () => {
    // Une frame nominale en `timeScale = 20` réclame `20 × 60 × DT_S = 20` pas : un plafond
    // inférieur briderait le mode test sans rien changer au résultat, mais le rendrait inutile.
    const stepsPerNominalFrame =
      (SIM_FAST_CONFIG.timeScale * SIM_FAST_CONFIG.nominalFps) * DT;
    expect(stepsPerNominalFrame).toBe(20);
    expect(SIM_FAST_CONFIG.maxStepsPerFrame).toBeGreaterThanOrEqual(stepsPerNominalFrame);
  });

  it('gèle les presets', () => {
    expect(Object.isFrozen(SIM_CONFIG)).toBe(true);
    expect(Object.isFrozen(SIM_FAST_CONFIG)).toBe(true);
    expect(Object.isFrozen(SIM_PRESETS)).toBe(true);
  });
});

describe('RaceSimulation — temps réel', () => {
  it('ne bouge pas tant que la course n’est pas lancée', () => {
    const simulation = new RaceSimulation(SEED);
    expect(simulation.phase).toBe('idle');

    simulation.update(1000);
    expect(simulation.view.steps).toBe(0);
    expect(simulation.phase).toBe('idle');
  });

  it('convertit les millisecondes en secondes simulées', () => {
    // Plafond volontairement très haut : ce test porte sur la conversion, pas sur le garde-fou.
    const simulation = new RaceSimulation(SEED, { ...SIM_CONFIG, maxStepsPerFrame: 1000 });
    simulation.start();
    simulation.update(1000);

    // 1 seconde réelle à timeScale 1 = 1 seconde simulée = 60 pas.
    expect(simulation.view.steps).toBe(60);
    expect(simulation.view.tSim).toBe(60 * DT);
  });

  it('multiplie par le timeScale sans jamais changer la taille du pas', () => {
    const simulation = new RaceSimulation(SEED, { ...SIM_CONFIG, maxStepsPerFrame: 5000 });
    simulation.start();
    simulation.update(1000);

    expect(simulation.view.steps).toBe(60);
    simulation.setTimeScale(20);
    simulation.update(1000);
    // 20 secondes simulées de plus, toujours par pas de DT_S.
    expect(simulation.view.steps).toBe(60 + 1200);
    expect(simulation.view.tSim).toBe(1260 * DT);
  });

  it('conserve le reliquat quand le plafond de pas par frame est atteint', () => {
    const simulation = new RaceSimulation(SEED, { ...SIM_CONFIG, maxStepsPerFrame: 10 });
    simulation.start();

    simulation.update(1000);
    expect(simulation.view.steps).toBe(10);

    // Un temps réel négligeable : les 10 pas suivants ne peuvent venir que du reliquat conservé.
    simulation.update(0.0001);
    expect(simulation.view.steps).toBe(20);
    simulation.update(0.0001);
    expect(simulation.view.steps).toBe(30);
  });

  it('ne perd aucun temps simulé sur un realDt énorme et donne le même résultat final', () => {
    const reference = playWith(new RaceSimulation(SEED), NOMINAL_FRAME_MS);

    // 2 secondes d'un coup, à chaque update : le plafond étale l'exécution, il ne la tronque pas.
    const frozen = playWith(new RaceSimulation(SEED), 2000);

    expectSameDoubles(frozen, reference);
  });

  it('donne exactement le même résultat en timeScale 1 et en timeScale 20', () => {
    const normal = playWith(new RaceSimulation(SEED, SIM_CONFIG), NOMINAL_FRAME_MS);

    const fast = new RaceSimulation(SEED, SIM_FAST_CONFIG);
    const fastDistances = playWith(fast, NOMINAL_FRAME_MS);

    expectSameDoubles(fastDistances, normal);
    expect(fast.timeScale).toBe(20);
  });

  it('atteint la fin exactement à 10 800 pas, quel que soit le découpage', () => {
    for (const frameMs of [1, 5, 16.667, 100, 2000]) {
      const distances = playWith(new RaceSimulation(SEED), frameMs);
      expect(distances, `frame de ${frameMs} ms`).toHaveLength(6);
    }

    const simulation = new RaceSimulation(SEED, { ...SIM_CONFIG, maxStepsPerFrame: 1000 });
    simulation.start();
    let guard = 0;
    while (simulation.phase !== 'finished' && guard < 100) {
      simulation.update(10_000);
      guard += 1;
    }
    expect(simulation.view.steps).toBe(RACE_CONFIG.TOTAL_STEPS);
    expect(simulation.view.tSim).toBe(180);
    expect(simulation.phase).toBe('finished');
  });

  it('arrête définitivement la course une fois terminée', () => {
    const simulation = new RaceSimulation(SEED);
    simulation.start();
    simulation.runToCompletion();

    const before = simulation.view;
    simulation.update(1000);
    expect(simulation.view.steps).toBe(before.steps);
    expect(simulation.view.tSim).toBe(before.tSim);
  });

  it('refuse un timeScale absurde', () => {
    const simulation = new RaceSimulation(SEED);
    expect(() => simulation.setTimeScale(0)).toThrow(RangeError);
    expect(() => simulation.setTimeScale(-3)).toThrow(RangeError);
    expect(() => simulation.setTimeScale(Number.NaN)).toThrow(RangeError);
  });

  it('refuse une configuration de temps réel inutilisable', () => {
    expect(() => new RaceSimulation(SEED, { ...SIM_CONFIG, timeScale: 0 })).toThrow(RangeError);
    expect(() => new RaceSimulation(SEED, { ...SIM_CONFIG, maxStepsPerFrame: 0 })).toThrow(
      RangeError,
    );
    expect(() => new RaceSimulation(SEED, { ...SIM_CONFIG, maxStepsPerFrame: 2.5 })).toThrow(
      RangeError,
    );
  });
});

describe('RaceSimulation — redémarrage', () => {
  it('repart de zéro avec la même seed et rejoue la même course', () => {
    const simulation = new RaceSimulation(SEED);
    simulation.start();
    const first = simulation.runToCompletion();

    simulation.restart();
    expect(simulation.phase).toBe('idle');
    expect(simulation.view.steps).toBe(0);
    expect(simulation.view.tSim).toBe(0);
    expect(simulation.view.characters.every((character) => character.x === 0)).toBe(true);

    const second = simulation.runToCompletion();
    expectSameDoubles(second.distances, first.distances);
    expect(second.ranking).toEqual(first.ranking);
  });

  it('change de course quand on change de seed', () => {
    const simulation = new RaceSimulation('RACEWAY1');
    const first = simulation.runToCompletion();

    const second = simulation.runToCompletion('ZZZZZZZZ');
    expect(simulation.view.seed).toBe('ZZZZZZZZ');
    expect(second.distances).not.toEqual(first.distances);
  });

  it('runToCompletion ne dépend ni du timeScale ni de la phase', () => {
    const fast = new RaceSimulation(SEED, SIM_FAST_CONFIG);
    fast.start();
    const fromRunning = fast.runToCompletion();

    const idle = new RaceSimulation(SEED);
    const fromIdle = idle.runToCompletion();

    expectSameDoubles(fromRunning.distances, fromIdle.distances);
  });
});

describe('classement affichable', () => {
  it('ordonne les 6 personnages par distance décroissante, rangs et écarts cohérents', () => {
    const result = new RaceSimulation(SEED).runToCompletion();
    const rows = buildLeaderboard(result.distances, CHARACTER_IDS);

    expect(rows).toHaveLength(6);
    expect(rows.map((row) => row.id)).toEqual(result.ranking);
    expect(rows[0]?.gapMeters).toBe(0);

    for (const [index, row] of rows.entries()) {
      expect(row.rank).toBe(index + 1);
      expect(Number.isFinite(row.distance)).toBe(true);
      expect(row.gapMeters).toBeGreaterThanOrEqual(0);
      expect(row.name.length).toBeGreaterThan(0);
      if (index > 0) {
        expect(row.distance).toBeLessThanOrEqual(rows[index - 1]?.distance ?? 0);
        expect(row.gapMeters).toBeGreaterThanOrEqual(rows[index - 1]?.gapMeters ?? 0);
      }
    }
  });

  it('départage les égalités par index croissant, comme le noyau', () => {
    const rows = buildLeaderboard([10, 10, 5], ['c2', 'c0', 'c1']);
    expect(rows.map((row) => row.id)).toEqual(['c0', 'c2', 'c1']);
    expect(rows.map((row) => row.rank)).toEqual([1, 2, 3]);
  });

  it('donne exactement le classement du noyau pour un état réel', () => {
    const simulation = new RaceSimulation(SEED);
    const result = simulation.runToCompletion();

    const rows = leaderboardOf(simulation.view);
    expect(rows.map((row) => row.id)).toEqual(result.ranking);

    for (const row of rows) {
      const index = CHARACTER_IDS.indexOf(row.id);
      expect(row.distance).toBe(result.distances[index]);
    }
  });

  it('place le premier au départ sans écarts négatifs', () => {
    const rows = buildLeaderboard([0, 0, 0], ['c0', 'c1', 'c2']);
    expect(rows.map((row) => row.id)).toEqual(['c0', 'c1', 'c2']);
    expect(rows.every((row) => row.gapMeters === 0)).toBe(true);
  });

  it('n’écrit jamais dans les distances du noyau', () => {
    const distances = [30, 10, 20];
    const snapshot = [...distances];
    buildLeaderboard(distances, ['c0', 'c1', 'c2']);
    expect(distances).toEqual(snapshot);
  });
});

describe('hooks de test', () => {
  it('ne s’active qu’en développement ou avec ?e2e=1', () => {
    expect(testHooksEnabled('', true)).toBe(true);
    expect(testHooksEnabled('?fast=1', true)).toBe(true);
    expect(testHooksEnabled('', false)).toBe(false);
    expect(testHooksEnabled('?fast=1&autostart=1', false)).toBe(false);
    expect(testHooksEnabled('?e2e=1', false)).toBe(true);
    expect(testHooksEnabled('?e2e=0', false)).toBe(false);
  });

  it('expose un classement et des distances cohérents avec le noyau', () => {
    const simulation = new RaceSimulation(SEED);
    const api = createTestApi(simulation);
    const result = simulation.runToCompletion();

    expect(api.distances()).toEqual([...result.distances]);
    expect(api.ranks().map((row) => row.id)).toEqual(result.ranking);
    expect(api.phase()).toBe('finished');
    expect(api.seed()).toBe(SEED);
    expect(api.timeScale()).toBe(1);
    expect(Object.isFrozen(api)).toBe(true);
  });

  it('n’offre aucun moyen d’écrire dans l’état', () => {
    const simulation = new RaceSimulation(SEED);
    const api = createTestApi(simulation);
    const state = api.state();

    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.characters)).toBe(true);
    for (const character of state.characters) {
      expect(Object.isFrozen(character)).toBe(true);
    }
  });

  it('démarre bien la course à travers l’API', () => {
    const simulation = new RaceSimulation(SEED, { ...SIM_CONFIG, maxStepsPerFrame: 1000 });
    const api = createTestApi(simulation);

    api.start();
    expect(api.phase()).toBe('running');
    simulation.update(1000);
    expect(api.state().steps).toBe(60);
  });
});

describe('cohérence des échelles', () => {
  it('utilise bien la vitesse de base du noyau pour l’écart en mètres', () => {
    // Garde-fou : le classement ne doit jamais dépendre d'une constante inventée côté rendu.
    expect(SPEED.BASE).toBe(12.0);
    const rows = buildLeaderboard([100, 88], ['c0', 'c1']);
    expect(rows[0]?.gapMeters).toBe(0);
    expect(rows[1]?.gapMeters).toBe(12);
  });
});
