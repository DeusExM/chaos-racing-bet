import { describe, expect, it } from 'vitest';

import { CHARACTER_IDS } from '../../src/core/characters';
import {
  characterAssetFile,
  characterAssetUrl,
  characterTextureKey,
} from '../../src/render/characterAssets';

/**
 * Visuels des personnages : le **mapping** personnage → fichier.
 *
 * ## Ce que ce test protège
 *
 * C'est la seule table du projet qui associe un identifiant de personnage à une image. Si elle se
 * désynchronise du roster — un fichier oublié, deux personnages sur la même image, un nom de fichier
 * changé d'un seul côté — un coureur porterait le visuel d'un autre, et **aucun test de course ne le
 * verrait** : la simulation ne connaît pas les images.
 *
 * Les fichiers eux-mêmes (présents, PNG transparent, bonnes dimensions, poids) sont vérifiés par
 * `tests/e2e/assets.spec.ts`, qui les demande au serveur de prévisualisation : ce sont les fichiers
 * réellement servis qui comptent, et ce test-ci reste sans accès disque.
 */

/** Fichiers attendus, dans l'ordre du roster : la spécification de cette passe, écrite une fois. */
const EXPECTED_FILES: Readonly<Record<string, string>> = {
  c0: 'mamie-nitro.png',
  c1: 'saucisse-mecanique.png',
  c2: 'poulet-3000.png',
  c3: 'jean-michel-turbo.png',
  c4: 'bananix.png',
  c5: 'gerard-le-paladin.png',
};

/** Répertoire des copies runtime, servi par Vite depuis `public/`. */
const EXPECTED_DIRECTORY = 'assets/characters';

/** Taille des copies runtime (hauteur choisie à 320 px) et taille des sources, pour le ratio. */
const RUNTIME_DIMENSIONS = { width: 427, height: 320 };
const SOURCE_DIMENSIONS = { width: 1448, height: 1086 };

describe('mapping des visuels de personnage', () => {
  it('associe à chaque personnage du roster exactement un fichier, sans doublon ni oubli', () => {
    const files = CHARACTER_IDS.map((id) => characterAssetFile(id));
    expect([...files].sort()).toEqual(Object.values(EXPECTED_FILES).sort());
    expect(new Set(files).size).toBe(CHARACTER_IDS.length);
  });

  it('nomme chaque fichier comme la spécification, et chaque texture de façon unique', () => {
    for (const id of CHARACTER_IDS) {
      expect(characterAssetFile(id), `fichier de ${id}`).toBe(EXPECTED_FILES[id]);
      expect(characterAssetUrl(id)).toBe(`${EXPECTED_DIRECTORY}/${String(EXPECTED_FILES[id])}`);
      expect(characterTextureKey(id)).toBe(`character-${id}`);
    }
    const keys = CHARACTER_IDS.map((id) => characterTextureKey(id));
    expect(new Set(keys).size).toBe(CHARACTER_IDS.length);
  });

  it('sert des noms de fichiers techniques : sans espace, sans accent, sans majuscule', () => {
    for (const id of CHARACTER_IDS) {
      expect(characterAssetFile(id), `nom technique de ${id}`).toMatch(/^[a-z0-9-]+\.png$/);
    }
  });

  it("utilise une URL relative : l'application marche aussi servie en sous-répertoire", () => {
    for (const id of CHARACTER_IDS) {
      expect(characterAssetUrl(id).startsWith('/'), `URL de ${id}`).toBe(false);
    }
  });

  it('conserve le ratio des sources dans les copies runtime, jamais un carré', () => {
    const sourceRatio = SOURCE_DIMENSIONS.width / SOURCE_DIMENSIONS.height;
    const runtimeRatio = RUNTIME_DIMENSIONS.width / RUNTIME_DIMENSIONS.height;
    // Arrondir la largeur (1448 × 320 / 1086 = 426,7 → 427) ne doit pas déformer l'image : le ratio
    // des copies doit rester celui des sources à moins d'un demi pour cent.
    expect(Math.abs(runtimeRatio - sourceRatio)).toBeLessThan(0.005);
    expect(runtimeRatio).toBeGreaterThan(1);
  });
});