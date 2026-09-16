import { describe, expect, it } from 'vitest';

import { CHARACTER_IDS, CHARACTERS, assertAllCharactersEquivalent } from '../../src/core/characters';
import type { CharacterConfig } from '../../src/core/characters';

describe('roster des 6 personnages', () => {
  it('contient exactement les six identifiants stables, dans l’ordre', () => {
    expect(CHARACTER_IDS).toEqual(['c0', 'c1', 'c2', 'c3', 'c4', 'c5']);
    expect(CHARACTERS.map((character) => character.id)).toEqual([...CHARACTER_IDS]);
  });

  it('donne à chaque personnage un libellé et une couleur distincts', () => {
    const names = CHARACTERS.map((character) => character.name);
    const colors = CHARACTERS.map((character) => character.color);

    for (const name of names) {
      expect(name.length).toBeGreaterThan(0);
    }
    for (const color of colors) {
      expect(color).toMatch(/^#[0-9a-f]{6}$/);
    }

    expect(new Set(names).size).toBe(CHARACTERS.length);
    expect(new Set(colors).size).toBe(CHARACTERS.length);
  });

  it('n’expose aucune donnée numérique : aucun personnage ne peut porter un avantage', () => {
    // L'équivalence des personnages n'est pas une convention, elle est structurelle : la
    // configuration ne comporte aucun champ où glisser une statistique. Ce test échouera le jour où
    // quelqu'un en ajoutera un.
    for (const character of CHARACTERS) {
      for (const [key, value] of Object.entries(character)) {
        expect(typeof value, `${character.id}.${key} doit rester une donnée cosmétique`).toBe('string');
      }
      expect(Object.keys(character).sort()).toEqual(['color', 'id', 'name']);
    }
  });

  it('gèle le roster et la liste d’identifiants', () => {
    expect(Object.isFrozen(CHARACTERS)).toBe(true);
    expect(Object.isFrozen(CHARACTER_IDS)).toBe(true);
    for (const character of CHARACTERS) {
      expect(Object.isFrozen(character)).toBe(true);
    }
  });
});

describe('assertAllCharactersEquivalent', () => {
  it('accepte le roster du jeu', () => {
    expect(() => assertAllCharactersEquivalent()).not.toThrow();
    expect(() => assertAllCharactersEquivalent(CHARACTERS)).not.toThrow();
  });

  it('rejette un effectif différent de six', () => {
    expect(() => assertAllCharactersEquivalent(CHARACTERS.slice(0, 5))).toThrow(/6 personnages/);
    expect(() => assertAllCharactersEquivalent([])).toThrow(/6 personnages/);
  });

  it('rejette un identifiant inattendu ou dans le mauvais ordre', () => {
    const swapped: readonly CharacterConfig[] = CHARACTERS.map((character, index): CharacterConfig =>
      index === 0 ? { ...character, id: 'c5' } : character,
    );
    expect(() => assertAllCharactersEquivalent(swapped)).toThrow(/Roster incohérent/);
  });

  it('rejette un personnage qui porterait un champ supplémentaire', () => {
    // Le cas exact que ce garde-fou existe pour interdire : un « bonus » glissé sur un personnage.
    const withBonus = CHARACTERS.map((character, index) =>
      index === 3 ? { ...character, bonus: 0.05 } : character,
    );

    expect(() => assertAllCharactersEquivalent(withBonus)).toThrow(/structurellement identiques/);
  });
});
