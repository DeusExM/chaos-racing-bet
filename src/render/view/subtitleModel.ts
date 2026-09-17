import type { CharacterId, RaceFact } from '../../core/types';
import type { SpeakerLine } from '../subtitle';
import { VIEW } from '../viewConfig';

/**
 * Modèle **pur** du bandeau de commentaire (P012).
 *
 * Tout ce qui décide de l'apparence du bandeau vit ici, hors de Phaser : la durée d'affichage, le
 * personnage mis en avant, l'état de la file, et la transition entre deux répliques. `SubtitleBanner`
 * ne fait plus que dessiner ce modèle, ce qui rend ces règles testables en environnement `node`.
 *
 * Aucune de ces fonctions ne lit l'état de course, ne tire de hasard ni ne connaît le speaker : elles
 * transforment une `SpeakerLine` **déjà décidée** en une description d'affichage.
 */

/** Description d'une réplique à l'écran, telle que le bandeau la dessine. */
export interface SubtitleModel {
  /** Texte de la réplique, exactement celui produit par le catalogue. */
  readonly text: string;
  /** Identifiant du personnage nommé par la phrase, ou `null`. */
  readonly characterId: CharacterId | null;
  /** Nom affiché de ce personnage, ou `null`. */
  readonly characterName: string | null;
  /** Nombre de commentaires réellement en attente dans la file du speaker. */
  readonly queuedCount: number;
  /** Indicateur de file, par exemple `+2 en attente`. Vide quand la file est vide. */
  readonly queueBadge: string;
  /** Vrai si la réplique a coupé la précédente. */
  readonly preempted: boolean;
}

/** Modèle d'un bandeau masqué : aucun texte, aucune file à signaler. */
export const EMPTY_SUBTITLE_MODEL: SubtitleModel = Object.freeze({
  text: '',
  characterId: null,
  characterName: null,
  queuedCount: 0,
  queueBadge: '',
  preempted: false,
});

/**
 * Vue de test d'une réplique affichée : le texte, **et le fait qui l'a produite**.
 *
 * Elle existe pour qu'un test puisse vérifier que le texte affiché correspond exactement au fait
 * mesuré, au lieu de se contenter de constater « du texte existe ».
 */
export interface SubtitleLineView {
  readonly text: string;
  readonly fact: RaceFact;
  readonly variantIndex: number;
  readonly characterId: CharacterId | null;
  readonly characterName: string | null;
  readonly queuedCount: number;
  readonly preempted: boolean;
  readonly startedAtS: number;
}

/**
 * Durée d'affichage d'une réplique, **adaptée à sa longueur**.
 *
 * Une phrase courte ne doit pas rester trois secondes après avoir été lue, une phrase longue ne doit
 * pas disparaître avant la fin. La durée est bornée des deux côtés pour rester prévisible, et elle
 * reste du temps **réel** : elle ne touche ni un cooldown du speaker, ni la sélection des lignes, ni
 * `tSim`. Le seul effet de bord — voulu et déjà présent en P009 — est de libérer plus ou moins tôt la
 * place de la réplique courante.
 *
 * Les bornes de `VIEW` sont dérivées du catalogue **réel** (46 à 98 caractères, médiane 74) et d'une
 * vitesse de lecture confortable (≤ 20 caractères par seconde, et ≤ 17 cps pour les plus longues) :
 * voir `SUBTITLE_MIN_MS`. Aucune réplique réelle n'y est écrasée au plafond, sauf les toutes
 * dernières, ce qui rend l'adaptation effective au lieu d'être nominale.
 */
export function subtitleDurationMs(text: string): number {
  const characters = text.trim().length;
  const wanted = VIEW.SUBTITLE_MIN_MS + characters * VIEW.SUBTITLE_PER_CHAR_MS;
  return Math.min(VIEW.SUBTITLE_MAX_MS, Math.max(VIEW.SUBTITLE_MIN_MS, wanted));
}

/**
 * Personnage que la phrase nomme réellement, ou `null`.
 *
 * Le parcours suit l'ordre des personnages du fait — donc l'ordre de pertinence choisi par
 * l'observateur — et retient le **premier dont le nom apparaît dans le texte**. Aucun nom n'est
 * inventé : si la variante tirée ne cite personne (certaines variantes de `CLOSE_RACE`, par exemple),
 * le bandeau n'affiche aucun nom plutôt qu'un nom plaqué.
 */
export function pickLineCharacter(
  text: string,
  characterIds: readonly CharacterId[],
  nameOf: (id: CharacterId) => string,
): CharacterId | null {
  for (const id of characterIds) {
    if (text.includes(nameOf(id))) {
      return id;
    }
  }
  return null;
}

/** Indicateur de file : le gabarit `{n}` est remplacé, et une file vide ne produit aucun libellé. */
export function queueBadgeLabel(queuedCount: number, template: string): string {
  if (!Number.isInteger(queuedCount) || queuedCount <= 0) {
    return '';
  }
  return template.replace('{n}', String(queuedCount));
}

/** Assemble le modèle d'affichage d'une réplique. `null` (ou un texte vide) ⇒ bandeau masqué. */
export function buildSubtitleModel(
  line: SpeakerLine | null,
  queuedCount: number,
  queueTemplate: string,
): SubtitleModel {
  if (line === null || line.text.length === 0) {
    return EMPTY_SUBTITLE_MODEL;
  }
  return Object.freeze({
    text: line.text,
    characterId: line.characterId,
    characterName: line.characterName,
    queuedCount,
    queueBadge: queueBadgeLabel(queuedCount, queueTemplate),
    preempted: line.preempted,
  });
}

/**
 * Clé d'identité d'une réplique affichée.
 *
 * Deux répliques différentes donnent deux clés différentes ; la même réplique redonnée à la frame
 * suivante donne la même clé, donc aucune réécriture inutile.
 */
export function subtitleKey(model: SubtitleModel): string | null {
  if (model.text.length === 0) {
    return null;
  }
  return `${model.characterName ?? ''}\u0000${model.text}`;
}

/** Vue de test d'une réplique, ou `null` quand rien n'est affiché. */
export function subtitleLineView(
  line: SpeakerLine | null,
  queuedCount: number,
): SubtitleLineView | null {
  if (line === null || line.text.length === 0) {
    return null;
  }
  return {
    text: line.text,
    fact: line.decision.fact,
    variantIndex: line.variantIndex,
    characterId: line.characterId,
    characterName: line.characterName,
    queuedCount,
    preempted: line.preempted,
    startedAtS: line.startedAtS,
  };
}

/** Ce que le bandeau doit faire de la réplique reçue, par rapport à celle déjà affichée. */
export type BannerTransition = 'hidden' | 'appear' | 'replace' | 'hold' | 'leave';

/**
 * Transition à appliquer entre la clé affichée et la clé reçue.
 *
 * `replace` est le cas de la **préemption** : une nouvelle réplique remplace une réplique en cours,
 * sans file intermédiaire et sans jamais remettre l'ancienne. `leave` est la disparition propre : le
 * texte n'est plus affiché, mais le bandeau s'efface avant de se cacher.
 */
export function bannerTransition(currentKey: string | null, nextKey: string | null): BannerTransition {
  if (nextKey === null) {
    return currentKey === null ? 'hidden' : 'leave';
  }
  if (currentKey === null) {
    return 'appear';
  }
  return currentKey === nextKey ? 'hold' : 'replace';
}

/** État d'opacité du bandeau : montée, descente, ou palier. */
export interface FadeState {
  readonly alpha: number;
  readonly phase: 'in' | 'out' | 'steady';
}

/** Départ d'une apparition, depuis une opacité nulle. */
export function fadeInStart(): FadeState {
  return { alpha: 0, phase: 'in' };
}

/** Départ d'une disparition, depuis l'opacité courante (jamais un saut brutal à zéro). */
export function fadeOutStart(state: FadeState): FadeState {
  return { alpha: state.alpha, phase: 'out' };
}

/** Avance l'opacité du temps réel écoulé, en la bornant à `[0 ; 1]`. */
export function advanceFade(state: FadeState, realDtMs: number): FadeState {
  const elapsed = Number.isFinite(realDtMs) && realDtMs > 0 ? realDtMs : 0;
  if (state.phase === 'in') {
    const alpha = Math.min(1, state.alpha + elapsed / VIEW.SUBTITLE_FADE_IN_MS);
    return { alpha, phase: alpha >= 1 ? 'steady' : 'in' };
  }
  if (state.phase === 'out') {
    const alpha = Math.max(0, state.alpha - elapsed / VIEW.SUBTITLE_FADE_OUT_MS);
    return { alpha, phase: alpha <= 0 ? 'steady' : 'out' };
  }
  return state;
}

/** Le bandeau a-t-il fini de disparaître ? C'est à ce moment seulement qu'il se cache vraiment. */
export function isFadeComplete(state: FadeState): boolean {
  return state.phase === 'steady' && state.alpha <= 0;
}
