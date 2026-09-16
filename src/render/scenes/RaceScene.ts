import { Scene } from 'phaser';

import { CHARACTERS } from '../../core/characters';
import type { RaceSimulation } from '../../sim/RaceSimulation';
import { leaderboardOf } from '../../sim/leaderboard';
import type { UiText } from '../uiText';
import { VIEW } from '../viewConfig';
import { installViewDebug } from '../viewDebug';
import { CameraRig } from '../view/CameraRig';
import { CharacterSprite } from '../view/CharacterSprite';
import { DebugPanel } from '../view/DebugPanel';
import { LeaderboardView } from '../view/LeaderboardView';
import { TrackView } from '../view/TrackView';

/** Tout ce dont la scène de course a besoin, fourni par `src/app/`. */
export interface RaceSceneOptions {
  readonly simulation: RaceSimulation;
  readonly text: UiText;
  readonly leaderboard: HTMLElement | null;
  readonly status: HTMLElement | null;
  readonly debugPanel: HTMLElement | null;
  readonly debug: boolean;
  /** Expose les positions écran réelles pour les tests E2E. */
  readonly exposeView: boolean;
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

  private layoutHeight = 0;

  private layoutWidth = 0;

  constructor(options: RaceSceneOptions) {
    super('race');
    this.options = options;
  }

  create(): void {
    this.track = new TrackView(this, this.options.text);

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
    this.updateStatus();
    this.debug?.update(state, this.options.simulation.phase, this.options.simulation.timeScale);
  }

  /** État de la course, en HTML : lisible même quand le canvas est réduit. */
  private updateStatus(): void {
    const element = this.options.status;
    if (element === null) {
      return;
    }
    const phase = this.options.simulation.phase;
    const label =
      phase === 'idle'
        ? this.options.text.statusIdle
        : phase === 'running'
          ? this.options.text.statusRunning
          : this.options.text.statusFinished;
    if (element.textContent !== label) {
      element.textContent = label;
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
    for (const sprite of this.sprites) {
      sprite.layout(height);
    }
  }
}
