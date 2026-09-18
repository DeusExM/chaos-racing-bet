import { SEED_TEXT_LENGTH, seedTextFromBytes } from '../core/seed';
import { createGame, type GameHandle } from '../render/Game';
import { CharacterGallery } from '../render/view/CharacterGallery';
import { installViewportWatch } from '../render/viewportWatch';
import { RaceSimulation } from '../sim/RaceSimulation';
import { SIM_PRESETS } from '../sim/config';
import { installTestHooks, testHooksEnabled } from '../sim/testHooks';
import { RaceCommentary, type CommentaryVoice } from './RaceCommentary';
import { SettingsPanel } from './SettingsPanel';
import { allowsVoice, createSettingsStorage, SettingsStore, type SettingsStorage } from './settings';
import { createSoundOutput, webAudioScope } from './sound';
import { SPEAKER_CATALOGUE_FR, UI_TEXT_FR } from './strings.fr';
import { createVoiceOutput, webSpeechScope } from './tts';

/**
 * Point d'entrée de l'application.
 *
 * `app/` est la seule couche qui a le droit de connaître à la fois le DOM de la page, les paramètres
 * d'URL et les trois couches internes : elle assemble, elle ne décide de rien. Aucune règle de jeu,
 * aucun cadrage, aucun classement n'est calculé ici.
 */

const SEED_PARAM = 'seed';
const FAST_PARAM = 'fast';
const DEBUG_PARAM = 'debug';
const AUTOSTART_PARAM = 'autostart';

/** Lit la seed dans l'URL. Toute chaîne est acceptée : une seed libre est hachée par le noyau. */
function readSeedFromUrl(search: string): string | null {
  const value = new URLSearchParams(search).get(SEED_PARAM);
  return value === null || value.length === 0 ? null : value;
}

/**
 * Tire une seed au hasard.
 *
 * Le tirage vit ici, dans `app/`, et jamais dans le noyau : `src/core/` doit rester pur et
 * reproductible, donc sans aucune source de hasard propre. La seed tirée est directement la chaîne
 * affichable — c'est elle la source de vérité, la seed interne n'en est qu'une réduction.
 */
function createRandomSeedText(): string {
  const bytes = new Uint8Array(SEED_TEXT_LENGTH);
  crypto.getRandomValues(bytes);
  return seedTextFromBytes(bytes);
}

/**
 * Détermine la seed de la course et l'inscrit dans l'URL.
 *
 * Écrire la seed dans l'URL est ce qui rend un rechargement reproductible : la course rejouée est
 * exactement la même, y compris lorsque la seed vient d'être tirée au hasard. Le numéro d'historique
 * n'est pas touché, donc le bouton « Précédent » du navigateur reste intact.
 */
function resolveSeedText(): string {
  const fromUrl = readSeedFromUrl(window.location.search);
  if (fromUrl !== null) {
    return fromUrl;
  }

  const generated = createRandomSeedText();
  writeSeedToUrl(generated);
  return generated;
}

/**
 * Inscrit la seed dans l'URL sans toucher à l'historique.
 *
 * Utilisé au démarrage **et** par « Nouvelle course » (P013) : la seed affichée reste donc toujours
 * celle qui est dans l'URL, et un rechargement de page rejoue la course en cours.
 */
function writeSeedToUrl(seedText: string): void {
  const params = new URLSearchParams(window.location.search);
  params.set(SEED_PARAM, seedText);
  window.history.replaceState(null, '', `${window.location.pathname}?${params.toString()}`);
}

/** Récupère un élément par identifiant, ou `null` s'il est absent. */
function elementById(id: string): HTMLElement | null {
  const element = document.getElementById(id);
  return element instanceof HTMLElement ? element : null;
}

/** Récupère un élément par sélecteur, ou `null` s'il est absent. */
function querySelector(selector: string): HTMLElement | null {
  const element = document.querySelector(selector);
  return element instanceof HTMLElement ? element : null;
}

/**
 * Lit `localStorage` sans jamais lever.
 *
 * Certains navigateurs refusent l'accès à `localStorage` lui-même (iframe restreinte, réglage de
 * confidentialité) : le simple fait de le lire peut produire une exception, avant même tout appel.
 * Sans ce garde-fou, le jeu ne démarrerait pas à cause d'un réglage d'interface facultatif.
 */
function readBrowserSettingsStorage(): SettingsStorage | null {
  try {
    return createSettingsStorage(window);
  } catch {
    return null;
  }
}

/**
 * Branche la voix sur les réglages.
 *
 * La voix n'est qu'une **sortie** : elle lit si une émission est autorisée et vocalise la ligne que
 * le speaker a déjà choisie. Elle ne décide rien, ne retarde rien, et n'existe pas du tout si le
 * navigateur n'expose pas le Web Speech API.
 */
function createCommentaryVoice(
  settings: SettingsStore,
  output: ReturnType<typeof createVoiceOutput>,
): CommentaryVoice {
  return {
    allowsVoice: () => allowsVoice(settings.get()),
    speak: (text) => output?.speak(text),
    cancel: () => output?.cancel(),
  };
}

function bootstrap(): void {
  const parent = elementById('game');
  if (parent === null) {
    throw new Error('Élément #game introuvable dans index.html.');
  }

  const params = new URLSearchParams(window.location.search);
  // La seed affichée est celle du noyau (`state.seed`), écrite par le HUD : `app/` reste la seule
  // couche qui décide de la seed (elle la passe à `RaceSimulation`), le HUD ne fait que l'afficher —
  // et c'est le seul affichage de seed de l'application, sur tous les formats.
  const seedText = resolveSeedText();

  // Le mode test ne touche pas au noyau : il ne change que le temps réel.
  const preset = params.get(FAST_PARAM) === '1' ? SIM_PRESETS.fast : SIM_PRESETS.normal;
  const simulation = new RaceSimulation(seedText, preset);

  // Réglages locaux (P012) : lus une fois au démarrage, persistés à chaque changement. Ils ne
  // touchent ni la simulation, ni la seed, ni le speaker.
  const settings = new SettingsStore(readBrowserSettingsStorage());
  const voiceOutput = createVoiceOutput(webSpeechScope(window));
  const soundOutput = createSoundOutput(webAudioScope(window));

  const hudRoot = querySelector('.hud');

  // Couper le commentateur coupe réellement l'énonciation en cours : le réglage ne doit pas laisser
  // une phrase continuer après avoir été coupé. Le son, lui, n'a rien à interrompre (le klaxon est
  // plus court que le clic qui le déclenche) : couper le son ne joue donc **aucun** son.
  settings.subscribe((current) => {
    if (!allowsVoice(current)) {
      voiceOutput?.cancel();
    }
  });

  // Le speaker est branché sur le flux de faits du noyau : `RaceSimulation` reste la seule à
  // drainer les faits, et les lui transmet par lots d'un même pas. Le commentaire ne voit donc
  // jamais l'état de course — seulement des faits mesurés et gelés.
  const commentary = new RaceCommentary(
    simulation.view.seedValue,
    SPEAKER_CATALOGUE_FR,
    createCommentaryVoice(settings, voiceOutput),
  );
  simulation.onFacts((facts) => {
    commentary.feedFacts(facts);
  });

  installTestHooks(simulation, testHooksEnabled(window.location.search, import.meta.env.DEV));

  const hooksEnabled = testHooksEnabled(window.location.search, import.meta.env.DEV);

  const startButton = elementById('start-button');
  const pauseButton = elementById('pause-button');
  const replayButton = elementById('replay-button');
  if (startButton !== null) {
    startButton.textContent = UI_TEXT_FR.startButton;
  }
  if (pauseButton !== null) {
    pauseButton.textContent = UI_TEXT_FR.pauseButton;
  }
  if (replayButton !== null) {
    replayButton.textContent = UI_TEXT_FR.replayButton;
  }

  // Le panneau de réglages est créé par `app/`, qui possède déjà le DOM et la persistance : le rendu
  // n'a donc jamais à connaître un réglage.
  //
  // Il rejoint la **ligne d'état compacte** (`.hud-topline`) : sur petit écran paysage, le son et le
  // commentateur tiennent ainsi sur la même ligne que l'état, le segment et le chrono, au lieu
  // d'occuper un bloc à part. Ailleurs, ce conteneur est en `display: contents` et les réglages
  // reprennent leur cellule habituelle de la grille du HUD.
  //
  // Les deux rappels ne sont appelés qu'à l'**activation**, et depuis le clic lui-même : le klaxon et
  // la courte confirmation vocale sont donc des réponses à un geste utilisateur, jamais des sons de
  // chargement. Ils ne passent ni par le speaker, ni par sa file, ni par ses cooldowns.
  const toplineRoot = hudRoot?.querySelector('.hud-topline') ?? null;
  if (hudRoot !== null) {
    const settingsRoot = toplineRoot instanceof HTMLElement ? toplineRoot : hudRoot;
    new SettingsPanel(settingsRoot, settings, UI_TEXT_FR, {
      onSoundEnabled: () => {
        soundOutput?.playHorn();
      },
      onCommentatorEnabled: () => {
        voiceOutput?.speak(UI_TEXT_FR.voiceEnabledConfirmation);
      },
    });
  }

  // Panneau « persos » (micro-correction responsive) : le bouton vit dans le HUD (déclaré par
  // `index.html`, visible seulement en petit paysage), le panneau est monté par `app/`, comme les
  // réglages. Il ne reçoit ni simulation, ni speaker, ni relecture : il ne peut donc rien changer à
  // la course, qui continue derrière lui.
  const galleryButton = elementById('gallery-button');
  if (galleryButton !== null) {
    new CharacterGallery(galleryButton, UI_TEXT_FR);
  }

  // Écran de rotation (correction iPhone ciblée) : son texte appartient à `app/`, comme tous les
  // libellés visibles, et sa visibilité est décidée par la surveillance de la fenêtre ci-dessous.
  const rotationGateTitle = querySelector('[data-testid="rotation-gate-title"]');
  const rotationGateHint = querySelector('[data-testid="rotation-gate-hint"]');
  if (rotationGateTitle !== null) {
    rotationGateTitle.textContent = UI_TEXT_FR.rotationGateTitle;
  }
  if (rotationGateHint !== null) {
    rotationGateHint.textContent = UI_TEXT_FR.rotationGateHint;
  }

  // Surveillance de la fenêtre : **une seule** pour tout le projet. Elle publie une taille stabilisée
  // (voir `viewportWatch.ts`) — le cadrage Phaser s'y réapplique, et la course est gelée tant que
  // l'écran de rotation recouvre tout. La poignée du jeu est prise après coup : la première mesure est
  // publiée avant que le jeu n'existe, et c'est voulu (l'écran de rotation ne doit pas attendre).
  let gameplayAllowed = true;
  let game: GameHandle | null = null;
  installViewportWatch(window, {
    onStable: (metrics) => {
      gameplayAllowed = !metrics.rotationGate;
      game?.refreshScale();
    },
  });

  game = createGame({
    parent,
    simulation,
    text: UI_TEXT_FR,
    hudRoot,
    status: elementById('race-status'),
    banner: elementById('checkpoint-banner'),
    leaderboard: elementById('leaderboard'),
    // La seed affichée appartient au HUD : son élément n'est plus déclaré dans `index.html` (il n'y a
    // qu'**un** affichage de seed, dans la colonne du HUD), et le HUD le crée lui-même. `app/` ne lui
    // passe donc rien : c'est le noyau (`state.seed`) qui fait foi, et le HUD le recopie.
    seedValue: null,
    pauseButton,
    replayBar: elementById('replay-bar'),
    debugPanel: params.get(DEBUG_PARAM) === '1' ? elementById('debug') : null,
    debug: params.get(DEBUG_PARAM) === '1',
    exposeView: hooksEnabled,
    commentary,
    allowsGameplay: () => gameplayAllowed,
    finishActions: {
      replaySameSeed: () => {
        startSameSeedRace();
      },
      newRace: () => {
        startNewRace();
      },
    },
  });

  // Le tout premier cadrage est recalculé **une fois** : Phaser mesure la boîte de la piste pendant la
  // construction du jeu, donc avant que la feuille de style et `--app-height` n'aient fini de
  // s'appliquer. Sans cet appel, un lancement direct pouvait garder un canvas d'un pixel plus petit
  // que sa boîte — c'est-à-dire un cadrage différent de celui d'un retour de rotation, pour le même
  // écran. Le rendu reste inchangé ensuite : seules les tailles stabilisées le rappellent.
  game.refreshScale();

  /**
   * Repart de zéro avec **exactement** la seed source (P013).
   *
   * C'est la même seed affichée, dans l'URL et dans le HUD : la course rejouée est donc identique au
   * bit près, podium compris. Aucun nouveau tirage n'a lieu.
   */
  function startSameSeedRace(): void {
    simulation.restart();
    commentary.reset(simulation.view.seedValue);
    simulation.start();
  }

  /**
   * Tire une **nouvelle** seed, l'inscrit dans l'URL, puis lance réellement la course (P013).
   *
   * Le tirage passe par le mécanisme existant de `app/` (`createRandomSeedText`), donc il n'existe
   * qu'un seul système de seed dans le projet. La seed précédente n'est jamais réutilisée : elle est
   * remplacée partout à la fois — URL, moteur, commentaire, et affichage (le HUD recopie `state.seed`)
   * — avant le départ.
   */
  function startNewRace(): void {
    const nextSeed = createRandomSeedText();
    writeSeedToUrl(nextSeed);
    simulation.restart(nextSeed);
    commentary.reset(simulation.view.seedValue);
    simulation.start();
  }

  // « Lancer » démarre la course : `RaceSimulation` gère elle-même le compte à rebours réel.
  startButton?.addEventListener('click', () => {
    simulation.start();
  });

  // « Rejouer » tire une **nouvelle** seed et relance immédiatement une course (passe de finition 2D).
  //
  // C'est le bouton principal de la barre de commandes : un clic doit donner une course différente, et
  // non rejouer la précédente. Il emprunte exactement le même chemin que le bouton « Nouvelle course »
  // de l'écran d'arrivée — un seul tirage de seed dans tout le projet, une seule séquence de remise à
  // zéro — donc rien n'est dupliqué. Le bouton explicite « Rejouer la même seed » de l'écran d'arrivée,
  // lui, garde son sens et continue d'appeler `startSameSeedRace()`.
  replayButton?.addEventListener('click', () => {
    startNewRace();
  });

  // « Pause / Reprendre » : même commande que la touche Espace, et rien d'autre.
  pauseButton?.addEventListener('click', () => {
    simulation.toggleUserPause();
  });

  window.addEventListener('keydown', (event) => {
    if (event.code !== 'Space' && event.key !== ' ') {
      return;
    }
    // Espace ne doit jamais faire défiler la page.
    event.preventDefault();

    // Un bouton qui garde le focus serait « cliqué » par Espace : la pause basculerait deux fois et
    // reviendrait à son état initial. On rend donc le focus au document pour que le raccourci reste
    // unique, quelle que soit la façon dont le MJ a lancé la course.
    if (event.target instanceof HTMLElement && event.target.tagName === 'BUTTON') {
      event.target.blur();
    }

    simulation.toggleUserPause();
  });

  if (params.get(AUTOSTART_PARAM) === '1') {
    simulation.start();
  }
}

bootstrap();
