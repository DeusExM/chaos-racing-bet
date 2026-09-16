import type { CharacterId } from './types';

/**
 * Roster des 6 personnages.
 *
 * Ces données sont **purement cosmétiques**. Aucun personnage ne porte de caractéristique : la
 * structure elle-même l'interdit, puisqu'elle ne comporte **aucun champ numérique** et donc aucun
 * endroit où glisser un avantage. Les six configurations sont strictement identiques en dehors de
 * l'identité visuelle, et `assertAllCharactersEquivalent()` le vérifie.
 *
 * Les noms sont des libellés **provisoires** ; les noms et les silhouettes définitifs arrivent avec
 * l'identité visuelle (P014). Les identifiants, eux, ne changeront jamais : ils servent de
 * départage déterministe au classement.
 */
export interface CharacterConfig {
  readonly id: CharacterId;
  /** Libellé provisoire, affiché au public. */
  readonly name: string;
  /** Couleur d'identité, au format `#rrggbb`. */
  readonly color: string;
}

/**
 * Identifiants du roster, dans l'ordre d'itération de la physique.
 *
 * Cet ordre est celui des index stables `0..5` : on n'itère jamais un `Set` ni une `Map` pour la
 * simulation, et le départage des égalités suit cet ordre.
 */
export const CHARACTER_IDS: readonly CharacterId[] = Object.freeze([
  'c0',
  'c1',
  'c2',
  'c3',
  'c4',
  'c5',
]);

/**
 * Champs autorisés d'une configuration de personnage, dans l'ordre alphabétique.
 *
 * Cette liste est volontairement fermée : ajouter un champ — et donc, un jour, un « bonus » par
 * personnage — fait échouer `assertAllCharactersEquivalent()`. Toute nouvelle donnée cosmétique
 * devra donc être ajoutée ici **consciemment**.
 */
const CHARACTER_KEYS: readonly string[] = Object.freeze(['color', 'id', 'name']);

/** Fige une fiche de personnage : `Object.freeze` sur le tableau ne suffit pas à figer ses éléments. */
function frozenCharacter(character: CharacterConfig): CharacterConfig {
  return Object.freeze(character);
}

/** Les 6 personnages, dans l'ordre du roster. */
export const CHARACTERS: readonly CharacterConfig[] = Object.freeze([
  frozenCharacter({ id: 'c0', name: 'Mamie Nitro', color: '#e6194b' }),
  frozenCharacter({ id: 'c1', name: 'Saucisse Mécanique', color: '#3cb44b' }),
  frozenCharacter({ id: 'c2', name: 'Poulet 3000', color: '#4363d8' }),
  frozenCharacter({ id: 'c3', name: 'Jean-Michel Turbo', color: '#f58231' }),
  frozenCharacter({ id: 'c4', name: 'Bananix', color: '#911eb4' }),
  frozenCharacter({ id: 'c5', name: 'Gérard le Paladin', color: '#42d4f4' }),
]);

/**
 * Vérifie que le roster est bien celui des 6 personnages équivalents.
 *
 * Contrôle trois choses : l'effectif, l'identité exacte des identifiants dans l'ordre du roster, et
 * l'égalité **structurelle** des six configurations (mêmes champs, dans la même forme). C'est ce
 * dernier point qui garantit qu'aucun personnage ne peut recevoir un modificateur permanent.
 *
 * Lève une `Error` au premier écart. Appelable avec un roster arbitraire, pour tester justement
 * qu'un roster divergent est refusé.
 */
export function assertAllCharactersEquivalent(
  characters: readonly CharacterConfig[] = CHARACTERS,
): void {
  if (characters.length !== CHARACTER_IDS.length) {
    throw new Error(
      `Le roster doit contenir exactement ${CHARACTER_IDS.length} personnages (reçu : ${characters.length}).`,
    );
  }

  const referenceKeys = CHARACTER_KEYS.join(',');

  for (const [index, character] of characters.entries()) {
    const expectedId = CHARACTER_IDS[index];
    if (character.id !== expectedId) {
      throw new Error(
        `Roster incohérent à l'index ${index} : identifiant attendu « ${expectedId} », reçu « ${character.id} ».`,
      );
    }

    const keys = Object.keys(character).sort().join(',');
    if (keys !== referenceKeys) {
      throw new Error(
        `Personnage « ${character.id} » : champs [${keys}] au lieu de [${referenceKeys}]. Les 6 configurations doivent être structurellement identiques.`,
      );
    }
  }
}
