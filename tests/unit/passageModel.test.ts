import { describe, expect, it } from 'vitest';

import { CHARACTERS } from '../../src/core/characters';
import { RACE_CONFIG } from '../../src/core/config';
import { RaceEngine } from '../../src/core/engine';
import type { RaceState } from '../../src/core/types';
import { leaderboardOf } from '../../src/sim/leaderboard';
import { PassageRecorder } from '../../src/render/view/passageModel';
import { buildFinishModel, captureFinishSnapshot } from '../../src/render/view/finishModel';
import { PLAIN_FINISH_SEED } from '../fixtures/seeds';

/**
 * Passe de finition 2D — historique des passages en tête.
 *
 * Le point sensible de cette section est la **véracité** : chaque ligne doit venir d'un classement
 * réellement observé, et d'aucune autre source. Ces tests rejouent donc de vraies courses avec le
 * noyau, relèvent le premier du classement aux instants des bornes, et vérifient que l'enregistreur
 * produit exactement ces valeurs-là — jamais une approximation déduite d'une position d'écran.
 */

/** Nombre de pas d'un segment : `20 s` à `DT = 1/60 s`, soit `1200` pas. */
const STEPS_PER_SEGMENT = Math.round(RACE_CONFIG.SEGMENT_DURATION_S / RACE_CONFIG.DT_S);

/** Course rejouée jusqu'à un instant donné, avec son classement à cet instant. */
function raceAt(seed: string, steps: number): RaceState {
  const engine = new RaceEngine(seed);
  for (let step = 0; step < steps; step += 1) {
    engine.step();
  }
  return engine.getState();
}

/** Nom affichable officiel d'un identifiant du roster. */
function nameOf(id: string): string {
  return CHARACTERS.find((character) => character.id === id)?.name ?? '';
}

describe('enregistreur des passages en tête', () => {
  it('note le premier du classement réel au moment de chaque borne', () => {
    const recorder = new PassageRecorder();
    const checkpoint1Step = STEPS_PER_SEGMENT;

    // La simulation annonce la borne pendant sa pause : le rendu observe alors l'état **gelé** à
    // l'instant exact du passage, et rien d'autre.
    const atCheckpoint1 = raceAt(PLAIN_FINISH_SEED, checkpoint1Step);
    recorder.observe(atCheckpoint1, 1);

    const atCheckpoint2 = raceAt(PLAIN_FINISH_SEED, checkpoint1Step * 2);
    recorder.observe(atCheckpoint2, 2);

    const expected1 = leaderboardOf(atCheckpoint1)[0];
    const expected2 = leaderboardOf(atCheckpoint2)[0];
    expect(expected1).toBeDefined();
    expect(expected2).toBeDefined();

    const rows = recorder.rows();
    expect(rows).toHaveLength(2);
    expect(rows[0]?.checkpoint).toBe(1);
    expect(rows[0]?.characterId).toBe(expected1?.id);
    expect(rows[0]?.name).toBe(nameOf(expected1?.id ?? ''));
    // L'instant publié est celui **mesuré** par le noyau, jamais une constante recopiée.
    expect(rows[0]?.tSim).toBe(atCheckpoint1.tSim);
    expect(rows[0]?.tSim).toBe(RACE_CONFIG.SEGMENT_DURATION_S);
    expect(rows[1]?.checkpoint).toBe(2);
    expect(rows[1]?.characterId).toBe(expected2?.id);
    expect(rows[1]?.tSim).toBe(RACE_CONFIG.SEGMENT_DURATION_S * 2);
  });

  it('n’enregistre une borne qu’une seule fois, même observée pendant toute la pause', () => {
    const recorder = new PassageRecorder();
    const state = raceAt(PLAIN_FINISH_SEED, STEPS_PER_SEGMENT);
    for (let frame = 0; frame < 30; frame += 1) {
      recorder.observe(state, 1);
    }
    expect(recorder.rows()).toHaveLength(1);
  });

  it('n’invente aucune borne : sans checkpoint annoncé, aucune ligne n’existe', () => {
    const recorder = new PassageRecorder();
    const state = raceAt(PLAIN_FINISH_SEED, 600);
    for (let frame = 0; frame < 20; frame += 1) {
      recorder.observe(state, null);
    }
    expect(recorder.rows()).toEqual([]);
  });

  it('oublie la course précédente dès qu’une nouvelle course démarre', () => {
    const recorder = new PassageRecorder();
    const checkpoint1Step = STEPS_PER_SEGMENT;
    recorder.observe(raceAt(PLAIN_FINISH_SEED, checkpoint1Step), 1);
    expect(recorder.rows()).toHaveLength(1);

    // Une course relancée à la même seed repart du pas zéro : l'historique doit être vide, sinon
    // l'écran d'arrivée suivant afficherait les passages d'une course déjà jouée.
    const restarted: RaceState = { ...raceAt(PLAIN_FINISH_SEED, checkpoint1Step), steps: 0, tSim: 0 };
    recorder.observe(restarted, null);
    expect(recorder.rows()).toEqual([]);

    // Une autre seed repart également de zéro.
    recorder.observe(raceAt(PLAIN_FINISH_SEED, checkpoint1Step), 1);
    recorder.observe(raceAt('AUTRESEED', checkpoint1Step), null);
    expect(recorder.rows()).toEqual([]);
  });

  it('ne modifie jamais l’état du noyau qu’il observe', () => {
    const recorder = new PassageRecorder();
    const state = raceAt(PLAIN_FINISH_SEED, STEPS_PER_SEGMENT);
    const before = JSON.stringify(state);
    recorder.observe(state, 1);
    expect(JSON.stringify(state)).toBe(before);
  });

  it('refuse une borne qui n’est pas un numéro de checkpoint positif', () => {
    const recorder = new PassageRecorder();
    const state = raceAt(PLAIN_FINISH_SEED, 600);
    recorder.observe(state, 0);
    recorder.observe(state, -1);
    recorder.observe(state, 1.5);
    expect(recorder.rows()).toEqual([]);
  });
});

describe('passages présentés à l’arrivée', () => {
  it('ajoute l’arrivée comme troisième borne, jamais un « checkpoint 3 »', () => {
    const engine = new RaceEngine(PLAIN_FINISH_SEED);
    engine.runToCompletion();
    const state = engine.getState();
    const snapshot = captureFinishSnapshot(state);

    const recorder = new PassageRecorder();
    const checkpoint1Step = STEPS_PER_SEGMENT;
    recorder.observe(raceAt(PLAIN_FINISH_SEED, checkpoint1Step), 1);
    recorder.observe(raceAt(PLAIN_FINISH_SEED, checkpoint1Step * 2), 2);

    const model = buildFinishModel(snapshot, null, recorder.rows());
    expect(model.passages).toHaveLength(3);
    expect(model.passages.map((passage) => passage.checkpoint)).toEqual([1, 2, null]);
    // La dernière ligne est l'arrivée, et son vainqueur est **exactement** celui du podium.
    const arrival = model.passages[2];
    expect(arrival?.tSim).toBe(RACE_CONFIG.TOTAL_SIM_S);
    expect(arrival?.characterId).toBe(model.winner.id);
    expect(arrival?.name).toBe(model.winner.name);
    // Aucune borne ne dépasse l'arrivée : la course dure 60 s, et il n'existe pas de checkpoint 3.
    expect(model.passages.every((passage) => passage.tSim <= RACE_CONFIG.TOTAL_SIM_S)).toBe(true);
  });

  it('n’affiche que les bornes réellement observées, plus l’arrivée', () => {
    const engine = new RaceEngine(PLAIN_FINISH_SEED);
    engine.runToCompletion();
    const snapshot = captureFinishSnapshot(engine.getState());

    // Aucun checkpoint observé (par exemple une course lancée directement à l'arrivée) : seule la
    // ligne d'arrivée est présentée, et elle reste exacte.
    const model = buildFinishModel(snapshot, null, []);
    expect(model.passages).toHaveLength(1);
    expect(model.passages[0]?.checkpoint).toBeNull();
    expect(model.passages[0]?.characterId).toBe(model.winner.id);
  });

  it('ordonne les bornes par instant mesuré, sans jamais en perdre', () => {
    const engine = new RaceEngine(PLAIN_FINISH_SEED);
    engine.runToCompletion();
    const snapshot = captureFinishSnapshot(engine.getState());

    const model = buildFinishModel(snapshot, null, [
      { checkpoint: 2, tSim: 40, characterId: 'c3', name: 'Jean-Michel Turbo' },
      { checkpoint: 1, tSim: 20, characterId: 'c1', name: 'Mamie Nitro' },
    ]);
    expect(model.passages.map((passage) => passage.checkpoint)).toEqual([1, 2, null]);
    expect(model.passages[0]?.name).toBe('Mamie Nitro');
    expect(model.passages[1]?.name).toBe('Jean-Michel Turbo');
  });
});
