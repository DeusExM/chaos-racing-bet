import { CHARACTERS } from '../core/characters';
import { computeRanks, gapMeters, gapSeconds, sortByRank } from '../core/ranking';
import type { CharacterId, RaceState } from '../core/types';

/**
 * Classement affichable, dérivé **exclusivement** de `core/ranking.ts`.
 *
 * Ce module existe pour qu'il n'y ait qu'**une seule** façon de calculer un classement dans tout le
 * projet : le rendu, les hooks de test et l'application passent tous par ici, donc aucun d'eux ne
 * peut afficher un classement qui diverge du noyau. Il ne contient aucune règle : il ne fait que
 * mettre en forme ce que `computeRanks`, `sortByRank`, `gapMeters` et `gapSeconds` renvoient déjà.
 */

/** Une ligne du classement affiché. */
export interface LeaderboardRow {
  readonly id: CharacterId;
  readonly name: string;
  /** Rang de 1 (leader) au nombre de personnages. */
  readonly rank: number;
  /** Distance parcourue, en mètres — la seule source du classement. */
  readonly distance: number;
  /** Écart avec le leader, en mètres. Exactement `0` pour le leader. */
  readonly gapMeters: number;
  /**
   * Écart avec le leader, en secondes, par la convention du noyau (`core/ranking.ts`) :
   * `gap_m / SPEED.BASE`. Ce n'est **pas** un temps de passage mesuré, mais la durée qu'il faudrait
   * au poursuivant pour combler l'écart à la vitesse nominale — la seule convention du projet.
   */
  readonly gapSeconds: number;
}

/** Noms affichables, indexés par identifiant stable. */
function nameOf(id: CharacterId): string {
  for (const character of CHARACTERS) {
    if (character.id === id) {
      return character.name;
    }
  }
  return id;
}

/**
 * Construit le classement, du 1er au dernier, à partir des distances du noyau.
 *
 * L'ordre suit `sortByRank` et les rangs viennent de `computeRanks` : les deux s'appuient sur le
 * même comparateur, donc l'ordre affiché et les rangs affichés ne peuvent pas se contredire.
 */
export function buildLeaderboard(
  distances: readonly number[],
  ids: readonly CharacterId[],
): readonly LeaderboardRow[] {
  const ranks = computeRanks(distances, ids);
  const gaps = gapMeters(distances);
  const gapsS = gapSeconds(distances);

  return sortByRank(distances, ids).map((index) => {
    const id = ids[index];
    if (id === undefined) {
      throw new RangeError(`Index de classement hors bornes : ${index}.`);
    }
    return {
      id,
      name: nameOf(id),
      rank: ranks[index] ?? 0,
      distance: distances[index] ?? 0,
      gapMeters: gaps[index] ?? 0,
      gapSeconds: gapsS[index] ?? 0,
    };
  });
}

/** Classement d'un état du noyau, dans l'ordre du roster pour les distances et les identifiants. */
export function leaderboardOf(state: Readonly<RaceState>): readonly LeaderboardRow[] {
  return buildLeaderboard(
    state.characters.map((character) => character.x),
    state.characters.map((character) => character.id),
  );
}
