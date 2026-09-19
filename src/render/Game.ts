import { AUTO, Game, Scale } from 'phaser';

import type { RaceSimulation } from '../sim/RaceSimulation';
import type { SimPhase } from '../sim/types';
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
  /**
   * Vrai quand la course peut avancer.
   *
   * `app/` la rend fausse quand l'écran de rotation recouvre tout (téléphone tenu droit) : le noyau ne
   * reçoit alors **aucun** pas, exactement comme pendant une pause, et la course ne peut donc pas se
   * jouer derrière l'écran. Le rendu ne fait que **lire** cette permission.
   */
  readonly allowsGameplay: () => boolean;
  /**
   * Annonce chaque changement de phase temps réel à `app/`.
   *
   * Utilisé par le sélecteur du nombre de coureurs, qui n'est modifiable qu'avant une course : le
   * rendu ne connaît pas ce contrôle, il signale seulement **quand** la phase change.
   */
  readonly onPhase?: ((phase: SimPhase) => void) | undefined;
}

/**
 * Poignée rendue par `createGame` : de quoi réappliquer le cadrage sans recréer le jeu.
 *
 * C'est `app/` qui décide **quand** (`viewportWatch` annonce une taille stabilisée) ; le rendu décide
 * **comment**. Aucun module n'écoute donc la fenêtre pour son propre compte.
 */
export interface GameHandle {
  /** Réapplique la taille logique de l'arène d'après la boîte réellement occupée par la piste. */
  refreshScale(): void;
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
 *
 * ## Qui décide du moment
 *
 * Pas ce module : Phaser écoute la fenêtre pour son propre compte, et sur iOS cette écoute arrive
 * pendant la rotation, quand la taille annoncée n'est pas encore la bonne. `app/` attend donc une
 * taille **stabilisée** (`viewportWatch`) puis appelle `refreshScale()` — c'est la seule différence
 * avec l'ancien `addEventListener('resize')` local, qui recadrait sur la première valeur venue.
 */
export function createGame(options: GameOptions): GameHandle {
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
    allowsGameplay: options.allowsGameplay,
    onPhase: options.onPhase,
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
  // s'aligne. `setGameSize` est l'API prévue pour `Scale.FIT` (elle change la taille **de base**, pas
  // la taille du canvas), et la scène relit `scale.width/height` à la frame suivante.
  //
  // ## Pourquoi la taille logique est calculée sur une boîte **arrondie vers le bas**
  //
  // En mode `FIT`, Phaser déduit la taille d'affichage du canvas de la taille du parent et du **rapport
  // de la taille logique**, avec des arrondis internes (`Math.floor`). Une taille logique calculée sur
  // une largeur fractionnaire — le moteur de rendu en produit (573,921875 px pour la colonne du HUD à
  // 844 × 390) — donnait donc un canvas d'un pixel plus petit que sa boîte, et **pas toujours le même**
  // selon l'instant de la mesure : c'est ce qui faisait différer le cadrage d'un lancement direct de
  // celui d'un retour de rotation, pour le même écran. En arrondissant la boîte **vers le bas**, dans
  // le même sens que Phaser, la taille logique devient déterministe — et tout ce qui en découle aussi.
  //
  // La boîte arrondie sert **uniquement** à choisir la taille logique : elle n'est jamais imposée à
  // Phaser (`setParentSize`), car un rapport d'aspect légèrement plus étroit que celui de l'arène
  // ferait rétrécir la hauteur du canvas d'un pixel — un défaut pire que celui qu'on corrige.
  //
  // ## Pourquoi `refresh` est rappelé **après** `setGameSize`
  //
  // `ScaleManager.refresh` fait deux choses dans cet ordre : il recalcule la taille d'affichage à
  // partir de la taille de parent **mémorisée**, puis il relit la boîte réelle. Le `refresh` déclenché
  // par `setGameSize` travaille donc sur une taille de parent périmée — celle mesurée avant la
  // rotation — et laisse un canvas d'un pixel de travers, que rien ne venait ensuite corriger. Le
  // `refresh` explicite qui suit relit la boîte à jour : le cadrage d'un retour de rotation devient
  // alors identique, au pixel près, à celui d'un lancement direct.
  const applyScale = (): { readonly width: number; readonly height: number } => {
    const box = options.parent.getBoundingClientRect();
    const width = Math.floor(box.width);
    const height = Math.floor(box.height);
    const next = arenaBaseSize(width, height, isCompactViewport());
    if (next.width !== game.scale.width || next.height !== game.scale.height) {
      game.scale.setGameSize(next.width, next.height);
    }
    game.scale.refresh();
    return { width, height };
  };

  return {
    refreshScale: () => {
      const applied = applyScale();
      // **Une seule** vérification, à la frame suivante : après une rotation, la mesure peut avoir été
      // prise juste avant que la feuille de style ne se stabilise, et la boîte gagne alors le pixel qui
      // manquait. C'est le repli borné de cette passe : on recalcule une fois, on ne recharge jamais.
      window.requestAnimationFrame(() => {
        const box = options.parent.getBoundingClientRect();
        if (Math.floor(box.width) !== applied.width || Math.floor(box.height) !== applied.height) {
          applyScale();
        }
      });
    },
  };
}

/** Taille logique de l'arène d'après la boîte réellement occupée par la piste. */
function arenaBaseSizeFor(parent: HTMLElement): ArenaSize {
  const box = parent.getBoundingClientRect();
  return arenaBaseSize(Math.floor(box.width), Math.floor(box.height), isCompactViewport());
}
