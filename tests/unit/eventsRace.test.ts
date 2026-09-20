import { describe, expect, it } from 'vitest';

import { CHARACTER_IDS } from '../../src/core/characters';
import { GAME_CONFIG, RACE_CONFIG, SPEED, SQRT_DT } from '../../src/core/config';
import { RaceEngine } from '../../src/core/engine';
import { EVENT_CATALOG, activeEventAt, createEventPlan, eventParams, stepEvents } from '../../src/core/events';
import type { EventPlanState } from '../../src/core/events';
import { lateFormFactor, lateFormParams } from '../../src/core/lateForm';
import { gaussianFrom, stepOrnsteinUhlenbeck } from '../../src/core/math';
import { computeRanks } from '../../src/core/ranking';
import { forkStream } from '../../src/core/rng';
import { normalizeSeed } from '../../src/core/seed';
import { integratePosition, integrateSpeed } from '../../src/core/speedModel';
import { createSurgeState, stepSurge, surgeParams } from '../../src/core/surges';
import type { ActiveEvent, CharacterId, EventId } from '../../src/core/types';
import { SIM_CONFIG } from '../../src/sim/config';
import { RaceSimulation } from '../../src/sim/RaceSimulation';

/**
 * P008 — les événements rares **dans la course**.
 *
 * Le catalogue et le planificateur sont éprouvés seuls dans `events.test.ts`. Ici on vérifie le
 * contrat du moteur : les décisions publiées sont exactement celles du flux `events:global`,
 * l'événement module la vitesse cible du pas où il s'applique, le gain de §7.2 est réellement produit
 * puis définitivement conservé, une pause réelle ne consomme rien, et la cible ne dépend jamais de la
 * position.
 */

const DT = RACE_CONFIG.DT_S;
const TOTAL_STEPS = RACE_CONFIG.TOTAL_STEPS;
const CONFIG = GAME_CONFIG;
const PARAMS = eventParams(CONFIG);
const SURGE_PARAMS = surgeParams(CONFIG);
const MAX_UP = SPEED.MAX_ACCEL * DT;
const MAX_DOWN = SPEED.MAX_DECEL * DT;
const EPS = 1e-12;

/** Tolérance de comparaison d'une avance conservée : quelques ulps sur des positions de 4 km. */
const GAP_TOLERANCE = 1e-9;
const WORK_SEED = 'POULET42';

/** Seeds de travail : elles n'ont rien de particulier, aucune n'est choisie « au feeling ». */
function seeds(count: number, prefix: string): readonly string[] {
  return Object.freeze(
    Array.from({ length: count }, (_, index) => `${prefix}${String(index).padStart(4, '0')}`),
  );
}

/** Rejoue le planificateur seul, sur le flux `events:global`, pas à pas. */
function replayPlanner(seed: string): { readonly plan: EventPlanState; readonly advance: (stepNumber: number) => void } {
  const plan = createEventPlan(CHARACTER_IDS.length);
  const stream = forkStream(normalizeSeed(seed), 'events:global');
  return {
    plan,
    advance: (stepNumber: number): void => {
      stepEvents(plan, stream, PARAMS, CHARACTER_IDS, stepNumber);
    },
  };
}

interface EventTrigger {
  readonly step: number;
  readonly index: number;
  readonly id: EventId;
}

/** Tous les déclenchements d'une course, dans l'ordre chronologique. */
function eventTriggers(seed: string): readonly EventTrigger[] {
  const { plan, advance } = replayPlanner(seed);
  const known: (ActiveEvent | null)[] = CHARACTER_IDS.map(() => null);
  const found: EventTrigger[] = [];

  for (let stepNumber = 1; stepNumber <= TOTAL_STEPS; stepNumber += 1) {
    advance(stepNumber);
    for (let index = 0; index < known.length; index += 1) {
      const event = activeEventAt(plan, index);
      if (event !== null && event !== known[index]) {
        found.push({ step: stepNumber, index, id: event.id });
      }
      known[index] = event;
    }
  }

  return found;
}

interface MeasuredGain {
  readonly id: EventId;
  readonly gain: number;
}

interface GainSample {
  readonly gains: readonly MeasuredGain[];
  /** Nombre de courses effectivement parcourues : sert à dériver les exigences de corpus. */
  readonly raceCount: number;
  readonly rampViolations: number;
  readonly boundViolations: number;
  readonly megaTurboSteps: number;
}

/**
 * Mesure le gain (ou la perte) **réellement produit** par chaque événement, grâce à un jumeau.
 *
 * Le jumeau d'un personnage est ce personnage privé de son événement : même dérive, mêmes surges,
 * même rampe, même intégration, mais une vitesse cible restée à `SPEED.BASE × (1 + drift + surge)`.
 * Le gain est la différence de distance au pas exact où l'événement s'achève — la définition même de
 * `GAME_DESIGN.md` §7.2. Au passage, la rampe directionnelle et les bornes de vitesse sont vérifiées à
 * chaque pas, événements compris.
 */
function measureGains(seedList: readonly string[]): GainSample {
  const gains: MeasuredGain[] = [];
  let rampViolations = 0;
  let boundViolations = 0;
  let megaTurboSteps = 0;

  for (const seed of seedList) {
    const engine = new RaceEngine(seed);
    const twinEvent: (ActiveEvent | null)[] = CHARACTER_IDS.map(() => null);
    const twinV: number[] = CHARACTER_IDS.map(() => 0);
    const twinX: number[] = CHARACTER_IDS.map(() => 0);

    let previous = engine.getState();
    let previousV = previous.characters.map((character) => character.v);

    for (let stepNumber = 1; stepNumber <= TOTAL_STEPS; stepNumber += 1) {
      engine.step();
      const state = engine.getState();

      for (const [index, character] of state.characters.entries()) {
        const previousCharacter = previous.characters[index];
        if (previousCharacter === undefined) {
          throw new Error(`Personnage ${index} absent de l'état précédent.`);
        }

        const delta = character.v - (previousV[index] ?? SPEED.BASE);
        if (delta >= 0 ? delta > MAX_UP + EPS : -delta > MAX_DOWN + EPS) {
          rampViolations += 1;
        }
        if (character.v < SPEED.MIN || character.v > SPEED.MAX) {
          boundViolations += 1;
        }
        if (character.activeEvent?.id === 'MEGA_TURBO') {
          megaTurboSteps += 1;
        }

        const event = character.activeEvent;
        const tracked = twinEvent[index] ?? null;

        if (tracked === null) {
          if (event !== null) {
            // Le jumeau part de l'état d'avant le pas et parcourt ce pas avec la cible non modulée.
            const v = integrateSpeed(
              previousCharacter.v,
              SPEED.BASE * (1 + character.drift + character.surge),
              CONFIG,
              DT,
            );
            twinV[index] = v;
            twinX[index] = integratePosition(previousCharacter.x, v, DT);
            twinEvent[index] = event;
          }
        } else {
          // Le jumeau parcourt lui aussi le pas courant : les deux distances sont donc comparées au
          // même instant. C'est cette égalité d'indice qui rend le gain exact.
          const v = integrateSpeed(
            twinV[index] ?? SPEED.BASE,
            SPEED.BASE * (1 + character.drift + character.surge),
            CONFIG,
            DT,
          );
          const x = integratePosition(twinX[index] ?? 0, v, DT);
          twinV[index] = v;
          twinX[index] = x;

          // Un événement qui dure garde le même objet : un changement d'objet signale sa fin (ou,
          // impossible avec les constantes de la V1, son remplacement).
          if (event !== tracked) {
            gains.push({ id: tracked.id, gain: character.x - x });
            twinEvent[index] = null;
          }
        }
      }

      previous = state;
      previousV = state.characters.map((character) => character.v);
    }
  }

  return { gains, raceCount: seedList.length, rampViolations, boundViolations, megaTurboSteps };
}

const MEASURED = measureGains(seeds(40, 'EVENTR'));

/** Gain attendu par événement : bornes du DoD de P008, elles-mêmes dérivées de la table §7.2. */
const EXPECTED_GAIN: Readonly<Record<EventId, { readonly min: number; readonly max: number }>> =
  Object.freeze({
    // P010 : magnitudes de bonus réduites de 35 % (§7.1), donc gains revus à la baisse.
    TURBO: { min: 16, max: 44 },
    RACCOURCI: { min: 22, max: 45 },
    MEGA_TURBO: { min: 72, max: 82 },
    CHUTE: { min: -42, max: -14 },
    SIESTE: { min: -42, max: -36 },
    VENT_DE_FACE: { min: -37, max: -13 },
    POULET: { min: -20, max: -4 },
  });

/**
 * Marge admise autour des bornes de §7.2 pour un événement **individuel**.
 *
 * La table de §7.2 calcule le gain « en supposant `drift = surge = 0` ». Un événement réel se produit
 * pendant que la dérive et les surges vivent leur vie, et deux effets d'écrêtage s'y ajoutent :
 * un malus combiné à une dérive et un surge négatifs voit sa cible passer sous `SPEED.MIN` et perd
 * donc moins de distance que la table ne l'annonce (jusqu'à 29 m pour une `SIESTE` au lieu de 39), et
 * un bonus combiné à un fort `drift`/`surge` positifs peut buter sur `SPEED.MAX`. La moyenne et la
 * médiane, elles, doivent rester dans les bornes annoncées : c'est ce que valide ce test.
 */
const GAIN_ENVELOPE = 0.25;

function gainsById(sample: GainSample): ReadonlyMap<EventId, readonly number[]> {
  const byId = new Map<EventId, number[]>();
  for (const { id, gain } of sample.gains) {
    const list = byId.get(id) ?? [];
    list.push(gain);
    byId.set(id, list);
  }
  return byId;
}

describe('le moteur applique exactement le planning d’événements', () => {
  it('publie, à chaque pas, l’événement décidé par le flux events:global', () => {
    const engine = new RaceEngine(WORK_SEED);
    const { plan, advance } = replayPlanner(WORK_SEED);
    let mismatches = 0;
    const seen = new Set<EventId>();

    for (let stepNumber = 1; stepNumber <= TOTAL_STEPS; stepNumber += 1) {
      engine.step();
      advance(stepNumber);
      const characters = engine.getState().characters;

      for (const [index, character] of characters.entries()) {
        const expected = activeEventAt(plan, index);

        if (expected === null) {
          if (character.activeEvent !== null || character.eventBonus !== 0) {
            mismatches += 1;
          }
          continue;
        }

        seen.add(expected.id);
        if (
          character.activeEvent?.id !== expected.id ||
          character.activeEvent.target !== expected.target ||
          character.activeEvent.startSimS !== expected.startSimS ||
          character.activeEvent.durationS !== expected.durationS ||
          character.activeEvent.magnitude !== expected.magnitude ||
          character.eventBonus !== expected.magnitude
        ) {
          mismatches += 1;
        }
      }
    }

    // 3 600 pas × 6 personnages comparés à un planning reconstruit à part : au bit près.
    expect(mismatches).toBe(0);
    // La couverture des 7 types est vérifiée sur l'échantillon complet, plus bas. Sur une seule
    // course de 60 s (3,4 événements en moyenne), au moins deux types distincts : mesure 2.
    expect(seen.size).toBeGreaterThanOrEqual(2);
  });

  it('utilise l’événement du pas courant dans la vitesse cible du même pas', () => {
    const engine = new RaceEngine(WORK_SEED);
    const params = lateFormParams(GAME_CONFIG);
    let previousV = CHARACTER_IDS.map(() => SPEED.BASE);
    let mismatches = 0;

    for (let stepNumber = 1; stepNumber <= TOTAL_STEPS; stepNumber += 1) {
      engine.step();
      const characters = engine.getState().characters;

      for (const [index, character] of characters.entries()) {
        // Reconstruction depuis les seules valeurs **publiées** : si le moteur avait utilisé
        // l'événement d'un autre pas, ou oublié `eventBonus`, l'égalité au bit près échouerait. La
        // forme de fin de course (P013-cor6) multiplie cette cible : elle est relue sur le moteur et
        // appliquée par la même fonction que dans la boucle de simulation.
        const target = SPEED.BASE * (1 + character.drift + character.surge + character.eventBonus);
        const factor = lateFormFactor(engine.lateForms[index] ?? 0, stepNumber, params);
        const modulated = factor === 1 ? target : target * factor;
        if (integrateSpeed(previousV[index] ?? SPEED.BASE, modulated, CONFIG, DT) !== character.v) {
          mismatches += 1;
        }
      }

      previousV = characters.map((character) => character.v);
    }

    expect(mismatches).toBe(0);
  });

  it('n’écrit jamais dans x : seule l’intégration de la vitesse fait avancer la distance', () => {
    const engine = new RaceEngine(WORK_SEED);
    let previous = engine.getState().characters;
    let rogue = 0;

    for (let stepNumber = 1; stepNumber <= TOTAL_STEPS; stepNumber += 1) {
      engine.step();
      const characters = engine.getState().characters;

      for (const [index, character] of characters.entries()) {
        const before = previous[index];
        if (before === undefined) {
          throw new Error(`Personnage ${index} absent.`);
        }
        if (integratePosition(before.x, character.v, DT) !== character.x) {
          rogue += 1;
        }
      }

      previous = characters;
    }

    expect(rogue).toBe(0);
  });
});

describe('gain réellement produit par chaque événement', () => {
  it('couvre les 7 types du catalogue sur 40 courses', () => {
    const byId = gainsById(MEASURED);
    // La taille du corpus est **dérivée de la cadence design** (au moins 3 événements par course de
    // 60 s), pas d'un nombre absolu hérité des courses de 180 s : ce qui compte pour la couverture
    // des 7 types est le nombre d'événements observés, vérifié juste en dessous type par type.
    expect(MEASURED.gains.length).toBeGreaterThanOrEqual(MEASURED.raceCount * 3);

    for (const definition of EVENT_CATALOG) {
      // Y compris les plus rares : `MEGA_TURBO` (4,3 %) et `SIESTE` (6,3 %).
      expect(byId.get(definition.id)?.length ?? 0, definition.id).toBeGreaterThanOrEqual(3);
    }
  });

  it('produit le gain attendu par la table §7.2, avec le bon signe', () => {
    const byId = gainsById(MEASURED);

    for (const [id, values] of byId) {
      const expected = EXPECTED_GAIN[id];
      const sorted = [...values].sort((a, b) => a - b);
      const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
      const median = sorted[Math.floor(values.length / 2)] ?? mean;

      // Le gain **typique** est celui qu'annonce §7.2 : moyenne et médiane dans les bornes du DoD.
      expect(mean, `${id} moyenne`).toBeGreaterThanOrEqual(expected.min);
      expect(mean, `${id} moyenne`).toBeLessThanOrEqual(expected.max);
      expect(median, `${id} médiane`).toBeGreaterThanOrEqual(expected.min);
      expect(median, `${id} médiane`).toBeLessThanOrEqual(expected.max);

      // Chaque événement individuel reste dans une enveloppe bornée autour de ces valeurs (voir
      // `GAIN_ENVELOPE`), et garde le signe de son type.
      const isBonus =
        (EVENT_CATALOG.find((definition) => definition.id === id)?.magnitudeMax ?? 0) > 0;
      for (const value of values) {
        expect(value, `${id} borne basse`).toBeGreaterThanOrEqual(
          expected.min - Math.abs(expected.min) * GAIN_ENVELOPE,
        );
        expect(value, `${id} borne haute`).toBeLessThanOrEqual(
          expected.max + Math.abs(expected.max) * GAIN_ENVELOPE,
        );
      }
      if (isBonus) {
        expect(sorted[0] ?? 0, `${id} bonus`).toBeGreaterThan(0);
      } else {
        expect(sorted[sorted.length - 1] ?? 0, `${id} malus`).toBeLessThan(0);
      }
    }
  });

  it('respecte la progressivité directionnelle et les bornes, événements compris', () => {
    // Aucun pas hors des rampes de §6.2 sur 40 courses, y compris pendant `MEGA_TURBO` (cible 31,6 m/s,
    // le plus gros écart de vitesse du jeu) : c'est la vérification explicite du DoD.
    expect(MEASURED.rampViolations).toBe(0);
    expect(MEASURED.boundViolations).toBe(0);
    expect(MEASURED.megaTurboSteps).toBeGreaterThan(0);
  });

  it('conserve définitivement le gain acquis après la fin d’un bonus', () => {
    // Le jumeau continue sa course après la fin du bonus : la rampe de descente ramène la vitesse
    // vers la normale, elle ne retire aucune distance. L'avance acquise ne doit donc jamais diminuer,
    // puis rester stable — jusqu'au prochain événement subi par le même personnage, qui est une autre
    // histoire (un malus a parfaitement le droit de reprendre du terrain à un jumeau sans histoires).
    let trackedEvents = 0;
    let comparedSteps = 0;
    const params = lateFormParams(GAME_CONFIG);

    for (const seed of seeds(6, 'EVENTK')) {
      const engine = new RaceEngine(seed);
      const tracked = CHARACTER_IDS.map(
        () => null as null | { v: number; x: number; best: number; event: ActiveEvent },
      );
      let previous = engine.getState();

      for (let stepNumber = 1; stepNumber <= TOTAL_STEPS; stepNumber += 1) {
        engine.step();
        const state = engine.getState();

        for (const [index, character] of state.characters.entries()) {
          const previousCharacter = previous.characters[index];
          if (previousCharacter === undefined) {
            throw new Error(`Personnage ${index} absent.`);
          }
          const event = character.activeEvent;
          const twin = tracked[index] ?? null;
          // Le jumeau reçoit la **même** forme de fin de course que le personnage suivi : la
          // comparaison ne porte donc que sur l'événement, pas sur la règle de fin de course.
          const factor = lateFormFactor(engine.lateForms[index] ?? 0, stepNumber, params);
          const modulate = (target: number): number => (factor === 1 ? target : target * factor);

          if (twin === null) {
            // Seuls les bonus sont suivis : pour un malus, l'écart au jumeau doit au contraire
            // continuer de se creuser jusqu'à ce que les deux vitesses se rejoignent.
            if (event !== null && event.magnitude > 0) {
              const v = integrateSpeed(
                previousCharacter.v,
                modulate(SPEED.BASE * (1 + character.drift + character.surge)),
                CONFIG,
                DT,
              );
              tracked[index] = {
                v,
                x: integratePosition(previousCharacter.x, v, DT),
                best: Number.NEGATIVE_INFINITY,
                event,
              };
              trackedEvents += 1;
            }
            continue;
          }

          if (event !== null && event !== twin.event) {
            tracked[index] = null;
            continue;
          }

          // Le jumeau poursuit sa route, uniquement mû par la cible non modulée, et parcourt comme le
          // personnage réel le pas courant : les deux distances sont comparées au même instant.
          twin.v = integrateSpeed(
            twin.v,
            modulate(SPEED.BASE * (1 + character.drift + character.surge)),
            CONFIG,
            DT,
          );
          twin.x = integratePosition(twin.x, twin.v, DT);

          const gap = character.x - twin.x;
          // La tolérance n'est pas une marge de jeu : sur des positions de quelques kilomètres, un ulp
          // de flottant vaut ≈ 5 × 10⁻¹³ m, et la soustraction de deux positions voisines en accumule.
          expect(gap, `${seed} ${CHARACTER_IDS[index]} pas ${stepNumber}`).toBeGreaterThanOrEqual(
            twin.best - GAP_TOLERANCE,
          );
          twin.best = Math.max(twin.best, gap);
          comparedSteps += 1;
        }

        previous = state;
      }
    }

    // Sans événement mesuré, l'assertion de monotonie ne prouverait rien ; et elle doit porter sur
    // des milliers de pas, pas sur trois.
    expect(trackedEvents).toBeGreaterThan(0);
    expect(comparedSteps).toBeGreaterThan(10_000);
  });

  it('finit toujours à 3600 pas, quel que soit le nombre d’événements', () => {
    const counts: number[] = [];

    for (const seed of seeds(12, 'EVENTF')) {
      const engine = new RaceEngine(seed);
      const triggers = eventTriggers(seed).length;

      while (engine.getState().phase.kind !== 'finished') {
        engine.step();
      }

      const state = engine.getState();
      expect(state.steps).toBe(TOTAL_STEPS);
      expect(state.tSim).toBe(RACE_CONFIG.TOTAL_SIM_S);
      counts.push(triggers);
    }

    // Le nombre d'événements varie d'une course à l'autre, et aucune ne s'arrête avant l'heure : la
    // fin de course ne dépend donc d'aucun événement, ni d'aucune distance.
    expect(Math.max(...counts)).toBeGreaterThan(Math.min(...counts));
  });
});

describe('ciblage : aucun rubber-banding', () => {
  // Le test rejoue volontairement 1000 courses : sous charge parallèle il dépasse le délai par
  // défaut de Vitest. Le délai est donc déclaré localement, sans toucher à RACES ni à la logique.
  it('ne choisit jamais sa cible selon la position, et répartit les événements également', { timeout: 30_000 }, () => {
    // Test de propriété **non confondu**. La mesure littérale « corrélation entre position moyenne et
    // nombre d'événements » ne peut pas valoir zéro : elle mesure l'effet des événements, que §7.2
    // revendique (« un gros bonus vaut typiquement 2 à 5 places »). Mesuré sur 1800 couples
    // (course, personnage) : r = −0,13 en rang moyen, et même r = −0,10 pour le rang d'avant le
    // premier événement du personnage — les événements des *autres* personnages déplacent déjà ce
    // rang. La seule mesure insensible à cet effet est celle du **premier événement de la course** :
    // à cet instant, aucun événement ne s'est encore appliqué nulle part, donc les positions ne
    // doivent rien aux événements, et la cible doit être uniforme sur les 6 personnages.
    const rankCounts = [0, 0, 0, 0, 0, 0];
    const RACES = 1000;
    let rankSum = 0;
    let measured = 0;

    for (const seed of seeds(RACES, 'EVENTB')) {
      const first = eventTriggers(seed).reduce<EventTrigger | null>(
        (earliest, trigger) =>
          earliest === null || trigger.step < earliest.step ? trigger : earliest,
        null,
      );
      if (first === null) {
        // Une course de 60 s ne contient que 3,4 événements en moyenne : quelques pour cent des
        // courses n'en ont aucun. Les ignorer est sans effet sur la propriété mesurée — qu'une course
        // produise un événement ou non ne dépend pas du rang des personnages — et le nombre de
        // courses réellement mesurées est vérifié en fin de test.
        continue;
      }

      const engine = new RaceEngine(seed);
      for (let stepNumber = 1; stepNumber < first.step; stepNumber += 1) {
        engine.step();
      }

      const ranks = computeRanks(
        engine.getState().characters.map((character) => character.x),
        CHARACTER_IDS,
      );
      const rank = ranks[first.index];
      if (rank === undefined) {
        throw new Error(`Rang absent pour ${CHARACTER_IDS[first.index]}.`);
      }
      rankCounts[rank - 1] = (rankCounts[rank - 1] ?? 0) + 1;
      rankSum += rank;
      measured += 1;
    }

    // Une cible uniforme donne un rang moyen de 3,5 (écart-type 0,054 sur 1 000 courses) et environ
    // 167 cibles par rang (écart-type 11,8). Un « bonus au dernier », un « malus au leader » ou un
    // « peloton accéléré » déplacerait ces deux chiffres de plusieurs écarts-types.
    expect(measured).toBeGreaterThanOrEqual(Math.floor(RACES * 0.9));
    expect(Math.abs(rankSum / measured - 3.5)).toBeLessThan(0.2);
    for (const [position, count] of rankCounts.entries()) {
      expect(Math.abs(count - measured / 6), `rang ${position + 1}`).toBeLessThan(60);
    }
  });
});

describe('pauses : aucun pas, donc aucun tirage d’événement', () => {
  it('gèle un événement actif pendant une pause de checkpoint et rend la course identique', () => {
    const checkpointStep = RACE_CONFIG.STEPS_PER_SEGMENT;
    const found = findActiveEventAt(checkpointStep);
    const index = CHARACTER_IDS.indexOf(found.id);
    const reference = new RaceEngine(found.seed).runToCompletion();

    const simulation = new RaceSimulation(found.seed, { ...SIM_CONFIG, maxStepsPerFrame: 100_000 });
    simulation.start();
    simulation.update(SIM_CONFIG.countdownRealS * 1000);
    simulation.update(RACE_CONFIG.SEGMENT_DURATION_S * 1000);

    expect(simulation.phase).toBe('checkpointPause');
    expect(simulation.view.steps).toBe(checkpointStep);
    const before = simulation.view.characters[index]?.activeEvent;
    expect(before?.id).toBe(found.event.id);

    // 30 secondes réelles d'attente : ni pas, ni tirage, ni consommation de l'événement en cours.
    simulation.update(30_000);
    expect(simulation.phase).toBe('running');
    expect(simulation.view.steps).toBe(checkpointStep);
    const after = simulation.view.characters[index]?.activeEvent;
    expect(after?.startSimS).toBe(before?.startSimS);
    expect(after?.durationS).toBe(before?.durationS);
    expect(after?.magnitude).toBe(before?.magnitude);

    // La course entière reste bit à bit celle du noyau seul : aucun tirage n'a été perdu ni ajouté.
    let guard = 0;
    while (simulation.phase !== 'finished') {
      simulation.update(60_000);
      guard += 1;
      if (guard > 1000) {
        throw new Error('La course ne se termine jamais.');
      }
    }

    expect(simulation.view.steps).toBe(TOTAL_STEPS);
    simulation.view.characters.forEach((character, position) => {
      expect(Object.is(character.x, reference.distances[position]), `${CHARACTER_IDS[position]}`).toBe(
        true,
      );
    });
  });
});

/** Cherche, de façon déterministe, une seed dont un événement est actif au pas demandé. */
function findActiveEventAt(step: number): {
  readonly seed: string;
  readonly id: CharacterId;
  readonly event: ActiveEvent;
} {
  for (let index = 0; index < 80; index += 1) {
    const seed = `EVENTCP${String(index).padStart(2, '0')}`;
    const { plan, advance } = replayPlanner(seed);
    for (let current = 1; current <= step; current += 1) {
      advance(current);
    }
    for (const id of CHARACTER_IDS) {
      const position = CHARACTER_IDS.indexOf(id);
      const event = activeEventAt(plan, position);
      const slot = plan.slots[position];
      // Un événement auquel il reste plusieurs pas à courir, pour que la pause soit significative.
      if (event !== null && slot !== null && slot !== undefined && slot.endStep - step > 30) {
        return { seed, id, event };
      }
    }
  }
  throw new Error(`Aucun événement actif au pas ${step} dans les seeds essayées.`);
}

describe('reproductibilité', () => {
  it('rejoue les mêmes événements et les mêmes distances pour la même seed', () => {
    const first = new RaceEngine(WORK_SEED);
    const second = new RaceEngine(WORK_SEED);
    let different = 0;

    for (let stepNumber = 1; stepNumber <= TOTAL_STEPS; stepNumber += 1) {
      first.step();
      second.step();
      const a = first.getState();
      const b = second.getState();
      a.characters.forEach((character, index) => {
        const other = b.characters[index];
        if (
          character.eventBonus !== other?.eventBonus ||
          character.activeEvent?.id !== other?.activeEvent?.id
        ) {
          different += 1;
        }
      });
    }

    expect(different).toBe(0);
    expect(first.getState().characters.map((character) => character.x)).toEqual(
      second.getState().characters.map((character) => character.x),
    );
  });

  it('repart d’un planning neuf après reset avec une autre seed', () => {
    const engine = new RaceEngine(WORK_SEED);
    const traceOf = (): readonly number[] => {
      const values: number[] = [];
      for (let stepNumber = 0; stepNumber < 3000; stepNumber += 1) {
        engine.step();
        values.push(engine.getState().characters[0]?.eventBonus ?? 0);
      }
      return values;
    };

    const reference = traceOf();
    engine.reset(WORK_SEED);
    expect(traceOf()).toEqual(reference);

    engine.reset('BANAN4X2');
    expect(traceOf()).not.toEqual(reference);
  });

  it('ne décale ni la dérive ni les surges : le flux events:global est indépendant', () => {
    // P008 consomme `events:global` ; les dérives et surges de P004/P007 doivent rester identiques,
    // bit à bit, à ceux qu'on reconstruit depuis leurs propres flux. C'est ce qui garantit que P008
    // n'a invalidé aucune course existante autrement que par l'effet voulu des événements.
    const engine = new RaceEngine(WORK_SEED);
    const driftStream = forkStream(normalizeSeed(WORK_SEED), 'drift:c0');
    const surgeStream = forkStream(normalizeSeed(WORK_SEED), 'surge:c0');
    const surgeState = createSurgeState(surgeStream, SURGE_PARAMS);

    let drift = 0;
    let mismatches = 0;

    for (let stepNumber = 1; stepNumber <= TOTAL_STEPS; stepNumber += 1) {
      engine.step();
      drift = stepOrnsteinUhlenbeck(drift, gaussianFrom(driftStream), {
        dt: DT,
        theta: CONFIG.DRIFT.THETA,
        sigma: CONFIG.DRIFT.SIGMA,
        sqrtDt: SQRT_DT,
        clampValue: CONFIG.DRIFT.CLAMP,
      });
      const expectedSurge = stepSurge(surgeState, surgeStream, SURGE_PARAMS, stepNumber);
      const character = engine.getState().characters[0];

      if (character?.drift !== drift || character.surge !== expectedSurge) {
        mismatches += 1;
      }
    }

    // Si consommer `events:global` décalait `drift:c0` ou `surge:c0`, les suites divergeraient dès le
    // premier pas.
    expect(mismatches).toBe(0);
  });
});
