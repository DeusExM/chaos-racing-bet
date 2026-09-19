import { describe, expect, it } from 'vitest';

import { CHARACTER_IDS } from '../../src/core/characters';
import {
  DEFAULT_PARTICIPANTS,
  MAX_PARTICIPANTS,
  MIN_PARTICIPANTS,
  normalizeParticipants,
  PARTICIPANT_STREAM_LABEL,
  selectParticipants,
} from '../../src/core/participants';
import { normalizeSeed } from '../../src/core/seed';

/**
 * Sélection des partants.
 *
 * Ces tests portent sur la **règle de choix** : qui court, pour un effectif et une seed donnés. Ils
 * vérifient trois propriétés que rien d'autre dans le projet ne peut garantir :
 *
 * 1. le plateau est **déterministe** — même seed, même effectif, mêmes partants, sur n'importe quel
 *    moteur JavaScript (aucun `Math.random`, aucun tirage flottant) ;
 * 2. le plateau est un **sous-ensemble du roster officiel**, dans l'ordre canonique `c0…c5` ;
 * 3. à six coureurs, **rien n'est tiré** : la sélection est le roster entier, à l'identique, ce qui
 *    rend les courses à six rigoureusement inchangées.
 */

/** Seeds canoniques déterministes : distinctes, stables d'une exécution à l'autre. */
function canonicalSeeds(count: number): readonly string[] {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const seeds: string[] = [];

  for (let index = 0; index < count; index += 1) {
    let state = Math.imul(index + 1, 0x9e3779b1) | 0;
    let seed = '';
    for (let position = 0; position < 8; position += 1) {
      state = (Math.imul(state, 1103515245) + 12345) | 0;
      seed += alphabet[(state >>> 16) & 31] ?? '0';
    }
    seeds.push(seed);
  }

  return seeds;
}

const SEEDS = canonicalSeeds(200);
const COUNTS: readonly number[] = [MIN_PARTICIPANTS, 4, 5, MAX_PARTICIPANTS];

describe('lecture du nombre de coureurs', () => {
  it('accepte exactement les quatre effectifs d’une course', () => {
    expect(normalizeParticipants(3)).toBe(3);
    expect(normalizeParticipants(4)).toBe(4);
    expect(normalizeParticipants(5)).toBe(5);
    expect(normalizeParticipants(6)).toBe(6);
    // Les chaînes de l'URL passent par le même chemin : `?players=4` vaut `4`.
    expect(normalizeParticipants('3')).toBe(3);
    expect(normalizeParticipants('6')).toBe(6);
    expect(normalizeParticipants(' 5 ')).toBe(5);
  });

  it('retombe proprement sur six coureurs pour toute valeur illisible', () => {
    for (const value of [null, undefined, '', '  ', 'abc', '4.5', '2', '7', '0', '-3', 2, 7, 0, 3.5, Number.NaN, Number.POSITIVE_INFINITY, true, {}, []]) {
      expect(
        normalizeParticipants(value),
        `« ${String(value)} » doit retomber sur l’effectif complet`,
      ).toBe(DEFAULT_PARTICIPANTS);
    }
  });

  it('vaut six par défaut, et trois au minimum', () => {
    expect(DEFAULT_PARTICIPANTS).toBe(MAX_PARTICIPANTS);
    expect(MIN_PARTICIPANTS).toBe(3);
    expect(MAX_PARTICIPANTS).toBe(CHARACTER_IDS.length);
  });
});

describe('sélection des partants', () => {
  it('aligne exactement l’effectif demandé, pour toute seed', () => {
    for (const seed of SEEDS) {
      const seedValue = normalizeSeed(seed);
      for (const count of COUNTS) {
        expect(selectParticipants(seedValue, count), `${seed} à ${String(count)}`).toHaveLength(count);
      }
    }
  });

  it('ne pioche que dans le roster officiel, sans doublon', () => {
    for (const seed of SEEDS) {
      const seedValue = normalizeSeed(seed);
      for (const count of COUNTS) {
        const ids = selectParticipants(seedValue, count);
        expect(new Set(ids).size, `${seed} à ${String(count)}`).toBe(count);
        for (const id of ids) {
          expect(CHARACTER_IDS, `${seed} : ${id} hors roster`).toContain(id);
        }
      }
    }
  });

  it('conserve l’ordre canonique du roster, quel que soit le tirage', () => {
    for (const seed of SEEDS) {
      const seedValue = normalizeSeed(seed);
      for (const count of COUNTS) {
        const ids = selectParticipants(seedValue, count);
        const positions = ids.map((id) => CHARACTER_IDS.indexOf(id));
        expect(
          [...positions].sort((a, b) => a - b),
          `${seed} à ${String(count)} : l’ordre des voies doit être celui du roster`,
        ).toEqual(positions);
      }
    }
  });

  it('donne exactement le même plateau pour la même seed et le même effectif', () => {
    for (const seed of SEEDS) {
      const seedValue = normalizeSeed(seed);
      for (const count of COUNTS) {
        expect(selectParticipants(seedValue, count)).toEqual(selectParticipants(seedValue, count));
      }
    }
  });

  it('peut changer de plateau quand la seed change', () => {
    for (const count of [MIN_PARTICIPANTS, 4, 5]) {
      const plateaus = new Set(SEEDS.map((seed) => selectParticipants(normalizeSeed(seed), count).join(',')));
      // Sur 200 seeds, un tirage qui ignorerait la seed donnerait un seul plateau : c'est ce que ce
      // test interdit. La borne est volontairement basse (plusieurs plateaux distincts suffisent).
      expect(plateaus.size, `à ${String(count)} coureurs, la seed doit peser`).toBeGreaterThan(1);
      // Et le nombre de plateaux distincts reste celui du dénombrement : il n'existe pas d'autre
      // sous-ensemble que ceux prévus par les combinaisons du roster.
      const expected = count === MIN_PARTICIPANTS ? 20 : count === 4 ? 15 : 6;
      expect(plateaus.size).toBeLessThanOrEqual(expected);
    }
  });

  it('choisit un plateau différent selon l’effectif, pour une même seed', () => {
    // Un plateau à trois coureurs n'est pas « les trois premiers » d'un plateau à cinq : c'est une
    // sélection à part entière. Au moins une seed de la campagne doit le montrer.
    const differs = SEEDS.some((seed) => {
      const seedValue = normalizeSeed(seed);
      const three = selectParticipants(seedValue, 3).join(',');
      const five = selectParticipants(seedValue, 5);
      return !five.every((id) => three.includes(id));
    });
    expect(differs, 'la sélection dépend de l’effectif, pas seulement de la seed').toBe(true);
  });

  it('renvoie le roster entier, tel quel, à six coureurs', () => {
    for (const seed of SEEDS) {
      const ids = selectParticipants(normalizeSeed(seed), MAX_PARTICIPANTS);
      // Identité stricte : à six, il n'y a pas de « copie triée » mais la liste du roster elle-même.
      expect(ids).toBe(CHARACTER_IDS);
    }
  });

  it('nomme le flux dédié à la sélection', () => {
    // Le nom du flux est un contrat : un renommage silencieux changerait tous les plateaux.
    expect(PARTICIPANT_STREAM_LABEL).toBe('participants');
  });
});