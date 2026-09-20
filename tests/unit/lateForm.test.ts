import { describe, expect, it } from 'vitest';

import { CHARACTER_IDS } from '../../src/core/characters';
import { GAME_CONFIG, LATE_FORM, RACE_CONFIG, validateConfig } from '../../src/core/config';
import { RaceEngine } from '../../src/core/engine';
import {
  LATE_FORM_STREAM_PREFIX,
  drawLateForm,
  lateFormFactor,
  lateFormParams,
  lateFormProgress,
  lateFormStreamLabel,
} from '../../src/core/lateForm';
import { forkStream } from '../../src/core/rng';
import { normalizeSeed } from '../../src/core/seed';
import type { GameConfig } from '../../src/core/config';
import { corpusSeeds } from '../../tools/balanceStats';

/**
 * Forme de fin de course (P013-cor6).
 *
 * La règle : chaque personnage reçoit **une** forme relative, tirée uniformément dans
 * `[−0,16 ; +0,16]` sur le flux dédié `lateform:<charId>`, nulle jusqu'à 40 s, linéaire jusqu'à 50 s,
 * puis complète jusqu'à l'arrivée. Elle multiplie la vitesse **cible**, jamais `x`.
 *
 * Ce fichier vérifie la **règle** (bornes, rampe, symétrie, déterminisme, stabilité par personnage).
 * La comparaison statistique « ancienne production / production » vit dans
 * `tests/unit/suspenseAudit.test.ts`, et l'inertie avant 40 s est prouvée là-bas aussi.
 */
describe('forme de fin de course (règle de jeu)', () => {
  const params = lateFormParams(GAME_CONFIG);
  const fromStep = 40 * 60;
  const fullAtStep = 50 * 60;

  it('tire ses bornes des constantes de jeu, jamais d’une valeur locale', () => {
    expect(LATE_FORM.AMPLITUDE).toBe(0.16);
    expect(LATE_FORM.FROM_S).toBe(40);
    expect(LATE_FORM.FULL_S).toBe(50);
    expect(params).toEqual({ amplitude: 0.16, fromStep, fullAtStep });
    expect(lateFormParams(GAME_CONFIG)).toEqual(params);
    expect(Object.isFrozen(params)).toBe(true);
  });

  it('refuse une configuration de forme incohérente', () => {
    const broken = (lateForm: GameConfig['LATE_FORM']): GameConfig => ({ ...GAME_CONFIG, LATE_FORM: lateForm });

    expect(() => validateConfig(broken({ ...LATE_FORM, AMPLITUDE: 0 }))).toThrow(RangeError);
    expect(() => validateConfig(broken({ ...LATE_FORM, AMPLITUDE: 1.5 }))).toThrow(RangeError);
    expect(() => validateConfig(broken({ ...LATE_FORM, FROM_S: -1 }))).toThrow(RangeError);
    expect(() => validateConfig(broken({ ...LATE_FORM, FULL_S: 0 }))).toThrow(RangeError);
    // Une rampe qui ne monte pas, ou qui dépasse la course, est refusée.
    expect(() => validateConfig(broken({ ...LATE_FORM, FULL_S: LATE_FORM.FROM_S }))).toThrow(RangeError);
    expect(() => validateConfig(broken({ ...LATE_FORM, FULL_S: 61 }))).toThrow(RangeError);
    expect(() => validateConfig(GAME_CONFIG)).not.toThrow();
  });

  it('monte linéairement de 0 % à 40 s jusqu’à 100 % à 50 s, puis maintient', () => {
    const factor = (form: number, seconds: number): number =>
      lateFormFactor(form, Math.round(seconds * 60), params);

    // 0 % à 40 s **inclus** : le pas 2400 ne subit rien, le pas 2401 est le premier touché.
    expect(factor(0.16, 40)).toBe(1);
    expect(factor(0.16, 40 - 1 / 60)).toBe(1);
    expect(lateFormProgress(fromStep + 1, params)).toBeGreaterThan(0);
    // Interpolation linéaire, exacte aux points de contrôle.
    expect(factor(0.16, 45)).toBeCloseTo(1.08, 12);
    expect(factor(0.16, 47.5)).toBeCloseTo(1.12, 12);
    expect(factor(0.16, 50)).toBeCloseTo(1.16, 12);
    // Maintenu jusqu'à l'arrivée : aucune retombée.
    expect(factor(0.16, 55)).toBeCloseTo(1.16, 12);
    expect(factor(0.16, 59)).toBeCloseTo(1.16, 12);
    expect(factor(0.16, 60)).toBeCloseTo(1.16, 12);
    expect(lateFormProgress(RACE_CONFIG.TOTAL_STEPS, params)).toBe(1);
    // Symétrie exacte : une forme négative freine d'autant.
    expect(factor(-0.16, 45)).toBeCloseTo(0.92, 12);
    expect(factor(-0.16, 60)).toBeCloseTo(0.84, 12);
    // Une forme nulle est inerte à tout pas : le moteur court-circuite la multiplication.
    for (const seconds of [0, 40, 45, 50, 60]) {
      expect(factor(0, seconds)).toBe(1);
      expect(lateFormFactor(0, Math.round(seconds * 60), params)).toBe(1);
    }
  });

  it('tire une seule valeur par personnage, dans les bornes, sur un flux dédié', () => {
    const seed = 'KR7Z8NAR';
    const seedValue = normalizeSeed(seed);
    const engine = new RaceEngine(seed, GAME_CONFIG, { players: 6 });

    expect(engine.lateForms).toHaveLength(CHARACTER_IDS.length);
    for (const form of engine.lateForms) {
      expect(Math.abs(form)).toBeLessThanOrEqual(LATE_FORM.AMPLITUDE);
    }
    // La valeur du noyau est exactement le premier tirage du flux du personnage, et rien d'autre.
    engine.participantIds.forEach((id, slot) => {
      const stream = forkStream(seedValue, lateFormStreamLabel(id));
      expect(engine.lateForms[slot]).toBe(drawLateForm(stream, params));
    });
    expect(lateFormStreamLabel('c5')).toBe(`${LATE_FORM_STREAM_PREFIX}c5`);
    // Le flux est indépendant de ceux du moteur : `drift:*` n'est pas consommé.
    const drift = forkStream(seedValue, 'drift:c0').next();
    const lateForm = forkStream(seedValue, lateFormStreamLabel('c0')).next();
    expect(lateForm).not.toBe(drift);
  });

  it('reste déterministe et se recalcule à chaque seed, y compris après reset', () => {
    const first = new RaceEngine('KR7Z8NAR', GAME_CONFIG, { players: 6 });
    const again = new RaceEngine('KR7Z8NAR', GAME_CONFIG, { players: 6 });
    expect(again.lateForms).toEqual(first.lateForms);

    first.reset('MFFX4731');
    const other = new RaceEngine('MFFX4731', GAME_CONFIG, { players: 6 });
    expect(first.lateForms).toEqual(other.lateForms);
    expect(other.lateForms).not.toEqual(again.lateForms);
  });

  it('ne fait dépendre la forme que de (seed, charId), jamais de l’effectif', () => {
    for (const seed of ['KR7Z8NAR', 'ZZZZZZZZ', '00000000']) {
      const reference = new RaceEngine(seed, GAME_CONFIG, { players: 6 });
      const byId = new Map(reference.participantIds.map((id, slot) => [id, reference.lateForms[slot]]));

      for (const players of [3, 4, 5]) {
        const engine = new RaceEngine(seed, GAME_CONFIG, { players });
        expect(engine.participantIds).toHaveLength(players);
        engine.participantIds.forEach((id, slot) => {
          expect(engine.lateForms[slot], `${seed} / ${id} à ${String(players)}`).toBe(byId.get(id));
        });
      }
    }
  });

  it('ne produit aucun effet physique avant 40 s, pour 3, 4, 5 et 6 partants', () => {
    for (const players of [3, 4, 5, 6]) {
      const withRule = new RaceEngine('KR7Z8NAR', GAME_CONFIG, { players });
      const legacy = new RaceEngine('KR7Z8NAR', GAME_CONFIG, { players, disableLateForm: true });

      // Mesure uniquement : la variante sans règle sert de témoin de l'ancienne production.
      expect(legacy.lateForms.every((form) => form === 0)).toBe(true);
      let firstDifference = -1;
      while (withRule.getState().phase.kind !== 'finished') {
        withRule.step();
        legacy.step();
        const left = withRule.getState();
        const right = legacy.getState();
        if (firstDifference === -1) {
          const same = left.characters.every((character, slot) => {
            const other = right.characters[slot];
            return (
              other !== undefined &&
              Object.is(character.x, other.x) &&
              Object.is(character.v, other.v) &&
              Object.is(character.drift, other.drift)
            );
          });
          if (!same) {
            firstDifference = left.steps;
          }
        }
      }
      // Premier pas **après** la borne : 2401. Jamais 2400.
      expect(firstDifference, `${String(players)} partants`).toBe(fromStep + 1);
    }
  });

  it('tire une loi uniforme centrée et symétrique sur un millier de seeds', () => {
    const seeds = corpusSeeds(1_000);
    const perSeed = seeds.map((seed) => new RaceEngine(seed, GAME_CONFIG, { players: 6 }).lateForms);
    const draws = perSeed.flatMap((forms) => forms);

    expect(draws).toHaveLength(6_000);
    const mean = draws.reduce((sum, value) => sum + value, 0) / draws.length;
    expect(Math.abs(mean)).toBeLessThan(0.02);
    expect(Math.min(...draws)).toBeLessThan(-0.155);
    expect(Math.max(...draws)).toBeGreaterThan(0.155);

    // Symétrie : autant de formes positives que négatives, à 4 écarts-types près.
    const positives = draws.filter((value) => value > 0).length;
    expect(Math.abs(positives - draws.length / 2)).toBeLessThan(4 * Math.sqrt(draws.length) / 2);

    // Uniformité : quatre classes de même largeur, chacune attendue à 25 % de 6 000 tirages
    // (soit 1 500), avec une tolérance de 4 écarts-types.
    const bins = [0, 0, 0, 0];
    for (const value of draws) {
      const index = Math.min(3, Math.floor((value + LATE_FORM.AMPLITUDE) / (LATE_FORM.AMPLITUDE / 2)));
      bins[index] = (bins[index] ?? 0) + 1;
    }
    for (const count of bins) {
      expect(count).toBeGreaterThan(1_300);
      expect(count).toBeLessThan(1_700);
    }

    // Aucun personnage n'est structurellement favorisé : les six moyennes restent centrées.
    CHARACTER_IDS.forEach((id, slot) => {
      const perCharacter = perSeed.map((forms) => forms[slot] ?? 0);
      const characterMean = perCharacter.reduce((sum, value) => sum + value, 0) / perCharacter.length;
      expect(Math.abs(characterMean), id).toBeLessThan(0.02);
    });
  });
});