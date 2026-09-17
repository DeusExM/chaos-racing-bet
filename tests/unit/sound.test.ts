import { describe, expect, it } from 'vitest';

import {
  createSoundOutput,
  webAudioScope,
  type AudioContextLike,
  type AudioDestinationLike,
  type AudioParamLike,
  type GainLike,
  type OscillatorLike,
} from '../../src/app/sound';

/**
 * Passe corrective §13 — klaxon de confirmation d'activation du son.
 *
 * Aucun test ne joue de son : le contexte audio est **injecté**, exactement comme le Web Speech API
 * l'est pour le TTS. On vérifie ce qui est observable et vérifiable — le nombre d'oscillateurs, leurs
 * fréquences, l'instant de création du contexte, et la dégradation silencieuse quand Web Audio manque.
 */

/** Paramètre audio qui enregistre ses automations, pour vérifier la forme de l'enveloppe. */
class FakeParam implements AudioParamLike {
  value = 0;

  readonly events: string[] = [];

  setValueAtTime(value: number, startTime: number): void {
    this.value = value;
    this.events.push(`set:${String(value)}@${String(startTime)}`);
  }

  exponentialRampToValueAtTime(value: number, endTime: number): void {
    this.events.push(`ramp:${String(value)}@${String(endTime)}`);
  }
}

class FakeGain implements GainLike {
  readonly gain = new FakeParam();

  readonly destinations: AudioDestinationLike[] = [];

  connect(destination: AudioDestinationLike): void {
    this.destinations.push(destination);
  }
}

class FakeOscillator implements OscillatorLike {
  readonly frequency = new FakeParam();

  type = 'sine';

  readonly started: number[] = [];

  readonly stopped: number[] = [];

  connect(_destination: GainLike): void {
    // Le branchement est vérifié par les tests du gain : rien à enregistrer ici.
  }

  start(when: number): void {
    this.started.push(when);
  }

  stop(when: number): void {
    this.stopped.push(when);
  }
}

/** Faux `AudioContext` qui compte tout ce qui est créé, et peut refuser de démarrer. */
function fakeContext(options: { readonly state?: string } = {}): {
  context: AudioContextLike;
  oscillators: FakeOscillator[];
  gains: FakeGain[];
  resumes: () => number;
  destination: AudioDestinationLike;
} {
  const oscillators: FakeOscillator[] = [];
  const gains: FakeGain[] = [];
  const destination: AudioDestinationLike = Object.freeze({ kind: 'destination' });
  let resumes = 0;

  return {
    context: {
      currentTime: 10,
      destination,
      state: options.state ?? 'running',
      createOscillator: () => {
        const oscillator = new FakeOscillator();
        oscillators.push(oscillator);
        return oscillator;
      },
      createGain: () => {
        const gain = new FakeGain();
        gains.push(gain);
        return gain;
      },
      resume: () => {
        resumes += 1;
        return Promise.resolve();
      },
    },
    oscillators,
    gains,
    resumes: () => resumes,
    destination,
  };
}

describe('passe corrective : klaxon de confirmation', () => {
  it('n’existe pas sans Web Audio', () => {
    expect(createSoundOutput({})).toBeNull();
    expect(createSoundOutput({ createAudioContext: undefined })).toBeNull();
  });

  it('ne crée le contexte audio qu’au premier son, jamais à la construction', () => {
    let created = 0;
    const output = createSoundOutput({
      createAudioContext: () => {
        created += 1;
        return fakeContext().context;
      },
    });

    expect(output).not.toBeNull();
    // Créer un contexte au chargement violerait la politique d'autoplay des navigateurs.
    expect(created, 'aucun contexte avant le geste utilisateur').toBe(0);
    output?.playHorn();
    expect(created).toBe(1);
    output?.playHorn();
    expect(created, 'le contexte est réutilisé, pas recréé').toBe(1);
  });

  it('joue deux appuis courts et distincts', () => {
    const fake = fakeContext();
    const output = createSoundOutput({ createAudioContext: () => fake.context });

    output?.playHorn();

    expect(fake.oscillators).toHaveLength(2);
    expect(fake.gains, 'chaque oscillateur passe par son propre gain').toHaveLength(2);
    for (const oscillator of fake.oscillators) {
      expect(oscillator.started).toHaveLength(1);
      expect(oscillator.stopped).toHaveLength(1);
      const started = oscillator.started[0] ?? 0;
      const stopped = oscillator.stopped[0] ?? 0;
      // Un appui dure une fraction de seconde : c'est un klaxon, pas une note tenue.
      expect(stopped - started).toBeGreaterThan(0);
      expect(stopped - started).toBeLessThanOrEqual(0.2);
    }
    // Les deux appuis n'ont pas la même hauteur : c'est ce qui fait « klaxon ».
    const [first, second] = fake.oscillators;
    expect(first?.frequency.value).not.toBe(second?.frequency.value);
    // L'enveloppe redescend vers un plancher inaudible : la rampe exponentielle ne peut pas viser 0.
    for (const gain of fake.gains) {
      expect(gain.gain.events.some((event) => event.startsWith('ramp:'))).toBe(true);
      expect(gain.destinations).toEqual([fake.destination]);
    }
  });

  it('réveille un contexte suspendu, dans le geste utilisateur', () => {
    const fake = fakeContext({ state: 'suspended' });
    const output = createSoundOutput({ createAudioContext: () => fake.context });

    output?.playHorn();
    expect(fake.resumes()).toBe(1);
  });

  it('ne lève jamais quand le contexte audio refuse de se créer', () => {
    const output = createSoundOutput({
      createAudioContext: () => {
        throw new Error('audio refusé');
      },
    });

    expect(output).not.toBeNull();
    expect(() => {
      output?.playHorn();
    }).not.toThrow();
    // Deuxième appel : la fabrique est retentée, et l'échec reste silencieux.
    expect(() => {
      output?.playHorn();
    }).not.toThrow();
  });

  it('détecte le Web Audio réel, sous ses deux noms', () => {
    class Real {
      currentTime = 0;
      destination = {};
      state = 'running';
      createOscillator(): FakeOscillator {
        return new FakeOscillator();
      }
      createGain(): FakeGain {
        return new FakeGain();
      }
      resume(): Promise<void> {
        return Promise.resolve();
      }
    }

    const scope = webAudioScope({ AudioContext: Real });
    expect(scope.createAudioContext?.()).toBeInstanceOf(Real);
    expect(webAudioScope({ webkitAudioContext: Real }).createAudioContext).toBeDefined();
    // Une propriété présente mais qui n'est pas un constructeur est traitée comme une absence.
    expect(webAudioScope({ AudioContext: 42 })).toEqual({});
    expect(webAudioScope({})).toEqual({});
  });
});
