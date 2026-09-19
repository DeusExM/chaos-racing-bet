import type { GameConfig } from './config';
import type { RngStream } from './rng';

/**
 * Les surges (P007) : petites accélérations et petits ralentissements **temporaires**, tirés
 * indépendamment pour chaque personnage, en plus de la dérive permanente de P004.
 *
 * Ce module ne contient **que le planning**. Il ne connaît ni `RaceEngine`, ni `RaceState`, ni
 * `CharacterState`, ne calcule aucune distance et n'écrit jamais dans `x` : il répond à une seule
 * question — « quel surge est actif au pas `n` ? » — et renvoie une magnitude relative. C'est ce qui
 * garantit qu'un surge ne peut pas être une téléportation déguisée : la seule façon dont il agit sur
 * la course est de moduler la vitesse **cible**, qui passe ensuite par la rampe puis par l'écrêtage.
 *
 * ## Trois choix structurants
 *
 * 1. **Tout est compté en pas entiers.** Le noyau avance par pas fixes ; planifier « 9 secondes en
 *    moyenne » dans un accumulateur flottant ferait dériver le planning d'un moteur JavaScript à
 *    l'autre, puisque seule l'arithmétique entière est exactement spécifiée. On tire donc des
 *    **numéros de pas**, jamais des durées flottantes accumulées.
 * 2. **L'intervalle entre deux débuts de surge est uniforme** sur `[INTERVAL_MIN_S,
 *    INTERVAL_MAX_S]`, où la borne haute est **dérivée** : `2 × INTERVAL_MEAN_S − INTERVAL_MIN_S`.
 *    C'est la seule façon d'obtenir exactement `INTERVAL_MEAN_S` de moyenne avec une loi uniforme.
 *    `14 s` n'est donc pas une constante de jeu : c'est un résultat, calculé à partir des deux
 *    valeurs de `GAME_DESIGN.md` §6.4, et il suit automatiquement tout changement de celles-ci.
 * 3. **Un seul surge actif par personnage**, garanti par construction et non par un espoir : la durée
 *    maximale (`DURATION_MAX_S = 4 s`) ne dépasse pas l'intervalle minimal entre deux débuts
 *    (`INTERVAL_MIN_S = 4 s`). Un surge est donc toujours terminé quand le suivant commence.
 *    `validateConfig()` refuse désormais une configuration qui romprait cette relation, et
 *    `stepSurge()` refuse en outre de démarrer un surge tant qu'un autre est actif.
 *
 * ## Convention d'intervalle : `[startStep, endStep)`
 *
 * Un surge de `N` pas démarre au pas `startStep` et se termine au pas `endStep = startStep + N`,
 * borne **exclue** :
 *
 * * le pas `startStep` **subit déjà** le surge ;
 * * le pas `endStep` ne le subit **plus**.
 *
 * Un surge actif pendant `N` pas influence donc exactement `N` intégrations de vitesse : ni une de
 * plus, ni une de moins. Les deux frontières sont verrouillées par des tests dédiés.
 *
 * ## Aucun biais
 *
 * Aucun tirage ne dépend du rang, de la distance, du leader, du dernier, du drift, ni du personnage :
 * chaque personnage a son propre flux nommé `surge:<charId>`, et rien d'autre n'entre dans la
 * décision. Les six sont donc structurellement équivalents.
 */

/** Planning interne d'un personnage. Volontairement **hors** de `RaceState` : ce n'est pas un état de jeu. */
export interface SurgeState {
  /** Pas absolu du **prochain** début de surge (base 1, comme `RaceState.steps` après le pas). */
  nextStartStep: number;
  /** Pas de fin du surge actif, **exclu**, ou `null` si aucun surge n'est actif. */
  endStep: number | null;
  /** Magnitude relative du surge actif ; `0` quand aucun surge n'est actif. */
  magnitude: number;
}

/** Bornes d'un tirage, en **pas entiers** inclusifs. */
export interface SurgeStepRange {
  readonly min: number;
  readonly max: number;
}

/**
 * Constantes de tirage pré-calculées, une fois par course.
 *
 * Même principe que `OrnsteinUhlenbeckParams` : rien n'est recalculé dans la boucle de simulation, et
 * les conversions secondes → pas sont faites à un seul endroit.
 */
export interface SurgeParams {
  readonly intervalSteps: SurgeStepRange;
  readonly durationSteps: SurgeStepRange;
  readonly magnitudeMin: number;
  readonly magnitudeMax: number;
  readonly brakeProbability: number;
  readonly brakeMagnitudeMin: number;
  readonly brakeMagnitudeMax: number;
}

/**
 * Borne haute **dérivée** de l'intervalle entre deux débuts, en secondes.
 *
 * `2 × INTERVAL_MEAN_S − INTERVAL_MIN_S` : pour une loi uniforme sur `[min, max]`, la moyenne vaut
 * `(min + max) / 2`. Fixer la moyenne à `INTERVAL_MEAN_S` impose donc cette borne haute. Avec les
 * valeurs de `GAME_DESIGN.md` §6.4 : `2 × 9 − 4 = 14 s`.
 */
export function intervalMaxS(config: GameConfig): number {
  return 2 * config.SURGE.INTERVAL_MEAN_S - config.SURGE.INTERVAL_MIN_S;
}

/**
 * Convertit une durée de jeu en nombre de pas.
 *
 * L'arrondi est **volontaire et unique** : c'est ici, et nulle part ailleurs, que le temps continu
 * devient discret. `4 s` donne exactement `240` pas et `14 s` exactement `840`, parce que la
 * multiplication tombe juste ; `Math.round` absorbe le dernier bit flottant de la division.
 */
function stepsForSeconds(seconds: number, config: GameConfig): number {
  return Math.round(seconds / config.RACE.DT_S);
}

/** Intervalle `[min, max]` entre deux **débuts** de surge, en pas inclusifs. */
export function intervalStepRange(config: GameConfig): SurgeStepRange {
  return Object.freeze({
    min: stepsForSeconds(config.SURGE.INTERVAL_MIN_S, config),
    max: stepsForSeconds(intervalMaxS(config), config),
  });
}

/**
 * Intervalle `[min, max]` pour une **moyenne imposée**, en pas inclusifs.
 *
 * Même loi et même logique de génération que `intervalStepRange` — un `nextInt(min, max)` uniforme,
 * tiré au même moment, dans le même ordre, sur le même flux — seule la moyenne change :
 *
 * * la borne **basse** reste `INTERVAL_MIN_S` : elle porte la garantie structurelle « un seul surge
 *   actif par personnage » (`INTERVAL_MIN_S ≥ DURATION_MAX_S`, vérifiée par `validateConfig`) ;
 * * la borne **haute** reste **dérivée** par `2 × moyenne − min`, donc la moyenne de la loi uniforme
 *   vaut exactement la valeur demandée.
 *
 * Avec `moyenne = 6 s` et `INTERVAL_MIN_S = 4 s`, la loi devient donc `[4 s ; 8 s]` : c'est ce que
 * donnerait un `INTERVAL_MEAN_S = 6` dans `GAME_DESIGN.md` §6.4, borne haute recalculée comprise.
 *
 * N'existe que pour la **mesure** (voir `RaceEngine`) : la production appelle `intervalStepRange`.
 */
export function intervalStepRangeForMean(config: GameConfig, meanS: number): SurgeStepRange {
  const min = config.SURGE.INTERVAL_MIN_S;
  if (!(meanS >= min)) {
    throw new RangeError(
      `intervalStepRangeForMean : moyenne ${String(meanS)} s sous l'intervalle minimal ${String(min)} s.`,
    );
  }
  return Object.freeze({
    min: stepsForSeconds(min, config),
    max: stepsForSeconds(2 * meanS - min, config),
  });
}

/** Durée `[min, max]` d'un surge, en pas inclusifs. */
export function durationStepRange(config: GameConfig): SurgeStepRange {
  return Object.freeze({
    min: stepsForSeconds(config.SURGE.DURATION_MIN_S, config),
    max: stepsForSeconds(config.SURGE.DURATION_MAX_S, config),
  });
}

/** Pré-calcule toutes les bornes de tirage à partir des constantes de jeu. */
export function surgeParams(config: GameConfig): SurgeParams {
  return Object.freeze({
    intervalSteps: intervalStepRange(config),
    durationSteps: durationStepRange(config),
    magnitudeMin: config.SURGE.MAGNITUDE_MIN,
    magnitudeMax: config.SURGE.MAGNITUDE_MAX,
    brakeProbability: config.SURGE.BRAKE_PROBABILITY,
    brakeMagnitudeMin: config.SURGE.MAGNITUDE_BRAKE_MIN,
    brakeMagnitudeMax: config.SURGE.MAGNITUDE_BRAKE_MAX,
  });
}

/**
 * Planning initial d'un personnage, au pas `0`.
 *
 * Le premier surge est tiré **comme les suivants** : la course ne commence donc pas avec un surge
 * « gratuit ». Sans cette symétrie, le nombre attendu de surges sur la course serait supérieur de 1
 * à `TOTAL_SIM_S / INTERVAL_MEAN_S`, et la mesure statistique ne correspondrait plus à cette
 * espérance.
 */
export function createSurgeState(stream: RngStream, params: SurgeParams): SurgeState {
  return {
    nextStartStep: stream.nextInt(params.intervalSteps.min, params.intervalSteps.max),
    endStep: null,
    magnitude: 0,
  };
}

/**
 * Magnitude signée du surge qui démarre : négative pour un freinage, positive sinon.
 *
 * Le signe est décidé **avant** la magnitude : un freinage tire sa valeur absolue dans les bornes de
 * freinage, une accélération dans les bornes d'accélération. Les deux lois sont disjointes, ce qui
 * interdit d'obtenir un freinage plus faible qu'une accélération, ou l'inverse.
 */
function drawMagnitude(stream: RngStream, params: SurgeParams): number {
  if (stream.nextFloat() < params.brakeProbability) {
    const absolute =
      params.brakeMagnitudeMin +
      stream.nextFloat() * (params.brakeMagnitudeMax - params.brakeMagnitudeMin);
    return -absolute;
  }
  return params.magnitudeMin + stream.nextFloat() * (params.magnitudeMax - params.magnitudeMin);
}

/**
 * Fait avancer le planning d'un personnage jusqu'au pas `stepNumber` et renvoie le surge actif.
 *
 * Appelée **une fois par pas et par personnage**, dans l'ordre physique du roster. C'est la seule
 * fonction qui consomme le flux `surge:<charId>`, et elle ne le consomme qu'au démarrage d'un surge :
 * quatre tirages (intervalle, durée, signe, magnitude), puis plus rien jusqu'au suivant.
 *
 * Les numéros de pas sont en base 1 et correspondent à `RaceState.steps` **après** le pas exécuté.
 * Les appels sont donc consécutifs, et la comparaison `stepNumber >= nextStartStep` est en pratique
 * une égalité ; le `>=` évite simplement de rester bloqué si un pas était sauté un jour.
 *
 * `intervalRange` n'existe que pour la **mesure** : il remplace la seule borne de l'intervalle tiré
 * **à ce pas**, sans changer ni l'ordre, ni le nombre, ni la nature des tirages (voir
 * `intervalStepRangeForMean`). Absent — le cas de la production — le tirage est celui de
 * `params.intervalSteps`.
 */
export function stepSurge(
  state: SurgeState,
  stream: RngStream,
  params: SurgeParams,
  stepNumber: number,
  intervalRange?: SurgeStepRange,
): number {
  // Fin : `endStep` est exclu, donc le pas `endStep` ne subit déjà plus le surge.
  if (state.endStep !== null && stepNumber >= state.endStep) {
    state.endStep = null;
    state.magnitude = 0;
  }

  // Début : le pas de départ subit le surge, contrairement au pas de fin.
  // La condition `endStep === null` rend le non-cumul structurel : un surge ne peut pas en écraser
  // un autre, même si une configuration incohérente le proposait.
  if (state.endStep === null && stepNumber >= state.nextStartStep) {
    const durationSteps = stream.nextInt(params.durationSteps.min, params.durationSteps.max);
    const range = intervalRange ?? params.intervalSteps;
    const intervalSteps = stream.nextInt(range.min, range.max);

    state.endStep = stepNumber + durationSteps;
    state.nextStartStep = stepNumber + intervalSteps;
    state.magnitude = drawMagnitude(stream, params);
  }

  return state.magnitude;
}
