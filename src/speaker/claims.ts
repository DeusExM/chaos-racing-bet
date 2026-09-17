import type { RaceFactType } from '../core/types';

/**
 * Le fait revendique-t-il une **position en cours** ?
 *
 * ## Pourquoi cette distinction existe
 *
 * Tous les faits sont des mesures datées, mais tous ne vieillissent pas de la même façon. Un
 * `OVERTAKE_STREAK` (« 3 dépassements en 5 s ») ou un `BIG_BONUS` (« +163 % pendant 5 s ») décrit un
 * **épisode passé** : dit quelques secondes plus tard, il reste vrai sur le fond, et ses variantes le
 * disent au passé ou horodatent explicitement leur chiffre (« au tirage »). Un `LEADER_CHANGE`, un
 * `BIG_COMEBACK`, un `LAST_COMEBACK` ou un `LEADER_MALUS`, au contraire, portent une variante qui
 * affirme *où en est* le personnage (« voilà le 1er », « leader », « s'installe en tête ») : une
 * position, elle, n'est vraie qu'à l'instant où elle est mesurée.
 *
 * ## Ce que cette fonction garantit, et ne garantit pas
 *
 * Elle ne *vérifie* pas la position — le speaker n'a aucun accès au classement, et c'est ce qui
 * l'empêche d'inventer. Elle **classe** les faits pour que le speaker applique aux revendications de
 * position une fenêtre de fraîcheur beaucoup plus courte qu'aux autres. C'est le seul levier
 * compatible avec la frontière `speaker → core/types` : on ne peut pas rendre vraie une mesure
 * ancienne, on peut seulement refuser de la prononcer tard.
 *
 * Le `switch` est **exhaustif et sans `default`** : ajouter un `RaceFactType` sans décider
 * explicitement s'il revendique une position casse la compilation, au lieu de le classer en silence
 * du côté permissif.
 */
export function claimsCurrentRank(type: RaceFactType): boolean {
  switch (type) {
    case 'LEADER_CHANGE':
    case 'BIG_COMEBACK':
    case 'LAST_COMEBACK':
    case 'LEADER_MALUS':
      return true;
    case 'OVERTAKE_STREAK':
    case 'BIG_BONUS':
    case 'CLOSE_RACE':
    case 'CHECKPOINT_SPLIT':
    case 'FINISH':
    case 'PHOTO_FINISH':
      return false;
  }
}
