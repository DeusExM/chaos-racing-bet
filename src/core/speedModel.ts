import type { GameConfig } from './config';
import { approach, clamp } from './math';
import type { CharacterState } from './types';

/**
 * Modèle de vitesse — **P004 : vitesse de base + dérive permanente, et rien d'autre.**
 *
 * Ces trois fonctions sont pures et sans état : elles reçoivent une valeur et un pas, elles
 * retournent la valeur suivante. Le seul état de la course vit dans `RaceEngine`.
 *
 * Les surfaces d'extension sont déjà typées mais **délibérément inutilisées** ici :
 * `CharacterState.surge` et `CharacterState.eventBonus` restent à `0` jusqu'à leurs étapes
 * respectives (P007 pour les surges, P008 pour les événements). Les brancher maintenant
 * introduirait une règle de jeu que personne n'a encore calibrée.
 */

/**
 * Vitesse visée par un personnage à cet instant : `SPEED.BASE × (1 + drift)`.
 *
 * La dérive est **relative** et multiplicative : `drift = +0,1` signifie « 10 % plus vite que la
 * base », ce que `DRIFT.CLAMP = 0,2` borne à ±20 %. Le facteur est symétrique : un personnage lent
 * peut devenir rapide et inversement, aucun n'est structurellement avantagé.
 */
export function computeTargetSpeed(character: CharacterState, config: GameConfig): number {
  return config.SPEED.BASE * (1 + character.drift);
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
