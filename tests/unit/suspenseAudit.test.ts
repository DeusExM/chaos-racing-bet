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
 *    comparaison aux références n'est concluante que sur le corpus de 10 000 seeds ;
 * 8. les métriques « **visibles** » de la passe exploratoire — un changement de tête qui tient une
 *    seconde, un dernier rang tenu deux secondes — sont justes sur des historiques construits à la
 *    main, et leur compte brut **concorde** avec le compteur pas-à-pas d'une course réelle.
 *
 * Aucune assertion ne porte sur une part mesurée à petit N : ces valeurs-là appartiennent au rapport
 * du corpus complet, pas à un test qui deviendrait instable (`AGENTS.md` §2).
 */

import { describe, expect, it } from 'vitest';

import { CHARACTER_IDS } from '../../src/core/characters';
import { FACT, GAME_CONFIG, RACE_CONFIG } from '../../src/core/config';
import { RaceEngine } from '../../src/core/engine';
import { selectParticipants } from '../../src/core/participants';
import { computeRanks } from '../../src/core/ranking';
import { forkStream } from '../../src/core/rng';
import { normalizeSeed } from '../../src/core/seed';
import { lateFormFactor } from '../../src/core/speedModel';
import { intervalStepRange, intervalStepRangeForMean } from '../../src/core/surges';
import { corpusSeeds } from '../../tools/balanceStats';
import {
  COMEBACK_RANKS,
  DEFAULT_AUDIT_CORPUS,
  DEFAULT_SUSPENSE_SEEDS,
  DEFAULT_VISIBLE_SUSPENSE_THRESHOLDS,
  DRIFT_NOISE_SWEEP_FACTORS,
  DRIFT_NOISE_SWEEP_FROM_S,
  FINAL_MARKS_S,
  FINAL_WINDOW_S,
  GAP_THRESHOLDS_M,
  LAST_CHANGE_WINDOWS_S,
  LAST_STREAK_S,
  LEADER_BOUNDS_S,
  LEADER_BOUND_LABELS,
  SUSPENSE_PLAYERS,
  SUSPENSE_REFERENCES,
  SURGE_INTERVAL_BASELINE_MEAN_S,
  SURGE_INTERVAL_CANDIDATE_MEAN_S,
  SURGE_INTERVAL_FROM_S,
  TIGHT_FINISH_GAP_M,
  LATE_FORM_AMPLITUDE,
  LATE_FORM_FROM_S,
  LATE_FORM_FULL_S,
  LATE_FORM_STREAM_PREFIX,
  VISIBLE_LEADER_CHANGE_S,
  auditSuspenseRace,
  buildLateFormComparisonJson,
  buildNoiseSweepJson,
  buildSurgeIntervalComparisonJson,
  buildSuspenseAuditJson,
  characterTrajectory,
  conclusionLines,
  firstDivergentStep,
  gapSummary,
  homogeneityTest,
  lateFormStats,
  lateFormValues,
  noiseScaleAfter,
  noiseSweepMetrics,
  parseSuspenseAuditArgs,
  quantile,
  raceComebackFlags,
  rankVector,
  referenceChecks,
  renderLateFormComparisonText,
  renderNoiseSweepText,
  renderSurgeIntervalComparisonText,
  renderSuspenseAuditText,
  runLateFormComparison,
  runNoiseSweep,
  runSurgeIntervalComparison,
  stepsForSeconds,
  summarizeSuspenseAudit,
  visibleSuspense,
  visibleSuspenseThresholdsFor,
  type CharacterTrajectory,
  type LeaderPersistence,
  type SuspenseRaceAudit,
  type VisibleLeaderChangeMetrics,
  type VisibleSuspense,
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
// Métriques « visibles » (passe exploratoire)
// ---------------------------------------------------------------------------------------------

/**
 * Historique **explicite** : une permutation complète par pas, donnée slot par slot.
 *
 * `historyForSlot` ne pilote qu'un personnage à la fois ; les métriques « visibles » doivent
 * contrôler simultanément qui mène (rang 1) et qui est dernier (rang 6), d'où ce constructeur — qui
 * vérifie au passage que chaque pas est bien une permutation des six rangs.
 */
function historyFromRanks(ranksByStep: readonly (readonly number[])[]): number[] {
  const characters = CHARACTER_IDS.length;
  const expected = Array.from({ length: characters }, (_unused, index) => index + 1);
  const history: number[] = [];
  for (const ranks of ranksByStep) {
    expect([...ranks].sort((left, right) => left - right)).toEqual(expected);
    history.push(...ranks);
  }
  return history;
}

/** Permutation de référence : c0 mène, c5 est dernier. */
const IDENTITY_RANKS: readonly number[] = [1, 2, 3, 4, 5, 6];
/** c1 prend la tête, c0 recule d'un rang. */
const SECOND_LEADS_RANKS: readonly number[] = [2, 1, 3, 4, 5, 6];

describe('métriques « visibles » : seuils', () => {
  it('convertit les durées en pas sans division flottante', () => {
    expect(stepsForSeconds(1)).toBe(60);
    expect(stepsForSeconds(2)).toBe(120);
    expect(stepsForSeconds(60)).toBe(RACE_CONFIG.TOTAL_STEPS);
  });

  it('dérive ses seuils du jeu : 1 s de tête, 2 s au dernier rang, relevés à 40 s et 50 s', () => {
    expect(VISIBLE_LEADER_CHANGE_S).toBe(1);
    expect(LAST_STREAK_S).toBe(2);
    expect(DEFAULT_VISIBLE_SUSPENSE_THRESHOLDS.visibleLeaderChangeSteps).toBe(60);
    expect(DEFAULT_VISIBLE_SUSPENSE_THRESHOLDS.lastStreakSteps).toBe(120);
    // L'index 0-based du premier pas à 40 s (tSim = (index + 1) × DT) vaut 2400 − 1.
    expect(DEFAULT_VISIBLE_SUSPENSE_THRESHOLDS.boundStep).toBe(stepsForSeconds(40) - 1);
    expect(DEFAULT_VISIBLE_SUSPENSE_THRESHOLDS.finalWindowStartStep).toBe(
      stepsForSeconds(RACE_CONFIG.TOTAL_SIM_S - FINAL_WINDOW_S) - 1,
    );
  });

  it('refuse un historique incohérent ou un relevé hors course', () => {
    const history = historyFromRanks([IDENTITY_RANKS, IDENTITY_RANKS]);
    const thresholds = visibleSuspenseThresholdsFor(2);
    expect(() => visibleSuspense(history, 0, 6, thresholds)).toThrow(RangeError);
    expect(() => visibleSuspense(history, 2, 1, thresholds)).toThrow(RangeError);
    expect(() =>
      visibleSuspense(history, 2, 6, { ...thresholds, boundStep: 2 }),
    ).toThrow(RangeError);
    expect(() =>
      visibleSuspense(history, 2, 6, { ...thresholds, finalWindowStartStep: -1 }),
    ).toThrow(RangeError);
    // Aucun rang 1 au premier pas : l'historique ne décrit pas une course.
    const headless = new Array<number>(2 * CHARACTER_IDS.length).fill(0);
    expect(() => visibleSuspense(headless, 2, 6, thresholds)).toThrow(RangeError);
  });
});

describe('métriques « visibles » : changements de leader', () => {
  const thresholds = {
    visibleLeaderChangeSteps: 3,
    lastStreakSteps: 4,
    boundStep: 4,
    finalWindowStartStep: 8,
  };

  it('ne compte aucun changement quand la tête ne bouge pas', () => {
    const history = historyFromRanks(Array.from({ length: 12 }, () => IDENTITY_RANKS));
    const visible = visibleSuspense(history, 12, 6, thresholds);

    expect(visible.changes.rawChanges).toBe(0);
    expect(visible.changes.visibleChanges).toBe(0);
    expect(visible.changes.microChanges).toBe(0);
    expect(visible.changes.lastVisibleChangeStep).toBe(-1);
    expect(visible.changes.visibleInFinalWindow).toBe(false);
  });

  it('retient un changement dont le nouveau leader tient 1 s pleine', () => {
    // La tête change au pas 3 et ne bouge plus : le règne fait 9 pas, donc ≥ 3.
    const history = historyFromRanks([
      IDENTITY_RANKS,
      IDENTITY_RANKS,
      IDENTITY_RANKS,
      ...Array.from({ length: 9 }, () => SECOND_LEADS_RANKS),
    ]);
    const visible = visibleSuspense(history, 12, 6, thresholds);

    expect(visible.changes.rawChanges).toBe(1);
    expect(visible.changes.visibleChanges).toBe(1);
    expect(visible.changes.microChanges).toBe(0);
    expect(visible.changes.lastVisibleChangeStep).toBe(3);
    expect(visible.changes.visibleInFinalWindow).toBe(false);
  });

  it('classe en micro-changement un aller-retour plus court que la seconde', () => {
    // La course s'arrête deux pas après la reprise de tête : le nouveau leader n'a pas été vu 1 s.
    const history = historyFromRanks([
      IDENTITY_RANKS,
      IDENTITY_RANKS,
      IDENTITY_RANKS,
      SECOND_LEADS_RANKS,
      SECOND_LEADS_RANKS,
    ]);
    const visible = visibleSuspense(history, 5, 6, {
      ...thresholds,
      boundStep: 2,
      finalWindowStartStep: 3,
    });

    expect(visible.changes.rawChanges).toBe(1);
    expect(visible.changes.visibleChanges).toBe(0);
    expect(visible.changes.microChanges).toBe(1);
    expect(visible.changes.visibleInFinalWindow).toBe(false);
  });

  it('compte le premier pas par rapport au leader initial, pas par rapport au vide', () => {
    // À t = 0 les six coureurs sont à la même distance : l'égalité de départ est départagée par
    // l'index, donc c0 est leader. c1 passe devant au premier pas, puis c0 reprend la tête : ce sont
    // bien deux changements, même si l'historique seul ne montre qu'un aller-retour entre deux pas.
    const history = historyFromRanks([
      SECOND_LEADS_RANKS,
      ...Array.from({ length: 11 }, () => IDENTITY_RANKS),
    ]);
    const withoutInitial = visibleSuspense(history, 12, 6, thresholds);
    expect(withoutInitial.changes.rawChanges).toBe(1);

    const withInitial = visibleSuspense(history, 12, 6, thresholds, 0);
    expect(withInitial.changes.rawChanges).toBe(2);
    // Le règne initial ne dure qu'une observation : il n'est pas un changement, et le suivant ne
    // tient qu'un pas — seul le règne final dépasse le seuil de trois pas.
    expect(withInitial.changes.visibleChanges).toBe(1);
    expect(withInitial.changes.microChanges).toBe(1);
  });

  it('repère un changement visible dans la fenêtre finale seulement', () => {
    const history = historyFromRanks([
      ...Array.from({ length: 9 }, () => IDENTITY_RANKS),
      ...Array.from({ length: 3 }, () => SECOND_LEADS_RANKS),
    ]);
    const visible = visibleSuspense(history, 12, 6, thresholds);

    // Le règne fait exactement 3 pas : il compte, et il commence dans la fenêtre finale.
    expect(visible.changes.visibleChanges).toBe(1);
    expect(visible.changes.lastVisibleChangeStep).toBe(9);
    expect(visible.changes.visibleInFinalWindow).toBe(true);
  });
});

describe('métriques « visibles » : remontées qualifiées', () => {
  const thresholds = {
    visibleLeaderChangeSteps: 3,
    lastStreakSteps: 4,
    boundStep: 4,
    finalWindowStartStep: 8,
  };
  /** c5 dernier aux pas 0..4, puis 2e — sans gagner. */
  const comebackRanks: readonly number[] = [1, 6, 3, 4, 5, 2];
  /** c5 dernier aux pas 0..4, puis vainqueur. */
  const comebackWinRanks: readonly number[] = [2, 6, 3, 4, 5, 1];
  /** c5 dernier aux pas 0..4, puis seulement 5e. */
  const shallowComebackRanks: readonly number[] = [1, 6, 3, 4, 2, 5];

  const withComeback = (tail: readonly number[]): number[] =>
    historyFromRanks([
      ...Array.from({ length: 5 }, () => IDENTITY_RANKS),
      ...Array.from({ length: 7 }, () => tail),
    ]);

  it('compte une remontée « dernier ≥ 2 s puis top 3 sans gagner »', () => {
    const visible = visibleSuspense(withComeback(comebackRanks), 12, 6, thresholds);

    expect(visible.longestLastStreakSteps).toBeGreaterThanOrEqual(5);
    expect(visible.heldLastTwoSeconds).toBe(true);
    expect(visible.lastStreakToTop3WithoutWin).toBe(true);
  });

  it('ne compte pas la remontée de celui qui gagne', () => {
    const visible = visibleSuspense(withComeback(comebackWinRanks), 12, 6, thresholds);

    expect(visible.heldLastTwoSeconds).toBe(true);
    expect(visible.lastStreakToTop3WithoutWin).toBe(false);
  });

  it('ne compte pas une remontée qui s’arrête au-delà du top 3', () => {
    const visible = visibleSuspense(withComeback(shallowComebackRanks), 12, 6, thresholds);

    expect(visible.heldLastTwoSeconds).toBe(true);
    expect(visible.lastStreakToTop3WithoutWin).toBe(false);
  });

  it('exige une série de dernier rang assez longue', () => {
    // c5 n'est dernier que trois pas (seuil : quatre), puis revient 2e — et personne d'autre ne
    // reste dernier plus longtemps, la course s'arrêtant trois pas après.
    const history = historyFromRanks([
      IDENTITY_RANKS,
      IDENTITY_RANKS,
      IDENTITY_RANKS,
      comebackRanks,
      comebackRanks,
      comebackRanks,
    ]);
    const visible = visibleSuspense(history, 6, 6, {
      ...thresholds,
      boundStep: 2,
      finalWindowStartStep: 4,
    });

    expect(visible.longestLastStreakSteps).toBe(3);
    expect(visible.heldLastTwoSeconds).toBe(false);
    expect(visible.lastStreakToTop3WithoutWin).toBe(false);
  });

  it('mesure la plus longue série au dernier rang, tous personnages confondus', () => {
    // c5 est dernier pendant tout le début, c0 prend sa place au pas 6.
    const history = historyFromRanks([
      ...Array.from({ length: 6 }, () => IDENTITY_RANKS),
      ...Array.from({ length: 6 }, () => [6, 2, 3, 4, 5, 1]),
    ]);
    const visible = visibleSuspense(history, 12, 6, thresholds);

    expect(visible.longestLastStreakSteps).toBe(6);
  });
});

describe('métriques « visibles » : relevés à 40 s et après 50 s', () => {
  const thresholds = {
    visibleLeaderChangeSteps: 3,
    lastStreakSteps: 4,
    boundStep: 4,
    finalWindowStartStep: 8,
  };

  const withRanksAtBound = (tail: readonly number[]): number[] =>
    historyFromRanks([
      ...Array.from({ length: 5 }, () => IDENTITY_RANKS),
      ...Array.from({ length: 7 }, () => tail),
    ]);

  it('compte un 5e ou 6e à 40 s qui termine dans le top 3, puis qui gagne', () => {
    const toTop3 = visibleSuspense(withRanksAtBound([1, 6, 3, 4, 5, 2]), 12, 6, thresholds);
    expect(toTop3.at40FifthOrSixthToTop3).toBe(true);
    expect(toTop3.at40FifthOrSixthToWin).toBe(false);

    const toWin = visibleSuspense(withRanksAtBound([2, 6, 3, 4, 5, 1]), 12, 6, thresholds);
    expect(toWin.at40FifthOrSixthToTop3).toBe(true);
    expect(toWin.at40FifthOrSixthToWin).toBe(true);
  });

  it('ignore un 4e à 40 s et un 6e à 40 s qui reste derrière', () => {
    const fourth = visibleSuspense(
      historyFromRanks([
        ...Array.from({ length: 5 }, () => [1, 2, 3, 6, 4, 5]),
        ...Array.from({ length: 7 }, () => [1, 2, 3, 6, 4, 5]),
      ]),
      12,
      6,
      thresholds,
    );
    expect(fourth.at40FifthOrSixthToTop3).toBe(false);

    const staysBehind = visibleSuspense(
      historyFromRanks(Array.from({ length: 12 }, () => IDENTITY_RANKS)),
      12,
      6,
      thresholds,
    );
    expect(staysBehind.at40FifthOrSixthToTop3).toBe(false);
    expect(staysBehind.at40FifthOrSixthToWin).toBe(false);
  });

  it('repère le leader de 40 s qui perd la tête après 50 s', () => {
    // c0 mène jusqu'au pas 8 inclus (donc encore en tête à 50 s), puis c1 prend la tête.
    const late = visibleSuspense(
      historyFromRanks([
        ...Array.from({ length: 9 }, () => IDENTITY_RANKS),
        ...Array.from({ length: 3 }, () => SECOND_LEADS_RANKS),
      ]),
      12,
      6,
      thresholds,
    );
    expect(late.leader40StillLeadsAt50).toBe(true);
    expect(late.leader40LosesLeadAfter50).toBe(true);

    // c0 perd la tête au pas 5, avant la fenêtre finale : ce n'est pas une perte « après 50 s ».
    const early = visibleSuspense(
      historyFromRanks([
        ...Array.from({ length: 5 }, () => IDENTITY_RANKS),
        ...Array.from({ length: 7 }, () => SECOND_LEADS_RANKS),
      ]),
      12,
      6,
      thresholds,
    );
    expect(early.leader40StillLeadsAt50).toBe(false);
    expect(early.leader40LosesLeadAfter50).toBe(false);

    // c0 ne lâche jamais la tête.
    const solid = visibleSuspense(
      historyFromRanks(Array.from({ length: 12 }, () => IDENTITY_RANKS)),
      12,
      6,
      thresholds,
    );
    expect(solid.leader40StillLeadsAt50).toBe(true);
    expect(solid.leader40LosesLeadAfter50).toBe(false);
  });
});

describe('métriques « visibles » : cohérence avec une course réelle', () => {
  it('relit dans l’historique le même nombre de changements que le suivi pas-à-pas', () => {
    const race = auditSuspenseRace('KR7Z8NAR');

    expect(race.leaderChangesConsistent).toBe(true);
    expect(race.visible.changes.rawChanges).toBe(race.leaderChanges);
    expect(race.visible.changes.visibleChanges).toBeLessThanOrEqual(race.leaderChanges);
    expect(race.visible.changes.visibleChanges + race.visible.changes.microChanges).toBe(
      race.leaderChanges,
    );
    expect(race.visible.changes.lastVisibleChangeStep).toBeLessThan(RACE_CONFIG.TOTAL_STEPS);
    // « perd la tête après 50 s » implique d'être encore en tête à l'entrée de la fenêtre finale.
    if (race.visible.leader40LosesLeadAfter50) {
      expect(race.visible.leader40StillLeadsAt50).toBe(true);
    }
    // Gagner après avoir été 5e ou 6e à 40 s implique d'être revenu dans le top 3.
    if (race.visible.at40FifthOrSixthToWin) {
      expect(race.visible.at40FifthOrSixthToTop3).toBe(true);
    }
  });

  it('qualifie les remontées de la course réelle par une durée', () => {
    const races = corpusSeeds(6).map((seed) => auditSuspenseRace(seed));

    for (const race of races) {
      expect(race.visible.changes.visibleChanges).toBeLessThanOrEqual(race.leaderChanges);
      expect(race.visible.longestLastStreakSteps).toBeGreaterThan(0);
      expect(race.visible.heldLastTwoSeconds).toBe(
        race.visible.longestLastStreakSteps >= DEFAULT_VISIBLE_SUSPENSE_THRESHOLDS.lastStreakSteps,
      );
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
 * Métriques « visibles » synthétiques : par défaut, aucun changement et personne ne bouge.
 *
 * Chaque champ peut être remplacé ; `changes.rawChanges` doit rester égal au `leaderChanges` de la
 * course synthétique, sinon la cohérence interne est fausse et la synthèse signalerait une anomalie.
 */
function syntheticVisible(
  overrides: Omit<Partial<VisibleSuspense>, 'changes'> & {
    readonly changes?: Partial<VisibleLeaderChangeMetrics>;
  } = {},
): VisibleSuspense {
  const { changes: changesOverride, ...rest } = overrides;
  const changes: VisibleLeaderChangeMetrics = {
    rawChanges: 0,
    visibleChanges: 0,
    microChanges: 0,
    lastVisibleChangeStep: -1,
    visibleInFinalWindow: false,
    ...(changesOverride ?? {}),
  };
  return {
    longestLastStreakSteps: 0,
    heldLastTwoSeconds: false,
    lastStreakToTop3WithoutWin: false,
    at40FifthOrSixthToTop3: false,
    at40FifthOrSixthToWin: false,
    leader40LosesLeadAfter50: false,
    leader40StillLeadsAt50: true,
    ...rest,
    changes,
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
    visible: syntheticVisible(),
    leaderChangesConsistent: true,
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
      leaderChangesConsistentEverywhere: true,
    });
  });

  it('agrège les changements visibles et les micro-changements', () => {
    const races = [
      syntheticRace({
        seed: 'visible',
        leaderChanges: 4,
        visible: syntheticVisible({
          changes: { rawChanges: 4, visibleChanges: 3, microChanges: 1 },
        }),
      }),
      syntheticRace({
        seed: 'micro',
        leaderChanges: 2,
        visible: syntheticVisible({
          changes: { rawChanges: 2, visibleChanges: 0, microChanges: 2 },
        }),
      }),
    ];
    const summary = summarizeSuspenseAudit(races);

    expect(summary.visibleChanges.rawMean).toBeCloseTo(3, 6);
    expect(summary.visibleChanges.visibleMean).toBeCloseTo(1.5, 6);
    expect(summary.visibleChanges.microMean).toBeCloseTo(1.5, 6);
    // 3 changements visibles sur 6 changements bruts.
    expect(summary.visibleChanges.visibleSharePercent).toBeCloseTo(50, 6);
    expect(summary.visibleChanges.racesWithVisibleChangePercent).toBeCloseTo(50, 6);
    expect(summary.visibleChanges.racesWithoutVisibleChangePercent).toBeCloseTo(50, 6);
    expect(summary.visibleChanges.visibleInFinalWindowPercent).toBe(0);
  });

  it('agrège les remontées qualifiées par une durée', () => {
    const races = [
      syntheticRace({
        seed: 'qualifiee',
        visible: syntheticVisible({
          longestLastStreakSteps: 300,
          heldLastTwoSeconds: true,
          lastStreakToTop3WithoutWin: true,
          at40FifthOrSixthToTop3: true,
          leader40LosesLeadAfter50: true,
        }),
      }),
      syntheticRace({ seed: 'plate' }),
    ];
    const summary = summarizeSuspenseAudit(races);

    expect(summary.qualifiedComebacks.heldLastTwoSecondsPercent).toBeCloseTo(50, 6);
    expect(summary.qualifiedComebacks.longestLastStreakStepsMean).toBeCloseTo(150, 6);
    expect(summary.qualifiedComebacks.longestLastStreakStepsMedian).toBeCloseTo(150, 6);
    expect(summary.qualifiedComebacks.lastStreakToTop3WithoutWinPercent).toBeCloseTo(50, 6);
    expect(summary.qualifiedComebacks.at40FifthOrSixthToTop3Percent).toBeCloseTo(50, 6);
    expect(summary.qualifiedComebacks.at40FifthOrSixthToWinPercent).toBe(0);
    expect(summary.qualifiedComebacks.leader40LosesLeadAfter50Percent).toBeCloseTo(50, 6);
    // La course synthétique par défaut voit son leader de 40 s encore en tête à 50 s.
    expect(summary.qualifiedComebacks.leader40StillLeadsAt50Percent).toBeCloseTo(100, 6);
  });

  it('signale un historique dont le compte brut diverge du compteur pas-à-pas', () => {
    const summary = summarizeSuspenseAudit([
      syntheticRace({ leaderChangesConsistent: false }),
    ]);

    expect(summary.corpus.leaderChangesConsistentEverywhere).toBe(false);
    const lines = conclusionLines(summary);
    expect(lines.join('\n')).toContain("relu dans l'historique diverge");
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
    expect(SUSPENSE_REFERENCES.leaderChangesMeanAt1000Seeds).toBeCloseTo(8.308, 6);
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
    expect(full).toHaveLength(8);
    // Chaque référence n'est comparable qu'à la taille de corpus où elle a été publiée.
    const atTenThousand = full.filter((check) => check.comparable);
    expect(atTenThousand).toHaveLength(7);
    expect(atTenThousand.every((check) => check.reproduced)).toBe(true);
    expect(full.find((check) => check.id === 'leader-changes-mean-1000')?.comparable).toBe(false);
    expect(full.map((check) => check.measured)).toContain('34,04 %');
    expect(full.map((check) => check.measured)).toContain('8,193');

    // Sur un corpus de 1 000 seeds, c'est la référence de 1 000 seeds qui devient comparable.
    const atOneThousand = referenceChecks(
      persistence,
      SUSPENSE_REFERENCES.leaderChangesMeanAt1000Seeds,
      1_000,
    );
    expect(atOneThousand.filter((check) => check.comparable).map((check) => check.id)).toEqual([
      'leader-changes-mean-1000',
    ]);
    expect(
      atOneThousand.find((check) => check.id === 'leader-changes-mean-1000')?.reproduced,
    ).toBe(true);
    expect(atOneThousand.find((check) => check.id === 'same-leader-all-bounds')?.comparable).toBe(
      false,
    );

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
    expect(text).toContain('Brut contre visible');
    expect(text).toContain('changements VISIBLES');
    expect(text).toContain('micro-changements');
    expect(text).toContain("dernier ≥ 2 s d'affilée puis top 3 SANS gagner");
    expect(text).toContain('5e ou 6e au relevé de 40 s');
    expect(text).toContain('perd la tête après 50 s');
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
    expect(report).toContain('visibleChanges');
    expect(report).toContain('qualifiedComebacks');
    expect(report).toContain('leaderChangesConsistentEverywhere');
    expect(report).not.toContain('undefined');
  });

  it('n’annonce des références reproduites que si une référence est comparable ici', () => {
    // Sur un corpus d'une course, aucune référence n'est comparable : la conclusion ne doit pas
    // prétendre les avoir reproduites.
    const summary = summarizeSuspenseAudit([syntheticRace()]);
    expect(summary.references.some((check) => check.comparable)).toBe(false);
    expect(conclusionLines(summary)[0] ?? '').not.toContain('références reproduites');
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
// Sweep du bruit de dérive après 40 s (mode expérimental)
// ---------------------------------------------------------------------------------------------

describe('sweep du bruit de dérive', () => {
  const fromStep = stepsForSeconds(DRIFT_NOISE_SWEEP_FROM_S);

  it('n’amplifie rien avant la borne, et amplifie tout après', () => {
    const scale = noiseScaleAfter(fromStep, 1.45);
    expect(scale(1)).toBe(1);
    expect(scale(fromStep - 1)).toBe(1);
    // Le pas qui ATTEINT 40 s n'est pas amplifié : l'état publié au checkpoint reste celui du baseline.
    expect(scale(fromStep)).toBe(1);
    expect(scale(fromStep + 1)).toBe(1.45);
    expect(scale(fromStep + 600)).toBe(1.45);
  });

  it('dilate le bruit déjà tiré sans consommer de tirage supplémentaire', () => {
    const seed = 'KR7Z8NAR';
    // Deux moteurs identiques ne divergent jamais.
    expect(firstDivergentStep(seed)).toBe(-1);
    // Un facteur de 1 est inerte : la course de mesure est exactement celle de production.
    expect(firstDivergentStep(seed, { driftNoiseScale: () => 1 })).toBe(-1);
    expect(auditSuspenseRace(seed, { driftNoiseScale: () => 1 })).toEqual(auditSuspenseRace(seed));

    // Avec un facteur réel, la divergence commence juste après la borne, jamais avant.
    const divergent = firstDivergentStep(seed, {
      driftNoiseScale: noiseScaleAfter(fromStep, 1.45),
    });
    expect(divergent).toBeGreaterThan(fromStep);
    expect(divergent).toBeLessThanOrEqual(fromStep + 2);
  });

  it('ne touche ni les rangs ni les écarts relevés à 40 s', () => {
    const seed = 'KR7Z8NAR';
    const baseline = auditSuspenseRace(seed);
    const variant = auditSuspenseRace(seed, {
      driftNoiseScale: noiseScaleAfter(fromStep, 1.45),
    });

    // Les bornes de 20 s et 40 s sont identiques ; le relevé de 50 s, lui, est après le levier.
    expect(variant.leadersAtBounds[0]).toBe(baseline.leadersAtBounds[0]);
    expect(variant.leadersAtBounds[1]).toBe(baseline.leadersAtBounds[1]);
    expect(variant.gapAtBoundsM[0]).toBe(baseline.gapAtBoundsM[0]);
    expect(variant.gapAtBoundsM[1]).toBe(baseline.gapAtBoundsM[1]);
    expect(variant.gapAtMarksM[0]).toBeGreaterThanOrEqual(0);
  });

  it('produit un tableau par facteur, avec le contrôle d’innocuité', () => {
    const seeds = corpusSeeds(2);
    const report = runNoiseSweep(seeds, { factors: [1, 1.45] });

    expect(report.seeds).toBe(2);
    expect(report.fromS).toBe(DRIFT_NOISE_SWEEP_FROM_S);
    expect(report.fromStep).toBe(fromStep);
    expect(report.points).toHaveLength(2);
    expect(report.factors).toEqual([1, 1.45]);

    const [baseline, variant] = report.points;
    expect(baseline?.factor).toBe(1);
    expect(variant?.factor).toBe(1.45);

    // Le point ×1,00 doit être exactement l'audit de production du même corpus.
    const baselineMetrics = noiseSweepMetrics(
      summarizeSuspenseAudit(seeds.map((seed) => auditSuspenseRace(seed))),
    );
    expect(baseline?.metrics).toEqual(baselineMetrics);

    // Aucune course ne diverge à 40 s ou avant, pour aucun facteur.
    for (const point of report.points) {
      expect(point.inertness.seeds).toBe(2);
      expect(point.inertness.fromStep).toBe(fromStep);
      expect(point.inertness.divergentAtOrBeforeBound).toBe(0);
      expect(point.metrics.winnerSharesPercent).toHaveLength(SUSPENSE_PLAYERS);
      expect(point.metrics.gapAtFinishMedianM).toBeGreaterThanOrEqual(0);
    }
    expect(variant?.inertness.firstDivergentStepMin).toBeGreaterThan(fromStep);
  });

  it('rend un tableau lisible et un JSON sans constante de production modifiée', () => {
    const report = runNoiseSweep(corpusSeeds(1), { factors: [1, 1.15] });
    const text = renderNoiseSweepText(report);

    expect(text).toContain('sweep du bruit de dérive');
    expect(text).toContain('×1,00');
    expect(text).toContain('×1,15');
    expect(text).toContain('leader à 40 s qui gagne');
    expect(text).toContain('leader à 40 s qui perd la tête après 50 s');
    expect(text).toContain('changement visible dans les 10 dernières secondes');
    expect(text).toContain('5e/6e à 40 s → top 3');
    expect(text).toContain('5e/6e à 40 s → victoire');
    expect(text).toContain('même leader 20/40/60');
    expect(text).toContain('écart P1–P2 médian à l’arrivée');
    expect(text).toContain('arrivée sous 15 m');
    expect(text).toContain('répartition des vainqueurs');
    expect(text).toContain('identité bit à bit jusqu’à 40 s');

    const json = JSON.stringify(buildNoiseSweepJson(report));
    expect(json).toContain('chaos-race-drift-noise-sweep');
    expect(json).toContain('"productionConstantsChanged":false');
    expect(json).toContain('"extraRngDraws":0');
    expect(json).toContain('"rankIndependent":true');
    expect(json).not.toContain('undefined');
  });

  it('compare les facteurs demandés dans l’ordre, baseline en tête', () => {
    expect(DRIFT_NOISE_SWEEP_FACTORS).toEqual([1, 1.15, 1.3, 1.45]);
    expect(DRIFT_NOISE_SWEEP_FROM_S).toBe(LEADER_BOUNDS_S[1]);
  });
});

// ---------------------------------------------------------------------------------------------
// Candidat « surges plus fréquents après 40 s » (mode expérimental)
// ---------------------------------------------------------------------------------------------

describe('surges plus fréquents après 40 s', () => {
  const fromStep = stepsForSeconds(SURGE_INTERVAL_FROM_S);

  it('dérive ses bornes de la moyenne, sans toucher au minimum', () => {
    expect(SURGE_INTERVAL_BASELINE_MEAN_S).toBe(GAME_CONFIG.SURGE.INTERVAL_MEAN_S);
    expect(SURGE_INTERVAL_CANDIDATE_MEAN_S).toBe(6);
    expect(SURGE_INTERVAL_FROM_S).toBe(LEADER_BOUNDS_S[1]);

    // La borne basse reste celle de la production : c'est elle qui garantit « un seul surge actif ».
    const candidate = intervalStepRangeForMean(GAME_CONFIG, SURGE_INTERVAL_CANDIDATE_MEAN_S);
    const baseline = intervalStepRange(GAME_CONFIG);
    expect(candidate.min).toBe(baseline.min);
    expect(candidate.min).toBe(stepsForSeconds(GAME_CONFIG.SURGE.INTERVAL_MIN_S));
    // La borne haute reste dérivée : `2 × moyenne − min`, donc la moyenne de la loi est exacte.
    expect(candidate.max).toBe(stepsForSeconds(2 * SURGE_INTERVAL_CANDIDATE_MEAN_S - GAME_CONFIG.SURGE.INTERVAL_MIN_S));
    expect((candidate.min + candidate.max) / 2).toBe(stepsForSeconds(SURGE_INTERVAL_CANDIDATE_MEAN_S));
    // La garantie structurelle tient : l'intervalle minimal ne descend pas sous la durée maximale.
    expect(candidate.min).toBeGreaterThanOrEqual(stepsForSeconds(GAME_CONFIG.SURGE.DURATION_MAX_S));
    expect(() => intervalStepRangeForMean(GAME_CONFIG, 1)).toThrow(RangeError);
  });

  it('ne change rien avant 40 s et ne touche ni durée, ni magnitude, ni freinage', () => {
    const seed = 'KR7Z8NAR';
    const candidate = { surgeIntervalAfter: { fromStep, meanS: SURGE_INTERVAL_CANDIDATE_MEAN_S } };
    const baseline = auditSuspenseRace(seed);
    const variant = auditSuspenseRace(seed, candidate);

    // Identité stricte jusqu'à 40 s : rangs et écarts des deux premières bornes confondus.
    expect(variant.leadersAtBounds[0]).toBe(baseline.leadersAtBounds[0]);
    expect(variant.leadersAtBounds[1]).toBe(baseline.leadersAtBounds[1]);
    expect(variant.gapAtBoundsM[0]).toBe(baseline.gapAtBoundsM[0]);
    expect(variant.gapAtBoundsM[1]).toBe(baseline.gapAtBoundsM[1]);
    const divergent = firstDivergentStep(seed, candidate);
    expect(divergent).toBeGreaterThan(fromStep);
  });

  it('n’ajoute aucun tirage : un candidat identique à la production est inerte', () => {
    const seed = 'KR7Z8NAR';
    // Même moyenne que la production : les bornes sont identiques, donc la course doit l'être aussi.
    const sameMean = {
      surgeIntervalAfter: { fromStep, meanS: SURGE_INTERVAL_BASELINE_MEAN_S },
    };
    expect(firstDivergentStep(seed, sameMean)).toBe(-1);
    expect(auditSuspenseRace(seed, sameMean)).toEqual(auditSuspenseRace(seed));
  });

  it('compare production et candidat sur le même corpus', () => {
    const seeds = corpusSeeds(2);
    const report = runSurgeIntervalComparison(seeds, { meanS: 6 });

    expect(report.seeds).toBe(2);
    expect(report.fromS).toBe(SURGE_INTERVAL_FROM_S);
    expect(report.fromStep).toBe(fromStep);
    expect(report.points).toHaveLength(2);

    const [baseline, candidate] = report.points;
    expect(baseline?.label).toContain('production');
    expect(candidate?.label).toContain('6 s');
    // Le point de production est exactement l'audit du même corpus.
    expect(baseline?.metrics).toEqual(
      noiseSweepMetrics(summarizeSuspenseAudit(seeds.map((seed) => auditSuspenseRace(seed)))),
    );
    for (const point of report.points) {
      expect(point.inertness.divergentAtOrBeforeBound).toBe(0);
      expect(point.metrics.winnerSharesPercent).toHaveLength(SUSPENSE_PLAYERS);
    }
    expect(candidate?.inertness.firstDivergentStepMin).toBeGreaterThan(fromStep);
  });

  it('rend un tableau avec la cible annoncée et un JSON sans constante modifiée', () => {
    const report = runSurgeIntervalComparison(corpusSeeds(1), { meanS: 6 });
    const text = renderSurgeIntervalComparisonText(report);

    expect(text).toContain('surges plus fréquents après 40 s');
    expect(text).toContain('production');
    expect(text).toContain('leader à 40 s qui gagne');
    expect(text).toContain('leader à 40 s qui perd la tête après 50 s');
    expect(text).toContain('changement visible dans les 10 dernières secondes');
    expect(text).toContain('5e/6e à 40 s → top 3');
    expect(text).toContain('même leader 20/40/60');
    expect(text).toContain('écart P1–P2 médian à l’arrivée');
    expect(text).toContain('arrivée sous 15 m');
    expect(text).toContain('répartition des vainqueurs');
    expect(text).toContain('identité bit à bit jusqu’à 40 s');
    expect(text).toContain('48–55 %');

    const json = JSON.stringify(buildSurgeIntervalComparisonJson(report));
    expect(json).toContain('chaos-race-surge-interval-comparison');
    expect(json).toContain('"productionConstantsChanged":false');
    expect(json).toContain('"extraRngDraws":0');
    expect(json).toContain('"newRngStreams":0');
    expect(json).toContain('"durationRangeUnchanged":true');
    expect(json).toContain('"brakeProbabilityUnchanged":true');
    expect(json).not.toContain('undefined');
  });
});

// ---------------------------------------------------------------------------------------------
// Candidat « forme de fin de course persistante » (mode expérimental)
// ---------------------------------------------------------------------------------------------

describe('forme de fin de course persistante ±8 %', () => {
  const fromStep = stepsForSeconds(LATE_FORM_FROM_S);
  const fullAtStep = stepsForSeconds(LATE_FORM_FULL_S);
  /** Enveloppe du candidat ±8 % : montée 40 → 42 s, puis effet complet jusqu'à l'arrivée. */
  const envelope = { fromStep, fullAtStep };

  it('monte progressivement de 0 % à 40 s jusqu’à 100 % à 42 s', () => {
    expect(LATE_FORM_FROM_S).toBe(LEADER_BOUNDS_S[1]);
    expect(LATE_FORM_FULL_S).toBe(LATE_FORM_FROM_S + 2);
    expect(LATE_FORM_AMPLITUDE).toBe(0.08);

    // Le pas qui atteint 40 s ne subit rien : l'identité jusqu'à 40 s incluse est exacte.
    expect(lateFormFactor(0.08, fromStep, envelope)).toBe(1);
    expect(lateFormFactor(0.08, fromStep - 1, envelope)).toBe(1);
    // 41 s : la moitié de l'effet ; 42 s : l'effet complet.
    expect(lateFormFactor(0.08, stepsForSeconds(41), envelope)).toBeCloseTo(1.04, 12);
    expect(lateFormFactor(0.08, fullAtStep, envelope)).toBeCloseTo(1.08, 12);
    // Puis constant jusqu'à l'arrivée.
    expect(lateFormFactor(0.08, RACE_CONFIG.TOTAL_STEPS, envelope)).toBeCloseTo(1.08, 12);
    // Symétrique : une forme négative freine exactement autant.
    expect(lateFormFactor(-0.08, fullAtStep, envelope)).toBeCloseTo(0.92, 12);
    // Une forme nulle est inerte, à tout pas.
    expect(lateFormFactor(0, RACE_CONFIG.TOTAL_STEPS, envelope)).toBe(1);
  });

  it('tire une forme par personnage sur un flux dédié, dans les bornes', () => {
    const seed = 'KR7Z8NAR';
    const values = lateFormValues(seed, LATE_FORM_AMPLITUDE);

    expect(values).toHaveLength(SUSPENSE_PLAYERS);
    expect(lateFormValues(seed, LATE_FORM_AMPLITUDE)).toEqual(values);
    for (const value of values) {
      expect(Math.abs(value)).toBeLessThanOrEqual(LATE_FORM_AMPLITUDE);
    }
    // Six tirages indépendants : ils ne sont pas tous identiques, et changer de seed les change tous.
    expect(new Set(values).size).toBeGreaterThan(1);
    expect(lateFormValues('MFFX4731', LATE_FORM_AMPLITUDE)).not.toEqual(values);
    // Le flux est bien distinct de ceux du moteur : la forme n'est pas corrélée à la dérive.
    const drift = forkStream(normalizeSeed(seed), 'drift:c0');
    const lateForm = forkStream(normalizeSeed(seed), `${LATE_FORM_STREAM_PREFIX}c0`);
    expect(lateForm.next()).not.toBe(drift.next());
  });

  it('aligne les formes sur l’ordre des partants, qui est le roster à six', () => {
    // C'est ce qui autorise l'outil à fournir les formes dans l'ordre de `CHARACTER_IDS`.
    for (const seed of corpusSeeds(5)) {
      expect(selectParticipants(normalizeSeed(seed), SUSPENSE_PLAYERS)).toEqual(CHARACTER_IDS);
    }
  });

  it('ne change rien jusqu’à 40 s inclus et ne touche à rien d’autre', () => {
    const seed = 'KR7Z8NAR';
    const candidate = {
      lateForm: { fromStep, fullAtStep, values: lateFormValues(seed, LATE_FORM_AMPLITUDE) },
    };
    const baseline = auditSuspenseRace(seed);
    const variant = auditSuspenseRace(seed, candidate);

    expect(variant.leadersAtBounds[0]).toBe(baseline.leadersAtBounds[0]);
    expect(variant.leadersAtBounds[1]).toBe(baseline.leadersAtBounds[1]);
    expect(variant.gapAtBoundsM[0]).toBe(baseline.gapAtBoundsM[0]);
    expect(variant.gapAtBoundsM[1]).toBe(baseline.gapAtBoundsM[1]);

    const divergent = firstDivergentStep(seed, candidate);
    // Premier pas du levier : 2401, soit le premier pas **après** 40 s. Jamais 2400.
    expect(divergent).toBe(fromStep + 1);
  });

  it('est inerte si les formes sont nulles, et déterministe sinon', () => {
    const seed = 'KR7Z8NAR';
    const zeros = {
      lateForm: { fromStep, fullAtStep, values: new Array<number>(SUSPENSE_PLAYERS).fill(0) },
    };
    expect(firstDivergentStep(seed, zeros)).toBe(-1);
    expect(auditSuspenseRace(seed, zeros)).toEqual(auditSuspenseRace(seed));

    const candidate = {
      lateForm: { fromStep, fullAtStep, values: lateFormValues(seed, LATE_FORM_AMPLITUDE) },
    };
    expect(auditSuspenseRace(seed, candidate)).toEqual(auditSuspenseRace(seed, candidate));
    // Une forme par partant : un tableau de la mauvaise taille est refusé.
    expect(() =>
      new RaceEngine(
        seed,
        GAME_CONFIG,
        { players: SUSPENSE_PLAYERS, lateForm: { fromStep, fullAtStep, values: [0.01] } },
      ),
    ).toThrow(RangeError);
  });

  it('compare production et candidat, et contrôle le biais des formes', () => {
    const seeds = corpusSeeds(3);
    const report = runLateFormComparison(seeds, { amplitude: LATE_FORM_AMPLITUDE });

    expect(report.comparison.seeds).toBe(3);
    expect(report.comparison.points).toHaveLength(2);
    expect(report.comparison.fromS).toBe(LATE_FORM_FROM_S);
    expect(report.fromStep).toBe(fromStep);
    expect(report.fullAtStep).toBe(fullAtStep);
    expect(report.amplitude).toBe(LATE_FORM_AMPLITUDE);

    const [baseline, candidate] = report.comparison.points;
    expect(baseline?.label).toBe('production');
    expect(candidate?.label).toContain('±8 %');
    expect(baseline?.metrics).toEqual(
      noiseSweepMetrics(summarizeSuspenseAudit(seeds.map((seed) => auditSuspenseRace(seed)))),
    );
    for (const point of report.comparison.points) {
      expect(point.inertness.divergentAtOrBeforeBound).toBe(0);
      expect(point.metrics.winnerSharesPercent).toHaveLength(SUSPENSE_PLAYERS);
    }
    // Le levier ne peut agir qu'après 40 s : le premier pas divergent est 2401.
    expect(candidate?.inertness.firstDivergentStepMin).toBe(fromStep + 1);
    expect(baseline?.inertness.firstDivergentStepMin).toBe(-1);

    // Contrôle de biais : six personnages, des bornes respectées, une moyenne globale proche de zéro.
    expect(report.statsByCharacter.map((stats) => stats.id)).toEqual([...CHARACTER_IDS]);
    expect(lateFormStats(seeds, LATE_FORM_AMPLITUDE).byCharacter).toEqual([...report.statsByCharacter]);
    expect(lateFormStats(seeds, LATE_FORM_AMPLITUDE).pooledMean).toBe(report.pooledMean);
    for (const stats of report.statsByCharacter) {
      expect(stats.min).toBeGreaterThanOrEqual(-LATE_FORM_AMPLITUDE);
      expect(stats.max).toBeLessThanOrEqual(LATE_FORM_AMPLITUDE);
      expect(Math.abs(stats.mean)).toBeLessThan(LATE_FORM_AMPLITUDE / 2);
    }
    expect(Math.abs(report.pooledMean)).toBeLessThan(LATE_FORM_AMPLITUDE / 2);
  });

  it('rend un tableau avec les formes et un JSON sans constante modifiée', () => {
    const report = runLateFormComparison(corpusSeeds(1), { amplitude: LATE_FORM_AMPLITUDE });
    const text = renderLateFormComparisonText(report);

    expect(text).toContain('forme de fin de course persistante ±8 %');
    expect(text).toContain('leader à 40 s qui gagne');
    expect(text).toContain('changement visible dans les 10 dernières secondes');
    expect(text).toContain('5e/6e à 40 s → top 3');
    expect(text).toContain('même leader 20/40/60');
    expect(text).toContain('écart P1–P2 médian à l’arrivée');
    expect(text).toContain('répartition des vainqueurs');
    expect(text).toContain('Formes tirées sur le corpus');
    expect(text).toContain('espérance théorique : 0,000 %');
    expect(text).toContain('identité bit à bit jusqu’à 40 s');
    expect(text).toContain('50–55 %');

    const json = JSON.stringify(buildLateFormComparisonJson(report));
    expect(json).toContain('chaos-race-late-form-comparison');
    expect(json).toContain('"dedicatedStream":true');
    expect(json).toContain('"appliesTo":"targetSpeed"');
    expect(json).toContain('"productionConstantsChanged":false');
    expect(json).toContain('"extraRngDraws":0');
    expect(json).toContain('"zeroMean":true');
    expect(json).not.toContain('undefined');
  });

  it('accepte une rampe plus longue et une amplitude plus forte, sans rien changer avant 40 s', () => {
    // Candidat « plus fort mais plus tardif » : ±16 %, 0 % à 40 s, 50 % à 45 s, 100 % à 50 s.
    const amplitude = 0.16;
    const fullS = 50;
    const fullAtStep = stepsForSeconds(fullS);

    expect(lateFormFactor(amplitude, fromStep, { fromStep, fullAtStep })).toBe(1);
    expect(lateFormFactor(amplitude, stepsForSeconds(45), { fromStep, fullAtStep })).toBeCloseTo(1.08, 12);
    expect(lateFormFactor(amplitude, fullAtStep, { fromStep, fullAtStep })).toBeCloseTo(1.16, 12);
    expect(lateFormFactor(-amplitude, fullAtStep, { fromStep, fullAtStep })).toBeCloseTo(0.84, 12);

    const seed = 'KR7Z8NAR';
    const values = lateFormValues(seed, amplitude);
    const half = lateFormValues(seed, LATE_FORM_AMPLITUDE);
    expect(values).toHaveLength(SUSPENSE_PLAYERS);
    values.forEach((value, slot) => {
      expect(Math.abs(value)).toBeLessThanOrEqual(amplitude);
      // Une amplitude doublée double exactement chaque forme : le tirage lui-même ne change pas.
      expect(value).toBeCloseTo((half[slot] ?? 0) * 2, 12);
    });

    const candidate = { lateForm: { fromStep, fullAtStep, values } };
    const baseline = auditSuspenseRace(seed);
    const variant = auditSuspenseRace(seed, candidate);
    expect(variant.leadersAtBounds[1]).toBe(baseline.leadersAtBounds[1]);
    expect(variant.gapAtBoundsM[1]).toBe(baseline.gapAtBoundsM[1]);
    // Le contrôle ne dépend pas de la rampe : premier pas divergent = 2401, soit après 40 s.
    expect(firstDivergentStep(seed, candidate)).toBe(fromStep + 1);

    const report = runLateFormComparison(corpusSeeds(2), { amplitude, fullS });
    expect(report.amplitude).toBe(amplitude);
    expect(report.fullS).toBe(fullS);
    expect(report.fullAtStep).toBe(fullAtStep);
    expect(report.comparison.points[1]?.label).toContain('±16 %');
    expect(report.comparison.points[1]?.label).toContain('50 s');
    expect(report.comparison.points[1]?.inertness.firstDivergentStepMin).toBe(fromStep + 1);
    expect(report.comparison.points[1]?.inertness.divergentAtOrBeforeBound).toBe(0);
    expect(renderLateFormComparisonText(report)).toContain('±16 %');
    // Une rampe qui ne monte pas est refusée.
    expect(() => runLateFormComparison(corpusSeeds(1), { amplitude, fullS: LATE_FORM_FROM_S })).toThrow(
      RangeError,
    );
  });

  it('applique une enveloppe 40→50→55→60 et revient exactement à 1 à l’arrivée', () => {
    const amplitude = 0.16;
    const fullS = 50;
    const fallFromS = 55;
    const endS = 60;
    const envelope = {
      fromStep,
      fullAtStep: stepsForSeconds(fullS),
      fallFromStep: stepsForSeconds(fallFromS),
      endStep: stepsForSeconds(endS),
    };

    // 40 s : rien ; 45 s : +8 % ; 50 s et 55 s : +16 % ; 57,5 s : +8 % ; 60 s : exactement 1.
    expect(lateFormFactor(amplitude, fromStep, envelope)).toBe(1);
    expect(lateFormFactor(amplitude, stepsForSeconds(45), envelope)).toBeCloseTo(1.08, 12);
    expect(lateFormFactor(amplitude, stepsForSeconds(fullS), envelope)).toBeCloseTo(1.16, 12);
    expect(lateFormFactor(amplitude, stepsForSeconds(fallFromS), envelope)).toBeCloseTo(1.16, 12);
    expect(lateFormFactor(amplitude, stepsForSeconds(57.5), envelope)).toBeCloseTo(1.08, 12);
    // Contrôle demandé : le multiplicateur est **exactement** 1 au pas de 60 s (3600).
    expect(lateFormFactor(amplitude, stepsForSeconds(endS), envelope)).toBe(1);
    expect(stepsForSeconds(endS)).toBe(RACE_CONFIG.TOTAL_STEPS);
    // …et il ne l'est pas encore tout à fait au pas précédent.
    expect(lateFormFactor(amplitude, RACE_CONFIG.TOTAL_STEPS - 1, envelope)).toBeGreaterThan(1);
    // Symétrie parfaite en négatif.
    expect(lateFormFactor(-amplitude, stepsForSeconds(fullS), envelope)).toBeCloseTo(0.84, 12);
    expect(lateFormFactor(-amplitude, stepsForSeconds(57.5), envelope)).toBeCloseTo(0.92, 12);
    expect(lateFormFactor(-amplitude, stepsForSeconds(endS), envelope)).toBe(1);

    const seed = 'KR7Z8NAR';
    const candidate = {
      lateForm: {
        fromStep,
        fullAtStep: envelope.fullAtStep,
        fallFromStep: envelope.fallFromStep,
        endStep: envelope.endStep,
        values: lateFormValues(seed, amplitude),
      },
    };
    const baseline = auditSuspenseRace(seed);
    const variant = auditSuspenseRace(seed, candidate);
    // Identité jusqu'à 40 s inclus, puis premier pas divergent = 2401 (après la borne).
    expect(variant.leadersAtBounds[1]).toBe(baseline.leadersAtBounds[1]);
    expect(variant.gapAtBoundsM[1]).toBe(baseline.gapAtBoundsM[1]);
    expect(firstDivergentStep(seed, candidate)).toBe(fromStep + 1);

    const report = runLateFormComparison(corpusSeeds(2), { amplitude, fullS, fallFromS, endS });
    expect(report.fallFromS).toBe(fallFromS);
    expect(report.endS).toBe(endS);
    expect(report.fallFromStep).toBe(envelope.fallFromStep);
    expect(report.endStep).toBe(RACE_CONFIG.TOTAL_STEPS);
    expect(report.comparison.points[1]?.label).toContain('40 → 50 → 55 → 60 s');
    expect(report.comparison.points[1]?.inertness.firstDivergentStepMin).toBe(fromStep + 1);
    const text = renderLateFormComparisonText(report);
    expect(text).toContain('retombée linéaire de 55 s à 60 s');
    expect(text).toContain('exactement 1');
    const json = JSON.stringify(buildLateFormComparisonJson(report));
    expect(json).toContain('"factorOneAtEnd":true');
    expect(json).toContain('"endS":60');

    // Une retombée incomplète ou incohérente est refusée.
    expect(() => runLateFormComparison(corpusSeeds(1), { amplitude, fullS, fallFromS })).toThrow(RangeError);
    expect(() =>
      runLateFormComparison(corpusSeeds(1), { amplitude, fullS, fallFromS: 45, endS: 60 }),
    ).toThrow(RangeError);
    expect(() =>
      runLateFormComparison(corpusSeeds(1), { amplitude, fullS, fallFromS: 55, endS: 55 }),
    ).toThrow(RangeError);
  });

  it('expose la fenêtre des 5 dernières secondes et le seuil des 10 m', () => {
    const summary = summarizeSuspenseAudit(corpusSeeds(2).map((seed) => auditSuspenseRace(seed)));
    const metrics = noiseSweepMetrics(summary);

    // Les fenêtres visibles sont celles des changements bruts, et 10 s concorde exactement avec la
    // mesure historique `visibleInFinalWindowPercent`.
    expect(summary.visibleChanges.windowsS).toEqual([...LAST_CHANGE_WINDOWS_S]);
    expect(summary.visibleChanges.visibleWithinWindowPercent).toHaveLength(LAST_CHANGE_WINDOWS_S.length);
    const indexOf10 = LAST_CHANGE_WINDOWS_S.indexOf(10);
    expect(summary.visibleChanges.visibleWithinWindowPercent[indexOf10]).toBe(
      summary.visibleChanges.visibleInFinalWindowPercent,
    );
    expect(metrics.visibleChangeInLast5Percent).toBe(
      summary.visibleChanges.visibleWithinWindowPercent[LAST_CHANGE_WINDOWS_S.indexOf(5)],
    );
    // Les deux seuils d'arrivée serrée sortent de la même table de seuils.
    const indexOf15 = summary.gapThresholdsM.indexOf(FACT.CLOSE_RACE_MAX_GAP_M);
    const indexOf10m = summary.gapThresholdsM.indexOf(TIGHT_FINISH_GAP_M);
    expect(metrics.finishUnder15mPercent).toBe(summary.finalSuspense.photoAtFinishPercent[indexOf15]);
    expect(metrics.finishUnder10mPercent).toBe(summary.finalSuspense.photoAtFinishPercent[indexOf10m]);
    expect(metrics.finishUnder10mPercent).toBeLessThanOrEqual(metrics.finishUnder15mPercent);

    const report = runLateFormComparison(corpusSeeds(1), { amplitude: LATE_FORM_AMPLITUDE });
    const text = renderLateFormComparisonText(report);
    expect(text).toContain('changement visible dans les 5 dernières secondes');
    expect(text).toContain('arrivée sous 10 m');
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
    expect(options.sweep).toBe(false);
    expect(options.sweepFactors).toEqual(DRIFT_NOISE_SWEEP_FACTORS);
  });

  it('active le mode sweep et lit ses facteurs', () => {
    const defaults = parseSuspenseAuditArgs(['--sweep']);
    expect(defaults).not.toBe('help');
    if (defaults === 'help') {
      throw new Error('aide inattendue');
    }
    expect(defaults.sweep).toBe(true);
    expect(defaults.sweepFactors).toEqual(DRIFT_NOISE_SWEEP_FACTORS);

    const explicit = parseSuspenseAuditArgs(['--sweep-factors=1,1.2,1.5']);
    expect(explicit).not.toBe('help');
    if (explicit === 'help') {
      throw new Error('aide inattendue');
    }
    expect(explicit.sweep).toBe(true);
    expect(explicit.sweepFactors).toEqual([1, 1.2, 1.5]);

    expect(() => parseSuspenseAuditArgs(['--sweep-factors=1,0'])).toThrow(RangeError);
    expect(() => parseSuspenseAuditArgs(['--sweep-factors=abc'])).toThrow(RangeError);
  });

  it('active le mode surges plus fréquents et lit sa moyenne', () => {
    const defaults = parseSuspenseAuditArgs(['--surge-interval']);
    expect(defaults).not.toBe('help');
    if (defaults === 'help') {
      throw new Error('aide inattendue');
    }
    expect(defaults.surgeInterval).toBe(true);
    expect(defaults.surgeIntervalMeanS).toBe(SURGE_INTERVAL_CANDIDATE_MEAN_S);
    expect(defaults.sweep).toBe(false);

    const explicit = parseSuspenseAuditArgs(['--surge-interval-mean=7.5']);
    expect(explicit).not.toBe('help');
    if (explicit === 'help') {
      throw new Error('aide inattendue');
    }
    expect(explicit.surgeInterval).toBe(true);
    expect(explicit.surgeIntervalMeanS).toBe(7.5);

    expect(() => parseSuspenseAuditArgs(['--surge-interval-mean=0'])).toThrow(RangeError);
    expect(() => parseSuspenseAuditArgs(['--surge-interval-mean=abc'])).toThrow(RangeError);
  });

  it('active le mode forme de fin de course et lit son amplitude', () => {
    const defaults = parseSuspenseAuditArgs(['--late-form']);
    expect(defaults).not.toBe('help');
    if (defaults === 'help') {
      throw new Error('aide inattendue');
    }
    expect(defaults.lateForm).toBe(true);
    expect(defaults.lateFormAmplitude).toBe(LATE_FORM_AMPLITUDE);
    expect(defaults.sweep).toBe(false);
    expect(defaults.surgeInterval).toBe(false);

    // L'amplitude s'accepte en fraction comme en pourcentage.
    const fraction = parseSuspenseAuditArgs(['--late-form-amplitude=0.05']);
    const percent = parseSuspenseAuditArgs(['--late-form-amplitude=5']);
    for (const options of [fraction, percent]) {
      expect(options).not.toBe('help');
      if (options === 'help') {
        throw new Error('aide inattendue');
      }
      expect(options.lateForm).toBe(true);
      expect(options.lateFormAmplitude).toBeCloseTo(0.05, 12);
    }

    expect(() => parseSuspenseAuditArgs(['--late-form-amplitude=0'])).toThrow(RangeError);
    expect(() => parseSuspenseAuditArgs(['--late-form-amplitude=abc'])).toThrow(RangeError);

    // Rampe « plus tardive » : 100 % à 50 s.
    const ramp = parseSuspenseAuditArgs(['--late-form-full-s=50']);
    expect(ramp).not.toBe('help');
    if (ramp === 'help') {
      throw new Error('aide inattendue');
    }
    expect(ramp.lateForm).toBe(true);
    expect(ramp.lateFormFullS).toBe(50);
    const defaultsRamp = parseSuspenseAuditArgs(['--late-form']);
    expect(defaultsRamp).not.toBe('help');
    if (defaultsRamp === 'help') {
      throw new Error('aide inattendue');
    }
    expect(defaultsRamp.lateFormFullS).toBe(LATE_FORM_FULL_S);
    expect(() => parseSuspenseAuditArgs(['--late-form-full-s=40'])).toThrow(RangeError);
    expect(() => parseSuspenseAuditArgs(['--late-form-full-s=abc'])).toThrow(RangeError);

    // Enveloppe complète : plateau jusqu'à 55 s, retour exact à 0 % à 60 s.
    const envelope = parseSuspenseAuditArgs([
      '--late-form',
      '--late-form-amplitude=16',
      '--late-form-full-s=50',
      '--late-form-fall-s=55',
      '--late-form-end-s=60',
    ]);
    expect(envelope).not.toBe('help');
    if (envelope === 'help') {
      throw new Error('aide inattendue');
    }
    expect(envelope.lateFormAmplitude).toBe(0.16);
    expect(envelope.lateFormFullS).toBe(50);
    expect(envelope.lateFormFallS).toBe(55);
    expect(envelope.lateFormEndS).toBe(60);
    const noFall = parseSuspenseAuditArgs(['--late-form']);
    expect(noFall).not.toBe('help');
    if (noFall === 'help') {
      throw new Error('aide inattendue');
    }
    expect(noFall.lateFormFallS).toBeNull();
    expect(noFall.lateFormEndS).toBeNull();
    expect(() => parseSuspenseAuditArgs(['--late-form-fall-s=0'])).toThrow(RangeError);
    expect(() => parseSuspenseAuditArgs(['--late-form-end-s=abc'])).toThrow(RangeError);
  });

  it('refuse une entrée invalide et répond à --help', () => {
    expect(() => parseSuspenseAuditArgs(['--seeds=0'])).toThrow(RangeError);
    expect(() => parseSuspenseAuditArgs(['--seeds=abc'])).toThrow(RangeError);
    expect(() => parseSuspenseAuditArgs(['--reproducibility-seeds=0'])).toThrow(RangeError);
    expect(() => parseSuspenseAuditArgs(['--inconnu'])).toThrow(RangeError);
    expect(parseSuspenseAuditArgs(['--help'])).toBe('help');
  });
});