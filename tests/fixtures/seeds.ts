import { CHARACTER_IDS } from '../../src/core/characters';
import { RaceEngine } from '../../src/core/engine';
import { OvertakeTracker } from '../../src/core/overtakes';
import { computeRanks, isLeaderChange } from '../../src/core/ranking';

/**
 * Seeds **mesurées** et partagées entre les tests unitaires et les tests E2E.
 *
 * Elles ne sont jamais choisies « au feeling » : chacune est retenue après mesure de plusieurs
 * candidates, et la mesure est vérifiée par un test unitaire. Si une évolution du noyau change ces
 * valeurs, c'est un signal explicite — il faut alors décider consciemment de conserver la seed ou
 * d'en choisir une autre, jamais corriger le chiffre en silence (AGENTS §2).
 */

/**
 * Seed retenue pour les tests de mouvement et de dépassement.
 *
 * Mesurée parmi 24 candidates en P004 : c'est celle qui produisait le plus de changements de leader
 * et de dépassements, à toutes les granularités d'observation testées. Une course à une douzaine de
 * changements de leader est exactement ce que le jeu cherche : imprévisible, sans qu'aucun
 * personnage ne soit avantagé.
 */
export const OVERTAKE_SEED = 'POULET42';

/**
 * Valeurs **remesurées** pour `OVERTAKE_SEED`, dernière fois après la passe corrective (course de
 * 60 s, 3 600 pas).
 *
 * La seed est **conservée** : à 60 s elle produit 11 changements de leader et 36 dépassements, très
 * au-dessus des minima exigés par les tests E2E, et changer de seed obligerait à remesurer toutes les
 * attentes qui s'y appuient sans rien apporter au jeu. Ce sont donc les **chiffres** qui suivent la
 * durée de la course, pas l'inverse.
 *
 * P010 avait déjà remesuré ces valeurs (magnitudes de bonus réduites de 35 %, aller-retour sur le
 * taux de §7.3 : `1/14` → `1/10` → `1/14`) ; les chiffres de P008 (14 / 32 pour un relevé tous les
 * 20 pas) sont périmés depuis P009, qui compte à chaque pas simulé.
 */
export const OVERTAKE_SEED_EVIDENCE = Object.freeze({
  leaderChanges: 11,
  overtakes: 36,
});

/**
 * Seed dont l'arrivée est une **photo finish** (P013), remesurée après la passe corrective.
 *
 * Cherchée sur le corpus canonique de 600 seeds (`observerSeeds.test.ts`) : 97 courses (≈ 16 %)
 * produisent réellement `PHOTO_FINISH` à 60 s, contre ≈ 8 % à 180 s — le seuil de design
 * (`FACT.PHOTO_ARRIVAL_MAX_GAP_M = 5 m`) est une **distance absolue**, et les écarts d'arrivée sont
 * mécaniquement plus petits sur une course plus courte. Le seuil n'a pas été touché pour autant : il
 * n'y a aucune raison de réécrire une constante de design parce que la course raccourcit, et une
 * arrivée serrée une fois sur six est un bon dosage dramatique.
 *
 * Celle-ci (`ZH0D03Q4`) est retenue pour son écart P1–P2 le plus serré du corpus **sans être
 * dégénéré** (0,141 m sépare `c1` de `c2`). Aucun gameplay n'a été modifié pour l'obtenir : c'est une
 * course normale du noyau, et `tests/unit/finishModel.test.ts` revérifie l'évidence ci-dessous à
 * chaque exécution.
 */
export const PHOTO_FINISH_SEED = 'ZH0D03Q4';

/** Évidence mesurée pour `PHOTO_FINISH_SEED`, au pas `3 600`. */
export const PHOTO_FINISH_SEED_EVIDENCE = Object.freeze({
  /** Écart P1–P2, en mètres, tel que l'observateur l'a mesuré. */
  gapMeters: 0.14111513361081052,
  /** Vainqueur et deuxième, dans l'ordre du fait d'arrivée. */
  leader: 'c1',
  second: 'c2',
});

/**
 * Seed dont l'arrivée est une arrivée **franche** (`FINISH`), cas négatif du rendu de podium.
 *
 * `HVEXYB9A` est l'écart P1–P2 le plus large du corpus canonique (179,33 m à 60 s) : la mention
 * « photo finish » n'a aucune ambiguïté à ne pas apparaître ici. Elle remplace `POULET42` dans ce
 * rôle, car l'arrivée de celui-ci (3,16 m) est **devenue** une photo finish avec la course de 60 s.
 */
export const PLAIN_FINISH_SEED = 'HVEXYB9A';

/** Évidence mesurée pour `PLAIN_FINISH_SEED` : son arrivée n'est **pas** une photo finish. */
export const PLAIN_FINISH_SEED_EVIDENCE = Object.freeze({
  type: 'FINISH',
  /** Écart P1–P2, en mètres : très au-dessus du seuil de photo finish du design. */
  gapMeters: 179.3276451846623,
});

/** Fait d'arrivée (`FINISH` ou `PHOTO_FINISH`) d'une course, mesuré pas à pas par le noyau. */
export function arrivalFactOf(seed: string): {
  readonly type: string;
  readonly gapMeters: number;
  readonly characterIds: readonly string[];
  readonly stepCount: number;
  readonly tSim: number;
} {
  const engine = new RaceEngine(seed);
  const result = engine.runToCompletion();
  const arrival = engine
    .drainFacts()
    .find((fact) => fact.type === 'FINISH' || fact.type === 'PHOTO_FINISH');

  if (arrival === undefined) {
    throw new Error(`Aucun fait d'arrivée pour la seed ${seed}.`);
  }

  return {
    type: arrival.type,
    gapMeters: arrival.magnitudes[0] ?? Number.NaN,
    characterIds: arrival.characterIds,
    stepCount: engine.getState().steps,
    tSim: result.tSim,
  };
}

export interface OvertakeMeasurement {
  readonly steps: number;
  readonly leaderChanges: number;
  readonly overtakes: number;
}

/**
 * Compte les changements de leader et les dépassements d'une course, **pas à pas**.
 *
 * Le détecteur est alimenté après chaque `step()` : c'est la granularité de P009, indépendante du
 * rendu, du `timeScale` et du nombre d'images par seconde.
 */
export function measureOvertakes(seed: string): OvertakeMeasurement {
  return measureObservedOvertakes(seed, 1);
}

/**
 * Même mesure, mais en n'alimentant le détecteur qu'un pas sur `granularitySteps`.
 *
 * Sert uniquement à **documenter** la robustesse du détecteur à une observation plus grossière
 * (celle du rendu) : deux relevés rapprochés peuvent manquer un aller-retour très rapide, donc cette
 * mesure n'est jamais la source de vérité — P009 observera chaque pas simulé.
 */
export function measureSampledOvertakes(seed: string, granularitySteps: number): OvertakeMeasurement {
  if (!Number.isInteger(granularitySteps) || granularitySteps < 1) {
    throw new RangeError(`granularitySteps doit être un entier supérieur ou égal à 1 (reçu : ${granularitySteps}).`);
  }

  return measureObservedOvertakes(seed, granularitySteps);
}

function measureObservedOvertakes(seed: string, granularitySteps: number): OvertakeMeasurement {
  const engine = new RaceEngine(seed);
  const tracker = new OvertakeTracker();
  const ids = CHARACTER_IDS;
  const distances = (): number[] => engine.getState().characters.map((character) => character.x);

  let previousRanks = computeRanks(distances(), ids);
  let leaderChanges = 0;
  let overtakes = 0;
  let steps = 0;

  while (engine.getState().phase.kind !== 'finished') {
    engine.step();
    steps += 1;

    const xs = distances();

    if (steps % granularitySteps !== 0) {
      continue;
    }

    overtakes += tracker.observe(xs, ids).length;

    const ranks = computeRanks(xs, ids);
    if (isLeaderChange(previousRanks, ranks)) {
      leaderChanges += 1;
    }
    previousRanks = ranks;
  }

  return { steps, leaderChanges, overtakes };
}
