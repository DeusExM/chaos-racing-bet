import { RACE_CONFIG } from '../../core/config';
import { segmentElapsedS, segmentIndexAt } from '../../core/track';
import type { RacePhase, RaceState } from '../../core/types';
import type { ReplayFrame } from '../../sim/ReplayHistory';

/**
 * Modèle **pur** du curseur de relecture (passe corrective 2).
 *
 * ## Le principe
 *
 * Pendant une pause manuelle, le MJ peut revoir ce qui vient de se passer : le curseur désigne un
 * **instant déjà joué**, et le rendu dessine cet instant au lieu de l'instant réel. Rien de tout cela
 * ne remonte vers le noyau : ce module ne fait que calculer des bornes et un libellé, et il est testé
 * sans navigateur.
 *
 * ## Les deux bornes
 *
 * * basse : `0` — le départ, premier instant enregistré ;
 * * haute : le **pas réel de la pause**, et rien au-delà. On ne peut donc jamais « avancer » dans une
 *   course qui n'a pas encore été jouée : ce serait afficher un futur qui n'existe pas.
 *
 * Le déplacement se fait par pas de `2 s` (`REPLAY_STEP_STEPS`), et la barre accepte en plus une
 * granularité d'un pas de simulation (`1/60 s`), parce qu'un curseur natif le permet sans rien
 * ajouter.
 */

/** Pas d'un déplacement par bouton : 2 secondes simulées. */
export const REPLAY_STEP_S = 2;

/** Même déplacement, exprimé en pas de simulation — la seule unité du noyau. */
export const REPLAY_STEP_STEPS = Math.round(REPLAY_STEP_S / RACE_CONFIG.DT_S);

/** Curseur de relecture : instant consulté et instant réel de la pause, en pas. */
export interface ReplayCursor {
  /** Pas consulté, toujours dans `[0, pauseStep]`. */
  readonly step: number;
  /** Pas réel de la pause : borne haute **inclusive**, et instant de reprise. */
  readonly pauseStep: number;
}

/** Curseur neuf, posé sur l'instant de pause : la relecture commence par le présent. */
export function cursorAtPause(pauseStep: number): ReplayCursor {
  return { step: pauseStep, pauseStep };
}

/**
 * Déplace le curseur de `deltaSteps`, en le **bornant** à `[0, pauseStep]`.
 *
 * La borne est appliquée ici, dans une fonction pure unique : les boutons, la barre et un éventuel
 * appel direct passent tous par elle, donc aucun chemin ne peut produire un instant hors de la course
 * déjà jouée.
 */
export function moveCursor(cursor: ReplayCursor, deltaSteps: number): ReplayCursor {
  return { step: clampStep(cursor.step + deltaSteps, cursor.pauseStep), pauseStep: cursor.pauseStep };
}

/** Curseur posé sur un pas donné, borné de la même façon. */
export function seekCursor(cursor: ReplayCursor, step: number): ReplayCursor {
  return { step: clampStep(step, cursor.pauseStep), pauseStep: cursor.pauseStep };
}

/** Borne unique du curseur : `[0, pauseStep]`, en pas entiers. */
function clampStep(step: number, pauseStep: number): number {
  return Math.min(pauseStep, Math.max(0, Math.round(step)));
}

/**
 * Phase du noyau à un instant passé, reconstruite depuis le **seul** `tSim`.
 *
 * La découpe des segments appartient à `core/track.ts` : le rendu ne recopie aucune frontière, et
 * l'instant consulté ne peut donc pas afficher un segment différent de celui que le noyau avait.
 */
/** Phase du noyau à un instant passé : toujours **en course** (l'historique ne contient que ça). */
export type ReplayPhase = Extract<RacePhase, { kind: 'running' }>;

export function replayPhaseAt(tSim: number): ReplayPhase {
  return {
    kind: 'running',
    segment: (segmentIndexAt(tSim) + 1) as 1 | 2 | 3,
    segmentElapsedS: segmentElapsedS(tSim),
  };
}

/**
 * État de course **affiché** pour un instant consulté.
 *
 * Les distances et les événements viennent de l'historique — donc du noyau, tels qu'ils ont été
 * calculés. Le `tSim`, le nombre de pas et la phase se déduisent du pas consulté, par les mêmes
 * fonctions du noyau que la course réelle. Les autres champs (vitesse, dérive, seed) sont recopiés
 * de l'état vivant : le HUD ne les affiche pas, et le panneau de debug continue de décrire le noyau
 * gelé — c'est lui qui dit la vérité sur la simulation, la piste montrant l'instant consulté.
 *
 * Rien n'est **inventé** : aucune distance n'est interpolée, aucun rang n'est recalculé ailleurs que
 * par `leaderboardOf` sur ces distances-là.
 */
export function replayStateOf(state: Readonly<RaceState>, frame: ReplayFrame): RaceState {
  return {
    ...state,
    tSim: frame.tSim,
    steps: frame.steps,
    phase: replayPhaseAt(frame.tSim),
    characters: state.characters.map((character, index) => ({
      ...character,
      x: frame.distances[index] ?? character.x,
      activeEvent: frame.events[index] ?? null,
    })),
  };
}
