import { CHARACTER_IDS } from './characters';
import { forkStream } from './rng';
import type { CharacterId } from './types';

/**
 * Qui court : le **roster complet** reste figé à six personnages, mais une course n'en aligne
 * qu'une **partie** (`participants`), choisie automatiquement.
 *
 * ## Pourquoi ce module vit dans `core/`
 *
 * Le choix des partants fait partie de l'**identité d'une course** : deux appareils qui partagent la
 * même seed et le même effectif doivent aligner exactement les mêmes personnages, sur les mêmes
 * voies. Il est donc déterministe, sans `Math.random`, sans fonction transcendante, et il ne consomme
 * **aucun** des flux de la course (`drift:*`, `surge:*`, `events:*`) : il ouvre son propre flux nommé,
 * `participants`, dérivé de la seed interne. Conséquence directe et voulue : tirer les partants ne
 * peut pas décaler une dérive, un surge ou un événement.
 *
 * ## Le cas à six ne tire rien
 *
 * À six partants, la sélection n'a pas lieu : `CHARACTER_IDS` est renvoyé **tel quel**, sans ouvrir de
 * flux ni consommer un seul tirage. C'est ce qui garantit qu'une seed jouée à six coureurs produit
 * exactement la course qu'elle produisait avant cette fonctionnalité — même sous-ensemble (le roster
 * entier), même ordre, mêmes distances, mêmes faits.
 *
 * ## Ordre canonique
 *
 * Le sous-ensemble est **retrié** dans l'ordre du roster (`c0` … `c5`) avant d'être renvoyé. Les voies,
 * les tableaux d'état et le départage des égalités (`RANK.TIE_BREAK = 'ascendingId'`) supposent tous
 * des identifiants croissants : l'index d'un personnage dans la course reste donc comparable à son
 * identifiant, même quand la course n'aligne que trois coureurs.
 */

/**
 * Label du flux dédié au choix des partants.
 *
 * Il rejoint la liste documentée des flux (`GAME_DESIGN.md` §10) : c'est un flux **de course**, au même
 * titre que `drift:*`, mais il n'est ouvert que pour un effectif inférieur au roster complet.
 */
export const PARTICIPANT_STREAM_LABEL = 'participants';

/** Effectif minimal d'une course. En dessous de trois, un podium n'aurait plus de sens. */
export const MIN_PARTICIPANTS = 3;

/** Effectif maximal : le roster complet, qui est aussi la valeur par défaut et l'ancien comportement. */
export const MAX_PARTICIPANTS = CHARACTER_IDS.length;

/** Effectif par défaut d'une course, quand rien ne le précise. */
export const DEFAULT_PARTICIPANTS = MAX_PARTICIPANTS;

/** Indices du roster complet, dans l'ordre canonique. Base du tirage sans remise. */
const ROSTER_INDEXES: readonly number[] = Object.freeze(
  CHARACTER_IDS.map((_, index) => index),
);

/**
 * Effectif **valide** le plus proche d'une valeur quelconque.
 *
 * Toute entrée illisible (`null`, texte vide, `7`, `2`, `abc`) retombe sur `DEFAULT_PARTICIPANTS` :
 * c'est la règle des paramètres d'URL du projet, où une valeur invalide ne doit jamais empêcher la
 * course de démarrer, mais ne doit jamais non plus inventer un effectif.
 */
export function normalizeParticipants(value: unknown): number {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim().length > 0
        ? Number(value)
        : Number.NaN;

  if (!Number.isInteger(parsed)) {
    return DEFAULT_PARTICIPANTS;
  }
  if (parsed < MIN_PARTICIPANTS || parsed > MAX_PARTICIPANTS) {
    return DEFAULT_PARTICIPANTS;
  }
  return parsed;
}

/** Refuse un effectif hors bornes : un appel interne avec `2` ou `7` est un bug, pas une donnée. */
function requireParticipants(participants: number): number {
  if (!Number.isInteger(participants) || participants < MIN_PARTICIPANTS || participants > MAX_PARTICIPANTS) {
    throw new RangeError(
      `Effectif invalide : ${participants} (attendu : entier de ${MIN_PARTICIPANTS} à ${MAX_PARTICIPANTS}).`,
    );
  }
  return participants;
}

/** Échange deux cases du pool de tirage, en refusant une case absente. */
function swap(pool: number[], left: number, right: number): void {
  const a = pool[left];
  const b = pool[right];
  if (a === undefined || b === undefined) {
    throw new RangeError(`Tirage des partants hors bornes (${left}, ${right}).`);
  }
  pool[left] = b;
  pool[right] = a;
}

/**
 * Partants d'une course, dans l'ordre canonique du roster.
 *
 * Le tirage est un **mélange partiel** de Fisher-Yates : les `count` premières cases du pool sont
 * remplacées par un tirage sans remise, donc chaque sous-ensemble de `count` personnages a exactement
 * la même probabilité — aucune combinaison n'est privilégiée, et aucune position du roster non plus.
 */
export function selectParticipants(seedValue: number, participants: number): readonly CharacterId[] {
  const count = requireParticipants(participants);

  // À effectif complet, **aucun** tirage : le sous-ensemble est le roster, dans son ordre, et rien
  // n'est consommé. C'est la garantie de non-régression des courses à six.
  if (count >= MAX_PARTICIPANTS) {
    return CHARACTER_IDS;
  }

  const stream = forkStream(seedValue, PARTICIPANT_STREAM_LABEL);
  const pool = [...ROSTER_INDEXES];
  for (let index = 0; index < count; index += 1) {
    swap(pool, index, index + stream.nextInt(0, pool.length - 1 - index));
  }

  const chosen = pool.slice(0, count).sort((left, right) => left - right);
  const ids: CharacterId[] = [];
  for (const index of chosen) {
    const id = CHARACTER_IDS[index];
    if (id === undefined) {
      throw new RangeError(`Index de roster hors bornes : ${index}.`);
    }
    ids.push(id);
  }
  return Object.freeze(ids);
}
