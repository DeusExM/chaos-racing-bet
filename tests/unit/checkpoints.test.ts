import { describe, expect, it } from 'vitest';

import { CHARACTER_IDS } from '../../src/core/characters';
import { GAME_CONFIG, RACE_CONFIG } from '../../src/core/config';
import { RaceEngine } from '../../src/core/engine';
import { computeRanks } from '../../src/core/ranking';
import type { RaceFact, RacePhase } from '../../src/core/types';

/**
 * P006, côté **noyau** : les checkpoints.
 *
 * Le noyau ne fait qu'une chose de plus qu'en P004 : il **signale** les instants `tSim = 45`, `90` et
 * `135 s`. Il ne s'arrête pas, ne connaît aucune durée de pause et n'a aucun état de pause. Ces tests
 * vérifient donc deux choses indissociables : les trois faits tombent sur les bonnes bornes, et le
 * noyau reste un noyau.
 */

const SEED = 'POULET42';
const DT = RACE_CONFIG.DT_S;

/** Pas exacts des trois bornes internes : 2700, 5400 et 8100. */
const SPLIT_STEPS: readonly number[] = [1, 2, 3].map(
  (index) => index * RACE_CONFIG.STEPS_PER_SEGMENT,
);

/** Instants simulés attendus, dans l'ordre. */
const SPLIT_TIMES: readonly number[] = SPLIT_STEPS.map((steps) => steps * DT);

/** Joue `count` pas, sans regarder les faits. */
function stepMany(engine: RaceEngine, count: number): void {
  for (let index = 0; index < count; index += 1) {
    engine.step();
  }
}

/**
 * Ne retient que les splits d'un tampon de faits.
 *
 * Depuis P009-A, `drainFacts()` transporte **tous** les faits de la course (leaderships, dépassements,
 * événements, arrivée…) : ces tests-ci ne portent que sur les checkpoints, ils filtrent donc
 * explicitement, au lieu de supposer que le tampon ne contient qu'eux.
 */
function splitsOf(facts: readonly RaceFact[]): readonly RaceFact[] {
  return facts.filter((fact) => fact.type === 'CHECKPOINT_SPLIT');
}

/**
 * Garde **de compilation** : le noyau ne connaît que trois phases.
 *
 * Si une phase de pause était ajoutée à `RacePhase`, cette fonction cesserait de compiler — l'invariant
 * « aucune pause dans le noyau » est donc vérifié par le type lui-même, pas seulement à l'exécution.
 */
function closedPhaseKind(kind: RacePhase['kind']): 'idle' | 'running' | 'finished' {
  return kind;
}

describe('CHECKPOINT_SPLIT — bornes exactes', () => {
  it('signale le split 45 au pas 2700, et rien au pas 2699', () => {
    const engine = new RaceEngine(SEED);

    stepMany(engine, RACE_CONFIG.STEPS_PER_SEGMENT - 1);
    expect(splitsOf(engine.drainFacts()), 'aucun split un pas avant la borne').toEqual([]);
    expect(engine.getState().steps).toBe(RACE_CONFIG.STEPS_PER_SEGMENT - 1);
    expect(engine.getState().tSim).toBe((RACE_CONFIG.STEPS_PER_SEGMENT - 1) * DT);

    engine.step();
    const splits = splitsOf(engine.drainFacts());
    expect(splits).toHaveLength(1);
    expect(splits[0]?.type).toBe('CHECKPOINT_SPLIT');
    expect(splits[0]?.tSim).toBe(45);
    expect(engine.getState().tSim).toBe(45);
  });

  it('place les trois splits sur 45, 90 et 135 s, et sur aucune autre borne', () => {
    for (const [index, steps] of SPLIT_STEPS.entries()) {
      const engine = new RaceEngine(SEED);

      stepMany(engine, steps - 1);
      // Un pas avant la borne : les splits déjà franchis sont là, celui-ci **pas encore**.
      expect(splitsOf(engine.drainFacts()).map((fact) => fact.tSim)).toEqual(
        SPLIT_TIMES.slice(0, index),
      );

      engine.step();
      const splits = splitsOf(engine.drainFacts());
      expect(splits).toHaveLength(1);
      expect(splits[0]?.tSim).toBe(SPLIT_TIMES[index]);
    }
  });

  it('produit exactement trois splits sur une course complète, sans doublon', () => {
    const engine = new RaceEngine(SEED);
    const splitTimes: number[] = [];

    for (let step = 1; step <= RACE_CONFIG.TOTAL_STEPS; step += 1) {
      engine.step();
      for (const fact of splitsOf(engine.drainFacts())) {
        splitTimes.push(fact.tSim);
      }
    }

    expect(splitTimes).toEqual([45, 90, 135]);
    expect(new Set(splitTimes).size).toBe(3);
    expect(engine.getState().steps).toBe(RACE_CONFIG.TOTAL_STEPS);
  });

  it('n’émet aucun split au départ ni à l’arrivée', () => {
    const engine = new RaceEngine(SEED);

    // Départ : `tSim = 0` n'est pas un checkpoint.
    expect(engine.getState().tSim).toBe(0);
    expect(engine.drainFacts()).toEqual([]);

    // Arrivée : `tSim = 180` n'en est pas un non plus, c'est `finished` (et le fait d'arrivée,
    // qui porte bien `tSim = 180` mais n'est pas un split).
    engine.runToCompletion();
    const facts = engine.drainFacts();
    const splits = splitsOf(facts);
    expect(splits.every((fact) => fact.tSim !== 0)).toBe(true);
    expect(splits.every((fact) => fact.tSim !== RACE_CONFIG.TOTAL_SIM_S)).toBe(true);
    expect(splits.map((fact) => fact.tSim)).toEqual([45, 90, 135]);
    expect(
      facts.filter((fact) => fact.type === 'FINISH' || fact.type === 'PHOTO_FINISH')[0]?.tSim,
    ).toBe(RACE_CONFIG.TOTAL_SIM_S);
  });

  it('produit les trois mêmes splits via runToCompletion()', () => {
    const engine = new RaceEngine(SEED);
    const result = engine.runToCompletion();

    expect(result.tSim).toBe(RACE_CONFIG.TOTAL_SIM_S);
    expect(splitsOf(engine.drainFacts()).map((fact) => fact.tSim)).toEqual([45, 90, 135]);
  });
});

describe('CHECKPOINT_SPLIT — contenu mesuré', () => {
  it('porte le classement réel du moment et les distances correspondantes', () => {
    const engine = new RaceEngine(SEED);
    stepMany(engine, RACE_CONFIG.STEPS_PER_SEGMENT);

    const facts = engine.drainFacts();
    const fact = splitsOf(facts)[0];
    expect(fact).toBeDefined();
    if (fact === undefined) {
      throw new Error('split attendu');
    }

    const state = engine.getState();
    const distances = state.characters.map((character) => character.x);
    const ids = state.characters.map((character) => character.id);

    // Le fait et le noyau décrivent le même instant : les distances publiées sont exactement celles
    // de `tSim = 45 s`, sans décalage d'un pas.
    expect(fact.magnitudes).toEqual([...distances].sort((a, b) => b - a));
    expect(fact.characterIds).toHaveLength(CHARACTER_IDS.length);
    expect([...fact.characterIds].sort()).toEqual([...CHARACTER_IDS].sort());

    // L'ordre des identifiants **est** le classement, du 1er au dernier.
    const ranks = computeRanks(distances, ids);
    const byId = new Map(ids.map((id, index) => [id, ranks[index]]));
    for (const [position, id] of fact.characterIds.entries()) {
      expect(byId.get(id)).toBe(position + 1);
    }
  });

  it('porte une importance normative et une clé de texte technique, jamais un texte', () => {
    const engine = new RaceEngine(SEED);
    stepMany(engine, RACE_CONFIG.STEPS_PER_SEGMENT);
    const facts = engine.drainFacts();
    const fact = splitsOf(facts)[0];

    // P009-A : l'importance de base de §9.2 est augmentée des deux modificateurs conditionnels,
    // mesurés sur la course (`+20` si un changement de leader a été confirmé depuis le checkpoint
    // précédent — depuis le départ, ici —, `+10` si l'écart P1–P2 est inférieur à 20 m).
    expect(GAME_CONFIG.FACT.CHECKPOINT_SPLIT_IMPORTANCE).toBe(38);
    const distances = engine.getState().characters.map((character) => character.x);
    const sorted = [...distances].sort((a, b) => b - a);
    const leaderChanged = facts.some((other) => other.type === 'LEADER_CHANGE');
    const closeAtSplit = (sorted[0] ?? 0) - (sorted[1] ?? 0) < GAME_CONFIG.FACT.CHECKPOINT_SPLIT_CLOSE_GAP_M;
    expect(fact?.importance).toBe(
      GAME_CONFIG.FACT.CHECKPOINT_SPLIT_IMPORTANCE +
        (leaderChanged ? GAME_CONFIG.FACT.CHECKPOINT_SPLIT_LEADER_CHANGE_BONUS : 0) +
        (closeAtSplit ? GAME_CONFIG.FACT.CHECKPOINT_SPLIT_CLOSE_BONUS : 0),
    );

    // Aucun texte visible dans le noyau : seulement une clé, résolue par `app/strings.fr.ts`.
    expect(fact?.textKey).toBe('fact.checkpointSplit');
    expect(fact?.textKey).not.toMatch(/\s/);
  });

  it('est figé : ni le fait ni ses tableaux ne peuvent être modifiés', () => {
    const engine = new RaceEngine(SEED);
    stepMany(engine, RACE_CONFIG.STEPS_PER_SEGMENT);
    const fact = splitsOf(engine.drainFacts())[0];

    expect(Object.isFrozen(fact)).toBe(true);
    expect(Object.isFrozen(fact?.characterIds)).toBe(true);
    expect(Object.isFrozen(fact?.magnitudes)).toBe(true);
  });
});

describe('drainFacts — tampon interne', () => {
  it('renvoie les faits puis vide le tampon', () => {
    const engine = new RaceEngine(SEED);
    stepMany(engine, RACE_CONFIG.STEPS_PER_SEGMENT);

    expect(splitsOf(engine.drainFacts())).toHaveLength(1);
    expect(engine.drainFacts()).toEqual([]);
    expect(engine.drainFacts()).toEqual([]);
  });

  it('ne vide rien depuis getState()', () => {
    const engine = new RaceEngine(SEED);
    stepMany(engine, RACE_CONFIG.STEPS_PER_SEGMENT);

    for (let index = 0; index < 5; index += 1) {
      engine.getState();
    }
    expect(splitsOf(engine.drainFacts())).toHaveLength(1);
  });

  it('est vidé par reset(), et une nouvelle course reproduit les mêmes splits', () => {
    const engine = new RaceEngine(SEED);
    stepMany(engine, RACE_CONFIG.STEPS_PER_SEGMENT);
    expect(splitsOf(engine.drainFacts())).toHaveLength(1);

    engine.reset(SEED);
    expect(engine.drainFacts()).toEqual([]);
    expect(engine.getState().steps).toBe(0);

    stepMany(engine, RACE_CONFIG.STEPS_PER_SEGMENT);
    expect(splitsOf(engine.drainFacts()).map((fact) => fact.tSim)).toEqual([45]);
  });

  it('n’ajoute aucun fait après la fin : step() est un no-op', () => {
    const engine = new RaceEngine(SEED);
    engine.runToCompletion();
    engine.drainFacts();

    const stepsAtEnd = engine.getState().steps;
    const stateAtEnd = engine.getState();
    for (let index = 0; index < 100; index += 1) {
      engine.step();
    }

    expect(engine.drainFacts()).toEqual([]);
    expect(engine.getState().steps).toBe(stepsAtEnd);
    expect(engine.getState().tSim).toBe(stateAtEnd.tSim);
  });
});

describe('le noyau ne connaît aucune pause', () => {
  it('garde un type de phase fermé sur idle / running / finished', () => {
    // Vérifié par la compilation : `closedPhaseKind` refuserait toute phase supplémentaire.
    expect(closedPhaseKind('idle')).toBe('idle');
    expect(closedPhaseKind('running')).toBe('running');
    expect(closedPhaseKind('finished')).toBe('finished');
  });

  it('n’expose que les clés attendues pour chaque phase', () => {
    const engine = new RaceEngine(SEED);
    expect(Object.keys(engine.getState().phase)).toEqual(['kind']);

    engine.step();
    expect(Object.keys(engine.getState().phase).sort()).toEqual([
      'kind',
      'segment',
      'segmentElapsedS',
    ]);

    engine.runToCompletion();
    expect(engine.getState().phase).toEqual({ kind: 'finished' });
  });

  it('ne traverse que running et finished sur une course entière', () => {
    const engine = new RaceEngine(SEED);
    const observed = new Set<string>();

    for (let step = 1; step <= RACE_CONFIG.TOTAL_STEPS; step += 1) {
      engine.step();
      observed.add(engine.getState().phase.kind);
    }

    // Aucune trace de pause nulle part : le noyau n'en a pas la notion.
    expect([...observed].sort()).toEqual(['finished', 'running']);
  });

  it('n’expose aucune constante de temps réel', () => {
    // Garde-fou de contrat : les durées réelles vivent dans `SIM_CONFIG`, jamais dans le noyau.
    expect(Object.keys(GAME_CONFIG.RACE)).not.toContain('COUNTDOWN_REAL_S');
    expect(Object.keys(GAME_CONFIG)).not.toContain('SIM');
  });
});
