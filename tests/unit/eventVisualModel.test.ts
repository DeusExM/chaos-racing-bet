import { describe, expect, it } from 'vitest';

import { CHARACTER_IDS } from '../../src/core/characters';
import type { ActiveEvent, CharacterState } from '../../src/core/types';
import {
  NO_EVENT_VISUAL,
  eventVisualOf,
  type EventVisual,
} from '../../src/render/view/eventVisualModel';

/**
 * Passe de finition 2D — modèle pur de l'état visuel d'un événement.
 *
 * Ces tests tournent sans navigateur : tout ce qui décide de l'aspect d'un bonus ou d'un malus est une
 * fonction pure d'un personnage déjà calculé. C'est ce qui garantit, structurellement, que l'effet ne
 * peut pas influencer la course : il ne reçoit ni distance d'arrivée, ni générateur aléatoire, ni
 * horloge de simulation, et il ne renvoie que des nombres d'affichage.
 */

function activeEvent(overrides: Partial<ActiveEvent> = {}): ActiveEvent {
  return {
    id: 'TURBO',
    target: 'c1',
    startSimS: 12,
    durationS: 3,
    magnitude: 0.9,
    ...overrides,
  };
}

function character(event: ActiveEvent | null): CharacterState {
  return {
    id: 'c1',
    x: 420,
    v: 12,
    drift: 0,
    surge: 0,
    eventBonus: event === null ? 0 : event.magnitude,
    activeEvent: event,
  };
}

/** Toutes les valeurs numériques d'un état visuel : sert à prouver qu'aucune n'est aberrante. */
function valuesOf(visual: EventVisual): number[] {
  return [
    visual.intensity,
    visual.tint,
    visual.auraTint,
    visual.auraAlpha,
    visual.auraScale,
    visual.trailAlpha,
    visual.trailOffsetRatio,
  ];
}

describe('état visuel d’un événement', () => {
  it('ne montre rien quand aucun événement n’est actif', () => {
    const visual = eventVisualOf(character(null), 0);
    expect(visual).toBe(NO_EVENT_VISUAL);
    expect(visual.kind).toBe('none');
    expect(visual.auraAlpha).toBe(0);
    expect(visual.trailAlpha).toBe(0);
    // Aucune teinte : le personnage garde exactement ses couleurs.
    expect(visual.tint).toBe(0xffffff);
  });

  it('ne montre rien non plus pour une magnitude nulle', () => {
    // Le noyau n'a rien appliqué : l'effet ne prétend donc rien, plutôt que d'inventer un sens.
    const visual = eventVisualOf(character(activeEvent({ magnitude: 0 })), 0);
    expect(visual.kind).toBe('none');
    expect(visual.auraAlpha).toBe(0);
  });

  it('déduit bonus et malus du signe de la magnitude réelle', () => {
    expect(eventVisualOf(character(activeEvent({ magnitude: 0.9 })), 0).kind).toBe('bonus');
    expect(
      eventVisualOf(character(activeEvent({ id: 'CHUTE', magnitude: -0.6 })), 0).kind,
    ).toBe('malus');
  });

  it('laisse le bonus ajouter de la lumière sans repeindre le personnage', () => {
    const visual = eventVisualOf(character(activeEvent({ magnitude: 1.2 })), 0);
    // Aucune teinte sur le sprite : c'est le halo et la traînée qui portent la lumière.
    expect(visual.tint).toBe(0xffffff);
    expect(visual.auraAlpha).toBeGreaterThan(0);
    expect(visual.trailAlpha).toBeGreaterThan(0);
    // La traînée recule **vers l'arrière** (à gauche) : le décalage est positif.
    expect(visual.trailOffsetRatio).toBeGreaterThan(0);
  });

  it('assombrit et rougit le malus, sans jamais remplacer l’illustration', () => {
    const visual = eventVisualOf(character(activeEvent({ id: 'CHUTE', magnitude: -0.75 })), 0);
    expect(visual.tint).not.toBe(0xffffff);
    // Une teinte multiplicative : chaque canal reste dans `[0 ; 255]`, et le rouge domine.
    const red = (visual.tint >> 16) & 0xff;
    const green = (visual.tint >> 8) & 0xff;
    const blue = visual.tint & 0xff;
    expect(red).toBeGreaterThan(green);
    expect(red).toBeGreaterThan(blue);
    expect(visual.auraAlpha).toBeGreaterThan(0);
    expect(visual.trailAlpha).toBeGreaterThan(0);
  });

  it('croît avec la magnitude, sans jamais sortir de son cadre', () => {
    const weak = eventVisualOf(character(activeEvent({ magnitude: 0.2 })), 0);
    const strong = eventVisualOf(character(activeEvent({ magnitude: 1.2 })), 0);
    expect(strong.intensity).toBeGreaterThan(weak.intensity);
    expect(strong.auraAlpha).toBeGreaterThan(weak.auraAlpha);
    expect(strong.trailOffsetRatio).toBeGreaterThan(weak.trailOffsetRatio);

    // Bornes dures : aucune valeur ne peut rendre l'écran illisible.
    for (const magnitude of [-0.75, -0.2, 0.2, 0.9, 1.63]) {
      for (const pulseMs of [0, 100, 210, 420, 1000, 9999]) {
        const visual = eventVisualOf(character(activeEvent({ magnitude })), pulseMs);
        for (const value of valuesOf(visual)) {
          expect(Number.isFinite(value), `valeur finie (magnitude ${String(magnitude)})`).toBe(true);
        }
        expect(visual.intensity).toBeGreaterThanOrEqual(0);
        expect(visual.intensity).toBeLessThanOrEqual(1);
        expect(visual.auraAlpha).toBeGreaterThanOrEqual(0);
        expect(visual.auraAlpha).toBeLessThanOrEqual(0.5);
        expect(visual.trailAlpha).toBeGreaterThanOrEqual(0);
        expect(visual.trailAlpha).toBeLessThanOrEqual(0.36);
        expect(visual.auraScale).toBeGreaterThanOrEqual(1);
        expect(visual.auraScale).toBeLessThanOrEqual(1.15);
        expect(visual.trailOffsetRatio).toBeGreaterThanOrEqual(0);
        // La traînée ne recule jamais de plus de la moitié de la largeur du sprite.
        expect(visual.trailOffsetRatio).toBeLessThanOrEqual(0.5);
        // Le halo déborde **autour** de la silhouette, jamais l'inverse.
        expect(visual.auraScale).toBeGreaterThan(1);
      }
    }
  });

  it('pulse dans le temps réel, sans jamais changer de position', () => {
    const alphas = new Set<number>();
    for (let pulseMs = 0; pulseMs <= 420; pulseMs += 30) {
      const visual = eventVisualOf(character(activeEvent({ magnitude: 1.2 })), pulseMs);
      alphas.add(Number(visual.auraAlpha.toFixed(4)));
    }
    // La pulsation module l'opacité : plusieurs valeurs distinctes apparaissent sur une période.
    expect(alphas.size).toBeGreaterThan(3);

    // Le décalage de la traînée, lui, ne dépend pas du temps : la pulsation ne déplace rien.
    const early = eventVisualOf(character(activeEvent({ magnitude: 1.2 })), 0);
    const late = eventVisualOf(character(activeEvent({ magnitude: 1.2 })), 315);
    expect(late.trailOffsetRatio).toBe(early.trailOffsetRatio);
    expect(late.intensity).toBe(early.intensity);
  });

  it('est une fonction pure : deux appels identiques donnent le même résultat', () => {
    const state = character(activeEvent({ magnitude: 0.5 }));
    const before = JSON.stringify(state);
    const first = eventVisualOf(state, 123);
    const second = eventVisualOf(state, 123);
    expect(second).toEqual(first);
    // Le personnage reçu n'est jamais modifié : ni `x`, ni `v`, ni l'événement.
    expect(JSON.stringify(state)).toBe(before);
  });

  it('ne lit aucune distance ni aucun classement : l’effet ne peut pas changer une course', () => {
    const near = character(activeEvent({ magnitude: 0.5 }));
    const far: CharacterState = { ...near, x: near.x + 500, v: near.v + 3 };
    // Deux personnages au même événement, à des positions et vitesses très différentes, ont
    // exactement le même état visuel : aucune position n'entre dans la décision.
    expect(eventVisualOf(far, 77)).toEqual(eventVisualOf(near, 77));
  });

  it('couvre les six personnages du roster sans dépendre de leur identité', () => {
    for (const id of CHARACTER_IDS) {
      const visual = eventVisualOf(
        { ...character(activeEvent()), id },
        0,
      );
      expect(visual.kind).toBe('bonus');
      expect(visual.auraAlpha).toBeGreaterThan(0);
    }
  });
});
