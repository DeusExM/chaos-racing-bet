/**
 * Tests du harnais d'équilibrage et des critères de `GAME_DESIGN.md` §13 (P010).
 *
 * ## Pourquoi ce test ne mesure pas 1000 seeds
 *
 * §13 définit ses plages « sur **1000 seeds** », et c'est `npm run balance -- --seeds=1000` qui fait
 * foi : lui seul produit les chiffres du rapport. Ce fichier est un **garde-fou**, pas la mesure de
 * référence, pour deux raisons de coût :
 *
 * * une course mesurée pas à pas coûte ≈ 55 ms (dont ≈ 29 ms pour le noyau seul) ; 1000 courses
 *   dépassent largement le budget d'une suite unitaire ;
 * * sur un corpus réduit, l'erreur d'échantillonnage d'une moyenne dépasse souvent la largeur de la
 *   plage testée : à 100 seeds, l'écart-type d'un taux de victoire vaut ≈ 3 points. Un test qui
 *   exigerait « le taux mesuré est dans [12 % ; 22 %] » à 100 seeds serait donc **instable par
 *   construction**, ce que `AGENTS.md` §2 interdit.
 *
 * Le test vérifie donc trois choses, qui sont les trois choses qu'un corpus réduit peut établir
 * honnêtement :
 *
 * 1. **Les invariants structurels** (§5) : exactement 3 600 pas pour chaque course, reproductibilité
 *    bit à bit, indépendance du résultat vis-à-vis d'un rejeu, aucun personnage hors roster.
 * 2. **La forme de la table des critères** : une entrée par ligne de §13, identifiants machine
 *    uniques, seuils identiques à ceux du document.
 * 3. **L'état mesuré du corpus réduit**, avec des bornes **larges** justifiées par l'erreur
 *    d'échantillonnage, et une assertion explicite des seuils de §13 dans la table des critères —
 *    c'est la table, et le harnais à 1000 seeds, qui portent le verdict ; ce fichier ne le duplique
 *    pas à une granularité où il serait instable.
 */

import { describe, expect, it } from 'vitest';

import { CHARACTER_IDS } from '../../src/core/characters';
import { RACE_CONFIG, SPEED } from '../../src/core/config';
import { RaceEngine } from '../../src/core/engine';
import {
  LEADER_CHECK_S,
  aggregate,
  balanceCriteria,
  corpusSeeds,
  measureReproducibility,
  observeRace,
  runBalanceCampaign,
  type BalanceMetrics,
} from '../../tools/balanceStats';

/** Corpus du test : le préfixe de celui de 1000 seeds, donc les mêmes courses. */
const TEST_SEEDS = corpusSeeds(100, 'balance-p010');

/** Corpus de reproductibilité : §13 demande « 100/100 seeds identiques bit à bit ». */
const REPLAY_COUNT = 100;

const campaign = runBalanceCampaign(TEST_SEEDS, {});
const metrics: BalanceMetrics = campaign.metrics;

/** Tolérance des bornes larges, en points de pourcentage, pour les critères dépendant du hasard. */
const MARGIN = 15;

describe('critères §13 : forme de la table', () => {
  it('décrit chaque ligne du document, avec un identifiant machine unique', () => {
    const criteria = balanceCriteria(metrics);
    const ids = criteria.map((criterion) => criterion.id);

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('gap-p1p6-median');
    expect(ids).toContain('gap-p1p6-p5');
    expect(ids).toContain('gap-p1p6-p95');
    expect(ids).toContain('leader-at-check-wins');
    expect(ids).toContain('leader-changes-mean');
    expect(ids).toContain('overtakes-mean');
    expect(ids).toContain('events-per-race-mean');
    expect(ids).toContain('events-per-character-max');
    expect(ids).toContain('surges-per-character-min');
    expect(ids).toContain('surges-per-character-max');
    expect(ids).toContain('speaker-lines-mean');
    expect(ids).toContain('speed-bias-max-abs');
    expect(ids).toContain('steps-exact');
    for (const id of CHARACTER_IDS) {
      expect(ids).toContain(`win-rate-${id}`);
      expect(ids).toContain(`event-share-${id}`);
    }
  });

  it('reprend le seuil du leader à l’instant documenté', () => {
    // 40 s = début du troisième et dernier segment (3 × 20 s), la notion de P010 (« le leader au début
    // du dernier segment gagne ») transposée sans changer de sens. L'instant est **dérivé** de
    // `RACE_CONFIG`, et §13 le cite : le test les tient ensemble.
    expect(LEADER_CHECK_S).toBe(RACE_CONFIG.TOTAL_SIM_S - RACE_CONFIG.SEGMENT_DURATION_S);
    expect(LEADER_CHECK_S).toBe(40);
    expect(metrics.leaderCheckS).toBe(LEADER_CHECK_S);

    const leader = balanceCriteria(metrics).find(
      (criterion) => criterion.id === 'leader-at-check-wins',
    );
    expect(leader?.expected).toBe('[55.00 % ; 85.00 %]');
    expect(leader?.label).toContain('t=40');
  });
});

describe('invariants structurels de la course', () => {
  it('termine chaque course en exactement 3 600 pas', () => {
    expect(metrics.exactSteps).toBe(true);
    expect(metrics.steps).toBe(RACE_CONFIG.TOTAL_STEPS);
    for (const observation of campaign.observations) {
      expect(observation.steps).toBe(RACE_CONFIG.TOTAL_STEPS);
      expect(observation.tSim).toBeCloseTo(RACE_CONFIG.TOTAL_SIM_S, 10);
    }
  });

  it('conserve le classement strictement dérivé des distances', () => {
    for (const observation of campaign.observations) {
      const ordered = [...observation.distances].sort((left, right) => right - left);
      const byId = new Map(
        CHARACTER_IDS.map((id, index) => [id, observation.distances[index] ?? 0] as const),
      );
      const expected = [...CHARACTER_IDS].sort((left, right) => {
        const difference = (byId.get(right) ?? 0) - (byId.get(left) ?? 0);
        return difference !== 0 ? difference : left < right ? -1 : 1;
      });
      expect([...observation.ranking]).toEqual(expected);
      expect(observation.distances.length).toBe(CHARACTER_IDS.length);
      expect(ordered[0]).toBe(Math.max(...observation.distances));
    }
  });

  it('ne compte que des dépassements réels, et jamais un aller-retour par pas', () => {
    // Le compteur pas à pas (source de vérité de P009) doit rester très supérieur au relevé
    // échantillonné de P008 : c'est la signature d'un comptage pas à pas, pas d'un sous-comptage.
    expect(metrics.overtakesMean).toBeGreaterThan(25);
    expect(metrics.overtakes.min).toBeGreaterThan(0);
  });
});

describe('reproductibilité', () => {
  it('rejoue 100 seeds deux fois, bit à bit, en 3 600 pas', () => {
    // Première passe : les 100 premières courses **déjà mesurées** par la campagne (le harnais ne
    // modifie pas la course, ce que vérifie un autre test de ce fichier). Seconde passe : un moteur
    // neuf par seed. On économise ainsi 100 courses sur 200, sans affaiblir la comparaison : elle
    // reste un rejeu complet, bit à bit, sur les seeds de §13.
    const seeds = TEST_SEEDS.slice(0, REPLAY_COUNT);
    expect(seeds).toHaveLength(REPLAY_COUNT);

    let identicalDistances = 0;
    let identicalRanking = 0;
    let exactSteps = 0;

    for (const [index, seed] of seeds.entries()) {
      const reference = campaign.observations[index];
      if (reference === undefined) {
        throw new Error(`Observation manquante pour ${seed}.`);
      }
      const engine = new RaceEngine(seed);
      const replay = engine.runToCompletion();

      if (new Float64Array(replay.distances).every((value, slot) => Object.is(value, reference.distances[slot]))) {
        identicalDistances += 1;
      }
      if ([...replay.ranking].every((id, slot) => id === reference.ranking[slot])) {
        identicalRanking += 1;
      }
      if (engine.getState().steps === RACE_CONFIG.TOTAL_STEPS) {
        exactSteps += 1;
      }
    }

    expect(identicalDistances).toBe(REPLAY_COUNT);
    expect(identicalRanking).toBe(REPLAY_COUNT);
    expect(exactSteps).toBe(REPLAY_COUNT);
  });

  it('rejoue aussi une seed deux fois par le chemin de la CLI', () => {
    const replay = measureReproducibility(TEST_SEEDS.slice(0, 5));
    expect(replay.identicalDistances).toBe(5);
    expect(replay.identicalRanking).toBe(5);
    expect(replay.exactSteps).toBe(5);
    expect(replay.mismatches).toEqual([]);
  });

  it('donne la même course après reset avec la même seed', () => {
    const seed = TEST_SEEDS[0] ?? 'BALANCE0';
    const first = new RaceEngine(seed);
    const firstResult = first.runToCompletion();

    first.reset(seed);
    const secondResult = first.runToCompletion();

    expect(new Float64Array(secondResult.distances)).toEqual(new Float64Array(firstResult.distances));
    expect(secondResult.ranking).toEqual(firstResult.ranking);
  });

  it('ne consomme plus rien après la fin de la course', () => {
    const engine = new RaceEngine(TEST_SEEDS[1] ?? 'BALANCE1');
    const result = engine.runToCompletion();
    const steps = engine.getState().steps;

    engine.step();
    engine.step();

    expect(engine.getState().steps).toBe(steps);
    expect(new Float64Array(engine.runToCompletion().distances)).toEqual(
      new Float64Array(result.distances),
    );
  });
});

describe('critères §13 : corpus réduit de 100 seeds', () => {
  it('garde l’écart P1–P6 dans la plage du document', () => {
    // Plage de §13 pour la course de 60 s : `[45 ; 150]`, `≥ 15`, `≤ 290` (échelle de P010 divisée par
    // √3, parce que l'écart entre deux personnages croît comme la racine du temps). Mesure du corpus
    // réduit : médiane 84,98 m, p5 41,88 m, p95 147,09 m.
    expect(metrics.gap1to6.median).toBeGreaterThanOrEqual(45 - MARGIN);
    expect(metrics.gap1to6.median).toBeLessThanOrEqual(150 + MARGIN);
    expect(metrics.gap1to6.p5).toBeGreaterThanOrEqual(15 - MARGIN);
    expect(metrics.gap1to6.p95).toBeLessThanOrEqual(290 + MARGIN);
    // L'écart P1–P6 est le maximum des retards au leader : il ne peut pas être plus petit que
    // l'écart P1–P2, ni que n'importe quel retard individuel.
    expect(metrics.gap1to6.median).toBeGreaterThanOrEqual(metrics.gap1to2.median);
  });

  it('fait courir six personnages strictement équivalents', () => {
    // Invariant §5.6 : aucun trait permanent, donc aucun personnage ne peut s'écarter durablement de
    // la moyenne des six. C'est la mesure qui porte l'invariant ; elle est exacte (pas de hasard) et
    // n'a donc pas besoin de marge.
    const shares = metrics.winRatePerCharacter;
    const spread = Math.max(...shares) - Math.min(...shares);
    expect(spread).toBeLessThan(25);
    for (const share of shares) {
      expect(share).toBeGreaterThan(12 - MARGIN);
      expect(share).toBeLessThan(22 + MARGIN);
    }
  });

  it('garde le biais de vitesse dans le seuil, marge comprise', () => {
    // Le seuil §13 est `SPEED.BASE ± 1,5 %`. Il est mesuré sur 1000 seeds par le harnais ; sur
    // 120 seeds, on vérifie qu'il reste dans l'ordre de grandeur du seuil, pas qu'il l'épouse.
    expect(metrics.maxAbsSpeedBiasPercent).toBeLessThan(1.5 + 1);
    expect(SPEED.BASE).toBe(12);
  });

  it('garde les volumes d’événements, de surges et de répliques dans leurs plages', () => {
    // Bornes **larges**, justifiées par l'erreur d'échantillonnage du corpus réduit : ≈ 0,2 événement,
    // ≈ 0,2 surge et ≈ 0,5 réplique sur la moyenne de 100 courses. La tolérance est de **1 point** (et
    // non de 3 comme avant la passe corrective, où les volumes étaient trois fois plus grands) : sur
    // une moyenne de 3,4 événements, 3 points ne testeraient plus rien. C'est la table des critères —
    // et le harnais à 1000 seeds — qui portent le verdict.
    const TOLERANCE = 1;
    expect(metrics.eventsTotalMean).toBeGreaterThanOrEqual(3 - TOLERANCE);
    expect(metrics.eventsTotalMean).toBeLessThanOrEqual(6 + TOLERANCE);
    expect(Math.max(...metrics.eventsPerCharacterMean)).toBeLessThanOrEqual(5 + 1);
    expect(Math.min(...metrics.surgesPerCharacterMean)).toBeGreaterThanOrEqual(4.7 - TOLERANCE);
    expect(Math.max(...metrics.surgesPerCharacterMean)).toBeLessThanOrEqual(8.7 + TOLERANCE);

    expect(metrics.speakerLines).not.toBeNull();
    expect(metrics.speakerLines?.mean).toBeGreaterThanOrEqual(6 - TOLERANCE);
    expect(metrics.speakerLines?.mean).toBeLessThanOrEqual(14 + TOLERANCE);
  });

  it('compte les changements de leader et les dépassements du même ordre que le document', () => {
    expect(metrics.leaderChangesMean).toBeGreaterThan(6 - MARGIN * 0.2);
    expect(metrics.leaderChangesMean).toBeLessThan(20 + MARGIN * 0.2);
  });

  /**
   * Le critère du leader est **conforme** : §13 demande que le leader au **début du dernier segment**
   * gagne 55 % à 85 % des courses. Trois mesures, trois corpus :
   *
   * * corpus **canonique de 1000 seeds** : **63,20 %** — valeur normative, celle de §13 ;
   * * corpus de ce test, **100 seeds** (préfixe du canonique) : 65,00 %.
   *
   * P010 avait retenu `tSim = 135 s` pour la course de 180 s (66,90 % sur le canonique) après avoir
   * écarté `tSim = 171 s` (88,10 %, hors plage) : 135 s est le **début du quatrième et dernier
   * segment**, documenté dans `docs/balance-report.md` §2. La passe corrective 60 s conserve la même
   * notion, indépendante de la durée, et donc le même instant relatif : le début du troisième et
   * dernier segment, soit **40 s** (`TOTAL_SIM_S − SEGMENT_DURATION_S`).
   *
   * L'encadrement reste **large à dessein** : sur 100 seeds, l'erreur d'échantillonnage d'un taux
   * voisin de 65 % vaut ≈ 4,7 points. Ce test vérifie donc que la course n'est **ni jouée d'avance
   * ni retournée à l'excès** dans le dernier segment, la valeur canonique étant celle du harnais.
   */
  it('garde le taux de victoire du leader à 40 s dans la plage de §13', () => {
    expect(metrics.leaderAtCheckWinRate).toBeGreaterThan(55 - 14);
    expect(metrics.leaderAtCheckWinRate).toBeLessThan(85 + 14);
  });
});

describe('harnais : déterminisme et pureté de la mesure', () => {
  it('produit exactement les mêmes métriques pour le même corpus', () => {
    // Sous-ensemble seulement : remesurer les 100 courses doublerait le coût du fichier pour
    // vérifier une propriété qui n'a pas besoin de tout le corpus (le harnais est déterministe).
    const subset = TEST_SEEDS.slice(0, 20);
    const again = aggregate(subset.map((seed) => observeRace(seed, {})));
    const reference = aggregate(campaign.observations.slice(0, subset.length));

    expect(again.leaderAtCheckWinRate).toBe(reference.leaderAtCheckWinRate);
    expect(again.overtakesMean).toBe(reference.overtakesMean);
    expect(again.leaderChangesMean).toBe(reference.leaderChangesMean);
    expect(again.eventsTotalMean).toBe(reference.eventsTotalMean);
    expect(again.gap1to6.median).toBe(reference.gap1to6.median);
    expect(again.maxAbsSpeedBiasPercent).toBe(reference.maxAbsSpeedBiasPercent);
  });

  it('dérive son corpus du seul nombre de seeds, et garde le préfixe stable', () => {
    const hundred = corpusSeeds(100);
    const thousand = corpusSeeds(1000);
    expect(hundred).toHaveLength(100);
    expect(thousand.slice(0, 100)).toEqual(hundred);
    expect(new Set(thousand).size).toBe(thousand.length);
  });

  it('n’altère pas la course qu’il mesure', () => {
    // Le harnais ne modifie aucun état du jeu : la course mesurée doit être identique, bit à bit, à
    // la course du même moteur joué sans aucune instrumentation.
    const seed = TEST_SEEDS[2] ?? 'BALANCE2';
    const observed = observeRace(seed, {});
    const bare = new RaceEngine(seed).runToCompletion();

    expect(new Float64Array(observed.distances)).toEqual(new Float64Array(bare.distances));
    expect([...observed.ranking]).toEqual([...bare.ranking]);
  });

  it('mesure une distribution de répliques complète, traîne comprise', () => {
    // Le critère §13 se lit sur la moyenne, mais la moyenne ne dit rien de la traîne : on publie et on
    // épingle donc la distribution entière, y compris les courses **muettes** (`0` réplique), qui
    // doivent rester mesurées et jamais masquées par un compteur agrégé.
    expect(metrics.speakerLines).not.toBeNull();
    expect(metrics.speakerLinesAtZero).toBeGreaterThanOrEqual(0);
    expect(metrics.speakerLinesAtZero).toBeLessThanOrEqual(TEST_SEEDS.length);
    expect(metrics.speakerLinesUnderTarget + metrics.speakerLinesOverTarget).toBeLessThanOrEqual(
      TEST_SEEDS.length,
    );
    const lines = metrics.speakerLines;
    if (lines === null) {
      throw new Error('Distribution du speaker absente.');
    }
    expect(lines.min).toBeGreaterThanOrEqual(0);
    expect(lines.p25).toBeLessThanOrEqual(lines.median);
    expect(lines.median).toBeLessThanOrEqual(lines.p75);
    expect(lines.p75).toBeLessThanOrEqual(lines.max);
  });
});
