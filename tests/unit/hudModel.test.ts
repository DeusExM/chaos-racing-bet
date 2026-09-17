import { describe, expect, it } from 'vitest';

import { CHARACTER_IDS } from '../../src/core/characters';
import { RACE_CONFIG, SPEED } from '../../src/core/config';
import { RaceEngine } from '../../src/core/engine';
import type { RaceState } from '../../src/core/types';
import { leaderboardOf } from '../../src/sim/leaderboard';
import { createTestApi } from '../../src/sim/testHooks';
import { RaceSimulation } from '../../src/sim/RaceSimulation';
import { SIM_FAST_CONFIG } from '../../src/sim/config';
import { buildDebugModel } from '../../src/render/view/debugModel';
import { buildHudModel, checkpointTimeS, segmentNumberFor } from '../../src/render/view/hudModel';
import { VIEW } from '../../src/render/viewConfig';
import { OVERTAKE_SEED } from '../fixtures/seeds';

/**
 * Modèles du HUD et du panneau de debug : ils ne font que **lire** l'état du noyau.
 *
 * Ces tests tournent en environnement node, sans navigateur ni Phaser : c'est possible parce que
 * `buildHudModel` et `buildDebugModel` sont des fonctions pures qui reçoivent un état déjà calculé.
 * Si elles avaient besoin du DOM, ce serait le signe d'une erreur d'architecture.
 */

/** État du noyau après `steps` pas, sans passer par le temps réel. */
function stateAfter(seed: string, steps: number): RaceState {
  const engine = new RaceEngine(seed);
  for (let index = 0; index < steps; index += 1) {
    engine.step();
  }
  return engine.getState() as RaceState;
}

describe('modèle du HUD : lecture seule du noyau', () => {
  it('reprend la seed et le temps simulé tels quels', () => {
    const state = stateAfter(OVERTAKE_SEED, 120);
    const model = buildHudModel(state, 'running', null);
    expect(model.seed).toBe(state.seed);
    expect(model.tSim).toBe(state.tSim);
    expect(model.checkpoint).toBeNull();
  });

  it('affiche le classement du noyau, dans son ordre, avec les deux écarts', () => {
    const state = stateAfter(OVERTAKE_SEED, 1500);
    const model = buildHudModel(state, 'running', null);

    const reference = leaderboardOf(state);
    expect(model.rows.map((row) => row.id)).toEqual(reference.map((row) => row.id));
    expect(model.rows.map((row) => row.rank)).toEqual(reference.map((row) => row.rank));

    const leader = model.rows[0];
    expect(leader?.rank).toBe(1);
    expect(leader?.gapMeters).toBe(0);
    expect(leader?.gapSeconds).toBe(0);

    for (const row of model.rows) {
      expect(row.gapSeconds).toBe(row.gapMeters / SPEED.BASE);
    }
  });

  it('déduit les marqueurs des seules distances du noyau', () => {
    const state = stateAfter(OVERTAKE_SEED, 300);
    const model = buildHudModel(state, 'running', null);

    expect(model.markers.map((marker) => marker.id)).toEqual(CHARACTER_IDS);
    for (const [index, marker] of model.markers.entries()) {
      const distance = state.characters[index]?.x ?? 0;
      expect(marker.distance).toBe(distance);
      expect(marker.position).toBeCloseTo(distance / VIEW.NOMINAL_SCALE_M, 10);
    }
  });

  it('numérote les segments comme le noyau, et 0 avant le départ', () => {
    expect(segmentNumberFor({ kind: 'idle' })).toBe(0);
    expect(segmentNumberFor({ kind: 'finished' })).toBe(0);
    expect(segmentNumberFor({ kind: 'running', segment: 3, segmentElapsedS: 1 })).toBe(3);

    // Un pas de segment = `SEGMENT_DURATION_S / DT_S` : la frontière vient du noyau, jamais d'un 45.
    const stepsPerSegment = RACE_CONFIG.SEGMENT_DURATION_S / RACE_CONFIG.DT_S;
    for (const segment of [1, 2, 3, 4]) {
      const state = stateAfter(OVERTAKE_SEED, stepsPerSegment * (segment - 1) + 5);
      const model = buildHudModel(state, 'running', null);
      expect(model.segment.number, `segment ${String(segment)}`).toBe(segment);
    }
  });

  it('borne l’instant d’un pointage sur les constantes du noyau', () => {
    expect(checkpointTimeS(1)).toBe(RACE_CONFIG.SEGMENT_DURATION_S);
    expect(checkpointTimeS(3)).toBe(3 * RACE_CONFIG.SEGMENT_DURATION_S);
  });

  it('n’expose un pointage que pendant la pause, avec les écarts figés', () => {
    // 45 s = 2700 pas : c'est exactement l'instant de la première borne.
    const state = stateAfter(OVERTAKE_SEED, RACE_CONFIG.STEPS_PER_SEGMENT + 1);

    const withoutPause = buildHudModel(state, 'running', null);
    expect(withoutPause.checkpoint).toBeNull();

    const withPause = buildHudModel(state, 'checkpointPause', 1);
    expect(withPause.checkpoint?.number).toBe(1);
    expect(withPause.checkpoint?.timeS).toBe(RACE_CONFIG.SEGMENT_DURATION_S);
    expect(withPause.checkpoint?.rows.map((row) => row.id)).toEqual(
      leaderboardOf(state).map((row) => row.id),
    );
    expect(withPause.checkpoint?.rows[0]?.gapMeters).toBe(0);
  });
});

describe('modèle du panneau de debug : valeurs réelles du noyau', () => {
  it('publie les grandeurs de chaque personnage sans rien recalculer', () => {
    const state = stateAfter(OVERTAKE_SEED, 900);
    const model = buildDebugModel(state, 'running', 20, leaderboardOf(state));

    expect(model.seed).toBe(state.seed);
    expect(model.tSim).toBe(state.tSim);
    expect(model.steps).toBe(state.steps);
    expect(model.segment).toBe(state.phase.kind === 'running' ? state.phase.segment : 0);
    expect(model.phase).toBe('running');
    expect(model.timeScale).toBe(20);
    expect(model.rows.map((row) => row.id)).toEqual(CHARACTER_IDS);

    for (const [index, row] of model.rows.entries()) {
      const character = state.characters[index];
      expect(character).toBeDefined();
      expect(row.x).toBe(character?.x);
      expect(row.v).toBe(character?.v);
      expect(row.drift).toBe(character?.drift);
      expect(row.surge).toBe(character?.surge);
      expect(row.eventBonus).toBe(character?.eventBonus);
      expect(row.event).toBe(character?.activeEvent?.id ?? null);
    }

    const ranks = leaderboardOf(state);
    expect(model.rows.map((row) => row.rank)).toEqual(
      CHARACTER_IDS.map((id) => ranks.find((row) => row.id === id)?.rank ?? 0),
    );
  });

  it('signale un événement actif par son identifiant, et la magnitude réellement appliquée', () => {
    const engine = new RaceEngine(OVERTAKE_SEED);
    let found = false;
    while (engine.getState().phase.kind !== 'finished') {
      engine.step();
      const state = engine.getState();
      const active = state.characters.find((character) => character.activeEvent !== null);
      if (active === undefined || active.activeEvent === null) {
        continue;
      }

      found = true;
      const model = buildDebugModel(state as RaceState, 'running', 1, leaderboardOf(state as RaceState));
      const row = model.rows.find((candidate) => candidate.id === active.id);
      expect(row?.event).toBe(active.activeEvent.id);
      expect(row?.eventBonus).toBe(active.activeEvent.magnitude);
      // Le bonus publié est exactement celui de la fiche d'événement : aucune valeur inventée.
      expect(row?.eventBonus).toBe(active.eventBonus);
      break;
    }

    expect(found, 'au moins un événement doit être actif sur une course complète').toBe(true);
  });

  it('les hooks de test exposent le segment du noyau, sans seconde source de vérité', () => {
    const simulation = new RaceSimulation(OVERTAKE_SEED, SIM_FAST_CONFIG);
    const api = createTestApi(simulation);
    expect(api.segment()).toBe(0);

    simulation.start();
    for (let index = 0; index < 300; index += 1) {
      simulation.update(1000 / 60);
    }

    const phase = simulation.view.phase;
    expect(api.segment()).toBe(phase.kind === 'running' ? phase.segment : 0);
    expect(api.segment()).toBeGreaterThan(1);
  });
});
