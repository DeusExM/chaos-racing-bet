import { RACE_CONFIG } from '../core/config';
import { RaceEngine } from '../core/engine';
import type { RaceFact, RaceResult, RaceState } from '../core/types';
import { SIM_CONFIG } from './config';
import { ReplayHistory } from './ReplayHistory';
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
 * ## P006 : countdown, checkpoints, pauses — et surtout **aucun rattrapage**
 *
 * Une pause réelle n'appelle simplement pas `step()`. Le noyau ignore qu'elle existe : `tSim`, `x`,
 * `v` et le drift sont strictement gelés, et le nombre total de pas d'une course reste `3600`
 * qu'il y ait eu 0, 2 ou 100 pauses.
 *
 * Corollaire moins évident, et c'est le piège de cette étape : **le temps réel passé en pause ne
 * doit jamais devenir du temps simulé à rattraper**. Sans précaution, une frame qui traverse une
 * borne de checkpoint aurait déjà « payé » plusieurs pas au-delà de la borne ; une pause de 3 s
 * ajouterait ses propres secondes à l'accumulateur, et la reprise rejouerait tout d'un bloc. C'est
 * pourquoi :
 *
 * * pendant `countdown`, `checkpointPause` et `userPaused`, **rien** n'est ajouté à l'accumulateur ;
 * * à chaque entrée en pause, l'accumulateur est **recalé sur `executedSteps × DT_S`**, ce qui jette
 *   le reliquat de la frame courante et coupe la progression **à la borne exacte**.
 *
 * Le temps réel d'une pause et le temps simulé accumulé sont donc deux quantités distinctes, que
 * rien ne relie.
 */
export class RaceSimulation {
  private readonly engine: RaceEngine;

  private config: SimConfig;

  /**
   * Total de temps **simulé** reçu depuis le départ, en secondes.
   *
   * Il ne fait que croître pendant la course : il n'est **jamais** décrémenté. Soustraire `DT_S` à
   * chaque pas accumulerait une erreur d'arrondi et ferait perdre un pas de temps en temps — un
   * `update` de 1000 ms en `timeScale = 1` ne produirait plus 60 pas, mais 59. Le nombre de pas à
   * exécuter est donc recalculé depuis ce total, et `executedSteps` tient le compte exact de ce qui
   * a déjà été joué. Il est en revanche **recalé** à chaque entrée en pause (voir la classe).
   */
  private accumulatedSimS = 0;

  /** Pas déjà exécutés. Un entier, incrémenté sans jamais dériver. */
  private executedSteps = 0;

  private simPhase: SimPhase = 'idle';

  /** Temps réel restant du compte à rebours, en secondes. */
  private countdownRemainingS = 0;

  /** Temps réel restant de la pause de checkpoint en cours, en secondes. */
  private checkpointPauseRemainingS = 0;

  /** Numéro du checkpoint atteint (1 à 3), pendant sa pause uniquement. */
  private checkpointNumber: number | null = null;

  /**
   * Phase suspendue par une pause utilisateur.
   *
   * Elle permet de reprendre **exactement** où l'on était : ni le compte à rebours ni une pause de
   * checkpoint ne sont annulés, recommencés, ni consommés pendant que le MJ regarde ailleurs.
   */
  private phaseBeforeUserPause: SimPhase = 'idle';

  /**
   * Destinataire des faits produits par le noyau, s'il y en a un.
   *
   * `RaceSimulation` reste la **seule** couche qui draine les faits du moteur : elle les transmet
   * ensuite, par lots d'un même pas, à qui veut les commenter (P009-C). Le flux de faits ne peut donc
   * pas être consommé deux fois, et un auditeur est un **observateur** : il ne reçoit que des faits
   * gelés, sans aucun accès à l'état de course.
   */
  private factsListener: ((facts: readonly RaceFact[]) => void) | null = null;

  /**
   * Historique compact des instants déjà joués, pour la **relecture** pendant une pause manuelle.
   *
   * Il est rempli ici, pas par le rendu : seul le propriétaire des pas peut dire ce qui a réellement
   * été calculé. Il ne participe à aucune décision — le vider, le remplir ou ne jamais le lire donne
   * exactement la même course.
   */
  readonly history = new ReplayHistory();

  constructor(seed: string, config: SimConfig = SIM_CONFIG) {
    requireUsableConfig(config);

    this.config = config;
    this.engine = new RaceEngine(seed);
    // Le pas `0` est un instant comme un autre : c'est l'état de départ, et la relecture doit pouvoir
    // y revenir (la borne basse du curseur vaut exactement `0 s`).
    this.history.record(this.engine.getState());
  }

  /** Phase temps réel : `idle` tant que `start()` n'a pas été appelé. */
  get phase(): SimPhase {
    return this.simPhase;
  }

  /**
   * Numéro du checkpoint dont la pause est en cours (`1`, `2` ou `3`), sinon `null`.
   *
   * C'est ce que la bannière affiche. Pendant la pause, l'état du noyau **est** le split : le
   * classement et les distances figés à la borne sont donc déjà disponibles dans `view`, sans avoir
   * à recopier quoi que ce soit.
   */
  get checkpoint(): number | null {
    return this.checkpointNumber;
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
   * Branche (ou débranche avec `null`) l'observateur de faits.
   *
   * Il est appelé **une fois par pas** qui produit au moins un fait, avec le lot complet de ce pas.
   * Un pas sans fait ne déclenche aucun appel : rien ne circule inutilement, et l'auditeur ne peut
   * pas confondre « pas silencieux » et « course à l'arrêt ».
   */
  onFacts(listener: ((facts: readonly RaceFact[]) => void) | null): void {
    this.factsListener = listener;
  }

  /**
   * Démarre la course : compte à rebours réel, puis course.
   *
   * Avec `countdownRealS = 0` (mode test), le départ est immédiat : `start()` passe directement en
   * `running`. Appeler `start()` sur une course terminée la rejoue depuis le début, même seed.
   */
  start(): void {
    if (this.simPhase === 'finished') {
      this.restart();
    }
    if (this.simPhase !== 'idle') {
      return;
    }

    this.countdownRemainingS = this.config.countdownRealS;
    this.simPhase = this.countdownRemainingS > 0 ? 'countdown' : 'running';
  }

  /**
   * Suspend ou reprend la course à la demande du MJ.
   *
   * `running` → `userPaused`, et retour à la phase exactement suspendue. Une pause utilisateur
   * déclenchée pendant le compte à rebours ou pendant une pause de checkpoint **ne les annule pas**
   * et **ne consomme pas leur minuterie** : elle laisse le temps restant intact et le reprend tel
   * quel.
   *
   * Sans effet sur une course qui n'a pas commencé ou qui est terminée : il n'y a rien à suspendre.
   */
  toggleUserPause(): void {
    if (this.simPhase === 'userPaused') {
      this.simPhase = this.phaseBeforeUserPause;
      return;
    }
    if (this.simPhase === 'idle' || this.simPhase === 'finished') {
      return;
    }

    this.phaseBeforeUserPause = this.simPhase;
    this.simPhase = 'userPaused';
  }

  /**
   * Avance la simulation du temps réel écoulé.
   *
   * `realDtMs` est en **millisecondes** — c'est ce que fournit la boucle d'affichage — alors que
   * `DT_S` est en secondes : la conversion est donc explicite, et le `timeScale` s'applique au temps
   * simulé, jamais à la taille du pas.
   */
  update(realDtMs: number): void {
    const realDtS = realDtMs / 1000;
    if (!Number.isFinite(realDtS) || realDtS <= 0) {
      return;
    }

    switch (this.simPhase) {
      case 'idle':
      case 'finished':
      case 'userPaused':
        // Rien ne bouge, et surtout rien ne s'accumule : ni pas, ni temps simulé, ni tirage.
        // La minuterie de la phase suspendue reste intacte, à la seconde près.
        return;

      case 'countdown':
        this.countdownRemainingS -= realDtS;
        if (this.countdownRemainingS > 0) {
          return;
        }
        this.countdownRemainingS = 0;
        this.simPhase = 'running';
        // Le reliquat de cette frame est abandonné : le temps passé à attendre le départ n'est pas
        // du temps couru, et le transformer en pas ferait bondir la course au premier update.
        this.rebaseAccumulator();
        return;

      case 'checkpointPause':
        this.checkpointPauseRemainingS -= realDtS;
        if (this.checkpointPauseRemainingS > 0) {
          return;
        }
        this.checkpointPauseRemainingS = 0;
        this.checkpointNumber = null;
        this.simPhase = 'running';
        this.rebaseAccumulator();
        return;

      case 'running':
        break;
    }

    this.advanceRunning(realDtS);
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

  /** Repart de zéro, **en `idle`**, avec tous les compteurs réels remis à plat. */
  restart(seed?: string): void {
    this.engine.reset(seed ?? this.engine.getState().seed);
    this.accumulatedSimS = 0;
    this.executedSteps = 0;
    this.countdownRemainingS = 0;
    this.checkpointPauseRemainingS = 0;
    this.checkpointNumber = null;
    this.phaseBeforeUserPause = 'idle';
    this.simPhase = 'idle';
    // L'historique appartient à **une** course : le garder d'une course à l'autre ferait croire à une
    // relecture possible d'instants qui n'existent plus.
    this.history.reset();
    this.history.record(this.engine.getState());
  }

  /**
   * Joue la course jusqu'au bout, **sans rendu ni pause**, et renvoie le résultat du noyau.
   *
   * C'est l'API des tests et des hooks : elle produit exactement le même résultat qu'une course
   * jouée image par image, en une fraction de seconde. Elle **ne dort pas** : ni les 3 s du compte à
   * rebours, ni les 3 × 3 s des checkpoints ne sont attendues — une pause ne fait pas partie de la
   * course, elle n'a donc rien à reproduire ici.
   */
  runToCompletion(seed?: string): RaceResult {
    this.restart(seed);
    const result = this.engine.runToCompletion();
    // La course est jouée d'un coup : l'horloge réelle est alignée sur les pas réellement exécutés,
    // pour qu'un `update()` ultérieur ne croie pas avoir du retard à rattraper.
    this.executedSteps = this.engine.getState().steps;
    this.accumulatedSimS = this.executedSteps * RACE_CONFIG.DT_S;
    this.countdownRemainingS = 0;
    this.checkpointPauseRemainingS = 0;
    this.checkpointNumber = null;
    this.phaseBeforeUserPause = 'idle';
    this.simPhase = 'finished';
    // La course a été jouée d'un bloc par le noyau, sans passer par la boucle : aucun instant
    // intermédiaire n'a été observé, donc aucun n'est enregistré. Un historique vide est honnête —
    // il vaut mieux qu'un historique qui prétendrait couvrir des instants jamais vus.
    this.history.reset();
    return result;
  }

  /** Avance la course d'au plus `maxStepsPerFrame` pas, en s'arrêtant pile sur un checkpoint. */
  private advanceRunning(realDtS: number): void {
    this.accumulatedSimS += realDtS * this.config.timeScale;

    // Nombre total de pas que le temps réel écoulé autorise depuis le départ…
    const stepsWanted = Math.floor(this.accumulatedSimS / RACE_CONFIG.DT_S);
    // … moins ceux déjà joués, plafonné par le garde-fou anti « spiral of death ».
    const stepsToRun = Math.min(stepsWanted - this.executedSteps, this.config.maxStepsPerFrame);

    for (let index = 0; index < stepsToRun; index += 1) {
      this.engine.step();
      this.executedSteps += 1;

      // L'instant qui vient d'être calculé entre dans l'historique **avant** toute autre lecture : la
      // relecture voit donc exactement ce que le noyau a produit, jamais une frame en retard.
      this.history.record(this.engine.getState());

      // Après **chaque** pas, jamais en fin de frame : en mode accéléré une seule frame demande
      // des centaines de pas et peut donc traverser une borne. Tout ce qui suit la borne
      // appartiendrait au segment suivant, or il doit être mis en pause.
      const facts = this.engine.drainFacts();

      // Les faits d'un pas partent **en un seul lot** : c'est ce qui permet à l'observateur de
      // parole de voir tout le pas avant de choisir (P009-C). Aucun lot vide n'est transmis.
      if (facts.length > 0) {
        this.factsListener?.(facts);
      }

      const checkpoint = checkpointReachedBy(facts);
      if (checkpoint !== null) {
        this.enterCheckpointPause(checkpoint);
        return;
      }

      // La course se termine **par le temps simulé** : dès que le noyau est `finished`, aucun pas de
      // plus n'est exécuté dans cette frame. Sans cette sortie, une frame qui demandait plus de pas
      // qu'il n'en restait ferait tourner la boucle « après la course » : les pas seraient des
      // non-actions du noyau, mais l'historique enregistrerait deux fois le même instant.
      if (this.engine.getState().phase.kind === 'finished') {
        this.simPhase = 'finished';
        return;
      }
    }
    // Si le plafond a été atteint ici, `stepsWanted - executedSteps` reste positif : le temps en
    // attente n'est ni perdu ni écrasé, il sera simplement exécuté au prochain `update()`.
  }

  /**
   * Entre en pause de checkpoint, **à la borne exacte**.
   *
   * L'accumulateur est recalé sur le pas atteint : la frame courante est terminée, son reliquat
   * appartient au temps réel de la pause et non à la course. C'est ce recalage qui rend le
   * non-rattrapage structurel plutôt que fortuit.
   */
  private enterCheckpointPause(checkpoint: number): void {
    this.rebaseAccumulator();
    if (this.config.checkpointPauseRealS > 0) {
      this.checkpointNumber = checkpoint;
      this.checkpointPauseRemainingS = this.config.checkpointPauseRealS;
      this.simPhase = 'checkpointPause';
      return;
    }

    // Pause de durée nulle : on ne s'arrête pas, mais la frontière reste franchie proprement.
    this.checkpointNumber = null;
    this.checkpointPauseRemainingS = 0;
    this.simPhase = 'running';
  }

  /** Recale l'accumulateur sur la frontière de pas atteinte, en abandonnant tout reliquat de frame. */
  private rebaseAccumulator(): void {
    this.accumulatedSimS = this.executedSteps * RACE_CONFIG.DT_S;
  }
}

/**
 * Numéro du checkpoint signalé par un `CHECKPOINT_SPLIT`, ou `null`.
 *
 * Le numéro vient du `tSim` du fait — `45 / 45 = 1`, `90 / 45 = 2`, `135 / 45 = 3` — et non d'un
 * calcul parallèle sur le compteur de pas : c'est le fait qui fait foi, et lui seul.
 */
function checkpointReachedBy(facts: readonly RaceFact[]): number | null {
  for (const fact of facts) {
    if (fact.type !== 'CHECKPOINT_SPLIT') {
      continue;
    }

    const checkpoint = fact.tSim / RACE_CONFIG.SEGMENT_DURATION_S;
    if (
      !Number.isInteger(checkpoint) ||
      checkpoint < 1 ||
      checkpoint >= RACE_CONFIG.SEGMENT_COUNT
    ) {
      throw new RangeError(`CHECKPOINT_SPLIT inattendu à tSim=${fact.tSim}.`);
    }
    return checkpoint;
  }
  return null;
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
  if (!Number.isFinite(config.countdownRealS) || config.countdownRealS < 0) {
    throw new RangeError(
      `SIM_CONFIG.countdownRealS doit être un nombre fini positif ou nul (reçu : ${config.countdownRealS}).`,
    );
  }
  if (!Number.isFinite(config.checkpointPauseRealS) || config.checkpointPauseRealS < 0) {
    throw new RangeError(
      `SIM_CONFIG.checkpointPauseRealS doit être un nombre fini positif ou nul (reçu : ${config.checkpointPauseRealS}).`,
    );
  }
}
