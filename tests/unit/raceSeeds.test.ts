import { describe, expect, it } from 'vitest';

import { RACE_CONFIG, SPEED } from '../../src/core/config';
import { OVERTAKE } from '../../src/core/config';
import {
  OVERTAKE_SEED,
  OVERTAKE_SEED_EVIDENCE,
  measureOvertakes,
} from '../fixtures/seeds';

/**
 * Vérifie la seed retenue par les tests E2E de mouvement et de dépassement.
 *
 * Sans ce test, la seed du test E2E serait un nombre choisi arbitrairement, et personne ne saurait
 * pourquoi elle l'a été. Ici, la raison est mesurée, chiffrée, et vérifiée à chaque exécution.
 */
describe('seed retenue pour les tests de dépassement', () => {
  const evidence = OVERTAKE_SEED_EVIDENCE;

  it('produit exactement la course mesurée lors du choix', () => {
    const measured = measureOvertakes(OVERTAKE_SEED, evidence.granularitySteps);

    expect(measured.steps).toBe(RACE_CONFIG.TOTAL_STEPS);
    expect(measured.leaderChanges).toBe(evidence.leaderChanges);
    expect(measured.overtakes).toBe(evidence.overtakes);
  });

  it('dépasse largement le minimum exigé par le test E2E', () => {
    const measured = measureOvertakes(OVERTAKE_SEED, evidence.granularitySteps);

    expect(measured.leaderChanges).toBeGreaterThanOrEqual(1);
    expect(measured.overtakes).toBeGreaterThanOrEqual(3);
  });

  it('reste exploitable même si le navigateur échantillonne deux fois plus grossièrement', () => {
    // Un navigateur à 30 images par seconde observe un pas sur 40, pas un pas sur 20.
    const coarse = measureOvertakes(OVERTAKE_SEED, evidence.granularitySteps * 2);
    expect(coarse.overtakes).toBeGreaterThanOrEqual(3);
    expect(coarse.leaderChanges).toBeGreaterThanOrEqual(1);
  });

  it('documente le couplage entre la marge de dépassement et la fréquence d’observation', () => {
    // `overtakesBetween` ne compte un dépassement que si le nouvel arrivant mène de plus de
    // `OVERTAKE.MIN_MARGIN` mètres au moment du relevé. Or à la vitesse de base, un pas ne fait
    // avancer que de `SPEED.BASE × DT_S` mètres : cette distance est INFÉRIEURE à la marge.
    const stepDistance = SPEED.BASE * RACE_CONFIG.DT_S;
    expect(stepDistance).toBeLessThan(OVERTAKE.MIN_MARGIN);

    // Conséquence mesurée : en observant pas à pas, cette seed ne produit aucun dépassement compté,
    // alors qu'elle en produit 22 en observant frame par frame. Le nombre de dépassements dépend
    // donc de la fréquence d'observation, ce qui devra être tranché quand le speaker s'appuiera
    // dessus (P007+).
    expect(measureOvertakes(OVERTAKE_SEED, 1).overtakes).toBe(0);
    expect(measureOvertakes(OVERTAKE_SEED, 20).overtakes).toBeGreaterThan(0);
  });
});
