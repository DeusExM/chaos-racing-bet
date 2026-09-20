import type { GameConfig } from './config';
import type { RngStream } from './rng';
import type { CharacterId } from './types';

/**
 * Forme de fin de course (P014) : un écart relatif **persistant**, propre à chaque personnage, qui ne
 * s'applique que sur le dernier tiers de la course.
 *
 * ## Ce que ce module fait, et rien d'autre
 *
 * Il répond à deux questions, et à elles seules :
 *
 * 1. **quelle forme pour ce personnage ?** — un tirage uniforme unique dans
 *    `[−AMPLITUDE ; +AMPLITUDE]`, sur le flux nommé `lateform:<charId>` ;
 * 2. **quelle part de cette forme s'applique à ce pas ?** — une rampe nulle jusqu'à `FROM_S`,
 *    linéaire jusqu'à `FULL_S`, complète ensuite.
 *
 * Il ne connaît ni `RaceEngine`, ni `RaceState`, ni `CharacterState`, ne calcule aucune distance et
 * n'écrit jamais dans `x` : la forme ne peut donc agir que comme un **multiplicateur de la vitesse
 * cible**, qui passe ensuite par la rampe d'accélération/décélération puis par l'écrêtage. C'est ce
 * qui interdit structurellement une téléportation déguisée.
 *
 * ## Aucun biais, aucune lecture du classement
 *
 * Le tirage ne dépend que de `(seed, charId)` : ni le rang, ni `x`, ni l'écart, ni la position du
 * personnage dans la liste des partants n'entrent dans la décision. Deux courses de mêmes seeds avec
 * des effectifs différents donnent donc **la même forme au même personnage**, et un personnage garde
 * sa forme si l'ordre des partants change. Le flux est **dédié** : consommer dedans ne décale ni
 * `drift:*`, ni `surge:*`, ni `events:*`, ni `speaker:lines`.
 *
 * La loi est symétrique et d'espérance nulle : sur un grand nombre de courses, la vitesse moyenne de
 * chaque personnage reste `SPEED.BASE`, et aucun n'est structurellement avantagé. Sur une course
 * donnée, en revanche, la vitesse moyenne du dernier tiers vaut `SPEED.BASE × (1 + forme/3)` : c'est
 * l'entorse **assumée** à l'équivalence stricte, documentée dans `GAME_DESIGN.md` §6.5.
 *
 * ## Aucune fonction transcendante
 *
 * Une soustraction, une multiplication et une division, dont l'arrondi est exactement spécifié par
 * ECMAScript : la course reste reproductible au bit près d'un moteur JavaScript à l'autre.
 */

/** Préfixe du flux **dédié** de la forme de fin de course. */
export const LATE_FORM_STREAM_PREFIX = 'lateform:';

/** Nom du flux d'un personnage : `lateform:<charId>`. */
export function lateFormStreamLabel(id: CharacterId): string {
  return `${LATE_FORM_STREAM_PREFIX}${id}`;
}

/**
 * Paramètres pré-calculés, une fois par course.
 *
 * Même principe que `SurgeParams` : les conversions secondes → pas sont faites à un seul endroit, et
 * rien n'est recalculé dans la boucle de simulation.
 */
export interface LateFormParams {
  /** Demi-amplitude du tirage, en valeur relative. */
  readonly amplitude: number;
  /** Pas où l'effet commence (0 % à ce pas **inclus**). */
  readonly fromStep: number;
  /** Pas où l'effet est complet (100 %). */
  readonly fullAtStep: number;
}

/**
 * Convertit une durée en secondes en un nombre **entier** de pas.
 *
 * Le noyau avance par pas fixes : une borne exprimée en secondes doit tomber sur un pas entier, sinon
 * le planning dépendrait d'une accumulation flottante. `TOTAL_STEPS × DT_S` valant exactement
 * `TOTAL_SIM_S`, la conversion est exacte pour les bornes du jeu.
 */
function stepsForSeconds(seconds: number, config: GameConfig): number {
  return Math.round(seconds / config.RACE.DT_S);
}

/** Paramètres de la forme de fin de course, dérivés des constantes de jeu. */
export function lateFormParams(config: GameConfig): LateFormParams {
  return Object.freeze({
    amplitude: config.LATE_FORM.AMPLITUDE,
    fromStep: stepsForSeconds(config.LATE_FORM.FROM_S, config),
    fullAtStep: stepsForSeconds(config.LATE_FORM.FULL_S, config),
  });
}

/**
 * Tire la forme d'un personnage : uniforme sur `[−amplitude ; +amplitude]`, **un seul** tirage.
 *
 * `nextFloat()` est uniforme sur `[0 ; 1)` : `nextFloat() × 2 − 1` est donc uniforme sur `[−1 ; 1)`,
 * centré, et la multiplication par l'amplitude ne change ni la symétrie ni l'espérance nulle.
 */
export function drawLateForm(stream: RngStream, params: LateFormParams): number {
  return (stream.nextFloat() * 2 - 1) * params.amplitude;
}

/**
 * Part de la forme appliquée à un pas : `0` jusqu'à `fromStep` inclus, `1` à partir de `fullAtStep`.
 *
 * Renvoie `1` — et non la forme — quand la forme est nulle : l'appelant peut ainsi court-circuiter la
 * multiplication et laisser le pas strictement identique à celui d'une course sans forme.
 */
export function lateFormProgress(stepNumber: number, params: LateFormParams): number {
  if (stepNumber <= params.fromStep) {
    return 0;
  }
  const span = params.fullAtStep - params.fromStep;
  if (span <= 0) {
    return 1;
  }
  return Math.min(1, (stepNumber - params.fromStep) / span);
}

/**
 * Facteur multiplicatif de la vitesse **cible** pour un personnage à un pas donné.
 *
 * `1` signifie « aucune influence » : la vitesse visée reste celle du modèle de vitesse. Le facteur
 * vaut exactement `1` tant que la forme est nulle ou que le pas n'a pas atteint la borne, puis croît
 * linéairement jusqu'à `1 + forme` et s'y maintient jusqu'à l'arrivée.
 */
export function lateFormFactor(form: number, stepNumber: number, params: LateFormParams): number {
  if (form === 0) {
    return 1;
  }
  const progress = lateFormProgress(stepNumber, params);
  return progress === 0 ? 1 : 1 + form * progress;
}
