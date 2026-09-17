import { describe, expect, it } from 'vitest';

import {
  DRIFT,
  EVENT,
  GAME_CONFIG,
  LEADER,
  OVERTAKE,
  RACE_CONFIG,
  RANK,
  SPEAK,
  SPEED,
  SQRT_DT,
  SURGE,
  validateConfig,
} from '../../src/core/config';
import type { GameConfig } from '../../src/core/config';

/**
 * Aucune clé de configuration ne doit évoquer une durée réelle ni une distance d'arrivée : ces
 * notions appartiennent à `SIM_CONFIG` (`src/sim/`) et au décor, jamais au noyau.
 */
const FORBIDDEN_KEY_PATTERN = /COUNTDOWN|PAUSE|TIME_?SCALE|FINISH|DISTANCE|REAL/i;

function assertDeeplyFrozen(value: unknown, path: string): void {
  if (typeof value !== 'object' || value === null) {
    return;
  }
  expect(Object.isFrozen(value), `${path} doit être figé`).toBe(true);
  for (const [key, child] of Object.entries(value)) {
    assertDeeplyFrozen(child, `${path}.${key}`);
  }
}

describe('constantes de temps simulé', () => {
  it('décrit exactement 4 segments de 45 s, soit 180 s de course', () => {
    expect(RACE_CONFIG.SEGMENT_COUNT).toBe(4);
    expect(RACE_CONFIG.SEGMENT_DURATION_S).toBe(45);
    expect(RACE_CONFIG.TOTAL_SIM_S).toBe(180);
    expect(RACE_CONFIG.SEGMENT_COUNT * RACE_CONFIG.SEGMENT_DURATION_S).toBe(RACE_CONFIG.TOTAL_SIM_S);
  });

  it('compte 2700 pas par segment et 10800 pas pour la course entière', () => {
    expect(RACE_CONFIG.DT_S).toBe(1 / 60);
    expect(RACE_CONFIG.STEPS_PER_SEGMENT).toBe(2700);
    expect(RACE_CONFIG.TOTAL_STEPS).toBe(10800);
    expect(RACE_CONFIG.SEGMENT_COUNT * RACE_CONFIG.STEPS_PER_SEGMENT).toBe(RACE_CONFIG.TOTAL_STEPS);
  });

  it('place chaque instant de checkpoint exactement sur un pas de simulation', () => {
    // C'est cette exactitude qui permet à `track.ts` de comparer sans la moindre tolérance, et donc
    // d'affirmer « terminé à partir de 180 s, et seulement là ». Si cette propriété cassait, le
    // moteur devrait accumuler du temps et raterait les checkpoints : ce test est le garde-fou.
    expect(RACE_CONFIG.STEPS_PER_SEGMENT * RACE_CONFIG.DT_S).toBe(RACE_CONFIG.SEGMENT_DURATION_S);
    expect(RACE_CONFIG.TOTAL_STEPS * RACE_CONFIG.DT_S).toBe(RACE_CONFIG.TOTAL_SIM_S);
    expect(2 * RACE_CONFIG.STEPS_PER_SEGMENT * RACE_CONFIG.DT_S).toBe(90);
    expect(3 * RACE_CONFIG.STEPS_PER_SEGMENT * RACE_CONFIG.DT_S).toBe(135);
  });

  it('ne contient que les six constantes de temps simulé prévues', () => {
    expect(Object.keys(RACE_CONFIG).sort()).toEqual([
      'DT_S',
      'SEGMENT_COUNT',
      'SEGMENT_DURATION_S',
      'STEPS_PER_SEGMENT',
      'TOTAL_SIM_S',
      'TOTAL_STEPS',
    ]);
  });
});

describe('constante dérivée SQRT_DT', () => {
  it('vaut √DT sans que le noyau ait à calculer de racine', () => {
    // Vérification algébrique par élévation au carré : aucune fonction transcendante n'est appelée,
    // ni ici ni dans le noyau.
    expect(SQRT_DT * SQRT_DT).toBeCloseTo(RACE_CONFIG.DT_S, 15);
    expect(SQRT_DT).toBeCloseTo(0.12909944487358055, 15);
    expect(SQRT_DT).toBeGreaterThan(0);
    expect(SQRT_DT).toBeLessThan(1);
  });

  it('est la valeur correctement arrondie de la racine carrée du pas', () => {
    // `Math.sqrt` est légitime ici, dans un test : c'est précisément ce que le noyau n'a pas le
    // droit de faire, puisque son arrondi n'est pas garanti d'un moteur JavaScript à l'autre. Ce
    // test vérifie que la constante figée ne dérive pas d'une valeur fausse ou tronquée.
    const exact = Math.sqrt(RACE_CONFIG.DT_S);
    expect(Math.abs(SQRT_DT - exact) / exact).toBeLessThan(1e-15);
  });
});

describe('constantes de jeu', () => {
  it('reprend les vitesses normatives', () => {
    expect(SPEED).toEqual({
      BASE: 12.0,
      MIN: 3.0,
      MAX: 48.0,
      MAX_ACCEL: 10.0,
      MAX_DECEL: 12.0,
    });
  });

  it('reprend les constantes de dérive normative', () => {
    expect(DRIFT.THETA).toBe(0.25);
    expect(DRIFT.SIGMA).toBe(0.09);
    expect(DRIFT.CLAMP).toBe(0.2);
  });

  it('fige un écart-type stationnaire cohérent avec sigma et theta, sans racine carrée', () => {
    // `STATIONARY_SD = SIGMA / sqrt(2 × THETA)` est pré-calculé, puisque le noyau n'a pas le droit
    // d'appeler `Math.sqrt`. Cette identité algébrique équivalente vérifie la valeur figée sans
    // jamais utiliser de fonction transcendante.
    expect(DRIFT.STATIONARY_SD * DRIFT.STATIONARY_SD * 2 * DRIFT.THETA).toBe(DRIFT.SIGMA * DRIFT.SIGMA);
    expect(DRIFT.STATIONARY_SD).toBeCloseTo(0.12727922061357855, 15);
  });

  it('reprend les constantes de surges et de planificateur', () => {
    expect(SURGE.INTERVAL_MEAN_S).toBe(9.0);
    expect(SURGE.INTERVAL_MIN_S).toBe(4.0);
    expect(SURGE.DURATION_MIN_S).toBe(1.5);
    expect(SURGE.DURATION_MAX_S).toBe(4.0);
    expect(SURGE.MAGNITUDE_MIN).toBe(0.1);
    expect(SURGE.MAGNITUDE_MAX).toBe(0.35);
    expect(SURGE.BRAKE_PROBABILITY).toBe(0.45);
    expect(SURGE.MAGNITUDE_BRAKE_MIN).toBe(0.1);
    expect(SURGE.MAGNITUDE_BRAKE_MAX).toBe(0.3);

    // `1/14` : valeur d'origine, **rétablie par P010** après un passage temporaire à `1/10` motivé
    // par la densité du speaker. Le compte d'événements reste dans `[10 ; 16]` (≈ 10,2), et la
    // moyenne des répliques reste conforme : ce n'était donc pas une constante à bouger.
    expect(EVENT.RATE_PER_S).toBe(1 / 14);
    expect(EVENT.GLOBAL_COOLDOWN_S).toBe(4.0);
    expect(EVENT.CHAR_COOLDOWN_S).toBe(8.0);
    expect(EVENT.MAX_PER_CHARACTER).toBe(5);
    expect(EVENT.MAX_ACTIVE_PER_CHARACTER).toBe(1);
  });

  it('reprend les marges d’observation et la discipline de parole', () => {
    expect(OVERTAKE.MIN_MARGIN).toBe(0.5);
    expect(LEADER.DEBOUNCE_S).toBe(0.75);
    expect(LEADER.MIN_MARGIN).toBe(1.0);

    expect(SPEAK.MIN_IMPORTANCE).toBe(45);
    expect(SPEAK.GLOBAL_COOLDOWN_S).toBe(6.0);
    expect(SPEAK.PREEMPT_IMPORTANCE).toBe(85);
    expect(SPEAK.INTERRUPT_DELTA).toBe(20);
    expect(SPEAK.QUEUE_MAX).toBe(3);
    expect(SPEAK.MAX_LINES_PER_SEGMENT).toBe(12);
    expect(SPEAK.MIN_WINDOW_AVG_S).toBe(5.0);
  });

  it('ne fixe aucun seuil numérique pour le classement', () => {
    // Le classement découle uniquement des distances : il n'existe aucune marge, aucun lissage,
    // aucune constante de correction. Seule la politique de départage est nommée.
    expect(RANK.TIE_BREAK).toBe('ascendingId');
    expect(Object.values(RANK).filter((value) => typeof value === 'number')).toEqual([]);
  });

  it('gèle profondément chaque section et n’expose que des valeurs primitives', () => {
    for (const [section, values] of Object.entries(GAME_CONFIG)) {
      expect(Object.isFrozen(values), `${section} doit être figé`).toBe(true);
      for (const [key, value] of Object.entries(values)) {
        expect(typeof value, `${section}.${key} doit être une primitive`).toMatch(/^(number|string)$/);
      }
    }
    assertDeeplyFrozen(GAME_CONFIG, 'GAME_CONFIG');
  });

  it('ne contient aucune clé évoquant une durée réelle ou une distance d’arrivée', () => {
    for (const [section, values] of Object.entries(GAME_CONFIG)) {
      for (const key of Object.keys(values)) {
        expect(`${section}.${key}`).not.toMatch(FORBIDDEN_KEY_PATTERN);
      }
    }
  });
});

describe('validateConfig', () => {
  it('accepte la configuration du jeu', () => {
    expect(() => validateConfig()).not.toThrow();
    expect(() => validateConfig(GAME_CONFIG)).not.toThrow();
  });

  it('rejette des vitesses incohérentes', () => {
    const minAboveBase: GameConfig = { ...GAME_CONFIG, SPEED: { ...SPEED, MIN: SPEED.BASE + 1 } };
    expect(() => validateConfig(minAboveBase)).toThrow(RangeError);

    const maxBelowBase: GameConfig = { ...GAME_CONFIG, SPEED: { ...SPEED, MAX: SPEED.BASE - 1 } };
    expect(() => validateConfig(maxBelowBase)).toThrow(RangeError);

    const noDeceleration: GameConfig = { ...GAME_CONFIG, SPEED: { ...SPEED, MAX_DECEL: 0 } };
    expect(() => validateConfig(noDeceleration)).toThrow(RangeError);

    const notANumber: GameConfig = { ...GAME_CONFIG, SPEED: { ...SPEED, MAX_ACCEL: Number.NaN } };
    expect(() => validateConfig(notANumber)).toThrow(RangeError);
  });

  it('rejette une structure temporelle incohérente', () => {
    const wrongTotal: GameConfig = { ...GAME_CONFIG, RACE: { ...RACE_CONFIG, TOTAL_SIM_S: 181 } };
    expect(() => validateConfig(wrongTotal)).toThrow(RangeError);

    const wrongSteps: GameConfig = { ...GAME_CONFIG, RACE: { ...RACE_CONFIG, TOTAL_STEPS: 10_000 } };
    expect(() => validateConfig(wrongSteps)).toThrow(RangeError);

    const wrongSegmentSteps: GameConfig = {
      ...GAME_CONFIG,
      RACE: { ...RACE_CONFIG, STEPS_PER_SEGMENT: 2600 },
    };
    expect(() => validateConfig(wrongSegmentSteps)).toThrow(RangeError);

    const zeroSegments: GameConfig = { ...GAME_CONFIG, RACE: { ...RACE_CONFIG, SEGMENT_COUNT: 0 } };
    expect(() => validateConfig(zeroSegments)).toThrow(RangeError);
  });

  it('rejette un écart-type stationnaire qui ne correspond plus à sigma', () => {
    const wrongSd: GameConfig = { ...GAME_CONFIG, DRIFT: { ...DRIFT, STATIONARY_SD: 0.15 } };
    expect(() => validateConfig(wrongSd)).toThrow(RangeError);
  });

  it('rejette un écart-type stationnaire au-dessus de l’écrêtage', () => {
    const clampedPermanently: GameConfig = { ...GAME_CONFIG, DRIFT: { ...DRIFT, STATIONARY_SD: 0.5 } };
    expect(() => validateConfig(clampedPermanently)).toThrow(RangeError);
  });

  it('rejette des surges incohérents', () => {
    const impossibleProbability: GameConfig = {
      ...GAME_CONFIG,
      SURGE: { ...SURGE, BRAKE_PROBABILITY: 1.5 },
    };
    expect(() => validateConfig(impossibleProbability)).toThrow(RangeError);

    const invertedRange: GameConfig = {
      ...GAME_CONFIG,
      SURGE: { ...SURGE, DURATION_MIN_S: 5, DURATION_MAX_S: 1 },
    };
    expect(() => validateConfig(invertedRange)).toThrow(RangeError);

    const negativeMagnitude: GameConfig = {
      ...GAME_CONFIG,
      SURGE: { ...SURGE, MAGNITUDE_MIN: -0.1 },
    };
    expect(() => validateConfig(negativeMagnitude)).toThrow(RangeError);
  });

  it('rejette un planificateur incohérent', () => {
    const zeroRate: GameConfig = { ...GAME_CONFIG, EVENT: { ...EVENT, RATE_PER_S: 0 } };
    expect(() => validateConfig(zeroRate)).toThrow(RangeError);

    const fractionalCap: GameConfig = {
      ...GAME_CONFIG,
      EVENT: { ...EVENT, MAX_PER_CHARACTER: 2.5 },
    };
    expect(() => validateConfig(fractionalCap)).toThrow(RangeError);

    const negativeCooldown: GameConfig = {
      ...GAME_CONFIG,
      EVENT: { ...EVENT, CHAR_COOLDOWN_S: -1 },
    };
    expect(() => validateConfig(negativeCooldown)).toThrow(RangeError);
  });

  it('rejette une discipline de parole incohérente', () => {
    const preemptBelowMinimum: GameConfig = {
      ...GAME_CONFIG,
      SPEAK: { ...SPEAK, PREEMPT_IMPORTANCE: SPEAK.MIN_IMPORTANCE - 1 },
    };
    expect(() => validateConfig(preemptBelowMinimum)).toThrow(RangeError);

    const tooImportant: GameConfig = { ...GAME_CONFIG, SPEAK: { ...SPEAK, MIN_IMPORTANCE: 140 } };
    expect(() => validateConfig(tooImportant)).toThrow(RangeError);

    const zeroQueue: GameConfig = { ...GAME_CONFIG, SPEAK: { ...SPEAK, QUEUE_MAX: 0 } };
    expect(() => validateConfig(zeroQueue)).toThrow(RangeError);
  });

  it('rejette une marge de dépassement négative', () => {
    const negativeMargin: GameConfig = {
      ...GAME_CONFIG,
      OVERTAKE: { ...OVERTAKE, MIN_MARGIN: -0.1 },
    };
    expect(() => validateConfig(negativeMargin)).toThrow(RangeError);
  });
});
