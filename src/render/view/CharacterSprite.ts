import type { GameObjects, Scene } from 'phaser';

import type { CharacterConfig } from '../../core/characters';
import type { CharacterId } from '../../core/types';
import { characterTextureKey } from '../characterAssets';
import {
  VIEW,
  characterHeightPx,
  characterNameFontPx,
  characterNameOrigin,
  characterNameX,
  characterNameY,
  laneY,
} from '../viewConfig';

/**
 * Un personnage à l'écran.
 *
 * Tout ce qui est affiché vient de la distance `x` du noyau et de sa position dans le roster :
 * `place()` ne fait que **positionner**, jamais calculer une position de course. Aucune écriture
 * dans `x`, `v`, `drift` ou le classement n'est possible depuis ce fichier.
 *
 * ## Taille et forme
 *
 * Le visuel est un PNG (voir `characterAssets.ts`) dont seule la **hauteur** est choisie
 * (`VIEW.CHARACTER_HEIGHT_PX`) : la largeur se déduit du ratio de la texture, donc l'image n'est
 * jamais écrasée en carré, et la résolution du fichier n'est jamais utilisée comme taille d'affichage.
 * C'est ce qui permet de garder des originaux haute résolution pour les écrans denses.
 */
export class CharacterSprite {
  private readonly image: GameObjects.Image;

  private readonly nameLabel: GameObjects.Text;

  private readonly edgeMarker: GameObjects.Text;

  private readonly characterId: CharacterId;

  private readonly laneIndex: number;

  private readonly name: string;

  /** Ratio largeur/hauteur de la texture, lu une fois : il ne dépend ni de la frame, ni du format. */
  private readonly aspectRatio: number;

  private heightPx = VIEW.CHARACTER_HEIGHT_PX;

  private widthPx = VIEW.CHARACTER_HEIGHT_PX;

  private fontSizePx = VIEW.CHARACTER_NAME_FONT_PX;

  constructor(scene: Scene, character: CharacterConfig, laneIndex: number) {
    this.characterId = character.id;
    this.laneIndex = laneIndex;
    this.name = character.name;

    this.image = scene.add.image(0, 0, characterTextureKey(character.id));
    this.image.setOrigin(0.5, 0.5);
    // La texture est déjà chargée (`BootScene.preload()`), donc `width`/`height` sont ceux du fichier.
    this.aspectRatio = this.image.width / this.image.height;

    this.nameLabel = scene.add.text(0, 0, character.name, {
      fontFamily: 'system-ui, sans-serif',
      fontSize: `${String(VIEW.CHARACTER_NAME_FONT_PX)}px`,
      color: '#e8ecf8',
    });
    this.nameLabel.setOrigin(0.5, 1);

    this.edgeMarker = scene.add.text(0, 0, '', {
      fontFamily: 'system-ui, sans-serif',
      fontSize: `${String(VIEW.CHARACTER_NAME_FONT_PX)}px`,
      color: '#ffd166',
      backgroundColor: '#00000080',
      padding: { left: 4, right: 4, top: 2, bottom: 2 },
    });
    this.edgeMarker.setOrigin(0.5, 0.5);
    this.edgeMarker.setVisible(false);
  }

  /**
   * Adapte la taille au format courant. Le rendu ne dépend jamais de la taille des sprites.
   *
   * La hauteur logique reçue vaut `VIEW.BASE_HEIGHT` dans les deux formats : ce qui change en petit
   * paysage, c'est la **cible** (`CHARACTER_HEIGHT_COMPACT_PX`), plus grande, parce que la zone des
   * voies y est plus haute. Le facteur proportionnel et le plancher ne servent qu'à rester lisible si
   * la hauteur logique changeait un jour — ils n'autorisent jamais un affichage non proportionnel à
   * la texture.
   */
  layout(heightPx: number, compact = false): void {
    const target = characterHeightPx(compact);
    this.heightPx = Math.max(
      VIEW.CHARACTER_MIN_HEIGHT_PX,
      Math.min(target, heightPx * (target / VIEW.BASE_HEIGHT)),
    );
    this.widthPx = this.heightPx * this.aspectRatio;

    const fontTarget = characterNameFontPx(compact);
    this.fontSizePx = Math.max(9, Math.min(fontTarget, heightPx * (fontTarget / VIEW.BASE_HEIGHT)));

    this.image.setDisplaySize(this.widthPx, this.heightPx);
    this.nameLabel.setFontSize(this.fontSizePx);
    this.edgeMarker.setFontSize(this.fontSizePx);
    // Le nom est ancré par son bord droit en petit paysage (il est posé à gauche du personnage) et
    // centré ailleurs : l'origine fait partie du format, comme la taille.
    const origin = characterNameOrigin(compact);
    this.nameLabel.setOrigin(origin.x, origin.y);
  }

  /**
   * Positionne le personnage à partir de sa distance et de la voie qui lui est réservée.
   *
   * Le nom suit le personnage horizontalement, mais **derrière** lui au sens de la course : à sa
   * gauche, sur l'axe de sa voie, séparé du sprite par `CHARACTER_NAME_GAP_PX`. Il ne consomme donc
   * aucune hauteur, et il n'est jamais recouvert par l'illustration. Sur bureau, il reste centré
   * juste au-dessus de la tête.
   */
  place(screenX: number, heightPx: number, compact = false): void {
    const y = laneY(this.laneIndex, heightPx, compact);
    this.image.setPosition(screenX, y);
    this.nameLabel.setPosition(
      characterNameX(screenX, this.widthPx, compact),
      characterNameY(y, this.heightPx, compact),
    );
    this.image.setDepth(VIEW.CHARACTER_SPRITE_DEPTH_BASE + this.laneIndex);
    this.nameLabel.setDepth(VIEW.CHARACTER_NAME_DEPTH);
  }

  /** Signale un personnage sorti de la fenêtre, collé au bord correspondant. */
  showEdgeMarker(side: 'left' | 'right', widthPx: number, heightPx: number, compact = false): void {
    const x = side === 'left' ? VIEW.EDGE_MARGIN_PX : widthPx - VIEW.EDGE_MARGIN_PX;
    this.edgeMarker.setText(side === 'left' ? `◀ ${this.name}` : `${this.name} ▶`);
    this.edgeMarker.setPosition(x, laneY(this.laneIndex, heightPx, compact));
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
   * s'y trouver, même partiellement — pas même la marge transparente de l'image. Il n'est pas perdu
   * pour le spectateur : `showEdgeMarker()` affiche son nom collé au bord de la piste.
   */
  setDrawn(drawn: boolean): void {
    this.image.setVisible(drawn);
    this.nameLabel.setVisible(drawn);
  }

  /** Largeur réellement dessinée, en pixels logiques : elle vient du ratio de la texture. */
  get width(): number {
    return this.widthPx;
  }

  /** Hauteur réellement dessinée, en pixels logiques. */
  get height(): number {
    return this.heightPx;
  }

  /**
   * Demi-largeur du sprite : c'est elle qui décide si le personnage tient **entièrement** dans la
   * piste. La supposer carrée (ancien placeholder) laisserait dépasser les images, qui sont plus
   * larges que hautes.
   */
  get halfWidth(): number {
    return this.widthPx / 2;
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

  /**
   * Abscisse réellement dessinée du nom, en pixels logiques.
   *
   * En petit paysage, elle est **à gauche** du sprite (le nom est derrière le personnage dans le sens
   * de la course) et séparée de lui : le texte n'est donc jamais recouvert par l'illustration.
   */
  get nameX(): number {
    return this.nameLabel.x;
  }

  /**
   * Ordonnée réellement dessinée du nom, en pixels logiques.
   *
   * Elle est publiée pour qu'un test puisse prouver que le nom partage l'axe du personnage en petit
   * paysage — donc qu'il ne réserve aucune hauteur au-dessus du sprite.
   */
  get nameY(): number {
    return this.nameLabel.y;
  }

  /** Profondeur réelle du nom : elle est **au-dessus** des sprites, dans les deux formats. */
  get nameDepth(): number {
    return this.nameLabel.depth;
  }

  /** Profondeur réelle du sprite. */
  get depth(): number {
    return this.image.depth;
  }
}