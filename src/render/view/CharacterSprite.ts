import type { GameObjects, Scene } from 'phaser';

import type { CharacterConfig } from '../../core/characters';
import type { CharacterId } from '../../core/types';
import { characterTextureKey } from '../characterShapes';
import { VIEW, laneY } from '../viewConfig';

/**
 * Un personnage à l'écran.
 *
 * Tout ce qui est affiché vient de la distance `x` du noyau et de sa position dans le roster :
 * `place()` ne fait que **positionner**, jamais calculer une position de course. Aucune écriture
 * dans `x`, `v`, `drift` ou le classement n'est possible depuis ce fichier.
 */
export class CharacterSprite {
  private readonly image: GameObjects.Image;

  private readonly nameLabel: GameObjects.Text;

  private readonly edgeMarker: GameObjects.Text;

  private readonly characterId: CharacterId;

  private readonly laneIndex: number;

  private readonly name: string;

  private sizePx = VIEW.CHARACTER_SIZE_PX;

  private fontSizePx = 14;

  constructor(scene: Scene, character: CharacterConfig, laneIndex: number) {
    this.characterId = character.id;
    this.laneIndex = laneIndex;
    this.name = character.name;

    this.image = scene.add.image(0, 0, characterTextureKey(character.id));
    this.image.setOrigin(0.5, 0.5);

    this.nameLabel = scene.add.text(0, 0, character.name, {
      fontFamily: 'system-ui, sans-serif',
      fontSize: '14px',
      color: '#e8ecf8',
    });
    this.nameLabel.setOrigin(0.5, 1);

    this.edgeMarker = scene.add.text(0, 0, '', {
      fontFamily: 'system-ui, sans-serif',
      fontSize: '14px',
      color: '#ffd166',
      backgroundColor: '#00000080',
      padding: { left: 4, right: 4, top: 2, bottom: 2 },
    });
    this.edgeMarker.setOrigin(0.5, 0.5);
    this.edgeMarker.setVisible(false);
  }

  /** Adapte la taille à la hauteur du canvas. Le rendu ne dépend jamais de la taille des sprites. */
  layout(heightPx: number): void {
    this.sizePx = Math.max(18, Math.min(VIEW.CHARACTER_SIZE_PX, heightPx * 0.08));
    this.fontSizePx = Math.max(9, Math.min(14, heightPx * 0.022));
    this.image.setDisplaySize(this.sizePx, this.sizePx);
    this.nameLabel.setFontSize(this.fontSizePx);
    this.edgeMarker.setFontSize(this.fontSizePx);
  }

  /** Positionne le personnage à partir de sa distance et de la voie qui lui est réservée. */
  place(screenX: number, heightPx: number): void {
    const y = laneY(this.laneIndex, heightPx);
    this.image.setPosition(screenX, y);
    this.nameLabel.setPosition(screenX, y - this.sizePx / 2 - 2);
    this.image.setDepth(10 + this.laneIndex);
    this.nameLabel.setDepth(60);
  }

  /** Signale un personnage sorti de la fenêtre, collé au bord correspondant. */
  showEdgeMarker(side: 'left' | 'right', widthPx: number, heightPx: number): void {
    const x = side === 'left' ? VIEW.EDGE_MARGIN_PX : widthPx - VIEW.EDGE_MARGIN_PX;
    this.edgeMarker.setText(side === 'left' ? `◀ ${this.name}` : `${this.name} ▶`);
    this.edgeMarker.setPosition(x, laneY(this.laneIndex, heightPx));
    this.edgeMarker.setDepth(80);
    this.edgeMarker.setVisible(true);
  }

  /** Masque le marqueur dès que le personnage revient dans la fenêtre. */
  hideEdgeMarker(): void {
    this.edgeMarker.setVisible(false);
  }

  /**
   * Dessine ou masque le personnage.
   *
   * Un personnage hors du champ est **masqué** plutôt que dessiné sous le classement permanent
   * (passe corrective 2) : le HUD occupe une bande réservée de l'arène, et rien de la course ne doit
   * s'y trouver, même partiellement. Il n'est pas perdu pour le spectateur : `showEdgeMarker()`
   * affiche son nom collé au bord de la piste.
   */
  setDrawn(drawn: boolean): void {
    this.image.setVisible(drawn);
    this.nameLabel.setVisible(drawn);
  }

  /** Taille réellement dessinée, en pixels logiques. */
  get size(): number {
    return this.sizePx;
  }

  /** Vrai si le personnage est réellement dessiné dans cette frame. */
  get drawn(): boolean {
    return this.image.visible;
  }

  /** Identifiant stable du personnage représenté. */
  get id(): CharacterId {
    return this.characterId;
  }

  /**
   * Position écran réelle du sprite.
   *
   * Elle est lue sur l'objet Phaser lui-même plutôt que recalculée : ce que renvoie le debug est
   * donc exactement ce qui est dessiné, sans risque d'écart entre les deux.
   */
  get screenX(): number {
    return this.image.x;
  }

  get screenY(): number {
    return this.image.y;
  }
}
