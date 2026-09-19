import {
  MAX_PARTICIPANTS,
  MIN_PARTICIPANTS,
  normalizeParticipants,
} from '../core/participants';
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
const PLAYERS_PARAM = 'players';
const FAST_PARAM = 'fast';
const DEBUG_PARAM = 'debug';
const AUTOSTART_PARAM = 'autostart';

/** Lit la seed dans l'URL. Toute chaîne est acceptée : une seed libre est hachée par le noyau. */
function readSeedFromUrl(search: string): string | null {
  const value = new URLSearchParams(search).get(SEED_PARAM);
  return value === null || value.length === 0 ? null : value;
}

/**
 * Lit le nombre de coureurs dans l'URL.
 *
 * Toute valeur absente ou illisible (`2`, `7`, `abc`) retombe sur l'effectif complet, et c'est
 * `core/participants.ts` qui en décide : `app/` ne réinvente pas la règle de lecture, elle l'appelle.
 */
function readPlayersFromUrl(search: string): number {
  return normalizeParticipants(new URLSearchParams(search).get(PLAYERS_PARAM));
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
 * Détermine la seed de la course.
 *
 * Elle vient de l'URL quand elle y est, sinon elle est tirée : l'appelant inscrit ensuite **l'identité
 * complète** de la course (seed et nombre de coureurs) dans l'URL, ce qui rend un rechargement
 * reproductible. Le numéro d'historique n'est pas touché, donc le bouton « Précédent » du navigateur
 * reste intact.
 */
function resolveSeedText(): string {
  return readSeedFromUrl(window.location.search) ?? createRandomSeedText();
}

/**
 * Inscrit la seed **et** le nombre de coureurs dans l'URL sans toucher à l'historique.
 *
 * Utilisé au démarrage **et** à chaque nouvelle course (P013) : la seed affichée reste donc toujours
 * celle qui est dans l'URL, et un rechargement de page rejoue exactement la même course. Le nombre de
 * coureurs fait partie de cette identité : la même seed à quatre coureurs n'aligne pas le même plateau
 * qu'à six, donc une URL qui ne le porterait pas ne serait pas reproductible.
 */
function writeRaceToUrl(seedText: string, players: number): void {
  const params = new URLSearchParams(window.location.search);
  params.set(SEED_PARAM, seedText);
  params.set(PLAYERS_PARAM, String(players));
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
 * Active ou désactive un contrôle par son **attribut HTML** `disabled`.
 *
 * Une apparence grisée ne suffit pas : un bouton qui « a l'air » inactif mais reste cliquable laisse
 * passer un second départ. L'attribut, lui, retire réellement le contrôle de la tabulation et du
 * clic, sans le retirer du flux — donc sans déplacer la mise en page.
 */
function setDisabled(element: HTMLElement | null, disabled: boolean): void {
  if (element instanceof HTMLButtonElement && element.disabled !== disabled) {
    element.disabled = disabled;
  }
}

/** Écrit un libellé dans un élément, seulement s'il change : le DOM n'est pas réécrit à chaque frame. */
function setTextIfChanged(element: HTMLElement | null, label: string): void {
  if (element !== null && element.textContent !== label) {
    element.textContent = label;
  }
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

  // Nombre de coureurs : lu dans l'URL (toute valeur illisible retombe sur 6), il fait partie de
  // l'identité de la course au même titre que la seed. `pendingPlayers` est le choix **affiché** par
  // le sélecteur ; il n'est appliqué qu'à une course neuve, jamais à une course en cours.
  let pendingPlayers = readPlayersFromUrl(window.location.search);

  // Le mode test ne touche pas au noyau : il ne change que le temps réel.
  const preset = params.get(FAST_PARAM) === '1' ? SIM_PRESETS.fast : SIM_PRESETS.normal;
  const simulation = new RaceSimulation(seedText, preset, pendingPlayers);
  // L'URL décrit désormais exactement la course en cours : seed **et** effectif, même si l'un des deux
  // manquait ou était illisible.
  writeRaceToUrl(simulation.seed, pendingPlayers);

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
  const resetButton = elementById('reset-button');
  if (startButton !== null) {
    startButton.textContent = UI_TEXT_FR.startButton;
  }
  if (pauseButton !== null) {
    pauseButton.textContent = UI_TEXT_FR.pauseButton;
  }
  if (resetButton !== null) {
    resetButton.textContent = UI_TEXT_FR.resetButton;
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

  // Sélecteur du nombre de coureurs (courses de 3 à 6). Il vit dans le HUD, mais il appartient à
  // `app/` : c'est la seule couche qui connaît l'URL et qui décide quand une course commence. Le
  // rendu ne le voit pas et ne peut donc pas s'en servir pour changer une course.
  const playersLabel = querySelector('[data-testid="players-label"]');
  if (playersLabel !== null) {
    playersLabel.textContent = UI_TEXT_FR.playersLabel;
  }

  const playersSelect = elementById('players-select');
  if (playersSelect instanceof HTMLSelectElement) {
    playersSelect.setAttribute('aria-label', UI_TEXT_FR.playersLabel);
    for (const [value, label] of [
      [MIN_PARTICIPANTS, UI_TEXT_FR.playersOption3],
      [MIN_PARTICIPANTS + 1, UI_TEXT_FR.playersOption4],
      [MIN_PARTICIPANTS + 2, UI_TEXT_FR.playersOption5],
      [MAX_PARTICIPANTS, UI_TEXT_FR.playersOption6],
    ] as const) {
      const option = document.createElement('option');
      option.value = String(value);
      // Le mot accompagne le chiffre : en petit paysage le libellé général est masqué, et le
      // contrôle doit rester compréhensible sans lui.
      option.textContent = `${label} ${UI_TEXT_FR.playersOptionSuffix}`;
      playersSelect.append(option);
    }
    playersSelect.value = String(pendingPlayers);
    playersSelect.addEventListener('change', () => {
      changePlayers(playersSelect.value);
    });
  }

  /**
   * Applique un nouveau nombre de coureurs.
   *
   * **Avant** toute course (`idle`), le choix prend effet immédiatement : « Lancer » aligne donc bien
   * l'effectif demandé, et l'URL décrit déjà la course à venir. **Pendant** une course, le contrôle est
   * désactivé (voir `syncPlayersControl`) : l'effectif ne peut donc pas être changé sous une course en
   * cours, et il n'existe plus de cas ambigu où le sélecteur afficherait 4 alors que le moteur aligne
   * encore 6 partants.
   */
  function changePlayers(raw: string): void {
    const next = normalizeParticipants(raw);
    if (next === pendingPlayers) {
      return;
    }
    pendingPlayers = next;
    if (simulation.phase === 'idle') {
      simulation.restart(simulation.seed, pendingPlayers);
      writeRaceToUrl(simulation.seed, pendingPlayers);
    }
    syncPlayersControl();
  }

  /**
   * Aligne le contrôle sur la phase réelle : l'effectif n'est modifiable qu'en `idle`.
   *
   * C'est **exactement** la règle de « Lancer » : dès que la course est engagée (compte à rebours,
   * course, pause, pause de checkpoint) ou terminée, le choix est figé. Aucun cas particulier pour
   * `finished` : une course terminée reste la course qui vient d'être jouée, et changer l'effectif
   * pendant que son classement est affiché ferait diverger le sélecteur du moteur — précisément le
   * bug corrigé ici. Il faut donc passer par « Réinitialiser ».
   */
  function syncPlayersControl(): void {
    if (!(playersSelect instanceof HTMLSelectElement)) {
      return;
    }
    const unlocked = simulation.phase === 'idle';
    playersSelect.disabled = !unlocked;
    if (unlocked) {
      playersSelect.value = String(pendingPlayers);
    }
  }

  /**
   * Garantit que le moteur aligne bien l'effectif **affiché** avant tout départ.
   *
   * C'est la correction structurelle du bug « 4 sélectionné → 6 lancés » : un démarrage ne peut plus
   * se contenter de supposer que le moteur est déjà à jour. Si les deux divergent, la course `idle`
   * est reconstruite avec le bon nombre — même seed, donc même identité de course — avant que
   * `start()` ne soit appelé. Le choix affiché et l'effectif réellement lancé ne peuvent donc plus
   * différer, quel que soit l'enchaînement de clics.
   */
  function ensurePendingPlayers(): void {
    if (simulation.players === pendingPlayers) {
      return;
    }
    simulation.restart(simulation.seed, pendingPlayers);
    writeRaceToUrl(simulation.seed, pendingPlayers);
    commentary.reset(simulation.view.seedValue);
  }

  /**
   * Aligne les trois commandes sur la phase réelle de la course.
   *
   * | phase | Lancer | Pause/Reprendre | Réinitialiser |
   * |---|---|---|---|
   * | `idle` | actif | inactif | actif |
   * | `countdown`, `running`, `userPaused` | inactif | actif | actif |
   * | `checkpointPause`, `finished` | inactif | inactif | actif |
   *
   * « Réinitialiser » reste disponible en **permanence** : c'est la sortie rapide d'une course, et le
   * joueur ne doit jamais avoir à attendre l'arrivée. Les deux autres suivent exactement ce que
   * `RaceSimulation` sait faire : `start()` ne démarre que depuis `idle`, `toggleUserPause()` n'a
   * aucun effet hors `countdown`/`running`/`userPaused`.
   *
   * L'état est porté par le **véritable attribut HTML `disabled`**, jamais par une apparence seule :
   * le bouton reste à sa place (aucun déplacement de mise en page), mais il est réellement
   * inatteignable au clic, au doigt comme au clavier. La mise en forme correspondante vit dans
   * `styles.css` (grisé, opacité réduite, curseur non interactif).
   */
  function syncControls(): void {
    const phase = simulation.phase;
    const paused = phase === 'userPaused';
    // Une pause de checkpoint est une pause du **noyau** : le MJ ne peut pas la reprendre à la main,
    // donc « Pause » n'a rien à y faire.
    const pauseAvailable = phase === 'countdown' || phase === 'running' || paused;

    setDisabled(startButton, phase !== 'idle');
    setDisabled(pauseButton, !pauseAvailable);
    setDisabled(resetButton, false);

    setTextIfChanged(pauseButton, paused ? UI_TEXT_FR.resumeButton : UI_TEXT_FR.pauseButton);
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
    onPhase: () => {
      syncPlayersControl();
      syncControls();
    },
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
    simulation.restart(undefined, pendingPlayers);
    writeRaceToUrl(simulation.seed, simulation.players);
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
    simulation.restart(nextSeed, pendingPlayers);
    writeRaceToUrl(simulation.seed, simulation.players);
    commentary.reset(simulation.view.seedValue);
    simulation.start();
  }

  // « Lancer » démarre la course : `RaceSimulation` gère elle-même le compte à rebours réel.
  //
  // Avant de démarrer, l'effectif **affiché** est appliqué au moteur s'il en divergeait (voir
  // `ensurePendingPlayers`) : il est donc structurellement impossible d'afficher 4 dans le sélecteur
  // et de lancer 6 coureurs. `start()` ne fait plus rien depuis une autre phase que `idle`, donc un
  // clic sur un bouton encore actif ne peut jamais relancer une course par surprise.
  startButton?.addEventListener('click', () => {
    ensurePendingPlayers();
    simulation.start();
  });

  /**
   * « Réinitialiser » : sortie rapide d'une course, à **toutes** les phases.
   *
   * Le joueur ne doit jamais avoir à attendre l'arrivée pour repartir sur une nouvelle course. Un
   * clic interrompt donc immédiatement la course en cours — quelle qu'elle soit : compte à rebours,
   * course, pause, pause de checkpoint, arrivée — et ramène la simulation en `idle` avec une
   * **nouvelle** seed.
   *
   * Tout ce qui appartenait à la course précédente est remis à zéro par les mécanismes existants :
   * le moteur et l'historique de relecture par `simulation.restart()`, la file du speaker et la voix
   * par `commentary.reset()`, l'écran d'arrivée par le rendu (il n'est qu'un reflet de la phase
   * `finished`, et disparaît donc dès que la phase quitte `finished`), et l'URL par `writeRaceToUrl`.
   *
   * `simulation.start()` n'est **jamais** appelé ici : réinitialiser ne démarre rien. Le joueur
   * choisit ensuite 3, 4, 5 ou 6 coureurs, puis clique sur « Lancer ».
   */
  function resetRace(): void {
    const nextSeed = createRandomSeedText();
    simulation.restart(nextSeed, pendingPlayers);
    commentary.reset(simulation.view.seedValue);
    writeRaceToUrl(simulation.seed, simulation.players);
    // L'interface revient en `idle` **immédiatement**, sans attendre une frame de rendu : le joueur
    // peut enchaîner « choisir un effectif » puis « Lancer » sans aucun délai perçu.
    syncPlayersControl();
    syncControls();
  }

  resetButton?.addEventListener('click', () => {
    resetRace();
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
    ensurePendingPlayers();
    simulation.start();
  }

  // État initial de la barre principale : la course peut déjà être en `countdown` (autostart), et
  // « Lancer » doit alors être inactif **dès la première frame**, sans attendre un changement de phase.
  syncPlayersControl();
  syncControls();
}

bootstrap();
