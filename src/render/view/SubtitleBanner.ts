import type { GameObjects, Scene } from 'phaser';

import { VIEW } from '../viewConfig';

/**
 * Bandeau de commentaire : **affichage uniquement** (P009-C).
 *
 * Il ne sait rien du speaker, des faits, des RNG ou des règles de parole : il reçoit une chaîne
 * déjà décidée et déjà formatée, la montre, puis la cache. La source de vérité de ce qui est dit —
 * et de ce qui est coupé — reste `Speaker` ; la durée d'affichage, elle, est une propriété **UI**
 * décidée par `src/app/` (voir `SUBTITLE_DISPLAY_MS`), jamais une règle du speaker.
 *
 * Aucun texte n'est écrit ici : pas de libellé par défaut, pas de placeholder, rien. Un bandeau sans
 * texte est un bandeau masqué.
 *
 * Le visuel est volontairement rudimentaire — un fond translucide et une ligne de texte — le soin
 * graphique appartient à P012.
 */
export class SubtitleBanner {
  private readonly background: GameObjects.Graphics;

  private readonly label: GameObjects.Text;

  private text = '';

  private visible = false;

  private layoutWidth: number;

  private layoutHeight: number;

  constructor(scene: Scene) {
    this.layoutWidth = VIEW.BASE_WIDTH;
    this.layoutHeight = VIEW.BASE_HEIGHT;

    this.background = scene.add.graphics();
    this.label = scene.add.text(0, 0, '', {
      fontFamily: 'sans-serif',
      fontSize: `${String(VIEW.SUBTITLE_FONT_PX)}px`,
      fontStyle: 'bold',
      color: '#ffffff',
      align: 'center',
      wordWrap: { width: VIEW.BASE_WIDTH - 80 },
    });
    this.label.setOrigin(0.5, 0.5);

    // Au-dessus de la piste et des personnages : le commentaire ne doit jamais être recouvert.
    this.background.setDepth(20);
    this.label.setDepth(21);

    this.applyLayout();
    this.setVisible(false);
  }

  /**
   * Affiche une réplique, ou masque le bandeau si la chaîne est vide.
   *
   * Remplacer un texte par un autre est instantané, et c'est exactement ce que veut la préemption :
   * la réplique coupée disparaît sans retour, elle n'est jamais remise en file par le rendu.
   */
  show(text: string): void {
    this.text = text;
    if (text.length === 0) {
      this.setVisible(false);
      return;
    }
    this.label.setText(text);
    this.applyLayout();
    this.setVisible(true);
  }

  hide(): void {
    this.text = '';
    this.setVisible(false);
  }

  /** Texte réellement dessiné dans la dernière frame : `''` quand le bandeau est masqué. */
  visibleText(): string {
    return this.visible ? this.text : '';
  }

  /** Redessine le fond à la taille courante : appelé au démarrage et à chaque redimensionnement. */
  layout(widthPx: number, heightPx: number): void {
    this.layoutWidth = widthPx;
    this.layoutHeight = heightPx;
    this.applyLayout();
  }

  private setVisible(visible: boolean): void {
    this.visible = visible;
    this.label.setVisible(visible);
    this.background.setVisible(visible);
  }

  private applyLayout(): void {
    const centreX = this.layoutWidth / 2;
    const height = VIEW.SUBTITLE_HEIGHT_PX;
    const top = this.layoutHeight - VIEW.SUBTITLE_BOTTOM_MARGIN_PX - height;
    const width = this.layoutWidth - 2 * VIEW.SUBTITLE_BOTTOM_MARGIN_PX;

    this.label.setPosition(centreX, top + height / 2);
    this.label.setWordWrapWidth(width - 40, true);

    this.background.clear();
    this.background.fillStyle(0x05070f, 0.78);
    this.background.fillRoundedRect(VIEW.SUBTITLE_BOTTOM_MARGIN_PX, top, width, height, 10);
    this.background.lineStyle(2, 0x4a5c94, 1);
    this.background.strokeRoundedRect(VIEW.SUBTITLE_BOTTOM_MARGIN_PX, top, width, height, 10);
  }
}
