import { CHARACTERS } from '../../src/core/characters';
import type { CharacterId, RaceFact, RaceFactType } from '../../src/core/types';

/**
 * Faits d'exemple **partagés** par les tests de textes et de sous-titres.
 *
 * Un seul jeu de valeurs réalistes sert à la fois à vérifier la véracité des phrases
 * (`speakerTexts.test.ts`) et la lisibilité de leur durée d'affichage (`subtitleModel.test.ts`) : les
 * deux mesures portent ainsi sur exactement les mêmes phrases, ce qui évite qu'une constante de
 * durée soit calibrée sur un catalogue imaginaire.
 */

/** Fait conforme au contrat de `RaceFact`, fabriqué à la main. */
export function fact(
  type: RaceFactType,
  magnitudes: readonly number[],
  characterIds: readonly CharacterId[] = CHARACTERS.map((character) => character.id),
): RaceFact {
  return Object.freeze({
    type,
    tSim: 12,
    characterIds: Object.freeze([...characterIds]),
    magnitudes: Object.freeze([...magnitudes]),
    importance: 50,
    textKey: `fact.${type}`,
  });
}

/**
 * Magnitudes **réalistes** par type, dans l'ordre exact documenté par `GAME_DESIGN.md` §9.2.
 *
 * Elles servent à produire une phrase représentative de chaque variante : un test qui ne remplirait
 * pas correctement un placeholder mesurerait la robustesse des erreurs, pas la véracité.
 */
export const SAMPLE_MAGNITUDES: Readonly<Record<RaceFactType, readonly number[]>> = Object.freeze({
  LEADER_CHANGE: [3.24, 12.0],
  BIG_COMEBACK: [4, 2],
  OVERTAKE_STREAK: [5],
  // Une durée d'événement est un **tirage uniforme** : elle porte donc de nombreuses décimales.
  // L'échantillon le reflète, sinon un test peut passer alors qu'un joueur lit `6.133333333333333 s`.
  BIG_BONUS: [1.35, 6.133333333333333, 1],
  // Magnitude **réellement négative** : c'est ce que publie P009-A (`CHUTE` : `-0.6`, `SIESTE` : `-0.7`).
  LEADER_MALUS: [-0.6, 3.0666666666666664, 1],
  CLOSE_RACE: [8.42, 5.05],
  LAST_COMEBACK: [4, 3],
  CHECKPOINT_SPLIT: [812.4, 809.1, 804.6, 800.2, 798.9, 790.3],
  FINISH: [12.5, 2160.0, 2147.5],
  PHOTO_FINISH: [0.42, 2159.9, 2159.5],
});

export function sampleFact(type: RaceFactType): RaceFact {
  return fact(type, SAMPLE_MAGNITUDES[type]);
}
