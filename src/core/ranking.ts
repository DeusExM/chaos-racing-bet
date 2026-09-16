import { RANK, SPEED } from './config';
import type { CharacterId } from './types';

/**
 * Classement et écarts.
 *
 * ## Invariant fondamental
 *
 * Le classement dépend **uniquement** des distances `x` et de l'identifiant stable qui départage les
 * égalités. Rien d'autre : ni l'historique, ni l'ordre d'appel, ni le rang précédent, ni le temps, ni
 * la position d'affichage. Toutes les fonctions de ce module sont **pures** et ne conservent aucun
 * état entre deux appels — il n'existe ici aucun « historique caché ». La détection des dépassements,
 * qui a besoin d'une mémoire, vit à part dans `./overtakes.ts`.
 *
 * ## Ce que ce module ne fait jamais
 *
 * * Il n'écrit **jamais** dans `x` : la seule écriture de position autorisée est l'intégration de la
 *   vitesse, dans le moteur.
 * * Il ne corrige **jamais** un classement et ne regroupe **jamais** les personnages : aucun
 *   rubber-banding, aucune resynchronisation.
 * * Il ne stocke **jamais** de rang dans un `CharacterState` : le rang est recalculé à la demande.
 */

interface Entry {
  readonly x: number;
  readonly id: CharacterId;
}

function requireFiniteDistances(xs: readonly number[]): void {
  for (const [index, x] of xs.entries()) {
    if (!Number.isFinite(x)) {
      throw new RangeError(`xs[${index}] doit être une distance finie (reçu : ${x}).`);
    }
  }
}

function requireIntegerRanks(ranks: readonly number[], label: string): void {
  for (const [index, rank] of ranks.entries()) {
    if (!Number.isInteger(rank) || rank < 1) {
      throw new RangeError(`${label}[${index}] doit être un rang entier supérieur ou égal à 1 (reçu : ${rank}).`);
    }
  }
}

function requireSameLength(a: readonly unknown[], b: readonly unknown[], labelA: string, labelB: string): void {
  if (a.length !== b.length) {
    throw new RangeError(`${labelA} (${a.length}) et ${labelB} (${b.length}) doivent avoir la même longueur.`);
  }
}

/**
 * Assemble distances et identifiants, en refusant tout ce qui rendrait le classement ambigu.
 *
 * Les identifiants doivent être uniques : deux personnages portant le même identifiant rendraient le
 * départage des égalités indéterminé.
 */
function buildEntries(xs: readonly number[], ids: readonly CharacterId[]): readonly Entry[] {
  requireSameLength(xs, ids, 'xs', 'ids');
  requireFiniteDistances(xs);

  const entries: Entry[] = [];
  for (const [index, x] of xs.entries()) {
    const id = ids[index];
    if (id === undefined) {
      throw new RangeError(`ids[${index}] est manquant.`);
    }
    entries.push({ x, id });
  }

  for (const [i, first] of entries.entries()) {
    for (const [j, second] of entries.entries()) {
      if (i < j && first.id === second.id) {
        throw new RangeError(`ids contient deux fois « ${first.id} » : le départage des égalités serait ambigu.`);
      }
    }
  }

  return entries;
}

/**
 * Ordre du classement : distance décroissante, puis politique `RANK.TIE_BREAK`.
 *
 * Renvoie une valeur négative si `a` devance `b`. Toutes les fonctions de tri et de rang s'appuient
 * sur ce comparateur unique : le classement calculé et le classement trié ne peuvent donc pas
 * diverger.
 */
function compareEntries(a: Entry, b: Entry): number {
  if (a.x !== b.x) {
    return a.x > b.x ? -1 : 1;
  }
  switch (RANK.TIE_BREAK) {
    case 'ascendingId':
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  }
}

/**
 * Rang de chaque personnage, aligné sur l'ordre des tableaux d'entrée.
 *
 * `rang_i = 1 + |{ j : j devance i }|` : le rang est **compté**, jamais attribué. Deux personnages à
 * distance égale sont départagés par identifiant croissant, ce qui garantit un résultat stable et
 * reproductible.
 */
export function computeRanks(xs: readonly number[], ids: readonly CharacterId[]): readonly number[] {
  const entries = buildEntries(xs, ids);

  const ranks: number[] = [];
  for (const [i, entry] of entries.entries()) {
    let ahead = 0;
    for (const [j, other] of entries.entries()) {
      if (j !== i && compareEntries(other, entry) < 0) {
        ahead += 1;
      }
    }
    ranks.push(ahead + 1);
  }

  return ranks;
}

/**
 * Indices des personnages, du 1er au dernier.
 *
 * Renvoie des **index** plutôt que des identifiants : ils se combinent directement avec `xs`, `ids`
 * et les rangs. Le tri suit exactement le comparateur du classement.
 */
export function sortByRank(xs: readonly number[], ids: readonly CharacterId[]): readonly number[] {
  return buildEntries(xs, ids)
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => compareEntries(a.entry, b.entry))
    .map((item) => item.index);
}

/**
 * Écart de chaque personnage avec le leader, en mètres : `gap_m_i = x_leader − x_i`.
 *
 * Toujours positif ou nul ; exactement `0` pour le leader. Aucun classement n'est nécessaire : le
 * leader est celui qui a la plus grande distance.
 */
export function gapMeters(xs: readonly number[]): readonly number[] {
  requireFiniteDistances(xs);
  if (xs.length === 0) {
    return [];
  }

  let leaderDistance = Number.NEGATIVE_INFINITY;
  for (const x of xs) {
    if (x > leaderDistance) {
      leaderDistance = x;
    }
  }

  return xs.map((x) => leaderDistance - x);
}

/**
 * Écart de chaque personnage avec le leader, en secondes : `gap_s_i = gap_m_i / SPEED.BASE`.
 *
 * La référence est la vitesse moyenne nominale, constante pour les 6 personnages : l'écart en
 * secondes reste donc comparable d'une course à l'autre, sans dépendre de la vitesse instantanée.
 */
export function gapSeconds(xs: readonly number[]): readonly number[] {
  return gapMeters(xs).map((gap) => gap / SPEED.BASE);
}

/**
 * Vrai si le leader a changé entre deux relevés de classement.
 *
 * Test **brut** : seul le porteur du rang 1 est comparé. La qualification complète du règlement —
 * maintien du rang 1 pendant `LEADER.DEBOUNCE_S` et avance d'au moins `LEADER.MIN_MARGIN` — exige le
 * temps et les distances ; elle s'applique par-dessus, côté observateur de faits, et ne modifie ni
 * le classement ni la simulation.
 */
export function isLeaderChange(
  previousRanks: readonly number[],
  currentRanks: readonly number[],
): boolean {
  requireSameLength(previousRanks, currentRanks, 'previousRanks', 'currentRanks');
  requireIntegerRanks(previousRanks, 'previousRanks');
  requireIntegerRanks(currentRanks, 'currentRanks');

  const previousLeader = previousRanks.indexOf(1);
  const currentLeader = currentRanks.indexOf(1);
  if (previousLeader === -1 || currentLeader === -1) {
    throw new RangeError('Chaque relevé doit contenir exactement un rang 1.');
  }

  return previousLeader !== currentLeader;
}
