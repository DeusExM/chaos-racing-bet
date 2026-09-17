import type { RaceResult, RaceState } from '../core/types';
import { leaderboardOf } from './leaderboard';
import type { LeaderboardRow } from './leaderboard';
import type { RaceSimulation } from './RaceSimulation';
import type { SimPhase } from './types';

/**
 * Hooks de test et de debug : `window.__CHAOS_RACE__`.
 *
 * Ils n'existent qu'en développement ou avec `?e2e=1`, et ils n'offrent **aucun** accès en écriture
 * à la simulation : toutes leurs fonctions passent par `RaceSimulation`, qui elle-même ne passe que
 * par `RaceEngine.step()`. Aucun hook ne peut donc « tricher » en modifiant une distance, une
 * vitesse ou un classement — ce qui rendrait les tests E2E complaisants.
 */

/** Surface exposée à Playwright et à la console de développement. */
export interface ChaosRaceTestApi {
  /** Démarre la course : compte à rebours réel, puis course. */
  start(): void;
  /** Repart de zéro avec la seed en cours. */
  restart(): void;
  /** Suspend ou reprend la course, exactement comme le bouton ou la touche Espace. */
  toggleUserPause(): void;
  /** État complet du noyau (instantané figé). */
  state(): Readonly<RaceState>;
  /** Classement, du 1er au dernier, calculé par `core/ranking.ts`. */
  ranks(): readonly LeaderboardRow[];
  /** Distances de chaque personnage, dans l'ordre du roster. */
  distances(): readonly number[];
  /** Joue la course entière sans rendu et renvoie le résultat final. */
  runToCompletion(seed?: string): RaceResult;
  /** Secondes simulées par seconde réelle. */
  timeScale(): number;
  /** Seed affichée de la course en cours. */
  seed(): string;
  /** Phase temps réel de la simulation. */
  phase(): SimPhase;
  /** Numéro du segment courant (1 à 3), `0` tant que la course n'est pas en cours. */
  segment(): number;
  /** Numéro du checkpoint en pause (`1` à `2`), sinon `null`. */
  checkpoint(): number | null;
}

declare global {
  interface Window {
    __CHAOS_RACE__?: ChaosRaceTestApi;
  }
}

/**
 * Faut-il exposer les hooks ?
 *
 * En développement, toujours : c'est ce qui permet d'inspecter une course depuis la console. En
 * build de production, uniquement sur demande explicite via `?e2e=1` — les tests Playwright
 * tournent contre le build réel, donc sans ce paramètre ils n'auraient aucun accès.
 */
export function testHooksEnabled(search: string, isDev: boolean): boolean {
  if (isDev) {
    return true;
  }
  return new URLSearchParams(search).get('e2e') === '1';
}

/** Construit l'API sans l'installer : utile pour les tests unitaires. */
export function createTestApi(simulation: RaceSimulation): ChaosRaceTestApi {
  return Object.freeze({
    start: () => simulation.start(),
    restart: () => simulation.restart(),
    toggleUserPause: () => simulation.toggleUserPause(),
    state: () => simulation.view,
    ranks: () => leaderboardOf(simulation.view),
    distances: () => simulation.view.characters.map((character) => character.x),
    runToCompletion: (seed?: string) => simulation.runToCompletion(seed),
    timeScale: () => simulation.timeScale,
    seed: () => simulation.seed,
    phase: () => simulation.phase,
    segment: () => {
      const phase = simulation.view.phase;
      return phase.kind === 'running' ? phase.segment : 0;
    },
    checkpoint: () => simulation.checkpoint,
  });
}

/** Installe les hooks sur `window` si `enabled` est vrai. Renvoie l'état réellement appliqué. */
export function installTestHooks(simulation: RaceSimulation, enabled: boolean): boolean {
  if (!enabled) {
    delete window.__CHAOS_RACE__;
    return false;
  }
  window.__CHAOS_RACE__ = createTestApi(simulation);
  return true;
}
