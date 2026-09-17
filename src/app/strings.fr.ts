import { CHARACTERS } from '../core/characters';
import type { CharacterId, RaceFact, RaceFactType } from '../core/types';
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

  nominalScale: 'échelle nominale',

  startButton: 'Lancer',
  replayButton: 'Rejouer',
  pauseButton: 'Pause',
  resumeButton: 'Reprendre',
  checkpointBanner: 'CHECKPOINT',

  // Titre du bandeau de commentaire (P009-C) : c'est un libellé d'interface, pas une réplique.
  speakerBannerTitle: 'MICRO',
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
 * Deux familles seulement, toutes deux non trompeuses :
 *
 * * les grandeurs **continues** (mètres, secondes) sont écrites avec **une décimale**, format
 *   français (`3,2 m`) ;
 * * les grandeurs **entières** (places, rangs, dépassements, durées entières) sont écrites telles
 *   quelles, sans arrondi du tout.
 *
 * Aucune valeur n'est arrondie « vers le haut » pour faire plus spectaculaire : les distances des
 * pointages et des arrivées sont tronquées au mètre (`Math.floor`), jamais arrondies au plus proche.
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
  return value.toFixed(1).replace('.', ',');
}

/** Distance en mètres, une décimale, virgule française : `3.24` → `« 3,2 m »`. */
export function formatMetresFr(value: number): string {
  return `${formatNumberFr(value)} m`;
}

/** Distance **tronquée** au mètre : jamais arrondie au plus proche, donc jamais surestimée. */
export function formatTruncatedMetresFr(value: number): string {
  return `${String(Math.floor(value))} m`;
}

/**
 * Places gagnées, en **places** : jamais en mètres.
 *
 * `BIG_COMEBACK` et `LAST_COMEBACK` publient `[placesGagnées, rangCourant]` : la première magnitude
 * est un nombre de places, pas une distance. Le mot est donc obligatoire, et le pluriel suit la
 * valeur (`1 place`, `4 places`).
 */
export function formatPlacesFr(value: number): string {
  const places = Math.trunc(value);
  return `${String(places)} place${Math.abs(places) >= 2 ? 's' : ''}`;
}

/**
 * Pénalité de vitesse d'un événement, exprimée en pour cent **positifs**.
 *
 * Les magnitudes de `LEADER_MALUS` sont **négatives** (`CHUTE` : `-0.6`, `SIESTE` : `-0.7`) : la
 * valeur absolue n'est prise que pour l'affichage, afin de ne jamais écrire « -60 % en moins ».
 */
export function formatPenaltyPercentFr(magnitude: number): string {
  return `${String(Math.round(Math.abs(magnitude) * 100))} % en moins`;
}

/** Rang ordinal : `1` → `« 1re »`, `2` → `« 2e »`, `3` → `« 3e »`… */
function rankLabel(rank: number): string {
  const value = Math.trunc(rank);
  return value === 1 ? '1re' : `${String(value)}e`;
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
      (fact: RaceFact) => `${nameAt(fact, 0)} enquille ${String(magnitudeAt(fact, 0))} dépassements d'affilée, c'est une moissonneuse !`,
      (fact: RaceFact) => `${String(magnitudeAt(fact, 0))} dépassements en cinq secondes pour ${nameAt(fact, 0)} : quelqu'un a oublié le frein !`,
      (fact: RaceFact) => `${nameAt(fact, 0)} double tout ce qui bouge : ${String(magnitudeAt(fact, 0))} fois, sans demander la permission !`,
      (fact: RaceFact) => `Autoroute pour ${nameAt(fact, 0)} : ${String(magnitudeAt(fact, 0))} dépassements, les autres font de la figuration !`,
      (fact: RaceFact) => `${nameAt(fact, 0)} distribue les dépassements : ${String(magnitudeAt(fact, 0))} en un rien de temps !`,
    ]),

    // magnitudes = [magnitude de l'événement, durée, rang au moment du tirage]
    BIG_BONUS: Object.freeze([
      (fact: RaceFact) => `${nameAt(fact, 0)} déclenche un bonus de ${String(Math.round(magnitudeAt(fact, 0) * 100))} % pendant ${String(magnitudeAt(fact, 1))} s !`,
      (fact: RaceFact) => `Coup de boost pour ${nameAt(fact, 0)} : +${String(Math.round(magnitudeAt(fact, 0) * 100))} % pendant ${String(magnitudeAt(fact, 1))} s !`,
      (fact: RaceFact) => `${nameAt(fact, 0)} touche le jackpot : ${String(Math.round(magnitudeAt(fact, 0) * 100))} % de mieux pendant ${String(magnitudeAt(fact, 1))} s !`,
      (fact: RaceFact) => `Bonus pour ${nameAt(fact, 0)} : ${String(Math.round(magnitudeAt(fact, 0) * 100))} % de vitesse en plus, ${String(magnitudeAt(fact, 1))} s pour en profiter !`,
      (fact: RaceFact) => `${nameAt(fact, 0)} appuie sur le champignon : +${String(Math.round(magnitudeAt(fact, 0) * 100))} % pendant ${String(magnitudeAt(fact, 1))} s, avec le ${rankLabel(magnitudeAt(fact, 2))} rang au tirage !`,
      (fact: RaceFact) => `Le hasard gâte ${nameAt(fact, 0)} : ${String(Math.round(magnitudeAt(fact, 0) * 100))} % de vitesse en plus, et le ${rankLabel(magnitudeAt(fact, 2))} rang au moment du tirage !`,
    ]),

    // magnitudes = [magnitude de l'événement (négative), durée, rang au moment du tirage] ; le rang vaut 1
    LEADER_MALUS: Object.freeze([
      (fact: RaceFact) => `Aïe pour ${nameAt(fact, 0)} : ${formatPenaltyPercentFr(magnitudeAt(fact, 0))} pendant ${String(magnitudeAt(fact, 1))} s, et c'est le leader qui trinque !`,
      (fact: RaceFact) => `Coup dur pour ${nameAt(fact, 0)}, leader : ${formatPenaltyPercentFr(magnitudeAt(fact, 0))} de vitesse pendant ${String(magnitudeAt(fact, 1))} s !`,
      (fact: RaceFact) => `${nameAt(fact, 0)} était devant, il prend une pénalité de ${formatPenaltyPercentFr(magnitudeAt(fact, 0))} pendant ${String(magnitudeAt(fact, 1))} s !`,
      (fact: RaceFact) => `Le sort s'acharne sur ${nameAt(fact, 0)} : ${formatPenaltyPercentFr(magnitudeAt(fact, 0))} pendant ${String(magnitudeAt(fact, 1))} s, juste quand il mène !`,
      (fact: RaceFact) => `Ça sent le roussi pour ${nameAt(fact, 0)} : ${formatPenaltyPercentFr(magnitudeAt(fact, 0))} pendant ${String(magnitudeAt(fact, 1))} s, en tête de course !`,
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
      (fact: RaceFact) => `Retour des abysses : ${nameAt(fact, 0)} quitte la cave et grimpe à la ${rankLabel(magnitudeAt(fact, 1))} place !`,
      (fact: RaceFact) => `${nameAt(fact, 0)} sort de la cave : ${formatPlacesFr(magnitudeAt(fact, 0))} de gagnées, ${rankLabel(magnitudeAt(fact, 1))} au classement !`,
      (fact: RaceFact) => `On l'avait enterré trop vite : ${nameAt(fact, 0)} remonte ${formatPlacesFr(magnitudeAt(fact, 0))} et pointe ${rankLabel(magnitudeAt(fact, 1))} !`,
      (fact: RaceFact) => `${nameAt(fact, 0)} fait le ménage dans le classement : ${formatPlacesFr(magnitudeAt(fact, 0))} de remontées, ${rankLabel(magnitudeAt(fact, 1))} !`,
    ]),

    // magnitudes = distances dans l'ordre du classement (P1 → P6), du plus loin au moins loin
    CHECKPOINT_SPLIT: Object.freeze([
      (fact: RaceFact) => `Pointage : ${formatTruncatedMetresFr(magnitudeAt(fact, 0))} pour ${nameAt(fact, 0)}, ${formatTruncatedMetresFr(magnitudeAt(fact, 1))} pour ${nameAt(fact, 1)}, ${formatTruncatedMetresFr(magnitudeAt(fact, 2))} pour ${nameAt(fact, 2)} !`,
      (fact: RaceFact) => `Les compteurs parlent : ${nameAt(fact, 0)} à ${formatTruncatedMetresFr(magnitudeAt(fact, 0))}, ${nameAt(fact, 1)} à ${formatTruncatedMetresFr(magnitudeAt(fact, 1))}, ${nameAt(fact, 2)} à ${formatTruncatedMetresFr(magnitudeAt(fact, 2))} !`,
      (fact: RaceFact) => `Relevé de mi-course : ${nameAt(fact, 0)} mène à ${formatTruncatedMetresFr(magnitudeAt(fact, 0))}, dernier ${nameAt(fact, 5)} à ${formatTruncatedMetresFr(magnitudeAt(fact, 5))} !`,
      (fact: RaceFact) => `Pointage officiel : ${nameAt(fact, 0)} à ${formatTruncatedMetresFr(magnitudeAt(fact, 0))}, ${nameAt(fact, 5)} à ${formatTruncatedMetresFr(magnitudeAt(fact, 5))}, et tout le monde transpire !`,
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
