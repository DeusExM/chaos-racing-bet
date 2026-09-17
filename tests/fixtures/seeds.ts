import { CHARACTER_IDS } from '../../src/core/characters';
import { RaceEngine } from '../../src/core/engine';
import { OvertakeTracker } from '../../src/core/overtakes';
import { computeRanks, isLeaderChange } from '../../src/core/ranking';

/**
 * Seeds **mesurées** et partagées entre les tests unitaires et les tests E2E.
 *
 * Elles ne sont jamais choisies « au feeling » : chacune est retenue après mesure de plusieurs
 * candidates, et la mesure est vérifiée par un test unitaire. Si une évolution du noyau change ces
 * valeurs, c'est un signal explicite — il faut alors décider consciemment de conserver la seed ou
 * d'en choisir une autre, jamais corriger le chiffre en silence (AGENTS §2).
 */

/**
 * Seed retenue pour les tests de mouvement et de dépassement.
 *
 * Mesurée parmi 24 candidates en P004 : c'est celle qui produisait le plus de changements de leader
 * et de dépassements, à toutes les granularités d'observation testées. Une course à une douzaine de
 * changements de leader est exactement ce que le jeu cherche : imprévisible, sans qu'aucun
 * personnage ne soit avantagé.
 */
export const OVERTAKE_SEED = 'POULET42';

/**
 * Valeurs **remesurées** pour `OVERTAKE_SEED`, dernière fois en P010.
 *
 * P010 a changé une constante du catalogue d'événements (magnitudes de bonus réduites de 35 %) et a
 * fait un aller-retour sur le taux de §7.3 (`1/14` → `1/10` → `1/14`) : la seed est conservée, la
 * mesure est refaite. Le comptage alimente un `OvertakeTracker` **à chaque pas simulé**, ce qui est la
 * source de vérité de P009. Les chiffres de P008 (14 changements / 32 dépassements pour un relevé tous
 * les 20 pas, et 0 dépassement pas à pas) sont périmés depuis P009 : ils mesuraient l'ancien couplage,
 * pas la course. La seed reste très largement au-dessus des minima exigés par les tests E2E.
 */
export const OVERTAKE_SEED_EVIDENCE = Object.freeze({
  leaderChanges: 16,
  overtakes: 81,
});

/**
 * Seed dont l'arrivée est une **photo finish** (P013).
 *
 * Mesurée sur le corpus canonique de 600 seeds de `tests/unit/observerSeeds.test.ts` : 49 courses
 * (≈ 8 %) produisent réellement `PHOTO_FINISH`, et celle-ci a été retenue pour son écart P1–P2 très
 * serré mais non dégénéré. Aucun gameplay n'a été modifié pour l'obtenir : c'est une course normale
 * du noyau, et `tests/unit/finishModel.test.ts` revérifie l'évidence ci-dessous à chaque exécution.
 */
export const PHOTO_FINISH_SEED = 'SRS47J58';

/** Évidence mesurée pour `PHOTO_FINISH_SEED`, au pas `10800`. */
export const PHOTO_FINISH_SEED_EVIDENCE = Object.freeze({
  /** Écart P1–P2, en mètres, tel que l'observateur l'a mesuré. */
  gapMeters: 0.43817919997081844,
  /** Vainqueur et deuxième, dans l'ordre du fait d'arrivée. */
  leader: 'c3',
  second: 'c4',
});

/** Évidence mesurée pour `OVERTAKE_SEED` : son arrivée **n'est pas** une photo finish. */
export const OVERTAKE_SEED_ARRIVAL = Object.freeze({
  type: 'FINISH',
  /** Écart P1–P2, en mètres : très au-dessus du seuil de photo finish du design. */
  gapMeters: 62.93463710859123,
});

/** Fait d'arrivée (`FINISH` ou `PHOTO_FINISH`) d'une course, mesuré pas à pas par le noyau. */
export function arrivalFactOf(seed: string): {
  readonly type: string;
  readonly gapMeters: number;
  readonly characterIds: readonly string[];
  readonly stepCount: number;
  readonly tSim: number;
} {
  const engine = new RaceEngine(seed);
  const result = engine.runToCompletion();
  const arrival = engine
    .drainFacts()
    .find((fact) => fact.type === 'FINISH' || fact.type === 'PHOTO_FINISH');

  if (arrival === undefined) {
    throw new Error(`Aucun fait d'arrivée pour la seed ${seed}.`);
  }

  return {
    type: arrival.type,
    gapMeters: arrival.magnitudes[0] ?? Number.NaN,
    characterIds: arrival.characterIds,
    stepCount: engine.getState().steps,
    tSim: result.tSim,
  };
}

export interface OvertakeMeasurement {
  readonly steps: number;
  readonly leaderChanges: number;
  readonly overtakes: number;
}

/**
 * Compte les changements de leader et les dépassements d'une course, **pas à pas**.
 *
 * Le détecteur est alimenté après chaque `step()` : c'est la granularité de P009, indépendante du
 * rendu, du `timeScale` et du nombre d'images par seconde.
 */
export function measureOvertakes(seed: string): OvertakeMeasurement {
  return measureObservedOvertakes(seed, 1);
}

/**
 * Même mesure, mais en n'alimentant le détecteur qu'un pas sur `granularitySteps`.
 *
 * Sert uniquement à **documenter** la robustesse du détecteur à une observation plus grossière
 * (celle du rendu) : deux relevés rapprochés peuvent manquer un aller-retour très rapide, donc cette
 * mesure n'est jamais la source de vérité — P009 observera chaque pas simulé.
 */
export function measureSampledOvertakes(seed: string, granularitySteps: number): OvertakeMeasurement {
  if (!Number.isInteger(granularitySteps) || granularitySteps < 1) {
    throw new RangeError(`granularitySteps doit être un entier supérieur ou égal à 1 (reçu : ${granularitySteps}).`);
  }

  return measureObservedOvertakes(seed, granularitySteps);
}

function measureObservedOvertakes(seed: string, granularitySteps: number): OvertakeMeasurement {
  const engine = new RaceEngine(seed);
  const tracker = new OvertakeTracker();
  const ids = CHARACTER_IDS;
  const distances = (): number[] => engine.getState().characters.map((character) => character.x);

  let previousRanks = computeRanks(distances(), ids);
  let leaderChanges = 0;
  let overtakes = 0;
  let steps = 0;

  while (engine.getState().phase.kind !== 'finished') {
    engine.step();
    steps += 1;

    const xs = distances();

    if (steps % granularitySteps !== 0) {
      continue;
    }

    overtakes += tracker.observe(xs, ids).length;

    const ranks = computeRanks(xs, ids);
    if (isLeaderChange(previousRanks, ranks)) {
      leaderChanges += 1;
    }
    previousRanks = ranks;
  }

  return { steps, leaderChanges, overtakes };
}
