import { Scene } from 'phaser';

import { characterById } from '../../core/characters';
import type { RaceFact } from '../../core/types';
import type { RaceSimulation } from '../../sim/RaceSimulation';
import type { SimPhase } from '../../sim/types';
import type { SpeakerLine } from '../subtitle';
import type { UiText } from '../uiText';
import { VIEW } from '../viewConfig';
import { isCompactViewport } from '../viewport';
import { installViewDebug } from '../viewDebug';
import { CameraRig } from '../view/CameraRig';
import { CharacterSprite } from '../view/CharacterSprite';
import { buildDebugModel } from '../view/debugModel';
import { DebugPanel } from '../view/DebugPanel';
import { EventFeedback } from '../view/EventFeedback';
import { FinishPanel, type FinishActions } from '../view/FinishPanel';
import {
  buildFinishModel,
  captureFinishSnapshot,
  deceleratedDistances,
  type FinishSnapshot,
} from '../view/finishModel';
import { Hud } from '../view/Hud';
import { buildHudModel } from '../view/hudModel';
import { PassageRecorder } from '../view/passageModel';
import { SubtitleBanner } from '../view/SubtitleBanner';
import { buildSubtitleModel, subtitleLineView } from '../view/subtitleModel';
import { TrackView } from '../view/TrackView';
import { ReplayBar } from '../view/ReplayBar';
import {
  cursorAtPause,
  replayStateOf,
  seekCursor,
  type ReplayCursor,
} from '../view/replayModel';
import type { ReplayFrame } from '../../sim/ReplayHistory';

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
  /**
   * Nombre de répliques réellement en attente dans la file du speaker.
   *
   * Le rendu le **lit** pour l'afficher : il ne tient aucune file de son côté, donc l'indicateur ne
   * peut pas annoncer un commentaire que le speaker n'a pas.
   */
  queuedCount(): number;
  /**
   * Fait d'arrivée réellement produit par le noyau (`FINISH` ou `PHOTO_FINISH`), ou `null`.
   *
   * L'écran d'arrivée n'a pas le droit de recalculer un seuil de photo finish : il reçoit le fait
   * mesuré, et n'affiche la mention que si ce fait est bien un `PHOTO_FINISH`.
   */
  arrivalFact(): RaceFact | null;
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
  /** Racine de la barre de relecture (`#replay-bar`), sous l'arène, avec les commandes. */
  readonly replayBar: HTMLElement | null;
  readonly debugPanel: HTMLElement | null;
  readonly debug: boolean;
  /** Expose les positions écran réelles pour les tests E2E. */
  readonly exposeView: boolean;
  /** Commentaire du speaker, ou `null` quand la course n'en a pas (tests unitaires, mode nu). */
  readonly commentary: CommentaryView | null;
  /**
   * Actions de l'écran d'arrivée (P013), fournies par `app/`.
   *
   * La seed et l'URL appartiennent à `app/` : le rendu se contente de **déclencher** ce qu'on lui
   * donne, il ne fabrique jamais une seed et ne décide jamais d'une nouvelle course.
   */
  readonly finishActions: FinishActions;
  /**
   * Vrai quand la course peut avancer.
   *
   * Rendue fausse par `app/` pendant que l'écran de rotation recouvre tout : la scène n'appelle alors
   * **pas** `simulation.update()`, donc aucun pas n'est exécuté — même mécanisme qu'une pause, aucun
   * nouveau concept dans le noyau, et `tSim` reste strictement gelé. Le rendu continue de dessiner
   * l'instant figé, sous l'écran qui le masque.
   */
  readonly allowsGameplay: () => boolean;
  /**
   * Prévient `app/` à chaque changement de phase temps réel.
   *
   * Il sert au sélecteur du nombre de coureurs, qui n'est modifiable qu'avant une course : le rendu
   * ne touche pas à ce contrôle (il appartient à `app/`), il se contente de dire **quand** la phase
   * change. Aucune règle de course ne passe par là.
   */
  readonly onPhase?: ((phase: SimPhase) => void) | undefined;
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

  /**
   * Signature des partants du dernier jeu de sprites construit.
   *
   * Elle sert à détecter un **changement d'effectif** (nouvelle course à 3, 4 ou 5 coureurs) : les
   * sprites appartiennent à une course, donc ils sont reconstruits plutôt que réutilisés — sinon une
   * course à trois garderait six voies et six personnages dessinés.
   */
  private participantsKey = '';

  /** Dernière phase annoncée à `app/` : évite de la prévenir à chaque frame. */
  private lastPhase: SimPhase | null = null;

  private track: TrackView | null = null;

  private hud: Hud | null = null;

  private debug: DebugPanel | null = null;

  private subtitle: SubtitleBanner | null = null;

  /** Retour visuel des événements actifs (passe corrective) : lecture seule, comme le HUD. */
  private eventFeedback: EventFeedback | null = null;

  private finish: FinishPanel | null = null;

  /**
   * Instantané **figé** de l'arrivée, ou `null` tant que la course n'est pas terminée.
   *
   * Il est capturé une seule fois, à la frame où le noyau devient `finished`, puis n'est plus jamais
   * recalculé : le classement et les distances affichés ne peuvent donc pas bouger, même si le rendu
   * continue de vivre et d'animer.
   */
  private finishSnapshot: FinishSnapshot | null = null;

  /**
   * Historique des passages en tête, alimenté **en lecture** au moment où le noyau annonce une borne.
   *
   * Il ne connaît ni distance ni position d'écran : il note le premier du classement existant
   * (`sim/leaderboard.ts`) à l'instant mesuré de la borne, et se vide de lui-même dès qu'une nouvelle
   * course démarre.
   */
  private readonly passages = new PassageRecorder();

  /** Temps **réel** écoulé depuis l'arrivée, en millisecondes : il ne pilote que la décélération. */
  private finishElapsedMs = 0;

  /**
   * Distances réellement utilisées pour placer les sprites et cadrer la caméra.
   *
   * En course, ce sont celles du noyau. Après l'arrivée, ce sont les distances figées plus une
   * courte inertie visuelle : le tableau n'est donc jamais une seconde source de classement, il n'est
   * qu'une position de dessin.
   */
  private visualXs: readonly number[] = [];

  /**
   * Largeur de la **piste**, en pixels logiques : l'arène moins la bande réservée au classement.
   *
   * Tous les placements d'écran passent par elle (caméra, sprites, décor, badges) : un personnage ne
   * peut donc pas être dessiné sous le classement, quelle que soit la résolution (passe corrective 2).
   */
  private trackWidth = 0;

  /**
   * Curseur de relecture, ou `null` hors relecture.
   *
   * Il n'existe que pendant une pause manuelle. Le noyau, lui, ne connaît ni ce curseur ni la
   * relecture : il reste gelé à l'instant de la pause, et c'est de là que « Reprendre » repart.
   */
  private replayCursor: ReplayCursor | null = null;

  /** Barre de relecture, ou `null` quand le rendu n'a pas de racine de commandes. */
  private replayBar: ReplayBar | null = null;

  private layoutHeight = 0;

  private layoutWidth = 0;

  /**
   * Format du dernier agencement appliqué (petit paysage ou non).
   *
   * Il fait partie de la clé de `applyLayout()` : un changement de format sans changement de taille
   * de canvas (bascule de la requête média) doit quand même reposer les voies et les personnages.
   */
  private compactLayout = false;

  constructor(options: RaceSceneOptions) {
    super('race');
    this.options = options;
  }

  create(): void {
    this.track = new TrackView(this, this.options.text);

    // Le bandeau de commentaire vit dans l'arène, à côté du HUD (voir `SubtitleBanner`) : il n'est
    // créé que lorsqu'une course commentée existe, et il partage donc la grille du HUD.
    if (this.options.commentary !== null && this.options.hudRoot !== null) {
      this.subtitle = new SubtitleBanner(this.options.hudRoot);
    }

    this.sprites = this.buildSprites();

    // Le classement est tenu par le HUD : celui-ci en est le **seul** écrivain, donc l'ordre affiché
    // ne peut pas diverger d'une seconde implémentation qui écrirait les mêmes lignes.
    if (this.options.hudRoot !== null) {
      this.hud = new Hud(this.options.hudRoot, this.options.text, {
        banner: this.options.banner,
        leaderboard: this.options.leaderboard,
        seedValue: this.options.seedValue,
      });
      // Retour visuel des événements (passe corrective) : il ne lit que l'état déjà calculé et les
      // positions d'écran des sprites, et vit donc dans l'arène comme le HUD.
      this.eventFeedback = new EventFeedback(this.options.hudRoot, this.options.text);
    }

    if (this.options.debug && this.options.debugPanel !== null) {
      this.debug = new DebugPanel(this.options.debugPanel, this.options.text);
    }

    // La barre de relecture ne décide de rien : elle transmet un pas à consulter, la scène le borne
    // (`replayModel.ts`) et l'utilise pour dessiner un instant déjà joué.
    if (this.options.replayBar !== null) {
      this.replayBar = new ReplayBar(this.options.replayBar, this.options.text, (step) => {
        this.seekReplay(step);
      });
    }

    // L'écran d'arrivée vit dans la même grille que le HUD : sa cellule ne recouvre donc jamais le
    // statut, les réglages, le chrono, la seed ni le bandeau de commentaire (P013).
    if (this.options.hudRoot !== null) {
      this.finish = new FinishPanel(
        this.options.hudRoot,
        this.options.text,
        this.options.finishActions,
      );
    }

    if (this.options.exposeView) {
      installViewDebug({
        sprites: () =>
          this.sprites.map((sprite) => ({
            id: sprite.id,
            screenX: sprite.screenX,
            screenY: sprite.screenY,
            // Dimensions et visibilité réelles : un test de géométrie ne peut pas deviner le rectangle
            // d'un sprite à partir d'une constante recopiée, et il doit savoir s'il est dessiné. Les
            // images n'étant pas carrées, la largeur et la hauteur sont publiées séparément.
            width: sprite.width,
            height: sprite.height,
            // Position et profondeur du nom : elles prouvent que le nom est bien **dans** la voie,
            // **derrière** le personnage au sens de la course (à sa gauche) et jamais dessous.
            nameX: sprite.nameX,
            nameY: sprite.nameY,
            nameDepth: sprite.nameDepth,
            depth: sprite.depth,
            drawn: sprite.drawn,
            // Effet d'événement réellement appliqué : il ne peut venir que de l'événement actif du
            // noyau, et il est nul dès qu'aucun événement n'est en cours.
            eventKind: sprite.eventKind,
            auraAlpha: sprite.auraAlpha,
            trailAlpha: sprite.trailAlpha,
            trailOffset: sprite.trailOffset,
            spriteTint: sprite.spriteTint,
          })),
        camera: () => ({ leftM: this.rig.left, windowM: this.rig.span }),
        subtitle: () => this.subtitle?.visibleText() ?? '',
        // La réplique affichée porte son fait source : un test peut recalculer le texte attendu et
        // vérifier que ce qui est montré vient bien d'un fait réellement mesuré.
        subtitleLine: () =>
          subtitleLineView(
            this.options.commentary?.currentLine() ?? null,
            this.options.commentary?.queuedCount() ?? 0,
          ),
        // La photographie du HUD vient du HUD lui-même : elle décrit ce qu'il vient d'écrire, et non
        // une reconstruction parallèle du modèle de la frame.
        hud: () => this.hud?.snapshot() ?? null,
        // Le chemin de copie est celui du bouton : le hook ne fait que l'appeler et rendre son
        // résultat, il ne copie rien lui-même et n'écrit jamais dans la simulation.
        hudCopy: () => this.hud?.copySeed() ?? Promise.resolve(false),
        hudCopyConfirmed: () => this.hud?.copyConfirmed ?? false,
        // Les distances de rendu : elles valent celles du noyau en course, et incluent l'inertie
        // visuelle après l'arrivée. Aucune écriture n'est possible depuis un hook.
        visualDistances: () => this.visualXs,
        // L'écran d'arrivée tel qu'il est réellement présenté, pour comparer le podium au noyau.
        finish: () => this.finish?.snapshot() ?? null,
        // Retour visuel d'événement : la photographie des badges réellement affichés, avec
        // l'occurrence d'événement qui les a produits. Elle sert à vérifier qu'un badge vient bien
        // d'un événement du noyau, et qu'il disparaît quand celui-ci se termine.
        eventFeedback: () => this.eventFeedback?.snapshot() ?? [],
        // Géométrie réelle de la piste : elle vient de la scène, pas d'une constante recopiée dans le
        // test, et décrit donc ce qui a réellement été dessiné.
        track: () => ({
          arenaWidth: this.layoutWidth,
          arenaHeight: this.layoutHeight,
          trackWidth: this.trackWidth,
          compact: this.compactLayout,
        }),
        // Relecture en cours : instants consulté et réel, en pas du noyau.
        replay: () =>
          this.replayCursor === null
            ? null
            : {
                viewedStep: this.replayCursor.step,
                pauseStep: this.replayCursor.pauseStep,
                visible: this.replayBar?.visible ?? false,
              },
      });
    }

    this.applyLayout();
  }

  override update(_time: number, delta: number): void {
    // 1. Le temps réel ne sert qu'ici, et il ne fait qu'autoriser des pas de taille fixe. Une fois la
    // course terminée, `RaceSimulation.update()` ne fait plus rien : le noyau ne reçoit donc plus
    // aucun pas, et c'est cette seule ligne qui garantit qu'il n'y a pas de « course après la course ».
    //
    // L'écran de rotation (téléphone tenu droit) coupe exactement ici : l'écran recouvre la course, et
    // la course ne doit donc pas se jouer derrière lui. Ne pas appeler `update()` est le mécanisme de
    // pause du projet — aucun pas n'est exécuté, `tSim` est gelé, et la reprise ne rattrape rien.
    if (this.options.allowsGameplay()) {
      this.options.simulation.update(delta);
    }

    // 2. Un unique instantané, lu par toutes les vues de cette frame.
    const state = this.options.simulation.view;
    const phase = this.options.simulation.phase;
    const checkpoint = this.options.simulation.checkpoint;

    // 2 bis. Changement de phase temps réel : `app/` en est prévenu une fois par transition (jamais à
    // chaque frame). Cela ne sert qu'à l'interface — ici, autoriser ou non le choix du nombre de
    // coureurs — et ne peut donc pas influencer la course.
    if (phase !== this.lastPhase) {
      this.lastPhase = phase;
      this.options.onPhase?.(phase);
    }

    // 2 bis. Passages en tête (passe de finition 2D) : quand le noyau annonce une borne, le premier de
    // son classement est noté. C'est une **lecture** du classement existant, faite une fois par borne :
    // aucun second moteur de classement n'est créé, et une borne non franchie n'est jamais complétée.
    if (phase !== 'finished') {
      this.passages.observe(state, checkpoint);
    }

    // 2 bis. Relecture (passe corrective 2) : le curseur suit la pause manuelle, et l'instant consulté
    // est lu dans l'historique du noyau. Aucun pas n'est exécuté, aucun fait n'est produit, aucun
    // tirage n'a lieu : on **regarde** un instant déjà calculé.
    const replayFrame = this.updateReplay(phase);

    // 3. À l'arrivée, la photographie du noyau est prise **une fois** : c'est elle, et rien d'autre,
    // qui alimente ensuite le podium et les distances affichées.
    if (phase === 'finished') {
      if (this.finishSnapshot === null) {
        this.finishSnapshot = captureFinishSnapshot(state);
      }
    } else {
      this.finishSnapshot = null;
      this.finishElapsedMs = 0;
    }

    // 4. Les positions de rendu : celles de l'instant **consulté** pendant une relecture, sinon celles
    // du noyau, plus une inertie purement visuelle après l'arrivée. Le décalage est le même pour tous
    // les partants, donc l'ordre à l'écran ne peut pas diverger du classement affiché — une position
    // de sprite n'est jamais un critère de victoire.
    //
    // C'est aussi ici, et seulement ici, que le rendu suit un changement d'**effectif** : entre deux
    // courses, le noyau peut aligner trois, quatre, cinq ou six partants, et les sprites sont alors
    // reconstruits pour cet effectif. Une course lancée ne change jamais d'effectif.
    this.syncParticipants();
    this.visualXs =
      replayFrame !== null
        ? replayFrame.distances
        : this.finishSnapshot === null
          ? state.characters.map((character) => character.x)
          : deceleratedDistances(this.finishSnapshot, this.finishElapsedMs);

    // L'état **affiché** : celui du noyau, ou celui d'un instant passé déjà enregistré. Le HUD, les
    // badges et le décor lisent tous celui-ci, donc ils décrivent tous le même instant.
    const displayState = replayFrame === null ? state : replayStateOf(state, replayFrame);

    // 5. Le cadrage se déduit des distances de rendu : jamais l'inverse.
    this.rig.follow(this.visualXs);

    this.applyLayout();
    this.track?.update(this.rig);

    for (const [index, sprite] of this.sprites.entries()) {
      const distance = this.visualXs[index];
      const character = displayState.characters[index];
      if (distance === undefined || character === undefined) {
        continue;
      }
      const screenX = this.rig.toScreenX(distance, this.trackWidth);
      // L'effet d'événement est décidé **avant** la pose : il ne fait que lire l'état déjà calculé de
      // cette frame, et il ne peut donc ni déplacer le personnage ni changer sa vitesse.
      sprite.updateEventVisual(character, delta);
      sprite.place(screenX, this.layoutHeight, this.compactLayout);
      // Un personnage hors du champ est **masqué** : il n'est jamais dessiné sous la bande réservée au
      // classement permanent, pas même partiellement. La décision se prend sur la **taille réellement
      // affichée** (les images sont plus larges que hautes) : supposer un carré laisserait dépasser
      // l'image sous le panneau. Son marqueur de bord, lui, reste dans la piste et dit qui c'est.
      const fitsInsideTrack =
        screenX - sprite.halfWidth >= 0 && screenX + sprite.halfWidth <= this.trackWidth;
      sprite.setDrawn(fitsInsideTrack);
      if (!fitsInsideTrack || this.rig.isOffscreen(distance, this.trackWidth)) {
        sprite.showEdgeMarker(
          screenX < this.trackWidth / 2 ? 'left' : 'right',
          this.trackWidth,
          this.layoutHeight,
          this.compactLayout,
        );
      } else {
        sprite.hideEdgeMarker();
      }
    }

    // Le HUD est construit une seule fois par frame, à partir de l'instantané déjà lu : le classement,
    // les écarts et les marqueurs qu'il affiche décrivent donc exactement le même instant. Il en est
    // le **seul** écrivain, et les lignes viennent de `sim/leaderboard.ts` (source unique du noyau).
    //
    // Pendant une relecture, le badge de checkpoint est masqué : il décrit la borne **réelle** de la
    // pause, pas l'instant consulté — l'afficher avec le classement du passé serait un mélange de deux
    // instants.
    const hudModel = buildHudModel(displayState, phase, replayFrame === null ? checkpoint : null);
    this.hud?.update(hudModel);

    // Retour visuel d'événement : il reçoit l'état **déjà lu** de cette frame et les positions des
    // sprites **déjà posés**, et n'a donc aucun moyen de faire avancer la course d'un pas de plus.
    // La couche couvre exactement la piste : un badge ne peut pas déborder sous le classement.
    this.eventFeedback?.update(
      displayState.characters,
      this.sprites.map((sprite) => ({
        id: sprite.id,
        screenX: sprite.screenX,
        screenY: sprite.screenY,
        // La demi-largeur réelle du sprite : c'est elle qui place le mot **derrière** le personnage,
        // sans jamais mordre sur l'illustration.
        halfWidth: sprite.halfWidth,
      })),
      { width: this.trackWidth, height: this.layoutHeight },
    );

    // L'écran d'arrivée lit la photographie figée et le fait d'arrivée **réel** : il ne recalcule ni
    // le classement, ni un seuil de photo finish. Hors arrivée, il est masqué.
    this.finish?.update(
      this.finishSnapshot === null
        ? null
        : buildFinishModel(
            this.finishSnapshot,
            this.options.commentary?.arrivalFact() ?? null,
            this.passages.rows(),
          ),
    );

    // Le `tSim` courant vient de l'instantané déjà lu : le commentaire n'a aucun accès au moteur,
    // il reçoit un simple nombre, ce qui lui permet de repoller un fait en file dès qu'il devient
    // éligible — sans attendre qu'un nouveau fait arrive. Il continue donc de vivre après l'arrivée,
    // jusqu'à la disparition propre de la réplique d'arrivée.
    //
    // Pendant une relecture, il n'est **pas** appelé du tout : la relecture est muette, ne remet aucune
    // ancienne réplique dans la file du speaker et ne produit aucun fait. Le bandeau garde simplement
    // ce qu'il affichait au moment de la pause.
    if (replayFrame === null) {
      this.updateSubtitle(delta, state.tSim);
    }
    this.updateHud();
    if (this.debug !== null) {
      this.debug.update(
        buildDebugModel(state, phase, this.options.simulation.timeScale, hudModel.rows),
      );
    }

    // 6. La montre de la décélération n'avance qu'après coup : la frame de l'arrivée elle-même est
    // donc dessinée exactement aux distances finales du noyau, sans le moindre décalage.
    if (this.finishSnapshot !== null) {
      this.finishElapsedMs += delta > 0 && Number.isFinite(delta) ? delta : 0;
    }
  }

  /**
   * Commentaire : le rendu **lit** la réplique courante et l'affiche telle quelle.
   *
   * Aucune règle de parole n'est réécrite ici : la préemption, les cooldowns et la file sont tranchés
   * par le speaker, dans `src/speaker/`. Le bandeau ne fait que constater — et remplacer
   * immédiatement un texte par un autre, sans jamais remettre l'ancien.
   *
   * Le modèle d'affichage est reconstruit à chaque frame depuis la ligne courante et le nombre réel
   * de répliques en file : c'est le bandeau qui décide s'il doit réécrire son DOM, pas la scène.
   */
  private updateSubtitle(deltaMs: number, simNowS: number): void {
    const commentary = this.options.commentary;
    if (commentary === null || this.subtitle === null) {
      return;
    }

    commentary.update(deltaMs, simNowS);
    this.subtitle.render(
      buildSubtitleModel(
        commentary.currentLine(),
        commentary.queuedCount(),
        this.options.text.queuedLines,
      ),
      deltaMs,
    );
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

  /**
   * Relecture : suit la pause manuelle et renvoie l'instant **consulté**, ou `null` en course.
   *
   * Rien de ce qui suit ne remonte vers le noyau. Le curseur naît à la pause, sur l'instant réel de la
   * pause (donc `+2 s` ne peut pas dépasser ce que la course a réellement joué), vit tant que la pause
   * dure, et **disparaît à la reprise** : la scène redessine alors l'instant réel, et la simulation
   * repart de son état gelé, sans un pas de plus ni un tirage de plus.
   */
  private updateReplay(phase: SimPhase): ReplayFrame | null {
    if (phase !== 'userPaused') {
      this.replayCursor = null;
      this.replayBar?.update(false, 0, 0);
      return null;
    }

    const pauseStep = this.options.simulation.view.steps;
    if (this.replayCursor === null) {
      this.replayCursor = cursorAtPause(pauseStep);
    } else if (this.replayCursor.pauseStep !== pauseStep) {
      // Le noyau est gelé pendant la pause : la borne ne bouge pas. Si elle bougeait, c'est que la
      // pause n'en était pas une — on se recale plutôt que d'afficher une borne fausse.
      this.replayCursor = cursorAtPause(pauseStep);
    }

    const frame = this.options.simulation.history.frameAt(this.replayCursor.step);
    this.replayBar?.update(true, this.replayCursor.step, pauseStep);
    return frame;
  }

  /** Déplace le curseur de relecture : la borne est appliquée par `replayModel.ts`, jamais ici. */
  private seekReplay(step: number): void {
    if (this.replayCursor === null) {
      return;
    }
    this.replayCursor = seekCursor(this.replayCursor, step);
  }

  /** Réapplique la géométrie quand la taille du canvas change. */
  private applyLayout(): void {
    const width = this.scale.width;
    const height = this.scale.height;
    const compact = isCompactViewport();
    const sameSize = width === this.layoutWidth && height === this.layoutHeight;
    if (sameSize && compact === this.compactLayout) {
      return;
    }

    this.layoutWidth = width;
    this.layoutHeight = height;
    this.compactLayout = compact;

    // Bande réservée au classement permanent (passe corrective 2). En téléphone paysage, c'est la
    // **colonne du HUD** qui tient ce rôle : la piste n'occupe plus qu'une partie de l'écran, mais
    // elle occupe **tout le canvas** — la largeur logique de l'arène est choisie pour cela
    // (`viewport.arenaBaseSize`), donc le canvas et la colonne coïncident au pixel.
    this.trackWidth = Math.round(width * (compact ? 1 : VIEW.TRACK_WIDTH_RATIO));

    // La largeur de la bande est publiée au CSS, qui la consomme pour la colonne du classement : une
    // seule valeur décide donc de la géométrie de la piste **et** de celle du HUD.
    const stage = this.scale.parent;
    if (stage instanceof HTMLElement) {
      stage.style.setProperty(
        '--hud-sidebar-width',
        compact ? '0' : `${String(Math.round((width - this.trackWidth) * 100) / 100)}px`,
      );
    }

    this.track?.layout(this.trackWidth, height, compact, this.sprites.length);
    for (const sprite of this.sprites) {
      sprite.layout(height, compact);
    }
  }

  /**
   * Construit un sprite par **partant**, dans l'ordre canonique du roster.
   *
   * Les sprites ne sont plus construits « pour six » : ils suivent la liste des partants du noyau, qui
   * est la seule source de vérité sur qui court. L'index de voie est l'index dans cette liste, donc
   * les voies restent ordonnées et aucun trou n'apparaît.
   */
  private buildSprites(): readonly CharacterSprite[] {
    const participants = this.options.simulation.participants;
    this.participantsKey = participants.join(',');
    return participants.map((id, index) => {
      const character = characterById(id);
      if (character === undefined) {
        throw new RangeError(`Partant hors roster : « ${id} ».`);
      }
      return new CharacterSprite(this, character, index, participants.length);
    });
  }

  /**
   * Reconstruit les sprites si l'effectif a changé depuis la dernière frame.
   *
   * Un changement d'effectif n'arrive qu'entre deux courses (`restart`), jamais pendant une course :
   * le noyau reconstruit son moteur, le rendu reconstruit ses sprites. Les anciens sont détruits pour
   * qu'aucune silhouette d'une course précédente ne reste dessinée sous la nouvelle.
   */
  private syncParticipants(): void {
    const participants = this.options.simulation.participants;
    if (participants.join(',') === this.participantsKey) {
      return;
    }
    for (const sprite of this.sprites) {
      sprite.destroy();
    }
    this.sprites = this.buildSprites();
    this.passages.reset();
    // La géométrie doit être rejouée pour le nouvel effectif : les voies et les tailles changent.
    this.layoutWidth = 0;
    this.layoutHeight = 0;
  }
}

/** Écrit un libellé dans un élément, seulement s'il change : le DOM n'est pas réécrit à chaque frame. */
function setTextIfChanged(element: HTMLElement | null, label: string): void {
  if (element !== null && element.textContent !== label) {
    element.textContent = label;
  }
}
