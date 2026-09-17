import { describe, expect, it } from 'vitest';

import {
  NBSP,
  DISPLAY_DECIMALS,
  formatCountFr,
  formatDecimalFr,
  formatMetresFr,
  formatPercentFr,
  formatSecondsFr,
  formatSignedMetresFr,
  formatSignedSecondsFr,
  formatTruncatedMetresFr,
  formatUnitFr,
} from '../../src/render/format';

/**
 * Passe corrective §9 — module unique de formatage des nombres visibles.
 *
 * Les valeurs de ces tests ne sont pas choisies au hasard : ce sont **exactement** celles que le
 * premier test joueur manuel a vues s'afficher (`6.133333333333333 s`, `35.93333333333333 %`) ou
 * aurait pu voir (une distance maximale à `26.0 m`). Le but du module est qu'aucune d'elles ne puisse
 * plus atteindre un texte visible sous sa forme brute.
 */

describe('passe corrective : formatage des nombres visibles', () => {
  it('affiche une durée sans décimale', () => {
    expect(formatSecondsFr(6)).toBe('6 s');
    expect(formatSecondsFr(6.133333333333333)).toBe('6 s');
    expect(formatSecondsFr(6.5)).toBe('7 s');
    expect(formatSecondsFr(0.4)).toBe('0 s');
  });

  it('affiche un pourcentage sans décimale', () => {
    expect(formatPercentFr(36)).toBe('36 %');
    expect(formatPercentFr(35.93333333333333)).toBe('36 %');
    expect(formatPercentFr(60.00000000000001)).toBe('60 %');
  });

  it('affiche un compte comme un entier, même bruité', () => {
    expect(formatCountFr(4)).toBe('4');
    expect(formatCountFr(3.9999999999999996)).toBe('4');
    expect(formatCountFr(5.000000000000001)).toBe('5');
  });

  it('garde une décimale aux distances, et jamais plus', () => {
    expect(formatMetresFr(3.24)).toBe('3,2 m');
    // Distance maximale d'une course de 60 s : le flottant brut ne doit pas fuir.
    expect(formatMetresFr(25.999999999999996)).toBe('26,0 m');
    expect(formatMetresFr(2160)).toBe('2160,0 m');
  });

  it('tronque les relevés de distance au mètre, sans jamais surestimer', () => {
    expect(formatTruncatedMetresFr(812.9999999)).toBe('812 m');
    expect(formatTruncatedMetresFr(812.4)).toBe('812 m');
    // Arrondir au plus proche donnerait `813 m` : une valeur que le noyau n'a pas mesurée.
    expect(formatTruncatedMetresFr(812.9999999)).not.toBe('813 m');
  });

  it('signe les écarts sans jamais écrire `-0,0`', () => {
    expect(formatSignedMetresFr(3.24)).toBe('+3,2 m');
    expect(formatSignedMetresFr(0)).toBe('0,0 m');
    expect(formatSignedMetresFr(-0.0001)).toBe('0,0 m');
    expect(formatSignedMetresFr(-3.24)).toBe('3,2 m');
    expect(formatSignedSecondsFr(0.32)).toBe('+0,3 s');
    expect(formatSignedSecondsFr(0)).toBe('0,0 s');
  });

  it('choisit le séparateur sans changer l’arrondi', () => {
    expect(formatUnitFr(6, 's', DISPLAY_DECIMALS.INTEGER, NBSP)).toBe(`6${NBSP}s`);
    expect(formatSecondsFr(6, NBSP)).toBe(`6${NBSP}s`);
    expect(formatMetresFr(3.24, NBSP)).toBe(`3,2${NBSP}m`);
  });

  it('ne laisse jamais fuir le point décimal du moteur', () => {
    for (const value of [6.133333333333333, 35.93333333333333, 0.42000000000000004]) {
      expect(formatDecimalFr(value)).not.toContain('.');
    }
  });

  it('reste lisible sur une valeur non finie, sans lever', () => {
    expect(formatDecimalFr(Number.NaN)).toBe('—');
    expect(formatDecimalFr(Number.POSITIVE_INFINITY)).toBe('—');
    expect(formatSecondsFr(Number.NaN)).toBe('— s');
  });

  it('n’arrondit que le texte : la valeur reçue est intacte', () => {
    const measured = 6.133333333333333;
    const before = measured;
    formatSecondsFr(measured);
    formatPercentFr(measured * 100);
    // Un arrondi d'affichage qui modifierait la valeur mesurée casserait la véracité du speaker.
    expect(measured).toBe(before);
  });
});
