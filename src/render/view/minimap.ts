import type { CharacterId } from '../../core/types';

/**
 * Mini-carte du HUD : placement **pur** des 6 marqueurs sur l'échelle `0 → VIEW.NOMINAL_SCALE_M`.
 *
 * Ce module ne lit aucune source de données : il reçoit des distances déjà calculées par le noyau et
 * renvoie des positions bornées. Il n'a donc aucun accès à la simulation, et ne peut ni la modifier
 * ni la décaler. Les positions renvoyées n'influencent rien : elles ne vivent que dans le DOM du HUD.
 *
 * ## Dépassement de l'échelle
 *
 * `NOMINAL_SCALE_M` est la longueur du décor, jamais une ligne d'arrivée (invariant §5.3) : un
 * personnage peut la franchir. Quand c'est le cas, le marqueur est **borné** à l'extrémité de la
 * piste — il ne sort jamais de la mini-carte — et `overflowM` publie de combien il l'a dépassée,
 * ce que le HUD affiche sous la forme `+xx m`. Le marqueur reste donc lisible, et l'information
 * « au-delà de l'échelle » n'est jamais perdue.
 */

/** Entrée d'un marqueur : identité visuelle et distance lue dans le noyau. */
export interface MinimapMarkerInput {
  readonly id: CharacterId;
  /** Distance parcourue, en mètres : celle de `CharacterState.x`, sans transformation. */
  readonly distance: number;
  /** Couleur d'identité, issue du roster (`core/characters.ts`). */
  readonly color: string;
}

/** Placement d'un marqueur sur la mini-carte, une fois l'échelle appliquée. */
export interface MinimapMarker {
  readonly id: CharacterId;
  readonly color: string;
  /** Distance d'origine, en mètres — conservée telle quelle pour les tests et le debug. */
  readonly distance: number;
  /** Position **bornée** dans `[0 ; 1]`, `1` correspondant à `NOMINAL_SCALE_M`. */
  readonly position: number;
  /** Vrai si la distance dépasse l'échelle nominale. */
  readonly overflow: boolean;
  /** Dépassement de l'échelle, en mètres : strictement positif si et seulement si `overflow`. */
  readonly overflowM: number;
}

function requireUsableScale(scaleM: number): void {
  if (!Number.isFinite(scaleM) || scaleM <= 0) {
    throw new RangeError(`L'échelle de la mini-carte doit être un nombre fini strictement positif (reçu : ${scaleM}).`);
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

/**
 * Place les marqueurs sur l'échelle.
 *
 * La position est strictement proportionnelle à la distance : la mini-carte ne peut donc pas montrer
 * un ordre différent de celui des `x` du noyau. Seule la borne haute est écrêtée, et uniquement pour
 * les personnages qui dépassent le décor.
 */
export function minimapMarkers(
  inputs: readonly MinimapMarkerInput[],
  scaleM: number,
): readonly MinimapMarker[] {
  requireUsableScale(scaleM);

  return inputs.map((input) => {
    if (!Number.isFinite(input.distance)) {
      throw new RangeError(`Distance non finie pour « ${input.id} » (reçu : ${input.distance}).`);
    }

    const raw = input.distance / scaleM;
    const overflowM = input.distance - scaleM;
    return {
      id: input.id,
      color: input.color,
      distance: input.distance,
      position: clamp(raw, 0, 1),
      overflow: overflowM > 0,
      overflowM: overflowM > 0 ? overflowM : 0,
    };
  });
}
