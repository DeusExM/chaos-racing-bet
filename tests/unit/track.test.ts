import { describe, expect, it } from 'vitest';

import { RACE_CONFIG } from '../../src/core/config';
import {
  isCheckpointInstant,
  isRaceOver,
  segmentElapsedS,
  segmentIndexAt,
} from '../../src/core/track';

/**
 * Bornes temporelles demandées par le cahier des charges, de part et d'autre de chaque instant de
 * checkpoint et de la fin de course.
 */
const BOUNDARIES = [
  { tSim: 0, segment: 0, elapsedS: 0, checkpoint: false, over: false },
  { tSim: 19.999, segment: 0, elapsedS: 19.999, checkpoint: false, over: false },
  { tSim: 20.0, segment: 1, elapsedS: 0, checkpoint: true, over: false },
  { tSim: 20.001, segment: 1, elapsedS: 0.001, checkpoint: false, over: false },
  { tSim: 39.999, segment: 1, elapsedS: 19.999, checkpoint: false, over: false },
  { tSim: 40.0, segment: 2, elapsedS: 0, checkpoint: true, over: false },
  { tSim: 40.001, segment: 2, elapsedS: 0.001, checkpoint: false, over: false },
  { tSim: 59.999, segment: 2, elapsedS: 19.999, checkpoint: false, over: false },
  { tSim: 60.0, segment: 2, elapsedS: 20, checkpoint: false, over: true },
  { tSim: 60.001, segment: 2, elapsedS: 20.001, checkpoint: false, over: true },
] as const;

describe('segments temporels', () => {
  it('place chaque borne dans le bon segment', () => {
    for (const boundary of BOUNDARIES) {
      expect(segmentIndexAt(boundary.tSim), `segmentIndexAt(${boundary.tSim})`).toBe(boundary.segment);
    }
  });

  it('mesure le temps écoulé depuis le début du segment courant', () => {
    for (const boundary of BOUNDARIES) {
      expect(segmentElapsedS(boundary.tSim), `segmentElapsedS(${boundary.tSim})`).toBeCloseTo(
        boundary.elapsedS,
        9,
      );
    }
  });

  it('découpe la course en trois segments de 20 s, soit 60 s', () => {
    expect(segmentIndexAt(0)).toBe(0);
    expect(segmentIndexAt(59.999)).toBe(RACE_CONFIG.SEGMENT_COUNT - 1);
    expect(segmentIndexAt(60)).toBe(RACE_CONFIG.SEGMENT_COUNT - 1);
    // Au-delà de la fin, on reste dans le dernier segment : l'information n'est pas écrêtée.
    expect(segmentIndexAt(1000)).toBe(RACE_CONFIG.SEGMENT_COUNT - 1);
    expect(segmentElapsedS(1000)).toBeCloseTo(
      1000 - (RACE_CONFIG.SEGMENT_COUNT - 1) * RACE_CONFIG.SEGMENT_DURATION_S,
      9,
    );
  });
});

describe('instants de checkpoint', () => {
  it('ne reconnaît un checkpoint qu’à 20 et 40 secondes simulées', () => {
    for (const boundary of BOUNDARIES) {
      expect(
        isCheckpointInstant(boundary.tSim),
        `isCheckpointInstant(${boundary.tSim})`,
      ).toBe(boundary.checkpoint);
    }
  });

  it('ne reconnaît aucun autre instant de checkpoint sur toute la course', () => {
    const detected: number[] = [];
    for (let milliseconds = 0; milliseconds <= 60_000; milliseconds += 1) {
      const tSim = milliseconds / 1000;
      if (isCheckpointInstant(tSim)) {
        detected.push(tSim);
      }
    }

    expect(detected).toEqual([20, 40]);
  });

  it('tombe exactement sur un pas de simulation, sans aucune tolérance', () => {
    // Le moteur doit dériver `tSim` par multiplication (`step × DT_S`) et non par accumulation :
    // c'est ce qui rend les comparaisons de `track.ts` exactes, sans zone grise autour des bornes.
    for (let segment = 1; segment < RACE_CONFIG.SEGMENT_COUNT; segment += 1) {
      const step = segment * RACE_CONFIG.STEPS_PER_SEGMENT;
      const tSim = step * RACE_CONFIG.DT_S;

      expect(tSim, `pas ${step}`).toBe(segment * RACE_CONFIG.SEGMENT_DURATION_S);
      expect(segmentIndexAt(tSim)).toBe(segment);
      expect(segmentElapsedS(tSim)).toBe(0);
      expect(isCheckpointInstant(tSim)).toBe(true);
      expect(isRaceOver(tSim)).toBe(false);
    }
  });
});

describe('fin de course', () => {
  it('est vrai à partir de 60 s, et seulement là', () => {
    for (const boundary of BOUNDARIES) {
      expect(isRaceOver(boundary.tSim), `isRaceOver(${boundary.tSim})`).toBe(boundary.over);
    }
  });

  it('bascule exactement une fois, au pas 3600', () => {
    let violations = 0;
    let firstOver = -1;
    for (let milliseconds = 0; milliseconds <= 60_001; milliseconds += 1) {
      const tSim = milliseconds / 1000;
      const over = isRaceOver(tSim);
      if (over !== tSim >= RACE_CONFIG.TOTAL_SIM_S) {
        violations += 1;
      }
      if (over && firstOver === -1) {
        firstOver = tSim;
      }
    }

    expect(violations).toBe(0);
    expect(firstOver).toBe(RACE_CONFIG.TOTAL_SIM_S);

    const finalStep = RACE_CONFIG.TOTAL_STEPS * RACE_CONFIG.DT_S;
    expect(finalStep).toBe(RACE_CONFIG.TOTAL_SIM_S);
    expect(isRaceOver(finalStep)).toBe(true);
  });

  it('ne dépend que du temps simulé', () => {
    // Une seule entrée : aucune distance, aucun classement, aucune position ne peut décider de la
    // fin de la course. Le nombre d'arguments est la preuve directe de cette indépendance.
    expect(segmentIndexAt.length).toBe(1);
    expect(segmentElapsedS.length).toBe(1);
    expect(isCheckpointInstant.length).toBe(1);
    expect(isRaceOver.length).toBe(1);
  });
});

describe('robustesse des entrées', () => {
  it('refuse un temps simulé qui n’est pas un nombre fini', () => {
    for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => segmentIndexAt(invalid)).toThrow(RangeError);
      expect(() => segmentElapsedS(invalid)).toThrow(RangeError);
      expect(() => isCheckpointInstant(invalid)).toThrow(RangeError);
      expect(() => isRaceOver(invalid)).toThrow(RangeError);
    }
  });

  it('ramène un temps simulé négatif au départ, sans planter', () => {
    expect(segmentIndexAt(-1)).toBe(0);
    expect(segmentElapsedS(-1)).toBe(0);
    expect(isCheckpointInstant(-1)).toBe(false);
    expect(isRaceOver(-1)).toBe(false);
  });
});
