import { AUTO, Game, Scale } from 'phaser';

import type { RaceSimulation } from '../sim/RaceSimulation';
import { BootScene } from './scenes/BootScene';
import { RaceScene } from './scenes/RaceScene';
import type { UiText } from './uiText';
import { VIEW } from './viewConfig';

/** Dépendances injectées par `src/app/` : le rendu ne crée ni ne possède la simulation. */
export interface GameOptions {
  readonly parent: HTMLElement;
  readonly simulation: RaceSimulation;
  readonly text: UiText;
  readonly leaderboard: HTMLElement | null;
  readonly status: HTMLElement | null;
  readonly debugPanel: HTMLElement | null;
  readonly debug: boolean;
  /** Expose les positions écran réelles (dev ou `?e2e=1`), pour les tests E2E. */
  readonly exposeView: boolean;
}

/**
 * Monte le jeu Phaser.
 *
 * `Scale.FIT` garde l'arène entière visible quelle que soit la fenêtre — la scène est cadrée comme
 * un plan large, jamais rognée — et `autoRound` évite les demi-pixels. La conséquence assumée est
 * que les textes **dessinés dans le canvas** rétrécissent avec la fenêtre : c'est pourquoi tout ce
 * qui doit rester lisible (classement, état, debug) est en HTML au-dessus du canvas.
 */
export function createGame(options: GameOptions): void {
  const raceScene = new RaceScene({
    simulation: options.simulation,
    text: options.text,
    leaderboard: options.leaderboard,
    status: options.status,
    debugPanel: options.debugPanel,
    debug: options.debug,
    exposeView: options.exposeView,
  });

  new Game({
    type: AUTO,
    parent: options.parent,
    width: VIEW.BASE_WIDTH,
    height: VIEW.BASE_HEIGHT,
    backgroundColor: '#0b0f1e',
    scale: {
      mode: Scale.ScaleModes.FIT,
      autoCenter: Scale.Center.CENTER_BOTH,
      autoRound: true,
    },
    scene: [new BootScene(), raceScene],
  });
}
