/**
 * Sortie vocale optionnelle (P012).
 *
 * ## Rôle exact
 *
 * Ce module **vocalise une phrase déjà choisie**. Il ne décide ni quoi dire, ni quand : la sélection
 * des répliques reste intégralement celle du speaker (`src/speaker/`), et la vocalisation n'est
 * qu'une sortie de plus pour une ligne qui existe déjà. Conséquence directe : le TTS ne peut pas
 * devenir une source de temps pour le speaker, puisqu'il n'a aucun moyen d'en retarder ni d'en
 * déclencher un seul.
 *
 * ## Le Web Speech API n'est jamais requis
 *
 * `speechSynthesis` et `SpeechSynthesisUtterance` peuvent être absents (navigateur minimal, contexte
 * restreint). Dans ce cas `createVoiceOutput` renvoie `null` : l'application n'a alors **aucune**
 * sortie vocale, et rien d'autre ne change. Aucune exception n'est levée, ni ici, ni chez l'appelant.
 *
 * Le choix de la voix est **déterministe** : la première voix française de la liste du navigateur,
 * sinon la première voix disponible, sinon la voix par défaut du navigateur (`lang = fr-FR`). Aucun
 * tirage aléatoire n'est consommé, donc aucun flux de la seed n'est décalé.
 */

/** Description minimale d'une voix, telle que `speechSynthesis.getVoices()` la fournit. */
export interface VoiceInfo {
  /** Étiquette de langue, par exemple `fr-FR` ou `fr_FR`. */
  readonly lang: string;
  /** Nom lisible de la voix, par exemple `Microsoft Paul`. */
  readonly name: string;
}

/** Une énonciation prête à être prononcée : seul ce dont le jeu a besoin est décrit. */
export interface UtteranceLike {
  voice: VoiceInfo | null;
  lang: string;
  /** Débit relatif : `1` est la vitesse normale du moteur de synthèse. */
  rate: number;
}

/** Surface de `speechSynthesis` réellement utilisée. */
export interface SpeechSynthesisLike {
  cancel(): void;
  speak(utterance: UtteranceLike): void;
  getVoices(): readonly VoiceInfo[];
}

/**
 * Le Web Speech API, injecté plutôt que lu dans un global.
 *
 * `createUtterance` est une fabrique et non la classe elle-même : les tests n'ont ainsi aucune classe
 * de navigateur à simuler, et un `SpeechSynthesisUtterance` absent se traduit simplement par
 * `undefined`.
 */
export interface SpeechApiScope {
  readonly speechSynthesis?: SpeechSynthesisLike | undefined;
  readonly createUtterance?: ((text: string) => UtteranceLike) | undefined;
}

/** Sortie vocale prête à l'emploi. */
export interface VoiceOutput {
  /** Prononce un texte. Un texte vide n'émet rien du tout. */
  speak(text: string): void;
  /** Coupe immédiatement l'énonciation en cours, s'il y en a une. */
  cancel(): void;
}

/** Langue demandée par défaut : le jeu est francophone, la voix doit l'être aussi. */
export const VOICE_LANGUAGE = 'fr-FR';

/**
 * Débit de la voix, en multiple de la vitesse normale du moteur de synthèse.
 *
 * Le premier test joueur manuel a jugé la voix « beaucoup trop lente » : à `1`, un commentateur de
 * course parle comme une synthèse de navigation d'ascenseur, et la réplique traîne encore quand
 * l'action est passée. `1,6` est le débit retenu — nettement plus rapide, mais toujours articulé
 * (au-delà de ≈ 1,8, la plupart des voix françaises deviennent difficiles à suivre).
 *
 * C'est une constante de **présentation**, et elle vit ici plutôt que dans `viewConfig.ts` : elle
 * n'affecte ni la simulation, ni la durée d'affichage des sous-titres, ni le moindre délai du speaker
 * (invariant §5.10).
 */
export const TTS_RATE = 1.6;

/** Vrai si une voix parle français, quel que soit le séparateur (`fr-FR`, `fr_FR`, `fr`). */
export function isFrenchVoice(voice: VoiceInfo): boolean {
  return voice.lang.replace('_', '-').toLowerCase().startsWith('fr');
}

/**
 * Choisit une voix **de façon déterministe** : première voix française, sinon première voix
 * disponible, sinon `null` (le navigateur appliquera alors sa voix par défaut).
 */
export function pickVoice(voices: readonly VoiceInfo[]): VoiceInfo | null {
  for (const voice of voices) {
    if (isFrenchVoice(voice)) {
      return voice;
    }
  }
  return voices[0] ?? null;
}

/**
 * Construit la sortie vocale à partir d'un Web Speech API éventuellement incomplet.
 *
 * Renvoie `null` dès qu'une des deux briques manque : c'est la dégradation silencieuse exigée, et
 * elle est structurelle — pas un `try/catch` autour d'un appel qui n'aurait pas de sens.
 */
export function createVoiceOutput(scope: SpeechApiScope): VoiceOutput | null {
  const synthesis = scope.speechSynthesis;
  const createUtterance = scope.createUtterance;
  if (synthesis === undefined || createUtterance === undefined) {
    return null;
  }

  return {
    speak: (text: string): void => {
      const phrase = text.trim();
      if (phrase.length === 0) {
        return;
      }

      const voice = pickVoice(synthesis.getVoices());
      const utterance = createUtterance(phrase);
      utterance.voice = voice;
      // Sans voix explicite, la langue demandée reste le français : le navigateur choisit alors sa
      // propre voix disponible, ce qui est un repli propre plutôt qu'un silence.
      utterance.lang = voice?.lang ?? VOICE_LANGUAGE;
      // Débit de commentateur sportif : la voix ne doit jamais être le goulot d'étranglement de
      // l'action. Le réglage est appliqué à chaque énonciation, donc jamais hérité d'un état global.
      utterance.rate = TTS_RATE;

      // Une seule phrase à la fois : une réplique préemptée est réellement coupée, jamais superposée.
      synthesis.cancel();
      synthesis.speak(utterance);
    },
    cancel: (): void => {
      synthesis.cancel();
    },
  };
}

/**
 * Lit le Web Speech API sur un objet global, sans jamais lever.
 *
 * L'API est **vérifiée structurellement** avant d'être retenue : une propriété présente mais
 * incomplète (navigateur exotique, page qui a remplacé l'objet) est traitée comme une API absente,
 * plutôt que de produire un appel qui échouerait plus tard.
 */
export function webSpeechScope(scope: {
  readonly speechSynthesis?: unknown;
  readonly SpeechSynthesisUtterance?: unknown;
}): SpeechApiScope {
  const synthesis = scope.speechSynthesis;
  const Utterance = scope.SpeechSynthesisUtterance;

  if (!isSpeechSynthesis(synthesis) || typeof Utterance !== 'function') {
    return {};
  }

  const factory = Utterance as new (text: string) => UtteranceLike;
  return {
    speechSynthesis: synthesis,
    createUtterance: (text: string) => new factory(text),
  };
}

/** Vrai si l'objet expose réellement les trois méthodes utilisées de `speechSynthesis`. */
function isSpeechSynthesis(value: unknown): value is SpeechSynthesisLike {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['speak'] === 'function' &&
    typeof candidate['cancel'] === 'function' &&
    typeof candidate['getVoices'] === 'function'
  );
}
