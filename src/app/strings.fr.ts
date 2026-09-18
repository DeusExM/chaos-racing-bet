import { CHARACTERS } from '../core/characters';
import type { CharacterId, RaceFact, RaceFactType } from '../core/types';
import {
  DISPLAY_DECIMALS,
  formatCountFr as formatCount,
  formatDecimalFr as formatDecimal,
  formatMetresFr as formatMetres,
  formatPercentFr as formatPercent,
  formatSecondsFr as formatSeconds,
  formatTruncatedMetresFr as formatTruncatedMetres,
} from '../render/format';
import type { SpeakerCatalogue } from '../render/subtitle';
import type { UiText } from '../render/uiText';

/**
 * Tous les textes **visibles** de l'application, en français.
 *
 * Ils sont regroupés ici et nulle part ailleurs : `core/`, `sim/` et `render/` n'en contiennent
 * aucun en dur (AGENTS §7). Modifier un libellé ne peut donc jamais changer une règle de jeu ni un
 * résultat de course.
 */
export const UI_TEXT_FR: UiText = Object.freeze({
  statusIdle: 'En attente du départ',
  statusCountdown: 'Départ imminent',
  statusRunning: 'Course en cours',
  statusCheckpointPause: 'Pause de checkpoint',
  statusUserPaused: 'En pause',
  statusFinished: 'Course terminée',

  rankingTitle: 'Classement',

  // Espace insécable : « 12,3 m » ne doit jamais se couper en fin de ligne.
  metres: '\u00A0m',

  debugTitle: 'Debug',
  debugPhase: 'phase',
  debugSimTime: 'temps simulé',
  debugSteps: 'pas',
  debugSeed: 'seed',
  debugTimeScale: 'échelle de temps',
  debugDistance: 'x',
  debugSpeed: 'v',
  debugDrift: 'drift',
  debugSurge: 'surge',
  debugEvent: 'événement',
  debugEventBonus: 'bonus événement',
  debugGap: 'écart',
  debugNoEvent: 'aucun',
  debugSegment: 'segment',

  timeTitle: 'Chrono',
  segmentLabel: 'segment',
  // À l'arrivée, le bloc segment ne peut plus afficher de numéro : il affiche l'état de la course.
  segmentDone: 'Terminé',
  seedLabel: 'Seed',
  copySeedButton: 'Copier',
  copySeedDone: 'Copié !',
  // Le rendu accole cette unité à l'écart en secondes du classement.
  gapSecondsLabel: 's',
  // Le rendu accole à ces libellés le numéro de checkpoint et l'instant simulé.
  checkpointTitle: 'Checkpoint',
  checkpointLeaderSplit: 'en tête',

  // Plus aucun libellé « échelle nominale » : le repère a été retiré de la piste (passe de finition
  // 2D), parce qu'un trait plus épais au milieu du décor se lisait comme une ligne d'arrivée.

  startButton: 'Lancer',
  replayButton: 'Rejouer',
  // Barre de relecture (passe corrective 2) : elle n'apparaît que pendant une pause manuelle.
  replayTitle: 'Revoir',
  replayBack: '−2 s',
  replayForward: '+2 s',
  pauseButton: 'Pause',
  resumeButton: 'Reprendre',
  checkpointBanner: 'CHECKPOINT',

  // Réglages locaux (P012, libellés revus par la passe corrective) : deux interrupteurs explicites,
  // nommés par ce qu'ils activent, et non par ce qu'ils coupent. Aucun de ces libellés n'est une
  // réplique : ils décrivent l'interface.
  queuedLines: '{n} en attente',
  settingsTitle: 'Réglages',
  soundLabel: 'Son',
  commentatorLabel: 'Commentateur',
  settingsOn: 'activé',
  settingsOff: 'coupé',

  // Retour visuel d'événement : un mot, une couleur, jamais une phrase. Les clés sont les `EventId`
  // du catalogue `src/core/events.ts` ; le rendu les lit, il ne les invente pas.
  eventLabels: {
    TURBO: 'TURBO !',
    CHUTE: 'CHUTE !',
    VENT_DE_FACE: 'VENT DE FACE !',
    RACCOURCI: 'RACCOURCI !',
    POULET: 'POULET !',
    SIESTE: 'SIESTE !',
    MEGA_TURBO: 'MEGA TURBO !',
  },
  eventFeedback: {
    bonus: 'BONUS !',
    malus: 'MALUS !',
    positive: 'positif',
    negative: 'négatif',
  },
  voiceEnabledConfirmation: "Let's go!",

  // Écran d'arrivée (P013). Ces libellés décrivent l'interface ; la seule phrase « parlée » reste une
  // réplique du catalogue, choisie par le speaker à partir d'un fait d'arrivée réel.
  finishTitle: 'Arrivée',
  finishWinnerLabel: 'Vainqueur',
  finishPodiumTitle: 'Podium',
  finishRankingTitle: 'Classement final',
  // Passages en tête : les deux checkpoints réellement observés, puis l'arrivée. Les libellés des
  // bornes sont ceux du HUD (`checkpointTitle`) et de l'écran d'arrivée (`finishTitle`) : il n'existe
  // pas de « checkpoint 3 », la troisième borne est l'arrivée.
  finishPassagesTitle: 'Passages en tête',
  finishPhotoBadge: 'Photo finish',
  finishReplaySameSeed: 'Rejouer la même seed',
  finishNewRace: 'Nouvelle course',

  // Panneau « persos » (micro-correction responsive) : un bouton discret à côté de la seed ouvre les
  // six personnages en grand. Ces libellés décrivent l'interface ; ils ne sont jamais prononcés.
  galleryButton: 'Persos',
  galleryTitle: 'Les personnages',
  galleryClose: 'Fermer',

  // Écran de rotation (correction iPhone ciblée) : sur un téléphone tenu droit, la course n'est pas
  // affichée du tout — cet écran plein la remplace, et aucun pas n'est exécuté pendant ce temps. La
  // phrase est celle demandée mot pour mot ; la seconde ligne dit seulement ce qui va se passer.
  rotationGateTitle: 'Tourne ton iPhone en paysage pour jouer',
  rotationGateHint: 'La course reprend là où elle en est.',
});

// -------------------------------------------------------------------------------------------
// P009-C — textes du speaker
// -------------------------------------------------------------------------------------------

/**
 * ## Véracité des répliques
 *
 * Chaque variante est une fonction pure `RaceFact → string`. Elle ne lit que les champs du fait
 * (`characterIds`, `magnitudes`) et refuse explicitement un fait dont la forme ne correspond pas à
 * son type : aucune position, aucune vitesse, aucune cause ne peut donc être inventée. Les
 * accesseurs ci-dessous lèvent une `RangeError` plutôt que de renvoyer `undefined` ou zéro.
 *
 * ## Arrondis
 *
 * Tous les nombres visibles passent par **`src/render/format.ts`**, le module unique de présentation.
 * Deux familles seulement, toutes deux non trompeuses :
 *
 * * les grandeurs **continues** (mètres, écarts) sont écrites avec **une décimale**, format français
 *   (`3,2 m`) ;
 * * les grandeurs **entières** (places, rangs, dépassements, durées, pourcentages) sont écrites
 *   **sans décimale** : `4 dépassements`, `6 s`, `36 %`.
 *
 * La passe corrective issue du premier test joueur manuel a corrigé ici même trois fuites de flottant
 * bruts (`String(magnitudeAt(fact, 1))` pour une durée, `String(magnitudeAt(fact, 0))` pour un
 * compte) : un joueur pouvait lire `6.133333333333333 s`. Aucune valeur n'est arrondie « vers le
 * haut » pour faire plus spectaculaire : les distances des checkpoints et des arrivées sont tronquées
 * au mètre (`Math.floor`), jamais arrondies au plus proche.
 */

/** Valeur mesurée d'un fait, refusée si elle est absente : un placeholder manquant est un bug. */
function magnitudeAt(fact: RaceFact, index: number): number {
  const value = fact.magnitudes[index];
  if (value === undefined) {
    throw new RangeError(`Fait ${fact.type} : magnitude ${index} absente (reçu ${fact.magnitudes.length}).`);
  }
  return value;
}

/** Personnage d'un fait, refusé si l'index n'existe pas. */
function characterAt(fact: RaceFact, index: number): CharacterId {
  const id = fact.characterIds[index];
  if (id === undefined) {
    throw new RangeError(`Fait ${fact.type} : personnage ${index} absent (reçu ${fact.characterIds.length}).`);
  }
  return id;
}

/** Nom officiel du roster : les répliques ne nomment jamais un personnage qui n'existe pas. */
export function characterNameFr(id: CharacterId): string {
  const character = CHARACTERS.find((candidate) => candidate.id === id);
  if (character === undefined) {
    throw new RangeError(`Personnage hors roster : « ${id} ».`);
  }
  return character.name;
}

/** Nom du personnage à l'index `index` du fait. */
function nameAt(fact: RaceFact, index: number): string {
  return characterNameFr(characterAt(fact, index));
}

/** Nombre à une décimale, virgule française : `3.24` → `« 3,2 »`. */
export function formatNumberFr(value: number): string {
  return formatDecimal(value, DISPLAY_DECIMALS.METRES);
}

/** Distance en mètres, une décimale, virgule française : `3.24` → `« 3,2 m »`. */
export function formatMetresFr(value: number): string {
  return formatMetres(value);
}

/** Distance **tronquée** au mètre : jamais arrondie au plus proche, donc jamais surestimée. */
export function formatTruncatedMetresFr(value: number): string {
  return formatTruncatedMetres(value);
}

/**
 * Places gagnées, en **places** : jamais en mètres.
 *
 * `BIG_COMEBACK` et `LAST_COMEBACK` publient `[placesGagnées, rangCourant]` : la première magnitude
 * est un nombre de places, pas une distance. Le mot est donc obligatoire, et le pluriel suit la
 * valeur (`1 place`, `4 places`).
 */
export function formatPlacesFr(value: number): string {
  const places = Math.round(value);
  return `${String(places)} place${Math.abs(places) >= 2 ? 's' : ''}`;
}

/**
 * Pénalité de vitesse d'un événement, exprimée en pour cent **positifs**.
 *
 * Les magnitudes de `LEADER_MALUS` sont **négatives** (`CHUTE` : `-0.6`, `SIESTE` : `-0.7`) : la
 * valeur absolue n'est prise que pour l'affichage, afin de ne jamais écrire « -60 % en moins ».
 */
export function formatPenaltyPercentFr(magnitude: number): string {
  return `${formatPercent(Math.abs(magnitude) * 100)} en moins`;
}

/** Durée d'un événement, en secondes simulées : `6 s`, jamais `6.133333333333333 s`. */
export function formatEventDurationFr(seconds: number): string {
  return formatSeconds(seconds);
}

/** Compte entier d'un fait (dépassements, places) : `4`, jamais `4.000000000000001`. */
export function formatCountValueFr(value: number): string {
  return formatCount(value);
}

/** Rang ordinal **masculin** — « un rang » : `1` → `« 1er »`, `2` → `« 2e »`, `3` → `« 3e »`… */
function rankLabel(rank: number): string {
  const value = Math.trunc(rank);
  return value === 1 ? '1er' : `${String(value)}e`;
}

/** Rang ordinal **féminin** — « une place » : `1` → `« 1re place »`, `2` → `« 2e place »`… */
function placeLabel(rank: number): string {
  const value = Math.trunc(rank);
  return value === 1 ? '1re place' : `${String(value)}e place`;
}

/**
 * Ordre stable de déclaration des types de faits : sert au contrôle d'exhaustivité des tests et à
 * la lecture. Il correspond à `RaceFactType` de `src/core/types.ts`.
 */
export const SPEAKER_FACT_TYPES: readonly RaceFactType[] = Object.freeze([
  'LEADER_CHANGE',
  'BIG_COMEBACK',
  'OVERTAKE_STREAK',
  'BIG_BONUS',
  'LEADER_MALUS',
  'CLOSE_RACE',
  'LAST_COMEBACK',
  'CHECKPOINT_SPLIT',
  'FINISH',
  'PHOTO_FINISH',
]);

/**
 * Les variantes françaises, **3 à 6 par type** (`GAME_DESIGN.md` §9.4).
 *
 * Le ton est énergique et loufoque, les phrases courtes : elles sont lues pendant une course. Aucune
 * n'utilise un chiffre qui ne soit pas dans le fait source, et aucune ne cite une position qui ne
 * soit pas explicitement portée par `magnitudes`.
 */
export const SPEAKER_LINES_FR: Readonly<Record<RaceFactType, readonly ((fact: RaceFact) => string)[]>> =
  Object.freeze({
    // magnitudes = [marge P1–P2, secondes de règne du précédent]
    LEADER_CHANGE: Object.freeze([
      (fact: RaceFact) => `Et voilà ${nameAt(fact, 0)} qui prend les commandes, avec ${formatMetresFr(magnitudeAt(fact, 0))} d'avance !`,
      (fact: RaceFact) => `${nameAt(fact, 0)} passe devant ! ${formatMetresFr(magnitudeAt(fact, 0))} d'écart, et personne ne rigole.`,
      (fact: RaceFact) => `Changement de leader : ${nameAt(fact, 0)} mène de ${formatMetresFr(magnitudeAt(fact, 0))} !`,
      (fact: RaceFact) => `${nameAt(fact, 0)} s'installe en tête : ${formatMetresFr(magnitudeAt(fact, 0))} d'avance sur le suivant.`,
      (fact: RaceFact) => `Après ${formatNumberFr(magnitudeAt(fact, 1))} s de règne, ${nameAt(fact, 1)} lâche la première place : ${nameAt(fact, 0)} reprend la main !`,
      (fact: RaceFact) => `Le trône change de locataire : ${nameAt(fact, 0)} devant, ${formatMetresFr(magnitudeAt(fact, 0))} dans la vue du deuxième !`,
    ]),

    // magnitudes = [places gagnées, rang courant]
    BIG_COMEBACK: Object.freeze([
      (fact: RaceFact) => `${nameAt(fact, 0)} remonte de ${formatPlacesFr(magnitudeAt(fact, 0))} : voilà le ${rankLabel(magnitudeAt(fact, 1))} !`,
      (fact: RaceFact) => `${nameAt(fact, 0)} a mangé ${formatPlacesFr(magnitudeAt(fact, 0))} en un éclair, et pointe au ${rankLabel(magnitudeAt(fact, 1))} rang !`,
      (fact: RaceFact) => `Remontée express : ${nameAt(fact, 0)} gagne ${formatPlacesFr(magnitudeAt(fact, 0))} et se retrouve ${rankLabel(magnitudeAt(fact, 1))} !`,
      (fact: RaceFact) => `${nameAt(fact, 0)} n'était pas invité, le revoilà ${rankLabel(magnitudeAt(fact, 1))} : ${formatPlacesFr(magnitudeAt(fact, 0))} de grimpées !`,
      (fact: RaceFact) => `On ne l'avait pas vu venir : ${nameAt(fact, 0)} bondit de ${formatPlacesFr(magnitudeAt(fact, 0))} jusqu'au ${rankLabel(magnitudeAt(fact, 1))} rang !`,
    ]),

    // magnitudes = [dépassements dans la fenêtre]
    OVERTAKE_STREAK: Object.freeze([
      (fact: RaceFact) => `${nameAt(fact, 0)} enquille ${formatCountValueFr(magnitudeAt(fact, 0))} dépassements d'affilée, c'est une moissonneuse !`,
      (fact: RaceFact) => `${formatCountValueFr(magnitudeAt(fact, 0))} dépassements en cinq secondes pour ${nameAt(fact, 0)} : quelqu'un a oublié le frein !`,
      (fact: RaceFact) => `${nameAt(fact, 0)} double tout ce qui bouge : ${formatCountValueFr(magnitudeAt(fact, 0))} fois, sans demander la permission !`,
      (fact: RaceFact) => `Autoroute pour ${nameAt(fact, 0)} : ${formatCountValueFr(magnitudeAt(fact, 0))} dépassements, les autres font de la figuration !`,
      (fact: RaceFact) => `${nameAt(fact, 0)} distribue les dépassements : ${formatCountValueFr(magnitudeAt(fact, 0))} en un rien de temps !`,
    ]),

    // magnitudes = [magnitude de l'événement, durée, rang au moment du tirage]
    BIG_BONUS: Object.freeze([
      (fact: RaceFact) => `${nameAt(fact, 0)} déclenche un bonus de ${formatPercent(magnitudeAt(fact, 0) * 100)} pendant ${formatEventDurationFr(magnitudeAt(fact, 1))} !`,
      (fact: RaceFact) => `Coup de boost pour ${nameAt(fact, 0)} : +${formatPercent(magnitudeAt(fact, 0) * 100)} pendant ${formatEventDurationFr(magnitudeAt(fact, 1))} !`,
      (fact: RaceFact) => `${nameAt(fact, 0)} touche le jackpot : ${formatPercent(magnitudeAt(fact, 0) * 100)} de mieux pendant ${formatEventDurationFr(magnitudeAt(fact, 1))} !`,
      (fact: RaceFact) => `Bonus pour ${nameAt(fact, 0)} : ${formatPercent(magnitudeAt(fact, 0) * 100)} de vitesse en plus, ${formatEventDurationFr(magnitudeAt(fact, 1))} pour en profiter !`,
      (fact: RaceFact) => `${nameAt(fact, 0)} appuie sur le champignon : +${formatPercent(magnitudeAt(fact, 0) * 100)} pendant ${formatEventDurationFr(magnitudeAt(fact, 1))}, avec le ${rankLabel(magnitudeAt(fact, 2))} rang au tirage !`,
      (fact: RaceFact) => `Le hasard gâte ${nameAt(fact, 0)} : ${formatPercent(magnitudeAt(fact, 0) * 100)} de vitesse en plus, et le ${rankLabel(magnitudeAt(fact, 2))} rang au moment du tirage !`,
    ]),

    // magnitudes = [magnitude de l'événement (négative), durée, rang au moment du tirage] ; le rang vaut 1
    LEADER_MALUS: Object.freeze([
      (fact: RaceFact) => `Aïe pour ${nameAt(fact, 0)} : ${formatPenaltyPercentFr(magnitudeAt(fact, 0))} pendant ${formatEventDurationFr(magnitudeAt(fact, 1))}, et c'est le leader qui trinque !`,
      (fact: RaceFact) => `Coup dur pour ${nameAt(fact, 0)}, leader : ${formatPenaltyPercentFr(magnitudeAt(fact, 0))} de vitesse pendant ${formatEventDurationFr(magnitudeAt(fact, 1))} !`,
      (fact: RaceFact) => `${nameAt(fact, 0)} était devant, il prend une pénalité de ${formatPenaltyPercentFr(magnitudeAt(fact, 0))} pendant ${formatEventDurationFr(magnitudeAt(fact, 1))} !`,
      (fact: RaceFact) => `Le sort s'acharne sur ${nameAt(fact, 0)} : ${formatPenaltyPercentFr(magnitudeAt(fact, 0))} pendant ${formatEventDurationFr(magnitudeAt(fact, 1))}, juste quand il mène !`,
      (fact: RaceFact) => `Ça sent le roussi pour ${nameAt(fact, 0)} : ${formatPenaltyPercentFr(magnitudeAt(fact, 0))} pendant ${formatEventDurationFr(magnitudeAt(fact, 1))}, en tête de course !`,
    ]),

    // magnitudes = [écart P1–P3, secondes écoulées]
    CLOSE_RACE: Object.freeze([
      (fact: RaceFact) => `Ils sont trois dans ${formatMetresFr(magnitudeAt(fact, 0))} depuis ${formatNumberFr(magnitudeAt(fact, 1))} s : ça se touche !`,
      (fact: RaceFact) => `Écart leader-troisième : ${formatMetresFr(magnitudeAt(fact, 0))} pendant ${formatNumberFr(magnitudeAt(fact, 1))} s !`,
      (fact: RaceFact) => `Trois prétendants dans un mouchoir : ${formatMetresFr(magnitudeAt(fact, 0))} depuis ${formatNumberFr(magnitudeAt(fact, 1))} s !`,
      (fact: RaceFact) => `${nameAt(fact, 0)} et ${nameAt(fact, 1)} se frottent les épaules : ${formatMetresFr(magnitudeAt(fact, 0))} d'écart depuis ${formatNumberFr(magnitudeAt(fact, 1))} s !`,
      (fact: RaceFact) => `Personne ne lâche : ${formatMetresFr(magnitudeAt(fact, 0))} entre les trois de tête depuis ${formatNumberFr(magnitudeAt(fact, 1))} s !`,
    ]),

    // magnitudes = [places gagnées, rang courant]
    LAST_COMEBACK: Object.freeze([
      (fact: RaceFact) => `${nameAt(fact, 0)} était dernier, le revoilà ${rankLabel(magnitudeAt(fact, 1))} : ${formatPlacesFr(magnitudeAt(fact, 0))} avalées !`,
      (fact: RaceFact) => `Retour des abysses : ${nameAt(fact, 0)} quitte la cave et grimpe à la ${placeLabel(magnitudeAt(fact, 1))} !`,
      (fact: RaceFact) => `${nameAt(fact, 0)} sort de la cave : ${formatPlacesFr(magnitudeAt(fact, 0))} de gagnées, ${rankLabel(magnitudeAt(fact, 1))} au classement !`,
      (fact: RaceFact) => `On l'avait enterré trop vite : ${nameAt(fact, 0)} remonte ${formatPlacesFr(magnitudeAt(fact, 0))} et pointe ${rankLabel(magnitudeAt(fact, 1))} !`,
      (fact: RaceFact) => `${nameAt(fact, 0)} fait le ménage dans le classement : ${formatPlacesFr(magnitudeAt(fact, 0))} de remontées, ${rankLabel(magnitudeAt(fact, 1))} !`,
    ]),

    // magnitudes = distances dans l'ordre du classement (P1 → P6), du plus loin au moins loin
    CHECKPOINT_SPLIT: Object.freeze([
      (fact: RaceFact) => `Checkpoint : ${formatTruncatedMetresFr(magnitudeAt(fact, 0))} pour ${nameAt(fact, 0)}, ${formatTruncatedMetresFr(magnitudeAt(fact, 1))} pour ${nameAt(fact, 1)}, ${formatTruncatedMetresFr(magnitudeAt(fact, 2))} pour ${nameAt(fact, 2)} !`,
      (fact: RaceFact) => `Les compteurs parlent : ${nameAt(fact, 0)} à ${formatTruncatedMetresFr(magnitudeAt(fact, 0))}, ${nameAt(fact, 1)} à ${formatTruncatedMetresFr(magnitudeAt(fact, 1))}, ${nameAt(fact, 2)} à ${formatTruncatedMetresFr(magnitudeAt(fact, 2))} !`,
      (fact: RaceFact) => `Relevé de mi-course : ${nameAt(fact, 0)} mène à ${formatTruncatedMetresFr(magnitudeAt(fact, 0))}, dernier ${nameAt(fact, 5)} à ${formatTruncatedMetresFr(magnitudeAt(fact, 5))} !`,
      (fact: RaceFact) => `Checkpoint officiel : ${nameAt(fact, 0)} à ${formatTruncatedMetresFr(magnitudeAt(fact, 0))}, ${nameAt(fact, 5)} à ${formatTruncatedMetresFr(magnitudeAt(fact, 5))}, et tout le monde transpire !`,
      (fact: RaceFact) => `Ça se resserre : ${nameAt(fact, 0)} à ${formatTruncatedMetresFr(magnitudeAt(fact, 0))}, ${nameAt(fact, 5)} à ${formatTruncatedMetresFr(magnitudeAt(fact, 5))}, et personne ne lâche !`,
    ]),

    // magnitudes = [écart P1–P2, distance du 1er, distance du 2e]
    FINISH: Object.freeze([
      (fact: RaceFact) => `Victoire de ${nameAt(fact, 0)} ! ${nameAt(fact, 1)} suit à ${formatMetresFr(magnitudeAt(fact, 0))} !`,
      (fact: RaceFact) => `${nameAt(fact, 0)} franchit la ligne en tête, avec ${formatMetresFr(magnitudeAt(fact, 0))} d'avance sur ${nameAt(fact, 1)} !`,
      (fact: RaceFact) => `C'est fini : ${nameAt(fact, 0)} premier, ${nameAt(fact, 1)} deuxième à ${formatMetresFr(magnitudeAt(fact, 0))} !`,
      (fact: RaceFact) => `Arrivée : ${nameAt(fact, 0)} à ${formatMetresFr(magnitudeAt(fact, 1))}, ${nameAt(fact, 1)} à ${formatMetresFr(magnitudeAt(fact, 2))} !`,
      (fact: RaceFact) => `${nameAt(fact, 0)} gagne avec ${formatMetresFr(magnitudeAt(fact, 1))} au compteur, ${formatMetresFr(magnitudeAt(fact, 0))} devant ${nameAt(fact, 1)} !`,
    ]),

    // magnitudes = [écart P1–P2, distance du 1er, distance du 2e] ; l'écart est strictement < 5 m
    PHOTO_FINISH: Object.freeze([
      (fact: RaceFact) => `PHOTO FINISH ! ${nameAt(fact, 0)} et ${nameAt(fact, 1)} dans ${formatMetresFr(magnitudeAt(fact, 0))} : les juges vont transpirer !`,
      (fact: RaceFact) => `Il faut la photo ! ${formatMetresFr(magnitudeAt(fact, 0))} entre ${nameAt(fact, 0)} et ${nameAt(fact, 1)} !`,
      (fact: RaceFact) => `Arrivée au fil du poil : ${nameAt(fact, 0)} devant ${nameAt(fact, 1)} pour ${formatMetresFr(magnitudeAt(fact, 0))} !`,
      (fact: RaceFact) => `Personne n'a rien vu : ${formatMetresFr(magnitudeAt(fact, 0))} séparent ${nameAt(fact, 0)} et ${nameAt(fact, 1)} !`,
      (fact: RaceFact) => `Départage au millimètre près : ${nameAt(fact, 0)} ${formatMetresFr(magnitudeAt(fact, 1))}, ${nameAt(fact, 1)} ${formatMetresFr(magnitudeAt(fact, 2))}, écart ${formatMetresFr(magnitudeAt(fact, 0))} !`,
    ]),
  });

/** Catalogue complet, sous la forme attendue par `RaceCommentary` et par `render/subtitle.ts`. */
export const SPEAKER_CATALOGUE_FR: SpeakerCatalogue = Object.freeze({
  lines: SPEAKER_LINES_FR,
});
