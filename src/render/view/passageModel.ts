import { CHARACTERS } from '../../core/characters';
import type { CharacterId, RaceState } from '../../core/types';
import { leaderboardOf } from '../../sim/leaderboard';

/**
 * Historique des **passages en tête** (passe de finition 2D).
 *
 * ## Ce que ce module enregistre, et ce qu'il n'invente pas
 *
 * À chaque borne de la course — les deux checkpoints intermédiaires, puis l'arrivée — l'écran
 * d'arrivée affiche qui était en tête. Ce module ne fait qu'une chose : **noter le premier du
 * classement au moment où le noyau annonce la borne**. Le classement vient de `sim/leaderboard.ts`,
 * qui s'appuie lui-même sur `core/ranking.ts` : il n'existe donc **aucun second moteur de
 * classement**, et rien n'est déduit d'une position de sprite ni d'une distance recalculée.
 *
 * Une borne non observée n'est **pas** complétée : si la course n'a pas atteint un checkpoint, sa
 * ligne n'existe pas. Mieux vaut une ligne manquante qu'un leader supposé.
 *
 * ## Pourquoi un enregistreur, et pas un recalcul
 *
 * Le noyau ne conserve pas le classement des instants passés : il ne garde que l'état courant. Le
 * mécanisme minimal est donc une **lecture** au bon moment, faite par le rendu, qui ne peut rien
 * écrire dans la simulation. C'est du stockage d'affichage, pas une règle de course.
 */

/** Une borne franchie, avec le leader **réellement observé** à cet instant. */
export interface PassageLeader {
  /** Numéro du checkpoint (`1`, `2`) au moment du passage. */
  readonly checkpoint: number;
  /** Instant simulé du passage, tel que le noyau l'a mesuré (`20`, `40`). */
  readonly tSim: number;
  readonly characterId: CharacterId;
  /** Nom affichable du leader, lu dans le roster : la présentation ne traduit rien. */
  readonly name: string;
}

/** Nom affichable d'un personnage, ou son identifiant si le roster ne le connaît pas. */
function nameOf(id: CharacterId): string {
  return CHARACTERS.find((character) => character.id === id)?.name ?? id;
}

/**
 * Enregistreur des passages en tête.
 *
 * Il ne lit que `state.tSim`, `state.seed`, `state.steps` et le numéro de checkpoint annoncé par
 * `RaceSimulation`, et n'écrit que dans sa propre liste. Aucune méthode ne prend un `x`, un `v` ou un
 * générateur aléatoire : il est donc impossible que cet historique change une course.
 */
export class PassageRecorder {
  private leaders: PassageLeader[] = [];

  /** Seed de la course dont les passages sont conservés : elle sert à détecter une nouvelle course. */
  private seed = '';

  /** Nombre de pas de la course en cours, pour reconnaître un redémarrage à seed identique. */
  private steps = -1;

  /**
   * Observe l'état d'une frame.
   *
   * `checkpoint` est le numéro annoncé par la simulation pendant la pause d'un checkpoint, ou `null`.
   * Un redémarrage — nouvelle seed, ou même seed relancée depuis le pas zéro — remet l'historique à
   * zéro : aucune ligne d'une course précédente ne peut donc survivre à l'écran d'arrivée suivant.
   */
  observe(state: Readonly<RaceState>, checkpoint: number | null): void {
    if (state.seed !== this.seed || state.steps < this.steps || state.steps === 0) {
      this.leaders = [];
      this.seed = state.seed;
    }
    this.steps = state.steps;

    if (checkpoint === null || !Number.isInteger(checkpoint) || checkpoint < 1) {
      return;
    }
    if (this.leaders.some((leader) => leader.checkpoint === checkpoint)) {
      return;
    }

    // Source unique du classement : la même que le HUD, le podium et la photo finish.
    const first = leaderboardOf(state)[0];
    if (first === undefined) {
      return;
    }

    this.leaders.push(
      Object.freeze({
        checkpoint,
        tSim: state.tSim,
        characterId: first.id,
        name: nameOf(first.id),
      }),
    );
  }

  /** Passages enregistrés, dans l'ordre des bornes. Copie gelée : l'appelant ne peut pas la modifier. */
  rows(): readonly PassageLeader[] {
    return Object.freeze([...this.leaders]);
  }

  /** Vide l'historique : appelé quand une nouvelle course démarre. */
  reset(): void {
    this.leaders = [];
    this.steps = -1;
    this.seed = '';
  }
}
