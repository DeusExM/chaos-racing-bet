import type { GameConfig } from './config';
import { approach, clamp } from './math';
import type { CharacterState } from './types';

/**
 * Modèle de vitesse — **base + dérive permanente (P004) + surges (P007) + événements rares (P008)
 * + forme de fin de course (P013-cor6).**
 *
 * Ces trois fonctions sont pures et sans état : elles reçoivent une valeur et un pas, elles
 * retournent la valeur suivante. Le seul état de la course vit dans `RaceEngine`.
 *
 * La forme de fin de course n'apparaît pas ici : c'est un **facteur multiplicatif** appliqué par le
 * moteur autour de `computeTargetSpeed` (voir `lateForm.ts`), ce qui garde ce module indépendant de
 * toute notion de planning.
 */

/**
 * Vitesse visée par un personnage à cet instant : `SPEED.BASE × (1 + drift + surge + eventBonus)`.
 *
 * Les trois modulations sont **relatives** et additives dans la même parenthèse, donc cumulables
 * telles quelles : `+0,1` signifie « 10 % plus vite que la base », qu'il vienne de la dérive, d'un
 * surge ou d'un événement. Chaque source est bornée par ses propres constantes (§6.3, §6.4, §7.1) et
 * leur somme est volontairement **non écrêtée** : chaque source garde son échelle, et l'écrêtage
 * final reste celui de `SPEED.MIN`/`SPEED.MAX`, appliqué après la rampe.
 *
 * Le facteur est symétrique : un personnage lent peut devenir rapide et inversement, aucun n'est
 * structurellement avantagé. Aucune source (surge, événement) ne dépend du rang, de la distance, ni
 * de la position dans le peloton — sinon elle serait un rubber-banding déguisé.
 */
export function computeTargetSpeed(character: CharacterState, config: GameConfig): number {
  return config.SPEED.BASE * (1 + character.drift + character.surge + character.eventBonus);
}

/**
 * Fait évoluer la vitesse d'un pas, **progressivement** : jamais de saut instantané.
 *
 * La rampe est directionnelle (`approach`) — montée bornée par `MAX_ACCEL × DT`, descente bornée par
 * `MAX_DECEL × DT`, les deux limites étant volontairement différentes — puis le résultat est écrêté
 * dans `[SPEED.MIN, SPEED.MAX]`.
 *
 * Une variation progressive est **aussi** ce qui garantit l'invariant d'équivalence visuelle : deux
 * personnages ne peuvent pas s'échanger leurs places en un seul pas de temps.
 */
export function integrateSpeed(
  previousV: number,
  targetV: number,
  config: GameConfig,
  dt: number,
): number {
  const ramped = approach(previousV, targetV, config.SPEED.MAX_ACCEL, config.SPEED.MAX_DECEL, dt);
  return clamp(ramped, config.SPEED.MIN, config.SPEED.MAX);
}

/**
 * Intègre la position : `x_next = x + v × DT`.
 *
 * **C'est la seule écriture autorisée de `x` dans tout le noyau** (invariant §5.4 : pas de
 * téléportation, pas de recentrage, pas de rubber-banding, pas de plafond d'arrivée). La fonction
 * est volontairement isolée et triviale : toute autre affectation de `x` doit être considérée comme
 * un bug critique.
 *
 * La vitesse reçue est celle du pas courant, **après** rampe et écrêtage, conformément à
 * `GAME_DESIGN.md` §6 : `v(t)` d'abord, `x(t) = x(t−1) + v(t) × DT` ensuite.
 */
export function integratePosition(x: number, v: number, dt: number): number {
  return x + v * dt;
}
