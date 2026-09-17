import { SEED_TEXT_LENGTH, seedTextFromBytes } from '../core/seed';
import { createGame } from '../render/Game';
import { RaceSimulation } from '../sim/RaceSimulation';
import { SIM_PRESETS } from '../sim/config';
import { installTestHooks, testHooksEnabled } from '../sim/testHooks';
import { RaceCommentary } from './RaceCommentary';
import { SPEAKER_CATALOGUE_FR, UI_TEXT_FR } from './strings.fr';

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
  const params = new URLSearchParams(window.location.search);
  params.set(SEED_PARAM, generated);
  window.history.replaceState(null, '', `${window.location.pathname}?${params.toString()}`);
  return generated;
}

/** Affiche la seed à l'écran : elle doit rester lisible et copiable en permanence. */
function displaySeed(seedText: string): void {
  const element = document.getElementById('seed-value');
  if (element !== null) {
    element.textContent = seedText;
  }
}

/** Récupère un élément par identifiant, ou `null` s'il est absent. */
function elementById(id: string): HTMLElement | null {
  const element = document.getElementById(id);
  return element instanceof HTMLElement ? element : null;
}

function bootstrap(): void {
  const parent = elementById('game');
  if (parent === null) {
    throw new Error('Élément #game introuvable dans index.html.');
  }

  const params = new URLSearchParams(window.location.search);
  const seedText = resolveSeedText();
  displaySeed(seedText);

  // Le mode test ne touche pas au noyau : il ne change que le temps réel.
  const preset = params.get(FAST_PARAM) === '1' ? SIM_PRESETS.fast : SIM_PRESETS.normal;
  const simulation = new RaceSimulation(seedText, preset);

  // Le speaker est branché sur le flux de faits du noyau : `RaceSimulation` reste la seule à
  // drainer les faits, et les lui transmet par lots d'un même pas. Le commentaire ne voit donc
  // jamais l'état de course — seulement des faits mesurés et gelés.
  const commentary = new RaceCommentary(simulation.view.seedValue, SPEAKER_CATALOGUE_FR);
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

  createGame({
    parent,
    simulation,
    text: UI_TEXT_FR,
    leaderboard: elementById('leaderboard'),
    status: elementById('race-status'),
    banner: elementById('checkpoint-banner'),
    pauseButton,
    debugPanel: params.get(DEBUG_PARAM) === '1' ? elementById('debug') : null,
    debug: params.get(DEBUG_PARAM) === '1',
    exposeView: hooksEnabled,
    commentary,
  });

  // « Lancer » démarre la course : `RaceSimulation` gère elle-même le compte à rebours réel.
  startButton?.addEventListener('click', () => {
    simulation.start();
  });

  // « Rejouer » repart de zéro avec exactement la même seed.
  replayButton?.addEventListener('click', () => {
    simulation.restart();
    commentary.reset(simulation.view.seedValue);
    simulation.start();
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
