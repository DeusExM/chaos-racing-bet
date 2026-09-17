import { Scene } from 'phaser';

import { preloadCharacterAssets } from '../characterAssets';

/**
 * Scène de démarrage : elle ne fait que **charger les six visuels**, puis passe la main.
 *
 * Le chargement vit ici, dans `preload()`, et non dans la scène de course : Phaser attend la fin du
 * chargement avant de créer la scène suivante, donc les textures existent toujours quand les
 * `CharacterSprite` sont construits. La course n'a aucun autre asset à charger.
 */
export class BootScene extends Scene {
  constructor() {
    super('boot');
  }

  preload(): void {
    preloadCharacterAssets(this);
  }

  create(): void {
    this.cameras.main.setBackgroundColor('#0b0f1e');
    this.scene.start('race');
  }
}