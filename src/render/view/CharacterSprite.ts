import type { GameObjects, Scene } from 'phaser';
import { BlendModes } from 'phaser';

import type { CharacterConfig } from '../../core/characters';
import { MAX_PARTICIPANTS } from '../../core/participants';
import type { CharacterId, CharacterState } from '../../core/types';
import { characterTextureKey } from '../characterAssets';
import { eventVisualOf, NO_EVENT_VISUAL, type EventVisual } from './eventVisualModel';
import {
  VIEW,
  characterHeightPx,
  characterNameFontPx,
  characterNameOrigin,
  characterNameX,
  characterNameY,
  laneBand,
  laneY,
  type LaneBand,
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
 *
 * ## Nom et retour d'événement
 *
 * Le nom vit **dans la voie**, à gauche du personnage : la course va de gauche à droite, donc le nom
 * est « derrière » lui au sens de la course, jamais dessous. Les effets de bonus et de malus
 * (`eventVisualModel.ts`) sont, eux, posés **sous** le sprite — un halo et une traînée, jamais une
 * écriture : ils lisent l'état déjà calculé et ne peuvent pas déplacer le personnage.
 */
export class CharacterSprite {
  private readonly image: GameObjects.Image;

  /** Halo d'événement : une copie agrandie de l'image, très peu opaque, toujours sous le sprite. */
  private readonly aura: GameObjects.Image;

  /** Traînée d'événement : une copie décalée vers l'arrière, pour suggérer l'élan ou le freinage. */
  private readonly trail: GameObjects.Image;

  private readonly nameLabel: GameObjects.Text;

  private readonly edgeMarker: GameObjects.Text;

  private readonly characterId: CharacterId;

  private readonly laneIndex: number;

  /**
   * Nombre de partants de la course, fixé à la construction.
   *
   * Il décide de la hauteur du sprite et de l'espacement des voies. Un sprite appartient à **une**
   * course : changer le nombre de coureurs reconstruit les sprites (`RaceScene`), il ne les
   * redimensionne jamais en place — sinon une course à trois garderait six voies.
   */
  private readonly participants: number;

  private readonly name: string;

  /** Ratio largeur/hauteur de la texture, lu une fois : il ne dépend ni de la frame, ni du format. */
  private readonly aspectRatio: number;

  private heightPx = VIEW.CHARACTER_HEIGHT_PX;

  private widthPx = VIEW.CHARACTER_HEIGHT_PX;

  private fontSizePx = VIEW.CHARACTER_NAME_FONT_PX;

  /**
   * Bande des voies de la course, calculée par `layout()`.
   *
   * Elle dépend de l'effectif : c'est elle, et non une constante de format, qui décide de l'ordonnée
   * de chaque voie. La valeur initiale ne sert qu'avant le premier `layout()`, qui est toujours appelé
   * avant le premier placement.
   */
  private band: LaneBand = laneBand(MAX_PARTICIPANTS, false);

  /** État visuel courant, décidé par le modèle pur à partir du seul événement actif. */
  private visual: EventVisual = NO_EVENT_VISUAL;

  /** Temps **réel** accumulé depuis le début de l'événement courant : il ne sert qu'à la pulsation. */
  private pulseMs = 0;

  private visualKind: EventVisual['kind'] = 'none';

  /** Mode de fusion déjà appliqué aux effets : évite de reconstruire le pipeline à chaque image. */
  private blendKind: EventVisual['kind'] = 'none';

  constructor(scene: Scene, character: CharacterConfig, laneIndex: number, participants: number) {
    this.characterId = character.id;
    this.laneIndex = laneIndex;
    this.participants = participants;
    this.name = character.name;

    this.image = scene.add.image(0, 0, characterTextureKey(character.id));
    this.image.setOrigin(0.5, 0.5);
    // La texture est déjà chargée (`BootScene.preload()`), donc `width`/`height` sont ceux du fichier.
    this.aspectRatio = this.image.width / this.image.height;

    // Les deux copies d'effet partagent la texture du personnage : aucun asset n'est ajouté, et le
    // halo se déforme donc exactement comme lui. Elles sont masquées tant qu'aucun événement n'est
    // actif, et leur profondeur est **sous** tous les sprites.
    this.aura = scene.add.image(0, 0, characterTextureKey(character.id));
    this.aura.setOrigin(0.5, 0.5);
    this.aura.setBlendMode(BlendModes.ADD);
    this.aura.setVisible(false);

    this.trail = scene.add.image(0, 0, characterTextureKey(character.id));
    this.trail.setOrigin(0.5, 0.5);
    this.trail.setVisible(false);

    this.nameLabel = scene.add.text(0, 0, character.name, {
      fontFamily: 'system-ui, sans-serif',
      fontSize: `${String(VIEW.CHARACTER_NAME_FONT_PX)}px`,
      color: '#e8ecf8',
    });
    const origin = characterNameOrigin();
    this.nameLabel.setOrigin(origin.x, origin.y);

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
   * La hauteur logique reçue vaut `VIEW.BASE_HEIGHT` dans les deux formats : ce qui change, c'est la
   * **cible** (`characterHeightPx(participants, compact)`), plus grande en petit paysage parce que la
   * zone des voies y est plus haute, et plus grande aussi quand la course aligne moins de coureurs —
   * la bande des voies est alors partagée entre moins de monde. Le facteur proportionnel et le
   * plancher ne servent qu'à rester lisible si la hauteur logique changeait un jour : ils n'autorisent
   * jamais un affichage non proportionnel à la texture.
   */
  layout(heightPx: number, compact = false): void {
    const target = characterHeightPx(this.participants, compact);
    this.heightPx = Math.max(
      VIEW.CHARACTER_MIN_HEIGHT_PX,
      Math.min(target, heightPx * (target / VIEW.BASE_HEIGHT)),
    );
    this.widthPx = this.heightPx * this.aspectRatio;

    const fontTarget = characterNameFontPx(this.participants, compact);
    this.fontSizePx = Math.max(9, Math.min(fontTarget, heightPx * (fontTarget / VIEW.BASE_HEIGHT)));

    // La bande des voies est calculée **une fois** ici, avec la hauteur logique réellement reçue :
    // elle dépend de l'effectif (voir `laneBand`), et tous les placements suivants la relisent.
    this.band = laneBand(this.participants, compact);

    this.image.setDisplaySize(this.widthPx, this.heightPx);
    this.applyVisualScale();
    this.nameLabel.setFontSize(this.fontSizePx);
    this.edgeMarker.setFontSize(this.fontSizePx);
  }

  /**
   * Applique l'état visuel d'un événement, à partir de l'état **déjà lu** de cette frame.
   *
   * `realDtMs` n'est utilisé que pour la pulsation : c'est du temps réel d'affichage, jamais du temps
   * simulé. Aucun tirage, aucune écriture, aucun pas de simulation.
   */
  updateEventVisual(character: CharacterState, realDtMs: number): void {
    let visual = eventVisualOf(character, this.pulseMs);
    // Un nouvel événement repart d'une pulsation neuve : la phase ne dépend donc que de sa durée.
    if (visual.kind !== this.visualKind) {
      this.visualKind = visual.kind;
      this.pulseMs = 0;
      visual = eventVisualOf(character, 0);
    }
    this.pulseMs += Number.isFinite(realDtMs) && realDtMs > 0 ? realDtMs : 0;
    this.visual = visual;
    this.applyBlendMode(visual.kind);

    this.image.setTint(this.visual.tint);
    // `this.drawn` vient du sprite lui-même : un personnage masqué (hors du champ, sous la bande
    // réservée au classement) ne laisse donc jamais voir son halo ni sa traînée.
    this.aura.setVisible(this.drawn && this.visual.auraAlpha > 0);
    this.aura.setTint(this.visual.auraTint);
    this.aura.setAlpha(this.visual.auraAlpha);
    this.trail.setVisible(this.drawn && this.visual.trailAlpha > 0);
    this.trail.setTint(this.visual.auraTint);
    this.trail.setAlpha(this.visual.trailAlpha);
    this.applyVisualScale();
  }

  /**
   * Applique le mode de fusion des effets, **uniquement quand il change**.
   *
   * `setBlendMode` reconstruit le pipeline de rendu : l'appeler soixante fois par seconde et par
   * personnage coûtait des images sans rien apporter, puisque le mode ne dépend que de la nature de
   * l'événement (`bonus` → additif, `malus` → normal).
   */
  private applyBlendMode(kind: EventVisual['kind']): void {
    if (kind === this.blendKind) {
      return;
    }
    this.blendKind = kind;
    const mode = kind === 'bonus' ? BlendModes.ADD : BlendModes.NORMAL;
    this.aura.setBlendMode(mode);
    this.trail.setBlendMode(mode);
  }

  /** Taille du halo : il suit la taille du sprite, et déborde donc **autour** de la silhouette. */
  private applyVisualScale(): void {
    const scale = this.visual.auraScale;
    this.aura.setDisplaySize(this.widthPx * scale, this.heightPx * scale);
    this.trail.setDisplaySize(this.widthPx, this.heightPx);
  }

  /**
   * Positionne le personnage à partir de sa distance et de la voie qui lui est réservée.
   *
   * Le nom suit le personnage horizontalement, mais **derrière** lui au sens de la course : à sa
   * gauche, sur l'axe de sa voie, séparé du sprite par `CHARACTER_NAME_GAP_PX`. Il ne consomme donc
   * aucune hauteur, et il n'est jamais recouvert par l'illustration. Le halo et la traînée suivent la
   * même position : le halo se superpose au sprite, la traînée s'en écarte vers l'arrière.
   */
  place(screenX: number): void {
    const y = laneY(this.laneIndex, this.band, this.participants);
    this.image.setPosition(screenX, y);
    this.aura.setPosition(screenX, y);
    this.trail.setPosition(screenX - this.widthPx * this.visual.trailOffsetRatio, y);
    this.nameLabel.setPosition(
      characterNameX(screenX, this.widthPx),
      characterNameY(y),
    );
    const depth = VIEW.CHARACTER_SPRITE_DEPTH_BASE + this.laneIndex;
    this.image.setDepth(depth);
    // Les effets passent **sous** tous les sprites : un halo ne recouvre jamais un autre coureur.
    this.aura.setDepth(VIEW.CHARACTER_EFFECT_DEPTH_BASE + this.laneIndex);
    this.trail.setDepth(VIEW.CHARACTER_EFFECT_DEPTH_BASE + this.laneIndex);
    this.nameLabel.setDepth(VIEW.CHARACTER_NAME_DEPTH);
  }

  /** Signale un personnage sorti de la fenêtre, collé au bord correspondant. */
  showEdgeMarker(side: 'left' | 'right', widthPx: number): void {
    const x = side === 'left' ? VIEW.EDGE_MARGIN_PX : widthPx - VIEW.EDGE_MARGIN_PX;
    this.edgeMarker.setText(side === 'left' ? `◀ ${this.name}` : `${this.name} ▶`);
    this.edgeMarker.setPosition(x, laneY(this.laneIndex, this.band, this.participants));
    this.edgeMarker.setDepth(80);
    this.edgeMarker.setVisible(true);
  }

  /** Masque le marqueur dès que le personnage revient dans la fenêtre. */
  hideEdgeMarker(): void {
    this.edgeMarker.setVisible(false);
  }

  /**
   * Détruit les objets Phaser du sprite.
   *
   * Appelé quand l'**effectif** d'une course change : un sprite appartient à une course et à une voie,
   * donc les sprites d'une course à six ne peuvent pas servir une course à trois. Les objets sont
   * réellement détruits (et non cachés) : aucune silhouette d'une course précédente ne peut rester
   * dessinée, et rien ne s'accumule d'une course à l'autre.
   */
  destroy(): void {
    this.image.destroy();
    this.aura.destroy();
    this.trail.destroy();
    this.nameLabel.destroy();
    this.edgeMarker.destroy();
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
    // Les effets d'événement suivent la visibilité du sprite : rien de la course ne doit apparaître
    // dans la bande réservée au classement, pas même un halo.
    this.aura.setVisible(drawn && this.visual.auraAlpha > 0);
    this.trail.setVisible(drawn && this.visual.trailAlpha > 0);
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
   * Elle est **à gauche** du sprite (le nom est derrière le personnage dans le sens de la course) et
   * séparée de lui : le texte n'est donc jamais recouvert par l'illustration.
   */
  get nameX(): number {
    return this.nameLabel.x;
  }

  /**
   * Ordonnée réellement dessinée du nom, en pixels logiques.
   *
   * Elle est publiée pour qu'un test puisse prouver que le nom partage l'axe du personnage — donc
   * qu'il ne réserve aucune hauteur au-dessus du sprite.
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

  /** Nature de l'effet d'événement réellement appliqué : `none`, `bonus` ou `malus`. */
  get eventKind(): EventVisual['kind'] {
    return this.visual.kind;
  }

  /**
   * Opacité réellement appliquée au halo.
   *
   * Elle est publiée pour qu'un test puisse prouver que l'effet suit l'**événement réel** : nulle
   * quand aucun événement n'est actif, non nulle pendant un bonus ou un malus.
   */
  get auraAlpha(): number {
    return this.aura.alpha;
  }

  /** Opacité réellement appliquée à la traînée. */
  get trailAlpha(): number {
    return this.trail.alpha;
  }

  /** Décalage réel de la traînée vers l'arrière, en pixels logiques (toujours ≥ 0). */
  get trailOffset(): number {
    return this.image.x - this.trail.x;
  }

  /** Teinte réellement appliquée au sprite (`0xffffff` = aucune). */
  get spriteTint(): number {
    return this.image.tintTopLeft;
  }
}
