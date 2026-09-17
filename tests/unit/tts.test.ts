import { describe, expect, it } from 'vitest';

import {
  TTS_RATE,
  VOICE_LANGUAGE,
  createVoiceOutput,
  isFrenchVoice,
  pickVoice,
  webSpeechScope,
  type SpeechApiScope,
  type SpeechSynthesisLike,
  type UtteranceLike,
  type VoiceInfo,
} from '../../src/app/tts';

/**
 * P012 — sortie vocale optionnelle.
 *
 * Aucun test ne dépend d'une vraie synthèse vocale : le Web Speech API est **injecté**, ce qui est
 * exactement la raison pour laquelle `createVoiceOutput` prend un `SpeechApiScope` plutôt que d'aller
 * lire un global. On vérifie le choix de voix, l'absence d'exception quand l'API manque, et le fait
 * qu'une émission ne peut pas se produire sans autorisation.
 */

function voice(lang: string, name = lang): VoiceInfo {
  return { lang, name };
}

/** Faux `speechSynthesis` qui enregistre les énonciations et les annulations. */
function fakeSynthesis(voices: readonly VoiceInfo[]): {
  synthesis: SpeechSynthesisLike;
  spoken: UtteranceLike[];
  cancels: () => number;
} {
  const spoken: UtteranceLike[] = [];
  let cancels = 0;
  return {
    synthesis: {
      cancel: () => {
        cancels += 1;
      },
      speak: (utterance) => {
        spoken.push(utterance);
      },
      getVoices: () => voices,
    },
    spoken,
    cancels: () => cancels,
  };
}

function utteranceFactory(): (text: string) => UtteranceLike {
  return () => ({ voice: null, lang: '', rate: 1 });
}

describe('P012 : choix de la voix', () => {
  it('reconnaît le français quel que soit le séparateur', () => {
    expect(isFrenchVoice(voice('fr-FR'))).toBe(true);
    expect(isFrenchVoice(voice('fr_FR'))).toBe(true);
    expect(isFrenchVoice(voice('fr'))).toBe(true);
    expect(isFrenchVoice(voice('FR-ca'))).toBe(true);
    expect(isFrenchVoice(voice('en-US'))).toBe(false);
    expect(isFrenchVoice(voice('de'))).toBe(false);
  });

  it('préfère la première voix française, de façon déterministe', () => {
    const voices = [voice('en-US'), voice('fr-CA', 'Amélie'), voice('fr-FR', 'Thomas')];
    expect(pickVoice(voices)?.name).toBe('Amélie');
    // Deux appels sur la même liste donnent la même voix : aucun hasard n'est consommé.
    expect(pickVoice(voices)).toEqual(pickVoice(voices));
  });

  it('retombe sur une voix disponible quand aucune n’est française', () => {
    expect(pickVoice([voice('en-GB', 'Daniel'), voice('de-DE')])?.name).toBe('Daniel');
  });

  it('ne choisit rien quand le navigateur n’annonce aucune voix', () => {
    expect(pickVoice([])).toBeNull();
  });
});

describe('P012 : sortie vocale', () => {
  it('n’existe pas sans `speechSynthesis`', () => {
    expect(createVoiceOutput({ createUtterance: utteranceFactory() })).toBeNull();
  });

  it('n’existe pas sans `SpeechSynthesisUtterance`', () => {
    const { synthesis } = fakeSynthesis([voice('fr-FR')]);
    expect(createVoiceOutput({ speechSynthesis: synthesis })).toBeNull();
  });

  it('prononce la phrase avec la voix française et sa langue', () => {
    const { synthesis, spoken } = fakeSynthesis([voice('en-US'), voice('fr-FR', 'Thomas')]);
    const output = createVoiceOutput({ speechSynthesis: synthesis, createUtterance: utteranceFactory() });
    expect(output).not.toBeNull();

    output?.speak('Bonjour la course');
    expect(spoken).toHaveLength(1);
    expect(spoken[0]?.voice?.name).toBe('Thomas');
    expect(spoken[0]?.lang).toBe('fr-FR');
  });

  it('demande le français quand aucune voix n’est disponible, sans lever', () => {
    const { synthesis, spoken } = fakeSynthesis([]);
    const output = createVoiceOutput({ speechSynthesis: synthesis, createUtterance: utteranceFactory() });

    output?.speak('Toujours en français');
    expect(spoken[0]?.voice).toBeNull();
    expect(spoken[0]?.lang).toBe(VOICE_LANGUAGE);
  });

  it('n’émet rien pour un texte vide', () => {
    const { synthesis, spoken, cancels } = fakeSynthesis([voice('fr-FR')]);
    const output = createVoiceOutput({ speechSynthesis: synthesis, createUtterance: utteranceFactory() });

    output?.speak('   ');
    expect(spoken).toEqual([]);
    expect(cancels()).toBe(0);
  });

  it('coupe l’énonciation précédente avant d’en démarrer une nouvelle', () => {
    const { synthesis, spoken, cancels } = fakeSynthesis([voice('fr-FR')]);
    const output = createVoiceOutput({ speechSynthesis: synthesis, createUtterance: utteranceFactory() });

    output?.speak('Première');
    output?.speak('Deuxième');
    expect(spoken).toHaveLength(2);
    expect(cancels()).toBe(2);
  });

  it('impose un débit de commentateur sportif à chaque énonciation', () => {
    const { synthesis, spoken } = fakeSynthesis([voice('fr-FR')]);
    const output = createVoiceOutput({ speechSynthesis: synthesis, createUtterance: utteranceFactory() });

    output?.speak('Une phrase');
    output?.speak('Une autre');

    // Le débit est écrit sur l'énonciation, pas sur un objet global : aucune n'y échappe.
    expect(spoken.map((utterance) => utterance.rate)).toEqual([TTS_RATE, TTS_RATE]);
    // Le premier test joueur manuel a jugé la voix trop lente : le débit retenu doit rester
    // nettement supérieur à la vitesse normale, sans devenir inintelligible.
    expect(TTS_RATE).toBeGreaterThan(1);
    expect(TTS_RATE).toBeLessThanOrEqual(1.8);
  });

  it('transmet une annulation explicite', () => {
    const { synthesis, cancels } = fakeSynthesis([voice('fr-FR')]);
    const output = createVoiceOutput({ speechSynthesis: synthesis, createUtterance: utteranceFactory() });

    output?.cancel();
    expect(cancels()).toBe(1);
  });
});

describe('P012 : détection du Web Speech API', () => {
  it('ne retient rien quand les deux briques manquent', () => {
    expect(webSpeechScope({})).toEqual({});
    expect(webSpeechScope({ speechSynthesis: undefined })).toEqual({});
  });

  it('ne retient rien pour une API présente mais incomplète', () => {
    const partial = { speak: () => undefined } as unknown;
    expect(webSpeechScope({ speechSynthesis: partial, SpeechSynthesisUtterance: class {} })).toEqual(
      {},
    );
    expect(webSpeechScope({ speechSynthesis: 42, SpeechSynthesisUtterance: 43 })).toEqual({});
  });

  it('retient une API complète et sait la faire parler', () => {
    const spoken: UtteranceLike[] = [];
    class FakeUtterance implements UtteranceLike {
      voice: VoiceInfo | null = null;
      lang = '';
      rate = 1;
      constructor(readonly text: string) {}
    }
    const scope: SpeechApiScope = webSpeechScope({
      speechSynthesis: {
        cancel: () => undefined,
        speak: (utterance: UtteranceLike) => spoken.push(utterance),
        getVoices: () => [voice('fr-FR', 'Thomas')],
      },
      SpeechSynthesisUtterance: FakeUtterance,
    });

    const output = createVoiceOutput(scope);
    output?.speak('Ça marche');
    expect(spoken).toHaveLength(1);
    expect(spoken[0]?.lang).toBe('fr-FR');
  });
});
