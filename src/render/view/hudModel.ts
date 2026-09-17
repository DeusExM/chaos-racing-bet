import { CHARACTERS } from '../../core/characters';
import { RACE_CONFIG } from '../../core/config';
import type { RacePhase, RaceState } from '../../core/types';
import { leaderboardOf } from '../../sim/leaderboard';
import type { SimPhase } from '../../sim/types';
import { VIEW } from '../viewConfig';
import type { HudModel } from './Hud';
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
 * Numéro de segment courant, `0` quand la course n'est pas en cours.
 *
 * Il est lu tel quel dans la phase du noyau : le rendu ne recalcule aucune frontière de segment.
 */
export function segmentNumberFor(phase: RacePhase): number {
  return phase.kind === 'running' ? phase.segment : 0;
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
    segment: {
      number: segmentNumberFor(state.phase),
      elapsedS: state.phase.kind === 'running' ? state.phase.segmentElapsedS : 0,
    },
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
