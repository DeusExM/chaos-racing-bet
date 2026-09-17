import { describe, expect, it } from 'vitest';

import { UI_TEXT_FR } from '../../src/app/strings.fr';
import { CHARACTER_IDS } from '../../src/core/characters';
import { RACE_CONFIG, SPEED } from '../../src/core/config';
import { RaceEngine } from '../../src/core/engine';
import { computeRanks, sortByRank } from '../../src/core/ranking';
import type { CharacterState, RaceFact, RaceState } from '../../src/core/types';
import {
  buildFinishModel,
  captureFinishSnapshot,
  deceleratedDistances,
  decelerationOffset,
  photoFinishOf,
  type FinishSnapshot,
} from '../../src/render/view/finishModel';
import { VIEW } from '../../src/render/viewConfig';
import {
  OVERTAKE_SEED,
  OVERTAKE_SEED_ARRIVAL,
  PHOTO_FINISH_SEED,
  PHOTO_FINISH_SEED_EVIDENCE,
  arrivalFactOf,
} from '../fixtures/seeds';

/**
 * P013 — modèles purs de l'arrivée.
 *
 * Ces tests tournent sans navigateur : tout ce qui décide du classement final, du podium et de la
 * mention de photo finish est une fonction pure, et c'est exactement le but. Le noyau est rejoué pour
 * de vrai (aucun état fabriqué pour les vérifications qui portent sur une course), et les deux seules
 * courses fabriquées servent à prouver des propriétés **structurelles** — ordre préservé par l'inertie
 * visuelle, refus d'un instantané non final — qui ne dépendent d'aucune seed.
 */

/** Course réellement terminée, avec son fait d'arrivée. */
function finishedRace(seed: string): { state: RaceState; arrival: RaceFact | null } {
  const engine = new RaceEngine(seed);
  engine.runToCompletion();
  const facts = engine.drainFacts();
  const arrival = facts.find((fact) => fact.type === 'FINISH' || fact.type === 'PHOTO_FINISH');
  return { state: engine.getState(), arrival: arrival ?? null };
}

/** État d'arrivée fabriqué : sert aux propriétés qui doivent tenir pour **n'importe** quelle course. */
function fabricatedFinish(distances: readonly number[], velocities: readonly number[]): RaceState {
  const characters: CharacterState[] = CHARACTER_IDS.map((id, index) => ({
    id,
    x: distances[index] ?? 0,
    v: velocities[index] ?? SPEED.BASE,
    drift: 0,
    surge: 0,
    eventBonus: 0,
    activeEvent: null,
  }));

  return {
    seed: 'TESTTEST',
    seedValue: 1,
    tSim: RACE_CONFIG.TOTAL_SIM_S,
    steps: RACE_CONFIG.TOTAL_STEPS,
    phase: { kind: 'finished' },
    characters,
  };
}

/** Copie profonde et sérialisable d'un état du noyau : détecte la moindre mutation. */
function cloneState(state: Readonly<RaceState>): string {
  return JSON.stringify({
    seed: state.seed,
    seedValue: state.seedValue,
    tSim: state.tSim,
    steps: state.steps,
    phase: state.phase,
    characters: state.characters,
  });
}

function factLike(overrides: Partial<RaceFact>): RaceFact {
  return {
    type: 'FINISH',
    tSim: RACE_CONFIG.TOTAL_SIM_S,
    characterIds: ['c0', 'c1'],
    magnitudes: [1.5, 2200, 2198.5],
    importance: 80,
    textKey: 'fact.finish',
    ...overrides,
  };
}

describe('instantané final', () => {
  it('fige les 10 800 pas et les distances du noyau à 180 s', () => {
    const { state } = finishedRace(OVERTAKE_SEED);
    const snapshot = captureFinishSnapshot(state);

    expect(snapshot.tSim).toBe(RACE_CONFIG.TOTAL_SIM_S);
    expect(snapshot.steps).toBe(RACE_CONFIG.TOTAL_STEPS);
    expect(snapshot.seed).toBe(OVERTAKE_SEED);
    expect([...snapshot.distances]).toEqual(state.characters.map((character) => character.x));
    expect([...snapshot.velocities]).toEqual(state.characters.map((character) => character.v));
  });

  it('refuse de capturer un classement final avant l’arrivée', () => {
    const engine = new RaceEngine(OVERTAKE_SEED);
    expect(() => captureFinishSnapshot(engine.getState())).toThrow(RangeError);

    engine.step();
    expect(engine.getState().phase.kind).toBe('running');
    expect(() => captureFinishSnapshot(engine.getState())).toThrow(RangeError);
  });

  it('est gelé en profondeur : aucune présentation ne peut le modifier', () => {
    const { state } = finishedRace(OVERTAKE_SEED);
    const snapshot = captureFinishSnapshot(state);
    const first = snapshot.rows[0];
    expect(first).toBeDefined();

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.distances)).toBe(true);
    expect(Object.isFrozen(snapshot.velocities)).toBe(true);
    expect(Object.isFrozen(snapshot.rows)).toBe(true);
    expect(Object.isFrozen(first)).toBe(true);

    const distances = snapshot.distances as number[];
    expect(() => distances.push(0)).toThrow(TypeError);
    const row = snapshot.rows[0] as { distance: number };
    expect(() => {
      row.distance = 0;
    }).toThrow(TypeError);
    expect(snapshot.rows[0]?.distance).toBe(first?.distance);
  });
});

describe('classement final, podium et écarts', () => {
  it('suit exactement l’ordre des distances du noyau (les 6, dans l’ordre)', () => {
    const { state } = finishedRace(OVERTAKE_SEED);
    const snapshot = captureFinishSnapshot(state);
    const model = buildFinishModel(snapshot, null);

    const distances = state.characters.map((character) => character.x);
    const expectedOrder = sortByRank(distances, CHARACTER_IDS).map(
      (index) => CHARACTER_IDS[index] ?? 'c0',
    );
    const expectedRanks = computeRanks(distances, CHARACTER_IDS);

    expect(model.rows).toHaveLength(CHARACTER_IDS.length);
    expect(model.rows.map((row) => row.id)).toEqual(expectedOrder);
    expect(model.rows.map((row) => row.rank)).toEqual(
      expectedOrder.map((id) => expectedRanks[CHARACTER_IDS.indexOf(id)] ?? 0),
    );
  });

  it('dérive les écarts des seules distances finales, et nuls pour le vainqueur', () => {
    const { state } = finishedRace(OVERTAKE_SEED);
    const snapshot = captureFinishSnapshot(state);
    const model = buildFinishModel(snapshot, null);

    const best = Math.max(...snapshot.distances);
    expect(model.rows[0]?.gapMeters).toBe(0);
    for (const [index, row] of model.rows.entries()) {
      const distance = snapshot.distances[CHARACTER_IDS.indexOf(row.id)];
      expect(row.distance).toBe(distance);
      expect(row.gapMeters, `écart de la ligne ${String(index)}`).toBeCloseTo(best - (distance ?? 0), 12);
    }
  });

  it('compose le podium avec le début du classement, jamais une seconde sélection', () => {
    const { state } = finishedRace(OVERTAKE_SEED);
    const snapshot = captureFinishSnapshot(state);
    const model = buildFinishModel(snapshot, null);

    expect(model.podium).toHaveLength(VIEW.FINISH_PODIUM_SIZE);
    expect(model.podium.map((row) => row.id)).toEqual(
      model.rows.slice(0, VIEW.FINISH_PODIUM_SIZE).map((row) => row.id),
    );
    expect(model.winner.id).toBe(model.rows[0]?.id);
    expect(model.winner.rank).toBe(1);
  });

  it('suit les distances même quand elles sont très au-dessus de l’échelle du décor', () => {
    // Preuve structurelle : la piste nominale (`NOMINAL_SCALE_M`) et le décor n'entrent nulle part.
    const beyond = VIEW.NOMINAL_SCALE_M + 500;
    const state = fabricatedFinish(
      [beyond, beyond - 0.5, beyond - 900, 12, 11.5, 0],
      [SPEED.BASE, SPEED.BASE, SPEED.BASE, SPEED.BASE, SPEED.BASE, SPEED.BASE],
    );
    const model = buildFinishModel(captureFinishSnapshot(state), null);

    expect(model.rows.map((row) => row.id)).toEqual(['c0', 'c1', 'c2', 'c3', 'c4', 'c5']);
    expect(model.winner.id).toBe('c0');
    expect(model.podium.map((row) => row.id)).toEqual(['c0', 'c1', 'c2']);
  });
});

describe('photo finish', () => {
  it('n’affiche la mention que si le noyau a réellement produit PHOTO_FINISH', () => {
    const withoutPhoto = finishedRace(OVERTAKE_SEED);
    const withoutModel = buildFinishModel(captureFinishSnapshot(withoutPhoto.state), withoutPhoto.arrival);
    expect(withoutPhoto.arrival?.type).toBe(OVERTAKE_SEED_ARRIVAL.type);
    expect(withoutModel.photoFinish).toBeNull();

    const photo = finishedRace(PHOTO_FINISH_SEED);
    const photoModel = buildFinishModel(captureFinishSnapshot(photo.state), photo.arrival);
    expect(photo.arrival?.type).toBe('PHOTO_FINISH');
    expect(photoModel.photoFinish).not.toBeNull();
    expect(photoModel.photoFinish?.gapMeters).toBe(PHOTO_FINISH_SEED_EVIDENCE.gapMeters);
    expect(photoModel.photoFinish?.leaderId).toBe(PHOTO_FINISH_SEED_EVIDENCE.leader);
    expect(photoModel.photoFinish?.secondId).toBe(PHOTO_FINISH_SEED_EVIDENCE.second);
  });

  it('mesure les deux seeds de référence sans les modifier', () => {
    const photo = arrivalFactOf(PHOTO_FINISH_SEED);
    expect(photo.type).toBe('PHOTO_FINISH');
    expect(photo.gapMeters).toBe(PHOTO_FINISH_SEED_EVIDENCE.gapMeters);
    expect(photo.stepCount).toBe(RACE_CONFIG.TOTAL_STEPS);
    expect(photo.tSim).toBe(RACE_CONFIG.TOTAL_SIM_S);

    const plain = arrivalFactOf(OVERTAKE_SEED);
    expect(plain.type).toBe(OVERTAKE_SEED_ARRIVAL.type);
    expect(plain.gapMeters).toBe(OVERTAKE_SEED_ARRIVAL.gapMeters);
  });

  it('refuse un fait d’arrivée incomplet au lieu d’inventer des valeurs', () => {
    expect(photoFinishOf(null)).toBeNull();
    expect(photoFinishOf(factLike({ type: 'FINISH' }))).toBeNull();
    expect(() => photoFinishOf(factLike({ type: 'PHOTO_FINISH', magnitudes: [] }))).toThrow(
      RangeError,
    );
    expect(() =>
      photoFinishOf(factLike({ type: 'PHOTO_FINISH', characterIds: ['c0'] })),
    ).toThrow(RangeError);
  });
});

describe('décélération visuelle', () => {
  const durationS = VIEW.FINISH_DECELERATION_MS / 1000;

  it('est nulle à l’instant de l’arrivée, croissante, puis bornée', () => {
    const speed = SPEED.BASE;
    expect(decelerationOffset(speed, 0)).toBe(0);
    expect(decelerationOffset(speed, -10)).toBe(0);
    expect(decelerationOffset(0, 500)).toBe(0);
    expect(decelerationOffset(Number.NaN, 500)).toBe(0);

    const samples = [0, 50, 100, 300, 600, 900, 1200, 1300, 5000].map((elapsed) =>
      decelerationOffset(speed, elapsed),
    );
    for (let index = 1; index < samples.length; index += 1) {
      expect(samples[index] ?? 0).toBeGreaterThanOrEqual(samples[index - 1] ?? 0);
    }

    const bound = (speed * durationS) / 2;
    expect(samples.at(-1)).toBeCloseTo(bound, 12);
    expect(decelerationOffset(speed, VIEW.FINISH_DECELERATION_MS)).toBeCloseTo(bound, 12);
    expect(decelerationOffset(speed, VIEW.FINISH_DECELERATION_MS * 10)).toBeCloseTo(bound, 12);
  });

  it('préserve strictement l’ordre du classement figé, à tout instant', () => {
    const snapshot = captureFinishSnapshot(
      fabricatedFinish(
        [10, 9.9, 9.899, 5, 4.999, 1],
        [12.2, 12.19, 12.18, 12.1, 12.09, 12.0],
      ),
    );
    const order = [...snapshot.distances]
      .map((distance, index) => ({ distance, index }))
      .sort((a, b) => b.distance - a.distance)
      .map((entry) => CHARACTER_IDS[entry.index] ?? 'c0');
    const expected = snapshot.rows.map((row) => row.id);
    expect(order).toEqual(expected);

    for (const elapsed of [0, 1, 100, 600, 1200, 5000]) {
      const visual = deceleratedDistances(snapshot, elapsed);
      const visualOrder = [...visual]
        .map((distance, index) => ({ distance, index }))
        .sort((a, b) => b.distance - a.distance)
        .map((entry) => CHARACTER_IDS[entry.index]);
      expect(visualOrder, `ordre visuel à ${String(elapsed)} ms`).toEqual(expected);
    }
  });

  it('n’écrit jamais dans l’état du noyau et ne change ni tSim ni les pas', () => {
    const { state, arrival } = finishedRace(PHOTO_FINISH_SEED);
    const before = cloneState(state);

    const snapshot: FinishSnapshot = captureFinishSnapshot(state);
    for (const elapsed of [0, 250, 1200, 4000]) {
      const visual = deceleratedDistances(snapshot, elapsed);
      expect(visual).toHaveLength(CHARACTER_IDS.length);
    }
    const model = buildFinishModel(snapshot, arrival);

    expect(cloneState(state)).toBe(before);
    expect(state.tSim).toBe(RACE_CONFIG.TOTAL_SIM_S);
    expect(state.steps).toBe(RACE_CONFIG.TOTAL_STEPS);
    expect(model.steps).toBe(RACE_CONFIG.TOTAL_STEPS);
    expect(model.tSim).toBe(RACE_CONFIG.TOTAL_SIM_S);
    // Les distances de rendu restent au-dessus des distances figées, jamais l'inverse.
    const visual = deceleratedDistances(snapshot, 1200);
    for (const [index, distance] of snapshot.distances.entries()) {
      expect(visual[index] ?? 0).toBeGreaterThanOrEqual(distance);
    }
  });
});

describe('garde-fous structurels', () => {
  const sources = import.meta.glob<string>('/src/render/view/finishModel.ts', {
    query: '?raw',
    import: 'default',
    eager: true,
  });
  const panelSources = import.meta.glob<string>('/src/render/view/FinishPanel.ts', {
    query: '?raw',
    import: 'default',
    eager: true,
  });

  function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  }

  function sourceOf(modules: Record<string, string>, path: string): string {
    const source = modules[path];
    if (source === undefined) {
      throw new Error(`Source introuvable : ${path}`);
    }
    return stripComments(source);
  }

  it('le modèle final ne recalcule aucune règle de classement et ignore le décor', () => {
    const code = sourceOf(sources, '/src/render/view/finishModel.ts');

    for (const forbidden of [
      'computeRanks',
      'sortByRank',
      'NOMINAL_SCALE',
      'screenX',
      'sprite',
      'phaser',
      'document',
      'window',
      'Math.random',
    ]) {
      expect(code.includes(forbidden), `finishModel.ts ne doit pas contenir « ${forbidden} »`).toBe(
        false,
      );
    }
    // Le seul classement possible passe par la source unique du projet.
    expect(code).toContain('leaderboardOf');
  });

  it('le panneau d’arrivée ne peut pas produire un classement par lui-même', () => {
    const code = sourceOf(panelSources, '/src/render/view/FinishPanel.ts');

    for (const forbidden of [
      "from '../../core/ranking'",
      "from '../../core/config'",
      "from '../viewConfig'",
      'phaser',
      '.sort(',
      'computeRanks',
      'sortByRank',
      // Le panneau reçoit un `LeaderboardRow` comme **type** de ligne déjà classée, jamais de quoi en
      // produire un : aucune fonction de classement de `sim/leaderboard` n'est appelable depuis lui.
      'leaderboardOf',
      'buildLeaderboard',
    ]) {
      expect(
        code.includes(forbidden),
        `FinishPanel.ts ne doit pas contenir « ${forbidden} »`,
      ).toBe(false);
    }
    // Il ne sait faire qu'une chose : présenter un modèle déjà dérivé du noyau.
    expect(code).toContain('update(model: FinishModel | null)');
    expect(code).toContain('formatGapMeters');
  });

  it('les libellés de l’écran d’arrivée sont fournis par l’application, jamais en dur', () => {
    const code = sourceOf(panelSources, '/src/render/view/FinishPanel.ts');
    expect(code).toContain('text.finishTitle');
    expect(code).toContain('text.finishReplaySameSeed');
    expect(code).toContain('text.finishNewRace');
    expect(code).not.toContain('Arrivée');
    // Les libellés existent bien dans la source unique des textes visibles.
    expect(UI_TEXT_FR.finishPhotoBadge.length).toBeGreaterThan(0);
    expect(UI_TEXT_FR.finishReplaySameSeed.length).toBeGreaterThan(0);
    expect(UI_TEXT_FR.finishNewRace.length).toBeGreaterThan(0);
  });
});
