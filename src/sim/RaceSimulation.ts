import { RACE_CONFIG } from '../core/config';
import { RaceEngine } from '../core/engine';
import type { RaceResult, RaceState } from '../core/types';
import { SIM_CONFIG } from './config';
import type { SimConfig, SimPhase } from './types';

/**
 * `RaceSimulation` — la seule couche qui connaît le **temps réel**.
 *
 * Elle **enveloppe** `RaceEngine` sans jamais modifier ses règles : elle décide seulement *combien*
 * de pas exécuter, jamais *de quelle taille*. `DT_S` reste constant, `step()` ne reçoit toujours
 * aucun argument, et le résultat d'une course ne dépend donc jamais du framerate, d'un
 * ralentissement, d'un onglet en arrière-plan ou du `timeScale` choisi.
 *
 * ## Le point critique : ne jamais perdre de temps simulé
 *
 * Quand `maxStepsPerFrame` est atteint, le temps restant **demeure dans l'accumulateur** et sera
 * exécuté aux `update()` suivants. Un `realDt` énorme (un freeze de 2 s, un onglet réactivé) ne peut
 * donc pas faire sauter une partie de la course : il la décale dans le temps réel, jamais dans le
 * résultat.
 *
 * ## P005
 *
 * Ni compte à rebours, ni pause, ni checkpoint : `start()` démarre immédiatement, et seul le noyau
 * décide de la fin — à `tSim = 180 s`, soit exactement 10 800 pas.
 */
export class RaceSimulation {
  private readonly engine: RaceEngine;

  private config: SimConfig;

  /**
   * Total de temps **simulé** reçu depuis le départ, en secondes.
   *
   * Il ne fait que croître : il n'est **jamais** décrémenté. Soustraire `DT_S` à chaque pas
   * accumulerait une erreur d'arrondi et ferait perdre un pas de temps en temps — un `update` de
   * 1000 ms en `timeScale = 1` ne produirait plus 60 pas, mais 59. Le nombre de pas à exécuter est
   * donc recalculé depuis ce total, et `executedSteps` tient le compte exact de ce qui a déjà été
   * joué.
   */
  private accumulatedSimS = 0;

  /** Pas déjà exécutés. Un entier, décrémenté ou incrémenté sans jamais dériver. */
  private executedSteps = 0;

  private simPhase: SimPhase = 'idle';

  constructor(seed: string, config: SimConfig = SIM_CONFIG) {
    requireUsableConfig(config);

    this.config = config;
    this.engine = new RaceEngine(seed);
  }

  /** Phase temps réel : `idle` tant que `start()` n'a pas été appelé. */
  get phase(): SimPhase {
    return this.simPhase;
  }

  /** État du noyau, en lecture seule. Le rendu ne peut pas le modifier. */
  get view(): Readonly<RaceState> {
    return this.engine.getState();
  }

  /** Seed affichée de la course en cours. */
  get seed(): string {
    return this.engine.getState().seed;
  }

  /** Secondes simulées par seconde réelle. */
  get timeScale(): number {
    return this.config.timeScale;
  }

  /**
   * Démarre la course immédiatement.
   *
   * P005 n'a **pas** de compte à rebours : c'est P006 qui l'ajoutera. Appeler `start()` sur une
   * course déjà terminée la rejoue depuis le début, avec la même seed.
   */
  start(): void {
    if (this.simPhase === 'finished') {
      this.restart();
    }
    this.simPhase = 'running';
  }

  /**
   * Avance la simulation du temps réel écoulé.
   *
   * `realDtMs` est en **millisecondes** — c'est ce que fournit la boucle d'affichage — alors que
   * `DT_S` est en secondes : la conversion est donc explicite, et le `timeScale` s'applique au temps
   * simulé, jamais à la taille du pas.
   */
  update(realDtMs: number): void {
    if (this.simPhase !== 'running') {
      return;
    }

    const realDtS = realDtMs / 1000;
    if (!Number.isFinite(realDtS) || realDtS <= 0) {
      return;
    }

    this.accumulatedSimS += realDtS * this.config.timeScale;

    // Nombre total de pas que le temps réel écoulé autorise depuis le départ…
    const stepsWanted = Math.floor(this.accumulatedSimS / RACE_CONFIG.DT_S);
    // … moins ceux déjà joués, plafonné par le garde-fou anti « spiral of death ».
    const stepsToRun = Math.min(stepsWanted - this.executedSteps, this.config.maxStepsPerFrame);

    for (let index = 0; index < stepsToRun; index += 1) {
      this.engine.step();
      this.executedSteps += 1;
    }
    // Si le plafond a été atteint ici, `stepsWanted - executedSteps` reste positif : le temps en
    // attente n'est ni perdu ni écrasé, il sera simplement exécuté au prochain `update()`.

    if (this.engine.getState().phase.kind === 'finished') {
      this.simPhase = 'finished';
    }
  }

  /**
   * Change le nombre de secondes simulées par seconde réelle.
   *
   * Ne touche **jamais** à `DT_S` : seul le nombre de pas par frame change, donc le résultat d'une
   * course est rigoureusement identique quel que soit le `timeScale`.
   */
  setTimeScale(timeScale: number): void {
    if (!Number.isFinite(timeScale) || timeScale <= 0) {
      throw new RangeError(`timeScale doit être un nombre fini strictement positif (reçu : ${timeScale}).`);
    }
    this.config = Object.freeze({ ...this.config, timeScale });
  }

  /** Repart de zéro. Sans seed, rejoue la course en cours. */
  restart(seed?: string): void {
    this.engine.reset(seed ?? this.engine.getState().seed);
    this.accumulatedSimS = 0;
    this.executedSteps = 0;
    this.simPhase = 'idle';
  }

  /**
   * Joue la course jusqu'au bout, **sans rendu ni pause**, et renvoie le résultat du noyau.
   *
   * C'est l'API des tests et des hooks : elle produit exactement le même résultat qu'une course
   * jouée image par image, en une fraction de seconde.
   */
  runToCompletion(seed?: string): RaceResult {
    this.restart(seed);
    const result = this.engine.runToCompletion();
    // La course est jouée d'un coup : l'horloge réelle est alignée sur les pas réellement exécutés,
    // pour qu'un `update()` ultérieur ne croie pas avoir du retard à rattraper.
    this.executedSteps = this.engine.getState().steps;
    this.accumulatedSimS = this.executedSteps * RACE_CONFIG.DT_S;
    this.simPhase = 'finished';
    return result;
  }
}

/** Refuse une configuration qui rendrait la boucle inutilisable ou silencieusement incohérente. */
function requireUsableConfig(config: SimConfig): void {
  if (!Number.isFinite(config.timeScale) || config.timeScale <= 0) {
    throw new RangeError(`SIM_CONFIG.timeScale doit être strictement positif (reçu : ${config.timeScale}).`);
  }
  if (!Number.isInteger(config.maxStepsPerFrame) || config.maxStepsPerFrame < 1) {
    throw new RangeError(
      `SIM_CONFIG.maxStepsPerFrame doit être un entier supérieur ou égal à 1 (reçu : ${config.maxStepsPerFrame}).`,
    );
  }
}
