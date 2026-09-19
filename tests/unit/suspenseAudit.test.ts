/**
 * Tests de l'audit de suspense (`tools/suspenseAudit.ts`).
 *
 * ## Ce que ce fichier teste, et pourquoi il est **synthétique**
 *
 * Le corpus de référence (10 000 seeds) est mesuré par `npm run balance:suspense` : une suite
 * unitaire ne peut pas le rejouer. Ce fichier vérifie donc ce qui est vérifiable vite et sans
 * ambiguïté :
 *
 * 1. le **périmètre** : l'outil ne mesure que six coureurs, et toutes ses bornes et seuils sont
 *    **dérivés** de `RACE_CONFIG` et de `FACT`, jamais recopiés ;
 * 2. le calcul des **rangs** est exactement celui du classement officiel (`computeRanks`), égalités
 *    comprises — c'est la condition qui rend les mesures de remontée crédibles ;
 * 3. les **trajectoires** de rang et les drapeaux de remontée sont justes sur des historiques
 *    construits à la main : remontée maximale, « 6e puis top 3 », gain non compté deux fois ;
 * 4. les **statistiques** (quantiles, écarts, homogénéité) sont justes sur des séries connues ;
 * 5. une **course réelle** produit bien 3 600 pas, 60 s, trois leaders, six trajectoires et un seul
 *    vainqueur, et le suivi rapide **concorde** avec `computeRanks` ;
 * 6. la **synthèse** refuse un corpus qui ne serait pas à six, et les pourcentages sont exacts sur un
 *    corpus construit ;
 * 7. la **conclusion** ne signale une anomalie que sur une anomalie structurelle réelle, et une
 *    comparaison aux références n'est concluante que sur le corpus de 10 000 seeds.
 *
 * Aucune assertion ne porte sur une part mesurée à petit N : ces valeurs-là appartiennent au rapport
 * du corpus complet, pas à un test qui deviendrait instable (`AGENTS.md` §2).
 */

import { describe, expect, it } from 'vitest';

import { CHARACTER_IDS } from '../../src/core/characters';
import { FACT, RACE_CONFIG } from '../../src/core/config';
import { computeRanks } from '../../src/core/ranking';
import { corpusSeeds } from '../../tools/balanceStats';
import {
  COMEBACK_RANKS,
  DEFAULT_AUDIT_CORPUS,
  DEFAULT_SUSPENSE_SEEDS,
  FINAL_MARKS_S,
  FINAL_WINDOW_S,
  GAP_THRESHOLDS_M,
  LAST_CHANGE_WINDOWS_S,
  LEADER_BOUNDS_S,
  LEADER_BOUND_LABELS,
  SUSPENSE_PLAYERS,
  SUSPENSE_REFERENCES,
  auditSuspenseRace,
  buildSuspenseAuditJson,
  characterTrajectory,
  conclusionLines,
  gapSummary,
  homogeneityTest,
  parseSuspenseAuditArgs,
  quantile,
  raceComebackFlags,
  rankVector,
  referenceChecks,
  renderSuspenseAuditText,
  summarizeSuspenseAudit,
  type CharacterTrajectory,
  type LeaderPersistence,
  type SuspenseRaceAudit,
} from '../../tools/suspenseAudit';

// ---------------------------------------------------------------------------------------------
// Périmètre et constantes
// ---------------------------------------------------------------------------------------------

describe('périmètre de l’audit', () => {
  it('ne mesure que six coureurs', () => {
    expect(SUSPENSE_PLAYERS).toBe(6);
    expect(CHARACTER_IDS).toHaveLength(SUSPENSE_PLAYERS);
    expect(DEFAULT_SUSPENSE_SEEDS).toBe(10_000);
    // Les références publiées viennent du corpus de 10 000 seeds : l'outil doit viser le même.
    expect(SUSPENSE_REFERENCES.seeds).toBe(DEFAULT_SUSPENSE_SEEDS);
  });

  it('dérive ses bornes et sa fenêtre finale du noyau au lieu de les recopier', () => {
    expect(LEADER_BOUNDS_S).toEqual([
      RACE_CONFIG.SEGMENT_DURATION_S,
      2 * RACE_CONFIG.SEGMENT_DURATION_S,
      RACE_CONFIG.TOTAL_SIM_S,
    ]);
    expect(LEADER_BOUNDS_S).toHaveLength(RACE_CONFIG.SEGMENT_COUNT);
    expect(LEADER_BOUND_LABELS).toEqual(['20 s', '40 s', '60 s']);
    expect(FINAL_MARKS_S).toEqual([
      RACE_CONFIG.TOTAL_SIM_S - FINAL_WINDOW_S,
      RACE_CONFIG.TOTAL_SIM_S - FINAL_WINDOW_S / 2,
    ]);
    expect(LAST_CHANGE_WINDOWS_S).toEqual([20, 10, 5]);
    expect(COMEBACK_RANKS).toEqual([3, 2, 1]);
  });

  it('prend ses seuils d’écart dans les constantes du jeu', () => {
    expect(GAP_THRESHOLDS_M).toEqual([
      FACT.PHOTO_ARRIVAL_MAX_GAP_M,
      10,
      FACT.CLOSE_RACE_MAX_GAP_M,
      FACT.CHECKPOINT_SPLIT_CLOSE_GAP_M,
    ]);
    // Du plus serré au plus large : la courbe de sensibilité doit rester monotone.
    for (let index = 1; index < GAP_THRESHOLDS_M.length; index += 1) {
      expect(GAP_THRESHOLDS_M[index] ?? 0).toBeGreaterThan(GAP_THRESHOLDS_M[index - 1] ?? 0);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Rangs
// ---------------------------------------------------------------------------------------------

describe('rangs', () => {
  it('donne exactement le classement officiel sur des distances distinctes', () => {
    const xs = [5, 9, 1, 7, 3, 2];
    expect(rankVector(xs, CHARACTER_IDS)).toEqual(computeRanks(xs, CHARACTER_IDS));
  });

  it('départage les égalités par identifiant croissant, comme le classement officiel', () => {
    const allEqual = [4, 4, 4, 4, 4, 4];
    expect(rankVector(allEqual, CHARACTER_IDS)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(rankVector(allEqual, CHARACTER_IDS)).toEqual(computeRanks(allEqual, CHARACTER_IDS));

    const partial = [2, 2, 5, 5, 5, 0];
    expect(rankVector(partial, CHARACTER_IDS)).toEqual(computeRanks(partial, CHARACTER_IDS));
  });

  it('reste identique à computeRanks sur un grand nombre de tirages, égalités comprises', () => {
    let state = 12345;
    const next = (): number => {
      state = (Math.imul(state, 1103515245) + 12345) | 0;
      return state >>> 16;
    };
    for (let draw = 0; draw < 500; draw += 1) {
      // Des valeurs entières sur cinq niveaux : les égalités sont fréquentes, c'est voulu.
      const xs = CHARACTER_IDS.map(() => next() % 5);
      expect(rankVector(xs, CHARACTER_IDS)).toEqual(computeRanks(xs, CHARACTER_IDS));
    }
  });

  it('réutilise le tableau de sortie et refuse des longueurs différentes', () => {
    const out = new Array<number>(6).fill(0);
    const ranks = rankVector([1, 2, 3, 4, 5, 6], CHARACTER_IDS, out);
    expect(ranks).toBe(out);
    expect(ranks).toEqual([6, 5, 4, 3, 2, 1]);
    expect(() => rankVector([1, 2], CHARACTER_IDS)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------------------------
// Trajectoires et remontées
// ---------------------------------------------------------------------------------------------

/**
 * Historique **cohérent** des rangs d'un personnage : le personnage visé reçoit le rang demandé à
 * chaque pas, et les autres se partagent les rangs restants dans l'ordre du roster. Chaque pas est
 * donc une permutation des six rangs, comme dans une vraie course.
 */
function historyForSlot(ranksByStep: readonly number[], slot = 0): number[] {
  const characters = CHARACTER_IDS.length;
  const history = new Array<number>(ranksByStep.length * characters).fill(0);
  for (const [step, rank] of ranksByStep.entries()) {
    let nextRank = 1;
    for (let other = 0; other < characters; other += 1) {
      if (other === slot) {
        history[step * characters + other] = rank;
        continue;
      }
      if (nextRank === rank) {
        nextRank += 1;
      }
      history[step * characters + other] = nextRank;
      nextRank += 1;
    }
  }
  return history;
}

describe('trajectoire d’un personnage', () => {
  it('mesure le meilleur rang, le pire rang, la remontée et la victoire', () => {
    const history = historyForSlot([2, 2, 1]);
    const trajectory = characterTrajectory(history, 3, 0, CHARACTER_IDS.length);

    expect(trajectory.steps).toBe(3);
    expect(trajectory.bestRank).toBe(1);
    expect(trajectory.worstRank).toBe(2);
    expect(trajectory.maxGain).toBe(1);
    expect(trajectory.wasLast).toBe(false);
    expect(trajectory.bestRankAfterLastPlace).toBeNull();
    expect(trajectory.won).toBe(true);
  });

  it('mesure la remontée depuis le dernier rang, et le meilleur rang atteint après', () => {
    const history = historyForSlot([6, 6, 1]);
    const trajectory = characterTrajectory(history, 3, 0, CHARACTER_IDS.length);

    expect(trajectory.worstRank).toBe(6);
    expect(trajectory.bestRank).toBe(1);
    expect(trajectory.maxGain).toBe(5);
    expect(trajectory.wasLast).toBe(true);
    expect(trajectory.bestRankAfterLastPlace).toBe(1);
    expect(trajectory.won).toBe(true);
  });

  it('ne compte pas deux fois une place perdue puis reprise', () => {
    // 3e → 6e → 1er : la remontée vaut 5 places (6 → 1), pas 2 + 5.
    const trajectory = characterTrajectory(
      historyForSlot([3, 6, 1]),
      3,
      0,
      CHARACTER_IDS.length,
    );
    expect(trajectory.worstRank).toBe(6);
    expect(trajectory.bestRank).toBe(1);
    expect(trajectory.maxGain).toBe(5);
    expect(trajectory.bestRankAfterLastPlace).toBe(1);
  });

  it('ne confond pas deux personnages dans un historique entrelacé', () => {
    // Le slot 0 alterne 1er / 2e : les deux rangs sont atteints, mais il ne gagne jamais la course.
    const history = historyForSlot([1, 2, 1, 2]);
    const first = characterTrajectory(history, 4, 0, CHARACTER_IDS.length);
    const second = characterTrajectory(history, 4, 1, CHARACTER_IDS.length);

    expect(first.bestRank).toBe(1);
    expect(first.worstRank).toBe(2);
    expect(first.maxGain).toBe(1);
    expect(first.won).toBe(false);
    expect(second.bestRank).toBe(1);
    expect(second.worstRank).toBe(2);
    expect(second.won).toBe(true);
  });

  it('refuse un historique vide ou un slot hors bornes', () => {
    expect(() => characterTrajectory([], 0, 0, CHARACTER_IDS.length)).toThrow(RangeError);
    expect(() => characterTrajectory([1, 2], 1, 2, 2)).toThrow(RangeError);
  });
});

describe('drapeaux de remontée d’une course', () => {
  /** Trajectoire synthétique : seuls les champs utiles au drapeau sont renseignés. */
  function trajectory(options: {
    readonly won?: boolean;
    readonly wasLast?: boolean;
    readonly bestAfterLast?: number | null;
    readonly maxGain?: number;
  }): CharacterTrajectory {
    return {
      steps: RACE_CONFIG.TOTAL_STEPS,
      bestRank: options.bestAfterLast ?? 6,
      worstRank: options.wasLast === true ? 6 : 3,
      maxGain: options.maxGain ?? 0,
      wasLast: options.wasLast ?? false,
      bestRankAfterLastPlace: options.bestAfterLast ?? null,
      won: options.won ?? false,
    };
  }

  it('ne signale rien quand personne n’a été dernier', () => {
    const flags = raceComebackFlags([trajectory({ won: true }), trajectory({}), trajectory({})]);
    expect(flags.toTop3).toBe(false);
    expect(flags.toTop2).toBe(false);
    expect(flags.toFirst).toBe(false);
    expect(flags.toTop3WithoutWin).toBe(false);
    expect(flags.maxGainPlaces).toBe(0);
  });

  it('distingue la remontée vers le top 3, le top 2, la victoire, et le top 3 sans gagner', () => {
    const toTop3 = raceComebackFlags([
      trajectory({ won: true }),
      trajectory({ wasLast: true, bestAfterLast: 3, maxGain: 3 }),
    ]);
    expect(toTop3.toTop3).toBe(true);
    expect(toTop3.toTop2).toBe(false);
    expect(toTop3.toFirst).toBe(false);
    expect(toTop3.toTop3WithoutWin).toBe(true);
    expect(toTop3.maxGainPlaces).toBe(3);

    const toTop2 = raceComebackFlags([
      trajectory({ won: true }),
      trajectory({ wasLast: true, bestAfterLast: 2, maxGain: 4 }),
    ]);
    expect(toTop2.toTop2).toBe(true);
    expect(toTop2.toFirst).toBe(false);
    expect(toTop2.toTop3WithoutWin).toBe(true);

    const toFirst = raceComebackFlags([
      trajectory({ wasLast: true, bestAfterLast: 1, maxGain: 5, won: true }),
    ]);
    expect(toFirst.toFirst).toBe(true);
    expect(toFirst.toTop3WithoutWin).toBe(false);
    expect(toFirst.maxGainPlaces).toBe(5);
  });

  it('ne retient que la plus grande remontée de la course', () => {
    const flags = raceComebackFlags([
      trajectory({ wasLast: true, bestAfterLast: 2, maxGain: 4 }),
      trajectory({ wasLast: true, bestAfterLast: 1, maxGain: 5, won: true }),
    ]);
    expect(flags.maxGainPlaces).toBe(5);
  });

  it('refuse une course sans trajectoire', () => {
    expect(() => raceComebackFlags([])).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------------------------
// Statistiques
// ---------------------------------------------------------------------------------------------

describe('quantiles et écarts', () => {
  it('interpole les quantiles demandés', () => {
    const values = Array.from({ length: 11 }, (_value, index) => index);
    expect(quantile(values, 0)).toBe(0);
    expect(quantile(values, 1)).toBe(10);
    expect(quantile(values, 0.5)).toBe(5);
    expect(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.1)).toBeCloseTo(1.9, 10);
    expect(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBeCloseTo(9.1, 10);
  });

  it('refuse une série vide ou un quantile hors bornes', () => {
    expect(() => quantile([], 0.5)).toThrow(RangeError);
    expect(() => quantile([1, 2, 3], 1.5)).toThrow(RangeError);
    expect(() => quantile([1, 2, 3], -0.1)).toThrow(RangeError);
  });

  it('résume une série d’écarts en min, p10, médiane, p90, max et moyenne', () => {
    const summary = gapSummary([10, 1, 5, 3, 8, 2, 4, 6, 7, 9]);
    expect(summary.count).toBe(10);
    expect(summary.min).toBe(1);
    expect(summary.max).toBe(10);
    expect(summary.median).toBeCloseTo(5.5, 10);
    expect(summary.mean).toBeCloseTo(5.5, 10);
    expect(summary.p10).toBeCloseTo(1.9, 10);
    expect(summary.p90).toBeCloseTo(9.1, 10);
    expect(() => gapSummary([])).toThrow(RangeError);
  });
});

describe('test d’homogénéité', () => {
  it('ne trouve rien à redire à six comptes égaux', () => {
    const test = homogeneityTest([500, 500, 500, 500, 500, 500], 1_000);
    expect(test.total).toBe(3_000);
    expect(test.chiSquare).toBeCloseTo(0, 10);
    expect(test.uniform).toBe(true);
    expect(test.degreesOfFreedom).toBe(5);
    expect(test.criticalChiSquare05).toBeCloseTo(11.07, 6);
    for (const share of test.shares) {
      expect(share).toBeCloseTo(50, 10);
    }
  });

  it('signale des comptes trop inégaux et nomme le personnage le plus déviant', () => {
    const test = homogeneityTest([900, 500, 500, 500, 500, 500], 1_000);
    expect(test.chiSquare).toBeGreaterThan(test.criticalChiSquare05);
    expect(test.uniform).toBe(false);
    expect(test.maxAbsZCharacter).toBe(CHARACTER_IDS[0]);
  });

  it('refuse une base nulle plutôt que de diviser par zéro', () => {
    expect(() => homogeneityTest([0, 0, 0, 0, 0, 0], 0)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------------------------
// Course réelle
// ---------------------------------------------------------------------------------------------

describe('course auditée', () => {
  it('relève tout le suspense d’une course réelle à six coureurs', () => {
    const race = auditSuspenseRace('KR7Z8NAR');

    expect(race.players).toBe(SUSPENSE_PLAYERS);
    expect(race.steps).toBe(RACE_CONFIG.TOTAL_STEPS);
    expect(race.tSim).toBe(RACE_CONFIG.TOTAL_SIM_S);
    expect(race.exactSteps).toBe(true);
    expect(race.fieldSizeOk).toBe(true);
    expect(race.rankVerified).toBe(true);
    expect(race.leadersAtBounds).toHaveLength(LEADER_BOUNDS_S.length);
    for (const leader of race.leadersAtBounds) {
      expect(CHARACTER_IDS).toContain(leader);
    }
    expect(race.leadersAtBounds[race.leadersAtBounds.length - 1]).toBe(race.winner);
    expect(race.gapAtBoundsM).toHaveLength(LEADER_BOUNDS_S.length);
    expect(race.gapAtMarksM).toHaveLength(FINAL_MARKS_S.length);
    expect(race.trajectories).toHaveLength(SUSPENSE_PLAYERS);
    expect(race.trajectories.filter((trajectory) => trajectory.won)).toHaveLength(1);
    expect(race.closeAtWindowStart).toHaveLength(GAP_THRESHOLDS_M.length);
    expect(race.closeThroughoutWindow).toHaveLength(GAP_THRESHOLDS_M.length);
    expect(race.photoAtFinish).toHaveLength(GAP_THRESHOLDS_M.length);
    expect(race.significantLeadLost).toHaveLength(GAP_THRESHOLDS_M.length);
    for (const gap of [...race.gapAtBoundsM, ...race.gapAtMarksM]) {
      expect(Number.isFinite(gap)).toBe(true);
      expect(gap).toBeGreaterThanOrEqual(0);
    }
    expect(race.minGapFinalWindowM).toBeLessThanOrEqual(race.maxGapFinalWindowM);
    expect(race.lastLeaderChangeS).toBeGreaterThanOrEqual(0);
    expect(race.lastLeaderChangeS).toBeLessThanOrEqual(RACE_CONFIG.TOTAL_SIM_S);
    // Le drapeau de course est bien le maximum des six trajectoires.
    expect(race.comeback.maxGainPlaces).toBe(
      Math.max(...race.trajectories.map((trajectory) => trajectory.maxGain)),
    );
  });

  it('donne exactement le même résultat quand la course est rejouée', () => {
    expect(auditSuspenseRace('KR7Z8NAR')).toEqual(auditSuspenseRace('KR7Z8NAR'));
  });

  it('mesure un écart P1–P2 qui s’ouvre entre 20 s et l’arrivée', () => {
    // La distance parcourue est une marche aléatoire : l'écart entre deux coureurs se diffuse donc
    // avec le temps. Le mesurer sur un petit corpus suffit — l'effet est largement supérieur au bruit.
    const races = corpusSeeds(8).map((seed) => auditSuspenseRace(seed));
    const at20 = races.reduce((sum, race) => sum + (race.gapAtBoundsM[0] ?? 0), 0) / races.length;
    const at60 = races.reduce((sum, race) => sum + (race.gapAtBoundsM[2] ?? 0), 0) / races.length;
    expect(at60).toBeGreaterThan(at20);
    for (const race of races) {
      expect(race.rankVerified).toBe(true);
      expect(race.fieldSizeOk).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Synthèse
// ---------------------------------------------------------------------------------------------

/** Trajectoire synthétique complète, pour construire un corpus à la main. */
function syntheticTrajectory(options: {
  readonly bestRank: number;
  readonly worstRank: number;
  readonly won?: boolean;
  readonly wasLast?: boolean;
  readonly bestAfterLast?: number | null;
  readonly maxGain?: number;
}): CharacterTrajectory {
  return {
    steps: RACE_CONFIG.TOTAL_STEPS,
    bestRank: options.bestRank,
    worstRank: options.worstRank,
    maxGain: options.maxGain ?? 0,
    wasLast: options.wasLast ?? false,
    bestRankAfterLastPlace: options.bestAfterLast ?? null,
    won: options.won ?? false,
  };
}

/**
 * Course synthétique : c0 mène de bout en bout, les autres restent derrière, l'écart P1–P2 vaut
 * `6 m` partout et personne ne remonte. Chaque champ peut être remplacé ; les drapeaux de remontée
 * et de proximité sont **toujours** recalculés à partir des écarts finaux, comme le fait l'audit
 * réel — un corpus synthétique incohérent ne testerait rien.
 */
function syntheticRace(overrides: Partial<SuspenseRaceAudit> = {}): SuspenseRaceAudit {
  const trajectories: CharacterTrajectory[] = CHARACTER_IDS.map((_id, index) =>
    syntheticTrajectory({
      bestRank: index + 1,
      worstRank: index + 1,
      won: index === 0,
      wasLast: index === CHARACTER_IDS.length - 1,
      bestAfterLast: index === CHARACTER_IDS.length - 1 ? CHARACTER_IDS.length : null,
    }),
  );
  const gap = 6;
  const base: SuspenseRaceAudit = {
    seed: 'seed-synthetique',
    players: SUSPENSE_PLAYERS,
    steps: RACE_CONFIG.TOTAL_STEPS,
    tSim: RACE_CONFIG.TOTAL_SIM_S,
    leadersAtBounds: ['c0', 'c0', 'c0'],
    winner: 'c0',
    leaderChanges: 0,
    lastLeaderChangeS: 0,
    gapAtBoundsM: [gap, gap, gap],
    gapAtMarksM: [gap, gap],
    maxGapFinalWindowM: gap,
    minGapFinalWindowM: gap,
    closeAtWindowStart: GAP_THRESHOLDS_M.map(() => true),
    closeThroughoutWindow: GAP_THRESHOLDS_M.map(() => true),
    photoAtFinish: GAP_THRESHOLDS_M.map(() => true),
    significantLeadLost: GAP_THRESHOLDS_M.map(() => false),
    maxLeadWhileLeadingM: gap,
    comeback: raceComebackFlags(trajectories),
    trajectories,
    rankVerified: true,
    fieldSizeOk: true,
    exactSteps: true,
  };
  const race: SuspenseRaceAudit = { ...base, ...overrides };
  const flagsFor = (value: number): readonly boolean[] =>
    GAP_THRESHOLDS_M.map((threshold) => value <= threshold);
  const windowStartGap = race.gapAtMarksM[0] ?? gap;
  const finishGap = race.gapAtBoundsM[race.gapAtBoundsM.length - 1] ?? gap;

  return {
    ...race,
    closeAtWindowStart: overrides.closeAtWindowStart ?? flagsFor(windowStartGap),
    closeThroughoutWindow: overrides.closeThroughoutWindow ?? flagsFor(race.maxGapFinalWindowM),
    photoAtFinish: overrides.photoAtFinish ?? flagsFor(finishGap),
    comeback: raceComebackFlags(race.trajectories),
  };
}

/**
 * Trajectoires d'une course où un **outsider** a été dernier avant d'aller chercher la deuxième
 * place : c'est le cas « 6e → top 2 sans gagner » que l'audit doit compter.
 */
function outsiderTrajectories(): readonly CharacterTrajectory[] {
  return [
    syntheticTrajectory({ bestRank: 1, worstRank: 2, won: true }),
    syntheticTrajectory({
      bestRank: 2,
      worstRank: 6,
      wasLast: true,
      bestAfterLast: 2,
      maxGain: 4,
    }),
    ...CHARACTER_IDS.slice(2).map(() => syntheticTrajectory({ bestRank: 4, worstRank: 5 })),
  ];
}

describe('synthèse d’un corpus', () => {
  it('refuse un corpus vide', () => {
    expect(() => summarizeSuspenseAudit([])).toThrow(RangeError);
  });

  it('refuse un corpus qui ne serait pas à six coureurs', () => {
    expect(() => summarizeSuspenseAudit([syntheticRace({ players: 5 })])).toThrow(RangeError);
  });

  it('mesure une persistance totale sur un corpus où le même leader mène partout', () => {
    const races = [0, 1, 2].map((index) => syntheticRace({ seed: `seed-${String(index)}` }));
    const summary = summarizeSuspenseAudit(races);

    expect(summary.players).toBe(SUSPENSE_PLAYERS);
    expect(summary.seeds).toBe(3);
    expect(summary.persistence.sameLeaderAllBoundsPercent).toBe(100);
    expect(summary.persistence.exactlyTwoLeadersPercent).toBe(0);
    expect(summary.persistence.threeDistinctLeadersPercent).toBe(0);
    expect(summary.persistence.leader20EqualsLeader40Percent).toBe(100);
    expect(summary.persistence.leader20EqualsWinnerPercent).toBe(100);
    expect(summary.leaderChanges.mean).toBe(0);
    expect(summary.lastChange.withinWindowPercent).toEqual([0, 0, 0]);
    expect(summary.distinctLeaders.mean).toBe(1);
    expect(summary.distinctLeaders.histogram[0]).toBe(3);
    expect(summary.winnerShares.counts[0]).toBe(3);
    expect(summary.everLedShares.counts[0]).toBe(3);
    expect(summary.everLedShares.uniform).toBe(false);
  });

  it('compte les changements de leader et le moment du dernier', () => {
    const races = [
      syntheticRace({ seed: 'a', leaderChanges: 2, lastLeaderChangeS: 30 }),
      syntheticRace({ seed: 'b', leaderChanges: 4, lastLeaderChangeS: 55 }),
    ];
    const summary = summarizeSuspenseAudit(races);

    expect(summary.leaderChanges.mean).toBe(3);
    expect(summary.leaderChanges.min).toBe(2);
    expect(summary.leaderChanges.max).toBe(4);
    expect(summary.leaderChanges.median).toBe(3);
    // 30 s est hors des trois fenêtres ; 55 s est dans les 20, 10 et 5 dernières secondes.
    expect(summary.lastChange.withinWindowPercent).toEqual([50, 50, 50]);
    expect(summary.finalSuspense.leaderChangeInWindowPercent).toBe(50);
  });

  it('agrège les drapeaux de remontée en pourcentages', () => {
    const races = [
      syntheticRace({ seed: 'comeback', trajectories: outsiderTrajectories() }),
      syntheticRace({ seed: 'plat' }),
    ];
    const summary = summarizeSuspenseAudit(races);

    expect(summary.comebacks.toTop2Percent).toBe(50);
    expect(summary.comebacks.toFirstPercent).toBe(0);
    expect(summary.comebacks.toTop3WithoutWinPercent).toBe(50);
    expect(summary.comebacks.maxGainPlacesMean).toBe(2);
    expect(summary.comebacks.maxGainPlacesMedian).toBe(2);
  });

  it('agrège les écarts et les seuils de proximité en mètres', () => {
    const races = [
      syntheticRace({
        seed: 'a',
        gapAtBoundsM: [2, 4, 6],
        gapAtMarksM: [5, 7],
        maxGapFinalWindowM: 9,
        minGapFinalWindowM: 1,
      }),
      syntheticRace({
        seed: 'b',
        gapAtBoundsM: [20, 30, 40],
        gapAtMarksM: [25, 35],
        maxGapFinalWindowM: 40,
        minGapFinalWindowM: 20,
      }),
    ];
    const summary = summarizeSuspenseAudit(races);

    expect(summary.finalSuspense.gapAtBounds[0]?.median).toBe(11);
    expect(summary.finalSuspense.gapAtBounds[2]?.min).toBe(6);
    expect(summary.finalSuspense.gapAtBounds[2]?.max).toBe(40);
    expect(summary.finalSuspense.gapAtMarks[0]?.median).toBe(15);
    // Le premier reste sous 10 m à l'arrivée, le second non : les seuils trient le corpus.
    const under10 = GAP_THRESHOLDS_M.indexOf(10);
    expect(under10).toBeGreaterThanOrEqual(0);
    expect(summary.finalSuspense.photoAtFinishPercent[under10]).toBe(50);
  });

  it('mesure le pire rang du vainqueur pour les renversements', () => {
    const races = [
      syntheticRace({
        seed: 'outsider',
        trajectories: [
          syntheticTrajectory({
            bestRank: 1,
            worstRank: 6,
            won: true,
            wasLast: true,
            bestAfterLast: 1,
            maxGain: 5,
          }),
          ...CHARACTER_IDS.slice(1).map(() =>
            syntheticTrajectory({ bestRank: 2, worstRank: 5 }),
          ),
        ],
      }),
      syntheticRace({ seed: 'solide' }),
    ];
    const summary = summarizeSuspenseAudit(races);

    expect(summary.upsets.winnerLastPercent).toBe(50);
    expect(summary.upsets.winnerOutsideTop4Percent).toBe(50);
    expect(summary.upsets.winnerOutsideTop3Percent).toBe(50);
    expect(summary.comebacks.toFirstPercent).toBe(50);
    expect(summary.upsets.leader20LosesPercent).toBe(0);
  });

  it('résume les remontées par personnage', () => {
    const summary = summarizeSuspenseAudit([syntheticRace()]);
    const last = summary.comebacks.perCharacter[CHARACTER_IDS.length - 1];

    expect(summary.comebacks.perCharacter).toHaveLength(SUSPENSE_PLAYERS);
    expect(last?.id).toBe(CHARACTER_IDS[CHARACTER_IDS.length - 1]);
    expect(last?.wasLastRaces).toBe(1);
    expect(last?.meanBestRankAfterLastPlace).toBe(CHARACTER_IDS.length);
    expect(last?.everLedPercent).toBe(0);
    expect(last?.everLastPercent).toBe(100);
    for (const character of summary.comebacks.perCharacter) {
      expect(character.meanBestRank).toBeGreaterThanOrEqual(1);
      expect(character.meanWorstRank).toBeLessThanOrEqual(SUSPENSE_PLAYERS);
      expect(character.meanMaxGain).toBeGreaterThanOrEqual(0);
    }
  });

  it('refuse de comparer aux références un corpus qui n’est pas celui des références', () => {
    const summary = summarizeSuspenseAudit([syntheticRace()]);
    expect(summary.references.length).toBeGreaterThan(0);
    for (const check of summary.references) {
      expect(check.comparable).toBe(false);
      expect(check.reproduced).toBe(false);
    }
  });

  it('met en avant cinq métriques de suspense, toutes mesurées', () => {
    const summary = summarizeSuspenseAudit([syntheticRace()]);
    expect(summary.spotlight).toHaveLength(5);
    const ids = summary.spotlight.map((metric) => metric.id);
    expect(ids).toEqual([
      'leader-20-wins',
      'same-leader-all-bounds',
      'last-change-within-10s',
      'last-to-top3',
      'close-race-throughout-final-window',
    ]);
    for (const metric of summary.spotlight) {
      expect(metric.value.length).toBeGreaterThan(0);
      expect(metric.label.length).toBeGreaterThan(0);
    }
  });

  it('vérifie les contrôles structurels du corpus', () => {
    const summary = summarizeSuspenseAudit([syntheticRace()]);
    expect(summary.corpus).toEqual({
      seeds: 1,
      distinctSeeds: 1,
      players: SUSPENSE_PLAYERS,
      exactSteps: true,
      finishedAtTotalSimS: true,
      rankVerifiedEverywhere: true,
      fieldSizeEverywhere: true,
    });
  });
});

describe('références de l’audit précédent', () => {
  it('recopie les mesures publiées sans les transformer en seuils', () => {
    expect(SUSPENSE_REFERENCES.sameLeaderAllBoundsPercent).toBeCloseTo(34.04, 6);
    expect(SUSPENSE_REFERENCES.leader40EqualsWinnerPercent).toBeCloseTo(62.23, 6);
    expect(SUSPENSE_REFERENCES.leader20EqualsWinnerPercent).toBeCloseTo(41.53, 6);
    expect(SUSPENSE_REFERENCES.leader20EqualsLeader40Percent).toBeCloseTo(51.61, 6);
    expect(SUSPENSE_REFERENCES.exactlyTwoLeadersPercent).toBeCloseTo(53.25, 6);
    expect(SUSPENSE_REFERENCES.threeDistinctLeadersPercent).toBeCloseTo(12.71, 6);
    // 8,193 est la moyenne du corpus de 10 000 seeds ; 8,308 (§13) est celle du sous-corpus de 1000.
    expect(SUSPENSE_REFERENCES.leaderChangesMean).toBeCloseTo(8.193, 6);
    expect(SUSPENSE_REFERENCES.leaderChangesMean).not.toBeCloseTo(8.308, 3);
    // Les trois catégories de persistance couvrent tout le corpus.
    expect(
      SUSPENSE_REFERENCES.sameLeaderAllBoundsPercent +
        SUSPENSE_REFERENCES.exactlyTwoLeadersPercent +
        SUSPENSE_REFERENCES.threeDistinctLeadersPercent,
    ).toBeCloseTo(100, 6);
  });

  it('ne conclut à une reproduction que sur le corpus des références', () => {
    const persistence: LeaderPersistence = {
      sameLeaderAllBounds: 3_404,
      sameLeaderAllBoundsPercent: 34.04,
      exactlyTwoLeaders: 5_325,
      exactlyTwoLeadersPercent: 53.25,
      threeDistinctLeaders: 1_271,
      threeDistinctLeadersPercent: 12.71,
      leader20EqualsLeader40: 5_161,
      leader20EqualsLeader40Percent: 51.61,
      leader40EqualsWinner: 6_223,
      leader40EqualsWinnerPercent: 62.23,
      leader20EqualsWinner: 4_153,
      leader20EqualsWinnerPercent: 41.53,
    };
    const full = referenceChecks(persistence, SUSPENSE_REFERENCES.leaderChangesMean, SUSPENSE_REFERENCES.seeds);
    expect(full.every((check) => check.comparable && check.reproduced)).toBe(true);
    expect(full.map((check) => check.measured)).toContain('34,04 %');
    expect(full.map((check) => check.measured)).toContain('8,193');
    expect(full).toHaveLength(7);

    const partial = referenceChecks(persistence, SUSPENSE_REFERENCES.leaderChangesMean, 500);
    expect(partial.every((check) => !check.comparable && !check.reproduced)).toBe(true);

    // Un instrument décalé (moyenne de changements différente) doit être signalé.
    const shifted = referenceChecks(persistence, 8.4, SUSPENSE_REFERENCES.seeds);
    expect(shifted.find((check) => check.id === 'leader-changes-mean')?.reproduced).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Rapports et conclusion
// ---------------------------------------------------------------------------------------------

describe('rapports', () => {
  it('rend un rapport texte complet, en français et avec les bornes du noyau', () => {
    const summary = summarizeSuspenseAudit([syntheticRace()]);
    const text = renderSuspenseAuditText(summary, 1_234);

    expect(text).toContain('audit de suspense');
    expect(text).toContain('6 coureurs');
    expect(text).toContain('Leader aux bornes');
    expect(text).toContain('Changements de leader');
    expect(text).toContain('Remontées');
    expect(text).toContain('Renversements');
    expect(text).toContain('Suspense final');
    expect(text).toContain('cinq métriques');
    for (const label of LEADER_BOUND_LABELS) {
      expect(text).toContain(label);
    }
    // Les nombres sont écrits à la française : virgule décimale.
    expect(text).toMatch(/\d,\d\d/);
  });

  it('rend un rapport structuré à clés ASCII', () => {
    const summary = summarizeSuspenseAudit([syntheticRace()]);
    const report = JSON.stringify(buildSuspenseAuditJson(summary, 10));

    expect(report).toContain('chaos-race-suspense-audit');
    expect(report).toContain('"players":6');
    expect(report).toContain('spotlight');
    expect(report).toContain(DEFAULT_AUDIT_CORPUS);
    expect(report).not.toContain('undefined');
  });

  it('ne signale une anomalie que sur une anomalie structurelle', () => {
    const clean = summarizeSuspenseAudit([syntheticRace()], {
      reproducibility: { seeds: 100, identical: 100 },
    });
    expect(conclusionLines(clean)[0] ?? '').toContain('Aucune anomalie structurelle');

    const brokenRank = summarizeSuspenseAudit([syntheticRace({ rankVerified: false })]);
    expect(conclusionLines(brokenRank)[0] ?? '').toContain('Anomalies structurelles');
    expect(conclusionLines(brokenRank).join('\n')).toContain('computeRanks');

    const brokenField = summarizeSuspenseAudit([syntheticRace({ fieldSizeOk: false })]);
    expect(conclusionLines(brokenField).join('\n')).toContain('six partants');

    const brokenSteps = summarizeSuspenseAudit([syntheticRace({ exactSteps: false })]);
    expect(conclusionLines(brokenSteps).join('\n')).toContain('pas');

    const brokenRepro = summarizeSuspenseAudit([syntheticRace()], {
      reproducibility: { seeds: 100, identical: 99 },
    });
    expect(conclusionLines(brokenRepro).join('\n')).toContain('reproductibilité');
  });

  it('ne présente pas une mesure de suspense comme un bug', () => {
    // Un corpus où le leader de 20 s gagne toujours n'est pas une anomalie structurelle : c'est une
    // propriété du jeu, et elle se rapporte.
    const summary = summarizeSuspenseAudit([syntheticRace()]);
    expect(summary.persistence.leader20EqualsWinnerPercent).toBe(100);
    expect(conclusionLines(summary)[0] ?? '').toContain('Aucune anomalie structurelle');
  });
});

// ---------------------------------------------------------------------------------------------
// Ligne de commande
// ---------------------------------------------------------------------------------------------

describe('ligne de commande', () => {
  it('applique les valeurs par défaut', () => {
    const options = parseSuspenseAuditArgs([]);
    expect(options).not.toBe('help');
    if (options === 'help') {
      throw new Error('aide inattendue');
    }
    expect(options.seeds).toBe(DEFAULT_SUSPENSE_SEEDS);
    expect(options.corpusPrefix).toBe(DEFAULT_AUDIT_CORPUS);
    expect(options.replayCheck).toBe(true);
    expect(options.jsonPath).toContain('.tmp/');
    expect(options.textPath).toContain('.tmp/');
  });

  it('lit les options explicites', () => {
    const options = parseSuspenseAuditArgs([
      '--seeds=250',
      '--reproducibility-seeds=10',
      '--corpus=autre',
      '--json=x.json',
      '--text=x.txt',
      '--no-replay-check',
    ]);
    expect(options).not.toBe('help');
    if (options === 'help') {
      throw new Error('aide inattendue');
    }
    expect(options.seeds).toBe(250);
    expect(options.reproducibilitySeeds).toBe(10);
    expect(options.corpusPrefix).toBe('autre');
    expect(options.jsonPath).toBe('x.json');
    expect(options.textPath).toBe('x.txt');
    expect(options.replayCheck).toBe(false);
  });

  it('refuse une entrée invalide et répond à --help', () => {
    expect(() => parseSuspenseAuditArgs(['--seeds=0'])).toThrow(RangeError);
    expect(() => parseSuspenseAuditArgs(['--seeds=abc'])).toThrow(RangeError);
    expect(() => parseSuspenseAuditArgs(['--reproducibility-seeds=0'])).toThrow(RangeError);
    expect(() => parseSuspenseAuditArgs(['--inconnu'])).toThrow(RangeError);
    expect(parseSuspenseAuditArgs(['--help'])).toBe('help');
  });
});