import { Scene } from 'phaser';

import { CHARACTERS } from '../../core/characters';
import type { RaceSimulation } from '../../sim/RaceSimulation';
import type { SimPhase } from '../../sim/types';
import type { SpeakerLine } from '../subtitle';
import type { UiText } from '../uiText';
import { VIEW } from '../viewConfig';
import { installViewDebug } from '../viewDebug';
import { CameraRig } from '../view/CameraRig';
import { CharacterSprite } from '../view/CharacterSprite';
import { buildDebugModel } from '../view/debugModel';
import { DebugPanel } from '../view/DebugPanel';
import { Hud } from '../view/Hud';
import { buildHudModel } from '../view/hudModel';
import { SubtitleBanner } from '../view/SubtitleBanner';
import { TrackView } from '../view/TrackView';

/**
 * Réplique en cours de commentaire, telle que le rendu la lit.
 *
 * Le rendu ne décide rien : il reçoit la ligne déjà choisie et déjà formatée, et se contente de
 * l'afficher, puis de la retirer quand la source n'en fournit plus.
 */
export interface CommentaryView {
  /**
   * Avance la montre d'affichage (temps réel) puis retente la parole au temps simulé **courant**.
   *
   * `simNowS` est un simple nombre : le commentaire ne connaît ni le moteur ni la simulation.
   */
  update(realDtMs: number, simNowS?: number): void;
  /** Réplique à afficher dans cette frame, ou `null`. */
  currentLine(): SpeakerLine | null;
}

/** Tout ce dont la scène de course a besoin, fourni par `src/app/`. */
export interface RaceSceneOptions {
  readonly simulation: RaceSimulation;
  readonly text: UiText;
  /** Racine du HUD en HTML : le `Hud` en devient propriétaire et y installe ses blocs. */
  readonly hudRoot: HTMLElement | null;
  readonly status: HTMLElement | null;
  /** Bannière de checkpoint : visible uniquement pendant la pause réelle. */
  readonly banner: HTMLElement | null;
  readonly leaderboard: HTMLElement | null;
  /** Valeur de seed : `app/` y écrit la seed de l'URL, le HUD la rend copiable. */
  readonly seedValue: HTMLElement | null;
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
 * (sprites, HUD, debug) est lu **dans le même instantané**. Le HUD ne peut donc pas être décalé
 * d'une frame par rapport aux positions affichées.
 *
 * La scène ne calcule rien de ce qui est affiché : elle assemble un `HudModel` (`hudModel.ts`) et un
 * `DebugModel` (`debugModel.ts`) à partir de cet instantané, et les confie aux vues. Le classement
 * affiché vient de `sim/leaderboard.ts`, seule source de classement du projet.
 */
export class RaceScene extends Scene {
  private readonly options: RaceSceneOptions;

  private readonly rig = new CameraRig();

  private sprites: readonly CharacterSprite[] = [];

  private track: TrackView | null = null;

  private hud: Hud | null = null;

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

    // Le classement est tenu par le HUD : celui-ci en est le **seul** écrivain, donc l'ordre affiché
    // ne peut pas diverger d'une seconde implémentation qui écrirait les mêmes lignes.
    if (this.options.hudRoot !== null) {
      this.hud = new Hud(this.options.hudRoot, this.options.text, {
        banner: this.options.banner,
        leaderboard: this.options.leaderboard,
        seedValue: this.options.seedValue,
      });
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
        // La photographie du HUD vient du HUD lui-même : elle décrit ce qu'il vient d'écrire, et non
        // une reconstruction parallèle du modèle de la frame.
        hud: () => this.hud?.snapshot() ?? null,
        // Le chemin de copie est celui du bouton : le hook ne fait que l'appeler et rendre son
        // résultat, il ne copie rien lui-même et n'écrit jamais dans la simulation.
        hudCopy: () => this.hud?.copySeed() ?? Promise.resolve(false),
        hudCopyConfirmed: () => this.hud?.copyConfirmed ?? false,
      });
    }

    this.applyLayout();
  }

  override update(_time: number, delta: number): void {
    // 1. Le temps réel ne sert qu'ici, et il ne fait qu'autoriser des pas de taille fixe.
    this.options.simulation.update(delta);

    // 2. Un unique instantané, lu par toutes les vues de cette frame.
    const state = this.options.simulation.view;
    const phase = this.options.simulation.phase;
    const checkpoint = this.options.simulation.checkpoint;

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

    // Le HUD est construit une seule fois par frame, à partir de l'instantané déjà lu : le classement,
    // les écarts et les marqueurs qu'il affiche décrivent donc exactement le même instant. Il en est
    // le **seul** écrivain, et les lignes viennent de `sim/leaderboard.ts` (source unique du noyau).
    const hudModel = buildHudModel(state, phase, checkpoint);
    this.hud?.update(hudModel);

    // Le `tSim` courant vient de l'instantané déjà lu : le commentaire n'a aucun accès au moteur,
    // il reçoit un simple nombre, ce qui lui permet de repoller un fait en file dès qu'il devient
    // éligible — sans attendre qu'un nouveau fait arrive.
    this.updateSubtitle(delta, state.tSim);
    this.updateHud();
    if (this.debug !== null) {
      this.debug.update(
        buildDebugModel(state, phase, this.options.simulation.timeScale, hudModel.rows),
      );
    }
  }

  /**
   * Commentaire : le rendu **lit** la réplique courante et l'affiche telle quelle.
   *
   * Aucune règle de parole n'est réécrite ici : la préemption, les cooldowns et la file sont tranchés
   * par le speaker, dans `src/speaker/`. Le bandeau ne fait que constater — et remplacer
   * immédiatement un texte par un autre, sans jamais remettre l'ancien.
   */
  private updateSubtitle(deltaMs: number, simNowS: number): void {
    const commentary = this.options.commentary;
    if (commentary === null || this.subtitle === null) {
      return;
    }

    commentary.update(deltaMs, simNowS);
    const text = commentary.currentLine()?.text ?? '';
    // Le conteneur redessine son fond : on ne le réécrit que lorsque la réplique change réellement.
    if (text !== this.shownSubtitle) {
      this.shownSubtitle = text;
      this.subtitle.show(text);
    }
  }

  /**
   * État et libellé du bouton de pause, en HTML : lisible même quand le canvas est réduit, et jamais
   * réécrit sans changement. Le reste du HUD est tenu par `Hud`, qui reçoit le même instantané.
   */
  private updateHud(): void {
    const phase = this.options.simulation.phase;

    setTextIfChanged(this.options.status, statusLabelFor(phase, this.options.text));
    setTextIfChanged(
      this.options.pauseButton,
      phase === 'userPaused' ? this.options.text.resumeButton : this.options.text.pauseButton,
    );
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
