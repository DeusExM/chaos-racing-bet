import { AUTO, Game, Scene } from 'phaser';

import { seedToText } from '../core/seed';

/** Résolution de référence (16:9). Le redimensionnement réel arrive en P005. */
const GAME_WIDTH = 1280;
const GAME_HEIGHT = 720;

const SEED_PARAM = 'seed';
const SEED_ELEMENT_ID = 'seed-value';

/**
 * Scène vide.
 *
 * P001 ne valide que la chaîne outillage (build, typecheck, tests, montage du canvas).
 * Aucune logique de course, aucun personnage, aucun rendu de piste n'appartient à cette
 * étape : la première course visible est l'objet de P005.
 */
class Placeholder extends Scene {
  constructor() {
    super('placeholder');
  }
}

/**
 * Lit la seed dans l'URL.
 *
 * Toute chaîne est acceptée : une seed qui n'est pas au format affichable est hachée plus tard
 * (voir `GAME_DESIGN.md` §10). Une valeur absente ou vide signifie « pas de seed imposée ».
 */
function readSeedFromUrl(search: string): string | null {
  const value = new URLSearchParams(search).get(SEED_PARAM);
  return value === null || value.length === 0 ? null : value;
}

/**
 * Tire une seed au hasard.
 *
 * Le tirage vit ici, dans `app/`, et jamais dans le noyau : `src/core/` doit rester pur et
 * reproductible, donc sans aucune source de hasard propre.
 */
function createRandomSeedText(): string {
  const buffer = new Uint32Array(1);
  crypto.getRandomValues(buffer);
  return seedToText(buffer[0] ?? 0);
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
  const element = document.getElementById(SEED_ELEMENT_ID);
  if (element !== null) {
    element.textContent = seedText;
  }
}

function bootstrap(): void {
  const parent = document.getElementById('game');
  if (!parent) {
    throw new Error("Élément #game introuvable dans index.html.");
  }

  const seedText = resolveSeedText();
  displaySeed(seedText);

  new Game({
    type: AUTO,
    parent,
    width: GAME_WIDTH,
    height: GAME_HEIGHT,
    backgroundColor: '#0b0f1e',
    scene: [Placeholder],
  });
}

bootstrap();
