/**
 * Retour sonore de l'interface — **minimal, et volontairement isolé**.
 *
 * La passe corrective demande **un seul** son : un court klaxon qui confirme l'activation du réglage
 * `Son`. Le système audio complet (moteur, mixage, nappes, budget d'assets) reste l'étape P015 ; ce
 * module n'en est pas un embryon, il n'existe que pour cette confirmation.
 *
 * ## Règles tenues ici
 *
 * 1. **Aucun asset, aucune dépendance** : le klaxon est **synthétisé** avec deux oscillateurs Web Audio
 *    et une enveloppe de gain. Rien n'est téléchargé, rien n'est ajouté à `public/`.
 * 2. **Aucun son automatique** : `playHorn()` n'est appelé que depuis le gestionnaire de clic qui
 *    active le réglage. Aucun son ne part au chargement, aucun son ne part à la désactivation.
 * 3. **Politique d'autoplay respectée** : le contexte audio est créé **au premier geste utilisateur**,
 *    dans le gestionnaire de clic lui-même, et jamais à l'import.
 * 4. **Aucune influence sur la course** : ce module ne lit ni n'écrit aucun état de jeu. Il ne reçoit
 *    ni distance, ni rang, ni fait, ni graine, et `RaceEngine` ignore jusqu'à son existence — comme
 *    la synthèse vocale, il ne peut donc pas modifier un résultat (invariant §5.10).
 * 5. **Dégradation silencieuse** : sans Web Audio (`AudioContext` absent, constructeur qui lève,
 *    contexte refusé), tout appel est un no-op. Le jeu reste jouable, aucun test ne casse.
 */

/**
 * Sous-ensemble de `AudioContext` réellement utilisé.
 *
 * Il est déclaré ici plutôt que d'emprunter le type du DOM : le module reste ainsi testable dans
 * Vitest, en environnement node, sans `jsdom` ni navigateur, exactement comme `tts.ts` le fait pour
 * la synthèse vocale.
 */
export interface AudioParamLike {
  value: number;
  setValueAtTime(value: number, startTime: number): void;
  exponentialRampToValueAtTime(value: number, endTime: number): void;
}

/** Oscillateur minimal : une forme d'onde, une fréquence, un démarrage et un arrêt. */
export interface OscillatorLike {
  readonly frequency: AudioParamLike;
  type: string;
  connect(destination: GainLike): void;
  start(when: number): void;
  stop(when: number): void;
}

/** Gain minimal : la seule automation dont le klaxon a besoin. */
export interface GainLike {
  readonly gain: AudioParamLike;
  connect(destination: AudioDestinationLike): void;
}

/** Destination finale : `ctx.destination`. */
export type AudioDestinationLike = object;

/** Contexte audio minimal, tel que `createSoundOutput` l'utilise. */
export interface AudioContextLike {
  readonly currentTime: number;
  readonly destination: AudioDestinationLike;
  readonly state: string;
  createOscillator(): OscillatorLike;
  createGain(): GainLike;
  resume(): Promise<void>;
}

/** Portée injectable : c'est ce qui rend le module testable sans navigateur. */
export interface AudioScope {
  /** Fabrique de contexte. Absente hors navigateur : le module devient alors inerte. */
  readonly createAudioContext?: (() => AudioContextLike) | undefined;
}

/**
 * Fréquences du klaxon, en hertz : une tierce majeure répétée (`la` – `do#`), la sonorité d'un
 * deux-tons d'ambiance.
 */
const HORN_LOW_HZ = 440;
const HORN_HIGH_HZ = 554.37;

/** Durée d'un appui, en secondes, et nombre d'appuis : deux, très courts. */
const HORN_PULSE_S = 0.13;
const HORN_PULSE_GAP_S = 0.03;
const HORN_PULSES = 2;

/** Gain de crête du klaxon : audible sans être brutal, et atténué dès l'attaque. */
const HORN_PEAK_GAIN = 0.12;

/** Sortie sonore de l'interface : le klaxon, et rien d'autre pour l'instant. */
export interface SoundOutput {
  /**
   * Joue le klaxon de confirmation.
   *
   * Ne lève jamais et ne rend rien : un navigateur sans Web Audio rend simplement la fonction
   * silencieuse. Le contexte est créé au premier appel, donc dans un gestionnaire de clic.
   */
  playHorn(): void;
}

/**
 * Construit la sortie sonore à partir d'une portée injectée.
 *
 * Renvoie `null` quand Web Audio est absent : l'appelant n'a alors rien à faire, et il n'a pas à
 * tester l'absence d'API lui-même.
 */
export function createSoundOutput(scope: AudioScope): SoundOutput | null {
  const factory = scope.createAudioContext;
  if (factory === undefined) {
    return null;
  }

  let context: AudioContextLike | null = null;

  /** Contexte courant, créé à la demande. Une fabrique qui lève est traitée comme une absence. */
  const contextOrNull = (): AudioContextLike | null => {
    if (context !== null) {
      return context;
    }
    try {
      context = factory();
    } catch {
      return null;
    }
    return context;
  };

  return {
    playHorn(): void {
      const audio = contextOrNull();
      if (audio === null) {
        return;
      }

      // Certains navigateurs démarrent le contexte en `suspended` : `resume()` est demandé **dans le
      // geste utilisateur**, et son échec éventuel est ignoré (le son est un bonus, jamais un dû).
      if (audio.state === 'suspended') {
        void audio.resume().catch(() => undefined);
      }

      const start = audio.currentTime;
      for (let pulse = 0; pulse < HORN_PULSES; pulse += 1) {
        const pulseStart = start + pulse * (HORN_PULSE_S + HORN_PULSE_GAP_S);
        const pulseEnd = pulseStart + HORN_PULSE_S;
        const oscillator = audio.createOscillator();
        const gain = audio.createGain();
        // Deux appuis de hauteurs différentes : c'est ce qui fait « klaxon » plutôt que « bip ».
        oscillator.type = 'square';
        oscillator.frequency.value = pulse === 0 ? HORN_LOW_HZ : HORN_HIGH_HZ;
        oscillator.connect(gain);
        gain.connect(audio.destination);
        gain.gain.setValueAtTime(HORN_PEAK_GAIN, pulseStart);
        // Une rampe exponentielle ne peut pas viser zéro : on vise un plancher inaudible.
        gain.gain.exponentialRampToValueAtTime(0.0001, pulseEnd);
        oscillator.start(pulseStart);
        oscillator.stop(pulseEnd);
      }
    },
  };
}

/**
 * Portée réelle du navigateur.
 *
 * Le `AudioContext` standard est cherché sous ses deux noms (`AudioContext` et le préfixe historique
 * `webkitAudioContext`) sans jamais dépendre de `window` dans le typage : le module reste compilable
 * en environnement node.
 */
export function webAudioScope(scope: {
  readonly AudioContext?: unknown;
  readonly webkitAudioContext?: unknown;
}): AudioScope {
  const candidate = scope.AudioContext ?? scope.webkitAudioContext;
  if (typeof candidate !== 'function') {
    return {};
  }
  const Constructor = candidate as new () => AudioContextLike;
  return {
    createAudioContext: () => new Constructor(),
  };
}
