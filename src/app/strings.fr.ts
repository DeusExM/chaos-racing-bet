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
});
