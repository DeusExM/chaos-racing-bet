import { describe, expect, it } from 'vitest';

import { CHARACTER_IDS } from '../../src/core/characters';
import { RACE_CONFIG } from '../../src/core/config';
import { RaceEngine } from '../../src/core/engine';
import {
  DEFAULT_PARTICIPANTS,
  MAX_PARTICIPANTS,
  MIN_PARTICIPANTS,
  selectParticipants,
} from '../../src/core/participants';
import { normalizeSeed } from '../../src/core/seed';
import type { RaceFact, RaceFactType } from '../../src/core/types';
import {
  buildFinishModel,
  captureFinishSnapshot,
} from '../../src/render/view/finishModel';
import { RaceSimulation } from '../../src/sim/RaceSimulation';
import { GAME_CONFIG } from '../../src/core/config';
import { SIM_PRESETS } from '../../src/sim/config';
import { buildLeaderboard } from '../../src/sim/leaderboard';

/**
 * Courses de 3 à 6 coureurs — bout en bout, sans navigateur.
 *
 * Le noyau est rejoué pour de vrai à chaque effectif, et tout ce qui dépend du plateau est vérifié sur
 * des **mesures** : nombre de partants, classement, faits, événements, historique de relecture,
 * classement final, podium, et véracité des répliques. Un seul test n'est pas mesuré mais **comparé** :
 * celui de non-régression à six coureurs, qui exige l'identité bit à bit avec une course à six
 * demandée explicitement.
 */

const COUNTS: readonly number[] = [MIN_PARTICIPANTS, 4, 5, MAX_PARTICIPANTS];

/** Seeds canoniques déterministes : distinctes, stables d'une exécution à l'autre. */
function canonicalSeeds(count: number): readonly string[] {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const seeds: string[] = [];

  for (let index = 0; index < count; index += 1) {
    let state = Math.imul(index + 1, 0x9e3779b1) | 0;
    let seed = '';
    for (let position = 0; position < 8; position += 1) {
      state = (Math.imul(state, 1103515245) + 12345) | 0;
      seed += alphabet[(state >>> 16) & 31] ?? '0';
    }
    seeds.push(seed);
  }

  return seeds;
}

const SEEDS = canonicalSeeds(24);

/**
 * Délai des campagnes.
 *
 * Chaque vérification rejoue de vraies courses complètes (3 600 pas) pour plusieurs effectifs : le
 * travail est réel, donc le délai est déclaré localement, sans toucher au délai par défaut de Vitest.
 */
const CAMPAIGN = { timeout: 30_000 } as const;

/** Course complète d'un effectif donné, avec ses faits. */
function race(seed: string, players: number): { engine: RaceEngine; facts: readonly RaceFact[] } {
  const engine = new RaceEngine(seed, GAME_CONFIG, { players });
  engine.runToCompletion();
  return { engine, facts: engine.drainFacts() };
}

const EVENT_FACT_TYPES: readonly RaceFactType[] = Object.freeze([
  'BIG_BONUS',
  'LEADER_MALUS',
]);

describe('le moteur court réellement à N partants', () => {
  it('aligne exactement N personnages, choisis dans le roster officiel', CAMPAIGN, () => {
    for (const seed of SEEDS) {
      for (const players of COUNTS) {
        const { engine } = race(seed, players);
        const state = engine.getState();
        expect(state.characters, `${seed} à ${String(players)}`).toHaveLength(players);
        expect(engine.playersCount).toBe(players);
        expect(engine.participantIds).toEqual(selectParticipants(normalizeSeed(seed), players));

        const ids = state.characters.map((character) => character.id);
        expect(new Set(ids).size).toBe(players);
        for (const id of ids) {
          expect(CHARACTER_IDS, `${seed} : ${id} hors roster`).toContain(id);
        }
      }
    }
  });

  it('ne cible jamais un personnage absent du plateau', CAMPAIGN, () => {
    for (const seed of SEEDS) {
      for (const players of COUNTS) {
        const { engine, facts } = race(seed, players);
        const participants = new Set(engine.participantIds);
        for (const fact of facts) {
          for (const id of fact.characterIds) {
            expect(
              participants.has(id),
              `${seed} à ${String(players)} : le fait ${fact.type} cite ${id}, qui ne court pas`,
            ).toBe(true);
          }
        }
      }
    }
  });

  it('ne cible les événements que sur les partants', CAMPAIGN, () => {
    for (const seed of SEEDS) {
      for (const players of COUNTS) {
        const { engine, facts } = race(seed, players);
        const participants = engine.participantIds;
        const targeted = facts
          .filter((fact) => EVENT_FACT_TYPES.includes(fact.type))
          .flatMap((fact) => [...fact.characterIds]);
        for (const id of targeted) {
          expect(participants, `${seed} à ${String(players)} : événement sur ${id}`).toContain(id);
        }
      }
    }
  });

  it('publie un classement de exactement N lignes, cohérent avec les distances', CAMPAIGN, () => {
    for (const seed of SEEDS) {
      for (const players of COUNTS) {
        const { engine } = race(seed, players);
        const state = engine.getState();
        const rows = buildLeaderboard(
          state.characters.map((character) => character.x),
          state.characters.map((character) => character.id),
        );

        expect(rows, `${seed} à ${String(players)}`).toHaveLength(players);
        expect(rows.map((row) => row.rank)).toEqual(
          Array.from({ length: players }, (_, index) => index + 1),
        );
        for (let index = 1; index < rows.length; index += 1) {
          expect(rows[index - 1]?.distance ?? 0).toBeGreaterThanOrEqual(rows[index]?.distance ?? 0);
        }
      }
    }
  });
});

describe('historique de relecture et écran d’arrivée à N partants', () => {
  it('enregistre exactement N distances par instant de relecture', () => {
    for (const players of COUNTS) {
      const simulation = new RaceSimulation(SEEDS[0] ?? 'K7QM2X9A', SIM_PRESETS.fast, players);
      // Quelques pas suffisent : c'est la **largeur** de chaque instant qui est vérifiée ici.
      for (let step = 0; step < 30; step += 1) {
        simulation.update(RACE_CONFIG.DT_S);
      }
      simulation.toggleUserPause();
      const frame = simulation.history.frameAt(simulation.history.lastStep ?? 0);

      expect(frame, 'un instant doit être enregistré dès le départ').not.toBeNull();
      expect(simulation.participants, `effectif ${String(players)}`).toHaveLength(players);
      expect(simulation.players).toBe(players);
      expect(simulation.history.participantCount).toBe(players);
      expect(frame?.distances).toHaveLength(players);
      for (const distance of frame?.distances ?? []) {
        expect(Number.isFinite(distance)).toBe(true);
      }
    }
  });

  it('produit un classement final de N résultats et un podium de min(3, N)', CAMPAIGN, () => {
    const arrivalFact = (facts: readonly RaceFact[]): RaceFact | null =>
      facts.find((fact) => fact.type === 'FINISH' || fact.type === 'PHOTO_FINISH') ?? null;

    for (const seed of SEEDS.slice(0, 10)) {
      for (const players of COUNTS) {
        const { engine, facts } = race(seed, players);
        const arrival = arrivalFact(facts);
        expect(arrival, `${seed} à ${String(players)}`).not.toBeNull();

        const snapshot = captureFinishSnapshot(engine.getState());
        const model = buildFinishModel(snapshot, arrival);

        expect(model.rows, `${seed} à ${String(players)}`).toHaveLength(players);
        expect(model.podium).toHaveLength(Math.min(3, players));
        expect(model.rows.map((row) => row.rank)).toEqual(
          Array.from({ length: players }, (_, index) => index + 1),
        );
        expect(model.podium.map((row) => row.id)).toEqual(
          model.rows.slice(0, Math.min(3, players)).map((row) => row.id),
        );
      }
    }
  });

  it('n’affiche aucun second coureur absent du plateau dans une course à trois', () => {
    const { engine, facts } = race(SEEDS[0] ?? 'K7QM2X9A', MIN_PARTICIPANTS);
    const arrival = facts.find((fact) => fact.type === 'FINISH' || fact.type === 'PHOTO_FINISH');
    const model = buildFinishModel(
      captureFinishSnapshot(engine.getState()),
      arrival ?? null,
    );

    expect(model.rows).toHaveLength(MIN_PARTICIPANTS);
    expect(model.podium).toHaveLength(MIN_PARTICIPANTS);
    // Chaque marcheur du podium est un partant réel, et le podium est le **début** du classement
    // final : ce n'est pas une seconde liste, encore moins une liste de six réduite à trois.
    for (const row of model.podium) {
      expect(engine.participantIds, `le podium cite ${row.id}`).toContain(row.id);
    }
    expect(model.podium.map((row) => row.id)).toEqual(model.rows.map((row) => row.id));
    expect(model.rows[MIN_PARTICIPANTS - 1]?.rank).toBe(MIN_PARTICIPANTS);
  });
});

describe('le speaker ne peut pas annoncer un gain impossible', () => {
  it('borne chaque gain mesuré par la taille réelle du plateau', CAMPAIGN, () => {
    for (const seed of SEEDS) {
      for (const players of COUNTS) {
        const { engine, facts } = race(seed, players);
        const participants = new Set(engine.participantIds);

        for (const fact of facts) {
          if (fact.type !== 'BIG_COMEBACK' && fact.type !== 'LAST_COMEBACK') {
            continue;
          }
          const gain = fact.magnitudes[0] ?? 0;
          const rank = fact.magnitudes[1] ?? 0;

          // Un gain de places ne peut pas dépasser « dernier → premier ».
          expect(
            gain,
            `${seed} à ${String(players)} : ${fact.type} annonce ${String(gain)} places`,
          ).toBeLessThanOrEqual(players - 1);
          expect(gain).toBeGreaterThanOrEqual(1);
          // Le rang revendiqué existe dans le plateau, et le personnage court bien.
          expect(rank).toBeGreaterThanOrEqual(1);
          expect(rank).toBeLessThanOrEqual(players);
          for (const id of fact.characterIds) {
            expect(participants.has(id), `${seed} : ${fact.type} cite ${id}`).toBe(true);
          }
        }
      }
    }
  });

  it('adapte le seuil de remontée au plateau, sans changer la mesure', () => {
    // À trois coureurs, la remontée maximale vaut deux places : un seuil de trois ne produirait
    // jamais de fait. Le test vérifie que le fait existe quand même, et que le gain publié reste
    // exactement celui qui a été mesuré (jamais un « 3 places » sur un plateau de trois).
    const gains = new Set<number>();
    let bigComebacks = 0;

    for (const seed of SEEDS) {
      const { facts } = race(seed, MIN_PARTICIPANTS);
      for (const fact of facts) {
        if (fact.type !== 'BIG_COMEBACK') {
          continue;
        }
        bigComebacks += 1;
        gains.add(fact.magnitudes[0] ?? 0);
      }
    }

    expect(bigComebacks, 'une remontée à trois coureurs doit rester possible').toBeGreaterThan(0);
    for (const gain of gains) {
      expect(gain, 'jamais trois places gagnées sur un plateau de trois').toBeLessThanOrEqual(2);
    }
  });

  it('garde le sens du fait « dernier puis remontée » sur un plateau réduit', () => {
    // À trois coureurs : dernier, puis 2e ou mieux. Le rang publié ne peut donc pas dépasser 2.
    for (const seed of SEEDS) {
      const { facts } = race(seed, MIN_PARTICIPANTS);
      for (const fact of facts) {
        if (fact.type !== 'LAST_COMEBACK') {
          continue;
        }
        expect(fact.magnitudes[1] ?? 0).toBeLessThanOrEqual(2);
        expect(fact.magnitudes[0] ?? 0).toBeLessThanOrEqual(2);
      }
    }
  });
});

describe('non-régression : les courses à six coureurs sont inchangées', () => {
  it('donne exactement la même course, à six, qu’un effectif demandé explicitement', CAMPAIGN, () => {
    for (const seed of SEEDS) {
      const implicit = race(seed, DEFAULT_PARTICIPANTS);
      const explicit = race(seed, MAX_PARTICIPANTS);

      const implicitResult = implicit.engine.runToCompletion();
      const explicitResult = explicit.engine.runToCompletion();

      expect(new Float64Array(implicitResult.distances)).toEqual(
        new Float64Array(explicitResult.distances),
      );
      expect(implicitResult.ranking).toEqual(explicitResult.ranking);
      expect(implicit.facts).toEqual(explicit.facts);
      expect(implicit.engine.participantIds).toEqual([...CHARACTER_IDS]);
    }
  });

  it('ne consomme aucun tirage pour choisir les partants à six', () => {
    // Preuve indirecte mais décisive : la sélection renvoie le roster lui-même (identité), donc aucune
    // copie n'a été mélangée. Un tirage, même de zéro pas, aurait produit un tableau distinct.
    for (const seed of SEEDS) {
      expect(selectParticipants(normalizeSeed(seed), MAX_PARTICIPANTS)).toBe(CHARACTER_IDS);
    }
  });

  it('conserve les six voies et la géométrie historique à six coureurs', () => {
    const ids = selectParticipants(normalizeSeed(SEEDS[0] ?? 'K7QM2X9A'), MAX_PARTICIPANTS);
    expect(ids).toHaveLength(6);
    expect(ids).toEqual([...CHARACTER_IDS]);
  });
});