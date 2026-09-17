/**
 * Réglages locaux de l'application (P012).
 *
 * ## Ce que ce module est
 *
 * Deux booléens d'**interface** — `mute` (aucune sortie vocale) et `tts` (vocalisation activée) —
 * encapsulés avec la persistance `localStorage`, la validation et les valeurs par défaut.
 *
 * ## Ce que ce module n'est pas
 *
 * Il n'entre **jamais** dans la simulation. Ces réglages ne sont ni une constante de jeu, ni une
 * entrée de `RaceEngine`, ni une graine : ils vivent dans `src/app/`, ils ne sont lus par aucune
 * couche de `core/`, `sim/` ou `speaker/`, et les modifier ne peut donc pas changer une distance, un
 * rang, un fait ou le nombre de pas d'une course. Un test unitaire de frontière (`boundaries.test.ts`)
 * interdit d'ailleurs `localStorage` partout sauf ici.
 *
 * ## Robustesse
 *
 * `localStorage` peut être absent (mode privé, contexte non sécurisé, iframe restreinte), refuser
 * l'écriture (quota) ou lever à la lecture. Aucun de ces cas ne doit empêcher le jeu de démarrer :
 * toute défaillance de stockage retombe sur les valeurs par défaut, documentées ci-dessous.
 * Une donnée corrompue est traitée comme une absence de donnée, jamais comme une erreur fatale.
 */

/** Valeurs par défaut : l'audio de la V1 est **désactivé**, y compris la synthèse vocale. */
export const DEFAULT_SETTINGS: RaceSettings = Object.freeze({
  mute: false,
  tts: false,
});

/** Clé de stockage : préfixée par le nom du jeu, pour ne rien écraser d'autre sur l'origine. */
export const SETTINGS_STORAGE_KEY = 'chaos-race:settings';

/** Réglages P012 : purement locaux, jamais transmis à la simulation. */
export interface RaceSettings {
  /** `true` : aucune sortie vocale. Les sous-titres texte restent affichés. */
  readonly mute: boolean;
  /** `true` : une réplique déjà choisie par le speaker est vocalisée (si `mute` est faux). */
  readonly tts: boolean;
}

/**
 * Accès au stockage, réduit à ce dont ce module a besoin.
 *
 * L'interface est minimale à dessein : elle rend le module testable sans navigateur (un objet de
 * trois lignes suffit), et elle empêche `settings.ts` de dépendre de l'API `Storage` complète.
 */
export interface SettingsStorage {
  read(key: string): string | null;
  write(key: string, value: string): void;
}

/** Sous-ensemble de `Storage` réellement utilisé, pour ne pas dépendre du DOM dans les tests. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Adapte un `Storage` du navigateur au contrat ci-dessus.
 *
 * Renvoie `null` quand le stockage est absent : les appelants n'ont alors rien à tester, et toutes
 * les lectures retombent sur `DEFAULT_SETTINGS`.
 */
export function createSettingsStorage(scope: {
  readonly localStorage?: StorageLike | undefined;
}): SettingsStorage | null {
  const store = scope.localStorage;
  if (store === undefined || store === null) {
    return null;
  }
  return {
    read: (key) => store.getItem(key),
    write: (key, value) => {
      store.setItem(key, value);
    },
  };
}

/**
 * Convertit une chaîne stockée en réglages valides. **Ne lève jamais.**
 *
 * Tout ce qui n'est pas un objet JSON portant des booléens pour `mute` et `tts` est ignoré, champ
 * par champ : une valeur corrompue n'entraîne pas la perte du champ voisin qui, lui, était lisible.
 */
export function parseSettings(raw: string | null | undefined): RaceSettings {
  if (raw === null || raw === undefined || raw.length === 0) {
    return DEFAULT_SETTINGS;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    // Donnée corrompue : ce n'est pas une erreur du jeu, seulement une absence de réglage. Le jeu
    // démarre donc sur les défauts, comme au premier lancement.
    return DEFAULT_SETTINGS;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return DEFAULT_SETTINGS;
  }

  const record = parsed as Record<string, unknown>;
  return Object.freeze({
    mute: typeof record['mute'] === 'boolean' ? record['mute'] : DEFAULT_SETTINGS.mute,
    tts: typeof record['tts'] === 'boolean' ? record['tts'] : DEFAULT_SETTINGS.tts,
  });
}

/**
 * Lit les réglages persistés, ou les défauts si le stockage est absent ou défaillant.
 *
 * Aucune exception ne remonte : un stockage qui lève à la lecture est traité exactement comme un
 * stockage absent, ce qui est la seule façon de garantir qu'un navigateur récalcitrant ne bloque pas
 * le démarrage de la course.
 */
export function loadSettings(storage: SettingsStorage | null): RaceSettings {
  if (storage === null) {
    return DEFAULT_SETTINGS;
  }

  let raw: string | null;
  try {
    raw = storage.read(SETTINGS_STORAGE_KEY);
  } catch {
    return DEFAULT_SETTINGS;
  }
  return parseSettings(raw);
}

/**
 * Persiste les réglages. Ne lève jamais : si l'écriture échoue (quota, stockage refusé), les
 * réglages restent appliqués **en mémoire** pour la session en cours, et rien d'autre ne change.
 */
export function saveSettings(storage: SettingsStorage | null, settings: RaceSettings): void {
  if (storage === null) {
    return;
  }
  try {
    storage.write(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Écriture refusée : la session garde ses réglages, la persistance est simplement perdue.
  }
}

/** Écouteur prévenu à chaque changement : sert à rafraîchir l'interface de réglages. */
export type SettingsListener = (settings: RaceSettings) => void;

/**
 * Réglages courants de la session, avec persistance best-effort.
 *
 * Le store est la **seule** source des réglages pour le reste de l'application : le panneau d'UI et
 * la vocalisation le lisent, personne ne relit `localStorage` directement.
 */
export class SettingsStore {
  private readonly storage: SettingsStorage | null;

  private readonly listeners = new Set<SettingsListener>();

  private current: RaceSettings;

  constructor(storage: SettingsStorage | null) {
    this.storage = storage;
    this.current = loadSettings(storage);
  }

  /** Réglages en vigueur. Jamais `null` : les défauts remplacent toute lecture impossible. */
  get(): RaceSettings {
    return this.current;
  }

  /** Applique un changement partiel, le persiste, puis prévient les écouteurs. */
  update(patch: Partial<RaceSettings>): RaceSettings {
    const next = Object.freeze({ ...this.current, ...patch });
    this.current = next;
    saveSettings(this.storage, next);
    for (const listener of this.listeners) {
      listener(next);
    }
    return next;
  }

  /** S'abonne aux changements et renvoie la fonction de désabonnement. */
  subscribe(listener: SettingsListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

/**
 * Le mode muet autorise-t-il une sortie vocale, avec ces réglages ?
 *
 * Règle unique, et volontairement très courte : la voix exige que le TTS soit **activé** et que le
 * mode muet soit **désactivé**. Aucune autre couche ne redécide cela.
 */
export function allowsVoice(settings: RaceSettings): boolean {
  return settings.tts && !settings.mute;
}
