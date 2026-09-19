import type { GameConfig } from './config';
import { approach, clamp } from './math';
import type { CharacterState } from './types';

/**
 * Modèle de vitesse — **base + dérive permanente (P004) + surges (P007) + événements rares (P008).**
 *
 * Ces trois fonctions sont pures et sans état : elles reçoivent une valeur et un pas, elles
 * retournent la valeur suivante. Le seul état de la course vit dans `RaceEngine`.
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
 * Facteur multiplicatif d'une **forme de fin de course**, monté progressivement (mesure uniquement).
 *
 * `form` est un écart relatif constant propre à un personnage (`+0,08` = « 8 % plus vite que sa
 * propre cible »). Le facteur vaut exactement `1` jusqu'à `fromStep` **inclus** — le pas qui atteint
 * la borne ne subit donc rien — puis croît linéairement jusqu'à `1 + form` à `fullAtStep`, et reste
 * à cette valeur ensuite. Exemple : `form = +0,08`, `fromStep` = 40 s, `fullAtStep` = 42 s donnent
 * `+0 %` à 40 s, `+4 %` à 41 s, `+8 %` à 42 s et au-delà.
 *
 * Le facteur ne reçoit que le numéro du pas et la forme du personnage : il ne peut donc lire ni le
 * rang, ni la distance, ni l'écart, et il n'est pas un rubber-band (toutes les formes sont de moyenne
 * nulle et tirées indépendamment, aucune règle ne réagit à la position). Il multiplie la **vitesse
 * cible** et non la position : l'effet passe donc toujours par la rampe d'accélération et de
 * décélération de `integrateSpeed`, et par l'écrêtage `SPEED.MIN`/`SPEED.MAX`.
 *
 * Aucune fonction transcendante : une soustraction, une division et une multiplication, dont
 * l'arrondi est exactement spécifié par ECMAScript.
 */
export function lateFormFactor(
  form: number,
  stepNumber: number,
  fromStep: number,
  fullAtStep: number,
): number {
  if (form === 0 || stepNumber <= fromStep) {
    return 1;
  }
  if (fullAtStep <= fromStep) {
    return 1 + form;
  }
  const progress = Math.min(1, (stepNumber - fromStep) / (fullAtStep - fromStep));
  return 1 + form * progress;
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
