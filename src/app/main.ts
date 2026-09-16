import { AUTO, Game, Scene } from 'phaser';

/** Résolution de référence (16:9). Le redimensionnement réel arrive en P005. */
const GAME_WIDTH = 1280;
const GAME_HEIGHT = 720;

/**
 * Scène vide.
 *
 * P001 ne valide que la chaîne outillage (build, typecheck, tests, montage du canvas).
 * Aucune logique de course, aucun personnage, aucun rendu de piste n'appartient à cette
 * étape : la première course visible est l'objet de P005.
 */
class Placeholder extends Scene {
  constructor() {
    super('placeholder');
  }
}

function bootstrap(): void {
  const parent = document.getElementById('game');
  if (!parent) {
    throw new Error("Élément #game introuvable dans index.html.");
  }

  new Game({
    type: AUTO,
    parent,
    width: GAME_WIDTH,
    height: GAME_HEIGHT,
    backgroundColor: '#0b0f1e',
    scene: [Placeholder],
  });
}

bootstrap();
