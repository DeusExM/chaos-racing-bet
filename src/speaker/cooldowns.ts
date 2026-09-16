/**
 * Cooldowns, quota par segment, fenêtre glissante de densité et registre de déduplication.
 *
 * **Invariant central de P009-B** : un cooldown, un point de quota ou une empreinte ne sont consommés
 * que par une réplique **réellement démarrée**. Un fait rejeté, dédupliqué, jeté de la file ou
 * préempté n'en consomme aucun. C'est pour cela que ces compteurs ne sont mis à jour que par
 * `TypeCooldownTracker.record`, `SegmentQuota.record`, `SlidingWindow.record` et
 * `DedupLedger.record`, tous appelés au même endroit : le démarrage d'une réplique.
 *
 * Aucun de ces objets ne connaît de texte, de fait ni de temps réel : ils ne manipulent que des
 * instants **simulés** (secondes), en arithmétique entière de pas pour les fenêtres.
 */

import type { RaceFactType } from '../core/types';
import { stepsForSeconds, type SpeakerPolicy, type TypeCooldowns } from './policy';

/** Comparaison de cooldown : strictement `>=` (un cooldown de 12 s est levé **à** 12 s). */
function cooldownElapsed(previous: number, nowS: number, cooldownS: number): boolean {
  return nowS - previous >= cooldownS;
}

/** Dernière prise de parole par type, et parité avec le cooldown **global**. */
export class TypeCooldownTracker {
  private lastStartS: Record<RaceFactType, number>;
  private lastAnyStartS: number;

  constructor(private readonly policy: SpeakerPolicy) {
    this.lastStartS = TypeCooldownTracker.emptyStarts();
    // Valeur sentinelle : « aucune prise de parole n'a jamais eu lieu ». L'infini garantit que le
    // cooldown global est satisfait pour la toute première réplique, quelle que soit la config.
    this.lastAnyStartS = Number.NEGATIVE_INFINITY;
  }

  private static emptyStarts(): Record<RaceFactType, number> {
    return {
      LEADER_CHANGE: Number.NEGATIVE_INFINITY,
      BIG_COMEBACK: Number.NEGATIVE_INFINITY,
      OVERTAKE_STREAK: Number.NEGATIVE_INFINITY,
      BIG_BONUS: Number.NEGATIVE_INFINITY,
      LEADER_MALUS: Number.NEGATIVE_INFINITY,
      CLOSE_RACE: Number.NEGATIVE_INFINITY,
      LAST_COMEBACK: Number.NEGATIVE_INFINITY,
      CHECKPOINT_SPLIT: Number.NEGATIVE_INFINITY,
      FINISH: Number.NEGATIVE_INFINITY,
      PHOTO_FINISH: Number.NEGATIVE_INFINITY,
    };
  }

  /** Cooldown **par type** : jamais contourné, même par un fait de préemption maximal. */
  isTypeReady(type: RaceFactType, nowS: number): boolean {
    return cooldownElapsed(this.lastStartS[type], nowS, this.policy.typeCooldownS[type]);
  }

  /**
   * Cooldown **global** : identique pour tous les types. `bypass` est réservé aux faits dont
   * l'importance atteint `preemptImportance` — et à eux seuls.
   */
  isGlobalReady(nowS: number, bypass: boolean): boolean {
    if (bypass) {
      return true;
    }
    return cooldownElapsed(this.lastAnyStartS, nowS, this.policy.globalCooldownS);
  }

  /** Enregistre le démarrage effectif d'une réplique : c'est le **seul** écrivain des cooldowns. */
  record(type: RaceFactType, nowS: number): void {
    this.lastStartS[type] = nowS;
    this.lastAnyStartS = nowS;
  }

  /** Cooldown global toujours écoulé. Vrai avant toute prise de parole et après `reset()`. */
  isFresh(): boolean {
    return this.lastAnyStartS === Number.NEGATIVE_INFINITY;
  }

  reset(): void {
    this.lastStartS = TypeCooldownTracker.emptyStarts();
    this.lastAnyStartS = Number.NEGATIVE_INFINITY;
  }
}

/**
 * Quota dur de répliques par segment, avec **une seule** segmentation possible.
 *
 * `segmentIndex(t)` est volontairement total : `floor` puis bornage sur `segmentCount − 1`. La borne
 * est ce qui empêche l'instant d'arrivée `tSim = 180` de créer un cinquième segment accidentel — la
 * segmentation du design est `[0,45[ [45,90[ [90,135[ [135,180]`, le quota de l'arrivée est donc
 * celui du **dernier** segment.
 */
export function segmentIndex(policy: SpeakerPolicy, nowS: number): number {
  const raw = Math.floor(nowS / policy.segmentDurationS);
  if (raw < 0) {
    return 0;
  }
  const last = policy.segmentCount - 1;
  return raw > last ? last : raw;
}

export class SegmentQuota {
  private readonly used: number[];

  constructor(private readonly policy: SpeakerPolicy) {
    this.used = new Array<number>(policy.segmentCount).fill(0);
  }

  /** Reste-t-il du quota dans le segment de `nowS` ? */
  hasRoom(nowS: number): boolean {
    const index = segmentIndex(this.policy, nowS);
    return (this.used[index] ?? 0) < this.policy.maxLinesPerSegment;
  }

  /** Consomme un point de quota. Appelé uniquement au démarrage effectif d'une réplique. */
  record(nowS: number): void {
    const index = segmentIndex(this.policy, nowS);
    this.used[index] = (this.used[index] ?? 0) + 1;
  }

  countIn(segment: number): number {
    return this.used[segment] ?? 0;
  }

  total(): number {
    let total = 0;
    for (const count of this.used) {
      total += count;
    }
    return total;
  }

  reset(): void {
    this.used.fill(0);
  }
}

/**
 * Fenêtre glissante de densité de parole (`SPEAK.MIN_WINDOW_AVG_S`).
 *
 * **Interprétation retenue** : la moyenne des écarts entre prises de parole *à l'intérieur* de la
 * fenêtre glissante de `windowS` secondes ne peut pas descendre sous `minWindowAvgS`. Le nouveau
 * départ `t` est refusé si, en le comptant, les départs de `[t − windowS, t]` donnent une moyenne
 * d'écart trop courte. Soit `k` le nombre de départs déjà enregistrés dans `[t − windowS, t[` : en
 * comptant le nouveau, la fenêtre contient `k + 1` répliques et donc `k` écarts, répartis sur la
 * largeur effective de la fenêtre (bornée par l'âge du plus ancien départ encore présent, pour ne
 * pas pénaliser le tout début de course) :
 *
 *     largeur = min(windowS, t − plus_ancien_départ)
 *     largeur / k < minWindowAvgS   ⇒   refus   (avec `k = 0` : toujours autorisé)
 *
 * Conséquences directes et vérifiées par les tests :
 * * une cadence de `windowS / k` secondes est **acceptée à la limite exacte** (moyenne égale à
 *   `minWindowAvgS`) et refusée en dessous ;
 * * le garde-fou ne se déclenche **jamais** pour une cadence conforme au cooldown global
 *   (`windowS / 5` = 6 s ≥ 5 s), il n'existe donc que pour les cadences accélérées par un
 *   contournement du cooldown global (fait de préemption ≥ `PREEMPT_IMPORTANCE`) ;
 * * un trou de silence « remet les compteurs à zéro » : dès que tous les départs sont sortis de la
 *   fenêtre, le départ redevient autorisé.
 *
 * La mémoire est bornée par construction : seuls les instants de départ des `windowS` dernières
 * secondes sont conservés (`windowSteps + 1` valeurs au plus).
 */
export class SlidingWindow {
  private readonly steps: number[] = [];
  private readonly windowSteps: number;

  constructor(private readonly policy: SpeakerPolicy) {
    this.windowSteps = stepsForSeconds(policy, policy.windowS);
  }

  private prune(nowStep: number): void {
    while (this.steps.length > 0 && (this.steps[0] ?? 0) < nowStep - this.windowSteps) {
      this.steps.shift();
    }
  }

  /** `SLIDING_ALLOWED` si le nouveau départ respecte la moyenne minimale, `SLIDING_REFUSED` sinon. */
  canStart(nowS: number): SlidingWindowVerdict {
    const nowStep = Math.round(nowS / this.policy.dtS);
    this.prune(nowStep);
    const existing = this.steps.length;
    if (existing === 0) {
      return 'SLIDING_ALLOWED';
    }
    const oldest = this.steps[0] ?? nowStep;
    const ageS = (nowStep - oldest) * this.policy.dtS;
    const widthS = ageS < this.policy.windowS ? ageS : this.policy.windowS;
    return widthS / existing < this.policy.minWindowAvgS ? 'SLIDING_REFUSED' : 'SLIDING_ALLOWED';
  }

  /** Enregistre un départ effectif. Les instants arrivent dans l'ordre : le tableau reste trié. */
  record(nowS: number): void {
    const nowStep = Math.round(nowS / this.policy.dtS);
    this.prune(nowStep);
    if (this.steps.length === 0 || (this.steps[this.steps.length - 1] ?? 0) <= nowStep) {
      this.steps.push(nowStep);
      return;
    }
    // Filet de sécurité d'ordre : insertion à la bonne place plutôt qu'un tableau désordonné.
    this.steps.push(nowStep);
    this.steps.sort((left, right) => left - right);
  }

  count(): number {
    return this.steps.length;
  }

  reset(): void {
    this.steps.length = 0;
  }
}

export type SlidingWindowVerdict = 'SLIDING_ALLOWED' | 'SLIDING_REFUSED';

/**
 * Registre de déduplication : `empreinte → dernier instant **prononcé**`.
 *
 * Le registre ne se remplit qu'à la parole effective : un fait rejeté, jeté de la file ou préempté
 * ne crée aucune empreinte et ne peut donc pas faire taire un fait ultérieur.
 */
export class DedupLedger {
  private readonly spokenAtS = new Map<string, number>();

  constructor(private readonly policy: SpeakerPolicy) {}

  /** Un fait de cette empreinte a-t-il été **prononcé** il y a moins de `dedupWindowS` ? */
  isDuplicate(fingerprint: string, nowS: number): boolean {
    this.prune(nowS);
    const previous = this.spokenAtS.get(fingerprint);
    return previous !== undefined && cooldownElapsed(previous, nowS, this.policy.dedupWindowS) === false;
  }

  record(fingerprint: string, nowS: number): void {
    this.prune(nowS);
    // Réécrire une empreinte existante ne change pas l'ordre d'insertion d'une `Map`, mais l'ordre
    // n'est jamais utilisé : seule la valeur par clé compte. Aucune décision ne dépend d'une
    // itération de `Map`.
    this.spokenAtS.set(fingerprint, nowS);
  }

  /** Mémoire bornée : les empreintes plus vieilles que la fenêtre ne peuvent plus rien supprimer. */
  private prune(nowS: number): void {
    for (const [fingerprint, spokenAt] of this.spokenAtS) {
      if (cooldownElapsed(spokenAt, nowS, this.policy.dedupWindowS)) {
        this.spokenAtS.delete(fingerprint);
      }
    }
  }

  size(): number {
    return this.spokenAtS.size;
  }

  reset(): void {
    this.spokenAtS.clear();
  }
}

/** Résultat d'une évaluation de porte : refus **nommé**, donc diagnosticable et testable. */
export type GateVerdict =
  | 'ALLOWED'
  | 'SEGMENT_QUOTA'
  | 'TYPE_COOLDOWN'
  | 'GLOBAL_COOLDOWN'
  | 'SLIDING_REFUSED';

export interface SpeakGates {
  /** Au moins une place de quota dans le segment courant. */
  readonly hasSegmentRoom: boolean;
  /** Cooldown **par type** écoulé : jamais contournable. */
  readonly typeReady: boolean;
  /** Cooldown **global** écoulé, ou explicitement contourné. */
  readonly globalReady: boolean;
  readonly sliding: SlidingWindowVerdict;
}

/**
 * Ordre d'évaluation des portes, du plus structurel au plus conjoncturel.
 *
 * Le **quota** passe avant les cooldowns : c'est un plafond absolu, il n'est jamais franchi, même
 * par un fait de préemption. Le cooldown **par type** est évalué avant le global, de sorte qu'un
 * fait de préemption ne puisse jamais se présenter comme « seulement » bloqué par le global alors
 * qu'il viole aussi son type : le diagnostic reste exact.
 */
export function evaluateGates(gates: SpeakGates): GateVerdict {
  if (!gates.hasSegmentRoom) {
    return 'SEGMENT_QUOTA';
  }
  if (!gates.typeReady) {
    return 'TYPE_COOLDOWN';
  }
  if (!gates.globalReady) {
    return 'GLOBAL_COOLDOWN';
  }
  if (gates.sliding !== 'SLIDING_ALLOWED') {
    return 'SLIDING_REFUSED';
  }
  return 'ALLOWED';
}

/** Cooldowns par type d'une politique, exposés pour les tests de conformité au design. */
export function typeCooldownsOf(policy: SpeakerPolicy): TypeCooldowns {
  return policy.typeCooldownS;
}