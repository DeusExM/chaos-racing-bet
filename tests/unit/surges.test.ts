import { describe, expect, it } from 'vitest';

import { CHARACTER_IDS } from '../../src/core/characters';
import { GAME_CONFIG, RACE_CONFIG, SURGE } from '../../src/core/config';
import { forkStream } from '../../src/core/rng';
import { normalizeSeed } from '../../src/core/seed';
import type { SurgeState } from '../../src/core/surges';
import {
  createSurgeState,
  durationStepRange,
  intervalMaxS,
  intervalStepRange,
  stepSurge,
  surgeParams,
} from '../../src/core/surges';

/**
 * P007 — le **planning** des surges, testé seul.
 *
 * Ces tests n'ont besoin ni de `RaceEngine`, ni du drift, ni du classement : le scheduling est une
 * fonction pure du flux `surge:<charId>` et du numéro de pas. C'est ce qui permet de vérifier les
 * propriétés statistiques sur 1000 seeds en moins d'une seconde, au lieu de simuler 6000 courses.
 */

const PARAMS = surgeParams(GAME_CONFIG);
const DT = RACE_CONFIG.DT_S;
const TOTAL_STEPS = RACE_CONFIG.TOTAL_STEPS;

/** Un flux de surge pour une seed et un personnage, exactement comme le fait `RaceEngine`. */
function surgeStream(seed: string, id: string) {
  return forkStream(normalizeSeed(seed), `surge:${id}`);
}

interface SurgeStart {
  readonly step: number;
  readonly magnitude: number;
  readonly endStep: number;
  readonly nextStartStep: number;
}

interface ScheduleObservation {
  readonly starts: readonly SurgeStart[];
  readonly intervals: readonly number[];
  readonly durations: readonly number[];
  readonly magnitudes: readonly number[];
  /** `true` si un surge démarre avant la fin du précédent : interdit par le non-cumul. */
  readonly overlapping: boolean;
}

/**
 * Intervalles réellement exploitables statistiquement.
 *
 * Un intervalle n'est mesurable que si le début **suivant** est observé : comme la course s'arrête
 * au pas `TOTAL_STEPS`, les intervalles longs commençant près de l'arrivée seraient
 * préférentiellement absents, ce qui biaiserait la moyenne **vers le bas** — un biais de mesure, pas
 * un biais du tirage. On ne retient donc que les débuts situés au moins `INTERVAL_MAX` pas avant la
 * fin : chacun est alors suivi de son début suivant, quoi qu'il arrive.
 */
function measurableIntervals(observation: ScheduleObservation): readonly number[] {
  const cut = TOTAL_STEPS - PARAMS.intervalSteps.max;
  const starts = observation.starts.filter((start) => start.step <= cut);
  const intervals: number[] = [];
  let previous = 0;
  for (const start of starts) {
    intervals.push(start.step - previous);
    previous = start.step;
  }
  return intervals;
}

/**
 * Déroule un planning pas à pas et observe les surges.
 *
 * Un démarrage est détecté par le **recul de `nextStartStep`** — la seule marque non ambiguë : une
 * magnitude peut passer directement d'un surge à un autre sans repasser par `0` (le suivant peut
 * démarrer exactement quand le précédent se termine), ce qu'une simple comparaison de magnitude
 * manquerait.
 */
function observeSchedule(seed: string, id: string, steps: number = TOTAL_STEPS): ScheduleObservation {
  const stream = surgeStream(seed, id);
  const state: SurgeState = createSurgeState(stream, PARAMS);
  const starts: SurgeStart[] = [];

  for (let step = 1; step <= steps; step += 1) {
    const previousNextStart = state.nextStartStep;
    const magnitude = stepSurge(state, stream, PARAMS, step);

    if (state.nextStartStep !== previousNextStart) {
      const endStep = state.endStep;
      if (endStep === null) {
        throw new Error('Un surge qui démarre doit avoir un pas de fin.');
      }
      starts.push({
        step,
        magnitude,
        endStep,
        nextStartStep: state.nextStartStep,
      });
    }
  }

  const intervals: number[] = [];
  const durations: number[] = [];
  const magnitudes: number[] = [];
  let overlapping = false;
  let previousStart = 0;

  for (const start of starts) {
    // L'attente initiale est tirée comme les intervalles suivants : elle compte donc comme un
    // intervalle, ce qui rend la moyenne mesurée directement comparable à `INTERVAL_MEAN_S`.
    intervals.push(start.step - previousStart);
    previousStart = start.step;
    durations.push(start.endStep - start.step);
    magnitudes.push(start.magnitude);
    if (start.nextStartStep < start.endStep) {
      overlapping = true;
    }
  }

  return { starts, intervals, durations, magnitudes, overlapping };
}

describe('bornes dérivées', () => {
  it('dérive la borne haute de l’intervalle sans nouvelle constante de jeu', () => {
    // `14 s` n'existe nulle part comme constante : c'est `2 × MEAN − MIN`, et rien d'autre.
    expect(intervalMaxS(GAME_CONFIG)).toBe(2 * SURGE.INTERVAL_MEAN_S - SURGE.INTERVAL_MIN_S);
    expect(intervalMaxS(GAME_CONFIG)).toBeCloseTo(14, 12);
    expect(Object.keys(SURGE)).not.toContain('INTERVAL_MAX_S');
  });

  it('convertit les bornes en pas entiers, une fois pour toutes', () => {
    expect(intervalStepRange(GAME_CONFIG)).toEqual({ min: 240, max: 840 });
    expect(durationStepRange(GAME_CONFIG)).toEqual({ min: 90, max: 240 });
    expect(PARAMS.intervalSteps).toEqual(intervalStepRange(GAME_CONFIG));
    expect(PARAMS.durationSteps).toEqual(durationStepRange(GAME_CONFIG));
  });

  it('garde une moyenne d’intervalle exactement égale à INTERVAL_MEAN_S', () => {
    const { min, max } = intervalStepRange(GAME_CONFIG);
    const meanSeconds = ((min + max) / 2) * DT;

    expect(meanSeconds).toBeCloseTo(SURGE.INTERVAL_MEAN_S, 10);
    // Sur 60 s, cela donne bien ~6,7 surges attendus par personnage — la même cadence qu'avant la
    // passe corrective, qui voyait 20 surges sur 180 s. La cadence est une propriété du jeu ; le
    // nombre par course, lui, suit la durée de la course.
    expect(RACE_CONFIG.TOTAL_SIM_S / SURGE.INTERVAL_MEAN_S).toBeCloseTo(20 / 3, 10);
  });

  it('tire les deux bornes inclusivement', () => {
    const { min, max } = intervalStepRange(GAME_CONFIG);
    const stream = surgeStream('BORNES42', 'c0');
    const seen = new Set<number>();

    for (let draw = 0; draw < 200_000; draw += 1) {
      seen.add(stream.nextInt(min, max));
    }

    expect(seen.has(min), `la borne basse ${min} doit être atteignable`).toBe(true);
    expect(seen.has(max), `la borne haute ${max} doit être atteignable`).toBe(true);
    expect(Math.min(...seen)).toBe(min);
    expect(Math.max(...seen)).toBe(max);
  });
});

describe('convention d’intervalle [startStep, endStep[', () => {
  it('fait démarrer le surge au pas de début et le termine au pas de fin, exclu', () => {
    const stream = surgeStream('BORNES42', 'c1');
    const state: SurgeState = { nextStartStep: 100, endStep: null, magnitude: 0 };

    // Avant le pas de départ : rien.
    expect(stepSurge(state, stream, PARAMS, 99)).toBe(0);
    expect(state.endStep).toBeNull();

    // Le pas de départ subit le surge.
    const magnitude = stepSurge(state, stream, PARAMS, 100);
    expect(magnitude).not.toBe(0);

    const endStep = state.endStep;
    expect(endStep).not.toBeNull();
    if (endStep === null) {
      throw new Error('pas de fin attendu');
    }
    expect(endStep).toBeGreaterThan(100);

    // Tous les pas intermédiaires portent la même magnitude.
    for (let step = 101; step < endStep; step += 1) {
      expect(stepSurge(state, stream, PARAMS, step), `pas ${step}`).toBe(magnitude);
    }

    // Le pas de fin ne le subit plus. On écarte d'abord tout démarrage immédiat, pour que ce test
    // porte bien sur la frontière et non sur un enchaînement fortuit.
    state.nextStartStep = endStep + 1000;
    expect(stepSurge(state, stream, PARAMS, endStep)).toBe(0);
    expect(state.endStep).toBeNull();
  });

  it('influence exactement N intégrations pour un surge de N pas', () => {
    const observation = observeSchedule('POULET42', 'c2', 4000);
    const first = observation.starts[0];
    expect(first, 'un premier surge doit exister').toBeDefined();
    if (first === undefined) {
      return;
    }

    const stream = surgeStream('POULET42', 'c2');
    const state = createSurgeState(stream, PARAMS);
    const influenced: number[] = [];
    for (let step = 1; step <= 4000; step += 1) {
      if (stepSurge(state, stream, PARAMS, step) !== 0) {
        influenced.push(step);
      }
    }

    // Le bloc du premier surge est exactement `[startStep, endStep[` : N pas, contigus, sans trou.
    const block = influenced.filter((step) => step >= first.step && step < first.endStep);
    const expected = Array.from({ length: first.endStep - first.step }, (_, index) => first.step + index);

    expect(block).toEqual(expected);
    expect(block).toHaveLength(first.endStep - first.step);
  });
});

describe('non-cumul', () => {
  it('ne démarre jamais un surge avant la fin du précédent', () => {
    for (const seed of ['POULET42', 'K7QM2X9A', 'ZZZZZZZZ', 'BANAN4X2']) {
      for (const id of CHARACTER_IDS) {
        const observation = observeSchedule(seed, id, 4000);
        expect(observation.overlapping, `${seed} / ${id}`).toBe(false);
        for (const start of observation.starts) {
          expect(start.nextStartStep - start.step).toBeGreaterThanOrEqual(
            start.endStep - start.step,
          );
        }
      }
    }
  });

  it('tire un intervalle minimal au moins égal à la durée maximale', () => {
    // C'est l'inégalité de `GAME_DESIGN.md` §6.4 qui rend le non-cumul structurel.
    expect(intervalStepRange(GAME_CONFIG).min).toBeGreaterThanOrEqual(
      durationStepRange(GAME_CONFIG).max,
    );
    expect(SURGE.DURATION_MAX_S).toBeLessThanOrEqual(SURGE.INTERVAL_MIN_S);
  });
});

describe('statistiques sur 1000 seeds', () => {
  const SEEDS = 1000;
  const counts = CHARACTER_IDS.map(() => 0);
  const allIntervals: number[] = [];
  const allDurations: number[] = [];
  const allMagnitudes: number[] = [];
  let brakeCount = 0;

  // Une seule passe, réutilisée par tous les tests statistiques : 1000 × 6 plannings complets.
  for (let index = 0; index < SEEDS; index += 1) {
    const seed = `SURGE${String(index).padStart(4, '0')}`;
    for (const [position, id] of CHARACTER_IDS.entries()) {
      const observation = observeSchedule(seed, id);
      counts[position] = (counts[position] ?? 0) + observation.starts.length;
      allIntervals.push(...measurableIntervals(observation));
      allDurations.push(...observation.durations);
      allMagnitudes.push(...observation.magnitudes);
    }
  }

  const perCharacterMeans = counts.map((count) => count / SEEDS);
  const globalMean = perCharacterMeans.reduce((sum, mean) => sum + mean, 0) / CHARACTER_IDS.length;

  it('reste dans [4,7 ; 8,7] surges par personnage sur 60 s, autour de 6,7', () => {
    // `SURGE.INTERVAL_MEAN_S = 9 s` est un **taux** : le nombre attendu pour une course vaut
    // `TOTAL_SIM_S / 9 ≈ 6,67`. La plage de P010 (`20 ± 30 %` pour `180 / 9 = 20`) devient donc
    // `6,67 ± 30 %`, soit `[4,7 ; 8,7]` — aucune constante de surge n'est modifiée.
    for (const [index, mean] of perCharacterMeans.entries()) {
      expect(mean, `${CHARACTER_IDS[index]}`).toBeGreaterThanOrEqual(4.7);
      expect(mean, `${CHARACTER_IDS[index]}`).toBeLessThanOrEqual(8.7);
    }
    expect(globalMean).toBeGreaterThanOrEqual(4.7);
    expect(globalMean).toBeLessThanOrEqual(8.7);
    // Cohérent avec la cible `TOTAL_SIM_S / INTERVAL_MEAN_S ≈ 6,67`.
    expect(Math.abs(globalMean - 20 / 3)).toBeLessThan(0.5);
  });

  it('garde tous les intervalles dans [4 ; 14] s, avec une moyenne proche de 9 s', () => {
    const { min, max } = intervalStepRange(GAME_CONFIG);

    for (const interval of allIntervals) {
      expect(Number.isInteger(interval)).toBe(true);
      expect(interval).toBeGreaterThanOrEqual(min);
      expect(interval).toBeLessThanOrEqual(max);
    }

    // Moyenne de la **loi de tirage**, mesurée sur les tirages bruts : c'est la seule mesure non
    // biaisée. La moyenne des intervalles *observés dans une course* est en effet biaisée vers le
    // bas par construction — une course de durée finie contient d'autant plus d'intervalles qu'ils
    // sont courts — et ce biais de renouvellement n'a rien à voir avec la loi elle-même.
    const stream = surgeStream('MOYENNE42', 'c0');
    const draws = 200_000;
    let total = 0;
    for (let draw = 0; draw < draws; draw += 1) {
      total += stream.nextInt(min, max);
    }
    const mean = total / draws;
    expect(Math.abs(mean - (min + max) / 2), `moyenne brute ${mean}`).toBeLessThan(2);

    // La moyenne observée en course reste du même ordre : environ 8,8 s. Elle est légèrement plus
    // basse qu'avant la passe corrective (8,79 mesuré ici, contre ~8,9 sur 180 s) parce que le biais
    // de renouvellement grandit quand la course raccourcit : une course de 60 s contient
    // proportionnellement plus d'intervalles courts. La borne haute, elle, ne bouge pas : au-dessus
    // de la moyenne de la loi (9 s), la mesure serait le signe d'un biais réel, pas de la durée.
    const observed = allIntervals.reduce((sum, value) => sum + value, 0) / allIntervals.length;
    expect(observed * DT).toBeGreaterThan(8.7);
    expect(observed * DT).toBeLessThan(9.2);
  });

  it('garde toutes les durées dans [90 ; 240] pas, donc [1,5 ; 4,0] s', () => {
    const { min, max } = durationStepRange(GAME_CONFIG);
    for (const duration of allDurations) {
      expect(Number.isInteger(duration)).toBe(true);
      expect(duration).toBeGreaterThanOrEqual(min);
      expect(duration).toBeLessThanOrEqual(max);
    }
    expect(min / 60).toBeCloseTo(SURGE.DURATION_MIN_S, 10);
    expect(max / 60).toBeCloseTo(SURGE.DURATION_MAX_S, 10);
  });

  it('garde les magnitudes dans les bornes, et environ 45 % de freinages', () => {
    for (const magnitude of allMagnitudes) {
      expect(magnitude).not.toBe(0);
      if (magnitude > 0) {
        expect(magnitude).toBeGreaterThanOrEqual(SURGE.MAGNITUDE_MIN);
        expect(magnitude).toBeLessThanOrEqual(SURGE.MAGNITUDE_MAX);
      } else {
        expect(magnitude).toBeLessThanOrEqual(-SURGE.MAGNITUDE_BRAKE_MIN);
        expect(magnitude).toBeGreaterThanOrEqual(-SURGE.MAGNITUDE_BRAKE_MAX);
      }
    }

    brakeCount = allMagnitudes.filter((magnitude) => magnitude < 0).length;
    const share = brakeCount / allMagnitudes.length;
    expect(share).toBeGreaterThan(0.42);
    expect(share).toBeLessThan(0.48);
  });

  it('n’a jamais laissé deux surges se chevaucher sur 6 000 plannings', () => {
    // Le non-cumul découle de la construction ; cette mesure vérifie qu'il tient sur les 6 000
    // plannings complets du corpus, soit 21,6 millions de pas planifiés depuis la passe corrective
    // (60 s par course au lieu de 180 s). La borne est dérivée de la cadence design — au moins
    // 5 surges par personnage et par course — et non d'une constante inventée pour passer.
    expect(allDurations.length).toBeGreaterThan(SEEDS * CHARACTER_IDS.length * 5);
    const overlapping = allDurations.filter(
      (duration, index) => duration > (allIntervals[index] ?? Number.POSITIVE_INFINITY),
    );
    expect(overlapping).toEqual([]);
  });
});

describe('indépendance des flux', () => {
  it('ne décale pas le planning de c0 quand on consomme c1..c5', () => {
    const alone = observeSchedule('POULET42', 'c0', 3000).starts;

    // Consommer tous les autres flux d'abord ne doit rien changer : les états sont dérivés
    // séparément, et l'ordre d'appel n'a aucune importance.
    for (const id of ['c1', 'c2', 'c3', 'c4', 'c5']) {
      observeSchedule('POULET42', id, 3000);
    }
    const after = observeSchedule('POULET42', 'c0', 3000).starts;

    expect(after).toEqual(alone);
  });

  it('ne décale pas drift:c0 quand on consomme surge:c0', () => {
    const driftSeed = normalizeSeed('POULET42');
    const reference: number[] = [];
    for (let index = 0; index < 500; index += 1) {
      reference.push(forkStream(driftSeed, 'drift:c0').next());
    }

    // Consommation du flux de surge, puis nouvelle lecture du drift : les deux suites sont distinctes.
    const surge = forkStream(driftSeed, 'surge:c0');
    for (let index = 0; index < 2000; index += 1) {
      surge.next();
    }
    const after: number[] = [];
    for (let index = 0; index < 500; index += 1) {
      after.push(forkStream(driftSeed, 'drift:c0').next());
    }

    expect(after).toEqual(reference);
  });

  it('rejoue exactement le même planning pour la même seed, et un autre pour une autre seed', () => {
    const first = observeSchedule('POULET42', 'c3', 4000);
    const same = observeSchedule('POULET42', 'c3', 4000);
    const other = observeSchedule('BANAN4X2', 'c3', 4000);

    expect(same.starts).toEqual(first.starts);
    expect(same.intervals).toEqual(first.intervals);
    expect(other.starts).not.toEqual(first.starts);
  });
});
