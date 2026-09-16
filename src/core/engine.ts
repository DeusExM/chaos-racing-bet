import { CHARACTER_IDS } from './characters';
import type { GameConfig } from './config';
import { GAME_CONFIG, SQRT_DT, validateConfig } from './config';
import { gaussianFrom, stepOrnsteinUhlenbeck } from './math';
import type { OrnsteinUhlenbeckParams } from './math';
import { sortByRank } from './ranking';
import type { RngStream } from './rng';
import { forkStream } from './rng';
import { normalizeSeed } from './seed';
import { computeTargetSpeed, integratePosition, integrateSpeed } from './speedModel';
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
 * rampe progressive, intégration de position. Pas encore de surge, pas d'événement, pas de
 * checkpoint, pas de fait, pas de commentaire.
 */

/** Numéros humains des segments, dans l'ordre. `RacePhase.segment` est en base 1 (contrat P003). */
const HUMAN_SEGMENTS: readonly (1 | 2 | 3 | 4)[] = [1, 2, 3, 4];

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

export class RaceEngine {
  private readonly config: GameConfig;

  /** Paramètres pré-calculés de l'étape d'Ornstein–Uhlenbeck : rien n'est recalculé dans la boucle. */
  private readonly driftParams: OrnsteinUhlenbeckParams;

  private seedValue: number;

  private state: RaceState;

  /**
   * Un flux de dérive par personnage, créé **une seule fois** par course.
   *
   * C'est le point le plus facile à casser de tout le moteur : reconstruire ces flux à chaque pas
   * (`forkStream(seed, 'drift:c0')` dans la boucle) ferait repartir chaque personnage du **premier**
   * tirage de son flux, à chaque pas. Les six dérives resteraient identiques et la course serait
   * parfaitement plate, sans qu'aucun test de type ne s'en aperçoive.
   */
  private driftStreams: readonly RngStream[];

  constructor(seed: string, config: GameConfig = GAME_CONFIG) {
    validateConfig(config);

    this.config = config;
    this.driftParams = Object.freeze({
      dt: config.RACE.DT_S,
      theta: config.DRIFT.THETA,
      sigma: config.DRIFT.SIGMA,
      sqrtDt: SQRT_DT,
      clampValue: config.DRIFT.CLAMP,
    });

    this.seedValue = normalizeSeed(seed);
    this.driftStreams = this.createDriftStreams();
    this.state = RaceEngine.createInitialState(seed, this.seedValue, config);
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

    // Ordre physique = ordre stable du roster, jamais celui d'un Map ou d'un Set.
    for (const [index, character] of this.state.characters.entries()) {
      const stream = this.driftStreams[index];
      if (stream === undefined) {
        throw new RangeError(`Aucun flux de dérive pour l'index ${index}.`);
      }

      const gaussian = gaussianFrom(stream);
      character.drift = stepOrnsteinUhlenbeck(character.drift, gaussian, this.driftParams);

      const targetV = computeTargetSpeed(character, this.config);
      character.v = integrateSpeed(character.v, targetV, this.config, DT_S);
      character.x = integratePosition(character.x, character.v, DT_S);
    }

    this.state.steps += 1;

    // Multiplication, jamais accumulation : `steps × DT_S` tombe exactement sur 45, 90, 135 et 180,
    // alors qu'une accumulation flottante donnerait 44.99999999999873 et 180.00000000003539 (P003).
    this.state.tSim = this.state.steps * DT_S;
    this.state.phase = this.phaseFor(this.state.tSim);
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
   * P004 n'en produit **aucun** : les faits naissent de l'observateur qui compare les états
   * successifs, et cet observateur arrive avec P009. Tant qu'il n'existe pas, cette liste est vide —
   * le speaker n'a donc rien à commenter, ce qui est exactement l'état attendu ici.
   */
  drainFacts(): readonly RaceFact[] {
    return [];
  }

  /** Repart de zéro sur une nouvelle seed : distances, vitesses, dérives, pas et flux aléatoires. */
  reset(seed: string): void {
    this.seedValue = normalizeSeed(seed);
    this.driftStreams = this.createDriftStreams();
    this.state = RaceEngine.createInitialState(seed, this.seedValue, this.config);
  }

  /** Un flux nommé par personnage, dérivé de la seed : consommer `c0` ne touche jamais `c1`. */
  private createDriftStreams(): readonly RngStream[] {
    return CHARACTER_IDS.map((id) => forkStream(this.seedValue, `${DRIFT_STREAM_PREFIX}${id}`));
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

    // `track.ts` indexe les segments à partir de 0 ; `RacePhase.segment` est un numéro humain 1..4.
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

  /** État de départ : tout le monde à zéro, même vitesse de base, aucune dérive. */
  private static createInitialState(
    seed: string,
    seedValue: number,
    config: GameConfig,
  ): RaceState {
    const characters: CharacterState[] = CHARACTER_IDS.map((id) => ({
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
