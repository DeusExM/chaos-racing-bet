import { CHARACTER_IDS } from './characters';
import type { GameConfig } from './config';
import { GAME_CONFIG, RANK } from './config';
import { OvertakeTracker } from './overtakes';
import type { ActiveEvent, CharacterId, EventId, RaceFact, RaceFactType } from './types';

/**
 * Observateur de faits (P009-A) : la **seule** source des `RaceFact` de la course.
 *
 * ## Ce que ce module est, et n'est pas
 *
 * C'est un observateur **purement passif**. Il ne modifie jamais `x`, `v`, le drift, un surge, un
 * événement ni un tirage : il reçoit une photographie du noyau et rend des faits. Il ne tire aucun
 * hasard, ne lit ni le DOM, ni Phaser, ni une horloge réelle — tout est en **temps simulé** et en
 * **pas entiers**. Conséquence structurelle : appeler `drainFacts()` ou non, et le faire à n'importe
 * quelle cadence, ne peut pas changer une seule distance finale.
 *
 * ## Contrat d'entrée
 *
 * Le roster de la V1 est **fixe** : exactement les 6 `CHARACTER_IDS` officiels, dans leur ordre
 * stable. Toute autre liste — taille différente, identifiant inconnu ou ordre permuté — lève une
 * `RangeError`. Les détections indexées par personnage supposent cet ordre : le vérifier est ce qui
 * empêche d'attribuer un fait au mauvais personnage.
 *
 * Les relevés doivent former une suite **exactement consécutive** : le premier est le pas
 * `FIRST_STEP` (1), puis chaque relevé vaut le précédent plus un. Répéter un pas, revenir en arrière
 * ou **sauter** un pas lève une `RangeError` : les fenêtres glissantes comptent des pas entiers, un
 * trou fausserait silencieusement toutes les mesures.
 *
 * ## Faits et règles exactes
 *
 * * `LEADER_CHANGE` : nouveau leader **confirmé** seulement s'il conserve le rang 1 pendant
 *   `LEADER.DEBOUNCE_S` **et** mène d'au moins `LEADER.MIN_MARGIN`. Le fait tombe au pas de
 *   confirmation, jamais au premier échange de rang. L'importance est
 *   `45 + min(25, secondes de règne du précédent)` ; le premier leader (celui du premier relevé) est
 *   en place sans fait et son règne est compté depuis `tSim = 0`.
 * * `BIG_COMEBACK` : gain d'au moins `FACT.BIG_COMEBACK_PLACES` places en au plus
 *   `FACT.BIG_COMEBACK_WINDOW_S`. Le gain est le **meilleur rang occupé dans la fenêtre** moins le
 *   rang courant.
 * * `OVERTAKE_STREAK` : au moins `FACT.OVERTAKE_STREAK_MIN` dépassements du **même** personnage en au
 *   plus `FACT.OVERTAKE_STREAK_WINDOW_S`. Les dépassements viennent exclusivement d'un
 *   `OvertakeTracker` alimenté **à chaque pas simulé** : jamais d'une comparaison occasionnelle de
 *   classements.
 * * `BIG_BONUS` / `LEADER_MALUS` : au pas où **commence** réellement un événement (`TURBO`,
 *   `MEGA_TURBO`, `RACCOURCI` pour le bonus ; `CHUTE`, `SIESTE`, `VENT_DE_FACE` pour le malus, et
 *   seulement si la cible était leader au moment du tirage). Le rang utilisé est celui du relevé
 *   **précédent** : l'événement est tiré au tout début du pas courant, donc le leader à cet instant
 *   est celui d'avant l'intégration du pas — jamais un rang observé quelques pas plus tard.
 * * `CLOSE_RACE` : écart P1–P3 ≤ 15 m pendant ≥ 5 s **consécutives**. Un seul fait par entrée dans
 *   l'état : il faut sortir (écart > 15 m) puis rester 5 s de nouveau sous le seuil pour réémettre.
 * * `LAST_COMEBACK` : le personnage passé dernier dans les 30 s atteint la 3e place ou mieux, **ou**
 *   gagne au moins 4 places en ≤ 30 s.
 * * `CHECKPOINT_SPLIT` : aux instants 45, 90 et 135 s, avec le classement et les distances du moment,
 *   et l'importance `38` augmentée de `+20` si un `LEADER_CHANGE` a été confirmé depuis le checkpoint
 *   précédent, `+10` si l'écart P1–P2 est inférieur à 20 m.
 * * `FINISH` / `PHOTO_FINISH` : à `tSim = 180 s`, exactement l'un des deux — `PHOTO_FINISH` si
 *   l'écart P1–P2 est strictement inférieur à 5 m.
 *
 * ## Un fait par épisode, jamais un par pas
 *
 * Chaque détection à fenêtre (`BIG_COMEBACK`, `OVERTAKE_STREAK`, `LAST_COMEBACK`) porte un **verrou de
 * front montant** : le fait n'est émis que lorsque la condition devient vraie, puis plus rien tant
 * qu'elle le reste. Réarmer exige qu'elle redevienne fausse. Les conditions déjà vraies au premier
 * relevé n'émettent rien : la référence est initialisée, seules les transitions **mesurées ensuite**
 * produisent un fait. `CLOSE_RACE` fait exception par nature : il compte dès le premier pas, et émet
 * à 5 s pleines.
 *
 * ## Mémoire : bornée, explicite, constante
 *
 * Aucun état complet des 6 personnages n'est conservé. Les fenêtres longues (10 s et 30 s) sont
 * représentées de façon compacte : pour chaque personnage et chaque rang possible (1 à 6), un unique
 * **horodatage du dernier pas où ce rang a été occupé**. « Le meilleur rang de la fenêtre » se lit
 * donc en au plus `CHARACTER_COUNT` comparaisons, et le fait qu'un personnage ait été dernier dans les
 * 30 s est une simple lecture.
 *
 * Contenu exact de la mémoire interne :
 *
 * | Structure | Taille maximale | Fenêtre |
 * | --- | --- | --- |
 * | `rankLastStep` | `6 × 6 = 36` entiers | 10 s / 30 s |
 * | `overtakeRing` | `300 × 6 = 1800` entiers | 5 s |
 * | compteurs et verrous | `6` chacun | — |
 * | `OvertakeTracker` | `15` entiers | — |
 *
 * Aucune de ces tailles ne dépend du nombre de pas déjà joués : la mémoire est **constante** sur une
 * course entière comme sur mille courses enchaînées après `reset()`.
 */

/** Roster officiel de la V1 : l'observateur n'est pas générique, et c'est volontaire. */
const CHARACTER_COUNT = CHARACTER_IDS.length;

/** Clés techniques des textes. Le noyau ne contient **aucun** texte visible. */
const TEXT_KEYS: Readonly<Record<RaceFactType, string>> = Object.freeze({
  LEADER_CHANGE: 'fact.leaderChange',
  BIG_COMEBACK: 'fact.bigComeback',
  OVERTAKE_STREAK: 'fact.overtakeStreak',
  BIG_BONUS: 'fact.bigBonus',
  LEADER_MALUS: 'fact.leaderMalus',
  CLOSE_RACE: 'fact.closeRace',
  LAST_COMEBACK: 'fact.lastComeback',
  CHECKPOINT_SPLIT: 'fact.checkpointSplit',
  FINISH: 'fact.finish',
  PHOTO_FINISH: 'fact.photoFinish',
});

/** Événements qui déclenchent `BIG_BONUS` (`GAME_DESIGN.md` §9.2). */
const BONUS_EVENTS: readonly EventId[] = Object.freeze(['TURBO', 'MEGA_TURBO', 'RACCOURCI']);

/** Événements qui déclenchent `LEADER_MALUS` lorsque leur cible mène (`GAME_DESIGN.md` §9.2). */
const MALUS_EVENTS: readonly EventId[] = Object.freeze(['CHUTE', 'SIESTE', 'VENT_DE_FACE']);

/** Personnage tel que l'observateur le voit : rien de plus que ce dont il a besoin. */
export interface ObservedCharacter {
  readonly id: CharacterId;
  readonly x: number;
  readonly activeEvent: ActiveEvent | null;
}

/** Photographie d'un pas, transmise par le noyau (ou fabriquée à la main dans les tests). */
export interface ObservationInput {
  /** Instant simulé du pas observé, en secondes. */
  readonly tSim: number;
  /** Numéro du pas observé, en base 1. Les fenêtres sont comptées en pas entiers. */
  readonly steps: number;
  /** Les 6 personnages officiels, dans leur ordre stable. */
  readonly characters: readonly ObservedCharacter[];
}

/**
 * Premier pas observé. Le noyau appelle l'observateur après l'intégration du pas, donc à partir du
 * pas 1 ; aucun relevé antérieur (départ, pas 0) ne lui est transmis.
 */
const FIRST_STEP = 1;

/** Convertit une durée de jeu en pas : unique endroit où le temps continu devient discret. */
function stepsForSeconds(seconds: number, config: GameConfig): number {
  return Math.round(seconds / config.RACE.DT_S);
}

export class RaceObserver {
  private readonly config: GameConfig;

  /** Détecteur de dépassements à hystérésis, alimenté à **chaque** pas simulé. */
  private readonly tracker = new OvertakeTracker();

  /**
   * Pour chaque personnage et chaque rang de 1 à `CHARACTER_COUNT`, le dernier pas où ce rang a été
   * occupé (`-1` si jamais). Suffit à répondre à « meilleur rang des 10 / 30 dernières secondes ».
   */
  private readonly rankLastStep = new Int32Array(CHARACTER_COUNT * CHARACTER_COUNT).fill(-1);

  /** Rang courant de chaque personnage, aligné sur le roster. */
  private readonly ranks = new Int32Array(CHARACTER_COUNT);

  /** Rang du relevé précédent : c'est le rang **au moment du tirage** d'un événement. */
  private readonly previousRanks = new Int32Array(CHARACTER_COUNT);

  /** Distances du pas courant, réutilisées pour ne rien allouer dans la boucle. */
  private readonly distances: number[] = new Array<number>(CHARACTER_COUNT).fill(0);

  /** Classement du pas courant (index de roster, du 1er au dernier), réutilisé à chaque pas. */
  private readonly order = new Int32Array(CHARACTER_COUNT);

  /** Dépassements par personnage et par pas sur la fenêtre de streak, et totaux glissants. */
  private readonly overtakeRing: Int32Array;
  private readonly overtakeTotals = new Int32Array(CHARACTER_COUNT);
  private ringCursor = 0;

  /** Verrous de front montant : un fait par épisode, jamais un par pas. */
  private readonly comebackLatch = new Uint8Array(CHARACTER_COUNT);
  private readonly lastComebackLatch = new Uint8Array(CHARACTER_COUNT);
  private readonly streakLatch = new Uint8Array(CHARACTER_COUNT);

  /** Dernier couple `(événement, instant de début)` vu par personnage : détecte un vrai début. */
  private readonly previousEventId: (EventId | null)[] = new Array<EventId | null>(
    CHARACTER_COUNT,
  ).fill(null);
  private readonly previousEventStart: number[] = new Array<number>(CHARACTER_COUNT).fill(0);

  /** `CLOSE_RACE` : pas consécutifs sous le seuil, et verrou d'état (une émission par entrée). */
  private closeRaceSteps = 0;
  private closeRaceActive = false;

  /** Leader confirmé et règne courant, puis candidat en cours de debounce. */
  private leaderIndex = -1;
  private leaderSinceStep = 0;
  private candidateIndex = -1;
  private candidateSinceStep = 0;
  private leaderChanges = 0;
  private leaderChangesAtLastCheckpoint = 0;

  /** Bornes en pas entiers, pré-calculées une fois : aucune conversion dans la boucle. */
  private readonly leaderDebounceSteps: number;
  private readonly streakWindowSteps: number;
  private readonly bigComebackWindowSteps: number;
  private readonly lastComebackWindowSteps: number;
  private readonly closeRaceStepsMin: number;

  private firstSnapshot = true;
  private arrivalEmitted = false;
  private lastSteps = -1;

  constructor(config: GameConfig = GAME_CONFIG) {
    this.config = config;
    this.leaderDebounceSteps = stepsForSeconds(config.LEADER.DEBOUNCE_S, config);
    this.streakWindowSteps = Math.max(1, stepsForSeconds(config.FACT.OVERTAKE_STREAK_WINDOW_S, config));
    this.bigComebackWindowSteps = stepsForSeconds(config.FACT.BIG_COMEBACK_WINDOW_S, config);
    this.lastComebackWindowSteps = stepsForSeconds(config.FACT.LAST_COMEBACK_WINDOW_S, config);
    this.closeRaceStepsMin = Math.max(
      1,
      stepsForSeconds(config.FACT.CLOSE_RACE_MIN_DURATION_S, config),
    );
    this.overtakeRing = new Int32Array(this.streakWindowSteps * CHARACTER_COUNT);
  }

  /**
   * Observe un pas et renvoie les faits **nouveaux** de ce pas, dans l'ordre du design.
   *
   * L'appelant doit fournir les pas dans l'ordre, sans trou ni retour en arrière : une observation
   * non croissante lève une `RangeError`, car elle corromprait les fenêtres glissantes.
   */
  observe(input: ObservationInput): readonly RaceFact[] {
    this.requireInput(input);

    const { tSim, steps, characters } = input;
    const xs = this.distances;
    for (let index = 0; index < CHARACTER_COUNT; index += 1) {
      xs[index] = this.xAt(characters, index);
    }

    const order = this.updateRanks(xs, steps);

    const facts: RaceFact[] = [];

    // Le rang du pas courant est horodaté **avant** les détections : une fenêtre qui contient le rang
    // courant ne peut que réduire un gain mesuré, jamais l'inventer.
    if (this.firstSnapshot) {
      // Référence initiale : le leader du premier relevé est en place, sans fait (aucune variation).
      this.leaderIndex = order[0] ?? 0;
      this.leaderSinceStep = 0;
      this.candidateIndex = -1;
    } else {
      this.detectLeaderChange(facts, tSim, steps, xs);
      this.detectBigComeback(facts, tSim, steps);
    }

    this.detectOvertakeStreak(facts, tSim, xs);
    this.detectEventFacts(facts, tSim, characters);
    this.detectCloseRace(facts, tSim, xs);

    if (!this.firstSnapshot) {
      this.detectLastComeback(facts, tSim, steps);
    }

    this.recordCheckpointSplit(facts, tSim, steps, xs);
    this.recordArrival(facts, tSim, steps, xs);

    this.previousRanks.set(this.ranks);
    for (let index = 0; index < CHARACTER_COUNT; index += 1) {
      const event = characters[index]?.activeEvent ?? null;
      this.previousEventId[index] = event === null ? null : event.id;
      this.previousEventStart[index] = event === null ? 0 : event.startSimS;
    }
    this.firstSnapshot = false;
    this.lastSteps = steps;

    return facts;
  }

  /** Repart d'une course neuve : aucune fenêtre, aucun verrou, aucun leader, aucun fait. */
  reset(): void {
    this.tracker.reset();
    this.rankLastStep.fill(-1);
    this.ranks.fill(0);
    this.previousRanks.fill(0);
    this.overtakeRing.fill(0);
    this.overtakeTotals.fill(0);
    this.ringCursor = 0;
    this.comebackLatch.fill(0);
    this.lastComebackLatch.fill(0);
    this.streakLatch.fill(0);
    for (let index = 0; index < CHARACTER_COUNT; index += 1) {
      this.previousEventId[index] = null;
      this.previousEventStart[index] = 0;
    }
    this.closeRaceSteps = 0;
    this.closeRaceActive = false;
    this.leaderIndex = -1;
    this.leaderSinceStep = 0;
    this.candidateIndex = -1;
    this.candidateSinceStep = 0;
    this.leaderChanges = 0;
    this.leaderChangesAtLastCheckpoint = 0;
    this.firstSnapshot = true;
    this.arrivalEmitted = false;
    this.lastSteps = -1;
  }

  /**
   * `LEADER_CHANGE` : confirmation après `LEADER.DEBOUNCE_S` de rang 1 et `LEADER.MIN_MARGIN` d'avance.
   *
   * Un simple échange de rang ne suffit donc jamais, et le fait porte le **moment de confirmation** :
   * c'est ce qui distingue un vrai changement de leader d'une oscillation à quelques centimètres.
   */
  private detectLeaderChange(
    facts: RaceFact[],
    tSim: number,
    steps: number,
    xs: readonly number[],
  ): void {
    const leaderIndex = this.rankIndexAt(0);
    const secondIndex = this.rankIndexAt(1);

    if (leaderIndex === this.leaderIndex) {
      this.candidateIndex = -1;
      return;
    }

    if (this.candidateIndex !== leaderIndex) {
      this.candidateIndex = leaderIndex;
      this.candidateSinceStep = steps;
    }

    const heldSteps = steps - this.candidateSinceStep;
    const margin = this.valueAt(xs, leaderIndex) - this.valueAt(xs, secondIndex);
    if (heldSteps < this.leaderDebounceSteps || margin < this.config.LEADER.MIN_MARGIN) {
      return;
    }

    // Règne du précédent : de sa confirmation — ou du départ pour le tout premier — à celle-ci.
    const reignS = (steps - this.leaderSinceStep) * this.config.RACE.DT_S;
    const importance =
      this.config.FACT.LEADER_CHANGE_IMPORTANCE +
      Math.min(this.config.FACT.LEADER_CHANGE_MAX_REIGN_BONUS, reignS);
    const previousIndex = this.leaderIndex;

    facts.push(
      this.buildFact(
        'LEADER_CHANGE',
        tSim,
        [this.idAt(leaderIndex), this.idAt(previousIndex)],
        [margin, reignS],
        importance,
      ),
    );

    this.leaderIndex = leaderIndex;
    this.leaderSinceStep = steps;
    this.candidateIndex = -1;
    this.leaderChanges += 1;
  }

  /** `BIG_COMEBACK` : au moins 3 places gagnées en 10 s, mesurées sur la fenêtre de rangs. */
  private detectBigComeback(facts: RaceFact[], tSim: number, steps: number): void {
    const { BIG_COMEBACK_PLACES, BIG_COMEBACK_BONUS_PER_PLACE, BIG_COMEBACK_IMPORTANCE } = this.config.FACT;

    for (let index = 0; index < CHARACTER_COUNT; index += 1) {
      const rank = this.rankAt(index);
      const gain = this.worstRankWithin(index, this.bigComebackWindowSteps, steps) - rank;

      if (gain < BIG_COMEBACK_PLACES) {
        this.comebackLatch[index] = 0;
        continue;
      }
      if (this.comebackLatch[index] === 1) {
        continue;
      }

      this.comebackLatch[index] = 1;
      const bonus = BIG_COMEBACK_BONUS_PER_PLACE * (gain - BIG_COMEBACK_PLACES);
      facts.push(
        this.buildFact(
          'BIG_COMEBACK',
          tSim,
          [this.idAt(index)],
          [gain, rank],
          BIG_COMEBACK_IMPORTANCE + bonus,
        ),
      );
    }
  }

  /**
   * `OVERTAKE_STREAK` : au moins 3 dépassements du même personnage en 5 s.
   *
   * Le comptage est exact et glissant : l'anneau de compteurs par pas est mis à jour à chaque pas, ce
   * qui donne le total de la fenêtre en temps constant, sans jamais recompter l'historique.
   */
  private detectOvertakeStreak(facts: RaceFact[], tSim: number, xs: readonly number[]): void {
    const { OVERTAKE_STREAK_MIN, OVERTAKE_STREAK_BONUS_PER_OVERTAKE, OVERTAKE_STREAK_IMPORTANCE } =
      this.config.FACT;

    const overtakes = this.tracker.observe(xs, CHARACTER_IDS);

    // Le pas qui sort de la fenêtre est retiré avant d'ajouter le pas courant.
    const base = this.ringCursor * CHARACTER_COUNT;
    for (let index = 0; index < CHARACTER_COUNT; index += 1) {
      const slot = base + index;
      this.overtakeTotals[index] = this.countAt(this.overtakeTotals, index) - this.countAt(this.overtakeRing, slot);
      this.overtakeRing[slot] = 0;
    }
    for (const overtake of overtakes) {
      const index = CHARACTER_IDS.indexOf(overtake.overtaker);
      if (index < 0) {
        throw new RangeError(`Dépassement attribué à un personnage hors roster : « ${overtake.overtaker} ».`);
      }
      const slot = base + index;
      this.overtakeRing[slot] = this.countAt(this.overtakeRing, slot) + 1;
      this.overtakeTotals[index] = this.countAt(this.overtakeTotals, index) + 1;
    }
    this.ringCursor = (this.ringCursor + 1) % this.streakWindowSteps;

    for (let index = 0; index < CHARACTER_COUNT; index += 1) {
      const count = this.countAt(this.overtakeTotals, index);
      if (count < OVERTAKE_STREAK_MIN) {
        this.streakLatch[index] = 0;
        continue;
      }
      if (this.streakLatch[index] === 1) {
        continue;
      }

      this.streakLatch[index] = 1;
      const bonus = OVERTAKE_STREAK_BONUS_PER_OVERTAKE * (count - OVERTAKE_STREAK_MIN);
      facts.push(
        this.buildFact(
          'OVERTAKE_STREAK',
          tSim,
          [this.idAt(index)],
          [count],
          OVERTAKE_STREAK_IMPORTANCE + bonus,
        ),
      );
    }
  }

  /**
   * `BIG_BONUS` et `LEADER_MALUS` : au pas où un événement **commence** réellement.
   *
   * Un début est détecté par le couple `(identifiant, instant de début)`, jamais par une comparaison
   * de magnitude : un événement qui se prolonge ne redéclenche donc rien, et un nouvel événement du
   * même type est bien vu comme un nouveau début.
   */
  private detectEventFacts(
    facts: RaceFact[],
    tSim: number,
    characters: readonly ObservedCharacter[],
  ): void {
    for (let index = 0; index < CHARACTER_COUNT; index += 1) {
      const event = characters[index]?.activeEvent ?? null;
      if (event === null) {
        continue;
      }

      const started =
        this.previousEventId[index] !== event.id ||
        this.previousEventStart[index] !== event.startSimS;
      if (!started) {
        continue;
      }

      // Rang **au moment du tirage** : l'événement est décidé au tout début du pas courant, donc le
      // leader de cet instant est celui du relevé précédent. Au premier relevé, il n'y a pas d'avant.
      const rank = this.firstSnapshot ? this.rankAt(index) : this.previousRankAt(index);

      if (BONUS_EVENTS.includes(event.id)) {
        let bonus = 0;
        if (rank === 1) {
          bonus += this.config.FACT.BIG_BONUS_LEADER_BONUS;
        }
        if (rank === CHARACTER_COUNT) {
          bonus += this.config.FACT.BIG_BONUS_LAST_BONUS;
        }
        facts.push(
          this.buildFact(
            'BIG_BONUS',
            tSim,
            [this.idAt(index)],
            [event.magnitude, event.durationS, rank],
            this.config.FACT.BIG_BONUS_IMPORTANCE + bonus,
          ),
        );
      } else if (MALUS_EVENTS.includes(event.id) && rank === 1) {
        const bonus = event.id === 'SIESTE' ? this.config.FACT.LEADER_MALUS_SIESTE_BONUS : 0;
        facts.push(
          this.buildFact(
            'LEADER_MALUS',
            tSim,
            [this.idAt(index)],
            [event.magnitude, event.durationS, rank],
            this.config.FACT.LEADER_MALUS_IMPORTANCE + bonus,
          ),
        );
      }
    }
  }

  /**
   * `CLOSE_RACE` : P1–P3 à 15 m ou moins pendant 5 s consécutives, une émission par entrée dans l'état.
   *
   * Le compteur démarre dès le premier pas ; sortir de l'état (écart > 15 m) le remet à zéro et
   * réarme l'émission.
   */
  private detectCloseRace(
    facts: RaceFact[],
    tSim: number,
    xs: readonly number[],
  ): void {
    const leaderIndex = this.rankIndexAt(0);
    const thirdIndex = this.rankIndexAt(2);
    const gap = this.valueAt(xs, leaderIndex) - this.valueAt(xs, thirdIndex);

    if (gap > this.config.FACT.CLOSE_RACE_MAX_GAP_M) {
      this.closeRaceSteps = 0;
      this.closeRaceActive = false;
      return;
    }

    this.closeRaceSteps += 1;
    if (this.closeRaceActive || this.closeRaceSteps < this.closeRaceStepsMin) {
      return;
    }

    this.closeRaceActive = true;
    const durationS = this.closeRaceSteps * this.config.RACE.DT_S;
    facts.push(
      this.buildFact(
        'CLOSE_RACE',
        tSim,
        [this.idAt(leaderIndex), this.idAt(thirdIndex)],
        [gap, durationS],
        this.config.FACT.CLOSE_RACE_IMPORTANCE,
      ),
    );
  }

  /**
   * `LAST_COMEBACK` : dernier dans les 30 s, puis 3e ou mieux — ou 4 places gagnées en 30 s.
   *
   * Les deux branches sont mesurées sur la même fenêtre bornée de 30 s : au-delà, aucun fait n'est
   * émis, ce qui évite aussi bien une recherche infinie qu'un fait « historique » sans cause proche.
   */
  private detectLastComeback(facts: RaceFact[], tSim: number, steps: number): void {
    const { LAST_COMEBACK_RANK, LAST_COMEBACK_PLACES, LAST_COMEBACK_IMPORTANCE } = this.config.FACT;

    for (let index = 0; index < CHARACTER_COUNT; index += 1) {
      const rank = this.rankAt(index);
      const worst = this.worstRankWithin(index, this.lastComebackWindowSteps, steps);
      const gain = worst - rank;
      const cameFromLast = worst === CHARACTER_COUNT && rank <= LAST_COMEBACK_RANK;

      if (!cameFromLast && gain < LAST_COMEBACK_PLACES) {
        this.lastComebackLatch[index] = 0;
        continue;
      }
      if (this.lastComebackLatch[index] === 1) {
        continue;
      }

      this.lastComebackLatch[index] = 1;
      facts.push(
        this.buildFact(
          'LAST_COMEBACK',
          tSim,
          [this.idAt(index)],
          [gain, rank],
          LAST_COMEBACK_IMPORTANCE,
        ),
      );
    }
  }

  /**
   * `CHECKPOINT_SPLIT` : aux bornes internes de 45, 90 et 135 s.
   *
   * Le fait est produit **ici et nulle part ailleurs** : il n'existe pas de seconde source. Les
   * distances publiées sont celles du pas qui atteint la borne, sans décalage.
   */
  private recordCheckpointSplit(
    facts: RaceFact[],
    tSim: number,
    steps: number,
    xs: readonly number[],
  ): void {
    const { STEPS_PER_SEGMENT, SEGMENT_COUNT } = this.config.RACE;
    if (steps <= 0 || steps % STEPS_PER_SEGMENT !== 0) {
      return;
    }

    const checkpoint = steps / STEPS_PER_SEGMENT;
    if (checkpoint >= SEGMENT_COUNT) {
      return;
    }

    const characterIds: CharacterId[] = [];
    const distances: number[] = [];
    for (let position = 0; position < CHARACTER_COUNT; position += 1) {
      const index = this.rankIndexAt(position);
      characterIds.push(this.idAt(index));
      distances.push(this.valueAt(xs, index));
    }

    const gap = this.valueAt(xs, this.rankIndexAt(0)) - this.valueAt(xs, this.rankIndexAt(1));
    const leaderChanged = this.leaderChanges > this.leaderChangesAtLastCheckpoint;
    this.leaderChangesAtLastCheckpoint = this.leaderChanges;

    const importance =
      this.config.FACT.CHECKPOINT_SPLIT_IMPORTANCE +
      (leaderChanged ? this.config.FACT.CHECKPOINT_SPLIT_LEADER_CHANGE_BONUS : 0) +
      (gap < this.config.FACT.CHECKPOINT_SPLIT_CLOSE_GAP_M
        ? this.config.FACT.CHECKPOINT_SPLIT_CLOSE_BONUS
        : 0);

    facts.push(this.buildFact('CHECKPOINT_SPLIT', tSim, characterIds, distances, importance));
  }

  /**
   * `FINISH` ou `PHOTO_FINISH` : à `tSim = 180 s`, **exactement** l'un des deux.
   *
   * `PHOTO_FINISH` remplace `FINISH` lorsque l'écart P1–P2 est strictement inférieur à 5 m. Un verrou
   * rend l'émission unique, même si l'observateur était alimenté après la fin de course.
   */
  private recordArrival(
    facts: RaceFact[],
    tSim: number,
    steps: number,
    xs: readonly number[],
  ): void {
    if (this.arrivalEmitted || steps < this.config.RACE.TOTAL_STEPS) {
      return;
    }
    this.arrivalEmitted = true;

    const leaderIndex = this.rankIndexAt(0);
    const secondIndex = this.rankIndexAt(1);
    const leaderDistance = this.valueAt(xs, leaderIndex);
    const secondDistance = this.valueAt(xs, secondIndex);
    const gap = leaderDistance - secondDistance;
    const photo = gap < this.config.FACT.PHOTO_ARRIVAL_MAX_GAP_M;

    facts.push(
      this.buildFact(
        photo ? 'PHOTO_FINISH' : 'FINISH',
        tSim,
        [this.idAt(leaderIndex), this.idAt(secondIndex)],
        [gap, leaderDistance, secondDistance],
        photo ? this.config.FACT.PHOTO_ARRIVAL_IMPORTANCE : this.config.FACT.ARRIVAL_IMPORTANCE,
      ),
    );
  }

  /**
   * Classe le pas courant et horodate le rang occupé par chaque personnage.
   *
   * L'observateur est appelé à **chaque** pas : le tri par insertion sur 6 éléments évite les
   * allocations d'un tri générique (`ranking.ts`), tout en appliquant exactement la même règle —
   * distance décroissante, égalité départagée selon `RANK.TIE_BREAK`. Le `switch` exhaustif ci-dessous
   * garantit à la compilation qu'une nouvelle politique de départage ne peut pas être oubliée ici.
   */
  private updateRanks(xs: readonly number[], steps: number): Int32Array {
    const order = this.order;
    for (let index = 0; index < CHARACTER_COUNT; index += 1) {
      order[index] = index;
    }

    for (let i = 1; i < CHARACTER_COUNT; i += 1) {
      const current = this.rankIndexAt(i);
      let j = i - 1;
      while (j >= 0) {
        const previous = this.rankIndexAt(j);
        if (this.precedes(previous, current, xs)) {
          break;
        }
        order[j + 1] = previous;
        j -= 1;
      }
      order[j + 1] = current;
    }

    for (let position = 0; position < CHARACTER_COUNT; position += 1) {
      const index = this.rankIndexAt(position);
      this.ranks[index] = position + 1;
      this.rankLastStep[index * CHARACTER_COUNT + position] = steps;
    }

    return order;
  }

  /** `true` si `first` devance `second` : distance décroissante, puis politique `RANK.TIE_BREAK`. */
  private precedes(first: number, second: number, xs: readonly number[]): boolean {
    const firstX = this.valueAt(xs, first);
    const secondX = this.valueAt(xs, second);
    if (firstX !== secondX) {
      return firstX > secondX;
    }
    switch (RANK.TIE_BREAK) {
      case 'ascendingId':
        // Les identifiants officiels sont dans l'ordre croissant : comparer les index revient à
        // comparer les identifiants, sans allocation ni comparaison de chaînes.
        return first < second;
    }
  }

  /**
   * Meilleur rang occupé par un personnage dans les `windowSteps` derniers pas, ou `0` si aucun rang
   * n'y a été observé (tout début de course).
   */
  private worstRankWithin(index: number, windowSteps: number, steps: number): number {
    for (let rank = CHARACTER_COUNT; rank >= 1; rank -= 1) {
      const last = this.rankLastStep[index * CHARACTER_COUNT + (rank - 1)];
      if (last !== undefined && last >= 0 && steps - last <= windowSteps) {
        return rank;
      }
    }
    return 0;
  }

  private rankAt(index: number): number {
    return this.ranks[index] ?? CHARACTER_COUNT;
  }

  private previousRankAt(index: number): number {
    return this.previousRanks[index] ?? CHARACTER_COUNT;
  }

  /** Index de roster en position `position` du classement ; refuse un classement incomplet. */
  private rankIndexAt(position: number): number {
    const index = this.order[position];
    if (index === undefined) {
      throw new RangeError(`Classement incomplet : aucune position ${position}.`);
    }
    return index;
  }

  private valueAt(values: readonly number[], index: number): number {
    const value = values[index];
    if (value === undefined) {
      throw new RangeError(`Valeur manquante à l'index ${index}.`);
    }
    return value;
  }

  private countAt(counts: Int32Array, index: number): number {
    return counts[index] ?? 0;
  }

  private xAt(characters: readonly ObservedCharacter[], index: number): number {
    const character = characters[index];
    if (character === undefined) {
      throw new RangeError(`Aucun personnage pour l'index ${index}.`);
    }
    return character.x;
  }

  private idAt(index: number): CharacterId {
    const id = CHARACTER_IDS[index];
    if (id === undefined) {
      throw new RangeError(`Aucun personnage officiel pour l'index ${index}.`);
    }
    return id;
  }

  private buildFact(
    type: RaceFactType,
    tSim: number,
    characterIds: readonly CharacterId[],
    magnitudes: readonly number[],
    importance: number,
  ): RaceFact {
    return Object.freeze({
      type,
      tSim,
      characterIds: Object.freeze([...characterIds]),
      magnitudes: Object.freeze([...magnitudes]),
      importance,
      textKey: TEXT_KEYS[type],
    });
  }

  /**
   * Vérifie le contrat d'entrée : roster officiel exact, dans l'ordre, distances finies, et suite de
   * pas **exactement** consécutive — le premier relevé est le pas 1, puis chaque relevé vaut le
   * précédent plus un. Une répétition, un retour en arrière ou un saut corromprait silencieusement
   * les fenêtres glissantes : les trois cas sont refusés.
   */
  private requireInput(input: ObservationInput): void {
    if (!Number.isFinite(input.tSim) || input.tSim < 0) {
      throw new RangeError(`tSim doit être un temps simulé fini et positif ou nul (reçu : ${input.tSim}).`);
    }
    if (!Number.isInteger(input.steps)) {
      throw new RangeError(`Le numéro de pas doit être un entier (reçu : ${input.steps}).`);
    }
    if (this.lastSteps < 0) {
      if (input.steps !== FIRST_STEP) {
        throw new RangeError(
          `La première observation doit être le pas ${FIRST_STEP} (reçu : ${input.steps}).`,
        );
      }
    } else if (input.steps !== this.lastSteps + 1) {
      throw new RangeError(
        `Les observations doivent être des pas consécutifs : ${this.lastSteps + 1} attendu après le pas ${this.lastSteps} (reçu : ${input.steps}).`,
      );
    }
    if (input.characters.length !== CHARACTER_COUNT) {
      throw new RangeError(
        `L'observateur exige exactement ${CHARACTER_COUNT} personnages (reçu : ${input.characters.length}).`,
      );
    }

    for (let index = 0; index < CHARACTER_COUNT; index += 1) {
      const character = input.characters[index];
      const expected = CHARACTER_IDS[index];
      if (character === undefined) {
        throw new RangeError(`Aucun personnage pour l'index ${index}.`);
      }
      if (character.id !== expected) {
        throw new RangeError(
          `L'observateur exige les identifiants officiels dans leur ordre stable : « ${expected} » attendu en position ${index}, « ${character.id} » reçu.`,
        );
      }
      if (!Number.isFinite(character.x)) {
        throw new RangeError(`x[${index}] doit être une distance finie (reçu : ${character.x}).`);
      }
    }
  }
}
