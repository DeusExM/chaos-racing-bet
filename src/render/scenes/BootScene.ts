import { Scene } from 'phaser';

import { createCharacterTextures } from '../characterShapes';

/**
 * Scène de démarrage.
 *
 * Elle ne charge encore aucun fichier : la V1 de P005 n'a aucun asset, les personnages sont des
 * silhouettes générées. C'est ici que P014 branchera le chargement des vrais visuels, sans que rien
 * d'autre ne change.
 */
export class BootScene extends Scene {
  constructor() {
    super('boot');
  }

  create(): void {
    this.cameras.main.setBackgroundColor('#0b0f1e');
    createCharacterTextures(this);
    this.scene.start('race');
  }
}
