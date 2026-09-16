/**
 * Vocabulaire **temps réel** de la course.
 *
 * Tout ce qui vit ici appartient à `src/sim/` et n'atteint **jamais** le noyau : `RaceEngine` ne
 * connaît ni le compte à rebours, ni la durée réelle d'une pause, ni le `timeScale`. C'est cette
 * séparation qui garantit qu'un ralentissement du navigateur, un onglet en arrière-plan ou une
 * pause ne peuvent pas modifier le résultat d'une course.
 */

/**
 * Phase **temps réel** de la course, vue par la boucle d'affichage.
 *
 * `RaceSimulation` est l'**unique** propriétaire de ces phases : le noyau n'en connaît que trois
 * (`idle`, `running`, `finished`), et n'importe jamais ce type. Une pause n'existe donc que d'un côté
 * de la frontière — c'est précisément ce qui garantit qu'elle ne peut pas modifier la course.
 *
 * Ordre d'une course normale, sans intervention du MJ :
 * `idle` → `countdown` → `running` → `checkpointPause` → `running` → … → `finished`.
 * `userPaused` s'intercale où l'on veut, sans consommer ni annuler la phase qu'il suspend.
 */
export type SimPhase =
  | 'idle'
  | 'countdown'
  | 'running'
  | 'checkpointPause'
  | 'userPaused'
  | 'finished';

/**
 * Configuration du **temps réel**. Les valeurs normatives sont dans `GAME_DESIGN.md` §4.1b et §11.
 *
 * Aucune de ces valeurs ne modifie une règle du noyau : elles ne changent que le **nombre** de pas
 * exécutés par frame, jamais leur taille.
 */
export interface SimConfig {
  /** Durée réelle du compte à rebours, en secondes. `0` en mode test : départ immédiat. */
  readonly countdownRealS: number;
  /** Durée réelle d'une pause de checkpoint, en secondes. */
  readonly checkpointPauseRealS: number;
  /** Nombre de secondes simulées par seconde réelle. */
  readonly timeScale: number;
  /** Garde-fou anti « spiral of death » : nombre maximal de `step()` par `update()`. */
  readonly maxStepsPerFrame: number;
  /**
   * Fréquence d'affichage **nominale**, en images par seconde.
   *
   * Constante d'implémentation, pas une règle de jeu : elle sert uniquement à vérifier que
   * `maxStepsPerFrame` est assez grand pour que le `timeScale` choisi ne soit pas artificiellement
   * bridé à la fréquence d'affichage de référence.
   */
  readonly nominalFps: number;
}
