/**
 * Speaker — discipline de parole (P009-B).
 *
 * Le speaker transforme un flux de `RaceFact` **mesurés** en décisions de commentaire : il choisit
 * quels faits méritent d'être dits, quand ils peuvent l'être, lesquels attendent en file, lesquels
 * sont jetés, et lesquels coupent une réplique en cours. Il ne produit **aucun texte**, ne tire
 * **aucun hasard**, ne connaît ni le moteur, ni le rendu, ni l'horloge réelle : le texte et le tirage
 * des variantes appartiennent à P009-C.
 *
 * ## Machine à états
 *
 * ```
 *   feed(fact, tSim) ──▶ importance < MIN           ──▶ REJECTED_IMPORTANCE
 *                    ├─▶ empreinte déjà prononcée   ──▶ DEDUPLICATED
 *                    ├─▶ file pleine & fait plus faible ─▶ REJECTED_QUEUE
 *                    └─▶ file (≤ QUEUE_MAX)          ──▶ QUEUED ─┐
 *                                                                 │
 *   poll(tSim) ──▶ meilleur candidat éligible ◀───────────────────┘
 *                    ├─▶ quota / cooldown de type / global / fenêtre ──▶ reste en file
 *                    └─▶ gate ALLOWED ──▶ CURRENT_LINE + SpeakerDecision
 *
 *   begin / finish / mute ─▶ signalent au speaker le cycle de vie réel de la réplique (P009-C)
 * ```
 *
 * Chaque décision porte le `RaceFact` source : **aucune sortie sans fait**. Un fait est gelé par le
 * noyau et n'est jamais recopié ni modifié ici.
 *
 * ## Ordre des portes
 *
 * `SEGMENT_QUOTA` → `TYPE_COOLDOWN` → `GLOBAL_COOLDOWN` → `SLIDING_REFUSED` (voir `evaluateGates`).
 * Le quota est un plafond absolu, jamais franchi, même par un fait de préemption. Le cooldown par
 * type n'est jamais contournable ; seul le cooldown **global** l'est, et uniquement pour un fait
 * dont l'importance atteint `preemptImportance`.
 */

import {
  DedupLedger,
  SegmentQuota,
  SlidingWindow,
  TypeCooldownTracker,
  evaluateGates,
  segmentIndex,
  type GateVerdict,
} from './cooldowns';
import { dedupFingerprint, isImportantEnough } from './importance';
import { SPEAKER_POLICY, type SpeakerPolicy } from './policy';
import type { RaceFact, RaceFactType } from '../core/types';

/**
 * Délai maximal entre l'observation d'un fait et sa prise de parole, en secondes simulées.
 *
 * Un fait est une **situation datée** : commenter un dépassement survenu il y a plus d'un segment
 * serait faux, et le fait annoncé ne serait plus celui du classement courant. Un candidat plus vieux
 * est donc périmé, retiré de la file, et n'a consommé ni cooldown ni quota — exactement comme s'il
 * n'avait jamais été mis en file. Cette borne est aussi ce qui rend la **mémoire de la file
 * bornée** : à tout instant, elle ne peut contenir que les faits de la dernière minute.
 */
const STALE_AFTER_S = 45;

/** Décision du speaker : un fait source et l'importance qui a justifié sa prise de parole. */
export interface SpeakerDecision {
  readonly fact: RaceFact;
  readonly importance: number;
  /** Instant simulé du **démarrage effectif** de la réplique (≥ `fact.tSim`). */
  readonly startedAtS: number;
}

/** Raison de rejet d'un fait, avant toute mise en file. */
export type SpeakerRejection = 'REJECTED_IMPORTANCE' | 'DEDUPLICATED' | 'REJECTED_QUEUE';

/** Candidat en attente : le fait, son importance et son rang d'arrivée (départage déterministe). */
interface QueuedCandidate {
  readonly fact: RaceFact;
  readonly importance: number;
  readonly arrivalIndex: number;
}

/**
 * Éviction quand la file est pleine : la réplique la moins importante est jetée ; à importance
 * égale, **le candidat déjà en file gagne** (règle stable : on ne déloge jamais un fait à égalité
 * d'importance). Deux candidats de même importance dans la file sont ordonnés par ordre d'arrivée
 * croissant, donc l'ordre est total et ne dépend ni d'une `Map`, ni d'un `Set`, ni d'un tri instable.
 */
function outranks(candidate: QueuedCandidate, other: QueuedCandidate): boolean {
  if (candidate.importance !== other.importance) {
    return candidate.importance > other.importance;
  }
  return candidate.arrivalIndex < other.arrivalIndex;
}

/** Compteurs de diagnostic : jamais utilisés pour décider, seulement pour mesurer. */
export interface SpeakerStats {
  readonly fed: number;
  readonly rejectedImportance: number;
  readonly deduplicated: number;
  readonly rejectedQueue: number;
  readonly queued: number;
  readonly linesStarted: number;
  readonly preempted: number;
  readonly queuedDropped: number;
}

export class Speaker {
  private readonly policy: SpeakerPolicy;
  private readonly cooldowns: TypeCooldownTracker;
  private readonly quota: SegmentQuota;
  private readonly density: SlidingWindow;
  private readonly ledger: DedupLedger;

  /** File d'attente bornée, maintenue triée par `outranks` (jamais réordonnée par le tri du moteur). */
  private queue: QueuedCandidate[] = [];
  private pending: SpeakerDecision[] = [];
  private current: SpeakerDecision | null = null;
  /** Dernière porte refusante observée (diagnostic d'équilibrage), remise à `null` après un succès. */
  private gateVerdict: GateVerdict | null = null;
  private lastObservedS = Number.NEGATIVE_INFINITY;
  private nextArrivalIndex = 0;
  private counts = Speaker.resetCounts();

  constructor(policy: SpeakerPolicy = SPEAKER_POLICY) {
    this.policy = policy;
    this.cooldowns = new TypeCooldownTracker(policy);
    this.quota = new SegmentQuota(policy);
    this.density = new SlidingWindow(policy);
    this.ledger = new DedupLedger(policy);
  }

  private static resetCounts(): {
    fed: number;
    rejectedImportance: number;
    deduplicated: number;
    rejectedQueue: number;
    queued: number;
    linesStarted: number;
    preempted: number;
    queuedDropped: number;
  } {
    return {
      fed: 0,
      rejectedImportance: 0,
      deduplicated: 0,
      rejectedQueue: 0,
      queued: 0,
      linesStarted: 0,
      preempted: 0,
      queuedDropped: 0,
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Entrées : faits mesurés (P009-A)
  // ---------------------------------------------------------------------------------------------

  /**
   * Reçoit un fait et tente de le faire parler.
   *
   * Retourne la décision si une réplique **démarre** dans cet appel (file vidée ou préemption),
   * `null` sinon. L'instant d'observation est celui du fait (`fact.tSim`) : deux appels ne peuvent
   * pas apporter le temps réel, et une suite non monotone est refusée plutôt que devinée.
   */
  feed(fact: RaceFact): SpeakerDecision | null {
    if (fact.tSim < this.lastObservedS) {
      throw new RangeError(
        `Speaker.feed : les faits doivent arriver dans l'ordre chronologique (reçu ${fact.tSim} après ${this.lastObservedS}).`,
      );
    }
    this.lastObservedS = fact.tSim;
    this.counts.fed += 1;

    const rejection = this.admit(fact);
    if (rejection !== null) {
      return null;
    }
    return this.poll(fact.tSim);
  }

  /** Variante en lot : un seul `poll` final, les faits d'un même pas étant compatibles entre eux. */
  feedAll(facts: readonly RaceFact[]): SpeakerDecision | null {
    let decision: SpeakerDecision | null = null;
    for (const fact of facts) {
      decision = this.feed(fact);
    }
    return decision;
  }

  /** Pourquoi un fait serait refusé **avant** mise en file, ou `null` s'il est admissible. */
  private admit(fact: RaceFact): SpeakerRejection | null {
    if (!isImportantEnough(fact, this.policy.minImportance)) {
      this.counts.rejectedImportance += 1;
      return 'REJECTED_IMPORTANCE';
    }

    const fingerprint = dedupFingerprint(fact, this.policy.magnitudeBucketResolution);
    if (this.ledger.isDuplicate(fingerprint, fact.tSim)) {
      this.counts.deduplicated += 1;
      return 'DEDUPLICATED';
    }

    const candidate: QueuedCandidate = {
      fact,
      importance: fact.importance,
      arrivalIndex: this.nextArrivalIndex,
    };
    this.nextArrivalIndex += 1;

    if (this.queue.length >= this.policy.queueMax) {
      const weakest = this.weakestCandidate();
      if (weakest !== null && !outranks(candidate, weakest)) {
        this.counts.rejectedQueue += 1;
        return 'REJECTED_QUEUE';
      }
      this.removeWeakest();
      this.counts.queuedDropped += 1;
    }

    this.insert(candidate);
    this.counts.queued += 1;
    return null;
  }

  private weakestCandidate(): QueuedCandidate | null {
    let weakest: QueuedCandidate | null = null;
    for (const candidate of this.queue) {
      if (weakest === null || outranks(weakest, candidate)) {
        weakest = candidate;
      }
    }
    return weakest;
  }

  private removeWeakest(): void {
    const weakest = this.weakestCandidate();
    if (weakest === null) {
      return;
    }
    const index = this.queue.indexOf(weakest);
    if (index >= 0) {
      this.queue.splice(index, 1);
    }
  }

  /** Insertion triée : les candidats plus forts passent devant, à importance égale le premier arrivé. */
  private insert(candidate: QueuedCandidate): void {
    let index = this.queue.length;
    for (let position = 0; position < this.queue.length; position += 1) {
      const queued = this.queue[position];
      if (queued !== undefined && outranks(candidate, queued)) {
        index = position;
        break;
      }
    }
    this.queue.splice(index, 0, candidate);
  }

  // ---------------------------------------------------------------------------------------------
  // Sortie : décisions (sans texte)
  // ---------------------------------------------------------------------------------------------

  /**
   * Tente de démarrer la meilleure réplique en attente à l'instant `nowS`.
   *
   * La file est parcourue **dans l'ordre de priorité** : un candidat bloqué par son cooldown de type
   * reste en file, et un candidat moins important mais éligible peut passer — l'ordre du design est
   * respecté sans qu'un blocage ponctuel ne fige la file entière.
   *
   * Si une réplique est en cours, seuls les faits qui la **remplacent** (`INTERRUPT_DELTA`) sont
   * examinés : un fait trop faible pour couper attend son tour en file. Un candidat plus vieux que
   * `STALE_AFTER_S` est périmé : parler d'un fait vieux d'un segment entier serait faux, et il n'a
   * jamais consommé de cooldown — il est retiré, ce qui libère sa place dans la file.
   *
   * Retourne la décision si une réplique (re)démarre, `null` sinon.
   */
  poll(nowS: number): SpeakerDecision | null {
    if (nowS < this.lastObservedS) {
      throw new RangeError(
        `Speaker.poll : instant antérieur au dernier fait observé (${nowS} < ${this.lastObservedS}).`,
      );
    }
    // Les candidats périmés sortent **avant** l'observation de la file : l'état lu juste après
    // `poll` décrit donc exactement ce qui reste à dire.
    this.pruneStale(nowS);

    const candidate = this.queue[0];
    if (candidate === undefined) {
      return null;
    }
    if (this.current !== null && !this.wouldPreempt(candidate)) {
      return null;
    }
    if (this.canSpeak(candidate, nowS) !== 'ALLOWED') {
      return null;
    }
    this.gateVerdict = null;
    this.queue.shift();
    return this.start(candidate, nowS);
  }

  /** Un fait qui n'a pas été dit en un segment entier ne sera plus dit du tout. */
  private pruneStale(nowS: number): void {
    const staleFrom = nowS - STALE_AFTER_S;
    this.queue = this.queue.filter((candidate) => candidate.fact.tSim >= staleFrom);
  }

  /** Le candidat couperait-il la réplique en cours ? Règle unique : `INTERRUPT_DELTA`. */
  private wouldPreempt(candidate: QueuedCandidate): boolean {
    const current = this.current;
    if (current === null) {
      return false;
    }
    return candidate.importance >= current.importance + this.policy.interruptDelta;
  }

  /** Évaluation complète des portes pour un candidat, à l'instant `nowS`. */
  private canSpeak(candidate: QueuedCandidate, nowS: number): GateVerdict {
    const bypassGlobal = candidate.importance >= this.policy.preemptImportance;
    const verdict = evaluateGates({
      hasSegmentRoom: this.quota.hasRoom(nowS),
      typeReady: this.cooldowns.isTypeReady(candidate.fact.type, nowS),
      globalReady: this.cooldowns.isGlobalReady(nowS, bypassGlobal),
      sliding: this.density.canStart(nowS),
    });
    this.gateVerdict = verdict;
    return verdict;
  }

  /** Démarrage effectif : **seul** endroit qui consomme cooldowns, quota, fenêtre et déduplication. */
  private start(candidate: QueuedCandidate, nowS: number): SpeakerDecision {
    const decision: SpeakerDecision = Object.freeze({
      fact: candidate.fact,
      importance: candidate.importance,
      startedAtS: nowS,
    });

    this.cooldowns.record(candidate.fact.type, nowS);
    this.quota.record(nowS);
    this.density.record(nowS);
    this.ledger.record(dedupFingerprint(candidate.fact, this.policy.magnitudeBucketResolution), nowS);
    this.counts.linesStarted += 1;

    if (this.current !== null) {
      // Préemption : l'ancienne réplique est coupée et **n'est jamais rejouée** (elle a quitté la
      // file au moment où elle a démarré : aucune règle ne la remet en attente).
      this.counts.preempted += 1;
    }
    this.current = decision;
    this.pending.push(decision);
    return decision;
  }

  /**
   * Décisions produites depuis le dernier appel, dans l'ordre chronologique, puis vide le tampon.
   * Le speaker est le seul à savoir ce qui a démarré : P009-C n'a donc rien à deviner.
   */
  drain(): readonly SpeakerDecision[] {
    if (this.pending.length === 0) {
      return [];
    }
    const drained = Object.freeze(this.pending);
    this.pending = [];
    return drained;
  }

  // ---------------------------------------------------------------------------------------------
  // Cycle de vie de la réplique en cours (signalé par P009-C)
  // ---------------------------------------------------------------------------------------------

  /** Informe le speaker qu'une réplique a réellement commencé (le cas échéant, celle qu'il a produite). */
  begin(decision: SpeakerDecision): void {
    this.current = decision;
  }

  /**
   * Informe le speaker que la réplique en cours est terminée : la place est libre pour la suivante.
   * Le cooldown de la réplique terminée court depuis son **démarrage**, jamais depuis sa fin ; un
   * fait préempté n'est pas remis en file.
   */
  finish(): void {
    this.current = null;
  }

  /** Réplique courante, ou `null` : le futur affichage lit cet état, il ne le modifie pas. */
  currentDecision(): SpeakerDecision | null {
    return this.current;
  }

  /**
   * Dernière porte ayant refusé un candidat dans `poll`, ou `null` si la dernière tentative a
   * abouti. Sert au diagnostic d'équilibrage : distinguer « le speaker n'a rien à dire » de « le
   * speaker veut parler mais une règle l'en empêche » — sans exposer l'état interne de la file.
   */
  lastGateVerdict(): GateVerdict | null {
    return this.gateVerdict;
  }

  isSpeaking(): boolean {
    return this.current !== null;
  }

  // ---------------------------------------------------------------------------------------------
  // Observation (tests, futur affichage)
  // ---------------------------------------------------------------------------------------------

  stats(): SpeakerStats {
    return Object.freeze({ ...this.counts });
  }

  queuedCount(): number {
    return this.queue.length;
  }

  typeCooldownReady(type: RaceFactType, nowS: number): boolean {
    return this.cooldowns.isTypeReady(type, nowS);
  }

  globalCooldownReady(nowS: number): boolean {
    return this.cooldowns.isGlobalReady(nowS, false);
  }

  segmentIndexAt(nowS: number): number {
    return segmentIndex(this.policy, nowS);
  }

  linesInSegment(segment: number): number {
    return this.quota.countIn(segment);
  }

  totalLinesStarted(): number {
    return this.counts.linesStarted;
  }

  policyInUse(): SpeakerPolicy {
    return this.policy;
  }

  /** Repart d'une course vierge : cooldowns, file, quota, fenêtre, déduplication et tampon à zéro. */
  reset(): void {
    this.cooldowns.reset();
    this.quota.reset();
    this.density.reset();
    this.ledger.reset();
    this.queue = [];
    this.pending = [];
    this.current = null;
    this.gateVerdict = null;
    this.lastObservedS = Number.NEGATIVE_INFINITY;
    this.nextArrivalIndex = 0;
    this.counts = Speaker.resetCounts();
  }
}