import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SETTINGS,
  SETTINGS_STORAGE_KEY,
  SettingsStore,
  allowsVoice,
  createSettingsStorage,
  loadSettings,
  parseSettings,
  saveSettings,
  type SettingsStorage,
} from '../../src/app/settings';

/**
 * P012 — réglages locaux `mute` / `tts`.
 *
 * Ces tests ne touchent à **aucune** couche de jeu : ils vérifient la lecture, la validation, la
 * persistance et la dégradation d'un module qui ne connaît que des booléens et un stockage. Le
 * stockage est injecté, donc aucune dépendance au DOM ni à un `localStorage` réel.
 */

/** Stockage en mémoire, avec la possibilité de faire lever lecture ou écriture. */
function fakeStorage(
  initial: string | null = null,
  options: { readonly throwOnRead?: boolean; readonly throwOnWrite?: boolean } = {},
): { storage: SettingsStorage; written: () => string | null } {
  let value = initial;
  return {
    storage: {
      read: () => {
        if (options.throwOnRead === true) {
          throw new Error('lecture refusée');
        }
        return value;
      },
      write: (_key, next) => {
        if (options.throwOnWrite === true) {
          throw new Error('écriture refusée');
        }
        value = next;
      },
    },
    written: () => value,
  };
}

describe('P012 : réglages locaux', () => {
  it('démarre muet désactivé et TTS désactivé', () => {
    expect(DEFAULT_SETTINGS).toEqual({ mute: false, tts: false });
    expect(loadSettings(null)).toEqual({ mute: false, tts: false });
    expect(parseSettings(null)).toEqual({ mute: false, tts: false });
    expect(parseSettings('')).toEqual({ mute: false, tts: false });
  });

  it('relit ce qui a été écrit', () => {
    const { storage } = fakeStorage();
    saveSettings(storage, { mute: true, tts: true });
    expect(loadSettings(storage)).toEqual({ mute: true, tts: true });

    saveSettings(storage, { mute: false, tts: true });
    expect(loadSettings(storage)).toEqual({ mute: false, tts: true });
  });

  it('écrit réellement sous la clé dédiée, sans toucher au reste de l’origine', () => {
    const seen: string[] = [];
    const storage: SettingsStorage = {
      read: () => null,
      write: (key) => {
        seen.push(key);
      },
    };
    saveSettings(storage, { mute: true, tts: false });
    expect(seen).toEqual([SETTINGS_STORAGE_KEY]);
  });

  it('retombe sur les défauts quand la donnée est corrompue', () => {
    for (const raw of ['{', 'pas du json', 'null', '42', '"texte"', '[]', '{"mute":', '[1,2,3]']) {
      expect(parseSettings(raw), raw).toEqual({ mute: false, tts: false });
    }
  });

  it('ignore un champ invalide sans perdre celui qui est lisible', () => {
    expect(parseSettings('{"mute":"oui","tts":true}')).toEqual({ mute: false, tts: true });
    expect(parseSettings('{"mute":true,"tts":0}')).toEqual({ mute: true, tts: false });
    expect(parseSettings('{"mute":true,"tts":false,"autre":1}')).toEqual({ mute: true, tts: false });
  });

  it('accepte un stockage absent sans jamais lever', () => {
    expect(() => {
      saveSettings(null, { mute: true, tts: true });
    }).not.toThrow();
    expect(loadSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(createSettingsStorage({})).toBeNull();
    expect(createSettingsStorage({ localStorage: undefined })).toBeNull();
  });

  it('survit à un stockage qui lève à la lecture', () => {
    const { storage } = fakeStorage('{"mute":true,"tts":true}', { throwOnRead: true });
    expect(loadSettings(storage)).toEqual(DEFAULT_SETTINGS);
  });

  it('survit à un stockage qui lève à l’écriture', () => {
    const { storage } = fakeStorage(null, { throwOnWrite: true });
    expect(() => {
      saveSettings(storage, { mute: true, tts: true });
    }).not.toThrow();
  });

  it('adapte un `Storage` du navigateur sans dépendre du DOM', () => {
    const values = new Map<string, string>();
    const storage = createSettingsStorage({
      localStorage: {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => {
          values.set(key, value);
        },
      },
    });
    expect(storage).not.toBeNull();
    saveSettings(storage, { mute: true, tts: false });
    expect(loadSettings(storage)).toEqual({ mute: true, tts: false });
  });

  it('applique et persiste un changement, puis prévient ses écouteurs', () => {
    const { storage, written } = fakeStorage();
    const store = new SettingsStore(storage);
    const seen: boolean[] = [];
    const unsubscribe = store.subscribe((settings) => seen.push(settings.mute));

    expect(store.get()).toEqual({ mute: false, tts: false });
    store.update({ mute: true });
    expect(store.get().mute).toBe(true);
    expect(loadSettings(storage), 'le changement est réellement persisté').toEqual({
      mute: true,
      tts: false,
    });
    expect(written()).toContain('"mute":true');

    store.update({ tts: true });
    expect(seen).toEqual([true, true]);

    unsubscribe();
    store.update({ mute: false });
    expect(seen, 'un écouteur désabonné ne reçoit plus rien').toEqual([true, true]);
  });

  it('démarre sur les réglages persistés plutôt que sur les défauts', () => {
    const { storage } = fakeStorage('{"mute":true,"tts":true}');
    expect(new SettingsStore(storage).get()).toEqual({ mute: true, tts: true });
    expect(new SettingsStore(fakeStorage('corrompu').storage).get()).toEqual(DEFAULT_SETTINGS);
  });

  it('n’autorise la voix que si le TTS est actif et le mode muet désactivé', () => {
    expect(allowsVoice({ mute: false, tts: true })).toBe(true);
    expect(allowsVoice({ mute: true, tts: true })).toBe(false);
    expect(allowsVoice({ mute: false, tts: false })).toBe(false);
    expect(allowsVoice({ mute: true, tts: false })).toBe(false);
  });
});
