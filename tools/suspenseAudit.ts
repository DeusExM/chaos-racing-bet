/**
 * Audit de **suspense** des courses à six coureurs — `npm run balance:suspense`.
 *
 * ## Pourquoi cet outil existe
 *
 * Un test joueur a donné l'impression que le suspense est insuffisant : « trop souvent quelqu'un
 * semble devant assez tôt et reste crédible jusqu'au bout ». L'audit des leaders aux bornes
 * (`tools/leaderAudit.ts`) avait déjà mesuré la **persistance** du leader ; il ne mesurait ni les
 * remontées, ni le moment du dernier changement de leader, ni les écarts P1–P2, c'est-à-dire
 * précisément ce dont un spectateur a besoin pour croire à une issue incertaine.
 *
 * Cet outil complète donc la mesure, sans rien changer au jeu : il ne modifie **aucun** RNG, aucune
 * constante de vitesse, aucun événement, aucun surge, aucun rubber-band, aucun boost, aucune
 * sélection de participant, aucun rendu, et il ne connaît **que** l'effectif de référence `N = 6`
 * (les modes 3/4/5 sont hors périmètre de cette étape).
 *
 * ## Source des métriques : l'état réel, jamais le speaker
 *
 * Toutes les grandeurs viennent de l'état publié par `RaceEngine` (`tSim`, `steps`, `characters[].x`),
 * relevé **à chaque pas** :
 *
 * * le **rang** de chaque personnage est recalculé à chaque pas à partir des seules distances, avec
 *   exactement la règle de `core/ranking.ts` (`computeRanks`, départage `ascendingId`) ;
 * * l'**historique des rangs** est conservé pendant la course, ce qui permet de mesurer les remontées
 *   (un personnage a-t-il été 6e **puis** top 3 ?) et pas seulement la position finale ;
 * * le **leader** à chaque pas est le porteur du rang 1, exactement comme dans le harnais
 *   d'équilibrage (`balanceStats.observeRace`) et dans l'audit des leaders.
 *
 * Aucun texte, aucun fait, aucun commentaire du speaker n'est lu : le speaker ne peut ni créer ni
 * masquer un renversement. Aucun compteur d'événements n'est utilisé non plus — ce n'est pas le sujet
 * ici, et un compteur qui ne compterait pas tous les événements fausserait la lecture.
 *
 * ## Les six familles de mesures
 *
 * 1. **Leader aux bornes** : même leader à 20/40/60 s, exactement 2 ou 3 leaders distincts,
 *    20 = 40 s, 40 s = vainqueur, 20 s = vainqueur — plus les parts par personnage et leur χ².
 * 2. **Changements de leader** : moyenne, dispersion, nombre de leaders distincts par course,
 *    moment du **dernier** changement, et part des courses dont le dernier changement tombe dans les
 *    20, 10 ou 5 dernières secondes.
 * 3. **Remontées** : meilleur et pire rang de chaque personnage, remontée maximale en places,
 *    et les passages « 6e → top 3 / top 2 / 1er », y compris « 6e → top 3 sans gagner ».
 * 4. **Renversements** : le leader de 20 s (resp. 40 s) ne gagne pas, un leader ayant eu une avance
 *    significative perd la tête, et le vainqueur a-t-il été 4e, 5e ou 6e en cours de course.
 * 5. **Suspense final** : écart P1–P2 en mètres à 20, 40, 50, 55 et 60 s (min, p10, médiane, p90,
 *    max, moyenne) et part des courses encore serrées dans les 10 dernières secondes.
 * 6. **Contrôles** : effectif réellement à six, pas exactement `3600`, arrivée à `60 s`, rang rapide
 *    vérifié contre `computeRanks` aux bornes, corpus distinct, reproductibilité bit à bit.
 *
 * ## Seuils de lecture
 *
 * Les seuils d'écart ne sont pas inventés ici : ce sont ceux du jeu. `5 m` est le seuil de
 * `PHOTO_FINISH`, `15 m` celui de `CLOSE_RACE`, `20 m` celui de l'écart serré de `CHECKPOINT_SPLIT`
 * (`FACT`), et `10 m` est le seul point intermédiaire — il vaut environ `0,83 s` à `SPEED.BASE`.
 * Les quatre sont publiés ensemble, ce qui donne une **courbe de sensibilité** au lieu d'un verdict
 * dépendant d'un seuil unique.
 *
 * ## Références de l'audit précédent
 *
 * `SUSPENSE_REFERENCES` recopie les valeurs publiées par `npm run balance:leaders` sur le **même
 * corpus déterministe** de 10 000 seeds. Ce ne sont pas des seuils : ce sont les mesures contre
 * lesquelles on vérifie que l'outil rejoue bien le même monde (le corpus est un préfixe stable, donc
 * une divergence signalerait un instrument faux, pas un jeu qui a changé).
 *
 * Le module n'importe rien de Node : c'est `tools/suspenseAuditRunner.mjs` qui écrit les rapports.
 */

import { CHARACTER_IDS } from '../src/core/characters';
import { FACT, GAME_CONFIG, RACE_CONFIG } from '../src/core/config';
import { RaceEngine } from '../src/core/engine';
import { computeRanks } from '../src/core/ranking';
import type { CharacterId } from '../src/core/types';

import { corpusSeeds, measureReproducibility } from './balanceStats';
import type { CharacterShares } from './leaderAudit';
import { characterShares } from './leaderAudit';

// ---------------------------------------------------------------------------------------------
// Périmètre et constantes de l'audit
// ---------------------------------------------------------------------------------------------

/**
 * Effectif de l'audit : **six**, et rien d'autre.
 *
 * C'est le mode de référence du jeu, et le seul que cet outil mesure. Les courses à 3, 4 ou 5
 * coureurs appartiennent à `tools/participantsAudit.ts` ; mélanger les effectifs dans une même
 * synthèse rendrait toute moyenne ininterprétable (un effectif de six a six rangs, donc six
 * remontées possibles). `summarizeSuspenseAudit` **refuse** un corpus qui ne serait pas à six.
 */
export const SUSPENSE_PLAYERS = 6;

/** Taille du corpus par défaut : celle du constat joueur, pour rester comparable. */
export const DEFAULT_SUSPENSE_SEEDS = 10_000;

/**
 * Préfixe du corpus : celui de `npm run balance:leaders` et du harnais d'équilibrage.
 *
 * Le partager n'est pas un détail : `corpusSeeds(n)` est un préfixe, donc rejouer ces seeds rejoue
 * exactement les courses déjà publiées, et une divergence avec les références signalerait un
 * instrument faux.
 */
export const DEFAULT_AUDIT_CORPUS = 'balance-p010';

/** Seeds du contrôle de reproductibilité bit à bit (rejouées deux fois). */
export const DEFAULT_REPRODUCIBILITY_SEEDS = 100;

export const DEFAULT_SUSPENSE_JSON = '.tmp/suspense-audit.json';
export const DEFAULT_SUSPENSE_TEXT = '.tmp/suspense-audit.txt';

/**
 * Bornes de mesure, **dérivées** de `RACE_CONFIG` : fin de chaque segment, puis l'arrivée.
 *
 * Il n'existe pas de « checkpoint 3 » : la troisième borne **est** l'arrivée.
 */
export const LEADER_BOUNDS_S: readonly number[] = Object.freeze([
  RACE_CONFIG.SEGMENT_DURATION_S,
  2 * RACE_CONFIG.SEGMENT_DURATION_S,
  RACE_CONFIG.TOTAL_SIM_S,
]);

/** Libellés des bornes, pour les rapports. */
export const LEADER_BOUND_LABELS: readonly string[] = Object.freeze(
  LEADER_BOUNDS_S.map((seconds) => `${String(seconds)} s`),
);

/** Fenêtre de fin de course analysée en continu, en secondes simulées. */
export const FINAL_WINDOW_S = 10;

/**
 * Instants relevés dans la fenêtre finale, dérivés de `FINAL_WINDOW_S` : son entrée (`50 s`) et son
 * milieu (`55 s`). Ce sont les deux points qui montrent si la course se resserre ou se détache.
 */
export const FINAL_MARKS_S: readonly number[] = Object.freeze([
  RACE_CONFIG.TOTAL_SIM_S - FINAL_WINDOW_S,
  RACE_CONFIG.TOTAL_SIM_S - FINAL_WINDOW_S / 2,
]);

/**
 * Fenêtres du **dernier** changement de leader, exprimées depuis l'arrivée : 20, 10 et 5 secondes.
 *
 * Elles répondent à « le résultat reste-t-il incertain assez tard ? » : un dernier changement à
 * 55 s signifie que la course a changé de main dans les cinq dernières secondes.
 */
export const LAST_CHANGE_WINDOWS_S: readonly number[] = Object.freeze([20, 10, 5]);

/** Rangs visés par une remontée : « 6e → top 3 », « → top 2 », « → 1er ». */
export const COMEBACK_RANKS: readonly number[] = Object.freeze([3, 2, 1]);

/**
 * Durée minimale pendant laquelle un **nouveau** leader doit rester 1er pour que son changement de
 * tête soit compté comme **visible**.
 *
 * C'est la réponse au « micro-changement » : un coureur qui reprend la tête pendant deux ou trois pas
 * puis la reperd n'a produit aucun rebondissement perceptible — il a seulement franchi une égalité
 * de hasard dans un peloton groupé. Un changement n'est retenu que si le nouveau leader tient le rang
 * 1 pendant au moins une seconde **continue**.
 */
export const VISIBLE_LEADER_CHANGE_S = 1;

/**
 * Durée minimale passée au **dernier** rang pour qualifier une remontée « subie ».
 *
 * Un coureur qui n'est dernier que le temps d'un pas n'a rien vécu : pour parler de remontée, il faut
 * qu'il ait été réellement distancé (deux secondes pleines), puis qu'il soit revenu.
 */
export const LAST_STREAK_S = 2;

/**
 * Convertit une durée simulée en nombre de pas, par arithmétique entière.
 *
 * `1 / RACE_CONFIG.DT_S` donnerait `60,00000000000001` : la division flottante est évitée ici, comme
 * partout où le noyau convertit du temps.
 */
export function stepsForSeconds(seconds: number): number {
  return Math.round((seconds * RACE_CONFIG.STEPS_PER_SEGMENT) / RACE_CONFIG.SEGMENT_DURATION_S);
}

/**
 * Seuils des métriques « visibles », exprimés en **pas** pour être testables sur de petits
 * historiques.
 *
 * Les index de pas sont ceux de l'historique des rangs, donc **0-based** : le pas d'index `k`
 * correspond à `tSim = (k + 1) × DT_S`. Le premier pas à `40 s` est donc `steps−1` de `40 s`.
 */
export interface VisibleSuspenseThresholds {
  readonly visibleLeaderChangeSteps: number;
  readonly lastStreakSteps: number;
  /** Index du pas relevé pour « à 40 s ». */
  readonly boundStep: number;
  /** Index du premier pas de la fenêtre finale (`50 s`). */
  readonly finalWindowStartStep: number;
}

/** Seuils réels du jeu : 1 s de tête, 2 s au dernier rang, relevés à 40 s et 50 s. */
export const DEFAULT_VISIBLE_SUSPENSE_THRESHOLDS: VisibleSuspenseThresholds = Object.freeze({
  visibleLeaderChangeSteps: stepsForSeconds(VISIBLE_LEADER_CHANGE_S),
  lastStreakSteps: stepsForSeconds(LAST_STREAK_S),
  boundStep: stepsForSeconds(LEADER_BOUNDS_S[1] ?? RACE_CONFIG.TOTAL_SIM_S) - 1,
  finalWindowStartStep: stepsForSeconds(RACE_CONFIG.TOTAL_SIM_S - FINAL_WINDOW_S) - 1,
});

/**
 * Facteurs d'amplitude comparés par le sweep du bruit de dérive.
 *
 * `1` est le baseline de production : il ne doit rien changer, et l'outil le vérifie. Les autres
 * dilatent le bruit **déjà tiré** à partir du premier pas qui suit 40 s.
 */
export const DRIFT_NOISE_SWEEP_FACTORS: readonly number[] = Object.freeze([1, 1.15, 1.3, 1.45]);

/** Seconde à partir de laquelle le sweep dilate le bruit : la dernière borne de `LEADER_BOUNDS_S`. */
export const DRIFT_NOISE_SWEEP_FROM_S = LEADER_BOUNDS_S[1] ?? 40;

/**
 * Seuils d'écart P1–P2, en mètres, **pris dans le jeu** (voir l'en-tête) et du plus serré au plus
 * large. Ils servent deux fois : « les deux premiers sont encore proches » et « le leader avait une
 * avance significative ».
 */
export const GAP_THRESHOLDS_M: readonly number[] = Object.freeze([
  FACT.PHOTO_ARRIVAL_MAX_GAP_M,
  10,
  FACT.CLOSE_RACE_MAX_GAP_M,
  FACT.CHECKPOINT_SPLIT_CLOSE_GAP_M,
]);

/** Libellés des seuils d'écart, pour les rapports. */
export const GAP_THRESHOLD_LABELS: readonly string[] = Object.freeze(
  GAP_THRESHOLDS_M.map((meters) => `${String(meters)} m`),
);

/**
 * Mesures publiées par l'audit des leaders sur le **même corpus** de 10 000 seeds.
 *
 * Ce sont des références de contrôle, pas des règles : l'outil vérifie qu'il rejoue le même monde.
 *
 * Les six premières sont les parts de persistance et de victoire relevées par `npm run balance:leaders`
 * sur les 10 000 seeds. Les deux dernières sont des moyennes de changements de leader, sur **deux**
 * corpus de tailles différentes : `8,193` sur les 10 000 seeds (rapport de l'audit des leaders) et
 * `8,308` sur le sous-corpus de 1 000 seeds (`GAME_DESIGN.md` §13). Une passe à 1 000 seeds doit donc
 * reproduire la seconde, pas la première : chaque référence porte la taille de corpus où elle est
 * valable, et une référence d'une autre taille est **indicative**, jamais une anomalie.
 */
export interface SuspenseReferences {
  readonly seeds: number;
  readonly sameLeaderAllBoundsPercent: number;
  readonly exactlyTwoLeadersPercent: number;
  readonly threeDistinctLeadersPercent: number;
  readonly leader20EqualsLeader40Percent: number;
  readonly leader40EqualsWinnerPercent: number;
  readonly leader20EqualsWinnerPercent: number;
  readonly leaderChangesMean: number;
  /** Moyenne publiée sur le **sous-corpus de 1 000 seeds** (`GAME_DESIGN.md` §13) : `8,308`. */
  readonly leaderChangesMeanAt1000Seeds: number;
}

export const SUSPENSE_REFERENCES: SuspenseReferences = Object.freeze({
  seeds: 10_000,
  sameLeaderAllBoundsPercent: 34.04,
  exactlyTwoLeadersPercent: 53.25,
  threeDistinctLeadersPercent: 12.71,
  leader20EqualsLeader40Percent: 51.61,
  leader40EqualsWinnerPercent: 62.23,
  leader20EqualsWinnerPercent: 41.53,
  leaderChangesMean: 8.193,
  leaderChangesMeanAt1000Seeds: 8.308,
});

// ---------------------------------------------------------------------------------------------
// Outils purs : rangs, trajectoires, écarts
// ---------------------------------------------------------------------------------------------

/**
 * Rang de chaque personnage, avec **exactement** la règle de `core/ranking.ts` : distance
 * décroissante, égalité départagée par identifiant croissant.
 *
 * Cette fonction est l'équivalent rapide de `computeRanks` : elle évite le tri et l'allocation d'un
 * tableau d'entrées à chaque pas (3 600 pas × 10 000 courses). Le test unitaire la compare à
 * `computeRanks` sur des cas construits, égalités comprises, et l'audit lui-même vérifie le rang 1
 * contre `computeRanks` aux trois bornes de chaque course. `out`, s'il est fourni, est réutilisé
 * d'un pas à l'autre — c'est ce qui garde la boucle sans allocation.
 */
export function rankVector(
  xs: readonly number[],
  ids: readonly CharacterId[],
  out?: number[],
): number[] {
  if (xs.length !== ids.length) {
    throw new RangeError(
      `rankVector : xs (${String(xs.length)}) et ids (${String(ids.length)}) n'ont pas la même longueur.`,
    );
  }
  const ranks = out ?? new Array<number>(xs.length);

  for (let index = 0; index < xs.length; index += 1) {
    const x = xs[index] ?? 0;
    const id = ids[index] ?? '';
    let ahead = 0;
    for (let other = 0; other < xs.length; other += 1) {
      if (other === index) {
        continue;
      }
      const otherX = xs[other] ?? 0;
      if (otherX > x) {
        ahead += 1;
        continue;
      }
      if (otherX === x && (ids[other] ?? '') < id) {
        ahead += 1;
      }
    }
    ranks[index] = ahead + 1;
  }

  return ranks;
}

/** Environnement d'un historique de rangs : `history[step × characters + slot]`, `1` = premier. */
export type RankHistory = ArrayLike<number>;

/** Lit un rang d'un historique sans jamais propager un `undefined` dans un calcul. */
function rankAt(history: RankHistory, step: number, slot: number, characters: number): number {
  return history[step * characters + slot] ?? characters;
}

/**
 * Trajectoire d'un personnage sur une course, reconstruite depuis l'historique des rangs.
 *
 * `maxGain` est la **remontée maximale en places** : `max(r(t1) − r(t2))` pour `t1 ≤ t2`. Une
 * remontée se mesure donc dans l'ordre du temps — repasser par une place perdue ne compte pas deux
 * fois, et une place gagnée puis reperdue reste acquise au maximum atteint.
 */
export interface CharacterTrajectory {
  readonly steps: number;
  readonly bestRank: number;
  readonly worstRank: number;
  readonly maxGain: number;
  /** Vrai si le personnage a occupé le **dernier** rang observé à un instant de la course. */
  readonly wasLast: boolean;
  /**
   * Meilleur rang atteint **après** avoir été dernier ; `null` si le personnage n'a jamais été
   * dernier. C'est la seule mesure qui distingue « 6e à l'arrivée » de « 6e puis revenu ».
   */
  readonly bestRankAfterLastPlace: number | null;
  readonly won: boolean;
}

/** Trajectoire d'un personnage, slot par slot, sur l'historique complet d'une course. */
export function characterTrajectory(
  history: RankHistory,
  steps: number,
  slot: number,
  characters: number,
): CharacterTrajectory {
  if (steps < 1) {
    throw new RangeError(`characterTrajectory : historique vide (steps = ${String(steps)}).`);
  }
  if (!Number.isInteger(slot) || slot < 0 || slot >= characters) {
    throw new RangeError(`characterTrajectory : slot hors bornes (${String(slot)}).`);
  }

  let bestRank = characters;
  let worstRank = 1;
  let maxGain = 0;
  let runningWorst = 0;
  let firstLastStep = -1;
  let bestAfterLast = characters;
  let lastRank = characters;

  for (let step = 0; step < steps; step += 1) {
    const rank = rankAt(history, step, slot, characters);
    if (rank < bestRank) {
      bestRank = rank;
    }
    if (rank > worstRank) {
      worstRank = rank;
    }
    // Le pire rang **courant** inclut le pas observé : une remontée se mesure depuis un creux déjà vu.
    if (rank > runningWorst) {
      runningWorst = rank;
    }
    const gain = runningWorst - rank;
    if (gain > maxGain) {
      maxGain = gain;
    }
    if (rank === characters && firstLastStep < 0) {
      firstLastStep = step;
    }
    if (firstLastStep >= 0 && rank < bestAfterLast) {
      bestAfterLast = rank;
    }
    lastRank = rank;
  }

  return Object.freeze({
    steps,
    bestRank,
    worstRank,
    maxGain,
    wasLast: firstLastStep >= 0,
    bestRankAfterLastPlace: firstLastStep < 0 ? null : bestAfterLast,
    won: lastRank === 1,
  });
}

/** Ce qu'une course contient comme remontées, vu par les six trajectoires. */
export interface RaceComebackFlags {
  /** Vrai si un personnage a été dernier à un instant puis atteint au moins le top 3. */
  readonly toTop3: boolean;
  readonly toTop2: boolean;
  /** Vrai si un personnage a été dernier à un instant puis a gagné. */
  readonly toFirst: boolean;
  /** Vrai si un personnage a été dernier, est revenu dans le top 3, et n'a pas gagné. */
  readonly toTop3WithoutWin: boolean;
  /** Plus grande remontée de la course, en places. */
  readonly maxGainPlaces: number;
}

/** Agrège les six trajectoires d'une course en drapeaux de remontée. */
export function raceComebackFlags(
  trajectories: readonly CharacterTrajectory[],
): RaceComebackFlags {
  if (trajectories.length === 0) {
    throw new RangeError('raceComebackFlags : aucune trajectoire.');
  }

  const reached = (rank: number): boolean =>
    trajectories.some(
      (trajectory) =>
        trajectory.bestRankAfterLastPlace !== null && trajectory.bestRankAfterLastPlace <= rank,
    );

  let maxGainPlaces = 0;
  for (const trajectory of trajectories) {
    if (trajectory.maxGain > maxGainPlaces) {
      maxGainPlaces = trajectory.maxGain;
    }
  }

  return Object.freeze({
    toTop3: reached(3),
    toTop2: reached(2),
    toFirst: reached(1),
    toTop3WithoutWin: trajectories.some(
      (trajectory) =>
        !trajectory.won &&
        trajectory.bestRankAfterLastPlace !== null &&
        trajectory.bestRankAfterLastPlace <= 3,
    ),
    maxGainPlaces,
  });
}

/**
 * Métriques « visibles » d'un changement de leader.
 *
 * `rawChanges` est le compte brut (chaque transition du rang 1), `visibleChanges` ne retient que les
 * changements dont le nouveau leader tient le rang 1 au moins `visibleLeaderChangeSteps` pas, et
 * `microChanges` est la différence : les allers-retours que personne ne peut percevoir.
 */
export interface VisibleLeaderChangeMetrics {
  readonly rawChanges: number;
  readonly visibleChanges: number;
  readonly microChanges: number;
  /** Index du pas où le dernier changement **visible** a eu lieu ; `-1` si aucun. */
  readonly lastVisibleChangeStep: number;
  /** Un changement visible a-t-il eu lieu dans la fenêtre finale ? */
  readonly visibleInFinalWindow: boolean;
}

/**
 * Les cinq métriques de cette passe exploratoire, toutes lues sur l'**historique des rangs**.
 *
 * Elles sont volontairement calculées hors de la boucle de course, dans une fonction pure : c'est ce
 * qui permet de les tester sur des historiques construits à la main, et donc de vérifier une
 * définition (« visible », « reste 6e », « perd la tête après 50 s ») plutôt qu'un ordre de grandeur.
 */
export interface VisibleSuspense {
  readonly changes: VisibleLeaderChangeMetrics;
  /** Plus longue série continue au dernier rang, en pas (toutes places de dernier confondues). */
  readonly longestLastStreakSteps: number;
  /** Un personnage est-il resté dernier au moins `lastStreakSteps` pas d'affilée ? */
  readonly heldLastTwoSeconds: boolean;
  /** Ce personnage est-il ensuite remonté dans le top 3 **sans** gagner la course ? */
  readonly lastStreakToTop3WithoutWin: boolean;
  /** Un personnage 5e ou 6e au relevé de 40 s termine-t-il dans le top 3 ? */
  readonly at40FifthOrSixthToTop3: boolean;
  /** …et gagne-t-il ? */
  readonly at40FifthOrSixthToWin: boolean;
  /** Le leader de 40 s a-t-il perdu la tête **après** l'entrée dans la fenêtre finale ? */
  readonly leader40LosesLeadAfter50: boolean;
  /** Le leader de 40 s est-il encore en tête à l'entrée de la fenêtre finale ? */
  readonly leader40StillLeadsAt50: boolean;
}

/** Index du pas où se trouve le porteur du rang 1, ou `-1` si l'historique n'en contient aucun. */
function leaderSlotAt(history: RankHistory, step: number, characters: number): number {
  for (let slot = 0; slot < characters; slot += 1) {
    if (rankAt(history, step, slot, characters) === 1) {
      return slot;
    }
  }
  return -1;
}

/** Premier pas (index 0-based) dont le `tSim` atteint `seconds`, pour un historique donné. */
function stepAtSeconds(seconds: number, steps: number): number {
  const stepsPerSecond = steps / RACE_CONFIG.TOTAL_SIM_S;
  return Math.max(0, Math.min(steps - 1, Math.ceil(seconds * stepsPerSecond) - 1));
}

/** Construit les seuils d'un historique de `steps` pas : utile aux tests sur de petits historiques. */
export function visibleSuspenseThresholdsFor(
  steps: number,
  options: {
    readonly visibleLeaderChangeS?: number;
    readonly lastStreakS?: number;
    readonly boundS?: number;
    readonly finalWindowS?: number;
  } = {},
): VisibleSuspenseThresholds {
  return Object.freeze({
    visibleLeaderChangeSteps: Math.round(
      (options.visibleLeaderChangeS ?? VISIBLE_LEADER_CHANGE_S) * (steps / RACE_CONFIG.TOTAL_SIM_S),
    ),
    lastStreakSteps: Math.round(
      (options.lastStreakS ?? LAST_STREAK_S) * (steps / RACE_CONFIG.TOTAL_SIM_S),
    ),
    boundStep: stepAtSeconds(options.boundS ?? (LEADER_BOUNDS_S[1] ?? RACE_CONFIG.TOTAL_SIM_S), steps),
    finalWindowStartStep: stepAtSeconds(
      options.finalWindowS ?? RACE_CONFIG.TOTAL_SIM_S - FINAL_WINDOW_S,
      steps,
    ),
  });
}

/**
 * Calcule les cinq métriques « visibles » à partir de l'historique des rangs d'une course.
 *
 * Un **changement visible** est une transition du rang 1 suivie d'un règne d'au moins
 * `visibleLeaderChangeSteps` pas. Un règne interrompu par l'arrivée ne compte que s'il atteint la
 * durée : un coureur qui prend la tête à `59,5 s` n'a pas été vu devant une seconde entière.
 *
 * `initialLeaderSlot` est le leader à `t = 0`, avant le premier pas. Le fournir fait entrer cette
 * observation dans le premier règne : le compte brut devient alors **exactement** celui du suivi
 * pas-à-pas, qui part lui aussi du leader initial. Sans lui, seules les transitions internes à
 * l'historique sont comptées.
 *
 * Une **remontée subie** est une série d'au moins `lastStreakSteps` pas au dernier rang, suivie d'un
 * retour dans le top 3 (strictement après la série) sans victoire. Un coureur qui gagne après avoir
 * été dernier ne compte pas : la question porte sur celui qui revient sans gagner.
 *
 * « 5e ou 6e à 40 s » se lit au pas `boundStep`, et « perd la tête après 50 s » se lit sur la
 * **première** perte de tête consécutive à ce relevé : elle doit avoir lieu à un pas ≥
 * `finalWindowStartStep`.
 */
export function visibleSuspense(
  history: RankHistory,
  steps: number,
  characters: number,
  thresholds: VisibleSuspenseThresholds = DEFAULT_VISIBLE_SUSPENSE_THRESHOLDS,
  initialLeaderSlot = -1,
): VisibleSuspense {
  if (steps < 1) {
    throw new RangeError(`visibleSuspense : historique vide (steps = ${String(steps)}).`);
  }
  if (!Number.isInteger(characters) || characters < 2) {
    throw new RangeError(`visibleSuspense : effectif invalide (${String(characters)}).`);
  }
  if (thresholds.boundStep < 0 || thresholds.boundStep >= steps) {
    throw new RangeError(
      `visibleSuspense : pas de relevé hors de l'historique (${String(thresholds.boundStep)} pour ${String(steps)} pas).`,
    );
  }
  if (thresholds.finalWindowStartStep < 0 || thresholds.finalWindowStartStep >= steps) {
    throw new RangeError(
      `visibleSuspense : fenêtre finale hors de l'historique (${String(thresholds.finalWindowStartStep)} pour ${String(steps)} pas).`,
    );
  }
  if (leaderSlotAt(history, 0, characters) < 0) {
    throw new RangeError('visibleSuspense : aucun rang 1 au premier pas.');
  }
  if (initialLeaderSlot >= characters) {
    throw new RangeError(
      `visibleSuspense : leader initial hors effectif (${String(initialLeaderSlot)} pour ${String(characters)} personnages).`,
    );
  }

  const lastRunStart = new Array<number>(characters).fill(-1);
  const firstQualifiedEnd = new Array<number>(characters).fill(-1);

  let rawChanges = 0;
  let visibleChanges = 0;
  let lastVisibleChangeStep = -1;
  let visibleInFinalWindow = false;
  let longestLastStreakSteps = 0;

  // Le leader initial (`t = 0`) est une observation à part entière : quand il est fourni, le premier
  // règne commence à l'index virtuel −1 et la durée d'un règne vaut toujours `longueur × DT`. C'est
  // ce qui fait concorder exactement ce calcul avec le compteur de changements pas-à-pas.
  let leader = initialLeaderSlot >= 0 ? initialLeaderSlot : leaderSlotAt(history, 0, characters);
  let leaderRunStart = initialLeaderSlot >= 0 ? -1 : 0;
  let leaderRunIndex = 0;

  /** Clôt la série au dernier rang d'un personnage, si elle en était une. */
  const closeLastRun = (slot: number, endStep: number): void => {
    const start = lastRunStart[slot] ?? -1;
    if (start < 0) {
      return;
    }
    const length = endStep - start;
    if (length > longestLastStreakSteps) {
      longestLastStreakSteps = length;
    }
    // Seule la **première** série qualifiée compte : la question est « a-t-il été distancé, puis
    // revenu ? », pas « a-t-il fini dernier ? ».
    if (length >= thresholds.lastStreakSteps && (firstQualifiedEnd[slot] ?? -1) < 0) {
      firstQualifiedEnd[slot] = endStep - 1;
    }
    lastRunStart[slot] = -1;
  };

  /** Clôt un règne de leader ; seuls les règnes nés d'un changement peuvent être « visibles ». */
  const closeLeaderRun = (endStep: number): void => {
    const length = endStep - leaderRunStart;
    if (
      leaderRunIndex >= 1 &&
      length >= thresholds.visibleLeaderChangeSteps &&
      leaderRunStart >= 0
    ) {
      visibleChanges += 1;
      lastVisibleChangeStep = leaderRunStart;
      if (leaderRunStart >= thresholds.finalWindowStartStep) {
        visibleInFinalWindow = true;
      }
    }
  };

  for (let step = 0; step < steps; step += 1) {
    for (let slot = 0; slot < characters; slot += 1) {
      if (rankAt(history, step, slot, characters) === characters) {
        if ((lastRunStart[slot] ?? -1) < 0) {
          lastRunStart[slot] = step;
        }
      } else {
        closeLastRun(slot, step);
      }
    }

    if (step === 0 && initialLeaderSlot < 0) {
      // Sans leader initial fourni, l'historique commence au premier pas : rien à comparer avant.
      continue;
    }
    const current = leaderSlotAt(history, step, characters);
    if (current !== leader) {
      closeLeaderRun(step);
      leader = current;
      leaderRunStart = step;
      leaderRunIndex += 1;
      rawChanges += 1;
    }
  }

  for (let slot = 0; slot < characters; slot += 1) {
    closeLastRun(slot, steps);
  }
  closeLeaderRun(steps);

  // « …puis remonte top 3 sans gagner » : meilleur rang STRICTEMENT après la série qualifiée.
  let lastStreakToTop3WithoutWin = false;
  for (let slot = 0; slot < characters; slot += 1) {
    const end = firstQualifiedEnd[slot] ?? -1;
    if (end < 0) {
      continue;
    }
    let bestAfter = characters;
    for (let step = end + 1; step < steps; step += 1) {
      const rank = rankAt(history, step, slot, characters);
      if (rank < bestAfter) {
        bestAfter = rank;
      }
    }
    if (bestAfter <= 3 && rankAt(history, steps - 1, slot, characters) !== 1) {
      lastStreakToTop3WithoutWin = true;
    }
  }

  let at40FifthOrSixthToTop3 = false;
  let at40FifthOrSixthToWin = false;
  for (let slot = 0; slot < characters; slot += 1) {
    const at40 = rankAt(history, thresholds.boundStep, slot, characters);
    if (at40 < 5) {
      continue;
    }
    const finalRank = rankAt(history, steps - 1, slot, characters);
    if (finalRank <= 3) {
      at40FifthOrSixthToTop3 = true;
    }
    if (finalRank === 1) {
      at40FifthOrSixthToWin = true;
    }
  }

  const leaderAt40 = leaderSlotAt(history, thresholds.boundStep, characters);
  const leader40StillLeadsAt50 =
    leaderAt40 === leaderSlotAt(history, thresholds.finalWindowStartStep, characters);
  // « perd la tête **après** 50 s » se lit sur la **première** perte de tête consécutive au relevé :
  // un leader qui lâche la tête à 45 s ne l'a pas perdue « après 50 s », même s'il ne la reprend
  // jamais. La décomposition avec `leader40StillLeadsAt50` est alors directe.
  let leader40LosesLeadAfter50 = false;
  for (let step = thresholds.boundStep + 1; step < steps; step += 1) {
    if (leaderSlotAt(history, step, characters) !== leaderAt40) {
      leader40LosesLeadAfter50 = step >= thresholds.finalWindowStartStep;
      break;
    }
  }

  return Object.freeze({
    changes: Object.freeze({
      rawChanges,
      visibleChanges,
      microChanges: rawChanges - visibleChanges,
      lastVisibleChangeStep,
      visibleInFinalWindow,
    }),
    longestLastStreakSteps,
    heldLastTwoSeconds: longestLastStreakSteps >= thresholds.lastStreakSteps,
    lastStreakToTop3WithoutWin,
    at40FifthOrSixthToTop3,
    at40FifthOrSixthToWin,
    leader40LosesLeadAfter50,
    leader40StillLeadsAt50,
  });
}

/** Quantile d'une série, par interpolation linéaire — méthode identique au harnais d'équilibrage. */
export function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) {
    throw new RangeError('quantile : série vide.');
  }
  if (!(q >= 0 && q <= 1)) {
    throw new RangeError(`quantile : quantile hors [0 ; 1] (reçu : ${String(q)}).`);
  }
  const sorted = [...values].sort((left, right) => left - right);
  const last = sorted.length - 1;
  const position = q * last;
  const low = Math.floor(position);
  const high = Math.min(low + 1, last);
  const weight = position - low;
  return (sorted[low] ?? 0) * (1 - weight) + (sorted[high] ?? 0) * weight;
}

/** Résumé d'une série d'écarts, en mètres. */
export interface GapSummary {
  readonly count: number;
  readonly min: number;
  readonly p10: number;
  readonly median: number;
  readonly p90: number;
  readonly max: number;
  readonly mean: number;
}

/** Résumé min / p10 / médiane / p90 / max / moyenne d'une série d'écarts. */
export function gapSummary(values: readonly number[]): GapSummary {
  if (values.length === 0) {
    throw new RangeError('gapSummary : série vide.');
  }
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let sum = 0;
  for (const value of values) {
    if (value < min) {
      min = value;
    }
    if (value > max) {
      max = value;
    }
    sum += value;
  }

  return Object.freeze({
    count: values.length,
    min,
    p10: quantile(values, 0.1),
    median: quantile(values, 0.5),
    p90: quantile(values, 0.9),
    max,
    mean: sum / values.length,
  });
}

// ---------------------------------------------------------------------------------------------
// Course auditée
// ---------------------------------------------------------------------------------------------

/**
 * Une course auditée à six coureurs : tout ce que le suspense demande, relevé sur l'état réel.
 *
 * Les rangs viennent de l'**historique** conservé pendant la course ; les écarts viennent des
 * distances aux instants demandés. Aucune valeur n'est reconstituée après coup, aucune ne dépend
 * d'un texte de commentaire.
 */
export interface SuspenseRaceAudit {
  readonly seed: string;
  readonly players: number;
  readonly steps: number;
  readonly tSim: number;
  /** Leader à chaque borne de `LEADER_BOUNDS_S` (`null` si la borne n'a pas été observée). */
  readonly leadersAtBounds: readonly (CharacterId | null)[];
  readonly winner: CharacterId;
  /** Changements **bruts** du porteur du rang 1, pas à pas. */
  readonly leaderChanges: number;
  /** Instant du **dernier** changement de leader ; `0` si le leader n'a jamais changé. */
  readonly lastLeaderChangeS: number;
  /** Écart P1–P2 à chaque borne, en mètres. */
  readonly gapAtBoundsM: readonly number[];
  /** Écart P1–P2 aux instants de `FINAL_MARKS_S` (50 s et 55 s). */
  readonly gapAtMarksM: readonly number[];
  /** Écart P1–P2 maximal et minimal observés dans la fenêtre finale `[50 s ; 60 s]`. */
  readonly maxGapFinalWindowM: number;
  readonly minGapFinalWindowM: number;
  /** Par seuil de `GAP_THRESHOLDS_M` : l'écart était-il encore serré à l'entrée de la fenêtre ? */
  readonly closeAtWindowStart: readonly boolean[];
  /** Par seuil : l'écart est-il resté serré pendant **toute** la fenêtre finale ? */
  readonly closeThroughoutWindow: readonly boolean[];
  /** Par seuil : l'écart à l'arrivée est-il sous le seuil ? */
  readonly photoAtFinish: readonly boolean[];
  /** Par seuil : un leader a-t-il perdu la tête après avoir eu au moins ce seuil d'avance ? */
  readonly significantLeadLost: readonly boolean[];
  /** Plus grande avance sur le 2e atteinte par un leader pendant son règne, en mètres. */
  readonly maxLeadWhileLeadingM: number;
  readonly comeback: RaceComebackFlags;
  readonly trajectories: readonly CharacterTrajectory[];
  /**
   * Métriques « visibles » de cette passe exploratoire, calculées depuis l'historique des rangs.
   *
   * Elles ne remplacent pas les mesures brutes : elles les **qualifient** en exigeant une durée
   * minimale (1 s de tête, 2 s au dernier rang).
   */
  readonly visible: VisibleSuspense;
  /** Le compte brut relu dans l'historique concorde-t-il avec le compteur pas-à-pas ? */
  readonly leaderChangesConsistent: boolean;
  /** Le rang 1 du suivi rapide concorde-t-il avec `computeRanks` aux trois bornes ? */
  readonly rankVerified: boolean;
  /** Le plateau fait-il bien six partants, et sont-ils le roster entier ? */
  readonly fieldSizeOk: boolean;
  readonly exactSteps: boolean;
}

/** Index du porteur du rang 1 dans un vecteur de rangs (`0` si le vecteur est vide). */
function leaderSlotOf(ranks: readonly number[]): number {
  for (const [slot, rank] of ranks.entries()) {
    if (rank === 1) {
      return slot;
    }
  }
  return 0;
}

/** Les deux plus grandes distances, sans tri complet : `[1re, 2e]`. */
function topTwo(xs: readonly number[]): readonly [number, number] {
  let first = Number.NEGATIVE_INFINITY;
  let second = Number.NEGATIVE_INFINITY;
  for (const x of xs) {
    if (x > first) {
      second = first;
      first = x;
      continue;
    }
    if (x > second) {
      second = x;
    }
  }
  return [first, second];
}

/**
 * Joue **une** course complète à six coureurs et relève tout le suspense mesurable.
 *
 * Le relevé est fait à chaque pas : distances, rangs, leader, écarts. Les rangs sont écrits dans un
 * historique de taille `TOTAL_STEPS × 6`, réutilisé par les trajectoires ; c'est ce qui permet de
 * mesurer les remontées dans l'ordre du temps.
 */
export function auditSuspenseRace(
  seed: string,
  options: {
    /**
     * Facteur d'amplitude du bruit de dérive **déjà tiré**, par numéro de pas.
     *
     * Passe-plat vers l'option de mesure du noyau : l'outil ne modifie aucune constante de jeu, il
     * demande au moteur de dilater un bruit existant. Absent, la course est celle de production.
     */
    readonly driftNoiseScale?: (stepNumber: number) => number;
  } = {},
): SuspenseRaceAudit {
  const engine = new RaceEngine(seed, GAME_CONFIG, {
    players: SUSPENSE_PLAYERS,
    ...(options.driftNoiseScale === undefined
      ? {}
      : { driftNoiseScale: options.driftNoiseScale }),
  });
  const ids = CHARACTER_IDS;
  const characters = ids.length;
  const slotOf = new Map<CharacterId, number>(ids.map((id, index) => [id, index]));

  const history = new Uint8Array(RACE_CONFIG.TOTAL_STEPS * characters);
  const distances = new Array<number>(characters).fill(0);
  const ranks = new Array<number>(characters).fill(1);
  const seenLeaders = new Uint8Array(characters);

  const leadersAtBounds: (CharacterId | null)[] = LEADER_BOUNDS_S.map(() => null);
  const gapAtBoundsM: number[] = LEADER_BOUNDS_S.map(() => Number.NaN);
  const boundTaken: boolean[] = LEADER_BOUNDS_S.map(() => false);
  const gapAtMarksM: number[] = FINAL_MARKS_S.map(() => Number.NaN);
  const markTaken: boolean[] = FINAL_MARKS_S.map(() => false);
  const closeAtWindowStart: boolean[] = GAP_THRESHOLDS_M.map(() => false);
  const closeThroughoutWindow: boolean[] = GAP_THRESHOLDS_M.map(() => true);
  const photoAtFinish: boolean[] = GAP_THRESHOLDS_M.map(() => false);
  const significantLeadLost: boolean[] = GAP_THRESHOLDS_M.map(() => false);

  let rankVerified = true;
  let leaderChanges = 0;
  let lastLeaderChangeS = 0;
  let maxLeadWhileLeadingM = 0;
  let maxGapFinalWindowM = 0;
  let minGapFinalWindowM = Number.POSITIVE_INFINITY;
  let maxGapInReign = 0;

  let state = engine.getState();
  const initialDistances = state.characters.map((character) => character.x);
  const initialLeaderSlot = leaderSlotOf(rankVector(initialDistances, ids));
  let previousLeaderSlot = initialLeaderSlot;

  while (state.phase.kind !== 'finished') {
    engine.step();
    state = engine.getState();

    for (const character of state.characters) {
      distances[slotOf.get(character.id) ?? 0] = character.x;
    }
    rankVector(distances, ids, ranks);

    const stepIndex = state.steps - 1;
    for (let slot = 0; slot < characters; slot += 1) {
      history[stepIndex * characters + slot] = ranks[slot] ?? characters;
    }

    const leaderSlot = leaderSlotOf(ranks);
    seenLeaders[leaderSlot] = 1;

    const [first, second] = topTwo(distances);
    const gap = first - second;

    if (leaderSlot !== previousLeaderSlot) {
      // Le règne qui s'achève : s'il s'était détaché d'au moins un seuil, la tête a été perdue après
      // une avance réelle. C'est la définition mesurée d'un « renversement ».
      for (const [index, threshold] of GAP_THRESHOLDS_M.entries()) {
        if (maxGapInReign >= threshold) {
          significantLeadLost[index] = true;
        }
      }
      leaderChanges += 1;
      lastLeaderChangeS = state.tSim;
      previousLeaderSlot = leaderSlot;
      maxGapInReign = gap;
    } else if (gap > maxGapInReign) {
      maxGapInReign = gap;
    }
    if (gap > maxLeadWhileLeadingM) {
      maxLeadWhileLeadingM = gap;
    }

    for (const [index, boundS] of LEADER_BOUNDS_S.entries()) {
      if (boundTaken[index] === true || state.tSim < boundS) {
        continue;
      }
      boundTaken[index] = true;
      leadersAtBounds[index] = ids[leaderSlot] ?? null;
      gapAtBoundsM[index] = gap;
      // Contrôle indépendant : le classement officiel doit désigner le même leader et le même écart.
      if (computeRanks(distances, ids).indexOf(1) !== leaderSlot) {
        rankVerified = false;
      }
    }

    for (const [index, markS] of FINAL_MARKS_S.entries()) {
      if (markTaken[index] === true || state.tSim < markS) {
        continue;
      }
      markTaken[index] = true;
      gapAtMarksM[index] = gap;
    }

    if (state.tSim >= RACE_CONFIG.TOTAL_SIM_S - FINAL_WINDOW_S) {
      if (gap > maxGapFinalWindowM) {
        maxGapFinalWindowM = gap;
      }
      if (gap < minGapFinalWindowM) {
        minGapFinalWindowM = gap;
      }
      for (const [index, threshold] of GAP_THRESHOLDS_M.entries()) {
        if (gap > threshold) {
          closeThroughoutWindow[index] = false;
        }
      }
    }
  }

  const finalRanks = new Array<number>(characters).fill(1);
  for (const character of state.characters) {
    distances[slotOf.get(character.id) ?? 0] = character.x;
  }
  rankVector(distances, ids, finalRanks);
  const winnerSlot = leaderSlotOf(finalRanks);
  const winner = ids[winnerSlot];
  if (winner === undefined) {
    throw new RangeError(`Aucun vainqueur pour la seed « ${seed} ».`);
  }
  if (leadersAtBounds[LEADER_BOUNDS_S.length - 1] !== winner) {
    // L'arrivée **est** la troisième borne : le leader à 60 s et le vainqueur ne peuvent pas diverger.
    rankVerified = false;
  }

  const windowStartGap = gapAtMarksM[0] ?? Number.NaN;
  const finishGap = gapAtBoundsM[LEADER_BOUNDS_S.length - 1] ?? Number.NaN;
  for (const [index, threshold] of GAP_THRESHOLDS_M.entries()) {
    closeAtWindowStart[index] = windowStartGap <= threshold;
    photoAtFinish[index] = finishGap <= threshold;
  }

  const trajectories: CharacterTrajectory[] = [];
  for (let slot = 0; slot < characters; slot += 1) {
    trajectories.push(characterTrajectory(history, state.steps, slot, characters));
  }

  const comeback = raceComebackFlags(trajectories);
  let distinctFromTrajectories = 0;
  for (const trajectory of trajectories) {
    if (trajectory.bestRank === 1) {
      distinctFromTrajectories += 1;
    }
  }
  let seenLeaderCount = 0;
  for (const seen of seenLeaders) {
    seenLeaderCount += seen === 1 ? 1 : 0;
  }
  if (seenLeaderCount !== distinctFromTrajectories) {
    rankVerified = false;
  }

  const participants = engine.participantIds;
  const fieldSizeOk =
    participants.length === SUSPENSE_PLAYERS &&
    participants.every((id, index) => id === CHARACTER_IDS[index]) &&
    state.characters.length === SUSPENSE_PLAYERS;

  // Les métriques « visibles » se relisent sur l'historique complet : le compte brut qu'elles
  // produisent doit être **exactement** celui du suivi pas-à-pas, sinon l'historique est faux.
  const visible = visibleSuspense(
    history,
    state.steps,
    characters,
    DEFAULT_VISIBLE_SUSPENSE_THRESHOLDS,
    initialLeaderSlot,
  );
  const leaderChangesConsistent = visible.changes.rawChanges === leaderChanges;

  return Object.freeze({
    seed,
    players: participants.length,
    steps: state.steps,
    tSim: state.tSim,
    leadersAtBounds: Object.freeze([...leadersAtBounds]),
    winner,
    leaderChanges,
    lastLeaderChangeS,
    gapAtBoundsM: Object.freeze([...gapAtBoundsM]),
    gapAtMarksM: Object.freeze([...gapAtMarksM]),
    maxGapFinalWindowM,
    minGapFinalWindowM: minGapFinalWindowM === Number.POSITIVE_INFINITY ? 0 : minGapFinalWindowM,
    closeAtWindowStart: Object.freeze([...closeAtWindowStart]),
    closeThroughoutWindow: Object.freeze([...closeThroughoutWindow]),
    photoAtFinish: Object.freeze([...photoAtFinish]),
    significantLeadLost: Object.freeze([...significantLeadLost]),
    maxLeadWhileLeadingM,
    comeback,
    trajectories: Object.freeze(trajectories),
    visible,
    leaderChangesConsistent,
    rankVerified,
    fieldSizeOk,
    exactSteps: state.steps === RACE_CONFIG.TOTAL_STEPS,
  });
}

/** Options d'une campagne. */
export interface SuspenseAuditOptions {
  /** Appelé après chaque course : progression, sans polluer le rapport. */
  readonly onRace?: (index: number, total: number) => void;
}

/** Joue le corpus entier, seed par seed, dans l'ordre. */
export function runSuspenseAudit(
  seeds: readonly string[],
  options: SuspenseAuditOptions = {},
): readonly SuspenseRaceAudit[] {
  if (seeds.length === 0) {
    throw new RangeError('runSuspenseAudit : corpus vide.');
  }
  const races: SuspenseRaceAudit[] = [];
  for (const [index, seed] of seeds.entries()) {
    races.push(auditSuspenseRace(seed));
    options.onRace?.(index + 1, seeds.length);
  }
  return Object.freeze(races);
}

// ---------------------------------------------------------------------------------------------
// Synthèse
// ---------------------------------------------------------------------------------------------

/**
 * Test d'**homogénéité** entre les six personnages pour une mesure dont l'espérance n'est pas `1/6`.
 *
 * `characterShares` (de l'audit des leaders) teste une part contre `1/6` du **corpus** : c'est juste
 * pour un vainqueur, dont l'espérance vaut bien un sixième des courses. Ce n'est **pas** juste pour
 * « ce personnage a mené au moins une fois » : la part attendue y vaut 100 % si un seul coureur
 * menait toujours, et environ 70 % ici — parce que plusieurs personnages mènent dans la même course.
 * Comparer ces parts à `1/6` produirait un χ² géant qui ne mesurerait que la définition de la
 * grandeur. Le test correct est donc une homogénéité : les six comptes doivent être compatibles avec
 * une même probabilité `total / 6`.
 */
/**
 * Valeur critique du χ² à 5 % pour 5 degrés de liberté (six personnages), recopiée de la table
 * usuelle — c'est celle qu'utilise déjà l'audit des leaders, pour que les deux outils lisent le même
 * seuil. `degreesOfFreedom` vaut 5 pour les mesures de cet audit.
 */
const CHI_SQUARE_05_DF5 = 11.07;

export interface HomogeneityTest {
  readonly counts: readonly number[];
  /** Somme des comptes. */
  readonly total: number;
  /** Base : nombre de courses du corpus. */
  readonly base: number;
  /** Part de chaque personnage, en pourcentage des courses. */
  readonly shares: readonly number[];
  /** Part attendue si les six personnages sont interchangeables, en pourcentage des courses. */
  readonly expectedShare: number;
  readonly deviations: readonly number[];
  readonly chiSquare: number;
  readonly degreesOfFreedom: number;
  readonly criticalChiSquare05: number;
  readonly maxAbsZ: number;
  readonly maxAbsZCharacter: CharacterId | null;
  readonly uniform: boolean;
}

/** Test d'homogénéité des six comptes, à espérance `total / 6`. */
export function homogeneityTest(counts: readonly number[], base: number): HomogeneityTest {
  if (base <= 0) {
    throw new RangeError('homogeneityTest : base nulle.');
  }
  const total = counts.reduce((sum, value) => sum + value, 0);
  const expected = total / counts.length;
  const shares = counts.map((value) => percentOf(value, base));
  const expectedShare = percentOf(expected, base);
  const deviations = shares.map((share) => share - expectedShare);

  let chiSquare = 0;
  let maxAbsZ = 0;
  let maxAbsZCharacter: CharacterId | null = null;
  // Variance d'une part sous l'hypothèse d'équiprobabilité entre les six modalités, sur `total`
  // observations : `p(1 − p) / total` avec `p = 1/6`.
  const variance = (1 / counts.length) * (1 - 1 / counts.length);

  for (const [index, observed] of counts.entries()) {
    if (expected > 0) {
      const delta = observed - expected;
      chiSquare += (delta * delta) / expected;
    }
    if (total > 0 && variance > 0) {
      const z = (observed / total - 1 / counts.length) / Math.sqrt(variance / total);
      if (Math.abs(z) > maxAbsZ) {
        maxAbsZ = Math.abs(z);
        maxAbsZCharacter = CHARACTER_IDS[index] ?? null;
      }
    }
  }

  const degreesOfFreedom = Math.max(1, counts.length - 1);

  return Object.freeze({
    counts: Object.freeze([...counts]),
    total,
    base,
    shares: Object.freeze(shares),
    expectedShare,
    deviations: Object.freeze(deviations),
    chiSquare,
    degreesOfFreedom,
    criticalChiSquare05: CHI_SQUARE_05_DF5,
    maxAbsZ,
    maxAbsZCharacter,
    uniform: chiSquare <= CHI_SQUARE_05_DF5,
  });
}

/** Persistance du leader, en parts du corpus. */
export interface LeaderPersistence {
  readonly sameLeaderAllBounds: number;
  readonly sameLeaderAllBoundsPercent: number;
  readonly exactlyTwoLeaders: number;
  readonly exactlyTwoLeadersPercent: number;
  readonly threeDistinctLeaders: number;
  readonly threeDistinctLeadersPercent: number;
  readonly leader20EqualsLeader40: number;
  readonly leader20EqualsLeader40Percent: number;
  readonly leader40EqualsWinner: number;
  readonly leader40EqualsWinnerPercent: number;
  readonly leader20EqualsWinner: number;
  readonly leader20EqualsWinnerPercent: number;
}

/** Statistiques des changements de leader. */
export interface LeaderChangeStats {
  readonly mean: number;
  readonly min: number;
  readonly max: number;
  readonly median: number;
  readonly p10: number;
  readonly p90: number;
}

/** Nombre de personnages différents ayant mené au moins une fois dans une course. */
export interface DistinctLeaderStats {
  readonly mean: number;
  /** `histogram[k − 1]` : nombre de courses à `k` leaders distincts, pour `k` de 1 à 6. */
  readonly histogram: readonly number[];
  /** Part des courses où les **six** coureurs ont mené au moins une fois. */
  readonly allSixLeadPercent: number;
}

/** Moment du dernier changement de leader. */
export interface LastChangeStats {
  readonly mean: number;
  readonly median: number;
  readonly p10: number;
  readonly p90: number;
  /** Parts des courses dont le dernier changement tombe dans les N dernières secondes. */
  readonly withinWindowPercent: readonly number[];
}

/** Remontées, par personnage puis par course. */
export interface ComebackStats {
  readonly perCharacter: readonly CharacterComebackStats[];
  /** Part des courses où un personnage a été dernier puis atteint au moins le top 3. */
  readonly toTop3Percent: number;
  readonly toTop2Percent: number;
  readonly toFirstPercent: number;
  readonly toTop3WithoutWinPercent: number;
  /** Remontée maximale d'une course, en places : moyenne et dispersion. */
  readonly maxGainPlacesMean: number;
  readonly maxGainPlacesMedian: number;
  readonly maxGainPlacesP10: number;
  readonly maxGainPlacesP90: number;
  /** Remontée maximale moyenne par personnage, tous personnages confondus. */
  readonly maxGainPlacesPerCharacterMean: number;
}

/** Remontées d'un personnage, agrégées sur le corpus. */
export interface CharacterComebackStats {
  readonly id: CharacterId;
  /** Rang moyen du meilleur rang atteint dans la course (plus petit = meilleur). */
  readonly meanBestRank: number;
  readonly meanWorstRank: number;
  /** Part des courses où le personnage a mené au moins une fois. */
  readonly everLedPercent: number;
  /** Part des courses où le personnage a occupé le dernier rang au moins une fois. */
  readonly everLastPercent: number;
  /** Remontée maximale moyenne, en places. */
  readonly meanMaxGain: number;
  /** Courses où le personnage a été dernier au moins une fois. */
  readonly wasLastRaces: number;
  /** Meilleur rang atteint après avoir été dernier, en moyenne sur ces courses. */
  readonly meanBestRankAfterLastPlace: number | null;
}

/** Renversements mesurés. */
export interface UpsetStats {
  readonly leader20LosesPercent: number;
  readonly leader40LosesPercent: number;
  /** Part des courses où le leader a perdu la tête après au moins ce seuil d'avance, par seuil. */
  readonly significantLeadLostPercent: readonly number[];
  /** Plus grande avance moyenne d'un leader pendant son règne, en mètres. */
  readonly meanMaxLeadWhileLeadingM: number;
  /** Le vainqueur a-t-il été 4e ou pire, 5e ou pire, ou dernier ? */
  readonly winnerOutsideTop3Percent: number;
  readonly winnerOutsideTop4Percent: number;
  readonly winnerLastPercent: number;
}

/** Suspense final : écarts P1–P2 et courses encore serrées. */
export interface FinalSuspenseStats {
  readonly gapAtBounds: readonly GapSummary[];
  readonly gapAtMarks: readonly GapSummary[];
  /** Par seuil : part des courses encore serrées à l'entrée de la fenêtre finale. */
  readonly closeAtWindowStartPercent: readonly number[];
  /** Par seuil : part des courses restées serrées pendant toute la fenêtre finale. */
  readonly closeThroughoutWindowPercent: readonly number[];
  /** Par seuil : part des courses dont l'écart à l'arrivée est sous le seuil (photo-finish). */
  readonly photoAtFinishPercent: readonly number[];
  /** Part des courses où le dernier changement de leader tombe dans la fenêtre finale. */
  readonly leaderChangeInWindowPercent: number;
}

/** Contrôles structurels du corpus audité. */
export interface SuspenseCorpusCheck {
  readonly seeds: number;
  readonly distinctSeeds: number;
  readonly players: number;
  readonly exactSteps: boolean;
  readonly finishedAtTotalSimS: boolean;
  readonly rankVerifiedEverywhere: boolean;
  readonly fieldSizeEverywhere: boolean;
  /** Le compte brut relu dans l'historique concorde-t-il avec le compteur pas-à-pas, partout ? */
  readonly leaderChangesConsistentEverywhere: boolean;
}

/**
 * Changements de leader **bruts** contre **visibles** — la comparaison qui dit si le chiffre brut
 * mesure des rebondissements ou du bruit de peloton.
 */
export interface VisibleLeaderChangeStats {
  readonly rawMean: number;
  readonly visibleMean: number;
  readonly microMean: number;
  /** Part des changements bruts qui sont visibles (règne ≥ 1 s). */
  readonly visibleSharePercent: number;
  readonly racesWithVisibleChangePercent: number;
  readonly racesWithoutVisibleChangePercent: number;
  /** Part des courses avec au moins un changement visible dans les 10 dernières secondes. */
  readonly visibleInFinalWindowPercent: number;
}

/** Remontées **qualifiées** par une durée, par opposition aux remontées brutes d'un seul pas. */
export interface QualifiedComebackStats {
  /** Au moins un personnage est resté dernier ≥ 2 s d'affilée. */
  readonly heldLastTwoSecondsPercent: number;
  readonly longestLastStreakStepsMean: number;
  readonly longestLastStreakStepsMedian: number;
  readonly longestLastStreakStepsP90: number;
  /** Dernier ≥ 2 s d'affilée, puis top 3 **sans** gagner. */
  readonly lastStreakToTop3WithoutWinPercent: number;
  /** 5e ou 6e au relevé de 40 s, puis top 3 à l'arrivée. */
  readonly at40FifthOrSixthToTop3Percent: number;
  /** 5e ou 6e à 40 s, puis vainqueur. */
  readonly at40FifthOrSixthToWinPercent: number;
  readonly leader40LosesLeadAfter50Percent: number;
  readonly leader40StillLeadsAt50Percent: number;
}

/** Une comparaison à une mesure publiée de l'audit précédent. */
export interface SuspenseReferenceCheck {
  readonly id: string;
  readonly label: string;
  readonly reference: string;
  readonly measured: string;
  /**
   * Vrai quand le corpus audité est bien celui des références (10 000 seeds).
   *
   * Les valeurs publiées ont été mesurées sur ce corpus **exact**. Sur un sous-corpus, un écart ne
   * dit rien du jeu : il ne dit que la dispersion d'échantillonnage. Une comparaison non comparable
   * est donc **indicative**, jamais une anomalie.
   */
  readonly comparable: boolean;
  readonly reproduced: boolean;
}

/** Une des cinq métriques mises en avant. */
export interface SpotlightMetric {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly previousAudit: string;
  readonly note: string;
}

/** Synthèse complète : tout ce que les rapports publient. */
export interface SuspenseAuditSummary {
  readonly players: number;
  readonly seeds: number;
  readonly boundsS: readonly number[];
  readonly boundLabels: readonly string[];
  readonly marksS: readonly number[];
  readonly gapThresholdsM: readonly number[];
  readonly gapThresholdLabels: readonly string[];
  readonly leadersPerBound: readonly CharacterShares[];
  readonly winnerShares: CharacterShares;
  /** Part des courses où chaque personnage a mené au moins une fois (test d'homogénéité). */
  readonly everLedShares: HomogeneityTest;
  readonly persistence: LeaderPersistence;
  readonly leaderChanges: LeaderChangeStats;
  readonly distinctLeaders: DistinctLeaderStats;
  readonly lastChange: LastChangeStats;
  readonly comebacks: ComebackStats;
  readonly upsets: UpsetStats;
  readonly finalSuspense: FinalSuspenseStats;
  /** Brut contre visible : la mesure qui dit si le suspense brut est perceptible. */
  readonly visibleChanges: VisibleLeaderChangeStats;
  /** Remontées qualifiées par une durée minimale au dernier rang. */
  readonly qualifiedComebacks: QualifiedComebackStats;
  readonly corpus: SuspenseCorpusCheck;
  readonly references: readonly SuspenseReferenceCheck[];
  readonly reproducibility: { readonly seeds: number; readonly identical: number };
  readonly spotlight: readonly SpotlightMetric[];
}

/** Moyenne d'une série, `0` si elle est vide. */
function meanOf(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  let sum = 0;
  for (const value of values) {
    sum += value;
  }
  return sum / values.length;
}

/** Part en pourcentage, `0` si le corpus est vide. */
function percentOf(count: number, total: number): number {
  return total === 0 ? 0 : (count / total) * 100;
}

/** Agrège un corpus déjà audité. Refuse tout effectif autre que six. */
export function summarizeSuspenseAudit(
  races: readonly SuspenseRaceAudit[],
  options: {
    readonly reproducibility?: { readonly seeds: number; readonly identical: number };
  } = {},
): SuspenseAuditSummary {
  if (races.length === 0) {
    throw new RangeError('summarizeSuspenseAudit : corpus vide.');
  }
  const first = races[0];
  if (first === undefined) {
    throw new RangeError('summarizeSuspenseAudit : corpus vide.');
  }
  if (first.players !== SUSPENSE_PLAYERS) {
    throw new RangeError(
      `summarizeSuspenseAudit : cet audit ne mesure que les courses à ${String(SUSPENSE_PLAYERS)} coureurs (reçu : ${String(first.players)}).`,
    );
  }

  const total = races.length;
  const ids = CHARACTER_IDS;
  const characters = ids.length;

  const leaderCountsPerBound = LEADER_BOUNDS_S.map(() => new Array<number>(characters).fill(0));
  const winnerCounts = new Array<number>(characters).fill(0);
  const everLedCounts = new Array<number>(characters).fill(0);
  const changeValues: number[] = [];
  const distinctValues: number[] = [];
  const distinctHistogram = new Array<number>(characters).fill(0);
  const lastChangeValues: number[] = [];
  const lastChangeWithinCounts = LAST_CHANGE_WINDOWS_S.map(() => 0);
  const comebackPerRace: number[] = [];
  const gapAtBounds: number[][] = LEADER_BOUNDS_S.map(() => []);
  const gapAtMarks: number[][] = FINAL_MARKS_S.map(() => []);
  const closeStartCounts = GAP_THRESHOLDS_M.map(() => 0);
  const closeWindowCounts = GAP_THRESHOLDS_M.map(() => 0);
  const photoCounts = GAP_THRESHOLDS_M.map(() => 0);
  const significantLeadLostCounts = GAP_THRESHOLDS_M.map(() => 0);

  const sumBestRank = new Array<number>(characters).fill(0);
  const sumWorstRank = new Array<number>(characters).fill(0);
  const sumMaxGain = new Array<number>(characters).fill(0);
  const sumBestAfterLast = new Array<number>(characters).fill(0);
  const wasLastCounts = new Array<number>(characters).fill(0);
  const everLastCounts = new Array<number>(characters).fill(0);

  let sameLeaderAllBounds = 0;
  let exactlyTwoLeaders = 0;
  let threeDistinctLeaders = 0;
  let leader20EqualsLeader40 = 0;
  let leader40EqualsWinner = 0;
  let leader20EqualsWinner = 0;
  let comebackToTop3 = 0;
  let comebackToTop2 = 0;
  let comebackToFirst = 0;
  let comebackToTop3WithoutWin = 0;
  let winnerOutsideTop3 = 0;
  let winnerOutsideTop4 = 0;
  let winnerLast = 0;
  let allSixLead = 0;
  let leaderChangeInWindow = 0;
  let meanMaxLeadSum = 0;
  let rankVerifiedEverywhere = true;
  let fieldSizeEverywhere = true;
  let exactStepsEverywhere = true;
  let finishedAtTotalSimS = true;
  let leaderChangesConsistentEverywhere = true;
  const visibleChangeValues: number[] = [];
  const microChangeValues: number[] = [];
  const longestStreakValues: number[] = [];
  let racesWithVisibleChange = 0;
  let racesWithoutVisibleChange = 0;
  let visibleInFinalWindow = 0;
  let heldLastTwoSeconds = 0;
  let lastStreakToTop3WithoutWin = 0;
  let at40FifthOrSixthToTop3 = 0;
  let at40FifthOrSixthToWin = 0;
  let leader40LosesLeadAfter50 = 0;
  let leader40StillLeadsAt50 = 0;
  let rawChangesTotal = 0;
  let visibleChangesTotal = 0;
  const seedSet = new Set<string>();

  for (const race of races) {
    seedSet.add(race.seed);
    for (const [boundIndex, leader] of race.leadersAtBounds.entries()) {
      if (leader === null) {
        continue;
      }
      const slot = ids.indexOf(leader);
      const counts = leaderCountsPerBound[boundIndex];
      if (slot >= 0 && counts !== undefined) {
        counts[slot] = (counts[slot] ?? 0) + 1;
      }
    }
    const winnerSlot = ids.indexOf(race.winner);
    if (winnerSlot >= 0) {
      winnerCounts[winnerSlot] = (winnerCounts[winnerSlot] ?? 0) + 1;
    }

    const distinct = race.trajectories.filter((trajectory) => trajectory.bestRank === 1).length;
    distinctValues.push(distinct);
    if (distinct >= 1) {
      distinctHistogram[distinct - 1] = (distinctHistogram[distinct - 1] ?? 0) + 1;
    }
    if (distinct === characters) {
      allSixLead += 1;
    }

    for (const [slot, trajectory] of race.trajectories.entries()) {
      if (trajectory.bestRank === 1) {
        everLedCounts[slot] = (everLedCounts[slot] ?? 0) + 1;
      }
      if (trajectory.wasLast) {
        everLastCounts[slot] = (everLastCounts[slot] ?? 0) + 1;
        wasLastCounts[slot] = (wasLastCounts[slot] ?? 0) + 1;
        sumBestAfterLast[slot] =
          (sumBestAfterLast[slot] ?? 0) + (trajectory.bestRankAfterLastPlace ?? characters);
      }
      sumBestRank[slot] = (sumBestRank[slot] ?? 0) + trajectory.bestRank;
      sumWorstRank[slot] = (sumWorstRank[slot] ?? 0) + trajectory.worstRank;
      sumMaxGain[slot] = (sumMaxGain[slot] ?? 0) + trajectory.maxGain;
    }

    const [at20, at40, at60] = race.leadersAtBounds;
    const distinctBounds = new Set(
      race.leadersAtBounds.filter((leader): leader is CharacterId => leader !== null),
    ).size;
    if (distinctBounds === 1) {
      sameLeaderAllBounds += 1;
    } else if (distinctBounds === 2) {
      exactlyTwoLeaders += 1;
    } else if (distinctBounds === 3) {
      threeDistinctLeaders += 1;
    }
    if (at20 !== undefined && at20 !== null && at20 === at40) {
      leader20EqualsLeader40 += 1;
    }
    if (at40 !== undefined && at40 !== null && at40 === at60) {
      leader40EqualsWinner += 1;
    }
    if (at20 !== undefined && at20 !== null && at20 === at60) {
      leader20EqualsWinner += 1;
    }

    changeValues.push(race.leaderChanges);
    lastChangeValues.push(race.lastLeaderChangeS);
    for (const [index, windowS] of LAST_CHANGE_WINDOWS_S.entries()) {
      if (race.lastLeaderChangeS >= RACE_CONFIG.TOTAL_SIM_S - windowS) {
        lastChangeWithinCounts[index] = (lastChangeWithinCounts[index] ?? 0) + 1;
      }
    }
    if (race.lastLeaderChangeS >= RACE_CONFIG.TOTAL_SIM_S - FINAL_WINDOW_S) {
      leaderChangeInWindow += 1;
    }

    comebackPerRace.push(race.comeback.maxGainPlaces);
    if (race.comeback.toTop3) {
      comebackToTop3 += 1;
    }
    if (race.comeback.toTop2) {
      comebackToTop2 += 1;
    }
    if (race.comeback.toFirst) {
      comebackToFirst += 1;
    }
    if (race.comeback.toTop3WithoutWin) {
      comebackToTop3WithoutWin += 1;
    }

    for (const [index, gap] of race.gapAtBoundsM.entries()) {
      (gapAtBounds[index] ?? []).push(gap);
    }
    for (const [index, gap] of race.gapAtMarksM.entries()) {
      (gapAtMarks[index] ?? []).push(gap);
    }
    for (const [index] of GAP_THRESHOLDS_M.entries()) {
      if (race.closeAtWindowStart[index] === true) {
        closeStartCounts[index] = (closeStartCounts[index] ?? 0) + 1;
      }
      if (race.closeThroughoutWindow[index] === true) {
        closeWindowCounts[index] = (closeWindowCounts[index] ?? 0) + 1;
      }
      if (race.photoAtFinish[index] === true) {
        photoCounts[index] = (photoCounts[index] ?? 0) + 1;
      }
      if (race.significantLeadLost[index] === true) {
        significantLeadLostCounts[index] = (significantLeadLostCounts[index] ?? 0) + 1;
      }
    }

    meanMaxLeadSum += race.maxLeadWhileLeadingM;
    if (winnerSlot >= 0) {
      const winnerTrajectory = race.trajectories[winnerSlot];
      if (winnerTrajectory !== undefined) {
        if (winnerTrajectory.worstRank >= 4) {
          winnerOutsideTop3 += 1;
        }
        if (winnerTrajectory.worstRank >= 5) {
          winnerOutsideTop4 += 1;
        }
        if (winnerTrajectory.worstRank === characters) {
          winnerLast += 1;
        }
      }
    }

    // Métriques « visibles » : brut contre qualifié par une durée.
    rawChangesTotal += race.visible.changes.rawChanges;
    visibleChangesTotal += race.visible.changes.visibleChanges;
    visibleChangeValues.push(race.visible.changes.visibleChanges);
    microChangeValues.push(race.visible.changes.microChanges);
    longestStreakValues.push(race.visible.longestLastStreakSteps);
    if (race.visible.changes.visibleChanges > 0) {
      racesWithVisibleChange += 1;
    } else {
      racesWithoutVisibleChange += 1;
    }
    if (race.visible.changes.visibleInFinalWindow) {
      visibleInFinalWindow += 1;
    }
    if (race.visible.heldLastTwoSeconds) {
      heldLastTwoSeconds += 1;
    }
    if (race.visible.lastStreakToTop3WithoutWin) {
      lastStreakToTop3WithoutWin += 1;
    }
    if (race.visible.at40FifthOrSixthToTop3) {
      at40FifthOrSixthToTop3 += 1;
    }
    if (race.visible.at40FifthOrSixthToWin) {
      at40FifthOrSixthToWin += 1;
    }
    if (race.visible.leader40LosesLeadAfter50) {
      leader40LosesLeadAfter50 += 1;
    }
    if (race.visible.leader40StillLeadsAt50) {
      leader40StillLeadsAt50 += 1;
    }

    rankVerifiedEverywhere = rankVerifiedEverywhere && race.rankVerified;
    fieldSizeEverywhere = fieldSizeEverywhere && race.fieldSizeOk;
    exactStepsEverywhere = exactStepsEverywhere && race.exactSteps;
    finishedAtTotalSimS = finishedAtTotalSimS && race.tSim === RACE_CONFIG.TOTAL_SIM_S;
    leaderChangesConsistentEverywhere =
      leaderChangesConsistentEverywhere && race.leaderChangesConsistent;
  }

  const persistence: LeaderPersistence = Object.freeze({
    sameLeaderAllBounds,
    sameLeaderAllBoundsPercent: percentOf(sameLeaderAllBounds, total),
    exactlyTwoLeaders,
    exactlyTwoLeadersPercent: percentOf(exactlyTwoLeaders, total),
    threeDistinctLeaders,
    threeDistinctLeadersPercent: percentOf(threeDistinctLeaders, total),
    leader20EqualsLeader40,
    leader20EqualsLeader40Percent: percentOf(leader20EqualsLeader40, total),
    leader40EqualsWinner,
    leader40EqualsWinnerPercent: percentOf(leader40EqualsWinner, total),
    leader20EqualsWinner,
    leader20EqualsWinnerPercent: percentOf(leader20EqualsWinner, total),
  });

  const perCharacter: CharacterComebackStats[] = ids.map((id, slot) => {
    const wasLast = wasLastCounts[slot] ?? 0;
    return Object.freeze({
      id,
      meanBestRank: (sumBestRank[slot] ?? 0) / total,
      meanWorstRank: (sumWorstRank[slot] ?? 0) / total,
      everLedPercent: percentOf(everLedCounts[slot] ?? 0, total),
      everLastPercent: percentOf(everLastCounts[slot] ?? 0, total),
      meanMaxGain: (sumMaxGain[slot] ?? 0) / total,
      wasLastRaces: wasLast,
      meanBestRankAfterLastPlace: wasLast === 0 ? null : (sumBestAfterLast[slot] ?? 0) / wasLast,
    });
  });

  const reproducibility = options.reproducibility ?? { seeds: 0, identical: 0 };
  const referenceComparisons = referenceChecks(persistence, meanOf(changeValues), total);

  const summary: SuspenseAuditSummary = {
    players: SUSPENSE_PLAYERS,
    seeds: total,
    boundsS: LEADER_BOUNDS_S,
    boundLabels: LEADER_BOUND_LABELS,
    marksS: FINAL_MARKS_S,
    gapThresholdsM: GAP_THRESHOLDS_M,
    gapThresholdLabels: GAP_THRESHOLD_LABELS,
    leadersPerBound: Object.freeze(
      leaderCountsPerBound.map((counts) => characterShares(counts, total)),
    ),
    winnerShares: characterShares(winnerCounts, total),
    everLedShares: homogeneityTest(everLedCounts, total),
    persistence,
    leaderChanges: Object.freeze({
      mean: meanOf(changeValues),
      min: Math.min(...changeValues),
      max: Math.max(...changeValues),
      median: quantile(changeValues, 0.5),
      p10: quantile(changeValues, 0.1),
      p90: quantile(changeValues, 0.9),
    }),
    distinctLeaders: Object.freeze({
      mean: meanOf(distinctValues),
      histogram: Object.freeze([...distinctHistogram]),
      allSixLeadPercent: percentOf(allSixLead, total),
    }),
    lastChange: Object.freeze({
      mean: meanOf(lastChangeValues),
      median: quantile(lastChangeValues, 0.5),
      p10: quantile(lastChangeValues, 0.1),
      p90: quantile(lastChangeValues, 0.9),
      withinWindowPercent: Object.freeze(
        lastChangeWithinCounts.map((count) => percentOf(count, total)),
      ),
    }),
    comebacks: Object.freeze({
      perCharacter: Object.freeze(perCharacter),
      toTop3Percent: percentOf(comebackToTop3, total),
      toTop2Percent: percentOf(comebackToTop2, total),
      toFirstPercent: percentOf(comebackToFirst, total),
      toTop3WithoutWinPercent: percentOf(comebackToTop3WithoutWin, total),
      maxGainPlacesMean: meanOf(comebackPerRace),
      maxGainPlacesMedian: quantile(comebackPerRace, 0.5),
      maxGainPlacesP10: quantile(comebackPerRace, 0.1),
      maxGainPlacesP90: quantile(comebackPerRace, 0.9),
      maxGainPlacesPerCharacterMean: meanOf(
        perCharacter.map((character) => character.meanMaxGain),
      ),
    }),
    upsets: Object.freeze({
      leader20LosesPercent: percentOf(total - leader20EqualsWinner, total),
      leader40LosesPercent: percentOf(total - leader40EqualsWinner, total),
      significantLeadLostPercent: Object.freeze(
        significantLeadLostCounts.map((count) => percentOf(count, total)),
      ),
      meanMaxLeadWhileLeadingM: meanMaxLeadSum / total,
      winnerOutsideTop3Percent: percentOf(winnerOutsideTop3, total),
      winnerOutsideTop4Percent: percentOf(winnerOutsideTop4, total),
      winnerLastPercent: percentOf(winnerLast, total),
    }),
    finalSuspense: Object.freeze({
      gapAtBounds: Object.freeze(gapAtBounds.map((values) => gapSummary(values))),
      gapAtMarks: Object.freeze(gapAtMarks.map((values) => gapSummary(values))),
      closeAtWindowStartPercent: Object.freeze(
        closeStartCounts.map((count) => percentOf(count, total)),
      ),
      closeThroughoutWindowPercent: Object.freeze(
        closeWindowCounts.map((count) => percentOf(count, total)),
      ),
      photoAtFinishPercent: Object.freeze(photoCounts.map((count) => percentOf(count, total))),
      leaderChangeInWindowPercent: percentOf(leaderChangeInWindow, total),
    }),
    visibleChanges: Object.freeze({
      rawMean: total === 0 ? 0 : rawChangesTotal / total,
      visibleMean: meanOf(visibleChangeValues),
      microMean: meanOf(microChangeValues),
      visibleSharePercent:
        rawChangesTotal === 0 ? 0 : percentOf(visibleChangesTotal, rawChangesTotal),
      racesWithVisibleChangePercent: percentOf(racesWithVisibleChange, total),
      racesWithoutVisibleChangePercent: percentOf(racesWithoutVisibleChange, total),
      visibleInFinalWindowPercent: percentOf(visibleInFinalWindow, total),
    }),
    qualifiedComebacks: Object.freeze({
      heldLastTwoSecondsPercent: percentOf(heldLastTwoSeconds, total),
      longestLastStreakStepsMean: meanOf(longestStreakValues),
      longestLastStreakStepsMedian: quantile(longestStreakValues, 0.5),
      longestLastStreakStepsP90: quantile(longestStreakValues, 0.9),
      lastStreakToTop3WithoutWinPercent: percentOf(lastStreakToTop3WithoutWin, total),
      at40FifthOrSixthToTop3Percent: percentOf(at40FifthOrSixthToTop3, total),
      at40FifthOrSixthToWinPercent: percentOf(at40FifthOrSixthToWin, total),
      leader40LosesLeadAfter50Percent: percentOf(leader40LosesLeadAfter50, total),
      leader40StillLeadsAt50Percent: percentOf(leader40StillLeadsAt50, total),
    }),
    corpus: Object.freeze({
      seeds: total,
      distinctSeeds: seedSet.size,
      players: SUSPENSE_PLAYERS,
      exactSteps: exactStepsEverywhere,
      finishedAtTotalSimS,
      rankVerifiedEverywhere,
      fieldSizeEverywhere,
      leaderChangesConsistentEverywhere,
    }),
    references: referenceComparisons,
    reproducibility: Object.freeze({ ...reproducibility }),
    spotlight: Object.freeze([]),
  };

  return Object.freeze({ ...summary, spotlight: spotlightMetrics(summary) });
}

/**
 * Comparaison aux mesures publiées de l'audit des leaders, sur le **même** corpus.
 *
 * Ce sont des contrôles d'instrument : le corpus est déterministe, donc une divergence signalerait
 * que l'audit de suspense ne rejoue pas les mêmes courses, pas que le jeu a changé.
 */
export function referenceChecks(
  persistence: LeaderPersistence,
  leaderChangesMean: number,
  seeds: number,
): readonly SuspenseReferenceCheck[] {
  const checks: readonly {
    readonly id: string;
    readonly label: string;
    readonly reference: number;
    readonly measured: number;
    readonly digits: number;
    /** Taille du corpus sur lequel la valeur publiée a été mesurée. */
    readonly referenceSeeds: number;
    readonly percent: boolean;
  }[] = [
    {
      id: 'same-leader-all-bounds',
      label: 'Même leader aux 3 bornes',
      reference: SUSPENSE_REFERENCES.sameLeaderAllBoundsPercent,
      measured: persistence.sameLeaderAllBoundsPercent,
      digits: 2,
      referenceSeeds: SUSPENSE_REFERENCES.seeds,
      percent: true,
    },
    {
      id: 'exactly-two-leaders',
      label: 'Exactement 2 leaders distincts',
      reference: SUSPENSE_REFERENCES.exactlyTwoLeadersPercent,
      measured: persistence.exactlyTwoLeadersPercent,
      digits: 2,
      referenceSeeds: SUSPENSE_REFERENCES.seeds,
      percent: true,
    },
    {
      id: 'three-leaders',
      label: '3 leaders distincts',
      reference: SUSPENSE_REFERENCES.threeDistinctLeadersPercent,
      measured: persistence.threeDistinctLeadersPercent,
      digits: 2,
      referenceSeeds: SUSPENSE_REFERENCES.seeds,
      percent: true,
    },
    {
      id: 'leader-20-eq-40',
      label: 'Leader 20 s = 40 s',
      reference: SUSPENSE_REFERENCES.leader20EqualsLeader40Percent,
      measured: persistence.leader20EqualsLeader40Percent,
      digits: 2,
      referenceSeeds: SUSPENSE_REFERENCES.seeds,
      percent: true,
    },
    {
      id: 'leader-40-wins',
      label: 'Leader 40 s vainqueur',
      reference: SUSPENSE_REFERENCES.leader40EqualsWinnerPercent,
      measured: persistence.leader40EqualsWinnerPercent,
      digits: 2,
      referenceSeeds: SUSPENSE_REFERENCES.seeds,
      percent: true,
    },
    {
      id: 'leader-20-wins',
      label: 'Leader 20 s vainqueur',
      reference: SUSPENSE_REFERENCES.leader20EqualsWinnerPercent,
      measured: persistence.leader20EqualsWinnerPercent,
      digits: 2,
      referenceSeeds: SUSPENSE_REFERENCES.seeds,
      percent: true,
    },
    {
      id: 'leader-changes-mean',
      label: `Changements de leader (moyenne, ${String(SUSPENSE_REFERENCES.seeds)} seeds)`,
      reference: SUSPENSE_REFERENCES.leaderChangesMean,
      measured: leaderChangesMean,
      digits: 3,
      referenceSeeds: SUSPENSE_REFERENCES.seeds,
      percent: false,
    },
    {
      id: 'leader-changes-mean-1000',
      label: 'Changements de leader (moyenne, 1 000 seeds)',
      reference: SUSPENSE_REFERENCES.leaderChangesMeanAt1000Seeds,
      measured: leaderChangesMean,
      digits: 3,
      referenceSeeds: 1_000,
      percent: false,
    },
  ];

  return Object.freeze(
    checks.map((check) => {
      // Les valeurs publiées sont arrondies : la comparaison se fait au dernier chiffre publié.
      const epsilon = check.digits === 2 ? 0.01 : 0.001;
      const comparable = seeds === check.referenceSeeds;
      const suffix = check.percent ? ' %' : '';
      return Object.freeze({
        id: check.id,
        label: check.label,
        reference: `${decimal(check.reference, check.digits)}${suffix}`,
        measured: `${decimal(check.measured, check.digits)}${suffix}`,
        comparable,
        reproduced: comparable && Math.abs(check.measured - check.reference) < epsilon,
      });
    }),
  );
}

/**
 * Les cinq métriques les plus révélatrices du suspense, mises en avant avec leur valeur.
 *
 * Le choix est **documenté** : il couvre les trois questions du design — le leader tient-il trop
 * longtemps (1, 2), la course change-t-elle de main assez tard (3), un retardé peut-il revenir (4),
 * et le final est-il disputé (5). L'outil publie les valeurs et la mesure équivalente de l'audit
 * précédent ; il ne tranche pas à leur place.
 */
export function spotlightMetrics(summary: SuspenseAuditSummary): readonly SpotlightMetric[] {
  const reference = (id: string): string =>
    summary.references.find((check) => check.id === id)?.reference ?? '—';
  const finalWindowIndex = Math.max(0, summary.gapThresholdsM.indexOf(FACT.CLOSE_RACE_MAX_GAP_M));

  return Object.freeze([
    Object.freeze({
      id: 'leader-20-wins',
      label: 'Leader à 20 s vainqueur',
      value: percent(summary.persistence.leader20EqualsWinnerPercent),
      previousAudit: reference('leader-20-wins'),
      note: 'le plus tôt un spectateur peut croire à une issue, le plus tôt elle est jouée',
    }),
    Object.freeze({
      id: 'same-leader-all-bounds',
      label: 'Même leader aux 3 bornes',
      value: percent(summary.persistence.sameLeaderAllBoundsPercent),
      previousAudit: reference('same-leader-all-bounds'),
      note: 'une tête qui ne change jamais = aucun rebondissement aux checkpoints',
    }),
    Object.freeze({
      id: 'last-change-within-10s',
      label: 'Dernier changement de leader dans les 10 dernières secondes',
      value: percent(summary.lastChange.withinWindowPercent[1] ?? 0),
      previousAudit: 'non mesuré',
      note: 'mesure directe du « ça se décide à la fin »',
    }),
    Object.freeze({
      id: 'last-to-top3',
      label: 'Dernier à un instant puis top 3',
      value: percent(summary.comebacks.toTop3Percent),
      previousAudit: 'non mesuré',
      note: 'la remontée spectaculaire est-elle possible sans boost dédié ?',
    }),
    Object.freeze({
      id: 'close-race-throughout-final-window',
      label: `Deux premiers serrés (< ${String(FACT.CLOSE_RACE_MAX_GAP_M)} m) sur toute la fenêtre finale`,
      value: percent(summary.finalSuspense.closeThroughoutWindowPercent[finalWindowIndex] ?? 0),
      previousAudit: 'non mesuré',
      note: `écart P1–P2 médian à ${String(FINAL_MARKS_S[0])} s : ${summary.finalSuspense.gapAtMarks[0] === undefined ? '—' : decimal(summary.finalSuspense.gapAtMarks[0].median)} m`,
    }),
  ]);
}

// ---------------------------------------------------------------------------------------------
// Rapports
// ---------------------------------------------------------------------------------------------

/** Formate un nombre avec une virgule décimale, comme les autres rapports français du projet. */
function decimal(value: number, digits = 2): string {
  return value.toFixed(digits).replace('.', ',');
}

/** Formate une part (0 à 100) en pourcentage. */
function percent(value: number): string {
  return `${decimal(value)} %`;
}

/** Ligne d'une table de parts par personnage. */
function shareRow(label: string, shares: CharacterShares, total: number): string {
  const parts = CHARACTER_IDS.map((id, index) => {
    const share = shares.shares[index] ?? 0;
    const deviation = shares.deviations[index] ?? 0;
    return `${id} ${decimal(share)} % (${deviation >= 0 ? '+' : ''}${decimal(deviation)})`;
  });
  return `${label.padEnd(10)}${String(total).padStart(7)}  ${parts.join(' | ')}`;
}

/** Ligne de synthèse d'un écart : min, p10, médiane, p90, max, moyenne. */
function gapRow(label: string, gap: GapSummary): string {
  return (
    `${label.padEnd(12)} min ${decimal(gap.min).padStart(6)} | p10 ${decimal(gap.p10).padStart(6)} | ` +
    `médiane ${decimal(gap.median).padStart(6)} | p90 ${decimal(gap.p90).padStart(6)} | ` +
    `max ${decimal(gap.max).padStart(7)} | moyenne ${decimal(gap.mean).padStart(6)} m`
  );
}

/** Rapport texte, destiné à l'humain. */
export function renderSuspenseAuditText(summary: SuspenseAuditSummary, elapsedMs: number): string {
  const lines: string[] = [];

  lines.push('Chaos Race — audit de suspense (courses à 6 coureurs)');
  lines.push(
    `corpus : ${String(summary.seeds)} seeds déterministes « ${DEFAULT_AUDIT_CORPUS} » | effectif ${String(summary.players)} | ` +
      `bornes ${summary.boundLabels.join(' / ')} | DT = ${String(RACE_CONFIG.DT_S)} s | ${String(RACE_CONFIG.TOTAL_STEPS)} pas par course`,
  );
  lines.push(
    `durée : ${decimal(elapsedMs / 1000, 1)} s (${decimal(elapsedMs / summary.seeds, 2)} ms/course) — aucun paramètre de jeu modifié`,
  );

  lines.push('');
  lines.push('=== 1. Leader aux bornes (état réel du noyau, pas le speaker) ===');
  lines.push(`${'borne'.padEnd(10)}${'courses'.padStart(7)}  ${CHARACTER_IDS.join(' | ')}`);
  for (const [boundIndex, shares] of summary.leadersPerBound.entries()) {
    lines.push(shareRow(summary.boundLabels[boundIndex] ?? '?', shares, summary.seeds));
  }
  lines.push(shareRow('vainqueur', summary.winnerShares, summary.seeds));
  lines.push(
    `χ² vainqueur = ${decimal(summary.winnerShares.chiSquare)} (seuil 5 % : ${decimal(summary.winnerShares.criticalChiSquare05)}) | ` +
      `max |z| = ${decimal(summary.winnerShares.maxAbsZ)} (${summary.winnerShares.maxAbsZCharacter ?? '—'}) → ` +
      `${summary.winnerShares.uniform ? 'uniforme' : 'NON UNIFORME'}`,
  );
  const persistence = summary.persistence;
  lines.push(
    `même leader aux 3 bornes : ${percent(persistence.sameLeaderAllBoundsPercent)} | ` +
      `exactement 2 leaders distincts : ${percent(persistence.exactlyTwoLeadersPercent)} | ` +
      `3 leaders distincts : ${percent(persistence.threeDistinctLeadersPercent)}`,
  );
  lines.push(
    `leader 20 s = 40 s : ${percent(persistence.leader20EqualsLeader40Percent)} | ` +
      `leader 40 s = vainqueur : ${percent(persistence.leader40EqualsWinnerPercent)} | ` +
      `leader 20 s = vainqueur : ${percent(persistence.leader20EqualsWinnerPercent)}`,
  );

  lines.push('');
  lines.push('=== 2. Changements de leader ===');
  lines.push(
    `par course : moyenne ${decimal(summary.leaderChanges.mean, 3)} | médiane ${decimal(summary.leaderChanges.median)} | ` +
      `p10 ${decimal(summary.leaderChanges.p10)} | p90 ${decimal(summary.leaderChanges.p90)} | ` +
      `min ${String(summary.leaderChanges.min)} | max ${String(summary.leaderChanges.max)}`,
  );
  lines.push(
    `personnages différents ayant mené dans une course : moyenne ${decimal(summary.distinctLeaders.mean)} | ` +
      `répartition ${summary.distinctLeaders.histogram
        .map((count, index) => `${String(index + 1)}: ${percent(percentOf(count, summary.seeds))}`)
        .join(' · ')}`,
  );
  lines.push(
    `courses où les 6 ont mené : ${percent(summary.distinctLeaders.allSixLeadPercent)} | ` +
      `part de courses où chaque personnage a mené au moins une fois (attendu ${percent(summary.everLedShares.expectedShare)}, ` +
      `χ² = ${decimal(summary.everLedShares.chiSquare)} pour un seuil à 5 % de ${decimal(summary.everLedShares.criticalChiSquare05)}, ` +
      `max |z| = ${decimal(summary.everLedShares.maxAbsZ)} → ${summary.everLedShares.uniform ? 'homogène' : 'NON HOMOGÈNE'}) : ` +
      CHARACTER_IDS.map((id, index) => `${id} ${percent(summary.everLedShares.shares[index] ?? 0)}`).join(' | '),
  );
  lines.push(
    `dernier changement de leader : moyenne ${decimal(summary.lastChange.mean)} s | médiane ${decimal(summary.lastChange.median)} s | ` +
      `p10 ${decimal(summary.lastChange.p10)} s | p90 ${decimal(summary.lastChange.p90)} s`,
  );
  lines.push(
    `dernier changement dans les dernières secondes : ` +
      LAST_CHANGE_WINDOWS_S.map(
        (windowS, index) =>
          `${String(windowS)} s : ${percent(summary.lastChange.withinWindowPercent[index] ?? 0)}`,
      ).join(' | '),
  );
  const visibleChanges = summary.visibleChanges;
  lines.push(
    `changements VISIBLES (nouveau leader ≥ ${decimal(VISIBLE_LEADER_CHANGE_S, 0)} s) : moyenne ${decimal(visibleChanges.visibleMean, 3)} | ` +
      `micro-changements (< ${decimal(VISIBLE_LEADER_CHANGE_S, 0)} s) : moyenne ${decimal(visibleChanges.microMean, 3)} | ` +
      `part visible : ${percent(visibleChanges.visibleSharePercent)}`,
  );
  lines.push(
    `courses avec au moins un changement visible : ${percent(visibleChanges.racesWithVisibleChangePercent)} | ` +
      `sans aucun changement visible : ${percent(visibleChanges.racesWithoutVisibleChangePercent)} | ` +
      `changement visible dans les ${String(FINAL_WINDOW_S)} dernières secondes : ${percent(visibleChanges.visibleInFinalWindowPercent)}`,
  );

  lines.push('');
  lines.push('=== 3. Remontées ===');
  lines.push(
    `courses avec remontée depuis le dernier rang : top 3 ${percent(summary.comebacks.toTop3Percent)} | ` +
      `top 2 ${percent(summary.comebacks.toTop2Percent)} | 1er ${percent(summary.comebacks.toFirstPercent)} | ` +
      `top 3 sans gagner ${percent(summary.comebacks.toTop3WithoutWinPercent)}`,
  );
  lines.push(
    `remontée maximale d'une course : moyenne ${decimal(summary.comebacks.maxGainPlacesMean)} places | ` +
      `médiane ${decimal(summary.comebacks.maxGainPlacesMedian)} | p10 ${decimal(summary.comebacks.maxGainPlacesP10)} | ` +
      `p90 ${decimal(summary.comebacks.maxGainPlacesP90)} | moyenne par personnage ${decimal(summary.comebacks.maxGainPlacesPerCharacterMean)}`,
  );
  const qualified = summary.qualifiedComebacks;
  lines.push(
    `au moins un personnage dernier ≥ ${decimal(LAST_STREAK_S, 0)} s d'affilée : ${percent(qualified.heldLastTwoSecondsPercent)} | ` +
      `plus longue série au dernier rang : moyenne ${decimal(qualified.longestLastStreakStepsMean, 1)} pas, ` +
      `médiane ${decimal(qualified.longestLastStreakStepsMedian, 1)}, p90 ${decimal(qualified.longestLastStreakStepsP90, 1)}`,
  );
  lines.push(
    `dernier ≥ ${decimal(LAST_STREAK_S, 0)} s d'affilée puis top 3 SANS gagner : ${percent(qualified.lastStreakToTop3WithoutWinPercent)}`,
  );
  lines.push(
    `${'personnage'.padEnd(11)}${'meilleur'.padStart(10)}${'pire'.padStart(8)}${'mené'.padStart(9)}${'dernier'.padStart(9)}` +
      `${'remontée'.padStart(10)}${'après 6e'.padStart(10)}`,
  );
  for (const character of summary.comebacks.perCharacter) {
    lines.push(
      `${character.id.padEnd(11)}${decimal(character.meanBestRank).padStart(10)}${decimal(character.meanWorstRank).padStart(8)}` +
        `${percent(character.everLedPercent).padStart(9)}${percent(character.everLastPercent).padStart(9)}` +
        `${decimal(character.meanMaxGain).padStart(10)}` +
        `${(character.meanBestRankAfterLastPlace === null ? '—' : decimal(character.meanBestRankAfterLastPlace)).padStart(10)}`,
    );
  }

  lines.push('');
  lines.push('=== 4. Renversements ===');
  lines.push(
    `leader à 20 s qui ne gagne pas : ${percent(summary.upsets.leader20LosesPercent)} | ` +
      `leader à 40 s qui ne gagne pas : ${percent(summary.upsets.leader40LosesPercent)}`,
  );
  lines.push(
    `leader ayant perdu la tête après une avance d'au moins : ` +
      summary.gapThresholdLabels.map(
        (label, index) =>
          `${label} : ${percent(summary.upsets.significantLeadLostPercent[index] ?? 0)}`,
      ).join(' | '),
  );
  lines.push(
    `plus grande avance moyenne d'un leader pendant son règne : ${decimal(summary.upsets.meanMaxLeadWhileLeadingM)} m`,
  );
  lines.push(
    `vainqueur ayant été 4e ou pire : ${percent(summary.upsets.winnerOutsideTop3Percent)} | ` +
      `5e ou pire : ${percent(summary.upsets.winnerOutsideTop4Percent)} | ` +
      `dernier : ${percent(summary.upsets.winnerLastPercent)}`,
  );
  lines.push(
    `5e ou 6e au relevé de ${String(summary.boundsS[1] ?? 40)} s : termine top 3 ${percent(qualified.at40FifthOrSixthToTop3Percent)} | ` +
      `gagne ${percent(qualified.at40FifthOrSixthToWinPercent)}`,
  );
  lines.push(
    `leader de ${String(summary.boundsS[1] ?? 40)} s : encore en tête à ${String(summary.marksS[0] ?? 50)} s ${percent(qualified.leader40StillLeadsAt50Percent)} | ` +
      `perd la tête après ${String(summary.marksS[0] ?? 50)} s ${percent(qualified.leader40LosesLeadAfter50Percent)}`,
  );

  lines.push('');
  lines.push('=== 5. Suspense final : écart P1–P2 en mètres ===');
  for (const [index, gap] of summary.finalSuspense.gapAtBounds.entries()) {
    lines.push(gapRow(summary.boundLabels[index] ?? '?', gap));
  }
  for (const [index, gap] of summary.finalSuspense.gapAtMarks.entries()) {
    lines.push(gapRow(`${String(summary.marksS[index] ?? 0)} s`, gap));
  }
  lines.push(
    `encore serrés à ${String(summary.marksS[0] ?? 0)} s : ` +
      summary.gapThresholdLabels.map(
        (label, index) =>
          `< ${label} : ${percent(summary.finalSuspense.closeAtWindowStartPercent[index] ?? 0)}`,
      ).join(' | '),
  );
  lines.push(
    `serrés pendant TOUTE la fenêtre finale : ` +
      summary.gapThresholdLabels.map(
        (label, index) =>
          `< ${label} : ${percent(summary.finalSuspense.closeThroughoutWindowPercent[index] ?? 0)}`,
      ).join(' | '),
  );
  lines.push(
    `écart à l'arrivée sous : ` +
      summary.gapThresholdLabels.map(
        (label, index) =>
          `${label} : ${percent(summary.finalSuspense.photoAtFinishPercent[index] ?? 0)}`,
      ).join(' | '),
  );
  lines.push(
    `changement de leader dans les ${String(FINAL_WINDOW_S)} dernières secondes : ` +
      `${percent(summary.finalSuspense.leaderChangeInWindowPercent)}`,
  );

  lines.push('');
  lines.push('=== 6. Brut contre visible (cœur de la passe exploratoire) ===');
  lines.push(
    `changements de leader : bruts ${decimal(summary.leaderChanges.mean, 3)}/course → visibles ` +
      `${decimal(summary.visibleChanges.visibleMean, 3)}/course (${percent(summary.visibleChanges.visibleSharePercent)} des bruts) | ` +
      `micro-changements (< ${decimal(VISIBLE_LEADER_CHANGE_S, 0)} s de tête) ${decimal(summary.visibleChanges.microMean, 3)}/course`,
  );
  lines.push(
    `remontées : brutes (dernier → top 3) ${percent(summary.comebacks.toTop3Percent)} → qualifiées ` +
      `(dernier ≥ ${decimal(LAST_STREAK_S, 0)} s d'affilée, puis top 3 sans gagner) ${percent(summary.qualifiedComebacks.lastStreakToTop3WithoutWinPercent)}`,
  );
  lines.push(
    `tête à 40 s : vainqueur ${percent(summary.persistence.leader40EqualsWinnerPercent)} | encore en tête à ` +
      `${String(summary.marksS[0] ?? 50)} s ${percent(summary.qualifiedComebacks.leader40StillLeadsAt50Percent)} | ` +
      `perd la tête après ${String(summary.marksS[0] ?? 50)} s ${percent(summary.qualifiedComebacks.leader40LosesLeadAfter50Percent)}`,
  );
  lines.push(
    `Lecture : ces lignes ne remplacent pas les mesures brutes, elles les qualifient par une durée. ` +
      `Un changement ou une remontée qui ne dure pas n'est pas un rebondissement pour un spectateur.`,
  );

  lines.push('');
  lines.push('=== 7. Contrôles ===');
  const corpus = summary.corpus;
  lines.push(
    `seeds ${String(corpus.seeds)} | distinctes ${String(corpus.distinctSeeds)} | effectif ${String(corpus.players)} partout : ` +
      `${corpus.fieldSizeEverywhere ? 'oui' : 'NON'} | pas exactement ${String(RACE_CONFIG.TOTAL_STEPS)} : ${corpus.exactSteps ? 'oui' : 'NON'} | ` +
      `arrivée à ${String(RACE_CONFIG.TOTAL_SIM_S)} s : ${corpus.finishedAtTotalSimS ? 'oui' : 'NON'}`,
  );
  lines.push(
    `rangs vérifiés contre computeRanks aux bornes : ${corpus.rankVerifiedEverywhere ? 'oui' : 'NON'} | ` +
      `changements bruts relus dans l'historique identiques au compteur pas-à-pas : ` +
      `${corpus.leaderChangesConsistentEverywhere ? 'oui' : 'NON'} | ` +
      `reproductibilité bit à bit : ${String(summary.reproducibility.identical)}/${String(summary.reproducibility.seeds)}`,
  );
  if (summary.references.length > 0) {
    // Chaque référence n'est comparable qu'à la taille de corpus où elle a été publiée : une passe à
    // 1 000 seeds reproduit la référence de 1 000 seeds, pas celle de 10 000.
    const comparable = summary.references.filter((check) => check.comparable);
    lines.push(
      `reproduction des mesures publiées (corpus de ${String(summary.seeds)} seeds) : ` +
        (comparable.length > 0
          ? comparable
              .map(
                (check) =>
                  `${check.label} ${check.measured}${check.reproduced ? ' = ' : ' ≠ '}${check.reference}`,
              )
              .join(' | ')
          : 'aucune référence publiée sur ce corpus'),
    );
    const skipped = summary.references.length - comparable.length;
    if (skipped > 0) {
      lines.push(
        `références non comparables ici : ${String(skipped)} mesure(s) publiée(s) sur un autre corpus ` +
          `(indicatives, jamais des anomalies)`,
      );
    }
  }

  lines.push('');
  lines.push('=== 8. Les cinq métriques les plus révélatrices ===');
  for (const metric of summary.spotlight) {
    lines.push(
      `${metric.label} : ${metric.value}   (audit précédent : ${metric.previousAudit}) — ${metric.note}`,
    );
  }

  lines.push('');
  lines.push(...conclusionLines(summary));
  return lines.join('\n');
}

/** Rapport structuré, à clés ASCII, pour un usage machine. */
export function buildSuspenseAuditJson(summary: SuspenseAuditSummary, elapsedMs: number): unknown {
  const shares = (table: CharacterShares): unknown => ({
    counts: [...table.counts],
    sharesPercent: table.shares.map((value) => Number(value.toFixed(4))),
    expectedSharePercent: Number(table.expectedShare.toFixed(4)),
    deviationsPoints: table.deviations.map((value) => Number(value.toFixed(4))),
    chiSquare: Number(table.chiSquare.toFixed(4)),
    degreesOfFreedom: table.degreesOfFreedom,
    criticalChiSquare05: table.criticalChiSquare05,
    maxAbsZ: Number(table.maxAbsZ.toFixed(4)),
    maxAbsZCharacter: table.maxAbsZCharacter,
    uniform: table.uniform,
    beyondChance: table.beyondChance,
  });
  const gaps = (series: readonly GapSummary[]): unknown =>
    series.map((gap) => ({
      count: gap.count,
      min: Number(gap.min.toFixed(4)),
      p10: Number(gap.p10.toFixed(4)),
      median: Number(gap.median.toFixed(4)),
      p90: Number(gap.p90.toFixed(4)),
      max: Number(gap.max.toFixed(4)),
      mean: Number(gap.mean.toFixed(4)),
    }));

  return {
    tool: 'chaos-race-suspense-audit',
    scope: { players: summary.players, note: 'N=6 uniquement' },
    corpus: {
      seeds: summary.seeds,
      prefix: DEFAULT_AUDIT_CORPUS,
      boundsS: [...summary.boundsS],
      marksS: [...summary.marksS],
      gapThresholdsM: [...summary.gapThresholdsM],
      dtS: RACE_CONFIG.DT_S,
      totalSteps: RACE_CONFIG.TOTAL_STEPS,
    },
    timing: {
      elapsedMs: Number(elapsedMs.toFixed(1)),
      msPerRace: Number((elapsedMs / summary.seeds).toFixed(3)),
    },
    leadersPerBound: summary.leadersPerBound.map((table) => shares(table)),
    winnerShares: shares(summary.winnerShares),
    everLedShares: {
      counts: [...summary.everLedShares.counts],
      total: summary.everLedShares.total,
      base: summary.everLedShares.base,
      sharesPercent: summary.everLedShares.shares.map((value) => Number(value.toFixed(4))),
      expectedSharePercent: Number(summary.everLedShares.expectedShare.toFixed(4)),
      chiSquare: Number(summary.everLedShares.chiSquare.toFixed(4)),
      degreesOfFreedom: summary.everLedShares.degreesOfFreedom,
      criticalChiSquare05: summary.everLedShares.criticalChiSquare05,
      maxAbsZ: Number(summary.everLedShares.maxAbsZ.toFixed(4)),
      maxAbsZCharacter: summary.everLedShares.maxAbsZCharacter,
      uniform: summary.everLedShares.uniform,
    },
    persistence: { ...summary.persistence },
    leaderChanges: { ...summary.leaderChanges },
    distinctLeaders: {
      mean: Number(summary.distinctLeaders.mean.toFixed(4)),
      histogram: [...summary.distinctLeaders.histogram],
      allSixLeadPercent: Number(summary.distinctLeaders.allSixLeadPercent.toFixed(4)),
    },
    lastChange: {
      ...summary.lastChange,
      withinWindowPercent: [...summary.lastChange.withinWindowPercent],
      windowsS: [...LAST_CHANGE_WINDOWS_S],
    },
    comebacks: {
      ...summary.comebacks,
      perCharacter: summary.comebacks.perCharacter.map((character) => ({ ...character })),
    },
    upsets: {
      ...summary.upsets,
      significantLeadLostPercent: [...summary.upsets.significantLeadLostPercent],
    },
    finalSuspense: {
      gapAtBounds: gaps(summary.finalSuspense.gapAtBounds),
      gapAtMarks: gaps(summary.finalSuspense.gapAtMarks),
      closeAtWindowStartPercent: [...summary.finalSuspense.closeAtWindowStartPercent],
      closeThroughoutWindowPercent: [...summary.finalSuspense.closeThroughoutWindowPercent],
      photoAtFinishPercent: [...summary.finalSuspense.photoAtFinishPercent],
      leaderChangeInWindowPercent: Number(
        summary.finalSuspense.leaderChangeInWindowPercent.toFixed(4),
      ),
      finalWindowS: FINAL_WINDOW_S,
    },
    visibleChanges: {
      ...summary.visibleChanges,
      visibleLeaderChangeS: VISIBLE_LEADER_CHANGE_S,
    },
    qualifiedComebacks: {
      ...summary.qualifiedComebacks,
      lastStreakS: LAST_STREAK_S,
    },
    corpusChecks: { ...summary.corpus },
    references: summary.references.map((check) => ({ ...check })),
    reproducibility: { ...summary.reproducibility },
    spotlight: summary.spotlight.map((metric) => ({ ...metric })),
    conclusion: conclusionLines(summary),
  };
}

/**
 * Conclusion **factuelle** : seules les anomalies structurelles (effectif autre que six, pas
 * manquants, rangs divergents, reproduction des références ratée) sont signalées. Une mesure de
 * suspense n'est jamais présentée comme un bug : c'est une propriété du jeu, et la changer est une
 * décision de design, pas une correction.
 */
export function conclusionLines(summary: SuspenseAuditSummary): readonly string[] {
  const lines: string[] = [];
  const anomalies: string[] = [];

  if (!summary.corpus.fieldSizeEverywhere) {
    anomalies.push('un plateau audité ne fait pas exactement six partants égaux au roster');
  }
  if (!summary.corpus.exactSteps) {
    anomalies.push(`une course n'a pas fait exactement ${String(RACE_CONFIG.TOTAL_STEPS)} pas`);
  }
  if (!summary.corpus.finishedAtTotalSimS) {
    anomalies.push(`une course ne s'est pas terminée à ${String(RACE_CONFIG.TOTAL_SIM_S)} s`);
  }
  if (!summary.corpus.rankVerifiedEverywhere) {
    anomalies.push('le suivi rapide des rangs diverge de computeRanks sur au moins une course');
  }
  if (!summary.corpus.leaderChangesConsistentEverywhere) {
    anomalies.push(
      "le compte brut de changements de leader relu dans l'historique diverge du compteur pas-à-pas",
    );
  }
  if (summary.corpus.distinctSeeds !== summary.corpus.seeds) {
    anomalies.push('le corpus contient des seeds dupliquées');
  }
  if (summary.reproducibility.seeds > 0 && summary.reproducibility.identical !== summary.reproducibility.seeds) {
    anomalies.push('la reproductibilité bit à bit a échoué');
  }
  if (summary.winnerShares.beyondChance) {
    anomalies.push(
      `taux de victoire non uniforme (χ² = ${decimal(summary.winnerShares.chiSquare)} pour un seuil à 1 % de ${decimal(summary.winnerShares.criticalChiSquare01)})`,
    );
  }
  for (const check of summary.references) {
    if (check.comparable && !check.reproduced) {
      anomalies.push(
        `référence non reproduite : ${check.label} (${check.measured} vs ${check.reference})`,
      );
    }
  }

  if (anomalies.length === 0) {
    lines.push(
      'Aucune anomalie structurelle détectée : effectif six partout, pas et arrivée exacts, rangs vérifiés ' +
        'contre le classement officiel, compte brut de changements relu à l’identique, corpus distinct' +
        (summary.reproducibility.seeds > 0 ? ', reproductibilité intacte' : ', reproductibilité non vérifiée sur ce lancement') +
        (summary.references.some((check) => check.comparable) ? ', références reproduites' : '') +
        '.',
    );
  } else {
    lines.push('Anomalies structurelles détectées :');
    for (const anomaly of anomalies) {
      lines.push(`- ${anomaly}`);
    }
  }
  lines.push(
    'Lecture : ces chiffres décrivent le suspense du jeu tel qu’il est. Aucune constante n’a été modifiée ' +
      'pour les produire, et aucun mécanisme correcteur (boost du dernier, rubber-band) n’existe dans le noyau.',
  );
  return Object.freeze(lines);
}

// ---------------------------------------------------------------------------------------------
// Sweep du bruit de dérive après 40 s (mode expérimental)
// ---------------------------------------------------------------------------------------------

/**
 * Facteur d'amplitude du bruit de dérive : `1` jusqu'à la borne incluse, `factor` ensuite.
 *
 * Le pas qui **atteint** 40 s (`fromStep`) n'est pas amplifié : l'état publié au checkpoint de 40 s
 * est donc, par construction, bit à bit celui du baseline. C'est ce que le sweep vérifie ensuite
 * course par course, plutôt que de le supposer.
 */
export function noiseScaleAfter(fromStep: number, factor: number): (stepNumber: number) => number {
  return (stepNumber: number): number => (stepNumber > fromStep ? factor : 1);
}

/**
 * Premier pas où deux courses de la même seed divergent, en comparant `x`, `v` et `drift` des
 * partants pas à pas. `-1` si elles restent identiques jusqu'à l'arrivée.
 *
 * La comparaison est **bit à bit** (`!==` sur des `number`) : elle ne tolère aucun écart, pas même
 * un dernier bit. C'est la seule façon de prouver que le levier est inerte avant 40 s.
 */
export function firstDivergentStep(
  seed: string,
  driftNoiseScale?: (stepNumber: number) => number,
): number {
  const baseline = new RaceEngine(seed, GAME_CONFIG, { players: SUSPENSE_PLAYERS });
  const variant = new RaceEngine(seed, GAME_CONFIG, {
    players: SUSPENSE_PLAYERS,
    ...(driftNoiseScale === undefined ? {} : { driftNoiseScale }),
  });

  let state = baseline.getState();
  while (state.phase.kind !== 'finished') {
    baseline.step();
    variant.step();
    state = baseline.getState();
    const other = variant.getState();
    for (let slot = 0; slot < state.characters.length; slot += 1) {
      const left = state.characters[slot];
      const right = other.characters[slot];
      if (left === undefined || right === undefined) {
        throw new RangeError(`Course sans personnage à l'index ${String(slot)}.`);
      }
      if (left.x !== right.x || left.v !== right.v || left.drift !== right.drift) {
        return state.steps;
      }
    }
  }
  return -1;
}

/** Contrôle d'innocuité du levier : la variante doit être identique au baseline jusqu'à 40 s. */
export interface NoiseSweepInertness {
  readonly seeds: number;
  /** Dernier pas non amplifié : `tSim = fromStep × DT`. */
  readonly fromStep: number;
  /** Courses dont la variante diverge du baseline **au plus tard** à ce pas (doit valoir `0`). */
  readonly divergentAtOrBeforeBound: number;
  /** Plus petit et plus grand premiers pas divergents observés (`-1` si aucune divergence). */
  readonly firstDivergentStepMin: number;
  readonly firstDivergentStepMax: number;
}

/** Les mesures comparées par le sweep, extraites d'une synthèse d'audit. */
export interface NoiseSweepMetrics {
  readonly leader40WinsPercent: number;
  readonly leader40LosesLeadAfter50Percent: number;
  readonly visibleChangeInFinalWindowPercent: number;
  readonly at40FifthOrSixthToTop3Percent: number;
  readonly at40FifthOrSixthToWinPercent: number;
  readonly sameLeaderAllBoundsPercent: number;
  readonly gapAtFinishMedianM: number;
  readonly finishUnder15mPercent: number;
  readonly winnerSharesPercent: readonly number[];
}

/** Un point du sweep : un facteur, ses mesures, et la preuve qu'il ne touche rien avant 40 s. */
export interface NoiseSweepPoint {
  readonly factor: number;
  readonly metrics: NoiseSweepMetrics;
  readonly inertness: NoiseSweepInertness;
}

/** Résultat complet du sweep. */
export interface NoiseSweepReport {
  readonly seeds: number;
  readonly fromS: number;
  readonly fromStep: number;
  readonly factors: readonly number[];
  readonly points: readonly NoiseSweepPoint[];
  readonly elapsedMs: number;
}

/** Extrait les neuf mesures comparées d'une synthèse, sans recalculer quoi que ce soit. */
export function noiseSweepMetrics(summary: SuspenseAuditSummary): NoiseSweepMetrics {
  const finishIndex = Math.max(0, summary.gapThresholdsM.indexOf(FACT.CLOSE_RACE_MAX_GAP_M));
  const finish = summary.finalSuspense.gapAtBounds[summary.finalSuspense.gapAtBounds.length - 1];
  return Object.freeze({
    leader40WinsPercent: summary.persistence.leader40EqualsWinnerPercent,
    leader40LosesLeadAfter50Percent: summary.qualifiedComebacks.leader40LosesLeadAfter50Percent,
    visibleChangeInFinalWindowPercent: summary.visibleChanges.visibleInFinalWindowPercent,
    at40FifthOrSixthToTop3Percent: summary.qualifiedComebacks.at40FifthOrSixthToTop3Percent,
    at40FifthOrSixthToWinPercent: summary.qualifiedComebacks.at40FifthOrSixthToWinPercent,
    sameLeaderAllBoundsPercent: summary.persistence.sameLeaderAllBoundsPercent,
    gapAtFinishMedianM: finish?.median ?? Number.NaN,
    finishUnder15mPercent: summary.finalSuspense.photoAtFinishPercent[finishIndex] ?? Number.NaN,
    winnerSharesPercent: Object.freeze([...summary.winnerShares.shares]),
  });
}

/**
 * Joue le sweep : pour chaque facteur, le corpus entier **et** le contrôle d'innocuité avant 40 s.
 *
 * Le contrôle d'innocuité rejoue deux moteurs en parallèle, seed par seed, et s'arrête au premier pas
 * divergent : son coût reste donc celui des 40 premières secondes, pas celui de la course entière.
 * Aucune constante de jeu n'est modifiée : le facteur n'existe que dans l'instance de mesure.
 */
export function runNoiseSweep(
  seeds: readonly string[],
  options: {
    readonly factors?: readonly number[];
    readonly fromS?: number;
    readonly onPoint?: (index: number, total: number) => void;
  } = {},
): NoiseSweepReport {
  const factors = options.factors ?? DRIFT_NOISE_SWEEP_FACTORS;
  const fromS = options.fromS ?? DRIFT_NOISE_SWEEP_FROM_S;
  const fromStep = stepsForSeconds(fromS);
  const startedAt = performance.now();
  const points: NoiseSweepPoint[] = [];

  for (const [index, factor] of factors.entries()) {
    const scale = noiseScaleAfter(fromStep, factor);
    const races: SuspenseRaceAudit[] = [];
    let divergentAtOrBeforeBound = 0;
    let firstDivergentStepMin = -1;
    let firstDivergentStepMax = -1;

    for (const seed of seeds) {
      races.push(auditSuspenseRace(seed, { driftNoiseScale: scale }));
      const divergent = firstDivergentStep(seed, scale);
      if (divergent > 0 && divergent <= fromStep) {
        divergentAtOrBeforeBound += 1;
      }
      if (divergent > 0) {
        if (firstDivergentStepMin < 0 || divergent < firstDivergentStepMin) {
          firstDivergentStepMin = divergent;
        }
        if (divergent > firstDivergentStepMax) {
          firstDivergentStepMax = divergent;
        }
      }
    }

    points.push(
      Object.freeze({
        factor,
        metrics: noiseSweepMetrics(summarizeSuspenseAudit(races)),
        inertness: Object.freeze({
          seeds: seeds.length,
          fromStep,
          divergentAtOrBeforeBound,
          firstDivergentStepMin,
          firstDivergentStepMax,
        }),
      }),
    );
    options.onPoint?.(index + 1, factors.length);
  }

  return Object.freeze({
    seeds: seeds.length,
    fromS,
    fromStep,
    factors: Object.freeze([...factors]),
    points: Object.freeze(points),
    elapsedMs: performance.now() - startedAt,
  });
}

/** Libellés des lignes du tableau de sweep, dans l'ordre d'affichage. */
const NOISE_SWEEP_ROWS: readonly { readonly label: string; readonly pick: (m: NoiseSweepMetrics) => string }[] =
  Object.freeze([
    { label: 'leader à 40 s qui gagne', pick: (m) => percent(m.leader40WinsPercent) },
    {
      label: 'leader à 40 s qui perd la tête après 50 s',
      pick: (m) => percent(m.leader40LosesLeadAfter50Percent),
    },
    {
      label: 'changement visible dans les 10 dernières secondes',
      pick: (m) => percent(m.visibleChangeInFinalWindowPercent),
    },
    { label: '5e/6e à 40 s → top 3', pick: (m) => percent(m.at40FifthOrSixthToTop3Percent) },
    { label: '5e/6e à 40 s → victoire', pick: (m) => percent(m.at40FifthOrSixthToWinPercent) },
    { label: 'même leader 20/40/60', pick: (m) => percent(m.sameLeaderAllBoundsPercent) },
    { label: 'écart P1–P2 médian à l’arrivée', pick: (m) => `${decimal(m.gapAtFinishMedianM)} m` },
    { label: 'arrivée sous 15 m', pick: (m) => percent(m.finishUnder15mPercent) },
    {
      label: 'répartition des vainqueurs (c0→c5)',
      pick: (m) => m.winnerSharesPercent.map((share) => decimal(share, 1)).join(' / '),
    },
  ]);

/** Rapport texte du sweep : un tableau facteur par colonne, mesure par ligne. */
export function renderNoiseSweepText(report: NoiseSweepReport): string {
  const lines: string[] = [];
  lines.push(
    `Chaos Race — sweep du bruit de dérive après ${decimal(report.fromS, 0)} s (courses à 6 coureurs)`,
  );
  lines.push(
    `corpus : ${String(report.seeds)} seeds | bruit dilaté à partir du pas ${String(report.fromStep + 1)} ` +
      `(tSim > ${decimal(report.fromS, 0)} s) | ${String(report.points.length)} variantes | ` +
      `durée : ${decimal(report.elapsedMs / 1_000, 1)} s`,
  );
  lines.push(
    'Levier : amplitude du bruit de dérive DÉJÀ TIRÉ, identique pour les six, sans tirage supplémentaire.',
  );
  lines.push('');

  const headers = ['mesure', ...report.points.map((point) => `×${decimal(point.factor)}`)];
  const rows = NOISE_SWEEP_ROWS.map((row) => [
    row.label,
    ...report.points.map((point) => row.pick(point.metrics)),
  ]);
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? '').length)),
  );
  const format = (row: readonly string[]): string =>
    row.map((cell, column) => cell.padEnd(widths[column] ?? cell.length)).join('  ').trimEnd();
  lines.push(format(headers));
  for (const row of rows) {
    lines.push(format(row));
  }

  lines.push('');
  lines.push(
    `identité bit à bit jusqu’à ${decimal(report.fromS, 0)} s (x, v et drift des six, pas à pas) :`,
  );
  for (const point of report.points) {
    const inertness = point.inertness;
    lines.push(
      `  ×${decimal(point.factor)} : ${String(inertness.seeds - inertness.divergentAtOrBeforeBound)}/${String(inertness.seeds)} courses identiques | ` +
        `premier pas divergent : ${inertness.firstDivergentStepMin < 0 ? 'aucun' : `${String(inertness.firstDivergentStepMin)} à ${String(inertness.firstDivergentStepMax)}`}` +
        (inertness.divergentAtOrBeforeBound > 0
          ? ` | ANOMALIE : ${String(inertness.divergentAtOrBeforeBound)} course(s) divergent à 40 s ou avant`
          : ''),
    );
  }
  lines.push('');
  lines.push(
    'Lecture : le baseline ×1,00 est la course de production ; les autres ne changent que l’amplitude ' +
      'du bruit après 40 s. Aucune constante du jeu n’a été modifiée, et aucun mécanisme ne lit le rang.',
  );
  return lines.join('\n');
}

/** Rapport structuré du sweep, à clés ASCII. */
export function buildNoiseSweepJson(report: NoiseSweepReport): unknown {
  return {
    tool: 'chaos-race-drift-noise-sweep',
    scope: { players: SUSPENSE_PLAYERS, note: 'N=6 uniquement, mode expérimental' },
    lever: {
      kind: 'drift-noise-amplitude-after-bound',
      fromS: report.fromS,
      firstAmplifiedStep: report.fromStep + 1,
      symmetric: true,
      zeroMean: true,
      rankIndependent: true,
      extraRngDraws: 0,
      productionConstantsChanged: false,
    },
    corpus: { seeds: report.seeds, prefix: DEFAULT_AUDIT_CORPUS, dtS: RACE_CONFIG.DT_S },
    timing: { elapsedMs: Number(report.elapsedMs.toFixed(1)) },
    factors: [...report.factors],
    points: report.points.map((point) => ({
      factor: point.factor,
      metrics: {
        ...point.metrics,
        winnerSharesPercent: [...point.metrics.winnerSharesPercent],
        gapAtFinishMedianM: Number(point.metrics.gapAtFinishMedianM.toFixed(4)),
      },
      inertness: { ...point.inertness },
    })),
  };
}

// ---------------------------------------------------------------------------------------------
// Ligne de commande
// ---------------------------------------------------------------------------------------------

/** Options de la ligne de commande. */
export interface SuspenseAuditCliOptions {
  readonly seeds: number;
  readonly reproducibilitySeeds: number;
  readonly corpusPrefix: string;
  readonly jsonPath: string;
  readonly textPath: string;
  readonly replayCheck: boolean;
  /** Mode expérimental : sweep du bruit de dérive après 40 s au lieu de l'audit. */
  readonly sweep: boolean;
  readonly sweepFactors: readonly number[];
}

const AUDIT_HELP: readonly string[] = Object.freeze([
  'Audit de suspense des courses à 6 coureurs (N=6 uniquement).',
  '',
  'Usage : npm run balance:suspense -- [options]',
  '',
  'Options :',
  `  --seeds=<n>                  nombre de seeds du corpus (défaut : ${String(DEFAULT_SUSPENSE_SEEDS)})`,
  `  --reproducibility-seeds=<n>  seeds du contrôle bit à bit (défaut : ${String(DEFAULT_REPRODUCIBILITY_SEEDS)})`,
  `  --corpus=<prefixe>           préfixe du corpus déterministe (défaut : ${DEFAULT_AUDIT_CORPUS})`,
  `  --json=<chemin>              rapport structuré (défaut : ${DEFAULT_SUSPENSE_JSON})`,
  `  --text=<chemin>              rapport texte (défaut : ${DEFAULT_SUSPENSE_TEXT})`,
  '  --no-replay-check            saute le contrôle de reproductibilité bit à bit',
  '  --sweep                      mode expérimental : sweep du bruit de dérive après 40 s',
  `  --sweep-factors=<liste>      facteurs du sweep (défaut : ${DRIFT_NOISE_SWEEP_FACTORS.map((factor) => decimal(factor)).join(', ')})`,
  '  --help                       affiche cette aide',
  '',
]);

/** Analyse les arguments. Lève une `RangeError` explicite sur une entrée invalide. */
export function parseSuspenseAuditArgs(argv: readonly string[]): SuspenseAuditCliOptions | 'help' {
  let seeds = DEFAULT_SUSPENSE_SEEDS;
  let reproducibilitySeeds = DEFAULT_REPRODUCIBILITY_SEEDS;
  let corpusPrefix = DEFAULT_AUDIT_CORPUS;
  let jsonPath = DEFAULT_SUSPENSE_JSON;
  let textPath = DEFAULT_SUSPENSE_TEXT;
  let replayCheck = true;
  let sweep = false;
  let sweepFactors: readonly number[] = DRIFT_NOISE_SWEEP_FACTORS;

  const integer = (value: string, label: string): number => {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new RangeError(`${label} attend un entier ≥ 1 (reçu : ${value}).`);
    }
    return parsed;
  };

  const factors = (value: string): readonly number[] => {
    const parsed = value.split(',').map((item) => Number(item.trim()));
    if (parsed.length === 0 || parsed.some((factor) => !Number.isFinite(factor) || factor <= 0)) {
      throw new RangeError(
        `--sweep-factors attend une liste de facteurs > 0 séparés par des virgules (reçu : ${value}).`,
      );
    }
    return Object.freeze(parsed);
  };

  for (const argument of argv) {
    if (argument.startsWith('--seeds=')) {
      seeds = integer(argument.slice('--seeds='.length), '--seeds');
      continue;
    }
    if (argument.startsWith('--reproducibility-seeds=')) {
      reproducibilitySeeds = integer(
        argument.slice('--reproducibility-seeds='.length),
        '--reproducibility-seeds',
      );
      continue;
    }
    if (argument.startsWith('--corpus=')) {
      corpusPrefix = argument.slice('--corpus='.length);
      continue;
    }
    if (argument.startsWith('--json=')) {
      jsonPath = argument.slice('--json='.length);
      continue;
    }
    if (argument.startsWith('--text=')) {
      textPath = argument.slice('--text='.length);
      continue;
    }
    if (argument === '--no-replay-check') {
      replayCheck = false;
      continue;
    }
    if (argument === '--sweep') {
      sweep = true;
      continue;
    }
    if (argument.startsWith('--sweep-factors=')) {
      sweepFactors = factors(argument.slice('--sweep-factors='.length));
      sweep = true;
      continue;
    }
    if (argument === '--help' || argument === '-h') {
      return 'help';
    }
    throw new RangeError(`Argument inconnu : ${argument}.`);
  }

  return Object.freeze({
    seeds,
    reproducibilitySeeds,
    corpusPrefix,
    jsonPath,
    textPath,
    replayCheck,
    sweep,
    sweepFactors,
  });
}

/** Résultat d'un lancement en ligne de commande. */
export interface SuspenseAuditCliResult {
  readonly exitCode: number;
  readonly text: string;
  readonly report: unknown;
  readonly jsonPath: string;
  readonly textPath: string;
}

/**
 * Exécute l'audit complet.
 *
 * Le code de sortie vaut `1` **uniquement** en cas d'anomalie structurelle : une mesure de suspense
 * faible ou forte ne fait pas échouer l'outil — elle se rapporte.
 */
export function runSuspenseAuditWithReport(argv: readonly string[]): SuspenseAuditCliResult {
  const options = parseSuspenseAuditArgs(argv);
  if (options === 'help') {
    console.log(AUDIT_HELP.join('\n'));
    return {
      exitCode: 0,
      text: AUDIT_HELP.join('\n'),
      report: null,
      jsonPath: '',
      textPath: '',
    };
  }

  const seeds = corpusSeeds(options.seeds, options.corpusPrefix);
  console.log('Chaos Race — audit de suspense (6 coureurs)');
  console.log(
    `corpus « ${options.corpusPrefix} » : ${String(options.seeds)} seeds | ` +
      `première ${seeds[0] ?? '—'} | dernière ${seeds[seeds.length - 1] ?? '—'}`,
  );

  if (options.sweep) {
    // Mode expérimental : aucune constante de jeu n'est touchée, le facteur ne vit que dans les
    // instances de mesure du sweep.
    console.log(
      `sweep du bruit de dérive après ${decimal(DRIFT_NOISE_SWEEP_FROM_S, 0)} s : ` +
        options.sweepFactors.map((factor) => `×${decimal(factor)}`).join(' / '),
    );
    const sweep = runNoiseSweep(seeds, {
      factors: options.sweepFactors,
      onPoint: (index, total) => {
        console.log(`  … variante ${String(index)}/${String(total)}`);
      },
    });
    const text = renderNoiseSweepText(sweep);
    console.log('');
    console.log(text);
    const anomaly = sweep.points.some((point) => point.inertness.divergentAtOrBeforeBound > 0);
    return {
      exitCode: anomaly ? 1 : 0,
      text,
      report: buildNoiseSweepJson(sweep),
      jsonPath: options.jsonPath,
      textPath: options.textPath,
    };
  }

  const startedAt = performance.now();
  const races = runSuspenseAudit(seeds, {
    onRace: (index, total) => {
      if (index % 1_000 === 0 || index === total) {
        console.log(`  … ${String(index)}/${String(total)} courses`);
      }
    },
  });
  const elapsedMs = performance.now() - startedAt;

  const reproducibility = options.replayCheck
    ? (() => {
        const measured = measureReproducibility(
          seeds.slice(0, Math.min(options.reproducibilitySeeds, seeds.length)),
        );
        return { seeds: measured.seeds, identical: measured.identicalDistances };
      })()
    : { seeds: 0, identical: 0 };

  const summary = summarizeSuspenseAudit(races, { reproducibility });
  const text = renderSuspenseAuditText(summary, elapsedMs);
  const report = buildSuspenseAuditJson(summary, elapsedMs);

  console.log('');
  console.log(text);

  const conclusion = conclusionLines(summary);
  const hasAnomaly = conclusion[0]?.startsWith('Anomalies') ?? false;

  return {
    exitCode: hasAnomaly ? 1 : 0,
    text,
    report,
    jsonPath: options.jsonPath,
    textPath: options.textPath,
  };
}