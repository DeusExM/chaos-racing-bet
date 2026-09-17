import type { CharacterId } from '../../core/types';

/**
 * Modèle de piste : placement **pur** des 6 marqueurs sur l'échelle `0 → VIEW.NOMINAL_SCALE_M`.
 *
 * Ce module ne lit aucune source de données : il reçoit des distances déjà calculées par le noyau et
 * renvoie des positions bornées. Il n'a donc aucun accès à la simulation, et ne peut ni la modifier
 * ni la décaler. Les positions renvoyées n'influencent rien : elles sont publiées dans le modèle du
 * HUD (`HudModel.markers`).
 *
 * **La mini-carte n'est plus dessinée depuis la passe corrective** (premier test joueur : le HUD
 * masquait trop la course). Ce module est conservé comme **hook de test et de debug** — il est encore
 * vérifié par les tests unitaires et E2E — et pour une éventuelle carte en P014.
 *
 * ## Dépassement de l'échelle
 *
 * `NOMINAL_SCALE_M` est la longueur du décor, jamais une ligne d'arrivée (invariant §5.3) : un
 * personnage peut la franchir. Quand c'est le cas, le marqueur est **borné** à `1` — l'échelle n'est
 * jamais recadrée en cours de course — et `overflowM` publie de combien il l'a dépassée. Le modèle
 * porte donc toujours l'information « au-delà de l'échelle », même si plus aucun élément d'interface
 * ne l'affiche aujourd'hui.
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
