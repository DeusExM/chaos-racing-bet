import type { CharacterState } from '../../core/types';

/**
 * Modèle **pur** de l'état visuel d'un personnage pendant un événement (passe de finition 2D).
 *
 * ## Pourquoi ce module existe
 *
 * Les mots `TURBO !`, `BONUS !`, `MALUS !` disent ce qui se passe, mais l'état lui-même ne se voyait
 * pas **sur le personnage** : une remontée ou un décrochage pouvait encore paraître arbitraire. Ce
 * modèle décrit donc, pour une frame déjà lue, ce que le sprite doit montrer : un halo chaud et une
 * traînée claire pour un bonus, une teinte sombre et une traînée sourde pour un malus.
 *
 * ## Lecture seule, et rien d'autre
 *
 * Tout est déduit de `activeEvent` et de sa **magnitude réelle**, signée : le sens de l'effet n'est
 * jamais une table écrite à la main, et un événement de magnitude nulle ne produit aucun effet plutôt
 * que d'affirmer quelque chose que le noyau n'a pas dit. Aucun tirage aléatoire, aucune horloge de
 * simulation, aucune écriture : `x`, `v` et le classement ne sont même pas lisibles ici — ce module
 * ne reçoit qu'un personnage et un temps **réel** écoulé, et ne renvoie que des nombres d'affichage.
 *
 * ## Ce qu'il ne décide pas
 *
 * Le ralentissement ou l'accélération réels viennent du moteur, et de lui seul. L'effet ne fait que
 * les **expliquer** : il ne déplace jamais le personnage, ne change jamais sa vitesse, et n'ajoute
 * aucune durée à l'événement.
 */

/** Nature visuelle d'un événement, déduite du signe de sa magnitude. */
export type EventVisualKind = 'none' | 'bonus' | 'malus';

/** Tout ce que le sprite doit appliquer pour une frame. */
export interface EventVisual {
  readonly kind: EventVisualKind;
  /** Intensité de `0` à `1`, déduite de la magnitude réelle de l'événement. */
  readonly intensity: number;
  /** Teinte du sprite (`0xffffff` = aucune) : le bonus ne dénature pas l'illustration, le malus l'assombrit. */
  readonly tint: number;
  /** Teinte du halo et de la traînée. */
  readonly auraTint: number;
  /** Opacité du halo, `0` quand il n'y a rien à montrer. */
  readonly auraAlpha: number;
  /** Échelle du halo par rapport au sprite : un halo se voit **autour** de la silhouette. */
  readonly auraScale: number;
  /** Opacité de la traînée, `0` quand il n'y a rien à montrer. */
  readonly trailAlpha: number;
  /** Recul de la traînée, en fraction de la largeur du sprite (vers l'arrière de la course). */
  readonly trailOffsetRatio: number;
}

/**
 * Magnitude à laquelle l'effet est à pleine intensité.
 *
 * Le catalogue va de `−0,75` (`CHUTE`) à `+1,63` (`MEGA_TURBO`) : `1,2` place donc la plupart des
 * événements entre 40 % et 100 % d'intensité, sans jamais saturer un `POULET` (`0,2` – `0,35`).
 */
const FULL_INTENSITY_MAGNITUDE = 1.2;

/** Période de la pulsation, en millisecondes **réelles** : lente, pour ne pas scintiller. */
const PULSE_PERIOD_MS = 420;

/** Aucun événement : rien n'est dessiné, et le sprite garde ses couleurs d'origine. */
export const NO_EVENT_VISUAL: EventVisual = Object.freeze({
  kind: 'none',
  intensity: 0,
  tint: 0xffffff,
  auraTint: 0xffffff,
  auraAlpha: 0,
  auraScale: 1,
  trailAlpha: 0,
  trailOffsetRatio: 0,
});

/** Borne une valeur dans `[min ; max]` : un effet ne doit jamais pouvoir sortir de son cadre. */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * État visuel d'un personnage pour une frame.
 *
 * `pulseMs` est un temps **réel** accumulé par le rendu : il ne vient d'aucune horloge de simulation,
 * et l'appeler deux fois de suite avec la même valeur donne exactement le même résultat.
 */
export function eventVisualOf(character: CharacterState, pulseMs: number): EventVisual {
  const event = character.activeEvent;
  if (event === null) {
    return NO_EVENT_VISUAL;
  }

  const magnitude = Number.isFinite(event.magnitude) ? event.magnitude : 0;
  if (magnitude === 0) {
    return NO_EVENT_VISUAL;
  }

  const intensity = clamp(Math.abs(magnitude) / FULL_INTENSITY_MAGNITUDE, 0, 1);
  const phase = Number.isFinite(pulseMs) ? pulseMs : 0;
  // Onde de `0` à `1` : la pulsation module l'opacité du halo, jamais sa position.
  const pulse = 0.5 + 0.5 * Math.sin((phase / PULSE_PERIOD_MS) * Math.PI * 2);

  if (magnitude > 0) {
    return Object.freeze({
      kind: 'bonus',
      intensity,
      // Aucune teinte : un bonus **ajoute** de la lumière, il ne repeint pas le personnage.
      tint: 0xffffff,
      auraTint: 0xffe08a,
      auraAlpha: clamp((0.16 + 0.22 * intensity) * (0.75 + 0.25 * pulse), 0, 0.5),
      auraScale: 1.06 + 0.05 * intensity + 0.02 * pulse,
      trailAlpha: clamp(0.08 + 0.16 * intensity, 0, 0.3),
      trailOffsetRatio: 0.18 + 0.22 * intensity,
    });
  }

  return Object.freeze({
    kind: 'malus',
    intensity,
    // Teinte multiplicative : l'illustration s'assombrit et tire vers le rouge, sans être remplacée.
    tint: 0xd08a96,
    auraTint: 0x501018,
    auraAlpha: clamp(0.2 + 0.24 * intensity, 0, 0.5),
    auraScale: 1.04 + 0.04 * intensity,
    trailAlpha: clamp(0.14 + 0.2 * intensity, 0, 0.36),
    trailOffsetRatio: 0.12 + 0.16 * intensity,
  });
}
