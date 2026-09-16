import { describe, expect, it } from 'vitest';

import { RACE_CONFIG, SPEED } from '../../src/core/config';
import { OVERTAKE } from '../../src/core/config';
import {
  OVERTAKE_SEED,
  OVERTAKE_SEED_EVIDENCE,
  measureOvertakes,
  measureSampledOvertakes,
} from '../fixtures/seeds';

/**
 * Vérifie la seed retenue par les tests E2E de mouvement et de dépassement.
 *
 * Sans ce test, la seed du test E2E serait un nombre choisi arbitrairement, et personne ne saurait
 * pourquoi elle l'a été. Ici, la raison est mesurée, chiffrée, et vérifiée à chaque exécution.
 *
 * Depuis le correctif d'hystérésis (avant P009), la mesure alimente un `OvertakeTracker` **à chaque
 * pas simulé** : c'est la granularité du noyau, celle que P009 utilisera.
 */
describe('seed retenue pour les tests de dépassement', () => {
  const evidence = OVERTAKE_SEED_EVIDENCE;

  it('produit exactement la course mesurée lors du choix', () => {
    const measured = measureOvertakes(OVERTAKE_SEED);

    expect(measured.steps).toBe(RACE_CONFIG.TOTAL_STEPS);
    expect(measured.leaderChanges).toBe(evidence.leaderChanges);
    expect(measured.overtakes).toBe(evidence.overtakes);
  });

  it('dépasse largement le minimum exigé par le test E2E', () => {
    const measured = measureOvertakes(OVERTAKE_SEED);

    expect(measured.leaderChanges).toBeGreaterThanOrEqual(1);
    expect(measured.overtakes).toBeGreaterThanOrEqual(3);
  });

  it('détecte les dépassements pas à pas, sans dépendre de la fréquence d’observation', () => {
    // Avant le correctif, `overtakesBetween` exigeait de dépasser `OVERTAKE.MIN_MARGIN` **entre deux
    // relevés** : comme un pas ne vaut que `SPEED.BASE × DT_S = 0,2 m`, observer pas à pas ne
    // comptait aucun dépassement. L'écart d'un pas reste inférieur à la marge — c'est une propriété
    // de la course, pas du détecteur.
    const stepDistance = SPEED.BASE * RACE_CONFIG.DT_S;
    expect(stepDistance).toBeLessThan(OVERTAKE.MIN_MARGIN);

    const everyStep = measureOvertakes(OVERTAKE_SEED);
    expect(everyStep.overtakes).toBeGreaterThan(0);

    // L'hystérésis mémorise le côté confirmé de chaque paire : tant qu'un relevé tombe dans la même
    // seconde simulée, le nombre de dépassements est **le même**.
    for (const granularity of [2, 5, 10]) {
      expect(
        measureSampledOvertakes(OVERTAKE_SEED, granularity).overtakes,
        `un relevé tous les ${granularity} pas`,
      ).toBe(everyStep.overtakes);
    }
  });

  it('documente la limite d’un échantillonnage grossier : la source de vérité reste le pas simulé', () => {
    // Un observateur alimenté toutes les 20 pas (une image en `timeScale = 20`) peut manquer un
    // aller-retour **plus rapide que son intervalle de relevé** : mesuré 65 dépassements au lieu de
    // 68. Aucune détection fondée sur des relevés ne peut reconstituer ce qu'elle n'a pas vu ; c'est
    // pourquoi P009 alimentera le détecteur à chaque pas du noyau, jamais à la fréquence de rendu.
    const coarse = measureSampledOvertakes(OVERTAKE_SEED, 20);
    expect(coarse.overtakes).toBeLessThanOrEqual(measureOvertakes(OVERTAKE_SEED).overtakes);

    // La marge de sécurité des tests E2E (qui observent à la fréquence d'affichage) reste tenue.
    expect(coarse.overtakes).toBeGreaterThanOrEqual(3);
    expect(coarse.leaderChanges).toBeGreaterThanOrEqual(1);
  });
});
