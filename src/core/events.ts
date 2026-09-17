import type { GameConfig } from './config';
import type { RngStream } from './rng';
import type { ActiveEvent, CharacterId, EventId } from './types';

/**
 * Les événements rares (P008) : le catalogue de `GAME_DESIGN.md` §7.1 et le planificateur §7.3.
 *
 * Un événement n'est **jamais** un déplacement : c'est une modulation de la vitesse **cible**
 * (`event_i` de §6), qui passe ensuite par la rampe puis par l'écrêtage, comme n'importe quelle
 * autre variation. Ce module ne touche donc ni `x`, ni `v`, ni `RaceState` : il décide seulement
 * *qui* subit *quoi*, *quand*, et pendant *combien de temps*.
 *
 * ## Trois choix structurants
 *
 * 1. **Processus de Poisson en temps discret.** Le planificateur tire un candidat à **chaque pas**,
 *    avec la probabilité `RATE_PER_S × DT_S` : l'intervalle moyen entre deux candidats vaut donc
 *    exactement `1 / RATE_PER_S = 14 s`. Aucune fonction transcendante n'est nécessaire — une loi
 *    exponentielle par inversion demanderait `Math.log`, interdit par §10.2 — et tout reste
 *    reproductible. Un candidat qui tombe pendant un cooldown est **rejeté**, pas reporté : les
 *    cooldowns éclaircissent (thinning) le processus, qui garde donc son absence de mémoire, et la
 *    course compte `≈ 10,2` événements (§13). P010 a testé `1 / 10` puis est **revenu à `1 / 14`** :
 *    le compte restait dans la fourchette `[10 ; 16]`, et « proche d'une borne » n'est pas un motif
 *    de réglage. Le catalogue a été rendu net neutre en distance par la même étape — voir les
 *    magnitudes de bonus ci-dessous.
 * 2. **Tout est compté en pas entiers.** Durées, cooldowns et frontières de fin sont des nombres de
 *    pas : seule l'arithmétique entière est exactement spécifiée par ECMAScript, donc le planning ne
 *    peut pas dériver d'un moteur JavaScript à l'autre.
 * 3. **Un emplacement par personnage** (`MAX_ACTIVE_PER_CHARACTER = 1`) : le non-cumul est
 *    structurel, et il est **absolu** — un personnage qui subit déjà un événement n'est plus
 *    éligible, sans exception. P010 a supprimé la seule dérogation qui existait (`CHUTE` remplaçant
 *    un `TURBO` actif, §7.3) : elle était inatteignable avec les constantes de la V1, et une règle
 *    normative qui ne peut pas se déclencher est un piège pour le prochain réglage.
 *
 * ## Convention d'intervalle : `[startStep, endStep)`
 *
 * Comme pour les surges, l'événement déclenché au pas `startStep` s'applique **déjà** à ce pas, et
 * son dernier pas est `endStep - 1`. Il influence donc exactement `durationSteps` intégrations.
 *
 * ## Anti-triche
 *
 * La cible est tirée **uniformément** parmi les personnages éligibles (cooldowns, plafond, emplacement
 * libre). Aucun tirage ne consulte le rang, la distance, l'écart, le leader ou le dernier : les
 * remontées spectaculaires émergent de la variance, elles ne sont jamais organisées.
 *
 * ## Neutralité en distance (P010)
 *
 * À poids et durées égaux, un bonus rapporte **plus** de distance qu'un malus n'en retire : le gain
 * n'est pas proportionnel à la magnitude mais à `BASE × (1 + m)`, donc la famille positive est
 * convexe. Mesuré sur 100 seeds, le catalogue d'origine ajoutait `+0,90 %` de distance moyenne à lui
 * seul. Les magnitudes de **bonus** ont donc été réduites de 35 % (`× 0,65`), ce qui ramène
 * l'ensemble du catalogue à la neutralité ; les **malus** sont inchangés, faute de raison mesurée de
 * les aggraver.
 */

/** Fiche normative d'un événement du catalogue. */
export interface EventDefinition {
  readonly id: EventId;
  /** Poids du tirage pondéré (§7.1). Somme du catalogue : `92`. */
  readonly weight: number;
  /** Borne basse de la magnitude relative, signée. */
  readonly magnitudeMin: number;
  /** Borne haute de la magnitude relative, signée. */
  readonly magnitudeMax: number;
  readonly durationMinS: number;
  readonly durationMaxS: number;
}

/** Catalogue V1, copie exacte de `GAME_DESIGN.md` §7.1. */
export const EVENT_CATALOG: readonly EventDefinition[] = Object.freeze([
  Object.freeze({
    id: 'TURBO',
    weight: 22,
    magnitudeMin: 0.78,
    magnitudeMax: 1.17,
    durationMinS: 2.5,
    durationMaxS: 4.0,
  }),
  Object.freeze({
    id: 'CHUTE',
    weight: 20,
    magnitudeMin: -0.75,
    magnitudeMax: -0.55,
    durationMinS: 2.5,
    durationMaxS: 5.0,
  }),
  Object.freeze({
    id: 'VENT_DE_FACE',
    weight: 18,
    magnitudeMin: -0.45,
    magnitudeMax: -0.3,
    durationMinS: 4.0,
    durationMaxS: 7.0,
  }),
  Object.freeze({
    id: 'RACCOURCI',
    weight: 12,
    magnitudeMin: 1.04,
    magnitudeMax: 1.3,
    durationMinS: 2.5,
    durationMaxS: 3.5,
  }),
  Object.freeze({
    id: 'POULET',
    weight: 10,
    magnitudeMin: -0.35,
    magnitudeMax: -0.2,
    durationMinS: 2.0,
    durationMaxS: 4.0,
  }),
  Object.freeze({
    id: 'SIESTE',
    weight: 6,
    magnitudeMin: -0.7,
    magnitudeMax: -0.7,
    durationMinS: 5.0,
    durationMaxS: 5.0,
  }),
  Object.freeze({
    id: 'MEGA_TURBO',
    weight: 4,
    magnitudeMin: 1.63,
    magnitudeMax: 1.63,
    durationMinS: 5.0,
    durationMaxS: 5.0,
  }),
]);

/**
 * Somme des poids du catalogue : `92` avec les valeurs de §7.1, valeur **calculée** pour ne jamais
 * pouvoir diverger silencieusement du catalogue.
 */
export const EVENT_TOTAL_WEIGHT: number = EVENT_CATALOG.reduce(
  (total, definition) => total + definition.weight,
  0,
);

/** Bornes d'une durée, en pas entiers inclusifs. */
export interface EventStepRange {
  readonly min: number;
  readonly max: number;
}

/** Une entrée du catalogue, prête au tirage : sa fiche et sa durée convertie en pas. */
export interface EventDrawSpec {
  readonly definition: EventDefinition;
  readonly durationSteps: EventStepRange;
}

/** Constantes de tirage pré-calculées, une fois par course. */
export interface EventParams {
  readonly dtS: number;
  /** Probabilité qu'un pas donné porte un candidat : `RATE_PER_S × DT_S`. */
  readonly perStepProbability: number;
  readonly globalCooldownSteps: number;
  readonly characterCooldownSteps: number;
  readonly maxPerCharacter: number;
  readonly specs: readonly EventDrawSpec[];
  readonly weights: readonly number[];
}

/** Événement actif sur un personnage, et la frontière de pas qui le termine (**exclue**). */
export interface ActiveEventSlot {
  readonly event: ActiveEvent;
  readonly endStep: number;
}

/**
 * Planning interne de la course. Volontairement **hors** de `RaceState` : le rang, les distances et
 * les cooldowns ne sont pas un état de jeu, seulement des compteurs de planification.
 */
export interface EventPlanState {
  /** Pas du dernier événement déclenché, ou `null`. Sert au cooldown global. */
  lastTriggerStep: number | null;
  /** Dernier pas où chaque personnage a subi un événement, par index de roster. */
  readonly lastCharacterStep: (number | null)[];
  /** Nombre d'événements déjà subis par chaque personnage. */
  readonly counts: number[];
  /** Emplacement d'événement de chaque personnage : au plus un, ou `null`. */
  readonly slots: (ActiveEventSlot | null)[];
}

/** Convertit une durée de jeu en pas : unique endroit où le temps continu devient discret. */
function stepsForSeconds(seconds: number, config: GameConfig): number {
  return Math.round(seconds / config.RACE.DT_S);
}

/**
 * Vérifie la cohérence interne d'un catalogue.
 *
 * Lève une `RangeError` au premier problème : un catalogue incohérent (poids nul, magnitude positive
 * annoncée comme malus, plusieurs `CHUTE`) produirait des courses silencieusement fausses.
 */
export function validateEventCatalog(catalog: readonly EventDefinition[]): void {
  if (catalog.length === 0) {
    throw new RangeError('EVENT : le catalogue est vide.');
  }

  const seen = new Set<string>();

  for (const definition of catalog) {
    if (seen.has(definition.id)) {
      throw new RangeError(`EVENT : l'identifiant ${definition.id} apparaît deux fois.`);
    }
    seen.add(definition.id);

    if (!Number.isFinite(definition.weight) || definition.weight <= 0) {
      throw new RangeError(`EVENT ${definition.id} : poids invalide (${definition.weight}).`);
    }
    if (!Number.isFinite(definition.magnitudeMin) || !Number.isFinite(definition.magnitudeMax)) {
      throw new RangeError(`EVENT ${definition.id} : magnitude non finie.`);
    }
    if (definition.magnitudeMin > definition.magnitudeMax) {
      throw new RangeError(`EVENT ${definition.id} : bornes de magnitude inversées.`);
    }
    // Une magnitude de −1 donnerait une vitesse cible nulle, donc un arrêt complet interdit par
    // `SPEED.MIN` : le malus serait alors plus violent que ce que le catalogue annonce.
    if (definition.magnitudeMin <= -1) {
      throw new RangeError(`EVENT ${definition.id} : magnitude minimale ≤ −1 (${definition.magnitudeMin}).`);
    }
    if (definition.durationMinS <= 0 || definition.durationMinS > definition.durationMaxS) {
      throw new RangeError(`EVENT ${definition.id} : bornes de durée invalides.`);
    }
  }
}

/**
 * Pré-calcule toutes les constantes de tirage, et refuse une configuration incohérente.
 *
 * La vérification la plus importante est celle du **plafond** : avec un événement du catalogue, la
 * vitesse cible nominale `SPEED.BASE × (1 + magnitude)` doit rester sous `SPEED.MAX`, sinon le
 * document annoncerait un gain que l'écrêtage rendrait faux.
 */
export function eventParams(config: GameConfig, catalog: readonly EventDefinition[] = EVENT_CATALOG): EventParams {
  validateEventCatalog(catalog);

  const { DT_S } = config.RACE;
  const perStepProbability = config.EVENT.RATE_PER_S * DT_S;

  if (!Number.isFinite(perStepProbability) || perStepProbability <= 0 || perStepProbability > 1) {
    throw new RangeError(`EVENT : probabilité par pas invalide (${perStepProbability}).`);
  }
  if (config.EVENT.MAX_ACTIVE_PER_CHARACTER !== 1) {
    throw new RangeError(
      `EVENT : MAX_ACTIVE_PER_CHARACTER doit valoir 1 (reçu : ${config.EVENT.MAX_ACTIVE_PER_CHARACTER}) : le planificateur ne gère qu'un emplacement par personnage.`,
    );
  }

  const specs = catalog.map((definition) =>
    Object.freeze({
      definition,
      durationSteps: Object.freeze({
        min: stepsForSeconds(definition.durationMinS, config),
        max: stepsForSeconds(definition.durationMaxS, config),
      }),
    }),
  );

  for (const spec of specs) {
    const nominalMax = config.SPEED.BASE * (1 + spec.definition.magnitudeMax);
    if (nominalMax > config.SPEED.MAX) {
      // Le plafond dur écraserait la cible : le gain annoncé par §7.1 serait alors faux.
      throw new RangeError(
        `EVENT ${spec.definition.id} : la vitesse cible maximale (${nominalMax}) dépasse SPEED.MAX (${config.SPEED.MAX}).`,
      );
    }
  }

  return Object.freeze({
    dtS: DT_S,
    perStepProbability,
    globalCooldownSteps: stepsForSeconds(config.EVENT.GLOBAL_COOLDOWN_S, config),
    characterCooldownSteps: stepsForSeconds(config.EVENT.CHAR_COOLDOWN_S, config),
    maxPerCharacter: config.EVENT.MAX_PER_CHARACTER,
    specs: Object.freeze(specs),
    weights: Object.freeze(catalog.map((definition) => definition.weight)),
  });
}

/** Planning initial : aucun événement déclenché, aucun emplacement occupé, aucun compteur entamé. */
export function createEventPlan(characterCount: number): EventPlanState {
  if (!Number.isInteger(characterCount) || characterCount < 1) {
    throw new RangeError(`EVENT : nombre de personnages invalide (${characterCount}).`);
  }

  return {
    lastTriggerStep: null,
    lastCharacterStep: new Array<number | null>(characterCount).fill(null),
    counts: new Array<number>(characterCount).fill(0),
    slots: new Array<ActiveEventSlot | null>(characterCount).fill(null),
  };
}

/** Événement actif d'un personnage, ou `null`. Seule lecture autorisée par le moteur. */
export function activeEventAt(plan: EventPlanState, index: number): ActiveEvent | null {
  const slot = plan.slots[index];
  return slot === undefined || slot === null ? null : slot.event;
}

/**
 * Fait avancer le planificateur d'un pas : expiration, puis tirage éventuel d'un nouvel événement.
 *
 * Appelée **une fois par pas**, avant la boucle des personnages, si bien que l'événement du pas est
 * déjà connu quand la vitesse cible est calculée. C'est la seule fonction qui consomme le flux
 * `events:global` ; elle ne le consomme jamais pendant une pause, puisque `RaceSimulation` n'appelle
 * simplement pas `step()`.
 *
 * Le tirage se fait dans un ordre fixe — candidat, identifiant, cible, durée, magnitude — et la cible
 * est tirée **avant** la durée et la magnitude : aucune valeur tirée ne dépend du rang ou de la
 * distance, seulement des cooldowns et du plafond.
 */
export function stepEvents(
  plan: EventPlanState,
  stream: RngStream,
  params: EventParams,
  characterIds: readonly CharacterId[],
  stepNumber: number,
): void {
  const count = characterIds.length;
  if (plan.slots.length !== count || plan.counts.length !== count) {
    throw new RangeError(
      `EVENT : planning de taille ${plan.slots.length} pour ${count} personnages.`,
    );
  }

  // 1. Expiration : `endStep` est exclu, le pas `endStep` ne subit donc plus rien.
  for (let index = 0; index < count; index += 1) {
    const slot = plan.slots[index];
    if (slot !== undefined && slot !== null && stepNumber >= slot.endStep) {
      plan.slots[index] = null;
    }
  }

  // 2. Candidat du pas. Le tirage a lieu à **chaque** pas, cooldown compris : un candidat qui tombe
  // pendant un cooldown est rejeté, jamais reporté. C'est ce qui garde au processus son absence de
  // mémoire (§7.3) ; les cooldowns l'éclaircissent, et la course compte donc ≈ 10 événements — le
  // bas de la fourchette `[10 ; 16]` de §13.
  if (stream.nextFloat() >= params.perStepProbability) {
    return;
  }

  // 3. Cooldown global, tous personnages confondus : le candidat est rejeté, et le flux a simplement
  // avancé d'un cran. Aucun report, aucun rattrapage.
  if (
    plan.lastTriggerStep !== null &&
    stepNumber - plan.lastTriggerStep < params.globalCooldownSteps
  ) {
    return;
  }

  const spec = stream.weightedPick(params.specs, params.weights);

  // 4. Éligibilité : plafond, cooldown individuel, puis emplacement libre. Un personnage qui subit
  // déjà un événement n'est **jamais** éligible, quel que soit l'événement tiré : la V1 n'a aucune
  // règle de remplacement. (Jusqu'à P010, `CHUTE` pouvait écraser un `TURBO` actif ; la règle a été
  // **supprimée**, pas désactivée — `CHAR_COOLDOWN_S = 8 s` dépassant la durée maximale d'un `TURBO`
  // (4 s), elle ne pouvait de toute façon jamais se déclencher en course, et une règle normative
  // inatteignable n'a pas sa place dans §7.3.)
  const eligible: number[] = [];
  for (let index = 0; index < count; index += 1) {
    if ((plan.counts[index] ?? 0) >= params.maxPerCharacter) {
      continue;
    }
    const last = plan.lastCharacterStep[index] ?? null;
    if (last !== null && stepNumber - last < params.characterCooldownSteps) {
      continue;
    }

    if ((plan.slots[index] ?? null) === null) {
      eligible.push(index);
    }
  }

  // Aucun personnage éligible : le candidat est rejeté lui aussi, sans être mis de côté.
  if (eligible.length === 0) {
    return;
  }

  const targetIndex = eligible[stream.nextInt(0, eligible.length - 1)];
  if (targetIndex === undefined) {
    throw new RangeError('EVENT : index de cible hors bornes.');
  }
  const target = characterIds[targetIndex];
  if (target === undefined) {
    throw new RangeError(`EVENT : aucun personnage pour l'index ${targetIndex}.`);
  }

  const durationSteps = stream.nextInt(spec.durationSteps.min, spec.durationSteps.max);
  const { magnitudeMin, magnitudeMax } = spec.definition;
  const magnitude = magnitudeMin + stream.nextFloat() * (magnitudeMax - magnitudeMin);

  const event: ActiveEvent = Object.freeze({
    id: spec.definition.id,
    target,
    // L'événement prend effet au **début** du pas `stepNumber`, et dure `durationSteps` pas entiers :
    // la durée publiée et la frontière de fin décrivent donc exactement le même intervalle.
    startSimS: (stepNumber - 1) * params.dtS,
    durationS: durationSteps * params.dtS,
    magnitude,
  });

  plan.slots[targetIndex] = Object.freeze({ event, endStep: stepNumber + durationSteps });
  plan.lastTriggerStep = stepNumber;
  plan.lastCharacterStep[targetIndex] = stepNumber;
  plan.counts[targetIndex] = (plan.counts[targetIndex] ?? 0) + 1;
}
