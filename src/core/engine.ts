import type { GameConfig } from './config';
import { GAME_CONFIG, SQRT_DT, validateConfig } from './config';
import type { EventDefinition, EventParams, EventPlanState } from './events';
import { EVENT_CATALOG, activeEventAt, createEventPlan, eventParams, stepEvents } from './events';
import { gaussianFrom, stepOrnsteinUhlenbeck } from './math';
import type { OrnsteinUhlenbeckParams } from './math';
import { RaceObserver } from './observer';
import { DEFAULT_PARTICIPANTS, normalizeParticipants, selectParticipants } from './participants';
import { sortByRank } from './ranking';
import type { RngStream } from './rng';
import { forkStream } from './rng';
import { normalizeSeed } from './seed';
import { computeTargetSpeed, integratePosition, integrateSpeed, lateFormFactor } from './speedModel';
import type { SurgeParams, SurgeState, SurgeStepRange } from './surges';
import { createSurgeState, intervalStepRangeForMean, stepSurge, surgeParams } from './surges';
import { segmentElapsedS, segmentIndexAt } from './track';
import type {
  CharacterId,
  CharacterState,
  RaceFact,
  RacePhase,
  RaceResult,
  RaceState,
} from './types';

/**
 * `RaceEngine` — le noyau déterministe de la course.
 *
 * **Ce que le moteur connaît** : un pas fixe `DT_S`, un temps **simulé** `tSim`, un compteur de pas,
 * et six positions. **Ce qu'il ignore totalement** : l'horloge réelle, le framerate, un compte à
 * rebours, une durée de pause, un `timeScale`. Il n'a donc aucune notion de pause : une pause réelle
 * consiste, pour `RaceSimulation`, à ne plus appeler `step()`, et le noyau ne s'en aperçoit pas.
 *
 * **Reproductibilité** : `(seed, config)` produit une course identique bit à bit, sur n'importe quel
 * appareil et n'importe quel moteur JavaScript. Aucun tirage ambiant, aucune horloge, aucune
 * fonction transcendante, aucun `Map`/`Set` dans l'ordre physique : l'ordre des personnages est
 * celui, stable, de `CHARACTER_IDS`, et chaque personnage a son propre flux aléatoire nommé.
 *
 * **P004 est une course minimale** : vitesse de base, dérive d'Ornstein–Uhlenbeck indépendante,
 * rampe progressive, intégration de position.
 *
 * **P006 ajoute les checkpoints**, et rien d'autre : le moteur **signale** les instants `tSim = 20`
 * et `40 s` par un fait `CHECKPOINT_SPLIT`, puis **continue**. Il ne s'arrête pas, ne connaît
 * aucune durée de pause et ignore qu'une pause existe : ce qui se passe après le signal appartient
 * entièrement à `RaceSimulation`.
 *
 * **P007 ajoute les surges** : de petites accélérations et ralentissements temporaires, tirés par le
 * planning de `surges.ts` sur un flux `surge:<charId>` distinct de `drift:<charId>`. Le moteur leur
 * fournit une seule chose — le numéro du pas courant — et reçoit une magnitude relative qu'il publie
 * dans `CharacterState.surge`. Aucun surge n'écrit jamais dans `x` : il module la vitesse **cible**,
 * qui passe ensuite par la rampe et par l'écrêtage, comme n'importe quelle autre variation.
 *
 * **P008 ajoute les événements rares** : le planificateur de `events.ts` décide, sur le flux
 * `events:global`, qui subit quel événement du catalogue §7.1, pendant combien de pas, et avec quelle
 * magnitude. Le moteur publie le résultat dans `CharacterState.eventBonus` / `activeEvent` et
 * l'ajoute à la vitesse cible — jamais à `x`. Les événements du pas sont décidés **avant** la boucle
 * des personnages, si bien que le personnage ciblé subit déjà l'événement au pas de son déclenchement.
 *
 * **P009-A ajoute l'observateur de faits** (`observer.ts`) : après chaque pas, le moteur lui transmet
 * une photographie — `tSim`, numéro de pas, personnages — et verse dans son tampon les faits qu'elle
 * rend. L'observateur est **purement passif** : il ne consomme aucun flux aléatoire, n'écrit ni `x`
 * ni `v`, et ne décide jamais de la course. C'est cet observateur, et lui seul, qui produit les
 * `CHECKPOINT_SPLIT` depuis P009-A : il n'existe pas deux sources de faits concurrentes.
 *
 * **Les courses de 3 à 6 coureurs** (`participants.ts`) ne changent rien à ces règles : le moteur
 * reçoit un **effectif** et aligne le sous-ensemble de roster correspondant, tiré de la seed. Tout ce
 * qui était écrit « six » devient « les partants » — les flux restent nommés **par personnage**
 * (`drift:c0` ne dépend pas de qui court), l'observateur reçoit la liste réelle, et le classement,
 * l'arrivée et les faits se calculent sur elle. À six partants, la liste **est** `CHARACTER_IDS` et
 * aucun tirage supplémentaire n'a lieu : les courses à six sont donc bit à bit celles d'avant.
 */

/** Numéros humains des segments, dans l'ordre. `RacePhase.segment` est en base 1 (contrat P003). */
const HUMAN_SEGMENTS: readonly (1 | 2 | 3)[] = [1, 2, 3];

/** Fige une phase : ce sont des valeurs, elles ne doivent jamais pouvoir être modifiées en place. */
function frozenPhase(phase: RacePhase): RacePhase {
  return Object.freeze(phase);
}

/** Phase initiale, partagée : `idle` est une valeur, pas un état propre à une instance. */
const IDLE_PHASE: RacePhase = frozenPhase({ kind: 'idle' });

/** Phase terminale, partagée pour la même raison. */
const FINISHED_PHASE: RacePhase = frozenPhase({ kind: 'finished' });

/** Préfixe des flux de dérive : `drift:c0`, `drift:c1`, … Un flux par personnage, jamais partagé. */
const DRIFT_STREAM_PREFIX = 'drift:';

/**
 * Préfixe des flux de surge : `surge:c0`, `surge:c1`, …
 *
 * Strictement distinct de `drift:` : consommer le flux de surge d'un personnage ne décale donc ni sa
 * dérive, ni les surges des autres. C'est ce qui permet d'ajouter les surges en P007 sans invalider
 * une seule dérive de P004.
 */
const SURGE_STREAM_PREFIX = 'surge:';

/**
 * Libellé du flux du planificateur d'événements.
 *
 * Un seul flux pour toute la course : la sélection de l'événement, de sa cible, de sa durée et de sa
 * magnitude sont quatre décisions **solidaires** (la cible dépend de l'événement tiré), elles ne
 * peuvent donc pas vivre dans des flux séparés sans devenir impossibles à rejouer.
 */
const EVENT_STREAM_LABEL = 'events:global';

/**
 * Tampon de faits vide, partagé : un `drainFacts()` sans fait ne doit rien allouer.
 */
const NO_FACTS: readonly RaceFact[] = Object.freeze([]);

export class RaceEngine {
  private readonly config: GameConfig;

  /** Paramètres pré-calculés de l'étape d'Ornstein–Uhlenbeck : rien n'est recalculé dans la boucle. */
  private readonly driftParams: OrnsteinUhlenbeckParams;

  private seedValue: number;

  private state: RaceState;

  /**
   * Facteur d'amplitude du bruit de dérive, **pour la mesure uniquement** (voir le constructeur).
   *
   * `undefined` en production. Il ne reçoit que le numéro du pas : aucune règle ne peut donc dépendre
   * du rang, de la distance ou de l'écart, et l'écrire ne consomme aucun tirage.
   */
  private readonly driftNoiseScale: ((stepNumber: number) => number) | undefined;

  /**
   * Intervalle de surge de mesure, **après** la borne uniquement (voir le constructeur).
   *
   * `undefined` en production. La plage est pré-calculée une fois par course : rien n'est recalculé
   * dans la boucle, et le tirage reste un `nextInt(min, max)` sur le flux `surge:<charId>`.
   */
  private readonly surgeIntervalAfter:
    | { readonly fromStep: number; readonly range: SurgeStepRange }
    | undefined;

  /**
   * Formes de fin de course de mesure, **alignées sur l'ordre des partants** (`state.characters`).
   *
   * `undefined` en production. Les valeurs sont **fournies** par l'appelant : le noyau ne tire rien
   * lui-même, donc cette option ne consomme aucun tirage et ne peut décaler ni les dérives, ni les
   * surges, ni les événements. Chaque forme multiplie la vitesse **cible** du personnage
   * correspondant, progressivement entre `fromStep` et `fullAtStep` (voir `lateFormFactor`).
   */
  private readonly lateForm:
    | {
        readonly fromStep: number;
        readonly fullAtStep: number;
        readonly values: readonly number[];
      }
    | undefined;

  /**
   * Un flux de dérive par personnage, créé **une seule fois** par course.
   *
   * C'est le point le plus facile à casser de tout le moteur : reconstruire ces flux à chaque pas
   * (`forkStream(seed, 'drift:c0')` dans la boucle) ferait repartir chaque personnage du **premier**
   * tirage de son flux, à chaque pas. Les six dérives resteraient identiques et la course serait
   * parfaitement plate, sans qu'aucun test de type ne s'en aperçoive.
   */
  private driftStreams: readonly RngStream[];

  /**
   * Un flux de surge par personnage, créé **une seule fois** par course, pour la même raison que les
   * flux de dérive : le reconstruire à chaque pas ferait repartir chaque personnage du premier tirage
   * de son flux, et les surges deviendraient un motif répétitif au lieu d'un hasard.
   */
  private surgeStreams: readonly RngStream[];

  /** Planning de surge de chaque personnage, aligné sur l'ordre du roster. */
  private surgeStates: readonly SurgeState[];

  /** Bornes de tirage pré-calculées : aucune conversion secondes → pas dans la boucle. */
  private readonly surgeConfig: SurgeParams;

  /** Flux unique du planificateur d'événements, créé une seule fois par course. */
  private eventStream: RngStream;

  /** Planning d'événements de la course : cibles, cooldowns, plafonds et emplacements actifs. */
  private eventPlan: EventPlanState;

  /** Constantes du planificateur pré-calculées, catalogue compris. */
  private readonly eventConfig: EventParams;

  /**
   * Catalogue en vigueur pour cette instance.
   *
   * Conservé pour que `reset()` reconstruise un planning **identique en règles** : sans ce champ, une
   * instance construite avec un catalogue de diagnostic repartirait silencieusement sur
   * `EVENT_CATALOG`, et deux moitiés de campagne ne mesureraient plus la même chose.
   */
  private readonly catalog: readonly EventDefinition[];

  /**
   * Effectif demandé pour la course (3 à 6).
   *
   * Il est **fixé à la construction** : changer de nombre de coureurs ne se fait pas en cours de
   * course, mais en repartant sur une nouvelle course. `reset()` conserve donc cet effectif et
   * recalcule seulement les **partants**, qui dépendent de la seed.
   */
  private readonly players: number;

  /**
   * Partants de la course en cours, dans l'ordre canonique du roster.
   *
   * Recalculés à chaque `reset()` : une nouvelle seed peut donc changer le sous-ensemble, ce qui est
   * le comportement voulu (mêmes règles, autre plateau). À six partants, la liste est exactement
   * `CHARACTER_IDS` et aucun flux n'est consommé pour la choisir.
   */
  private participants: readonly CharacterId[];

  /**
   * Faits produits depuis le dernier `drainFacts()`, dans l'ordre chronologique.
   *
   * Depuis P009-A, tous les faits — `CHECKPOINT_SPLIT` compris — viennent de l'observateur, alimenté
   * après chaque pas. Le tampon est vidé par `drainFacts()` et par `reset()` — **jamais** par
   * `getState()`, qui n'est qu'une photographie en lecture seule.
   */
  private facts: RaceFact[] = [];

  /**
   * Observateur de faits, créé **une seule fois** par course.
   *
   * Il est reconstruit par `reset()` : sa mémoire est une fenêtre glissante, elle n'a aucun sens
   * d'une course à l'autre. Il ne consomme aucun flux aléatoire et ne peut donc pas décaler la
   * simulation, quelle que soit la façon dont `drainFacts()` est appelé.
   */
  private observer: RaceObserver;

  /**
   * Construit un moteur pour une course.
   *
   * `options.catalog` n'existe que pour la **mesure** : le harnais d'équilibrage doit pouvoir évaluer
   * une variante du catalogue §7.1 sans muter un export partagé — un diagnostic qui réécrit l'état
   * global n'est ni reproductible ni parallélisable. En production, l'argument est absent et le
   * catalogue est celui du noyau (`EVENT_CATALOG`, valeur par défaut de `eventParams`).
   *
   * `options.players` fixe l'**effectif** (3 à 6, `6` par défaut). Une valeur illisible retombe sur
   * `DEFAULT_PARTICIPANTS` plutôt que de lever : c'est un paramètre d'entrée, pas une constante de
   * jeu, et un effectif invalide ne doit jamais empêcher une course de démarrer.
   *
   * `options.driftNoiseScale` n'existe lui aussi que pour la **mesure** : il multiplie l'amplitude du
   * bruit de dérive **déjà tiré**, sans consommer un seul tirage supplémentaire. Il reçoit le numéro
   * du pas courant (base 1, comme `RaceState.steps` une fois le pas terminé) et rend un facteur.
   * Absent — le cas de la production — le facteur vaut `1` et **aucune multiplication n'a lieu** :
   * le noyau reste bit à bit celui de production. Un facteur `1` rendu par la fonction est traité de
   * la même façon, pour que la mesure puisse le vérifier.
   *
   * Ce levier est symétrique (il s'applique à tous les partants de la même manière), de moyenne nulle
   * (il ne fait que dilater un bruit centré) et **indépendant du rang** : la fonction ne reçoit que le
   * numéro du pas, jamais une position, une distance ni un classement. Ce n'est donc ni un
   * rubber-band ni un boost du dernier.
   *
   * `options.surgeIntervalAfter` n'existe lui aussi que pour la **mesure** : à partir du premier pas
   * qui **suit** `fromStep`, l'intervalle entre deux débuts de surge est tiré dans une loi de moyenne
   * `meanS` au lieu de `SURGE.INTERVAL_MEAN_S`. Rien d'autre ne change : mêmes tirages, même ordre,
   * même flux, même durée, mêmes magnitudes, même probabilité de freinage. La borne basse
   * (`INTERVAL_MIN_S`) et la borne haute **dérivée** (`2 × moyenne − min`) sont conservées, donc la
   * garantie « un seul surge actif » tient toujours. Un intervalle tiré **avant** la borne n'est pas
   * retouché : le levier ne peut donc rien changer avant `fromStep`.
   *
   * `options.lateForm` n'existe lui aussi que pour la **mesure** : une forme relative par personnage
   * (moyenne nulle sur le roster, une valeur par partant, dans l'ordre des partants), montée
   * linéairement de `0 %` à `fromStep` jusqu'à `100 %` à `fullAtStep`, puis maintenue. Elle multiplie
   * la vitesse **cible**, donc l'effet passe par les rampes existantes. Le noyau ne tire aucune
   * valeur : c'est l'appelant qui fournit le tableau, ce qui garantit qu'aucun flux du moteur n'est
   * décalé.
   */
  constructor(
    seed: string,
    config: GameConfig = GAME_CONFIG,
    options: {
      readonly catalog?: readonly EventDefinition[];
      readonly players?: number;
      readonly driftNoiseScale?: (stepNumber: number) => number;
      readonly surgeIntervalAfter?: { readonly fromStep: number; readonly meanS: number };
      readonly lateForm?: {
        readonly fromStep: number;
        readonly fullAtStep: number;
        readonly values: readonly number[];
      };
    } = {},
  ) {
    validateConfig(config);

    this.config = config;
    this.driftNoiseScale = options.driftNoiseScale;
    this.surgeIntervalAfter =
      options.surgeIntervalAfter === undefined
        ? undefined
        : Object.freeze({
            fromStep: options.surgeIntervalAfter.fromStep,
            range: intervalStepRangeForMean(config, options.surgeIntervalAfter.meanS),
          });
    this.lateForm =
      options.lateForm === undefined
        ? undefined
        : Object.freeze({
            fromStep: options.lateForm.fromStep,
            fullAtStep: options.lateForm.fullAtStep,
            values: Object.freeze([...options.lateForm.values]),
          });
    this.driftParams = Object.freeze({
      dt: config.RACE.DT_S,
      theta: config.DRIFT.THETA,
      sigma: config.DRIFT.SIGMA,
      sqrtDt: SQRT_DT,
      clampValue: config.DRIFT.CLAMP,
    });

    this.seedValue = normalizeSeed(seed);
    this.players = normalizeParticipants(options.players ?? DEFAULT_PARTICIPANTS);
    this.participants = selectParticipants(this.seedValue, this.players);
    // Le contrôle d'alignement ne peut avoir lieu qu'une fois les partants connus : une forme est
    // fournie par partant, dans l'ordre des partants.
    if (this.lateForm !== undefined && this.lateForm.values.length !== this.participants.length) {
      throw new RangeError(
        `lateForm attend ${String(this.participants.length)} valeurs, une par partant (reçu : ${String(this.lateForm.values.length)}).`,
      );
    }
    this.surgeConfig = surgeParams(config);
    this.catalog = options.catalog ?? EVENT_CATALOG;
    this.eventConfig = eventParams(config, this.catalog);
    this.driftStreams = this.createDriftStreams();
    this.surgeStreams = this.createSurgeStreams();
    this.surgeStates = this.createSurgeStates();
    this.eventStream = forkStream(this.seedValue, EVENT_STREAM_LABEL);
    this.eventPlan = createEventPlan(this.participants.length);
    this.observer = new RaceObserver(config, this.participants);
    this.state = RaceEngine.createInitialState(seed, this.seedValue, config, this.participants);
  }

  /** Effectif de la course (3 à 6) : il ne change pas d'une course à l'autre pour cette instance. */
  get playersCount(): number {
    return this.players;
  }

  /** Partants réellement alignés, dans l'ordre canonique du roster. */
  get participantIds(): readonly CharacterId[] {
    return this.participants;
  }

  /**
   * Avance la course d'**exactement** un pas `DT_S`.
   *
   * Ne prend aucun argument : il n'existe aucun moyen d'injecter un `dt` externe, donc aucun moyen
   * de faire dépendre la course du framerate. Sur une course terminée, c'est un no-op **total** :
   * ni pas, ni temps, ni distance, ni tirage aléatoire consommé.
   */
  step(): void {
    if (this.state.phase.kind === 'finished') {
      return;
    }

    const { DT_S } = this.config.RACE;

    // Numéro du pas en cours de calcul. `state.steps` n'est incrémenté qu'après la boucle : le pas
    // courant est donc `steps + 1`, et les surges sont planifiés sur cette même base 1 que
    // `RaceState.steps` une fois le pas terminé.
    const stepNumber = this.state.steps + 1;

    // Les événements du pas sont décidés **avant** la boucle des personnages (P008) : l'événement qui
    // démarre à ce pas en fait donc déjà partie, et celui qui s'achève à ce pas n'en fait déjà plus
    // partie. Aucun événement n'est tiré pendant une pause, puisque `step()` n'est alors pas appelé.
    stepEvents(this.eventPlan, this.eventStream, this.eventConfig, this.participants, stepNumber);

    // Ordre physique = ordre stable du roster, jamais celui d'un Map ou d'un Set.
    for (const [index, character] of this.state.characters.entries()) {
      const stream = this.driftStreams[index];
      const surgeStream = this.surgeStreams[index];
      const surgeState = this.surgeStates[index];
      if (stream === undefined) {
        throw new RangeError(`Aucun flux de dérive pour l'index ${index}.`);
      }
      if (surgeStream === undefined || surgeState === undefined) {
        throw new RangeError(`Aucun planning de surge pour l'index ${index}.`);
      }

      // L'événement actif est republié à chaque pas : `eventBonus` et `activeEvent` décrivent donc
      // toujours le pas courant, et retombent à zéro d'eux-mêmes à l'expiration.
      const activeEvent = activeEventAt(this.eventPlan, index);
      character.activeEvent = activeEvent;
      character.eventBonus = activeEvent === null ? 0 : activeEvent.magnitude;

      // Ordre imposé et testé (P007) : le surge du pas est décidé **avant** la dérive, donc avant la
      // vitesse cible. Un surge qui démarre à ce pas en fait donc déjà partie, et un surge dont la
      // fin tombe sur ce pas n'en fait déjà plus partie.
      character.surge = stepSurge(
        surgeState,
        surgeStream,
        this.surgeConfig,
        stepNumber,
        this.surgeIntervalAfter !== undefined && stepNumber > this.surgeIntervalAfter.fromStep
          ? this.surgeIntervalAfter.range
          : undefined,
      );

      const gaussian = gaussianFrom(stream);
      // Le bruit est dilaté **après** le tirage : aucun flux n'est consommé en plus, et un facteur de
      // 1 (ou l'absence de facteur) laisse le pas strictement identique à celui de production.
      const noiseScale = this.driftNoiseScale === undefined ? 1 : this.driftNoiseScale(stepNumber);
      character.drift = stepOrnsteinUhlenbeck(
        character.drift,
        noiseScale === 1 ? gaussian : gaussian * noiseScale,
        this.driftParams,
      );

      // Forme de fin de course éventuelle (mesure uniquement) : un facteur multiplicatif sur la
      // vitesse **cible**, jamais sur `x`. Absente, le facteur vaut exactement 1 et le pas est celui
      // de production, au bit près.
      const form = this.lateForm === undefined ? 0 : (this.lateForm.values[index] ?? 0);
      const formFactor =
        this.lateForm === undefined || form === 0
          ? 1
          : lateFormFactor(form, stepNumber, this.lateForm.fromStep, this.lateForm.fullAtStep);

      const targetV = computeTargetSpeed(character, this.config);
      const modulatedV = formFactor === 1 ? targetV : targetV * formFactor;
      character.v = integrateSpeed(character.v, modulatedV, this.config, DT_S);
      character.x = integratePosition(character.x, character.v, DT_S);
    }

    this.state.steps += 1;

    // Multiplication, jamais accumulation : `steps × DT_S` tombe exactement sur 20, 40 et 60,
    // alors qu'une accumulation flottante donnerait 20.000000000000146 et 59.999999999997875 (P003).
    this.state.tSim = this.state.steps * DT_S;
    this.state.phase = this.phaseFor(this.state.tSim);

    // Le fait est produit **après** l'intégration du pas qui atteint la borne : les distances
    // publiées sont donc exactement celles de `tSim` = 20 ou 40 s, sans décalage d'un pas.
    // L'observateur voit le noyau à CHAQUE pas simulé, jamais à la fréquence du rendu.
    const produced = this.observer.observe({
      tSim: this.state.tSim,
      steps: this.state.steps,
      characters: this.state.characters,
    });
    for (const fact of produced) {
      this.facts.push(fact);
    }
  }

  /**
   * Joue la course jusqu'au bout, sans rendu ni pause.
   *
   * Depuis un moteur neuf, cela fait exactement `TOTAL_STEPS` pas. Appelée sur un moteur déjà
   * terminé, la boucle ne s'exécute pas une seule fois.
   */
  runToCompletion(): RaceResult {
    while (this.state.phase.kind !== 'finished') {
      this.step();
    }
    return this.buildResult();
  }

  /**
   * Photographie de l'état courant.
   *
   * L'instantané est **figé** : le rendu peut le lire et le conserver, il ne peut pas corrompre la
   * simulation, et l'état interne ne change jamais sous ses pieds. Il est en revanche recréé à
   * chaque appel — ne pas comparer deux appels par identité.
   */
  getState(): Readonly<RaceState> {
    const characters = this.state.characters.map((character) =>
      Object.freeze({ ...character }),
    );

    return Object.freeze({
      seed: this.state.seed,
      seedValue: this.state.seedValue,
      tSim: this.state.tSim,
      steps: this.state.steps,
      phase: this.state.phase,
      characters: Object.freeze(characters),
    });
  }

  /**
   * Faits produits par les pas écoulés, et vide le tampon.
   *
   * Contrat : ce qui est renvoyé ne le sera plus au prochain appel — un second `drainFacts()`
   * immédiat renvoie une liste vide. `getState()` ne draine rien : consulter l'état ne doit jamais
   * faire disparaître un fait non consommé.
   */
  drainFacts(): readonly RaceFact[] {
    if (this.facts.length === 0) {
      return NO_FACTS;
    }
    const drained = this.facts;
    this.facts = [];
    return Object.freeze(drained);
  }

  /** Repart de zéro sur une nouvelle seed : distances, vitesses, dérives, surges, événements, faits et flux. */
  reset(seed: string): void {
    this.seedValue = normalizeSeed(seed);
    // Les partants sont **retirés** pour cette seed : une nouvelle course peut donc changer de plateau
    // sans changer d'effectif. À six, le tirage n'a pas lieu et la liste reste le roster entier.
    this.participants = selectParticipants(this.seedValue, this.players);
    this.driftStreams = this.createDriftStreams();
    this.surgeStreams = this.createSurgeStreams();
    this.surgeStates = this.createSurgeStates();
    this.eventStream = forkStream(this.seedValue, EVENT_STREAM_LABEL);
    this.eventPlan = createEventPlan(this.participants.length);
    this.observer = new RaceObserver(this.config, this.participants);
    this.facts = [];
    this.state = RaceEngine.createInitialState(seed, this.seedValue, this.config, this.participants);
  }

  /** Un flux nommé par personnage, dérivé de la seed : consommer `c0` ne touche jamais `c1`. */
  private createDriftStreams(): readonly RngStream[] {
    return this.participants.map((id) => forkStream(this.seedValue, `${DRIFT_STREAM_PREFIX}${id}`));
  }

  /**
   * Un flux de surge par personnage, nommé `surge:<charId>`.
   *
   * La séparation des noms est la seule chose qui garantit l'indépendance : `forkStream` dérive un
   * état complet par couple `(seed, label)`, donc les surges et les dérives des partants sont des
   * suites indépendantes, et l'ordre dans lequel on les consomme n'a aucune importance.
   *
   * Le nom ne dépend que du **personnage**, jamais de l'effectif : un coureur aligné à trois comme à
   * six reçoit exactement la même suite de surges pour une seed donnée.
   */
  private createSurgeStreams(): readonly RngStream[] {
    return this.participants.map((id) => forkStream(this.seedValue, `${SURGE_STREAM_PREFIX}${id}`));
  }

  /** Plannings de surge initiaux : le premier surge de chaque personnage est tiré comme les suivants. */
  private createSurgeStates(): readonly SurgeState[] {
    return this.surgeStreams.map((stream) => createSurgeState(stream, this.surgeConfig));
  }

  /**
   * Phase correspondant au temps simulé.
   *
   * La course se termine **exclusivement** par le temps : `finished` est atteint si et seulement si
   * `tSim >= TOTAL_SIM_S`. Aucune distance, aucune ligne d'arrivée, aucun plafond de `x` n'entre
   * dans cette décision — un personnage dix fois plus rapide franchit la même borne au même pas.
   */
  private phaseFor(tSim: number): RacePhase {
    if (tSim >= this.config.RACE.TOTAL_SIM_S) {
      return FINISHED_PHASE;
    }
    if (tSim <= 0) {
      return IDLE_PHASE;
    }

    // `track.ts` indexe les segments à partir de 0 ; `RacePhase.segment` est un numéro humain 1..3.
    const segment = HUMAN_SEGMENTS[segmentIndexAt(tSim)];
    if (segment === undefined) {
      throw new RangeError(`Segment hors bornes pour tSim=${tSim}.`);
    }

    return frozenPhase({
      kind: 'running',
      segment,
      segmentElapsedS: segmentElapsedS(tSim),
    });
  }

  /** Classement final dérivé des seules distances, plus les distances dans l'ordre du roster. */
  private buildResult(): RaceResult {
    const distances = this.state.characters.map((character) => character.x);
    const ids = this.state.characters.map((character) => character.id);

    const ranking: CharacterId[] = [];
    for (const index of sortByRank(distances, ids)) {
      const id = ids[index];
      if (id === undefined) {
        throw new RangeError(`Index de classement hors bornes : ${index}.`);
      }
      ranking.push(id);
    }

    return Object.freeze({ tSim: this.state.tSim, ranking: Object.freeze(ranking), distances });
  }

  /** État de départ : tous les partants à zéro, même vitesse de base, ni dérive ni surge. */
  private static createInitialState(
    seed: string,
    seedValue: number,
    config: GameConfig,
    participants: readonly CharacterId[],
  ): RaceState {
    const characters: CharacterState[] = participants.map((id) => ({
      id,
      x: 0,
      v: config.SPEED.BASE,
      drift: 0,
      surge: 0,
      eventBonus: 0,
      activeEvent: null,
    }));

    return {
      seed,
      seedValue,
      tSim: 0,
      steps: 0,
      phase: IDLE_PHASE,
      characters,
    };
  }
}
