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
