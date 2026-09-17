import { describe, expect, it } from 'vitest';

import { CHARACTER_IDS } from '../../src/core/characters';
import type { GameConfig } from '../../src/core/config';
import { GAME_CONFIG, RACE_CONFIG, SPEED } from '../../src/core/config';
import {
  EVENT_CATALOG,
  EVENT_TOTAL_WEIGHT,
  activeEventAt,
  createEventPlan,
  eventParams,
  stepEvents,
  validateEventCatalog,
} from '../../src/core/events';
import type { EventDefinition } from '../../src/core/events';
import { RngStream, forkStream } from '../../src/core/rng';
import { normalizeSeed } from '../../src/core/seed';
import type { ActiveEvent, CharacterId, EventId } from '../../src/core/types';

/**
 * P008 — le catalogue (§7.1) et le planificateur (§7.3), **sans moteur**.
 *
 * Le planificateur ne dépend ni des distances, ni des vitesses, ni du rang : il peut donc être
 * éprouvé seul, et c'est ce qui permet de vérifier les mécanismes sur 1000 seeds à coût quasi nul.
 * L'intégration dans la course — l'événement module réellement la vitesse cible, et rien n'est tiré
 * pendant une pause — est vérifiée dans `eventsRace.test.ts`.
 */

const DT = RACE_CONFIG.DT_S;
const PARAMS = eventParams(GAME_CONFIG);
const TOTAL_STEPS = RACE_CONFIG.TOTAL_STEPS;

type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** Les 7 identifiants de §7.1, écrits une fois : l'exhaustivité est vérifiée par le compilateur. */
const DOCUMENTED_IDS = [
  'TURBO',
  'CHUTE',
  'VENT_DE_FACE',
  'RACCOURCI',
  'POULET',
  'SIESTE',
  'MEGA_TURBO',
] as const satisfies readonly EventId[];

const idsAreExhaustive: Equals<(typeof DOCUMENTED_IDS)[number], EventId> = true;

/** Table §7.1, recopiée à la main : c'est elle qui fait foi pour ce test. */
const DOCUMENTED: Readonly<
  Record<
    EventId,
    {
      readonly weight: number;
      readonly magnitudeMin: number;
      readonly magnitudeMax: number;
      readonly durationMinS: number;
      readonly durationMaxS: number;
    }
  >
> = Object.freeze({
  TURBO: { weight: 22, magnitudeMin: 0.78, magnitudeMax: 1.17, durationMinS: 2.5, durationMaxS: 4.0 },
  CHUTE: { weight: 20, magnitudeMin: -0.75, magnitudeMax: -0.55, durationMinS: 2.5, durationMaxS: 5.0 },
  VENT_DE_FACE: { weight: 18, magnitudeMin: -0.45, magnitudeMax: -0.3, durationMinS: 4.0, durationMaxS: 7.0 },
  RACCOURCI: { weight: 12, magnitudeMin: 1.04, magnitudeMax: 1.3, durationMinS: 2.5, durationMaxS: 3.5 },
  POULET: { weight: 10, magnitudeMin: -0.35, magnitudeMax: -0.2, durationMinS: 2.0, durationMaxS: 4.0 },
  SIESTE: { weight: 6, magnitudeMin: -0.7, magnitudeMax: -0.7, durationMinS: 5.0, durationMaxS: 5.0 },
  MEGA_TURBO: { weight: 4, magnitudeMin: 1.63, magnitudeMax: 1.63, durationMinS: 5.0, durationMaxS: 5.0 },
});

/**
 * Flux scripté : rend les valeurs 32 bits demandées, dans l'ordre.
 *
 * Il sert à fabriquer un tirage **exact** (tel événement, telle cible, telle durée) plutôt qu'à
 * attendre qu'une seed le produise, sans jamais dépendre du hasard réel.
 */
function scripted(values: readonly number[]): RngStream {
  let index = 0;
  class ScriptedStream extends RngStream {
    constructor() {
      super(() => 0);
    }

    override next(): number {
      const value = values[index] ?? 0;
      index += 1;
      return value >>> 0;
    }
  }
  return new ScriptedStream();
}

/** Valeur 32 bits produisant `nextFloat() = fraction`. */
function floatValue(fraction: number): number {
  return Math.floor(fraction * 0x1_0000_0000);
}

/** Fraction à tirer pour qu'un `weightedPick` sur le catalogue tombe sur `id`. */
function fractionFor(id: EventId): number {
  const index = EVENT_CATALOG.findIndex((definition) => definition.id === id);
  if (index < 0) {
    throw new RangeError(`Événement inconnu : ${id}.`);
  }
  const before = EVENT_CATALOG.slice(0, index).reduce((sum, definition) => sum + definition.weight, 0);
  // Milieu de la tranche de l'événement : jamais sur une frontière.
  return (before + (EVENT_CATALOG[index]?.weight ?? 0) / 2) / EVENT_TOTAL_WEIGHT;
}

interface EventObservation {
  readonly step: number;
  readonly index: number;
  readonly event: ActiveEvent;
  readonly endStep: number;
  /** `true` si l'événement a remplacé un autre événement encore actif (seul cas : `CHUTE`/`TURBO`). */
  readonly replacesActive: boolean;
  readonly replacedId: EventId | null;
  /** Pas du précédent événement **du même personnage, dans la même course**, ou `null`. */
  readonly previousStep: number | null;
  /** Pas du précédent événement **de la même course**, tous personnages confondus, ou `null`. */
  readonly previousGlobalStep: number | null;
}

/**
 * Fait tourner le planificateur seul sur une course complète et rapporte chaque déclenchement.
 *
 * Un déclenchement est détecté par **identité** de la fiche : le planificateur remplace l'objet quand
 * il déclenche, et conserve le même objet sinon. L'état « connu » est mis à jour en place, sans
 * allouer quoi que ce soit dans la boucle : à 1000 seeds, cela représente 10,8 millions de pas.
 *
 * `idsAtStep` permet de présenter les personnages dans un ordre dicté par un « monde » artificiel :
 * c'est ce que le planificateur reçoit — et tout ce qu'il reçoit avec le pas et le flux.
 */
function runPlanner(
  seed: string,
  observe: (observation: EventObservation) => void,
  idsAtStep: (step: number) => readonly CharacterId[] = () => CHARACTER_IDS,
): void {
  const plan = createEventPlan(CHARACTER_IDS.length);
  const stream = forkStream(normalizeSeed(seed), 'events:global');
  const known: (ActiveEvent | null)[] = CHARACTER_IDS.map(() => null);
  const lastStep: (number | null)[] = CHARACTER_IDS.map(() => null);
  let lastGlobalStep: number | null = null;

  for (let step = 1; step <= TOTAL_STEPS; step += 1) {
    stepEvents(plan, stream, PARAMS, idsAtStep(step), step);

    for (let index = 0; index < known.length; index += 1) {
      const event = activeEventAt(plan, index);
      const previous = known[index] ?? null;
      if (event === previous) {
        continue;
      }
      known[index] = event;
      if (event === null) {
        continue;
      }

      const slot = plan.slots[index];
      if (slot === null || slot === undefined) {
        throw new Error('Emplacement vide pour un événement actif.');
      }

      observe({
        step,
        index,
        event,
        endStep: slot.endStep,
        replacesActive: previous !== null,
        replacedId: previous === null ? null : previous.id,
        previousStep: lastStep[index] ?? null,
        previousGlobalStep: lastGlobalStep,
      });
      lastStep[index] = step;
      lastGlobalStep = step;
    }
  }
}

interface EventStatistics {
  readonly races: number;
  readonly events: number;
  readonly perRaceCounts: readonly number[];
  readonly perCharacterCounts: readonly number[];
  /** Maximum, sur toutes les courses, du nombre d'événements subis par un même personnage. */
  readonly maxPerRacePerCharacter: number;
  readonly observations: readonly EventObservation[];
  readonly replacements: number;
}

/** Statistiques du planificateur sur `races` seeds, indépendamment du moteur. */
function measureEvents(races: number, prefix = 'EVENT'): EventStatistics {
  const perRaceCounts: number[] = [];
  const perCharacterCounts = CHARACTER_IDS.map(() => 0);
  const observations: EventObservation[] = [];
  let replacements = 0;
  let total = 0;
  let maxPerRacePerCharacter = 0;

  for (let race = 0; race < races; race += 1) {
    const seed = `${prefix}${String(race).padStart(4, '0')}`;
    const inRace = CHARACTER_IDS.map(() => 0);
    let count = 0;

    runPlanner(seed, (observation) => {
      count += 1;
      total += 1;
      perCharacterCounts[observation.index] = (perCharacterCounts[observation.index] ?? 0) + 1;
      inRace[observation.index] = (inRace[observation.index] ?? 0) + 1;
      if (observation.replacesActive) {
        replacements += 1;
      }
      observations.push(observation);
    });

    maxPerRacePerCharacter = Math.max(maxPerRacePerCharacter, ...inRace);
    perRaceCounts.push(count);
  }

  return {
    races,
    events: total,
    perRaceCounts,
    perCharacterCounts,
    maxPerRacePerCharacter,
    observations,
    replacements,
  };
}

describe('catalogue d’événements', () => {
  it('reprend exactement la table de GAME_DESIGN §7.1', () => {
    expect(idsAreExhaustive).toBe(true);
    expect(EVENT_CATALOG.map((definition) => definition.id)).toEqual([...DOCUMENTED_IDS]);
    expect(EVENT_TOTAL_WEIGHT).toBe(92);

    for (const definition of EVENT_CATALOG) {
      const expected = DOCUMENTED[definition.id];
      expect(definition.weight, definition.id).toBe(expected.weight);
      expect(definition.magnitudeMin, definition.id).toBe(expected.magnitudeMin);
      expect(definition.magnitudeMax, definition.id).toBe(expected.magnitudeMax);
      expect(definition.durationMinS, definition.id).toBe(expected.durationMinS);
      expect(definition.durationMaxS, definition.id).toBe(expected.durationMaxS);
    }
  });

  it('garde chaque vitesse cible nominale entre SPEED.MIN et SPEED.MAX', () => {
    for (const definition of EVENT_CATALOG) {
      const fastest = SPEED.BASE * (1 + definition.magnitudeMax);
      const slowest = SPEED.BASE * (1 + definition.magnitudeMin);

      // Aucun événement n'est écrêté par le plafond dur : les gains de §7.2 sont donc réels.
      expect(fastest, definition.id).toBeLessThanOrEqual(SPEED.MAX);
      expect(slowest, definition.id).toBeGreaterThanOrEqual(SPEED.MIN);
    }

    // Les deux vitesses vitrines annoncées par §7.1.
    expect(SPEED.BASE * (1 + 2.5)).toBe(42);
    expect(SPEED.BASE * (1 + 2.0)).toBe(36);
  });

  it('refuse un catalogue incohérent', () => {
    const first = EVENT_CATALOG[0] as EventDefinition;
    const catalog = (overrides: Partial<EventDefinition>): readonly EventDefinition[] => [
      { ...first, ...overrides },
    ];

    expect(() => validateEventCatalog([])).toThrow(RangeError);
    expect(() => validateEventCatalog(catalog({ weight: 0 }))).toThrow(RangeError);
    expect(() => validateEventCatalog(catalog({ magnitudeMin: 1, magnitudeMax: -1 }))).toThrow(
      RangeError,
    );
    expect(() => validateEventCatalog(catalog({ magnitudeMin: -1 }))).toThrow(RangeError);
    expect(() => validateEventCatalog(catalog({ durationMinS: 0 }))).toThrow(RangeError);
    expect(() => validateEventCatalog(catalog({ durationMaxS: 1 }))).toThrow(RangeError);
    expect(() =>
      validateEventCatalog([first, { ...(EVENT_CATALOG[1] as EventDefinition), id: 'TURBO' }]),
    ).toThrow(RangeError);
  });

  it('refuse une configuration dont les constantes contrediraient le catalogue', () => {
    // Un événement dont la cible dépasserait SPEED.MAX serait écrêté : le gain annoncé serait faux.
    const tooFast: GameConfig = { ...GAME_CONFIG, SPEED: { ...GAME_CONFIG.SPEED, MAX: 30 } };
    expect(() => eventParams(tooFast)).toThrow(RangeError);

    // Un emplacement par personnage est structurel : `MAX_ACTIVE_PER_CHARACTER` ne peut valoir que 1.
    const stacked: GameConfig = {
      ...GAME_CONFIG,
      EVENT: { ...GAME_CONFIG.EVENT, MAX_ACTIVE_PER_CHARACTER: 2 },
    };
    expect(() => eventParams(stacked)).toThrow(RangeError);
  });

  it('tire les événements proportionnellement à leurs poids', () => {
    const stream = forkStream(normalizeSeed('POIDS000'), 'events:global');
    const draws = 20_000;
    const counts = new Map<EventId, number>();

    for (let draw = 0; draw < draws; draw += 1) {
      const spec = stream.weightedPick(PARAMS.specs, PARAMS.weights);
      counts.set(spec.definition.id, (counts.get(spec.definition.id) ?? 0) + 1);
    }

    for (const definition of EVENT_CATALOG) {
      const measured = (counts.get(definition.id) ?? 0) / draws;
      const expected = definition.weight / EVENT_TOTAL_WEIGHT;
      // 20 000 tirages : l'écart-type d'une fréquence de 4,3 % vaut 0,14 %, la tolérance de 1 point
      // ne teste donc que l'ordre de grandeur (le générateur lui-même est testé en P003).
      expect(Math.abs(measured - expected), definition.id).toBeLessThan(0.01);
    }
  });
});

describe('planificateur : tirage forcé', () => {
  it('déclenche l’événement tiré sur la cible tirée, à la durée tirée', () => {
    const plan = createEventPlan(CHARACTER_IDS.length);
    // Candidat, identifiant (RACCOURCI), cible (index 3), durée (borne haute = 210 pas = 3,5 s),
    // magnitude (milieu de [1,04 ; 1,30] = 1,17).
    const stream = scripted([0, floatValue(fractionFor('RACCOURCI')), 3, 210 - 150, floatValue(0.5)]);

    stepEvents(plan, stream, PARAMS, CHARACTER_IDS, 1);

    const event = activeEventAt(plan, 3);
    expect(event).not.toBeNull();
    expect(event?.id).toBe('RACCOURCI');
    expect(event?.target).toBe('c3');
    expect(event?.startSimS).toBe(0);
    expect(event?.durationS).toBe(210 * DT);
    expect(event?.magnitude).toBeCloseTo(1.17, 12);

    const slot = plan.slots[3];
    expect(slot?.endStep).toBe(211);
    expect(plan.counts[3]).toBe(1);
    expect(plan.lastTriggerStep).toBe(1);
  });

  it('ne déclenche rien sans candidat, et rien pendant un cooldown global', () => {
    const plan = createEventPlan(CHARACTER_IDS.length);
    stepEvents(plan, scripted([0xffff_ffff]), PARAMS, CHARACTER_IDS, 5);
    expect(plan.slots.every((slot) => slot === null)).toBe(true);
    expect(plan.lastTriggerStep).toBeNull();

    // Premier événement au pas 5 : le suivant, 3 s plus tard, est refusé par le cooldown global de 4 s.
    stepEvents(
      plan,
      scripted([0, floatValue(fractionFor('POULET')), 0, 0, floatValue(0)]),
      PARAMS,
      CHARACTER_IDS,
      5,
    );
    expect(plan.lastTriggerStep).toBe(5);

    stepEvents(
      plan,
      scripted([0, floatValue(fractionFor('POULET')), 0, 0, floatValue(0)]),
      PARAMS,
      CHARACTER_IDS,
      185,
    );
    expect(plan.lastTriggerStep).toBe(5);
    expect(plan.counts.reduce((sum, count) => sum + count, 0)).toBe(1);
  });

  it('rejette un candidat tombé pendant un cooldown, sans le reporter à sa fin', () => {
    // §7.3 : le tirage est éclairci (thinning) par les cooldowns, jamais différé. La preuve est
    // directe : le candidat de 185 a été rejeté ; au pas 241 le cooldown global (240 pas après le pas
    // 1) est écoulé, et pourtant **aucun** événement ne se déclenche si aucun nouveau candidat n'est
    // tiré. Un candidat simplement mis en attente se serait déclenché ici.
    const plan = createEventPlan(CHARACTER_IDS.length);
    stepEvents(
      plan,
      scripted([0, floatValue(fractionFor('POULET')), 0, 0, floatValue(0)]),
      PARAMS,
      CHARACTER_IDS,
      1,
    );
    expect(plan.lastTriggerStep).toBe(1);

    // Candidat pendant le cooldown : rejeté.
    stepEvents(
      plan,
      scripted([0, floatValue(fractionFor('POULET')), 0, 0, floatValue(0)]),
      PARAMS,
      CHARACTER_IDS,
      200,
    );
    expect(plan.lastTriggerStep).toBe(1);

    // Cooldown écoulé, mais pas de candidat : rien ne se déclenche. Rien n'était « en attente ».
    stepEvents(plan, scripted([0xffff_ffff]), PARAMS, CHARACTER_IDS, 241);

    // Un mois plus tard, toujours rien, tant que le flux ne tire pas de candidat. Le `POULET` de
    // l'unique déclenchement est terminé depuis longtemps : aucun emplacement n'est occupé.
    stepEvents(plan, scripted([0xffff_ffff]), PARAMS, CHARACTER_IDS, 5000);

    expect(plan.counts.reduce((sum, count) => sum + count, 0)).toBe(1);
    expect(plan.slots.every((slot) => slot === null)).toBe(true);
  });

  it('ne dépend ni des positions ni du classement : même flux sur un « monde » réordonné', () => {
    // Preuve **structurelle** demandée en complément du test statistique : le planificateur ne reçoit
    // que le planning, le flux, les constantes, l'ordre des personnages et le numéro du pas. On rejoue
    // donc exactement le même flux, mais en présentant les personnages dans l'ordre d'un monde
    // artificiel qui change à chaque pas (positions et classements faux). Doivent rester strictement
    // identiques : les pas de déclenchement, les identifiants, les durées, les magnitudes et l'index
    // tiré. Seule l'identité du personnage suit l'ordre reçu — jamais sa place dans le monde.
    const seed = 'MONDE001';
    // Monde hostile : rotation déterministe, revue à chaque pas (jamais l'ordre du roster).
    const hostile = (step: number): readonly CharacterId[] => {
      const shift = (step * 7 + Math.floor(step / 13)) % CHARACTER_IDS.length;
      return CHARACTER_IDS.map(
        (_, index) => CHARACTER_IDS[(index + shift) % CHARACTER_IDS.length] as CharacterId,
      );
    };

    const signature = (observation: EventObservation): string =>
      `${observation.step}|${observation.event.id}|${observation.event.durationS}|${observation.event.magnitude}|${observation.index}`;

    const reference: string[] = [];
    const perturbed: string[] = [];
    const targets: { readonly step: number; readonly index: number; readonly target: CharacterId }[] =
      [];

    runPlanner(seed, (observation) => {
      reference.push(signature(observation));
    });
    runPlanner(
      seed,
      (observation) => {
        perturbed.push(signature(observation));
        targets.push({ step: observation.step, index: observation.index, target: observation.event.target });
      },
      hostile,
    );

    // Aucune décision ne bouge, l'index tiré compris.
    expect(perturbed).toEqual(reference);
    // Et l'identité du personnage est exactement celle de l'ordre reçu à ce pas.
    expect(targets.length).toBeGreaterThan(0);
    for (const { step, index, target } of targets) {
      expect(target, `pas ${step}`).toBe(hostile(step)[index]);
    }

    // Le monde a réellement été hostile : sans cela, la comparaison ne prouverait rien.
    expect(hostile(1)).not.toEqual([...CHARACTER_IDS]);
  });

  it('refuse un second événement sur un personnage déjà occupé', () => {
    const plan = createEventPlan(CHARACTER_IDS.length);
    // VENT_DE_FACE (long) sur c0, à sa durée maximale (7 s = 420 pas).
    stepEvents(
      plan,
      scripted([0, floatValue(fractionFor('VENT_DE_FACE')), 0, 420 - 240, floatValue(0.5)]),
      PARAMS,
      CHARACTER_IDS,
      1,
    );
    const before = activeEventAt(plan, 0);
    expect(before?.id).toBe('VENT_DE_FACE');

    // Second candidat 5 s plus tard : le flux désigne c0, mais c0 est encore occupé. L'événement part
    // donc sur le premier personnage éligible, et c0 conserve son événement d'origine.
    stepEvents(
      plan,
      scripted([0, floatValue(fractionFor('VENT_DE_FACE')), 0, 0, floatValue(0.5)]),
      PARAMS,
      CHARACTER_IDS,
      301,
    );

    expect(activeEventAt(plan, 0)).toBe(before);
    expect(plan.counts[0]).toBe(1);
  });

  it('ne remplace jamais un événement en cours, même à cooldowns nuls', () => {
    // La V1 n'a **aucune** règle de remplacement : un personnage qui subit déjà un événement n'est
    // pas éligible, quel que soit l'événement tiré. Jusqu'à P010, `CHUTE` pouvait écraser un `TURBO`
    // actif ; la dérogation a été supprimée parce qu'elle était inatteignable avec les constantes de
    // §7.3 (`CHAR_COOLDOWN_S = 8 s` > durée maximale d'un `TURBO`, 4 s). Ce test neutralise donc les
    // deux cooldowns **exprès** : il vérifie que la règle tient par structure, et non par un concours
    // de constantes qui pourrait se défaire au prochain réglage.
    const permissive = eventParams({
      ...GAME_CONFIG,
      EVENT: { ...GAME_CONFIG.EVENT, GLOBAL_COOLDOWN_S: 0, CHAR_COOLDOWN_S: 0 },
    });
    const plan = createEventPlan(CHARACTER_IDS.length);
    // TURBO à sa durée maximale (4 s = 240 pas) sur c0.
    stepEvents(
      plan,
      scripted([0, floatValue(fractionFor('TURBO')), 0, 240 - 150, floatValue(0.5)]),
      permissive,
      CHARACTER_IDS,
      1,
    );
    const turbo = activeEventAt(plan, 0);
    expect(turbo?.id).toBe('TURBO');

    // 3 s plus tard, le flux désigne CHUTE puis c0 : c0 est occupé, donc écarté du tirage.
    stepEvents(
      plan,
      scripted([0, floatValue(fractionFor('CHUTE')), 0, 0, floatValue(0.5)]),
      permissive,
      CHARACTER_IDS,
      181,
    );

    expect(activeEventAt(plan, 0)).toBe(turbo);
    expect(plan.counts[0]).toBe(1);
    // La `CHUTE` n'est pas perdue pour autant : elle part sur un autre personnage éligible.
    expect(plan.counts.reduce((sum, count) => sum + count, 0)).toBe(2);
  });

  it('garde le cooldown individuel plus long que le TURBO maximal', () => {
    // Cette inégalité de constantes est la raison pour laquelle la règle « `CHUTE` annule un `TURBO` »
    // a été **supprimée** en P010 plutôt que conservée comme garde : elle était inatteignable, et
    // aucune course ne l'exerçait. Le test l'épingle pour que le raisonnement reste vérifiable.
    expect(GAME_CONFIG.EVENT.CHAR_COOLDOWN_S).toBeGreaterThan(
      EVENT_CATALOG.reduce((longest, definition) => Math.max(longest, definition.durationMaxS), 0),
    );
  });

  it('ne peut pas replacer un événement sur un personnage encore sous cooldown', () => {
    // Documentation chiffrée : après un `TURBO` déclenché au pas 1, le premier candidat que le
    // cooldown global laisse passer arrive au pas 241 — exactement le pas où l'emplacement d'un
    // `TURBO` de durée maximale se vide (`endStep` exclu). Le cooldown individuel (480 pas) court
    // alors encore : le personnage n'est donc pas rééligible.
    const plan = createEventPlan(CHARACTER_IDS.length);
    stepEvents(
      plan,
      scripted([0, floatValue(fractionFor('TURBO')), 0, 240 - 150, floatValue(0.5)]),
      PARAMS,
      CHARACTER_IDS,
      1,
    );
    expect(activeEventAt(plan, 0)?.id).toBe('TURBO');
    expect(plan.slots[0]?.endStep).toBe(241);

    for (const step of [240, 241, 300, 479]) {
      stepEvents(
        plan,
        scripted([0, floatValue(fractionFor('CHUTE')), 0, 0, floatValue(0.5)]),
        PARAMS,
        CHARACTER_IDS,
        step,
      );
      // c0 n'est jamais retenu : soit le pas est sous le cooldown global (240), soit son `TURBO` est
      // terminé et le cooldown individuel court encore (241, 300, 479).
      expect(plan.counts[0], `pas ${step}`).toBe(1);
    }

    // Un seul candidat a effectivement été accepté (pas 241), sur un autre personnage.
    expect(activeEventAt(plan, 0)).toBeNull();
    expect(plan.counts.reduce((sum, count) => sum + count, 0)).toBe(2);
  });
});

describe('planificateur : mécanismes sur 1000 seeds', () => {
  const statistics = measureEvents(1000);

  it('déclenche 3 à 6 événements par course de 60 s, soit un toutes les 18 s environ', () => {
    const mean = statistics.events / statistics.races;

    // `EVENT.RATE_PER_S = 1 / 14` est un **taux** — un candidat toutes les 14 s — éclairci par les
    // cooldowns (§7.3) : le nombre d'événements d'une course suit donc mécaniquement sa durée, et
    // seul le **nombre par seconde** est une grandeur de game design. La course de 180 s d'avant la
    // passe corrective en produisait 10,1, soit un toutes les 17,9 s ; celle de 60 s en produit
    // 3,40, soit un toutes les 17,7 s : même cadence, aucune constante de tirage ajustée.
    const cadenceS = (RACE_CONFIG.TOTAL_SIM_S * statistics.races) / statistics.events;
    expect(mean).toBeGreaterThanOrEqual(3);
    expect(mean).toBeLessThanOrEqual(6);
    expect(cadenceS).toBeGreaterThan(15);
    expect(cadenceS).toBeLessThan(22);

    // Bornes de vraisemblance d'une loi de Poisson éclaircie de moyenne 3,4 : garde-fous contre un
    // planificateur cassé, pas seuils de game design. Mesure : minimum 0, maximum 8 sur 1 000
    // courses ; la borne haute est posée à `3 ×` la moyenne théorique.
    expect(Math.min(...statistics.perRaceCounts)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...statistics.perRaceCounts)).toBeLessThanOrEqual(10);
  });

  it('ne dépasse jamais 5 événements par personnage', () => {
    expect(statistics.maxPerRacePerCharacter).toBeLessThanOrEqual(
      GAME_CONFIG.EVENT.MAX_PER_CHARACTER,
    );
    expect(statistics.events).toBe(statistics.perRaceCounts.reduce((sum, count) => sum + count, 0));
    expect(statistics.perCharacterCounts.reduce((sum, count) => sum + count, 0)).toBe(
      statistics.events,
    );
  });

  it('répartit les événements également entre les 6 personnages', () => {
    for (const [index, count] of statistics.perCharacterCounts.entries()) {
      const share = count / statistics.events;
      // §13 : part de chaque personnage entre 10 % et 27 %. Aucun personnage n'est avantagé, donc
      // aucune « aide au dernier » ni « ralentissement du leader » ne peut se cacher ici.
      expect(share, CHARACTER_IDS[index]).toBeGreaterThan(0.1);
      expect(share, CHARACTER_IDS[index]).toBeLessThan(0.27);
    }
  });

  it('ne viole jamais un cooldown, et ne cumule jamais deux événements', () => {
    let globalViolations = 0;
    let characterViolations = 0;
    let illegal = 0;

    for (const observation of statistics.observations) {
      if (
        observation.previousGlobalStep !== null &&
        observation.step - observation.previousGlobalStep < PARAMS.globalCooldownSteps
      ) {
        globalViolations += 1;
      }
      if (
        observation.previousStep !== null &&
        observation.step - observation.previousStep < PARAMS.characterCooldownSteps
      ) {
        characterViolations += 1;
      }

      // Aucun cumul : le seul remplacement autorisé par §7.3 est `CHUTE` sur `TURBO`, et il est
      // structurellement impossible avec les constantes de la V1 (voir `events.test.ts`, test dédié).
      if (
        observation.replacesActive &&
        !(observation.event.id === 'CHUTE' && observation.replacedId === 'TURBO')
      ) {
        illegal += 1;
      }
    }

    expect(globalViolations).toBe(0);
    expect(characterViolations).toBe(0);
    expect(illegal).toBe(0);
  });

  it('respecte les bornes et la durée annoncée de chaque événement', () => {
    let outOfRange = 0;
    let durationMismatch = 0;

    for (const observation of statistics.observations) {
      const definition = EVENT_CATALOG.find((event) => event.id === observation.event.id);
      if (definition === undefined) {
        throw new Error(`Événement hors catalogue : ${observation.event.id}`);
      }

      const { magnitude, durationS } = observation.event;
      if (magnitude < definition.magnitudeMin || magnitude > definition.magnitudeMax) {
        outOfRange += 1;
      }
      if (durationS < definition.durationMinS || durationS > definition.durationMaxS) {
        outOfRange += 1;
      }
      // La durée publiée et la frontière de fin décrivent exactement le même nombre de pas.
      if (durationS !== (observation.endStep - observation.step) * DT) {
        durationMismatch += 1;
      }
    }

    expect(outOfRange).toBe(0);
    expect(durationMismatch).toBe(0);
  });
});
