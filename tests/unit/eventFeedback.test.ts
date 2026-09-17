import { describe, expect, it } from 'vitest';

import { CHARACTERS } from '../../src/core/characters';
import type { ActiveEvent, CharacterId, CharacterState, EventId } from '../../src/core/types';
import { UI_TEXT_FR } from '../../src/app/strings.fr';
import {
  buildEventBadges,
  eventKindOf,
  eventOccurrence,
  type EventBadgePosition,
} from '../../src/render/view/eventFeedbackModel';

/**
 * Passe corrective §10 — retour visuel d'événement.
 *
 * Le modèle est **pur** : il ne reçoit que des états déjà lus et des positions d'écran, et ne rend
 * que des badges. Ces tests vérifient donc tout ce qui peut mentir à l'écran — le personnage visé, la
 * nature bonus/malus, le libellé, la position — sans navigateur, et sans jamais approcher le noyau.
 */

const LAYOUT = { width: 1280, height: 720 } as const;

function activeEvent(overrides: Partial<ActiveEvent> = {}): ActiveEvent {
  return {
    id: 'TURBO',
    target: CHARACTERS[0]?.id ?? 'c1',
    startSimS: 12,
    durationS: 5,
    magnitude: 0.35,
    ...overrides,
  };
}

function character(id: CharacterId, event: ActiveEvent | null): CharacterState {
  return {
    id,
    x: 100,
    v: 10,
    drift: 0,
    surge: 0,
    eventBonus: event === null ? 0 : event.magnitude,
    activeEvent: event,
  };
}

/** Positions d'écran des six personnages, espacées : chaque badge doit atterrir sur le sien. */
function positions(): readonly EventBadgePosition[] {
  return CHARACTERS.map((character_, index) => ({
    id: character_.id,
    screenX: 128 * (index + 1),
    screenY: 72 * (index + 1),
  }));
}

describe('passe corrective : modèle du retour visuel d’événement', () => {
  it('ne produit aucun badge sans événement actif', () => {
    const badges = buildEventBadges(
      CHARACTERS.map((character_) => character(character_.id, null)),
      positions(),
      LAYOUT,
      UI_TEXT_FR,
    );
    expect(badges).toEqual([]);
  });

  it('attache le badge au personnage réellement visé', () => {
    const target = CHARACTERS[2]?.id ?? 'c3';
    const event = activeEvent({ target });
    const badges = buildEventBadges(
      CHARACTERS.map((character_) => character(character_.id, character_.id === target ? event : null)),
      positions(),
      LAYOUT,
      UI_TEXT_FR,
    );

    expect(badges).toHaveLength(1);
    expect(badges[0]?.id).toBe(target);
    expect(badges[0]?.eventId).toBe('TURBO');
    expect(badges[0]?.label).toBe('TURBO !');
  });

  it('déduit bonus et malus du signe de la magnitude réelle', () => {
    expect(eventKindOf(activeEvent({ magnitude: 0.35 }))).toBe('bonus');
    expect(eventKindOf(activeEvent({ id: 'CHUTE', magnitude: -0.6 }))).toBe('malus');
    // Un événement neutre n'est ni l'un ni l'autre : le badge ne prétend rien.
    expect(eventKindOf(activeEvent({ magnitude: 0 }))).toBe('neutral');

    const bonus = buildEventBadges(
      [character('c1', activeEvent({ magnitude: 0.35 }))],
      positions(),
      LAYOUT,
      UI_TEXT_FR,
    );
    expect(bonus[0]?.kindLabel).toBe('BONUS !');

    const malus = buildEventBadges(
      [character('c1', activeEvent({ id: 'CHUTE', magnitude: -0.6 }))],
      positions(),
      LAYOUT,
      UI_TEXT_FR,
    );
    expect(malus[0]?.kindLabel).toBe('MALUS !');
    expect(malus[0]?.label).toBe('CHUTE !');

    const neutral = buildEventBadges(
      [character('c1', activeEvent({ magnitude: 0 }))],
      positions(),
      LAYOUT,
      UI_TEXT_FR,
    );
    expect(neutral[0]?.kindLabel).toBe('');
  });

  it('distingue deux occurrences successives du même type', () => {
    const first = activeEvent({ id: 'TURBO', startSimS: 12 });
    const second = activeEvent({ id: 'TURBO', startSimS: 31 });
    // Même type, départs différents : ce sont deux événements distincts, donc deux badges distincts.
    expect(eventOccurrence(first)).not.toBe(eventOccurrence(second));
    expect(eventOccurrence(first)).toBe('TURBO@12');
    expect(eventOccurrence(second)).toBe('TURBO@31');
  });

  it('positionne le badge sur le sprite, en pourcentage d’arène', () => {
    const target = 'c1';
    const badges = buildEventBadges(
      [character(target, activeEvent({ target }))],
      [{ id: target, screenX: 320, screenY: 180 }],
      LAYOUT,
      UI_TEXT_FR,
    );

    // 320 / 1280 = 25 %, 180 / 720 = 25 % : la conversion est exacte, donc indépendante de la
    // résolution réelle (l'arène est toujours le canvas, `Scale.FIT`).
    expect(badges[0]?.leftPercent).toBe(25);
    expect(badges[0]?.topPercent).toBe(25);
  });

  it('borne un badge de personnage hors écran dans l’arène', () => {
    const badges = buildEventBadges(
      [character('c1', activeEvent()), character('c2', activeEvent({ target: 'c2' }))],
      [
        { id: 'c1', screenX: -400, screenY: 3600 },
        { id: 'c2', screenX: 5000, screenY: -20 },
      ],
      LAYOUT,
      UI_TEXT_FR,
    );

    for (const badge of badges) {
      expect(badge.leftPercent).toBeGreaterThanOrEqual(0);
      expect(badge.leftPercent).toBeLessThanOrEqual(100);
      expect(badge.topPercent).toBeGreaterThanOrEqual(0);
      expect(badge.topPercent).toBeLessThanOrEqual(100);
    }
  });

  it('n’affiche pas de badge pour un personnage sans position connue', () => {
    const badges = buildEventBadges([character('c1', activeEvent())], [], LAYOUT, UI_TEXT_FR);
    expect(badges).toEqual([]);
  });

  it('retombe sur l’identifiant technique pour un type hors catalogue, sans jamais inventer', () => {
    const unknown: EventId = 'MEGA_TURBO';
    const badges = buildEventBadges(
      [character('c1', activeEvent({ id: unknown, magnitude: 1.2 }))],
      positions(),
      LAYOUT,
      UI_TEXT_FR,
    );

    expect(badges[0]?.label).toBe('MEGA TURBO !');
    expect(badges[0]?.kind).toBe('bonus');
  });

  it('ne modifie aucun état du noyau : le personnage reçu est intact', () => {
    const event = activeEvent();
    const state = character('c1', event);
    const before = structuredClone(state);
    buildEventBadges([state], positions(), LAYOUT, UI_TEXT_FR);
    expect(state).toEqual(before);
  });
});
