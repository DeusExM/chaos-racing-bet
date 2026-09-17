import { describe, expect, it } from 'vitest';

import { CHARACTER_IDS } from '../../src/core/characters';
import { RACE_CONFIG } from '../../src/core/config';
import { RaceEngine } from '../../src/core/engine';
import { isCanonicalSeedText } from '../../src/core/seed';

import golden from './fixtures/golden-seeds.json';

/**
 * Table de seeds dorées.
 *
 * Les valeurs de `fixtures/golden-seeds.json` ont été **mesurées** avec le moteur réellement
 * implémenté, jamais choisies. Elles ne doivent **jamais** être mises à jour pour faire passer un
 * test : si elles changent, c'est qu'une règle du noyau a changé, et la mise à jour doit être
 * volontaire, documentée, et expliquée dans le compte rendu (AGENTS §2).
 */
describe('seeds dorées', () => {
  it('contient plusieurs seeds affichées explicites, canoniques et distinctes', () => {
    expect(golden.goldenSeeds.length).toBeGreaterThanOrEqual(4);
    expect(new Set(golden.goldenSeeds.map((entry) => entry.seed)).size).toBe(
      golden.goldenSeeds.length,
    );

    for (const entry of golden.goldenSeeds) {
      expect(isCanonicalSeedText(entry.seed), entry.seed).toBe(true);
      expect(entry.distances).toHaveLength(CHARACTER_IDS.length);
      expect(entry.ranking).toHaveLength(CHARACTER_IDS.length);
      expect(entry.tSim).toBe(RACE_CONFIG.TOTAL_SIM_S);
    }
  });

  for (const entry of golden.goldenSeeds) {
    it(`reproduit exactement la course de la seed ${entry.seed}`, () => {
      const engine = new RaceEngine(entry.seed);
      const result = engine.runToCompletion();

      expect(engine.getState().steps).toBe(RACE_CONFIG.TOTAL_STEPS);
      expect(engine.getState().tSim).toBe(entry.tSim);
      // Comparaison bit à bit, pas une tolérance.
      expect(new Float64Array(result.distances)).toEqual(new Float64Array(entry.distances));
      expect(result.ranking).toEqual(entry.ranking);
    });
  }

  it('donne un classement cohérent avec les distances dorées', () => {
    for (const entry of golden.goldenSeeds) {
      const ordered = [...CHARACTER_IDS].sort((a, b) => {
        const indexA = CHARACTER_IDS.indexOf(a);
        const indexB = CHARACTER_IDS.indexOf(b);
        const distanceA = entry.distances[indexA] ?? 0;
        const distanceB = entry.distances[indexB] ?? 0;
        return distanceB - distanceA || indexA - indexB;
      });

      expect(ordered, entry.seed).toEqual(entry.ranking);
    }
  });

  it('rejoue une même seed deux fois avec une égalité stricte', () => {
    const seed = golden.goldenSeeds[0]?.seed ?? 'K7QM2X9A';
    const first = new RaceEngine(seed).runToCompletion();
    const second = new RaceEngine(seed).runToCompletion();

    expect(first.distances).toHaveLength(second.distances.length);
    for (const [index, distance] of first.distances.entries()) {
      expect(Object.is(distance, second.distances[index]), `index ${index}`).toBe(true);
    }
  });

  it('associe des courses différentes à des seeds différentes', () => {
    const signatures = golden.goldenSeeds.map((entry) => entry.distances.join('|'));
    expect(new Set(signatures).size).toBe(golden.goldenSeeds.length);
  });
});
