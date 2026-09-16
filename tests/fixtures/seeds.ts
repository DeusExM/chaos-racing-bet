import { CHARACTER_IDS } from '../../src/core/characters';
import { RaceEngine } from '../../src/core/engine';
import { computeRanks, isLeaderChange, overtakesBetween } from '../../src/core/ranking';

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
 * Valeurs **remesurées** pour `OVERTAKE_SEED` après le correctif de P008 (rejet d'un candidat tombé
 * pendant un cooldown).
 *
 * Ce correctif change la course de cette seed comme l'activation des événements l'avait fait : les
 * deux chiffres passent de 16 changements de leader / 38 dépassements à 14 / 32. La seed est
 * conservée — elle reste très largement au-dessus des minima exigés par les tests E2E (1 changement de
 * leader, 3 dépassements), et la remplacer romprait la continuité des captures E2E sans rien apporter.
 *
 * À savoir : ce comptage dépend de la **fréquence d'observation** (`OVERTAKE.MIN_MARGIN` vaut plus
 * qu'un pas de course, donc observer pas à pas ne compte aucun dépassement). Ce couplage est
 * documenté et testé dans `tests/unit/raceSeeds.test.ts` ; il doit être tranché avant P009.
 */
export const OVERTAKE_SEED_EVIDENCE = Object.freeze({
  /** 20 pas par frame = `timeScale 20` observé à 60 images par seconde. */
  granularitySteps: 20,
  leaderChanges: 14,
  overtakes: 32,
});

export interface OvertakeMeasurement {
  readonly steps: number;
  readonly leaderChanges: number;
  readonly overtakes: number;
}

/**
 * Compte les changements de leader et les dépassements d'une course complète.
 *
 * `granularitySteps` reproduit la fréquence à laquelle un observateur regarde la course : `1` pour
 * un examen pas à pas, `20` pour une frame en `timeScale = 20`. Cette précision est essentielle,
 * car `overtakesBetween` exige que le dépassement soit **établi** de plus de
 * `OVERTAKE.MIN_MARGIN` mètres entre deux relevés (voir le test qui documente ce point).
 */
export function measureOvertakes(seed: string, granularitySteps: number): OvertakeMeasurement {
  const engine = new RaceEngine(seed);
  const ids = CHARACTER_IDS;
  const distances = (): number[] => engine.getState().characters.map((character) => character.x);

  let previousRanks = computeRanks(distances(), ids);
  let leaderChanges = 0;
  let overtakes = 0;
  let steps = 0;

  while (engine.getState().phase.kind !== 'finished') {
    engine.step();
    steps += 1;
    if (steps % granularitySteps !== 0) {
      continue;
    }

    const xs = distances();
    const ranks = computeRanks(xs, ids);
    if (isLeaderChange(previousRanks, ranks)) {
      leaderChanges += 1;
    }
    overtakes += overtakesBetween(previousRanks, ranks, xs, ids).length;
    previousRanks = ranks;
  }

  return { steps, leaderChanges, overtakes };
}
