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
 * Passe corrective — réglages locaux `sound` / `commentator`.
 *
 * Ces tests ne touchent à **aucune** couche de jeu : ils vérifient la lecture, la validation, la
 * persistance, la **migration** de l'ancienne forme `{ mute, tts }` et la dégradation d'un module qui
 * ne connaît que des booléens et un stockage. Le stockage est injecté, donc aucune dépendance au DOM
 * ni à un `localStorage` réel.
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

describe('passe corrective : réglages locaux', () => {
  it('démarre avec le son et le commentateur coupés', () => {
    expect(DEFAULT_SETTINGS).toEqual({ sound: false, commentator: false });
    expect(loadSettings(null)).toEqual({ sound: false, commentator: false });
    expect(parseSettings(null)).toEqual({ sound: false, commentator: false });
    expect(parseSettings('')).toEqual({ sound: false, commentator: false });
  });

  it('relit ce qui a été écrit', () => {
    const { storage } = fakeStorage();
    saveSettings(storage, { sound: true, commentator: true });
    expect(loadSettings(storage)).toEqual({ sound: true, commentator: true });

    saveSettings(storage, { sound: false, commentator: true });
    expect(loadSettings(storage)).toEqual({ sound: false, commentator: true });
  });

  it('écrit réellement sous la clé dédiée, sans toucher au reste de l’origine', () => {
    const seen: string[] = [];
    const storage: SettingsStorage = {
      read: () => null,
      write: (key) => {
        seen.push(key);
      },
    };
    saveSettings(storage, { sound: true, commentator: false });
    expect(seen).toEqual([SETTINGS_STORAGE_KEY]);
  });

  it('retombe sur les défauts quand la donnée est corrompue', () => {
    for (const raw of ['{', 'pas du json', 'null', '42', '"texte"', '[]', '{"sound":', '[1,2,3]']) {
      expect(parseSettings(raw), raw).toEqual({ sound: false, commentator: false });
    }
  });

  it('ignore un champ invalide sans perdre celui qui est lisible', () => {
    expect(parseSettings('{"sound":"oui","commentator":true}')).toEqual({
      sound: false,
      commentator: true,
    });
    expect(parseSettings('{"sound":true,"commentator":0}')).toEqual({
      sound: true,
      commentator: false,
    });
    expect(parseSettings('{"sound":true,"commentator":false,"autre":1}')).toEqual({
      sound: true,
      commentator: false,
    });
  });

  it('migre silencieusement l’ancienne paire `mute` / `tts`', () => {
    // Le commentateur était audible exactement quand la voix était active sans mode muet.
    expect(parseSettings('{"mute":false,"tts":true}')).toEqual({ sound: false, commentator: true });
    expect(parseSettings('{"mute":true,"tts":true}')).toEqual({ sound: false, commentator: false });
    expect(parseSettings('{"mute":false,"tts":false}')).toEqual({ sound: false, commentator: false });
    // Aucun effet sonore n'existait : la migration ne peut pas inventer une activation.
    expect(parseSettings('{"mute":true,"tts":false}')).toEqual({ sound: false, commentator: false });
    // Ancienne forme partielle : le champ manquant prend sa valeur par défaut, sans lever.
    expect(parseSettings('{"tts":true}')).toEqual({ sound: false, commentator: true });
    expect(parseSettings('{"mute":true}')).toEqual({ sound: false, commentator: false });
  });

  it('préfère la forme nouvelle dès qu’un de ses champs est présent', () => {
    // Un enregistrement mixte (nouvelle forme partielle + anciens champs) ne doit pas ressusciter
    // `tts` : seul le champ nouveau fait foi, l'absence retombe sur le défaut.
    expect(parseSettings('{"sound":false,"tts":true}')).toEqual({
      sound: false,
      commentator: false,
    });
    expect(parseSettings('{"commentator":true,"mute":true}')).toEqual({
      sound: false,
      commentator: true,
    });
  });

  it('réécrit la forme nouvelle à la première écriture, sans perte', () => {
    const { storage, written } = fakeStorage('{"mute":false,"tts":true}');
    const store = new SettingsStore(storage);
    expect(store.get()).toEqual({ sound: false, commentator: true });

    store.update({ sound: true });
    expect(store.get()).toEqual({ sound: true, commentator: true });
    expect(written()).toBe('{"sound":true,"commentator":true}');
    expect(loadSettings(storage)).toEqual({ sound: true, commentator: true });
  });

  it('accepte un stockage absent sans jamais lever', () => {
    expect(() => {
      saveSettings(null, { sound: true, commentator: true });
    }).not.toThrow();
    expect(loadSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(createSettingsStorage({})).toBeNull();
    expect(createSettingsStorage({ localStorage: undefined })).toBeNull();
  });

  it('survit à un stockage qui lève à la lecture', () => {
    const { storage } = fakeStorage('{"sound":true,"commentator":true}', { throwOnRead: true });
    expect(loadSettings(storage)).toEqual(DEFAULT_SETTINGS);
  });

  it('survit à un stockage qui lève à l’écriture', () => {
    const { storage } = fakeStorage(null, { throwOnWrite: true });
    expect(() => {
      saveSettings(storage, { sound: true, commentator: true });
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
    saveSettings(storage, { sound: true, commentator: false });
    expect(loadSettings(storage)).toEqual({ sound: true, commentator: false });
  });

  it('applique et persiste un changement, puis prévient ses écouteurs', () => {
    const { storage, written } = fakeStorage();
    const store = new SettingsStore(storage);
    const seen: boolean[] = [];
    const unsubscribe = store.subscribe((settings) => seen.push(settings.sound));

    expect(store.get()).toEqual({ sound: false, commentator: false });
    store.update({ sound: true });
    expect(store.get().sound).toBe(true);
    expect(loadSettings(storage), 'le changement est réellement persisté').toEqual({
      sound: true,
      commentator: false,
    });
    expect(written()).toContain('"sound":true');

    store.update({ commentator: true });
    expect(seen).toEqual([true, true]);

    unsubscribe();
    store.update({ sound: false });
    expect(seen, 'un écouteur désabonné ne reçoit plus rien').toEqual([true, true]);
  });

  it('démarre sur les réglages persistés plutôt que sur les défauts', () => {
    const { storage } = fakeStorage('{"sound":true,"commentator":true}');
    expect(new SettingsStore(storage).get()).toEqual({ sound: true, commentator: true });
    expect(new SettingsStore(fakeStorage('corrompu').storage).get()).toEqual(DEFAULT_SETTINGS);
  });

  it('n’autorise la voix que si le commentateur est activé', () => {
    expect(allowsVoice({ sound: false, commentator: true })).toBe(true);
    expect(allowsVoice({ sound: true, commentator: true })).toBe(true);
    expect(allowsVoice({ sound: false, commentator: false })).toBe(false);
    // Les effets sonores n'ont aucun pouvoir sur le commentateur, et réciproquement.
    expect(allowsVoice({ sound: true, commentator: false })).toBe(false);
  });
});
