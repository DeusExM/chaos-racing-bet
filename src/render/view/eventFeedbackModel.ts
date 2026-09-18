import type { ActiveEvent, CharacterId, CharacterState } from '../../core/types';
import type { UiText } from '../uiText';

/**
 * Modèle **pur** du retour visuel d'événement (passe corrective §10).
 *
 * Il transforme une frame déjà lue (états du noyau + positions d'écran) en une liste de badges
 * affichables. Aucune fonction de ce module ne touche au DOM, à `RaceSimulation`, à un générateur
 * aléatoire ou à une horloge : c'est ce qui rend le retour visuel testable **sans navigateur** et
 * vérifiable comme une simple lecture.
 *
 * Règle de véracité, la même que pour le speaker : le mot principal est le libellé du `EventId`
 * réellement actif, et `BONUS !` / `MALUS !` est déduit du **signe de la magnitude réelle**. Aucun
 * événement n'est classé « gentil » ou « méchant » par une table écrite à la main.
 */

/** Nature d'un événement, déduite du signe de sa magnitude. */
export type EventKind = 'bonus' | 'malus' | 'neutral';

/** Position d'écran d'un personnage, en pixels logiques du canvas. */
export interface EventBadgePosition {
  readonly id: CharacterId;
  readonly screenX: number;
  readonly screenY: number;
  /**
   * Demi-largeur réellement dessinée du sprite, en pixels logiques.
   *
   * Elle sert à reculer le badge **derrière** le personnage : la course va de gauche à droite, donc
   * le mot est posé à gauche du sprite, séparé de lui par `EVENT_BADGE_GAP_PX`. Sans cette mesure, le
   * rendu devrait supposer une largeur, et le badge pourrait mordre sur l'illustration.
   */
  readonly halfWidth: number;
}

/** Dimensions logiques de l'arène : elles servent à convertir une position d'écran en pourcentage. */
export interface EventBadgeLayout {
  readonly width: number;
  readonly height: number;
}

/** Badge prêt à écrire : toutes les valeurs affichées sont déjà résolues. */
export interface EventBadge {
  readonly id: CharacterId;
  readonly eventId: string;
  /** Identité de l'occurrence : `type@départ`. Deux `TURBO` successifs ne se confondent pas. */
  readonly occurrence: string;
  readonly kind: EventKind;
  /** Libellé court de l'événement : `TURBO !`, `CHUTE !`… */
  readonly label: string;
  /** `BONUS !` ou `MALUS !`, vide pour un événement neutre. */
  readonly kindLabel: string;
  /** Position du badge, en pourcentage de l'arène, bornée à `[0 ; 100]`. */
  readonly leftPercent: number;
  readonly topPercent: number;
  /** Instant simulé de départ de l'événement : permet de vérifier la durée réelle du badge. */
  readonly startSimS: number;
}

/**
 * Classe un événement par le signe de sa magnitude.
 *
 * Un événement de magnitude nulle n'est ni un bonus ni un malus : le badge reste neutre plutôt que
 * d'affirmer quelque chose que le noyau n'a pas dit.
 */
export function eventKindOf(event: ActiveEvent): EventKind {
  if (event.magnitude > 0) {
    return 'bonus';
  }
  return event.magnitude < 0 ? 'malus' : 'neutral';
}

/**
 * Identité d'une occurrence d'événement : le type **et** son instant de départ.
 *
 * Deux `TURBO` successifs sur le même personnage sont deux occurrences distinctes : les confondre
 * ferait disparaître le second badge sans jamais l'afficher.
 */
export function eventOccurrence(event: ActiveEvent): string {
  return `${event.id}@${String(event.startSimS)}`;
}

/** Borne une position d'écran au pourcentage d'arène : un badge reste toujours visible. */
function toPercent(value: number, total: number): number {
  if (!(total > 0) || !Number.isFinite(value)) {
    return 0;
  }
  return Math.min(100, Math.max(0, (value / total) * 100));
}

/**
 * Construit les badges d'une frame.
 *
 * Un personnage sans événement actif n'a pas de badge ; un personnage dont la position d'écran est
 * inconnue n'en a pas non plus (rien ne serait alors désigné). L'ordre suit celui des personnages,
 * c'est-à-dire l'ordre stable du roster : l'affichage ne dépend donc d'aucune itération de `Map`.
 */
export function buildEventBadges(
  characters: readonly CharacterState[],
  positions: readonly EventBadgePosition[],
  layout: EventBadgeLayout,
  text: UiText,
): readonly EventBadge[] {
  const badges: EventBadge[] = [];

  for (const character of characters) {
    const event = character.activeEvent;
    if (event === null) {
      continue;
    }
    const position = positions.find((candidate) => candidate.id === character.id);
    if (position === undefined) {
      continue;
    }

    const kind = eventKindOf(event);
    badges.push({
      id: character.id,
      eventId: event.id,
      occurrence: eventOccurrence(event),
      kind,
      // Un `EventId` inconnu du catalogue retombe sur son identifiant technique : jamais sur un mot
      // inventé, et jamais sur un badge vide.
      label: text.eventLabels[event.id] ?? event.id,
      kindLabel:
        kind === 'bonus'
          ? (text.eventFeedback['bonus'] ?? '')
          : kind === 'malus'
            ? (text.eventFeedback['malus'] ?? '')
            : '',
      leftPercent: toPercent(position.screenX, layout.width),
      topPercent: toPercent(position.screenY, layout.height),
      startSimS: event.startSimS,
    });
  }

  return badges;
}
