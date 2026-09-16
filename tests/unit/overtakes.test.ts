import { describe, expect, it } from 'vitest';

import { OVERTAKE } from '../../src/core/config';
import { OvertakeTracker } from '../../src/core/overtakes';
import type { CharacterId } from '../../src/core/types';

const PAIR: readonly CharacterId[] = ['c0', 'c1'];
const SIX: readonly CharacterId[] = ['c0', 'c1', 'c2', 'c3', 'c4', 'c5'];

/** Observe l'écart `c0 − c1` seul, avec `c1` immobile : la marge se lit donc directement. */
function observeGap(tracker: OvertakeTracker, gap: number): number {
  return tracker.observe([gap, 0], PAIR).length;
}

describe('OvertakeTracker : hystérésis de dépassement', () => {
  it('respecte la marge documentée dans la configuration', () => {
    expect(OVERTAKE.MIN_MARGIN).toBe(0.5);
  });

  it('n’émet rien tant que la marge n’est pas franchie, puis exactement un dépassement', () => {
    const tracker = new OvertakeTracker();

    // c1 est confirmé devant c0 (1 m d'avance) : c'est une initialisation, pas un dépassement.
    expect(observeGap(tracker, -1.0)).toBe(0);

    // c0 revient : sous la marge, rien n'est émis et le côté confirmé ne change pas.
    for (const gap of [-0.4, -0.1, 0.1, 0.4, 0.5]) {
      expect(observeGap(tracker, gap), `écart ${gap}`).toBe(0);
    }

    // Le franchissement franc de la marge émet exactement un dépassement, une seule fois.
    expect(observeGap(tracker, 0.51)).toBe(1);
    expect(observeGap(tracker, 0.8)).toBe(0);
    expect(observeGap(tracker, 0.51)).toBe(0);
  });

  it('ne compte aucun dépassement sur un bruit autour de zéro', () => {
    const tracker = new OvertakeTracker();

    // Aucun côté n'est confirmé : ±0,2 m ne franchit jamais la marge.
    for (let round = 0; round < 200; round += 1) {
      const gap = round % 2 === 0 ? 0.2 : -0.2;
      expect(observeGap(tracker, gap)).toBe(0);
    }

    // Après confirmation opposée, le bruit reste sans effet tant que la marge n'est pas franchie.
    expect(observeGap(tracker, -0.51)).toBe(0);
    for (let round = 0; round < 200; round += 1) {
      const gap = round % 3 === 0 ? 0.3 : round % 3 === 1 ? -0.1 : 0.4;
      expect(observeGap(tracker, gap)).toBe(0);
    }
  });

  it('compte deux dépassements sur un aller-retour réel', () => {
    const tracker = new OvertakeTracker();

    expect(observeGap(tracker, 0.6)).toBe(0); // c0 confirmé devant : initialisation.
    expect(observeGap(tracker, -0.6)).toBe(1); // c1 repasse c0.
    expect(observeGap(tracker, 0.6)).toBe(1); // c0 repasse c1.

    let total = 2;
    for (const gap of [-0.2, 0.2, -0.5, 0.5, -0.49, 0.49]) {
      total += observeGap(tracker, gap);
    }
    expect(total).toBe(2);
  });

  it('ne produit aucun dépassement fictif au départ à égalité des 6 personnages', () => {
    const tracker = new OvertakeTracker();

    // Les 6 à la même distance : aucune paire n'a de côté confirmé.
    for (let step = 0; step < 120; step += 1) {
      expect(tracker.observe([0, 0, 0, 0, 0, 0], SIX)).toEqual([]);
    }

    // Puis les écarts s'ouvrent progressivement sans qu'aucune paire ne se réordonne : chaque paire
    // s'initialise, aucune ne bascule.
    let overtakes = 0;
    for (let step = 1; step <= 200; step += 1) {
      const xs = [0, 0.1, 0.2, 0.3, 0.4, 0.5].map((base) => base + step * (0.2 + base));
      overtakes += tracker.observe(xs, SIX).length;
    }
    expect(overtakes).toBe(0);
  });

  it('compte un dépassement par paire franchie quand un personnage en double deux autres', () => {
    const tracker = new OvertakeTracker();

    // c2 est confirmé dernier, puis franchit c1 et c0 avec de la marge.
    expect(tracker.observe([100, 90, 60], ['c0', 'c1', 'c2'])).toEqual([]);
    expect(tracker.observe([100, 90, 110], ['c0', 'c1', 'c2'])).toEqual([
      { overtaker: 'c2', overtaken: 'c0' },
      { overtaker: 'c2', overtaken: 'c1' },
    ]);
  });

  it('reste stable quand on réobserve les mêmes distances', () => {
    const tracker = new OvertakeTracker();
    const xs = [100, 98, 96, 94, 92, 90];

    tracker.observe(xs, SIX);
    const frozen = Object.freeze([...xs]);

    expect(tracker.observe(frozen, SIX)).toEqual([]);
    expect(tracker.observe(frozen, SIX)).toEqual([]);
  });

  it('oublie les côtés confirmés après reset', () => {
    const tracker = new OvertakeTracker();

    expect(observeGap(tracker, -0.6)).toBe(0);
    tracker.reset();

    // Après reset, le retour à +0,6 m est une initialisation, pas un dépassement.
    expect(observeGap(tracker, 0.6)).toBe(0);
    expect(observeGap(tracker, -0.6)).toBe(1);
  });

  it('accepte le même ordre d’identifiants à chaque observation', () => {
    const tracker = new OvertakeTracker();

    for (let step = 0; step < 50; step += 1) {
      expect(tracker.observe([100, 98, 96, 94, 92, 90], SIX)).toEqual([]);
    }

    // Une observation vide ne dit rien de l'ordre et ne l'engage pas.
    expect(tracker.observe([], [])).toEqual([]);
    expect(tracker.observe([100, 98, 96, 94, 92, 90], SIX)).toEqual([]);
  });

  it('refuse une permutation de deux identifiants, au lieu d’attribuer un dépassement au mauvais couple', () => {
    const tracker = new OvertakeTracker();
    const permuted = Object.freeze(['c1', 'c0', 'c2', 'c3', 'c4', 'c5'] as const);

    expect(tracker.observe([100, 98, 96, 94, 92, 90], SIX)).toEqual([]);
    expect(() => tracker.observe([100, 98, 96, 94, 92, 90], permuted)).toThrow(/ordre des identifiants/);

    // Une liste plus courte est refusée pour la même raison : les index ne désignent plus les mêmes
    // personnages.
    expect(() => tracker.observe([100, 98, 96, 94, 92], SIX.slice(0, 5))).toThrow(RangeError);
  });

  it('adopte un nouvel ordre après reset, comme au départ d’une autre course', () => {
    const tracker = new OvertakeTracker();
    const swapped: readonly CharacterId[] = ['c1', 'c0'];

    expect(tracker.observe([100, 90], ['c0', 'c1'])).toEqual([]);
    tracker.reset();

    // Après reset, l'ordre mémorisé est oublié : un autre roster repart proprement, sans dépassement
    // fictif hérité d'un ancien côté confirmé (le premier relevé ne fait qu'initialiser la paire).
    expect(tracker.observe([100, 90], swapped)).toEqual([]);
    expect(tracker.observe([90, 100], swapped)).toEqual([{ overtaker: 'c0', overtaken: 'c1' }]);
  });

  it('refuse des entrées inexploitables', () => {
    const tracker = new OvertakeTracker();

    expect(() => tracker.observe([1, 2], ['c0'])).toThrow(RangeError);
    expect(() => tracker.observe([1, Number.NaN], PAIR)).toThrow(RangeError);
    expect(() => tracker.observe([1, 2], ['c0', 'c0'])).toThrow(/deux fois/);
  });
});
