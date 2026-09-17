import { describe, expect, it } from 'vitest';

import { CHARACTERS } from '../../src/core/characters';
import { RACE_CONFIG } from '../../src/core/config';
import { RaceEngine } from '../../src/core/engine';
import { computeRanks } from '../../src/core/ranking';
import { segmentIndexAt } from '../../src/core/track';
import { MAX_EVENT_INTERVALS, ReplayHistory } from '../../src/sim/ReplayHistory';
import {
  REPLAY_STEP_S,
  REPLAY_STEP_STEPS,
  cursorAtPause,
  moveCursor,
  replayPhaseAt,
  replayStateOf,
  seekCursor,
} from '../../src/render/view/replayModel';

/**
 * Relecture (passe corrective 2) : l'historique est un **enregistreur**, le curseur un **borneur**.
 *
 * Ces tests vérifient trois choses, et rien d'autre :
 *
 * 1. ce qui est enregistré suffit à redessiner un instant passé — distances exactes, événements actifs ;
 * 2. l'historique reste **petit** et borné (taille mesurée, pas supposée) ;
 * 3. le curseur ne peut pas sortir de `[0, instant de pause]`, et un instant consulté ne modifie
 *    jamais l'état du noyau.
 */

const IDS = CHARACTERS.map((character) => character.id);
const TOTAL_STEPS = RACE_CONFIG.TOTAL_STEPS;

/** Joue une course pas à pas en enregistrant chaque instant, comme le fait `RaceSimulation`. */
function recordFullRace(seed: string): { history: ReplayHistory; engine: RaceEngine } {
  const engine = new RaceEngine(seed);
  const history = new ReplayHistory();
  history.record(engine.getState());
  for (let step = 0; step < TOTAL_STEPS; step += 1) {
    engine.step();
    history.record(engine.getState());
  }
  return { history, engine };
}

describe('historique de relecture : ce qui est enregistré', () => {
  it('enregistre chaque pas dans l’ordre et refuse un pas manquant ou rejoué', () => {
    const engine = new RaceEngine('ACDEFGHJ');
    const history = new ReplayHistory();

    history.record(engine.getState());
    engine.step();
    history.record(engine.getState());
    // Rejouer le même pas est une erreur de câblage : elle est signalée, jamais rattrapée en silence.
    expect(() => history.record(engine.getState())).toThrow(RangeError);
    expect(history.recorded).toBe(2);
    expect(history.lastStep).toBe(1);

    // Sauter un pas l'est tout autant : un historique troué ne pourrait pas être relu.
    const fresh = new RaceEngine('ACDEFGHJ');
    const skipping = new ReplayHistory();
    skipping.record(fresh.getState());
    fresh.step();
    fresh.step();
    expect(() => skipping.record(fresh.getState())).toThrow(RangeError);
  });

  it('restitue exactement les distances du noyau, pas une approximation', () => {
    const engine = new RaceEngine('KR7Z8NAR');
    const history = new ReplayHistory();
    history.record(engine.getState());

    const samples = new Map<number, number[]>();
    for (let step = 0; step < 600; step += 1) {
      engine.step();
      history.record(engine.getState());
      if (engine.getState().steps % 137 === 0) {
        samples.set(
          engine.getState().steps,
          engine.getState().characters.map((character) => character.x),
        );
      }
    }

    expect(samples.size).toBeGreaterThan(3);
    for (const [step, distances] of samples) {
      expect(history.frameAt(step)?.distances, `pas ${String(step)}`).toStrictEqual(distances);
    }
  });

  it('restitue le classement d’un instant passé à partir des seules distances enregistrées', () => {
    const { history, engine } = recordFullRace('KR7Z8NAR');
    const step = 1800;
    const frame = history.frameAt(step);
    expect(frame).not.toBeNull();

    const liveRanks = computeRanks(
      engine.getState().characters.map((character) => character.x),
      IDS,
    );
    // L'instant consulté n'est pas l'instant final : le classement doit donc différer au moins une
    // fois, sinon le test ne prouverait rien.
    const pastRanks = computeRanks(frame?.distances ?? [], IDS);
    expect(pastRanks).not.toStrictEqual(liveRanks);

    // Le tSim et le segment se déduisent du pas, sans rien stocker de plus.
    expect(frame?.tSim).toBe(step * RACE_CONFIG.DT_S);
    expect(replayPhaseAt(frame?.tSim ?? 0).segment).toBe(segmentIndexAt(step * RACE_CONFIG.DT_S) + 1);
  });

  it('ne restitue rien hors des instants réellement enregistrés', () => {
    const engine = new RaceEngine('ACDEFGHJ');
    const history = new ReplayHistory();
    history.record(engine.getState());
    engine.step();
    history.record(engine.getState());

    expect(history.frameAt(-1)).toBeNull();
    expect(history.frameAt(2)).toBeNull();
    expect(history.frameAt(1.5)).toBeNull();
    expect(history.frameAt(1)).not.toBeNull();
  });

  it('suit les événements rares sous forme d’intervalles, et les restitue à l’instant juste', () => {
    const engine = new RaceEngine('KR7Z8NAR');
    const history = new ReplayHistory();
    history.record(engine.getState());

    const observed: { step: number; events: (string | null)[] }[] = [];
    for (let step = 0; step < TOTAL_STEPS; step += 1) {
      engine.step();
      history.record(engine.getState());
      const events = engine
        .getState()
        .characters.map((character) =>
          character.activeEvent === null
            ? null
            : `${character.activeEvent.id}@${String(character.activeEvent.startSimS)}`,
        );
      observed.push({ step, events });
    }

    let seen = 0;
    for (const { step, events } of observed) {
      const frame = history.frameAt(step + 1);
      const replayed = (frame?.events ?? []).map((event) =>
        event === null || event === undefined ? null : `${event.id}@${String(event.startSimS)}`,
      );
      expect(replayed, `pas ${String(step + 1)}`).toStrictEqual(events);
      if (events.some((event) => event !== null)) {
        seen += 1;
      }
    }

    // Le test n'a de valeur que si la course produit réellement des événements.
    expect(seen).toBeGreaterThan(0);
    expect(history.eventCount).toBeGreaterThan(0);
  });

  it('reste petit : moins de 200 Ko pour une course entière, et un nombre d’intervalles borné', () => {
    const { history } = recordFullRace('KR7Z8NAR');

    expect(history.capacity).toBe(TOTAL_STEPS + 1);
    expect(history.recorded).toBe(TOTAL_STEPS + 1);
    // 3601 instants × 6 distances × 8 octets = 172,8 Ko, plus quelques fiches d'événements.
    expect(history.byteLength).toBeLessThan(200 * 1024);
    expect(history.byteLength).toBeGreaterThan(6 * (TOTAL_STEPS + 1) * 8);
    expect(history.eventCount).toBeLessThan(MAX_EVENT_INTERVALS);
  });

  it('oublie tout au redémarrage : deux courses ne se mélangent jamais', () => {
    const { history } = recordFullRace('ACDEFGHJ');
    expect(history.recorded).toBe(TOTAL_STEPS + 1);

    history.reset();
    expect(history.recorded).toBe(0);
    expect(history.lastStep).toBeNull();
    expect(history.eventCount).toBe(0);
    expect(history.frameAt(0)).toBeNull();
  });
});

describe('curseur de relecture : deux bornes, jamais franchies', () => {
  it('naît sur l’instant de la pause et ne recule jamais avant le départ', () => {
    const pause = Math.round(52.4 / RACE_CONFIG.DT_S);
    let cursor = cursorAtPause(pause);
    expect(cursor.step).toBe(pause);

    // Deux « −2 s » : 50,4 s puis 48,4 s, à un pas près (l'instant de pause n'est pas rond).
    cursor = moveCursor(cursor, -REPLAY_STEP_STEPS);
    expect(cursor.step * RACE_CONFIG.DT_S).toBeCloseTo(50.4, 2);
    cursor = moveCursor(cursor, -REPLAY_STEP_STEPS);
    expect(cursor.step * RACE_CONFIG.DT_S).toBeCloseTo(48.4, 2);

    // « +2 s » revient exactement au même pas, et jamais au-delà.
    cursor = moveCursor(cursor, REPLAY_STEP_STEPS);
    expect(cursor.step * RACE_CONFIG.DT_S).toBeCloseTo(50.4, 2);
    cursor = moveCursor(cursor, REPLAY_STEP_STEPS);
    expect(cursor.step).toBe(pause);
    cursor = moveCursor(cursor, REPLAY_STEP_STEPS);
    expect(cursor.step).toBe(pause);

    // Borne basse : on ne descend jamais sous le départ, même en insistant.
    let low = cursorAtPause(pause);
    for (let index = 0; index < 40; index += 1) {
      low = moveCursor(low, -REPLAY_STEP_STEPS);
    }
    expect(low.step).toBe(0);
  });

  it('accepte une navigation plus fine que deux secondes, sans jamais sortir des bornes', () => {
    const pause = 3000;
    const cursor = seekCursor(cursorAtPause(pause), 1234);
    expect(cursor.step).toBe(1234);

    expect(seekCursor(cursorAtPause(pause), -10).step).toBe(0);
    expect(seekCursor(cursorAtPause(pause), pause + 10).step).toBe(pause);
    expect(seekCursor(cursorAtPause(pause), 1234.6).step).toBe(1235);
    expect(REPLAY_STEP_S).toBe(2);
    expect(REPLAY_STEP_STEPS).toBe(120);
  });

  it('borne la barre sur la course réellement jouée, même sur une pause très courte', () => {
    const cursor = cursorAtPause(30);
    expect(moveCursor(cursor, REPLAY_STEP_STEPS).step).toBe(30);
    expect(moveCursor(cursor, -REPLAY_STEP_STEPS).step).toBe(0);
  });
});

describe('état affiché d’un instant passé : lecture seule', () => {
  it('ne modifie jamais l’état du noyau et se déduit du pas consulté', () => {
    const engine = new RaceEngine('KR7Z8NAR');
    const history = new ReplayHistory();
    history.record(engine.getState());
    for (let step = 0; step < 1200; step += 1) {
      engine.step();
      history.record(engine.getState());
    }

    const live = engine.getState();
    const liveDistances = live.characters.map((character) => character.x);
    const liveSteps = live.steps;
    const livePhase = live.phase;

    const frame = history.frameAt(600);
    expect(frame).not.toBeNull();
    const displayed = replayStateOf(live, frame ?? { steps: 0, tSim: 0, distances: [], events: [] });

    expect(displayed.steps).toBe(600);
    expect(displayed.tSim).toBeCloseTo(10, 10);
    expect(displayed.phase).toStrictEqual({ kind: 'running', segment: 1, segmentElapsedS: 10 });
    expect(displayed.characters.map((character) => character.x)).toStrictEqual(frame?.distances);

    // L'état vivant est intact : consulter un instant passé ne rembobine rien.
    expect(live.characters.map((character) => character.x)).toStrictEqual(liveDistances);
    expect(live.steps).toBe(liveSteps);
    expect(live.phase).toStrictEqual(livePhase);
  });

  it('affiche le segment du noyau à l’instant consulté, jamais celui de la pause', () => {
    expect(replayPhaseAt(0)).toStrictEqual({ kind: 'running', segment: 1, segmentElapsedS: 0 });
    expect(replayPhaseAt(19.5)).toStrictEqual({ kind: 'running', segment: 1, segmentElapsedS: 19.5 });
    expect(replayPhaseAt(20)).toStrictEqual({ kind: 'running', segment: 2, segmentElapsedS: 0 });
    expect(replayPhaseAt(59.99).segment).toBe(3);
  });
});
