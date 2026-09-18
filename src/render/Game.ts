import { AUTO, Game, Scale } from 'phaser';

import type { RaceSimulation } from '../sim/RaceSimulation';
import { BootScene } from './scenes/BootScene';
import { RaceScene } from './scenes/RaceScene';
import type { CommentaryView } from './scenes/RaceScene';
import type { UiText } from './uiText';
import type { FinishActions } from './view/FinishPanel';
import { arenaBaseSize, isCompactViewport, type ArenaSize } from './viewport';

/** Dépendances injectées par `src/app/` : le rendu ne crée ni ne possède la simulation. */
export interface GameOptions {
  readonly parent: HTMLElement;
  readonly simulation: RaceSimulation;
  readonly text: UiText;
  /** Racine du HUD en HTML (`.hud`) : le HUD y installe ses blocs. */
  readonly hudRoot: HTMLElement | null;
  readonly status: HTMLElement | null;
  readonly banner: HTMLElement | null;
  readonly leaderboard: HTMLElement | null;
  readonly seedValue: HTMLElement | null;
  readonly pauseButton: HTMLElement | null;
  /** Racine de la barre de relecture (`#replay-bar`) : remplie par le rendu, masquée hors pause. */
  readonly replayBar: HTMLElement | null;
  readonly debugPanel: HTMLElement | null;
  readonly debug: boolean;
  /** Expose les positions écran réelles (dev ou `?e2e=1`), pour les tests E2E. */
  readonly exposeView: boolean;
  /** Commentaire du speaker, ou `null` : le rendu ne le crée pas, il l'affiche. */
  readonly commentary: CommentaryView | null;
  /** Actions de l'écran d'arrivée (P013), fournies par `app/` : seed, URL et redémarrage. */
  readonly finishActions: FinishActions;
}

/**
 * Monte le jeu Phaser.
 *
 * `Scale.FIT` garde l'arène entière visible quelle que soit la fenêtre — la scène est cadrée comme
 * un plan large, jamais rognée — et `autoRound` évite les demi-pixels. La conséquence assumée est
 * que les textes **dessinés dans le canvas** rétrécissent avec la fenêtre : c'est pourquoi tout ce
 * qui doit rester lisible (classement, état, debug) est en HTML au-dessus du canvas.
 *
 * ## Taille logique et petit paysage
 *
 * En petit paysage, l'écran est partagé entre la piste et la colonne du HUD : la piste n'a donc plus
 * le rapport 16:9. La taille logique est alors choisie pour **remplir exactement** la boîte de la
 * piste (`arenaBaseSize`) : sans cela, `Scale.FIT` ajouterait des bandes vides et, plus grave, le
 * canvas ne coïnciderait plus avec la colonne du HUD qui lui fait face — les badges d'événement,
 * posés en pourcentage de la piste, seraient décalés. La taille est réajustée au redimensionnement
 * (rotation du téléphone, barre d'URL qui se replie), sans jamais toucher à la simulation : seuls le
 * cadrage et la taille des sprites changent.
 */
export function createGame(options: GameOptions): void {
  const raceScene = new RaceScene({
    simulation: options.simulation,
    text: options.text,
    hudRoot: options.hudRoot,
    status: options.status,
    banner: options.banner,
    leaderboard: options.leaderboard,
    seedValue: options.seedValue,
    pauseButton: options.pauseButton,
    replayBar: options.replayBar,
    debugPanel: options.debugPanel,
    debug: options.debug,
    exposeView: options.exposeView,
    commentary: options.commentary,
    finishActions: options.finishActions,
  });

  const base = arenaBaseSizeFor(options.parent);

  const game = new Game({
    type: AUTO,
    parent: options.parent,
    width: base.width,
    height: base.height,
    backgroundColor: '#0b0f1e',
    scale: {
      mode: Scale.ScaleModes.FIT,
      autoCenter: Scale.Center.CENTER_BOTH,
      autoRound: true,
    },
    scene: [new BootScene(), raceScene],
  });

  // Le canvas suit la boîte de la piste tant qu'elle change : la mise en page CSS décide, le rendu
  // s'aligne. `setGameSize` est l'API prévue pour `Scale.FIT` (elle change la taille **de base**,
  // pas la taille du canvas), et la scène relit `scale.width/height` à la frame suivante.
  window.addEventListener('resize', () => {
    const next = arenaBaseSizeFor(options.parent);
    if (next.width !== game.scale.width || next.height !== game.scale.height) {
      game.scale.setGameSize(next.width, next.height);
    }
  });
}

/** Taille logique de l'arène d'après la boîte réellement occupée par la piste. */
function arenaBaseSizeFor(parent: HTMLElement): ArenaSize {
  const box = parent.getBoundingClientRect();
  return arenaBaseSize(box.width, box.height, isCompactViewport());
}
