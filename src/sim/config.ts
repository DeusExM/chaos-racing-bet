import type { SimConfig } from './types';

/**
 * Presets de **temps réel**.
 *
 * Le mode test (`?fast=1`) ne touche **jamais** au noyau : il ne change que cette configuration. La
 * course doit produire exactement le même résultat en `normal` et en `fast` pour une même seed —
 * seules la durée réelle et la fluidité perçue changent.
 */

/**
 * Mode normal (`×1`) — valeurs normatives de `GAME_DESIGN.md` §4.1b.
 *
 * `countdownRealS` et `checkpointPauseRealS` sont définis dès maintenant parce que le contrat de
 * `SIM_CONFIG` les prévoit, mais **aucun des deux n'est exécuté en P005** : le compte à rebours et
 * les pauses de checkpoint arrivent avec P006.
 */
export const SIM_CONFIG: SimConfig = Object.freeze({
  countdownRealS: 3.0,
  checkpointPauseRealS: 3.0,
  timeScale: 1,
  maxStepsPerFrame: 5,
  nominalFps: 60,
});

/**
 * Mode test accéléré (`?fast=1`) — valeurs normatives de `GAME_DESIGN.md` §11.
 *
 * `maxStepsPerFrame` vaut `TIME_SCALE × MAX_STEPS_PER_FRAME` du mode normal, soit `20 × 5 = 100`.
 * C'est indispensable : à 60 images par seconde et en `timeScale = 20`, une frame réclame
 * `20 × 60 × DT_S = 20` pas. Un plafond à 5 briderait le mode test à un quart de sa vitesse — sans
 * jamais perdre de temps simulé, mais en rendant le mode test inutilement lent.
 */
export const SIM_FAST_CONFIG: SimConfig = Object.freeze({
  countdownRealS: 0,
  checkpointPauseRealS: 0.2,
  timeScale: 20,
  maxStepsPerFrame: 100,
  nominalFps: 60,
});

/** Nom des presets, utilisés par `?fast=1`. */
export type SimPresetName = 'normal' | 'fast';

/** Presets disponibles, pour que l'application n'ait pas à connaître leurs valeurs. */
export const SIM_PRESETS: Readonly<Record<SimPresetName, SimConfig>> = Object.freeze({
  normal: SIM_CONFIG,
  fast: SIM_FAST_CONFIG,
});
