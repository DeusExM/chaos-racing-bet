import type { CharacterId, RaceState } from '../../core/types';
import type { LeaderboardRow } from '../../sim/leaderboard';
import type { SimPhase } from '../../sim/types';

/**
 * Modèle du panneau de debug (`?debug=1`).
 *
 * Il est construit par une fonction **pure**, testable sans navigateur : le panneau n'a donc aucun
 * accès au moteur ni à un état mutable. Il ne peut pas faire avancer la course, consommer un tirage
 * aléatoire, injecter une valeur ni modifier une constante — `?debug=1` produit exactement la même
 * course que sans le paramètre, bit à bit, et un test E2E le vérifie.
 */

/** Ligne de debug d'un personnage : uniquement des valeurs publiées par le noyau. */
export interface DebugCharacterRow {
  readonly id: CharacterId;
  readonly name: string;
  /** Rang dans le classement du noyau, `1` pour le leader. */
  readonly rank: number;
  readonly x: number;
  readonly v: number;
  readonly drift: number;
  readonly surge: number;
  /** Identifiant de l'événement rare actif, ou `null`. */
  readonly event: string | null;
  /** Magnitude de l'événement actif : `eventBonus` du noyau, `0` sans événement. */
  readonly eventBonus: number;
  /** Écart au leader, en mètres : lu dans le même classement que le HUD. */
  readonly gapMeters: number;
}

/** Tout ce que le panneau affiche à une frame donnée, déjà calculé. */
export interface DebugModel {
  readonly seed: string;
  readonly tSim: number;
  readonly steps: number;
  /** Numéro de segment courant (1 à 4), `0` tant que la course n'est pas en cours. */
  readonly segment: number;
  readonly phase: SimPhase;
  readonly timeScale: number;
  readonly rows: readonly DebugCharacterRow[];
}

/**
 * Construit le modèle de debug à partir de l'état du noyau et du classement déjà calculé.
 *
 * Les rangs et les écarts viennent des lignes fournies — celles du HUD, produites par
 * `sim/leaderboard.ts` — et jamais d'un second classement.
 */
export function buildDebugModel(
  state: Readonly<RaceState>,
  phase: SimPhase,
  timeScale: number,
  rows: readonly LeaderboardRow[],
): DebugModel {
  const byId = new Map<CharacterId, LeaderboardRow>();
  for (const row of rows) {
    byId.set(row.id, row);
  }

  return {
    seed: state.seed,
    tSim: state.tSim,
    steps: state.steps,
    segment: state.phase.kind === 'running' ? state.phase.segment : 0,
    phase,
    timeScale,
    rows: state.characters.map((character) => {
      const row = byId.get(character.id);
      return {
        id: character.id,
        name: row?.name ?? character.id,
        rank: row?.rank ?? 0,
        gapMeters: row?.gapMeters ?? 0,
        x: character.x,
        v: character.v,
        drift: character.drift,
        surge: character.surge,
        event: character.activeEvent?.id ?? null,
        eventBonus: character.eventBonus,
      };
    }),
  };
}
