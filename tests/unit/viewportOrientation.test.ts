import { describe, expect, it } from 'vitest';

import { VIEW } from '../../src/render/viewConfig';
import { isPortraitPhone, orientationOf } from '../../src/render/viewport';
import {
  SETTLE_MAX_WAIT_MS,
  SETTLE_SAMPLES,
  ViewportSettle,
  sameViewport,
  type ViewportSample,
} from '../../src/render/viewportSettle';

/**
 * Décisions de format prises hors du navigateur.
 *
 * Ces trois briques décident **où** la course a le droit de s'afficher (orientation), **quand** une
 * taille de fenêtre est fiable (stabilisation) et **si** deux mesures décrivent le même écran. Elles
 * sont pures : les tester ici, sans DOM, est ce qui garantit qu'elles ne dépendent ni de WebKit ni de
 * l'ordre d'arrivée des événements de fenêtre.
 */

/** Téléphones réels, dans les deux sens, avec les tailles de mise en page correspondantes. */
const PHONES_LANDSCAPE = [
  { name: 'iPhone 12/13/14', width: 844, height: 390 },
  { name: 'iPhone 14 Pro Max', width: 926, height: 428 },
];

function sample(overrides: Partial<ViewportSample> = {}): ViewportSample {
  return {
    visibleWidth: 844,
    visibleHeight: 390,
    layoutWidth: 844,
    layoutHeight: 390,
    ...overrides,
  };
}

describe('orientation d’une fenêtre', () => {
  it('reconnaît le portrait et le paysage des deux sens', () => {
    expect(orientationOf(390, 844)).toBe('portrait');
    expect(orientationOf(844, 390)).toBe('landscape');
    expect(orientationOf(428, 926)).toBe('portrait');
    expect(orientationOf(926, 428)).toBe('landscape');
  });

  it('traite le carré comme du paysage', () => {
    // Aucun téléphone n'est carré : cette branche n'existe que pour rendre la fonction totale, et le
    // carré est le cas où l'écran est aussi large que possible sans être plus haut que large.
    expect(orientationOf(500, 500)).toBe('landscape');
  });

  it('suit la taille de mise en page, pas la taille visible', () => {
    // Une barre d'URL repliée change la hauteur **visible** sans changer l'orientation de la mise en
    // page : c'est bien celle-ci que lisent les requêtes média de `styles.css`.
    expect(orientationOf(844, 390)).toBe('landscape');
    expect(orientationOf(390, 844)).toBe('portrait');
  });
});

describe('téléphone tenu droit', () => {
  it('bloque les téléphones en portrait', () => {
    for (const phone of PHONES_LANDSCAPE) {
      expect(isPortraitPhone(phone.height, phone.width), phone.name).toBe(true);
    }
  });

  it('laisse jouer les mêmes téléphones en paysage', () => {
    for (const phone of PHONES_LANDSCAPE) {
      expect(isPortraitPhone(phone.width, phone.height), phone.name).toBe(false);
    }
  });

  it('ne bloque pas une fenêtre de bureau haute et étroite', () => {
    // Elle est en portrait, mais son côté court dépasse le seuil du téléphone : la bloquer serait une
    // régression pour un écran de bureau redimensionné.
    expect(isPortraitPhone(700, 900)).toBe(false);
    expect(isPortraitPhone(561, 1000)).toBe(false);
  });

  it('bloque jusqu’au seuil du format petit paysage, et pas au-delà', () => {
    const seuil = VIEW.COMPACT_VIEWPORT_MAX_HEIGHT_PX;
    expect(isPortraitPhone(seuil, 1000)).toBe(true);
    expect(isPortraitPhone(seuil + 1, 1000)).toBe(false);
  });

  it('ne bloque pas un carré, qui n’est pas du portrait', () => {
    expect(isPortraitPhone(VIEW.COMPACT_VIEWPORT_MAX_HEIGHT_PX, VIEW.COMPACT_VIEWPORT_MAX_HEIGHT_PX)).toBe(
      false,
    );
  });
});

describe('comparaison de deux mesures de fenêtre', () => {
  it('reconnaît deux mesures identiques', () => {
    expect(sameViewport(sample(), sample())).toBe(true);
  });

  it('distingue chaque champ', () => {
    const reference = sample();
    expect(sameViewport(reference, sample({ visibleWidth: 845 }))).toBe(false);
    expect(sameViewport(reference, sample({ visibleHeight: 391 }))).toBe(false);
    expect(sameViewport(reference, sample({ layoutWidth: 845 }))).toBe(false);
    expect(sameViewport(reference, sample({ layoutHeight: 391 }))).toBe(false);
  });
});

describe('stabilisation de la taille de fenêtre', () => {
  it('n’accepte rien tant qu’aucun événement n’a été signalé', () => {
    const settle = new ViewportSettle();
    expect(settle.pending).toBe(false);
    expect(settle.push(sample(), 0)).toBeNull();
  });

  it('accepte une taille après plusieurs mesures identiques', () => {
    const settle = new ViewportSettle();
    settle.arm(0);
    expect(settle.pending).toBe(true);
    for (let index = 0; index < SETTLE_SAMPLES - 1; index += 1) {
      expect(settle.push(sample(), index), `mesure ${String(index + 1)}`).toBeNull();
    }
    expect(settle.push(sample(), SETTLE_SAMPLES - 1)).toEqual(sample());
    expect(settle.pending).toBe(false);
  });

  it('repart de zéro dès qu’une mesure diffère', () => {
    const settle = new ViewportSettle();
    settle.arm(0);
    settle.push(sample(), 0);
    settle.push(sample(), 1);
    // iOS annonce une taille corrigée : l'attente recommence, rien n'est recalculé sur l'ancienne.
    expect(settle.push(sample({ layoutWidth: 926, visibleWidth: 926 }), 2)).toBeNull();
    expect(settle.push(sample({ layoutWidth: 926, visibleWidth: 926 }), 3)).toBeNull();
    expect(settle.push(sample({ layoutWidth: 926, visibleWidth: 926 }), 4)).toEqual(
      sample({ layoutWidth: 926, visibleWidth: 926 }),
    );
  });

  it('repart de zéro à chaque nouvel événement de fenêtre', () => {
    const settle = new ViewportSettle();
    settle.arm(0);
    settle.push(sample(), 0);
    settle.push(sample(), 1);
    settle.arm(2);
    expect(settle.push(sample(), 2)).toBeNull();
    expect(settle.push(sample(), 3)).toBeNull();
    expect(settle.push(sample(), 4)).toEqual(sample());
  });

  it('accepte la dernière taille connue au bout du délai maximal', () => {
    // Repli documenté : une barre d'URL qui n'arrête jamais de bouger ne doit pas figer la page.
    const settle = new ViewportSettle();
    settle.arm(0);
    settle.push(sample(), 0);
    const dernier = sample({ visibleHeight: 391 });
    expect(settle.push(dernier, SETTLE_MAX_WAIT_MS)).toEqual(dernier);
    expect(settle.pending).toBe(false);
  });

  it('n’accepte plus rien après stabilisation, sans nouvel événement', () => {
    const settle = new ViewportSettle();
    settle.arm(0);
    settle.push(sample(), 0);
    settle.push(sample(), 1);
    settle.push(sample(), 2);
    expect(settle.push(sample(), 3)).toBeNull();
  });
});
