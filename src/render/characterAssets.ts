import type { Scene } from 'phaser';

import { CHARACTERS } from '../core/characters';
import type { CharacterId } from '../core/types';

/**
 * Visuels des 6 personnages : **une seule table** associe un identifiant à un fichier.
 *
 * ## Ce que ce module possède
 *
 * * la **clé de texture** Phaser d'un personnage (`character-c0`…) ;
 * * l'**URL** de son image, servie par Vite depuis `public/` ;
 * * le **chargement** des six images, à faire dans le `preload()` de la scène de démarrage.
 *
 * Aucun autre fichier ne connaît un chemin d'asset : ajouter un personnage, ou renommer un fichier,
 * se fait ici et nulle part ailleurs. `CharacterSprite` ne reçoit qu'une clé de texture.
 *
 * ## Origine des fichiers
 *
 * Les PNG livrés (`mamie Nitro.png`, …) restent **intacts** à la racine du dépôt : ils sont la source
 * d'art, en pleine résolution, et ne sont jamais modifiés ni servis. Les fichiers listés ici sont les
 * **copies runtime**, produites par `tools/optimizeCharacterAssets.mjs` (transparence et ratio
 * conservés, hauteur 320 px, ~120 Ko par personnage, ~0,75 Mio au total) : c'est ce qui permet de
 * respecter le budget de ressources d'`AGENTS.md` §3.6 tout en gardant des originaux haute résolution
 * pour un futur réexport. Le rendu n'affiche que ~73 px de haut : il ne lit donc jamais la résolution
 * du fichier comme une taille d'affichage.
 */
const CHARACTER_ASSET_DIRECTORY = 'assets/characters';

/**
 * Fichier runtime de chaque personnage, dans l'ordre stable du roster.
 *
 * Les noms sont techniques — sans espace ni accent — pour rester valides partout (URL, zip, systèmes de
 * fichiers) et ne pas dépendre d'un encodage.
 */
const CHARACTER_ASSET_FILES: Readonly<Record<CharacterId, string>> = {
  c0: 'mamie-nitro.png',
  c1: 'saucisse-mecanique.png',
  c2: 'poulet-3000.png',
  c3: 'jean-michel-turbo.png',
  c4: 'bananix.png',
  c5: 'gerard-le-paladin.png',
};

/** Clé de texture Phaser d'un personnage. */
export function characterTextureKey(id: CharacterId): string {
  return `character-${id}`;
}

/** Nom du fichier runtime d'un personnage (sans répertoire). */
export function characterAssetFile(id: CharacterId): string {
  return CHARACTER_ASSET_FILES[id];
}

/**
 * URL de l'image runtime d'un personnage, **relative** au document.
 *
 * Volontairement sans `/` initial : l'application est servie aussi bien à la racine qu'en
 * sous-répertoire (`base: './'` dans `vite.config.ts`), et une URL absolue casserait le second cas.
 */
export function characterAssetUrl(id: CharacterId): string {
  return `${CHARACTER_ASSET_DIRECTORY}/${CHARACTER_ASSET_FILES[id]}`;
}

/**
 * Charge les six images avant la création des personnages.
 *
 * À appeler depuis `preload()` : Phaser attend la fin du chargement avant `create()`, donc aucune
 * texture ne peut manquer au moment où les sprites sont construits. Le rendu ne charge rien d'autre :
 * le jeu n'a aucun autre asset.
 */
export function preloadCharacterAssets(scene: Scene): void {
  for (const character of CHARACTERS) {
    scene.load.image(characterTextureKey(character.id), characterAssetUrl(character.id));
  }
}