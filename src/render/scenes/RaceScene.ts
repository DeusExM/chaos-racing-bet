import { Scene } from 'phaser';

import { CHARACTERS } from '../../core/characters';
import type { RaceSimulation } from '../../sim/RaceSimulation';
import type { SimPhase } from '../../sim/types';
import { leaderboardOf } from '../../sim/leaderboard';
import type { SpeakerLine } from '../subtitle';
import type { UiText } from '../uiText';
import { VIEW } from '../viewConfig';
import { installViewDebug } from '../viewDebug';
import { CameraRig } from '../view/CameraRig';
import { CharacterSprite } from '../view/CharacterSprite';
import { DebugPanel } from '../view/DebugPanel';
import { LeaderboardView } from '../view/LeaderboardView';
import { SubtitleBanner } from '../view/SubtitleBanner';
import { TrackView } from '../view/TrackView';

/**
 * Réplique en cours de commentaire, telle que le rendu la lit.
 *
 * Le rendu ne décide rien : il reçoit la ligne déjà choisie et déjà formatée, et se contente de
 * l'afficher, puis de la retirer quand la source n'en fournit plus.
 */
export interface CommentaryView {
  /** Avance la montre d'affichage (temps réel) et rend la réplique visible, ou `null`. */
  update(realDtMs: number): void;
  /** Réplique à afficher dans cette frame, ou `null`. */
  currentLine(): SpeakerLine | null;
}

/** Tout ce dont la scène de course a besoin, fourni par `src/app/`. */
export interface RaceSceneOptions {
  readonly simulation: RaceSimulation;
  readonly text: UiText;
  readonly leaderboard: HTMLElement | null;
  readonly status: HTMLElement | null;
  /** Bannière de checkpoint : visible uniquement pendant la pause réelle. */
  readonly banner: HTMLElement | null;
  /** Bouton Pause / Reprendre : son libellé suit la phase, la commande est câblée par `app/`. */
  readonly pauseButton: HTMLElement | null;
  readonly debugPanel: HTMLElement | null;
  readonly debug: boolean;
  /** Expose les positions écran réelles pour les tests E2E. */
  readonly exposeView: boolean;
  /** Commentaire du speaker, ou `null` quand la course n'en a pas (tests unitaires, mode nu). */
  readonly commentary: CommentaryView | null;
}

/** Libellé d'état correspondant à une phase temps réel. Exhaustif par construction. */
function statusLabelFor(phase: SimPhase, text: UiText): string {
  switch (phase) {
    case 'idle':
      return text.statusIdle;
    case 'countdown':
      return text.statusCountdown;
    case 'running':
      return text.statusRunning;
    case 'checkpointPause':
      return text.statusCheckpointPause;
    case 'userPaused':
      return text.statusUserPaused;
    case 'finished':
      return text.statusFinished;
  }
}

/**
 * Scène de course : la seule à faire avancer le temps réel, et la seule à lire l'état du noyau.
 *
 * Elle **appelle** `simulation.update(delta)` puis se contente de **lire** l'état obtenu. Elle ne
 * modifie jamais une distance, une vitesse ou un rang : c'est la garantie que ce qui est affiché
 * est exactement ce que le noyau a calculé, et non une reconstruction parallèle.
 *
 * L'ordre des opérations dans `update()` est volontaire : le temps avance d'abord, puis tout
 * (sprites, classement, debug) est lu **dans le même instantané**. Le classement affiché ne peut
 * donc pas être décalé d'une frame par rapport aux positions affichées.
 */
export class RaceScene extends Scene {
  private readonly options: RaceSceneOptions;

  private readonly rig = new CameraRig();

  private sprites: readonly CharacterSprite[] = [];

  private track: TrackView | null = null;

  private leaderboard: LeaderboardView | null = null;

  private debug: DebugPanel | null = null;

  private subtitle: SubtitleBanner | null = null;

  /** Dernier texte poussé au bandeau : évite de redessiner le fond à chaque frame. */
  private shownSubtitle = '';

  private layoutHeight = 0;

  private layoutWidth = 0;

  constructor(options: RaceSceneOptions) {
    super('race');
    this.options = options;
  }

  create(): void {
    this.track = new TrackView(this, this.options.text);

    if (this.options.commentary !== null) {
      this.subtitle = new SubtitleBanner(this);
    }

    this.sprites = CHARACTERS.map(
      (character, index) => new CharacterSprite(this, character, index),
    );

    if (this.options.leaderboard !== null) {
      this.leaderboard = new LeaderboardView(this.options.leaderboard, this.options.text);
    }
    if (this.options.debug && this.options.debugPanel !== null) {
      this.debug = new DebugPanel(this.options.debugPanel, this.options.text);
    }

    if (this.options.exposeView) {
      installViewDebug({
        sprites: () =>
          this.sprites.map((sprite) => ({
            id: sprite.id,
            screenX: sprite.screenX,
            screenY: sprite.screenY,
          })),
        camera: () => ({ leftM: this.rig.left, windowM: this.rig.span }),
        subtitle: () => this.subtitle?.visibleText() ?? '',
      });
    }

    this.applyLayout();
  }

  override update(_time: number, delta: number): void {
    // 1. Le temps réel ne sert qu'ici, et il ne fait qu'autoriser des pas de taille fixe.
    this.options.simulation.update(delta);

    // 2. Un unique instantané, lu par toutes les vues de cette frame.
    const state = this.options.simulation.view;

    // 3. Le cadrage se déduit des distances : jamais l'inverse.
    this.rig.follow(state.characters.map((character) => character.x));

    this.applyLayout();
    this.track?.update(this.rig);

    for (const [index, sprite] of this.sprites.entries()) {
      const character = state.characters[index];
      if (character === undefined) {
        continue;
      }
      sprite.place(this.rig.toScreenX(character.x, this.layoutWidth), this.layoutHeight);
      if (this.rig.isOffscreen(character.x, this.layoutWidth)) {
        sprite.showEdgeMarker(
          this.rig.toScreenX(character.x, this.layoutWidth) < VIEW.EDGE_MARGIN_PX ? 'left' : 'right',
          this.layoutWidth,
          this.layoutHeight,
        );
      } else {
        sprite.hideEdgeMarker();
      }
    }

    this.leaderboard?.update(leaderboardOf(state));
    this.updateSubtitle(delta);
    this.updateHud();
    this.debug?.update(state, this.options.simulation.phase, this.options.simulation.timeScale);
  }

  /**
   * Commentaire : le rendu **lit** la réplique courante et l'affiche telle quelle.
   *
   * Aucune règle de parole n'est réécrite ici : la préemption, les cooldowns et la file sont tranchés
   * par le speaker, dans `src/speaker/`. Le bandeau ne fait que constater — et remplacer
   * immédiatement un texte par un autre, sans jamais remettre l'ancien.
   */
  private updateSubtitle(deltaMs: number): void {
    const commentary = this.options.commentary;
    if (commentary === null || this.subtitle === null) {
      return;
    }

    commentary.update(deltaMs);
    const text = commentary.currentLine()?.text ?? '';
    // Le conteneur redessine son fond : on ne le réécrit que lorsque la réplique change réellement.
    if (text !== this.shownSubtitle) {
      this.shownSubtitle = text;
      this.subtitle.show(text);
    }
  }

  /**
   * État, bannière de checkpoint et libellé du bouton de pause, en HTML : lisible même quand le
   * canvas est réduit, et jamais réécrit sans changement.
   *
   * La bannière n'apparaît **que** pendant la pause réelle : elle se déduit de la phase, donc elle
   * disparaît d'elle-même à la reprise, sans minuterie ni animation à entretenir.
   */
  private updateHud(): void {
    const phase = this.options.simulation.phase;

    setTextIfChanged(this.options.status, statusLabelFor(phase, this.options.text));
    setTextIfChanged(
      this.options.pauseButton,
      phase === 'userPaused' ? this.options.text.resumeButton : this.options.text.pauseButton,
    );

    const checkpoint = this.options.simulation.checkpoint;
    const showBanner = phase === 'checkpointPause' && checkpoint !== null;
    setTextIfChanged(
      this.options.banner,
      showBanner ? `${this.options.text.checkpointBanner} ${String(checkpoint)}` : '',
    );
    if (this.options.banner !== null) {
      this.options.banner.hidden = !showBanner;
    }
  }

  /** Réapplique la géométrie quand la taille du canvas change. */
  private applyLayout(): void {
    const width = this.scale.width;
    const height = this.scale.height;
    if (width === this.layoutWidth && height === this.layoutHeight) {
      return;
    }

    this.layoutWidth = width;
    this.layoutHeight = height;
    this.track?.layout(width, height);
    this.subtitle?.layout(width, height);
    for (const sprite of this.sprites) {
      sprite.layout(height);
    }
  }
}

/** Écrit un libellé dans un élément, seulement s'il change : le DOM n'est pas réécrit à chaque frame. */
function setTextIfChanged(element: HTMLElement | null, label: string): void {
  if (element !== null && element.textContent !== label) {
    element.textContent = label;
  }
}
