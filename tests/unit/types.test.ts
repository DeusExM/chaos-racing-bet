import { describe, expect, it } from 'vitest';

import { RACE_CONFIG } from '../../src/core/config';
import { segmentIndexAt } from '../../src/core/track';
import type {
  ActiveEvent,
  CharacterId,
  CharacterState,
  RaceFact,
  RacePhase,
  RaceResult,
  RaceState,
} from '../../src/core/types';

/**
 * Égalité de types, évaluée **par le compilateur**, jamais à l'exécution.
 *
 * C'est le seul moyen de verrouiller un type : les assertions d'exécution plus bas ne peuvent
 * vérifier que des noms de champs, pas des unions ni des mutabilités.
 */
type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

// ---------------------------------------------------------------------------------------------
// Garde-fous de compilation : chacune de ces lignes devient une erreur de `tsc --noEmit` si le
// contrat central de `ROADMAP.md` §A.4 dérive.
// ---------------------------------------------------------------------------------------------

/** `RacePhase` ne connaît que ces trois situations — aucun état de pause, de countdown ni de reprise. */
const phaseKindsAreExhaustive: Equals<RacePhase['kind'], 'idle' | 'running' | 'finished'> = true;

/** Le segment d'une phase est un **numéro humain** 1..4, pas un index 0..3. */
const segmentIsHumanNumber: Equals<Extract<RacePhase, { kind: 'running' }>['segment'], 1 | 2 | 3 | 4> =
  true;

/** La phase en cours porte bien le temps écoulé dans son segment. */
const runningPhaseCarriesElapsed: Equals<
  Extract<RacePhase, { kind: 'running' }>['segmentElapsedS'],
  number
> = true;

/** `CharacterState` expose exactement les champs du contrat — ni `event`, ni `rank`. */
const characterFieldsAreTheContract: Equals<
  keyof CharacterState,
  'id' | 'x' | 'v' | 'drift' | 'surge' | 'eventBonus' | 'activeEvent'
> = true;

/** Le classement n'est jamais stocké dans l'état. */
const characterHasNoRankField: Equals<Extract<keyof CharacterState, 'rank'>, never> = true;

/** Aucun champ de caractéristique permanente : rien pour avantager un personnage. */
const characterHasNoTraitField: Equals<
  Extract<keyof CharacterState, 'bonus' | 'strength' | 'trait' | 'handicap'>,
  never
> = true;

const characterIdIsStable: Equals<CharacterState['id'], CharacterId> = true;
const activeEventIsNullable: Equals<CharacterState['activeEvent'], ActiveEvent | null> = true;

/** `RaceState` expose exactement les champs du contrat central. */
const raceStateFieldsAreTheContract: Equals<
  keyof RaceState,
  'seed' | 'seedValue' | 'tSim' | 'steps' | 'phase' | 'characters'
> = true;

const raceStateCarriesSeedText: Equals<RaceState['seed'], string> = true;
const raceStateCarriesSeedValue: Equals<RaceState['seedValue'], number> = true;
const raceStateCountsSteps: Equals<RaceState['steps'], number> = true;
const charactersAreAnOrderedArray: Equals<RaceState['characters'], readonly CharacterState[]> = true;

/** `RaceFact` reprend exactement les champs exigés par `GAME_DESIGN.md` §9.2. */
const raceFactFieldsMatchDesign: Equals<
  keyof RaceFact,
  'type' | 'tSim' | 'characterIds' | 'magnitudes' | 'importance' | 'textKey'
> = true;

/** Les segments humains admis par le contrat, dans l'ordre. */
const HUMAN_SEGMENTS: readonly (1 | 2 | 3 | 4)[] = [1, 2, 3, 4];

// ---------------------------------------------------------------------------------------------
// Valeurs de référence, écrites à la main d'après le contrat.
// ---------------------------------------------------------------------------------------------

const IDLE_PHASE: RacePhase = { kind: 'idle' };
const RUNNING_PHASE: RacePhase = { kind: 'running', segment: 1, segmentElapsedS: 0 };
const FINISHED_PHASE: RacePhase = { kind: 'finished' };

const CHARACTER: CharacterState = {
  id: 'c0',
  x: 0,
  v: 12,
  drift: 0,
  surge: 0,
  eventBonus: 0,
  activeEvent: null,
};

const RACE_STATE: RaceState = {
  seed: 'K7QM2X9A',
  seedValue: 133_990_825,
  tSim: 0,
  steps: 0,
  phase: IDLE_PHASE,
  characters: [CHARACTER],
};

/**
 * Jamais appelée : cette fonction n'existe que pour que `tsc` refuse la compilation si l'un de ces
 * champs devient `readonly` — c'est-à-dire si le moteur ne peut plus faire avancer l'état.
 */
function assertEngineCanAdvanceState(state: RaceState, character: CharacterState): void {
  character.x += character.v;
  character.v = 0;
  character.drift = 0;
  character.surge = 0;
  character.eventBonus = 0;
  character.activeEvent = null;
  state.tSim = 0;
  state.steps = 0;
  state.phase = RUNNING_PHASE;
}

describe('contrat central (ROADMAP.md §A.4)', () => {
  it('vérifie à la compilation que les types n’ont pas dérivé', () => {
    expect([
      phaseKindsAreExhaustive,
      segmentIsHumanNumber,
      runningPhaseCarriesElapsed,
      characterFieldsAreTheContract,
      characterHasNoRankField,
      characterHasNoTraitField,
      characterIdIsStable,
      activeEventIsNullable,
      raceStateFieldsAreTheContract,
      raceStateCarriesSeedText,
      raceStateCarriesSeedValue,
      raceStateCountsSteps,
      charactersAreAnOrderedArray,
      raceFactFieldsMatchDesign,
    ]).toEqual(new Array(14).fill(true));
  });

  it('expose exactement les champs attendus, à l’exécution', () => {
    expect(Object.keys(CHARACTER).sort()).toEqual([
      'activeEvent',
      'drift',
      'eventBonus',
      'id',
      'surge',
      'v',
      'x',
    ]);
    expect(Object.keys(RACE_STATE).sort()).toEqual([
      'characters',
      'phase',
      'seed',
      'seedValue',
      'steps',
      'tSim',
    ]);
    expect(Object.keys(IDLE_PHASE)).toEqual(['kind']);
    expect(Object.keys(FINISHED_PHASE)).toEqual(['kind']);
    expect(Object.keys(RUNNING_PHASE).sort()).toEqual(['kind', 'segment', 'segmentElapsedS']);
  });

  it('ne porte aucun champ de classement ni de caractéristique dans l’état', () => {
    for (const forbidden of ['rank', 'position', 'bonus', 'trait', 'speedMultiplier']) {
      expect(Object.keys(CHARACTER)).not.toContain(forbidden);
    }
  });

  it('laisse au moteur des champs réellement modifiables', () => {
    expect(typeof assertEngineCanAdvanceState).toBe('function');
  });

  it('numérote les segments de 1 à 4, quand track.ts les indexe de 0 à 3', () => {
    expect(HUMAN_SEGMENTS).toHaveLength(RACE_CONFIG.SEGMENT_COUNT);
    expect(HUMAN_SEGMENTS.at(0)).toBe(1);
    expect(HUMAN_SEGMENTS.at(-1)).toBe(RACE_CONFIG.SEGMENT_COUNT);

    // C'est le seul lien entre les deux conventions : `segmentIndexAt + 1`, au début de chaque
    // segment comme sur la borne finale.
    for (const segment of HUMAN_SEGMENTS) {
      const tSim = (segment - 1) * RACE_CONFIG.SEGMENT_DURATION_S;
      expect(segmentIndexAt(tSim) + 1, `segment ${segment}`).toBe(segment);
    }
    expect(segmentIndexAt(RACE_CONFIG.TOTAL_SIM_S) + 1).toBe(RACE_CONFIG.SEGMENT_COUNT);
  });

  it('reste compatible avec un résultat de course complet', () => {
    const result: RaceResult = { tSim: RACE_CONFIG.TOTAL_SIM_S, ranking: ['c0'], distances: [0] };

    expect(Object.keys(result).sort()).toEqual(['distances', 'ranking', 'tSim']);
    expect(result.tSim).toBe(180);
  });
});
