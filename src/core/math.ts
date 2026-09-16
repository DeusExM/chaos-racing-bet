import type { RngStream } from './rng';

/**
 * Fonctions mathématiques pures du noyau.
 *
 * Aucune d'elles n'appelle de fonction transcendante (`Math.sqrt`, `Math.log`, `Math.cos`, `Math.pow`,
 * …) : la norme ECMAScript ne garantit pas leur arrondi, donc leur bit de poids faible peut différer
 * d'un moteur JavaScript à l'autre — ce qui casserait la reproductibilité inter-moteurs. Les
 * constantes qui en dépendent sont pré-calculées et figées dans `config.ts`.
 *
 * Aucune d'elles ne lit d'horloge, ne consomme d'aléatoire ambiant et ne conserve d'état : le hasard
 * arrive par paramètre, sous forme d'un tirage déjà effectué.
 */

/**
 * Borne `value` dans l'intervalle `[min, max]`.
 *
 * @throws RangeError si les bornes sont inversées : c'est une erreur de programmation,
 *         pas une donnée d'entrée valide, et elle doit être visible immédiatement.
 */
export function clamp(value: number, min: number, max: number): number {
  if (min > max) {
    throw new RangeError(`clamp : bornes inversées (min=${min}, max=${max}).`);
  }
  return Math.min(Math.max(value, min), max);
}

/**
 * Interpolation linéaire : `a` à `t = 0`, `b` à `t = 1`.
 *
 * `t` n'est **pas** borné à `[0, 1]` : l'extrapolation est volontairement permise, c'est à
 * l'appelant de borner s'il le souhaite (par exemple pour une interpolation d'affichage).
 */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Bruit gaussien centré réduit, tiré du **seul** générateur déterministe du noyau.
 *
 * Cette fonction n'implémente aucun second algorithme : elle délègue à `RngStream.nextGaussian()`,
 * dont l'approximation — somme de 12 tirages uniformes, sans aucune fonction transcendante — et le
 * centrage exact sont verrouillés par les tests de P002. Dupliquer ici un générateur (Box-Muller ou
 * autre) ferait diverger le bruit d'un moteur à l'autre et casserait la reproductibilité.
 */
export function gaussianFrom(rng: RngStream): number {
  return rng.nextGaussian();
}

/**
 * Paramètres d'une étape d'Ornstein–Uhlenbeck, tous pré-calculés hors de la boucle de simulation.
 *
 * `sqrtDt` vaut `√DT`, fourni **déjà calculé** : le noyau n'a pas le droit d'appeler `Math.sqrt`.
 * Voir `SQRT_DT` dans `config.ts`.
 */
export interface OrnsteinUhlenbeckParams {
  /** Pas de temps, en secondes. */
  readonly dt: number;
  /** Rappel vers zéro, par seconde. */
  readonly theta: number;
  /** Amplitude du bruit, par racine de seconde. */
  readonly sigma: number;
  /** `√dt`, pré-calculé. */
  readonly sqrtDt: number;
  /** Écrêtage symétrique appliqué après l'étape. */
  readonly clampValue: number;
}

/**
 * Une étape du processus d'Ornstein–Uhlenbeck qui produit la dérive :
 *
 * ```
 * drift_next = drift + (−THETA × drift × DT) + SIGMA × √DT × bruit
 * drift_next = clamp(drift_next, −CLAMP, +CLAMP)
 * ```
 *
 * Le rappel vers zéro (`−THETA × drift × DT`) est ce qui garantit que la vitesse **moyenne** de
 * chaque personnage reste `SPEED.BASE` : les personnages restent équivalents, aucun ne dérive
 * durablement. Le terme de bruit, lui, crée la variance locale qui provoque les rapprochements et les
 * dépassements naturels. Les six `drift` sont indépendants : aucun couplage entre personnages.
 */
export function stepOrnsteinUhlenbeck(
  drift: number,
  gaussian: number,
  params: OrnsteinUhlenbeckParams,
): number {
  const next = drift - params.theta * drift * params.dt + params.sigma * params.sqrtDt * gaussian;
  return clamp(next, -params.clampValue, params.clampValue);
}

/**
 * Approche progressive d'une vitesse cible, avec **deux limites distinctes selon la direction** :
 *
 * ```
 * si target >= current :  min(target, current + upRate × dt)
 * sinon                :  max(target, current − downRate × dt)
 * ```
 *
 * La formulation symétrique `|Δv| ≤ upRate × dt` appliquée aux deux directions est **interdite** :
 * elle sous-estimerait la descente autorisée (`MAX_DECEL = 12 m/s²` contre `MAX_ACCEL = 10 m/s²`) et
 * rendrait les ralentissements et les fins de bonus artificiellement mous. Un test de non-régression
 * de `tests/unit/speedModel.test.ts` échoue si quelqu'un réintroduit cette erreur.
 */
export function approach(
  current: number,
  target: number,
  upRate: number,
  downRate: number,
  dt: number,
): number {
  if (target >= current) {
    return Math.min(target, current + upRate * dt);
  }
  return Math.max(target, current - downRate * dt);
}
