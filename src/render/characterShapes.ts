import type { GameObjects, Scene } from 'phaser';

import { CHARACTERS } from '../core/characters';
import type { CharacterId } from '../core/types';
import { VIEW } from './viewConfig';

/**
 * Formes placeholder des 6 personnages.
 *
 * Chaque personnage reçoit une **silhouette distincte** et sa couleur, pour rester identifiable même
 * quand le peloton est serré : c'est un choix de lisibilité, pas une caractéristique de jeu — les
 * six personnages restent strictement équivalents en simulation. Les vrais visuels arriveront plus
 * tard (P014) : tout ce qui est produit ici est remplaçable sans toucher au noyau.
 */

/** Nombre de côtés du polygone régulier, par index de personnage. `0` signifie « rond ». */
const POLYGON_SIDES: readonly number[] = [0, 4, 3, 4, 6, 5];

/** Clé de texture d'un personnage. */
export function characterTextureKey(id: CharacterId): string {
  return `character-${id}`;
}

/** Convertit une couleur `#rrggbb` du noyau en entier Phaser. */
function hexToInt(hex: string): number {
  return Number.parseInt(hex.replace('#', ''), 16);
}

/** Remplit un polygone régulier en éventail de triangles, sans dépendre des API de polygone. */
function fillRegularPolygon(
  graphics: GameObjects.Graphics,
  center: number,
  radius: number,
  sides: number,
  rotation: number,
  color: number,
): void {
  graphics.fillStyle(color, 1);
  for (let index = 0; index < sides; index += 1) {
    const start = rotation + (2 * Math.PI * index) / sides;
    const end = rotation + (2 * Math.PI * (index + 1)) / sides;
    graphics.fillTriangle(
      center,
      center,
      center + radius * Math.cos(start),
      center + radius * Math.sin(start),
      center + radius * Math.cos(end),
      center + radius * Math.sin(end),
    );
  }
}

/** Dessine la silhouette d'un personnage dans un carré de `size` pixels. */
function drawShape(graphics: GameObjects.Graphics, index: number, size: number, color: number): void {
  const center = size / 2;
  const radius = center - 3;
  const sides = POLYGON_SIDES[index] ?? 0;

  if (sides === 0) {
    graphics.fillStyle(color, 1);
    graphics.fillCircle(center, center, radius);
    return;
  }

  // Le triangle pointe vers l'avant (à droite) : le sens de lecture de la course.
  const rotation = sides === 3 ? 0 : -Math.PI / 2;
  fillRegularPolygon(graphics, center, radius, sides, rotation, color);
}

/**
 * Crée une texture par personnage, une seule fois.
 *
 * Les textures sont générées au démarrage plutôt que chargées depuis des fichiers : la V1 de P005
 * n'a aucun asset, et un placeholder dessiné est plus honnête qu'un faux fichier image.
 */
export function createCharacterTextures(scene: Scene): void {
  const size = VIEW.CHARACTER_SIZE_PX;

  for (const [index, character] of CHARACTERS.entries()) {
    const key = characterTextureKey(character.id);
    if (scene.textures.exists(key)) {
      continue;
    }

    const graphics = scene.add.graphics();
    drawShape(graphics, index, size, hexToInt(character.color));
    graphics.generateTexture(key, size, size);
    graphics.destroy();
  }
}
