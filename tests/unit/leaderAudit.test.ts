/**
 * Tests de l'audit des leaders aux bornes (`tools/leaderAudit.ts`).
 *
 * ## Ce que ce fichier teste, et pourquoi il est **synthétique**
 *
 * Le corpus de référence (10 000 seeds) est mesuré par `npm run balance:leaders` : une suite unitaire
 * ne peut pas le rejouer. Ce fichier vérifie donc ce qui est vérifiable vite et sans ambiguïté :
 *
 * 1. les **bornes** viennent de `RACE_CONFIG`, jamais d'une valeur recopiée ;
 * 2. une course réelle donne bien trois leaders, un vainqueur, `3600` pas et `60 s`, et le suivi pas
 *    à pas **concorde** avec le classement officiel ;
 * 3. les **maths statistiques** sont justes : χ² d'uniformité, z, matrices de transition, corrélation,
 *    détection d'un corpus dégénéré — sur des corpus **construits à la main**, donc sans aucune
 *    variabilité d'échantillonnage ;
 * 4. les **flux RNG** sont indépendants (structurellement et comportementalement) ;
 * 5. la **conclusion** ne signale une anomalie que sur une anomalie structurelle réelle.
 *
 * Aucune assertion ne porte sur une part mesurée à petit N : ces valeurs-là appartiennent au rapport
 * du corpus complet, pas à un test qui deviendrait instable (`AGENTS.md` §2).
 */

import { describe, expect, it } from 'vitest';

import { CHARACTER_IDS } from '../../src/core/characters';
import { RACE_CONFIG } from '../../src/core/config';
import type { CharacterId } from '../../src/core/types';
import {
  AUDIT_REFERENCES,
  LEADER_BOUNDS_S,
  LEADER_BOUND_LABELS,
  RNG_STREAM_LABELS,
  auditRace,
  auditRngStreams,
  buildLeaderAuditJson,
  characterShares,
  conclusionLines,
  corpusCheck,
  correlation,
  parseLeaderAuditArgs,
  renderLeaderAuditText,
  summarizeLeaderAudit,
  transitionMatrix,
  uniformityChiSquare,
  type LeaderAuditRace,
} from '../../tools/leaderAudit';
import { corpusSeeds } from '../../tools/balanceStats';

/** Course synthétique : distances croissantes, leader placé dans la voie voulue. */
function syntheticRace(seed: string, leaders: readonly CharacterId[], index: number): LeaderAuditRace {
  const winner = leaders[leaders.length - 1];
  if (winner === undefined) {
    throw new RangeError('syntheticRace : au moins un leader est requis.');
  }
  const winnerSlot = CHARACTER_IDS.indexOf(winner);
  const distances = CHARACTER_IDS.map((_id, slot) =>
    slot === winnerSlot ? 1_000 + index : index + slot,
  );
  return {
    seed,
    leaders,
    winner,
    leaderChanges: 0,
    distinctLeaders: new Set(leaders).size,
    distances,
    leaderConsistent: true,
    steps: RACE_CONFIG.TOTAL_STEPS,
    tSim: RACE_CONFIG.TOTAL_SIM_S,
  };
}

describe('bornes de l’audit', () => {
  it('dérive les bornes du noyau au lieu de les recopier', () => {
    expect(LEADER_BOUNDS_S).toEqual([
      RACE_CONFIG.SEGMENT_DURATION_S,
      2 * RACE_CONFIG.SEGMENT_DURATION_S,
      RACE_CONFIG.TOTAL_SIM_S,
    ]);
    // Trois segments ⇒ deux bornes intermédiaires, puis l'arrivée : il n'existe pas de « checkpoint 3 ».
    expect(LEADER_BOUNDS_S).toHaveLength(RACE_CONFIG.SEGMENT_COUNT);
    expect(LEADER_BOUNDS_S[LEADER_BOUNDS_S.length - 1]).toBe(RACE_CONFIG.TOTAL_SIM_S);
    expect(LEADER_BOUND_LABELS).toEqual(['20 s', '40 s', '60 s']);
  });
});

describe('course auditée', () => {
  it('relève trois leaders, le vainqueur et les compteurs de la course', () => {
    const race = auditRace('KR7Z8NAR');

    expect(race.steps).toBe(RACE_CONFIG.TOTAL_STEPS);
    expect(race.tSim).toBe(RACE_CONFIG.TOTAL_SIM_S);
    expect(race.leaders).toHaveLength(LEADER_BOUNDS_S.length);
    for (const leader of race.leaders) {
      expect(CHARACTER_IDS).toContain(leader);
    }
    expect(race.leaders[race.leaders.length - 1]).toBe(race.winner);
    expect(CHARACTER_IDS).toContain(race.winner);
    expect(race.distances).toHaveLength(CHARACTER_IDS.length);

    // Le nombre de leaders distincts est exactement celui des trois bornes…
    expect(race.distinctLeaders).toBe(new Set(race.leaders).size);
    expect(race.distinctLeaders).toBeGreaterThanOrEqual(1);
    expect(race.distinctLeaders).toBeLessThanOrEqual(LEADER_BOUNDS_S.length);

    // …et le suivi pas à pas du leader doit concorder avec le classement officiel (`computeRanks`).
    expect(race.leaderConsistent).toBe(true);
  });

  it('donne exactement le même résultat quand la course est rejouée', () => {
    const first = auditRace('KR7Z8NAR');
    const second = auditRace('KR7Z8NAR');
    expect(second).toEqual(first);
  });
});

describe('parts par personnage', () => {
  it('ne trouve rien à redire à une répartition exactement uniforme', () => {
    const counts = new Array<number>(CHARACTER_IDS.length).fill(600);
    const shares = characterShares(counts, 3_600);

    expect(shares.chiSquare).toBeCloseTo(0, 10);
    expect(shares.uniform).toBe(true);
    expect(shares.beyondChance).toBe(false);
    expect(shares.anyOutlier).toBe(false);
    expect(shares.degreesOfFreedom).toBe(CHARACTER_IDS.length - 1);
    for (const share of shares.shares) {
      expect(share).toBeCloseTo(100 / CHARACTER_IDS.length, 10);
    }
    for (const deviation of shares.deviations) {
      expect(deviation).toBeCloseTo(0, 10);
    }
  });

  it('signale une part hors du hasard, avec le personnage concerné', () => {
    const counts = [2_000, 320, 320, 320, 320, 320];
    const shares = characterShares(counts, 3_600);

    expect(shares.chiSquare).toBeGreaterThan(shares.criticalChiSquare01);
    expect(shares.uniform).toBe(false);
    expect(shares.beyondChance).toBe(true);
    expect(shares.anyOutlier).toBe(true);
    expect(shares.maxAbsZCharacter).toBe(CHARACTER_IDS[0]);
    expect(shares.maxAbsZ).toBeGreaterThan(shares.zThreshold);
    expect(shares.deviations[0] ?? 0).toBeGreaterThan(0);
    expect(shares.deviations[1] ?? 0).toBeLessThan(0);
  });

  it('refuse un total nul plutôt que de diviser par zéro', () => {
    expect(() => characterShares([0, 0, 0, 0, 0, 0], 0)).toThrow(RangeError);
  });
});

describe('matrices de transition', () => {
  it('mesure une persistance parfaite, qui est une dépendance maximale', () => {
    // Dix courses par personnage, chacune conservant son leader : la diagonale est pleine.
    const races: LeaderAuditRace[] = [];
    for (const id of CHARACTER_IDS) {
      for (let index = 0; index < 10; index += 1) {
        races.push(syntheticRace(`${id}-${String(index)}`, [id, id, id], races.length));
      }
    }
    const matrix = transitionMatrix(races, 0, 1);

    expect(matrix.persistencePercent).toBe(100);
    for (const [row, values] of matrix.counts.entries()) {
      expect(values[row]).toBe(10);
      expect(matrix.rowTotals[row]).toBe(10);
      expect(matrix.columnTotals[row]).toBe(10);
      // Aucune transition hors diagonale.
      expect(values.reduce((sum, value) => sum + value, 0)).toBe(10);
    }
    expect(matrix.independent).toBe(false);
    expect(matrix.degreesOfFreedom).toBe((CHARACTER_IDS.length - 1) ** 2);
  });

  it('mesure une indépendance parfaite quand tous les enchaînements sont équiprobables', () => {
    // Les 36 couples (leader 20 s, leader 40 s), une fois chacun : chaque ligne a exactement un tirage
    // par colonne, donc les deux bornes sont indépendantes.
    const races: LeaderAuditRace[] = [];
    for (const from of CHARACTER_IDS) {
      for (const to of CHARACTER_IDS) {
        races.push(syntheticRace(`${from}-${to}`, [from, to, to], races.length));
      }
    }
    const matrix = transitionMatrix(races, 0, 1);

    expect(matrix.persistencePercent).toBeCloseTo(100 / CHARACTER_IDS.length, 10);
    expect(matrix.chiSquareIndependence).toBeCloseTo(0, 10);
    expect(matrix.independent).toBe(true);
  });
});

describe('contrôles de corpus', () => {
  it('accepte un corpus dont toutes les courses diffèrent', () => {
    const races = CHARACTER_IDS.map((id, index) =>
      syntheticRace(`seed-${String(index)}`, [id, id, id], index),
    );
    const check = corpusCheck(races);

    expect(check.seeds).toBe(CHARACTER_IDS.length);
    expect(check.distinctSeeds).toBe(CHARACTER_IDS.length);
    expect(check.distinctDistanceVectors).toBe(CHARACTER_IDS.length);
    expect(check.allRacesDistinct).toBe(true);
    expect(check.exactSteps).toBe(true);
    expect(check.finishedAtTotalSimS).toBe(true);
    expect(check.leaderConsistentEverywhere).toBe(true);
  });

  it('détecte un corpus dégénéré (deux seeds, la même course)', () => {
    const first = syntheticRace('seed-a', ['c0', 'c0', 'c0'], 0);
    const second = syntheticRace('seed-b', ['c0', 'c0', 'c0'], 0);
    const check = corpusCheck([first, second]);

    expect(check.distinctSeeds).toBe(2);
    expect(check.distinctDistanceVectors).toBe(1);
    expect(check.allRacesDistinct).toBe(false);
  });

  it('détecte une divergence entre le suivi pas à pas et le classement officiel', () => {
    const broken: LeaderAuditRace = {
      ...syntheticRace('seed-x', ['c0', 'c0', 'c0'], 0),
      leaderConsistent: false,
    };
    expect(corpusCheck([broken]).leaderConsistentEverywhere).toBe(false);
  });
});

describe('outils statistiques', () => {
  it('calcule une corrélation de Pearson, y compris sur une série constante', () => {
    const series = [1, 2, 3, 4, 5];
    expect(correlation(series, series)).toBeCloseTo(1, 12);
    expect(correlation(series, [5, 4, 3, 2, 1])).toBeCloseTo(-1, 12);
    // Une série constante n'a pas de variance : la corrélation est indéfinie, donc rendue nulle.
    expect(correlation(series, [1, 1, 1, 1, 1])).toBe(0);
    expect(() => correlation(series, [1, 2, 3])).toThrow(RangeError);
  });

  it('calcule un χ² d’uniformité nul sur une série parfaitement répartie', () => {
    const values = Array.from({ length: 10 }, (_value, index) => (index + 0.5) / 10);
    expect(uniformityChiSquare(values)).toBeCloseTo(0, 10);
    // Vingt classes pour vingt valeurs : une par classe, donc toujours parfaitement uniforme.
    const wider = Array.from({ length: 20 }, (_value, index) => (index + 0.5) / 20);
    expect(uniformityChiSquare(wider, 20)).toBeCloseTo(0, 10);
    // Une classe vide et une classe double s'écartent, elles, de l'uniformité.
    expect(uniformityChiSquare([...values, 0.05])).toBeGreaterThan(0);
  });
});

describe('flux RNG', () => {
  it('vérifie l’indépendance des streams et leur usage par le moteur', () => {
    const seeds = corpusSeeds(120, 'audit-unit');
    const rng = auditRngStreams(seeds, { behaviorSeeds: 40 });

    expect(rng.labels).toHaveLength(RNG_STREAM_LABELS.length);
    expect(rng.labels).toEqual(RNG_STREAM_LABELS);
    expect(rng.samplesPerStream).toBe(seeds.length);
    // Aucun flux partagé, aucune corrélation hors du hasard, tous uniformes.
    expect(rng.identicalSequencePairs).toEqual([]);
    expect(rng.maxAbsCorrelation).toBeLessThan(rng.correlationThreshold);
    expect(rng.uniformityAnomalies).toEqual([]);
    expect(rng.independentConsumption).toBe(true);
    // Les tirages ne se répètent pas d'une seed à l'autre.
    for (const label of RNG_STREAM_LABELS) {
      expect(rng.distinctFirstDraws[label] ?? 0).toBeGreaterThan(seeds.length * 0.9);
    }
    // Et le moteur consomme bien un flux par personnage : les dérives ne sont pas corrélées.
    expect(rng.engineDriftStreamsDistinct).toBe(true);
    expect(rng.driftWorstZ).toBeLessThan(rng.driftZThreshold);
    expect(rng.engineSurgeStreamsDistinct).toBe(true);
    expect(rng.everyCharacterSurged).toBe(true);
  });

  it('refuse un corpus vide', () => {
    expect(() => auditRngStreams([])).toThrow(RangeError);
  });
});

describe('synthèse et rapports', () => {
  /** Corpus uniforme : chaque personnage mène les trois bornes cent fois. */
  function uniformRaces(perCharacter: number): readonly LeaderAuditRace[] {
    const races: LeaderAuditRace[] = [];
    for (const id of CHARACTER_IDS) {
      for (let index = 0; index < perCharacter; index += 1) {
        races.push(syntheticRace(`${id}-${String(index)}`, [id, id, id], races.length));
      }
    }
    return races;
  }

  it('ne conclut à aucune anomalie quand tout est propre', () => {
    const races = uniformRaces(100);
    const rng = auditRngStreams(corpusSeeds(40, 'audit-unit'), { behaviorSeeds: 40 });
    const summary = summarizeLeaderAudit(races, { rng });
    const conclusion = conclusionLines(summary);

    expect(summary.seeds).toBe(races.length);
    expect(summary.sameLeaderAllBoundsPercent).toBe(100);
    expect(summary.exactlyTwoLeadersPercent).toBe(0);
    expect(summary.threeDistinctLeadersPercent).toBe(0);
    expect(summary.leaderChangesMean).toBe(0);
    expect(summary.winnerShares.chiSquare).toBeCloseTo(0, 8);
    expect(conclusion[0] ?? '').toContain('Aucune anomalie structurelle');
  });

  it('signale un stream RNG partagé et ne le confond pas avec du hasard', () => {
    const races = uniformRaces(20);
    const rng = auditRngStreams(corpusSeeds(40, 'audit-unit'), { behaviorSeeds: 40 });
    const summary = summarizeLeaderAudit(races, {
      rng: { ...rng, identicalSequencePairs: ['drift:c0 = drift:c1'] },
    });
    const conclusion = conclusionLines(summary);

    expect(conclusion[0] ?? '').toContain('Anomalies structurelles');
    expect(conclusion.join('\n')).toContain('drift:c0 = drift:c1');
  });

  it('signale un corpus dégénéré', () => {
    const rng = auditRngStreams(corpusSeeds(40, 'audit-unit'), { behaviorSeeds: 40 });
    const races = [
      syntheticRace('a', ['c0', 'c0', 'c0'], 0),
      syntheticRace('b', ['c0', 'c1', 'c0'], 1),
    ];
    const duplicated = summarizeLeaderAudit(
      [syntheticRace('a', ['c0', 'c0', 'c0'], 0), syntheticRace('b', ['c0', 'c0', 'c0'], 0)],
      { rng },
    );

    // Le corpus synthétique est trop petit pour un χ² exploitable : seule la dégénérescence est testée.
    expect(summarizeLeaderAudit(races, { rng }).corpus.allRacesDistinct).toBe(true);
    expect(conclusionLines(duplicated).join('\n')).toContain('corpus dégénéré');
  });

  it('rend un rapport texte et un rapport structuré cohérents', () => {
    const races = uniformRaces(50);
    const rng = auditRngStreams(corpusSeeds(40, 'audit-unit'), { behaviorSeeds: 40 });
    const summary = summarizeLeaderAudit(races, {
      rng,
      reproducibility: { seeds: 100, identical: 100 },
    });
    const text = renderLeaderAuditText(summary, 1_234);
    const report = buildLeaderAuditJson(summary, 1_234);

    expect(text).toContain('audit des leaders aux bornes');
    expect(text).toContain('=== Comparaison aux références 60 s');
    expect(text).toContain('Reproductibilité bit à bit');
    // Les bornes citées dans le rapport sont celles du noyau.
    for (const label of LEADER_BOUND_LABELS) {
      expect(text).toContain(label);
    }
    expect(JSON.stringify(report)).toContain('chaos-race-leader-audit');
    // Le rapport ne recopie pas de règle de jeu : il ne fait que mesurer.
    expect(AUDIT_REFERENCES.leaderChangesMean).toBeCloseTo(8.308, 3);
  });
});

describe('ligne de commande', () => {
  it('applique les valeurs par défaut', () => {
    const options = parseLeaderAuditArgs([]);
    expect(options).not.toBe('help');
    if (options === 'help') {
      throw new Error('aide inattendue');
    }
    expect(options.seeds).toBe(10_000);
    expect(options.referenceSeeds).toBe(1_000);
    expect(options.replayCheck).toBe(true);
    expect(options.jsonPath).toContain('.tmp/');
  });

  it('lit les options explicites', () => {
    const options = parseLeaderAuditArgs([
      '--seeds=250',
      '--reference-seeds=200',
      '--behavior-seeds=10',
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
    expect(options.referenceSeeds).toBe(200);
    expect(options.behaviorSeeds).toBe(10);
    expect(options.corpusPrefix).toBe('autre');
    expect(options.jsonPath).toBe('x.json');
    expect(options.textPath).toBe('x.txt');
    expect(options.replayCheck).toBe(false);
  });

  it('refuse une entrée invalide et répond à --help', () => {
    expect(() => parseLeaderAuditArgs(['--seeds=0'])).toThrow(RangeError);
    expect(() => parseLeaderAuditArgs(['--seeds=abc'])).toThrow(RangeError);
    expect(() => parseLeaderAuditArgs(['--inconnu'])).toThrow(RangeError);
    expect(parseLeaderAuditArgs(['--help'])).toBe('help');
  });
});
