import { describe, expect, it } from 'vitest';

import { RaceCommentary } from '../../src/app/RaceCommentary';
import { SPEAKER_CATALOGUE_FR } from '../../src/app/strings.fr';
import { RaceEngine } from '../../src/core/engine';
import { forkStream } from '../../src/core/rng';
import type { RaceFact, RaceFactType } from '../../src/core/types';
import type { SpeakerCatalogue } from '../../src/render/subtitle';
import { RaceSimulation } from '../../src/sim/RaceSimulation';
import { SIM_FAST_CONFIG, SIM_CONFIG } from '../../src/sim/config';

/**
 * P009-C — flux `speaker:lines` et invariance du gameplay.
 *
 * Deux propriétés, et une seule manière de les prouver : comparer des **distances finales**.
 *
 * 1. Le tirage des variantes est déterministe pour une seed donnée, et il ne consomme **jamais** un
 *    flux du noyau (`drift:*`, `surge:*`, `events:*`).
 * 2. Ajouter, retirer ou réécrire le catalogue de textes ne change **aucune** distance, bit à bit.
 */

/** Seeds dorées : deux courses réelles, aucune campagne — le noyau est déjà couvert par P009-B. */
const GOLDEN_SEEDS: readonly string[] = Object.freeze(['POULET42', 'K7QM2X9A']);

/**
 * Compose un catalogue dont **toutes** les variantes sont identiques : `speaker:lines` est donc
 * encore consommé, mais le texte affiché trahit immédiatement quel catalogue a parlé. C'est ce qui
 * permet de comparer deux catalogues sans rejouer deux fois le même.
 */
function catalogueFrom(name: string): SpeakerCatalogue {
  const lines: Partial<Record<RaceFactType, readonly ((fact: RaceFact) => string)[]>> = {};
  for (const type of Object.keys(SPEAKER_CATALOGUE_FR.lines) as RaceFactType[]) {
    lines[type] = Object.freeze([() => `${name}-${type}`]);
  }
  return Object.freeze({ lines: Object.freeze(lines as Record<RaceFactType, readonly ((fact: RaceFact) => string)[]>) });
}

/** Catalogue où **aucun** type n'a de variante : le speaker doit refuser de parler. */
function emptyCatalogue(): SpeakerCatalogue {
  const lines: Partial<Record<RaceFactType, readonly ((fact: RaceFact) => string)[]>> = {};
  for (const type of Object.keys(SPEAKER_CATALOGUE_FR.lines) as RaceFactType[]) {
    lines[type] = Object.freeze([]);
  }
  return Object.freeze({ lines: Object.freeze(lines as Record<RaceFactType, readonly ((fact: RaceFact) => string)[]>) });
}

const ALT_CATALOGUE = catalogueFrom('AUTRE');

/** Une course complète, jouée par pas, avec le commentaire branché et ses textes relevés. */
function runCommentedRace(
  seed: string,
  catalogue: SpeakerCatalogue = SPEAKER_CATALOGUE_FR,
): { distances: readonly number[]; texts: readonly string[] } {
  const simulation = new RaceSimulation(seed, SIM_FAST_CONFIG);
  const commentary = new RaceCommentary(simulation.view.seedValue, catalogue);
  simulation.onFacts((facts) => {
    commentary.feedFacts(facts);
  });
  simulation.start();

  const texts: string[] = [];
  let guard = 0;
  while (simulation.phase !== 'finished' && guard < 20_000) {
    simulation.update(100);
    commentary.update(SUBTITLE_STEP_MS);
    const line = commentary.currentLine();
    if (line !== null && texts[texts.length - 1] !== line.text) {
      texts.push(line.text);
    }
    guard += 1;
  }

  return { distances: simulation.view.characters.map((character) => character.x), texts };
}

/**
 * Pas réel d'avance du test : plus court que la durée d'affichage, donc chaque réplique reste
 * visible assez longtemps pour être relevée, et l'ordre des textes est celui des décisions.
 */
const SUBTITLE_STEP_MS = 200;

describe('P009-C : flux speaker:lines', () => {
  it('donne la même séquence de variantes pour la même seed', () => {
    const first = runCommentedRace('POULET42');
    const second = runCommentedRace('POULET42');
    expect(first.texts.length).toBeGreaterThan(0);
    expect(second.texts).toEqual(first.texts);
  });

  it('donne une séquence généralement différente pour une autre seed', () => {
    const first = runCommentedRace('POULET42');
    const second = runCommentedRace('K7QM2X9A');
    expect(second.texts).not.toEqual(first.texts);
  });

  it('repart exactement de la même séquence après un reset', () => {
    const simulation = new RaceSimulation('POULET42', SIM_FAST_CONFIG);
    const commentary = new RaceCommentary(simulation.view.seedValue, SPEAKER_CATALOGUE_FR);
    simulation.onFacts((facts) => commentary.feedFacts(facts));

    const texts: string[] = [];
    for (const pass of [0, 1]) {
      simulation.restart();
      commentary.reset(simulation.view.seedValue);
      simulation.start();
      const passTexts: string[] = [];
      let guard = 0;
      while (simulation.phase !== 'finished' && guard < 20_000) {
        simulation.update(100);
        commentary.update(SUBTITLE_STEP_MS);
        const line = commentary.currentLine();
        if (line !== null && passTexts[passTexts.length - 1] !== line.text) {
          passTexts.push(line.text);
        }
        guard += 1;
      }
      if (pass === 0) {
        texts.push(...passTexts);
      } else {
        expect(passTexts).toEqual(texts);
      }
    }
  });

  it('consommer 100 tirages de variantes ne touche aucun flux du noyau', () => {
    for (const seed of GOLDEN_SEEDS) {
      const seedValue = new RaceEngine(seed).getState().seedValue;
      const reference = new RaceEngine(seed).runToCompletion();

      const stream = forkStream(seedValue, 'speaker:lines');
      for (let index = 0; index < 100; index += 1) {
        stream.nextInt(0, 5);
      }

      const after = new RaceEngine(seed).runToCompletion();
      expect(after.distances).toEqual(reference.distances);
      expect(after.ranking).toEqual(reference.ranking);
    }
  });

  it('donne des distances identiques avec et sans speaker', () => {
    for (const seed of GOLDEN_SEEDS) {
      const reference = new RaceEngine(seed).runToCompletion();
      const commented = runCommentedRace(seed);
      expect(commented.distances).toEqual(reference.distances);
    }
  });

  it('donne des distances identiques en mode normal, en mode accéléré et avec pause', () => {
    for (const seed of GOLDEN_SEEDS) {
      const reference = new RaceEngine(seed).runToCompletion().distances;

      const normal = runCommentedRace(seed);
      expect(normal.distances).toEqual(reference);

      // Une pause réelle ne fait pas avancer le noyau : la reprise doit être identique, au bit près.
      const paused = new RaceSimulation(seed, SIM_CONFIG);
      const commentary = new RaceCommentary(paused.view.seedValue, SPEAKER_CATALOGUE_FR);
      paused.onFacts((facts) => commentary.feedFacts(facts));
      paused.start();
      let guard = 0;
      while (paused.phase !== 'finished' && guard < 200_000) {
        if (guard === 10) {
          paused.toggleUserPause();
        }
        if (guard === 40) {
          paused.toggleUserPause();
        }
        paused.update(1000 / 60);
        guard += 1;
      }
      expect(paused.view.characters.map((character) => character.x)).toEqual(reference);
    }
  });

  it('remplacer tout le catalogue par un autre ne change aucune distance finale', () => {
    for (const seed of GOLDEN_SEEDS) {
      const reference = runCommentedRace(seed);
      const alternative = runCommentedRace(seed, ALT_CATALOGUE);

      expect(alternative.distances).toEqual(reference.distances);
      // Le catalogue alternatif est bien celui qui a parlé : le test ne compare pas deux fois le même.
      expect(alternative.texts[0]).toContain('AUTRE-');
      expect(reference.texts[0]).not.toContain('AUTRE-');
    }
  });

  it('refuse un catalogue sans variante pour un type, plutôt que d’afficher du vide', () => {
    // Tous les types sont vides : quel que soit celui que le speaker choisit en premier, le
    // catalogue est incomplet. Le test ne dépend donc ni d'une seed ni d'une détection particulière.
    expect(() => runCommentedRace('POULET42', emptyCatalogue())).toThrow(RangeError);
  });
});