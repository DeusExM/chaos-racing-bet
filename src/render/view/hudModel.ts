import { CHARACTERS } from '../../core/characters';
import { RACE_CONFIG } from '../../core/config';
import type { RacePhase, RaceState } from '../../core/types';
import { leaderboardOf } from '../../sim/leaderboard';
import type { SimPhase } from '../../sim/types';
import { VIEW } from '../viewConfig';
import type { HudModel, HudSegment } from './Hud';
import { minimapMarkers } from './minimap';

/**
 * Construction des modèles du HUD et du panneau de debug.
 *
 * Ces fonctions sont **pures** et n'importent rien de Phaser ni du DOM : elles transforment un
 * instantané du noyau en un modèle affichable, et peuvent donc être testées en environnement node.
 * C'est ce qui garantit, par construction, que le HUD ne fait que **lire** la course — s'il avait
 * fallu le moteur ou une horloge pour produire ces modèles, ce serait le signe d'une seconde source
 * de vérité.
 *
 * Aucune règle de jeu n'est réécrite ici : le classement vient de `sim/leaderboard.ts`, les distances
 * de `CharacterState.x`, les segments de `RacePhase`. Les seules constantes utilisées sont celles du
 * noyau, jamais recopiées.
 */

/**
 * Numéro de segment courant, ou `null` quand **aucun segment n'est en cours**.
 *
 * Il est lu tel quel dans la phase du noyau : le rendu ne recalcule aucune frontière de segment.
 *
 * `null` — et non `0` — parce qu'un segment est un numéro humain de `1` à `SEGMENT_COUNT` : il
 * n'existe ni segment `0`, ni segment `4`. La passe corrective 2 a corrigé ce point : à `60,0 s`, la
 * phase du noyau devient `finished`, et l'ancien `0` s'affichait tel quel en `segment 0/3` — un
 * segment qui n'existe pas. Un HUD ne doit jamais pouvoir afficher une valeur de segment invalide,
 * donc l'absence de segment est représentée comme une absence, pas comme un zéro.
 */
export function segmentNumberFor(phase: RacePhase): number | null {
  return phase.kind === 'running' ? phase.segment : null;
}

/**
 * Segment affichable à partir de la phase du noyau : numéro, temps écoulé, ou `null`.
 *
 * Le `switch` est exhaustif : ajouter une phase au noyau oblige à décider ce que le HUD affiche.
 */
export function buildSegment(phase: RacePhase): HudSegment | null {
  switch (phase.kind) {
    case 'running':
      return { number: phase.segment, elapsedS: phase.segmentElapsedS };
    case 'idle':
    case 'finished':
      return null;
  }
}

/**
 * Instant d'une borne de checkpoint : `45`, `90` ou `135`.
 *
 * `CHECKPOINT_SPLIT` est produit par le noyau à `tSim = n × SEGMENT_DURATION_S` (P006) : la borne se
 * déduit donc de la constante du noyau, sans jamais recopier `45`.
 */
export function checkpointTimeS(checkpoint: number): number {
  return checkpoint * RACE_CONFIG.SEGMENT_DURATION_S;
}

/**
 * Assemble le modèle du HUD à partir d'un unique instantané du noyau.
 *
 * Toutes les valeurs viennent de `RaceState` ou de `leaderboardOf` — la seule source de classement du
 * projet. Rien n'est recalculé ici : le HUD ne peut donc pas afficher un classement ou une position
 * qui divergent du noyau.
 */
export function buildHudModel(
  state: Readonly<RaceState>,
  phase: SimPhase,
  checkpoint: number | null,
): HudModel {
  const rows = leaderboardOf(state);
  return {
    seed: state.seed,
    phase,
    tSim: state.tSim,
    steps: state.steps,
    // `null` hors segment en cours : le HUD affiche alors « Terminé » ou un tiret, jamais `0/3`.
    segment: buildSegment(state.phase),
    rows,
    markers: minimapMarkers(
      CHARACTERS.map((character, index) => ({
        id: character.id,
        distance: state.characters[index]?.x ?? 0,
        color: character.color,
      })),
      VIEW.NOMINAL_SCALE_M,
    ),
    checkpoint:
      checkpoint === null
        ? null
        : {
            number: checkpoint,
            timeS: checkpointTimeS(checkpoint),
            // Pendant la pause, le noyau est gelé à la borne : les écarts lus ici **sont** le split.
            rows,
          },
  };
}
