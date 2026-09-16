import { RACE_CONFIG } from './config';

/**
 * Structure **temporelle** de la course.
 *
 * Ce module ne connaît que du temps simulé. Il ne contient aucune distance, aucun repère de décor,
 * aucune notion d'arrivée « à une ligne » : la course se termine parce que le temps simulé est
 * écoulé, jamais parce qu'un personnage a atteint un endroit.
 *
 * ## Contrat d'exactitude (important pour `RaceEngine`)
 *
 * Les instants de checkpoint doivent tomber **exactement** sur un pas de simulation. Le noyau doit
 * donc dériver le temps simulé par multiplication — `tSim = step × RACE_CONFIG.DT_S` — et **jamais**
 * par accumulation (`tSim += DT_S`), qui dérive :
 *
 * | Pas | `step × DT_S` | Accumulation naïve |
 * | --- | --- | --- |
 * | `2700` | `45` exactement | `44.99999999999873` |
 * | `5400` | `90` exactement | `89.99999999999618` |
 * | `8100` | `135` exactement | `134.99999999999957` |
 * | `10800` | `180` exactement | `180.00000000003539` |
 *
 * Avec la multiplication, les comparaisons ci-dessous sont **exactes** et aucune tolérance n'est
 * nécessaire — ce qui permet d'affirmer « la course se termine à partir de `tSim = 180 s`, et
 * seulement là » sans zone grise.
 */

/** Le noyau ne produit jamais de temps non fini : c'est une erreur de programmation, pas un cas de jeu. */
function requireFiniteTime(tSim: number): void {
  if (!Number.isFinite(tSim)) {
    throw new RangeError(`tSim doit être un nombre fini (reçu : ${tSim}).`);
  }
}

/**
 * Index du segment courant, de `0` à `SEGMENT_COUNT - 1`.
 *
 * Segments : `[0, 45)`, `[45, 90)`, `[90, 135)`, `[135, 180]`. L'instant de séparation appartient
 * toujours au segment qui commence. Un temps simulé négatif est ramené à `0`, et un temps au-delà de
 * la fin de course reste dans le dernier segment.
 */
export function segmentIndexAt(tSim: number): number {
  requireFiniteTime(tSim);
  if (tSim <= 0) {
    return 0;
  }
  const index = Math.floor(tSim / RACE_CONFIG.SEGMENT_DURATION_S);
  return Math.min(index, RACE_CONFIG.SEGMENT_COUNT - 1);
}

/**
 * Temps simulé écoulé depuis le début du segment courant, en secondes.
 *
 * Vaut `0` à l'instant de départ d'un segment, et n'est jamais négatif. Au-delà de la fin de course,
 * la valeur continue de croître dans le dernier segment : l'information n'est pas écrêtée.
 */
export function segmentElapsedS(tSim: number): number {
  requireFiniteTime(tSim);
  if (tSim <= 0) {
    return 0;
  }
  return tSim - segmentIndexAt(tSim) * RACE_CONFIG.SEGMENT_DURATION_S;
}

/**
 * Vrai si `tSim` est **exactement** un instant de checkpoint : `45`, `90` ou `135 s`.
 *
 * Le départ (`tSim = 0`) et la fin de course (`tSim = 180 s`) n'en sont pas : un checkpoint sépare
 * deux segments, il ne les termine pas. Un découpage d'un millième de seconde plus loin n'en est
 * évidemment pas un.
 */
export function isCheckpointInstant(tSim: number): boolean {
  requireFiniteTime(tSim);
  return segmentIndexAt(tSim) >= 1 && segmentElapsedS(tSim) === 0;
}

/**
 * Vrai à partir de `tSim = TOTAL_SIM_S` (`180 s`), et seulement là.
 *
 * Aucune distance n'intervient dans cette décision : c'est le **seul** critère d'arrêt de la course,
 * exactement `TOTAL_STEPS = 10800` pas.
 */
export function isRaceOver(tSim: number): boolean {
  requireFiniteTime(tSim);
  return tSim >= RACE_CONFIG.TOTAL_SIM_S;
}
