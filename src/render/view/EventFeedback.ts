import type { CharacterId, CharacterState } from '../../core/types';
import type { UiText } from '../uiText';
import {
  buildEventBadges,
  type EventBadge,
  type EventBadgeLayout,
  type EventBadgePosition,
} from './eventFeedbackModel';

/**
 * Retour visuel d'événement, **par personnage** — écriture DOM du modèle pur.
 *
 * ## Le problème corrigé
 *
 * Le premier test joueur manuel a relevé que les bonus et les malus « s'appliquaient mais ne se
 * voyaient pas » : un événement changeait la vitesse d'un personnage sans qu'aucun signe visible ne
 * l'annonce, si bien qu'une remontée ou un décrochage paraissait arbitraire. Ce module attache donc
 * un mot court (`TURBO !`, `CHUTE !`…) **au personnage concerné**, le temps que l'événement dure.
 *
 * ## Lecture seule, par construction
 *
 * Tout ce qui est *décidé* vit dans `eventFeedbackModel.ts`, une fonction pure testable sans
 * navigateur : ce fichier ne fait qu'écrire dans le DOM une liste de badges déjà résolus. Il ne
 * connaît ni `RaceSimulation`, ni `RaceEngine`, ni un générateur aléatoire, ni une horloge, et il ne
 * modifie aucun état de course : supprimer cette couche ne changerait pas une seule distance.
 *
 * ## Pourquoi du HTML et non du canvas
 *
 * Pour la même raison que le HUD (P011) : la couche est positionnée en **pourcentage de l'arène**,
 * qui est exactement le canvas (`Scale.FIT` sur une base 16:9). Un texte de canvas devrait, lui, être
 * redimensionné à la main à chaque résolution, et ne serait pas comparable par un test E2E. La
 * direction artistique définitive (halo, particules, icônes) appartient à P014.
 */
export class EventFeedback {
  private readonly root: HTMLElement;

  private readonly text: UiText;

  /** Badges en cours, indexés par personnage : un seul badge visible par personnage. */
  private readonly badges = new Map<CharacterId, HTMLElement>();

  /** Occurrence affichée par personnage : évite de réécrire un badge qui n'a pas changé. */
  private readonly shown = new Map<CharacterId, string>();

  constructor(root: HTMLElement, text: UiText) {
    this.text = text;

    this.root = document.createElement('div');
    this.root.className = 'hud-events';
    this.root.dataset['testid'] = 'event-feedback';
    // Une décoration purement visuelle : elle ne doit pas être annoncée à chaque apparition, sous
    // peine de rendre le commentaire et le classement inaudibles pour un lecteur d'écran.
    this.root.setAttribute('aria-hidden', 'true');
    root.appendChild(this.root);
  }

  /**
   * Applique l'état d'une frame, déjà lu par la scène.
   *
   * Aucune écriture de jeu n'est possible : le modèle ne contient que des états en lecture et des
   * positions d'écran. Le cache interne ne sert qu'à éviter de réécrire le DOM soixante fois par
   * seconde pour un badge identique.
   */
  update(
    characters: readonly CharacterState[],
    positions: readonly EventBadgePosition[],
    layout: EventBadgeLayout,
  ): void {
    const badges = buildEventBadges(characters, positions, layout, this.text);
    const active = new Set<CharacterId>();

    for (const badge of badges) {
      active.add(badge.id);
      const element = this.ensureBadge(badge.id);

      if (this.shown.get(badge.id) !== badge.occurrence) {
        this.shown.set(badge.id, badge.occurrence);
        this.writeContent(element, badge);
      }

      // Le libellé suit le personnage : il est posé juste au-dessus de son sprite.
      element.style.left = `${badge.leftPercent.toFixed(3)}%`;
      element.style.top = `${badge.topPercent.toFixed(3)}%`;
    }

    for (const [id, element] of this.badges) {
      if (!active.has(id)) {
        element.remove();
        this.badges.delete(id);
        this.shown.delete(id);
      }
    }
  }

  /** Nombre de badges visibles : lu par les tests, jamais par le rendu. */
  get visibleCount(): number {
    return this.badges.size;
  }

  /** Occurrences affichées, dans l'ordre d'insertion : photographie de test. */
  snapshot(): readonly { readonly id: CharacterId; readonly occurrence: string }[] {
    return [...this.shown].map(([id, occurrence]) => ({ id, occurrence }));
  }

  private ensureBadge(id: CharacterId): HTMLElement {
    const existing = this.badges.get(id);
    if (existing !== undefined) {
      return existing;
    }

    const badge = document.createElement('div');
    badge.className = 'hud-event';
    badge.dataset['testid'] = 'event-badge';
    badge.dataset['characterId'] = id;

    const label = document.createElement('span');
    label.className = 'hud-event-label';
    label.dataset['testid'] = 'event-label';
    const kind = document.createElement('span');
    kind.className = 'hud-event-kind';
    kind.dataset['testid'] = 'event-kind';
    badge.append(label, kind);

    this.badges.set(id, badge);
    this.root.appendChild(badge);
    return badge;
  }

  /** Écrit le contenu d'un badge : chaque valeur vient du modèle, donc de l'événement réel. */
  private writeContent(badge: HTMLElement, model: EventBadge): void {
    badge.dataset['eventId'] = model.eventId;
    badge.dataset['kind'] = model.kind;
    badge.dataset['eventStart'] = String(model.startSimS);
    badge.classList.toggle('is-bonus', model.kind === 'bonus');
    badge.classList.toggle('is-malus', model.kind === 'malus');

    const labelElement = badge.querySelector<HTMLElement>('.hud-event-label');
    if (labelElement !== null) {
      labelElement.textContent = model.label;
    }

    const kindElement = badge.querySelector<HTMLElement>('.hud-event-kind');
    if (kindElement !== null) {
      kindElement.textContent = model.kindLabel;
      kindElement.hidden = model.kindLabel.length === 0;
    }
  }
}
