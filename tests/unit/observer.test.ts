import { describe, expect, it } from 'vitest';

import { CHARACTER_IDS } from '../../src/core/characters';
import { FACT, LEADER, RACE_CONFIG } from '../../src/core/config';
import { RaceEngine } from '../../src/core/engine';
import { RaceObserver } from '../../src/core/observer';
import type { ObservationInput, ObservedCharacter } from '../../src/core/observer';
import type { ActiveEvent, CharacterId, EventId, RaceFact } from '../../src/core/types';

/**
 * P009-A : l'observateur de faits, seul producteur des `RaceFact` de la course.
 *
 * Chaque type de fait a **un test fabriqué à la main** : les distances sont écrites pas à pas, et le
 * test vérifie le type exact, les personnages, les magnitudes mesurées, `tSim` et l'absence de tout
 * fait supplémentaire. Aucun de ces tests ne dépend d'une seed : ce sont des situations construites.
 */

const DT = RACE_CONFIG.DT_S;
const SIX = CHARACTER_IDS;
const SEED = 'POULET42';

/** Distances neutres : aucune condition de fait n'y est vraie (aucun test ne dépasse 300 pas). */
const NEUTRAL_XS: readonly number[] = [1, 2, 3, 4, 5, 6];

/** Photographie d'un pas construite à partir des seules distances, dans l'ordre officiel. */
function snapshot(
  steps: number,
  xs: readonly number[],
  events: readonly (ActiveEvent | null)[] = [],
): ObservationInput {
  const characters: ObservedCharacter[] = SIX.map((id, index) => ({
    id,
    x: xs[index] ?? 0,
    activeEvent: events[index] ?? null,
  }));
  return { tSim: steps * DT, steps, characters };
}

/** Événement démarré au pas `startStep` : `startSimS` est le début de ce pas, comme dans le noyau. */
function eventAt(
  id: EventId,
  target: CharacterId,
  startStep: number,
  magnitude: number,
  durationS: number,
): ActiveEvent {
  return { id, target, startSimS: (startStep - 1) * DT, durationS, magnitude };
}

/** Un fait, et un seul, attendu. */
function single(facts: readonly RaceFact[]): RaceFact {
  expect(facts).toHaveLength(1);
  const fact = facts[0];
  if (fact === undefined) {
    throw new Error('un fait unique était attendu');
  }
  return fact;
}

/** Alimente l'observateur en tenant le numéro de pas, et retient les faits par pas. */
class Feeder {
  private step = 0;
  readonly all: RaceFact[] = [];

  constructor(private readonly observer: RaceObserver) {}

  /** Joue `count` pas de distances identiques. */
  feed(xs: readonly number[], count = 1, events: readonly (ActiveEvent | null)[] = []): RaceFact[][] {
    const perStep: RaceFact[][] = [];
    for (let index = 0; index < count; index += 1) {
      this.step += 1;
      const produced = [...this.observer.observe(snapshot(this.step, xs, events))];
      perStep.push(produced);
      this.all.push(...produced);
    }
    return perStep;
  }

  get stepNumber(): number {
    return this.step;
  }
}

describe('contrat d’entrée : les 6 identifiants officiels, dans l’ordre stable', () => {
  it('refuse un roster incomplet, un ordre permuté ou une distance non finie', () => {
    const observer = new RaceObserver();
    const official = snapshot(1, [0, 0, 0, 0, 0, 0]);

    const short: ObservationInput = { ...official, characters: official.characters.slice(0, 5) };
    expect(() => observer.observe(short)).toThrow(RangeError);

    const reversed: ObservationInput = {
      tSim: official.tSim,
      steps: official.steps,
      characters: [...official.characters].reverse(),
    };
    expect(() => observer.observe(reversed)).toThrow(/ordre stable/);

    const notFinite: ObservationInput = {
      ...official,
      characters: official.characters.map((character, index) =>
        index === 3 ? { ...character, x: Number.NaN } : character,
      ),
    };
    expect(() => observer.observe(notFinite)).toThrow(RangeError);
  });

  it('exige que le premier relevé soit le pas 1', () => {
    expect(() => new RaceObserver().observe(snapshot(1, NEUTRAL_XS))).not.toThrow();
    expect(() => new RaceObserver().observe(snapshot(2, NEUTRAL_XS))).toThrow(/première observation/);
  });

  it('exige des pas consécutifs : 1 → 2 passe, un saut de pas échoue', () => {
    const observer = new RaceObserver();

    expect(() => observer.observe(snapshot(1, NEUTRAL_XS))).not.toThrow();
    expect(() => observer.observe(snapshot(2, NEUTRAL_XS))).not.toThrow();

    // Saut : le pas 3 manque. Le relevé est refusé, et rien n'a bougé : le pas 3 reste attendu.
    expect(() => observer.observe(snapshot(4, NEUTRAL_XS))).toThrow(/consécutifs/);
    expect(() => observer.observe(snapshot(3, NEUTRAL_XS))).not.toThrow();
    expect(() => observer.observe(snapshot(4, NEUTRAL_XS))).not.toThrow();
  });

  it('refuse un pas répété, qui compterait deux fois le même pas', () => {
    const observer = new RaceObserver();
    observer.observe(snapshot(1, NEUTRAL_XS));

    expect(() => observer.observe(snapshot(1, NEUTRAL_XS))).toThrow(RangeError);
    expect(() => observer.observe(snapshot(1, NEUTRAL_XS))).toThrow(/consécutifs/);
  });

  it('refuse un retour en arrière', () => {
    const observer = new RaceObserver();
    observer.observe(snapshot(1, NEUTRAL_XS));
    observer.observe(snapshot(2, NEUTRAL_XS));

    expect(() => observer.observe(snapshot(1, NEUTRAL_XS))).toThrow(/consécutifs/);
    expect(() => observer.observe(snapshot(0, NEUTRAL_XS))).toThrow(RangeError);
  });
});

describe('LEADER_CHANGE', () => {
  it('n’émet qu’après debounce ET marge, au pas de confirmation', () => {
    const feeder = new Feeder(new RaceObserver());

    feeder.feed([100, 98, 96, 94, 92, 90], 10);
    const perStep = feeder.feed([100, 103, 96, 94, 92, 90], 80);

    const debounceSteps = Math.round(LEADER.DEBOUNCE_S / DT);
    const confirmedStep = 11 + debounceSteps;

    // Le premier échange de rang (pas 11) n'est **pas** un fait : le fait tombe à la confirmation.
    for (let step = 11; step < confirmedStep; step += 1) {
      expect(perStep[step - 11], `pas ${step}`).toEqual([]);
    }

    const fact = single(perStep[confirmedStep - 11] ?? []);
    expect(fact.type).toBe('LEADER_CHANGE');
    expect(fact.characterIds).toEqual(['c1', 'c0']);
    expect(fact.tSim).toBe(confirmedStep * DT);
    expect(fact.magnitudes[0]).toBe(3);
    expect(fact.magnitudes[1]).toBeCloseTo(confirmedStep * DT, 12);
    expect(fact.importance).toBeCloseTo(FACT.LEADER_CHANGE_IMPORTANCE + confirmedStep * DT, 12);
    expect(fact.textKey).toBe('fact.leaderChange');

    // Puis plus rien : le leader confirmé ne change plus.
    for (let step = confirmedStep + 1; step <= 90; step += 1) {
      expect(perStep[step - 11], `pas ${step}`).toEqual([]);
    }
  });

  it('ne confirme jamais un leader qui reste sous la marge, même après 100 pas', () => {
    const feeder = new Feeder(new RaceObserver());

    feeder.feed([100, 98, 96, 94, 92, 90], 6);
    // c1 prend le rang 1, mais avec 0,5 m d'avance seulement (< LEADER.MIN_MARGIN = 1,0 m).
    feeder.feed([100, 100.5, 96, 94, 92, 90], 114);

    expect(feeder.all).toEqual([]);
  });

  it('ignore une oscillation de rang 1 sous la marge, sans jamais confirmer', () => {
    const feeder = new Feeder(new RaceObserver());

    for (let step = 1; step <= 400; step += 1) {
      const c0 = step % 2 === 0 ? 100.4 : 99.6;
      feeder.feed([c0, 100, 50, 40, 30, 20], 1);
    }

    expect(feeder.all).toEqual([]);
  });
});

describe('BIG_COMEBACK', () => {
  it('émet un fait pour 3 places gagnées en ≤ 10 s, une seule fois par épisode', () => {
    const feeder = new Feeder(new RaceObserver());
    const after = [0.25, 0.2, 0.15, 0.1, 0.22, 0];

    expect(feeder.feed([0.25, 0.2, 0.15, 0.1, 0.05, 0], 1)[0]).toEqual([]);
    // c4 passe de la 5e à la 2e place : 3 places gagnées, toutes les paires restant sous 0,5 m.
    const perStep = feeder.feed(after, 99);

    const fact = single(perStep[0] ?? []);
    expect(fact.type).toBe('BIG_COMEBACK');
    expect(fact.characterIds).toEqual(['c4']);
    expect(fact.magnitudes).toEqual([3, 2]);
    expect(fact.importance).toBe(FACT.BIG_COMEBACK_IMPORTANCE);
    expect(fact.tSim).toBe(2 * DT);

    for (let step = 3; step <= 100; step += 1) {
      expect(perStep[step - 2], `pas ${step}`).toEqual([]);
    }
  });

  it('n’émet rien au premier relevé, même si la condition semble déjà vraie', () => {
    const feeder = new Feeder(new RaceObserver());
    expect(feeder.feed([0.25, 0.2, 0.15, 0.1, 0.05, 0], 1)[0]).toEqual([]);
  });
});

describe('OVERTAKE_STREAK', () => {
  const others = [100, 90, 4, 2];

  it('émet au 3e dépassement du même personnage en ≤ 5 s, puis plus rien pour cet épisode', () => {
    const feeder = new Feeder(new RaceObserver());

    for (let step = 1; step <= 8; step += 1) {
      const c0 = step % 2 === 1 ? 6.6 : 5.4;
      feeder.feed([c0, 6.0, ...others], 1);
    }

    const facts = feeder.all;
    expect(facts).toHaveLength(2);

    const third = facts[0];
    expect(third?.type).toBe('OVERTAKE_STREAK');
    expect(third?.characterIds).toEqual(['c1']);
    expect(third?.magnitudes).toEqual([3]);
    expect(third?.importance).toBe(FACT.OVERTAKE_STREAK_IMPORTANCE);
    expect(third?.tSim).toBe(6 * DT);

    const fourth = facts[1];
    expect(fourth?.type).toBe('OVERTAKE_STREAK');
    expect(fourth?.characterIds).toEqual(['c0']);
    expect(fourth?.magnitudes).toEqual([3]);
    expect(fourth?.tSim).toBe(7 * DT);
  });

  it('ne compte jamais un dépassement depuis une comparaison occasionnelle de classement', () => {
    const feeder = new Feeder(new RaceObserver());

    // 300 pas d'oscillation franche : c0 et c1 se dépassent, et personne d'autre ne bouge.
    for (let step = 1; step <= 300; step += 1) {
      const c0 = step % 2 === 1 ? 6.6 : 5.4;
      feeder.feed([c0, 6.0, ...others], 1);
    }

    expect(feeder.all.map((fact) => fact.type)).toEqual(['OVERTAKE_STREAK', 'OVERTAKE_STREAK']);
  });
});

describe('BIG_BONUS', () => {
  it('déclenche au vrai début d’un bonus, avec le rang au moment du tirage', () => {
    const observer = new RaceObserver();
    const base = [100, 98, 96, 94, 92, 90];
    const none = [null, null, null, null, null, null];

    expect(observer.observe(snapshot(1, base))).toEqual([]);

    // c0 est leader au pas 1 : le TURBO tiré au début du pas 2 porte le bonus « leader ».
    const turbo = single(observer.observe(snapshot(2, base, [eventAt('TURBO', 'c0', 2, 1.5, 3), ...none.slice(1)])));
    expect(turbo.type).toBe('BIG_BONUS');
    expect(turbo.characterIds).toEqual(['c0']);
    expect(turbo.magnitudes).toEqual([1.5, 3, 1]);
    expect(turbo.importance).toBe(FACT.BIG_BONUS_IMPORTANCE + FACT.BIG_BONUS_LEADER_BONUS);
    expect(turbo.tSim).toBe(2 * DT);

    // Le même événement continue : ce n'est pas un nouveau début.
    expect(observer.observe(snapshot(3, base, [eventAt('TURBO', 'c0', 2, 1.5, 3), ...none.slice(1)]))).toEqual([]);

    // c5 est dernière : MEGA_TURBO porte le bonus « dernière ».
    const mega = single(
      observer.observe(snapshot(4, base, [...none.slice(0, 5), eventAt('MEGA_TURBO', 'c5', 4, 2.5, 5)])),
    );
    expect(mega.type).toBe('BIG_BONUS');
    expect(mega.characterIds).toEqual(['c5']);
    expect(mega.magnitudes).toEqual([2.5, 5, 6]);
    expect(mega.importance).toBe(FACT.BIG_BONUS_IMPORTANCE + FACT.BIG_BONUS_LAST_BONUS);

    // RACCOURCI au milieu du peloton : importance de base.
    const shortcut = single(
      observer.observe(snapshot(5, base, [null, null, eventAt('RACCOURCI', 'c2', 5, 1.8, 3), null, null, null])),
    );
    expect(shortcut.type).toBe('BIG_BONUS');
    expect(shortcut.magnitudes).toEqual([1.8, 3, 3]);
    expect(shortcut.importance).toBe(FACT.BIG_BONUS_IMPORTANCE);

    // POULET et CHUTE ne sont pas des bonus : rien n'est émis.
    expect(
      observer.observe(snapshot(6, base, [null, eventAt('POULET', 'c1', 6, -0.3, 2), null, null, null, null])),
    ).toEqual([]);
    expect(
      observer.observe(snapshot(7, base, [null, null, null, eventAt('CHUTE', 'c3', 7, -0.6, 4), null, null])),
    ).toEqual([]);
  });
});

describe('LEADER_MALUS', () => {
  it('n’émet que pour le leader au moment du tirage', () => {
    const observer = new RaceObserver();
    const base = [100, 98, 96, 94, 92, 90];

    expect(observer.observe(snapshot(1, base))).toEqual([]);

    // c0 était leader au pas 1 : CHUTE au pas 2 ⇒ malus de leader.
    const chute = single(
      observer.observe(snapshot(2, base, [eventAt('CHUTE', 'c0', 2, -0.6, 4), null, null, null, null, null])),
    );
    expect(chute.type).toBe('LEADER_MALUS');
    expect(chute.characterIds).toEqual(['c0']);
    expect(chute.magnitudes).toEqual([-0.6, 4, 1]);
    expect(chute.importance).toBe(FACT.LEADER_MALUS_IMPORTANCE);
    expect(chute.tSim).toBe(2 * DT);

    // c4 est 5e : SIESTE ne produit aucun malus de leader.
    expect(
      observer.observe(snapshot(3, base, [null, null, null, null, eventAt('SIESTE', 'c4', 3, -0.7, 5), null])),
    ).toEqual([]);

    // Le leader actuel subit SIESTE : le bonus de 15 s'applique.
    const sieste = single(
      observer.observe(snapshot(4, base, [eventAt('SIESTE', 'c0', 4, -0.7, 5), null, null, null, null, null])),
    );
    expect(sieste.type).toBe('LEADER_MALUS');
    expect(sieste.magnitudes).toEqual([-0.7, 5, 1]);
    expect(sieste.importance).toBe(FACT.LEADER_MALUS_IMPORTANCE + FACT.LEADER_MALUS_SIESTE_BONUS);

    // c0 n'est plus leader : le rang utilisé est celui du tirage (2), donc rien n'est émis.
    expect(observer.observe(snapshot(5, [100, 104, 96, 94, 92, 90]))).toEqual([]);
    expect(
      observer.observe(
        snapshot(6, [100, 104, 96, 94, 92, 90], [eventAt('CHUTE', 'c0', 6, -0.6, 4), null, null, null, null, null]),
      ),
    ).toEqual([]);
  });
});

describe('CLOSE_RACE', () => {
  const tight = [0, -3, -10, -20, -25, -30];
  const loose = [0, -3, -20, -25, -30, -35];

  it('émet après 5 s consécutives à ≤ 15 m, une seule fois par entrée dans l’état', () => {
    const feeder = new Feeder(new RaceObserver());

    const warmup = feeder.feed(tight, 299);
    expect(warmup.flat()).toEqual([]);

    const emission = feeder.feed(tight, 1);
    const fact = single(emission[0] ?? []);
    expect(fact.type).toBe('CLOSE_RACE');
    expect(fact.characterIds).toEqual(['c0', 'c2']);
    expect(fact.magnitudes).toEqual([10, 5]);
    expect(fact.importance).toBe(FACT.CLOSE_RACE_IMPORTANCE);
    expect(fact.tSim).toBe(300 * DT);

    // Tant que la situation dure, aucun nouveau fait.
    expect(feeder.feed(tight, 200).flat()).toEqual([]);

    // Sortir de l'état réarme l'émission, mais il faut de nouveau 5 s pleines sous le seuil.
    expect(feeder.feed(loose, 1).flat()).toEqual([]);
    expect(feeder.feed(tight, 299).flat()).toEqual([]);
    const second = single(feeder.feed(tight, 1)[0] ?? []);
    expect(second.type).toBe('CLOSE_RACE');
    expect(second.tSim).toBe(feeder.stepNumber * DT);
  });
});

describe('LAST_COMEBACK', () => {
  it('émet quand le dernier atteint la 3e place, avec le comeback mesuré', () => {
    const observer = new RaceObserver();

    expect(observer.observe(snapshot(1, [0.25, 0.2, 0.15, 0.1, 0.05, 0]))).toEqual([]);
    const facts = [...observer.observe(snapshot(2, [0.25, 0.2, 0.15, 0.1, 0.05, 0.17]))];

    // Deux faits distincts, dans l'ordre du design : 3 places gagnées, et un retour depuis la dernière.
    expect(facts.map((fact) => fact.type)).toEqual(['BIG_COMEBACK', 'LAST_COMEBACK']);
    const comeback = facts[1];
    expect(comeback?.characterIds).toEqual(['c5']);
    expect(comeback?.magnitudes).toEqual([3, 3]);
    expect(comeback?.importance).toBe(FACT.LAST_COMEBACK_IMPORTANCE);
    expect(comeback?.tSim).toBe(2 * DT);

    for (let step = 3; step <= 20; step += 1) {
      expect(observer.observe(snapshot(step, [0.25, 0.2, 0.15, 0.1, 0.05, 0.17])), `pas ${step}`).toEqual([]);
    }
  });

  it('émet aussi pour 4 places gagnées en ≤ 30 s sans avoir été dernier', () => {
    const observer = new RaceObserver();

    expect(observer.observe(snapshot(1, [0.25, 0.2, 0.15, 0.1, 0.05, 0]))).toEqual([]);
    const facts = [...observer.observe(snapshot(2, [0.05, 0.2, 0.15, 0.1, 0.25, 0]))];

    expect(facts.map((fact) => fact.type)).toEqual(['BIG_COMEBACK', 'LAST_COMEBACK']);
    expect(facts[1]?.characterIds).toEqual(['c4']);
    expect(facts[1]?.magnitudes).toEqual([4, 1]);
  });
});

describe('CHECKPOINT_SPLIT', () => {
  it('porte le classement et les distances du pas de la borne, avec le bonus de densité', () => {
    const feeder = new Feeder(new RaceObserver());
    const xs = [100, 98, 96, 94, 92, 90];

    const perStep = feeder.feed(xs, RACE_CONFIG.STEPS_PER_SEGMENT);
    const fact = single(perStep[RACE_CONFIG.STEPS_PER_SEGMENT - 1] ?? []);

    expect(fact.type).toBe('CHECKPOINT_SPLIT');
    expect(fact.tSim).toBe(45);
    expect(fact.characterIds).toEqual(['c0', 'c1', 'c2', 'c3', 'c4', 'c5']);
    expect(fact.magnitudes).toEqual([...xs]);
    // 38 de base, + 10 car l'écart P1–P2 vaut 2 m (< 20 m) et aucun leader n'a changé.
    expect(fact.importance).toBe(FACT.CHECKPOINT_SPLIT_IMPORTANCE + FACT.CHECKPOINT_SPLIT_CLOSE_BONUS);
    expect(fact.textKey).toBe('fact.checkpointSplit');
    expect(Object.isFrozen(fact)).toBe(true);
    expect(Object.isFrozen(fact.characterIds)).toBe(true);
  });

  it('ajoute le bonus de changement de leader confirmé depuis le checkpoint précédent', () => {
    const feeder = new Feeder(new RaceObserver());

    feeder.feed([100, 98, 96, 94, 92, 90], 10);
    feeder.feed([100, 130, 96, 94, 92, 90], RACE_CONFIG.STEPS_PER_SEGMENT - 10);

    const changes = feeder.all.filter((fact) => fact.type === 'LEADER_CHANGE');
    expect(changes).toHaveLength(1);
    expect(changes[0]?.characterIds).toEqual(['c1', 'c0']);

    const splits = feeder.all.filter((fact) => fact.type === 'CHECKPOINT_SPLIT');
    const split = single(splits);
    // 38 + 20 (leader changé), sans le +10 : l'écart P1–P2 vaut 30 m.
    expect(split.importance).toBe(
      FACT.CHECKPOINT_SPLIT_IMPORTANCE + FACT.CHECKPOINT_SPLIT_LEADER_CHANGE_BONUS,
    );
    expect(split.tSim).toBe(45);
  });
});

describe('FINISH et PHOTO_FINISH', () => {
  it('émet FINISH seul quand l’écart P1–P2 vaut au moins 5 m', () => {
    const feeder = new Feeder(new RaceObserver());
    feeder.feed([0, -8, -20, -30, -40, -50], RACE_CONFIG.TOTAL_STEPS);

    const arrivals = feeder.all.filter((fact) => fact.type === 'FINISH' || fact.type === 'PHOTO_FINISH');
    const arrival = single(arrivals);
    expect(arrival.type).toBe('FINISH');
    expect(arrival.tSim).toBe(180);
    expect(arrival.characterIds).toEqual(['c0', 'c1']);
    expect(arrival.magnitudes).toEqual([8, 0, -8]);
    expect(arrival.importance).toBe(FACT.ARRIVAL_IMPORTANCE);

    // Exactement trois splits et une arrivée : un fait n'existe que s'il est mesuré.
    expect(feeder.all.filter((fact) => fact.type === 'CHECKPOINT_SPLIT')).toHaveLength(3);
    expect(feeder.all).toHaveLength(4);
  });

  it('remplace FINISH par PHOTO_FINISH quand l’écart P1–P2 est strictement sous 5 m', () => {
    const feeder = new Feeder(new RaceObserver());
    feeder.feed([0, -2, -20, -30, -40, -50], RACE_CONFIG.TOTAL_STEPS);

    const arrivals = feeder.all.filter((fact) => fact.type === 'FINISH' || fact.type === 'PHOTO_FINISH');
    const arrival = single(arrivals);
    expect(arrival.type).toBe('PHOTO_FINISH');
    expect(arrival.tSim).toBe(180);
    expect(arrival.magnitudes).toEqual([2, 0, -2]);
    expect(arrival.importance).toBe(FACT.PHOTO_ARRIVAL_IMPORTANCE);
  });
});

describe('anti-bruit : 3 000 pas d’échanges de rang sous la marge', () => {
  it('ne produit ni OVERTAKE_STREAK ni faux LEADER_CHANGE', () => {
    const feeder = new Feeder(new RaceObserver());

    // c0 et c1 échangent les 3e et 4e places avec ±0,4 m (sous OVERTAKE.MIN_MARGIN = 0,5 m) ; c2 mène
    // largement, c5 est dernier et immobile. Aucune condition de fait n'est jamais vraie.
    for (let step = 1; step <= 3000; step += 1) {
      const c0 = step % 2 === 1 ? 10.4 : 9.6;
      feeder.feed([c0, 10, 100, 90, 5, 0], 1);
    }

    // Le seul fait légitime de ces 3 000 pas est le split de checkpoint à 45 s : aucun bruit.
    expect(feeder.all).toEqual([expect.objectContaining({ type: 'CHECKPOINT_SPLIT', tSim: 45 })]);
    expect(feeder.all.filter((fact) => fact.type === 'OVERTAKE_STREAK')).toEqual([]);
    expect(feeder.all.filter((fact) => fact.type === 'LEADER_CHANGE')).toEqual([]);
  });
});

describe('intégration au moteur : drainFacts()', () => {
  it('accumule, draine, puis ne rend rien tant qu’aucun pas nouveau n’est joué', () => {
    const engine = new RaceEngine(SEED);
    expect(engine.drainFacts()).toEqual([]);

    for (let step = 0; step < RACE_CONFIG.STEPS_PER_SEGMENT; step += 1) {
      engine.step();
    }

    const accumulated = engine.drainFacts();
    expect(accumulated.length).toBeGreaterThan(0);
    expect(engine.drainFacts()).toEqual([]);
    expect(engine.drainFacts()).toEqual([]);

    for (let step = 0; step < 10; step += 1) {
      engine.step();
    }
    const later = engine.drainFacts();
    // Rien n'est rejoué : tout fait drainé après la borne appartient aux pas suivants.
    expect(later.every((fact) => fact.tSim > 45)).toBe(true);
    expect(engine.drainFacts()).toEqual([]);
  });

  it('produit exactement trois splits et une arrivée sur une course complète', () => {
    const engine = new RaceEngine(SEED);
    const facts: RaceFact[] = [];

    for (let step = 0; step < RACE_CONFIG.TOTAL_STEPS; step += 1) {
      engine.step();
      facts.push(...engine.drainFacts());
    }

    const splits = facts.filter((fact) => fact.type === 'CHECKPOINT_SPLIT');
    expect(splits.map((fact) => fact.tSim)).toEqual([45, 90, 135]);
    expect(
      facts.filter((fact) => fact.type === 'FINISH' || fact.type === 'PHOTO_FINISH'),
    ).toHaveLength(1);
    expect(engine.getState().steps).toBe(RACE_CONFIG.TOTAL_STEPS);
  });
});

/** Tailles des conteneurs internes d'un objet, récursivement : sert à prouver une borne de mémoire. */
function containerSizes(value: unknown, depth = 0): number[] {
  if (depth > 3 || typeof value !== 'object' || value === null) {
    return [];
  }

  const sizes: number[] = [];
  for (const child of Object.values(value)) {
    if (Array.isArray(child)) {
      sizes.push(child.length);
    } else if (ArrayBuffer.isView(child)) {
      sizes.push(child.byteLength);
    } else if (typeof child === 'object' && child !== null) {
      sizes.push(...containerSizes(child, depth + 1));
    }
  }
  return sizes;
}

/** Rejoue une course en alimentant un observateur externe, pas après pas. */
function factsOfRace(seed: string, observer: RaceObserver): RaceFact[] {
  const engine = new RaceEngine(seed);
  const facts: RaceFact[] = [];
  let step = 0;

  while (engine.getState().phase.kind !== 'finished') {
    engine.step();
    step += 1;
    const current = engine.getState();
    facts.push(...observer.observe({ tSim: current.tSim, steps: step, characters: current.characters }));
  }
  return facts;
}

describe('mémoire bornée', () => {
  it('ne fait grandir aucune structure interne entre le pas 300 et la fin de course', () => {
    const engine = new RaceEngine(SEED);
    const observer = new RaceObserver();

    let at300: number[] = [];
    let step = 0;
    while (engine.getState().phase.kind !== 'finished') {
      engine.step();
      step += 1;
      const current = engine.getState();
      observer.observe({ tSim: current.tSim, steps: step, characters: current.characters });
      if (step === 300) {
        at300 = containerSizes(observer);
      }
    }

    expect(step).toBe(RACE_CONFIG.TOTAL_STEPS);
    expect(at300.length).toBeGreaterThan(0);
    expect(containerSizes(observer)).toEqual(at300);
  });

  it('repart d’une mémoire neuve après reset : deux courses donnent les mêmes faits', () => {
    const observer = new RaceObserver();
    const first = factsOfRace(SEED, observer);
    observer.reset();
    const second = factsOfRace(SEED, observer);

    expect(first.length).toBeGreaterThan(0);
    expect(second).toEqual(first);
  });
});

describe('invariance du gameplay', () => {
  const SEEDS: readonly string[] = ['POULET42', 'K7QM2X9A', 'RACEWAY1', '00000000'];

  /** Joue une course complète en drainant tous les `cadence` pas (0 = un seul drain à la fin). */
  function race(
    seed: string,
    cadence: number,
  ): { facts: RaceFact[]; ranking: readonly CharacterId[]; distances: readonly number[] } {
    const engine = new RaceEngine(seed);
    const facts: RaceFact[] = [];

    for (let step = 1; step <= RACE_CONFIG.TOTAL_STEPS; step += 1) {
      engine.step();
      if (cadence > 0 && step % cadence === 0) {
        facts.push(...engine.drainFacts());
      }
    }
    facts.push(...engine.drainFacts());

    const result = engine.runToCompletion();
    return { facts, ranking: result.ranking, distances: result.distances };
  }

  it('donne exactement la même course, quel que soit le rythme de drainFacts()', () => {
    for (const seed of SEEDS) {
      const everyStep = race(seed, 1);
      const every17 = race(seed, 17);
      const never = race(seed, 0);

      expect(every17.distances, seed).toEqual(everyStep.distances);
      expect(never.distances, seed).toEqual(everyStep.distances);
      expect(every17.ranking, seed).toEqual(everyStep.ranking);
      expect(never.ranking, seed).toEqual(everyStep.ranking);

      // Les faits eux-mêmes ne dépendent pas de la cadence de lecture.
      expect(every17.facts, seed).toEqual(everyStep.facts);
      expect(never.facts, seed).toEqual(everyStep.facts);
    }
  });

  it('ne change ni le nombre de pas ni le temps simulé final', () => {
    const engine = new RaceEngine(SEED);
    engine.runToCompletion();
    expect(engine.getState().steps).toBe(RACE_CONFIG.TOTAL_STEPS);
    expect(engine.getState().tSim).toBe(RACE_CONFIG.TOTAL_SIM_S);
  });
});
