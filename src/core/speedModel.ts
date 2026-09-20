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
 * Enveloppe temporelle d'une **forme de fin de course**, en numéros de pas.
 *
 * Elle décrit la part de l'effet appliquée à chaque pas : `0` jusqu'à `fromStep` inclus, montée
 * linéaire jusqu'à `fullAtStep`, plateau à `1` jusqu'à `fallFromStep`, puis descente linéaire
 * jusqu'à `endStep` où l'effet revient **exactement** à `0`.
 *
 * `fallFromStep` et `endStep` sont absents quand l'effet doit rester complet jusqu'à l'arrivée : la
 * forme précédente du levier reste donc exprimable sans cas particulier dans le noyau.
 */
export interface LateFormEnvelope {
  readonly fromStep: number;
  readonly fullAtStep: number;
  readonly fallFromStep?: number;
  readonly endStep?: number;
}

/**
 * Facteur multiplicatif d'une **forme de fin de course** à un pas donné (mesure uniquement).
 *
 * `form` est un écart relatif constant propre à un personnage (`+0,16` = « 16 % plus vite que sa
 * propre cible »), pondéré par l'enveloppe : `+0 %` à 40 s, `+8 %` à 45 s, `+16 %` à 50 s, `+16 %` à
 * 55 s, `+8 %` à 57,5 s, `+0 %` à 60 s pour une enveloppe `40 → 50 → 55 → 60`.
 *
 * Le facteur ne reçoit que le numéro du pas et la forme du personnage : il ne peut donc lire ni le
 * rang, ni la distance, ni l'écart, et il n'est pas un rubber-band (formes de moyenne nulle, tirées
 * indépendamment, aucune règle ne réagit à la position). Il multiplie la **vitesse cible** et non la
 * position : l'effet passe donc toujours par la rampe d'accélération et de décélération de
 * `integrateSpeed`, et par l'écrêtage `SPEED.MIN`/`SPEED.MAX`.
 *
 * Aucune fonction transcendante : soustractions, divisions, multiplications et `Math.min`/`Math.max`,
 * dont l'arrondi est exactement spécifié par ECMAScript.
 */
export function lateFormFactor(form: number, stepNumber: number, envelope: LateFormEnvelope): number {
  if (form === 0 || stepNumber <= envelope.fromStep) {
    return 1;
  }

  const riseSpan = envelope.fullAtStep - envelope.fromStep;
  let progress = riseSpan <= 0 ? 1 : Math.min(1, (stepNumber - envelope.fromStep) / riseSpan);

  const fallFromStep = envelope.fallFromStep;
  const endStep = envelope.endStep;
  if (fallFromStep !== undefined && endStep !== undefined && stepNumber > fallFromStep) {
    const fallSpan = endStep - fallFromStep;
    const remaining = fallSpan <= 0 ? 0 : (endStep - stepNumber) / fallSpan;
    progress = Math.min(progress, Math.max(0, remaining));
  }

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
