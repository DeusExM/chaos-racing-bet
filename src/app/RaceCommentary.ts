import { forkStream, type RngStream } from '../core/rng';
import type { RaceFact } from '../core/types';
import type { SpeakerCatalogue, SpeakerLine } from '../render/subtitle';
import { pickLineCharacter, subtitleDurationMs } from '../render/view/subtitleModel';
import { Speaker, type SpeakerDecision } from '../speaker/Speaker';
import { characterNameFr } from './strings.fr';

/**
 * `RaceCommentary` — intégration du speaker dans une course visible (P009-C, réglages en P012).
 *
 * ## Ce qu'il fait
 *
 * Il relie quatre choses qui, chacune, ignorent les trois autres :
 *
 * ```
 *   RaceFact[] ──feedAll──▶ Speaker ──décision──▶ tirage `speaker:lines` ──▶ texte français
 * ```
 *
 * * les faits viennent de `src/sim/` (`RaceSimulation.onFacts`), **par lots d'un même pas** ;
 * * la sélection (quels faits méritent d'être dits, dans quel ordre, avec quels cooldowns) est
 *   intégralement celle de `Speaker` : rien n'est réimplémenté ici ;
 * * le tirage de la variante consomme le flux `speaker:lines`, dérivé de la seed de course ;
 * * le texte vient du catalogue injecté (en pratique `SPEAKER_CATALOGUE_FR`).
 *
 * ## Ce qu'il ne fait pas
 *
 * Il ne connaît **ni le moteur, ni l'état de course, ni le rendu** : il ne voit que des `RaceFact`.
 * Il ne peut donc pas inventer une position, une vitesse ni une cause — la seule chose qu'il ajoute
 * au fait, c'est une phrase choisie dans un catalogue dont chaque variante ne lit que ce fait.
 *
 * ## Durée d'affichage : une propriété d'UI
 *
 * La durée pendant laquelle une réplique reste à l'écran est un **temps réel**, calculé à partir de
 * la longueur du texte (`subtitleDurationMs`). Le speaker, lui, n'a aucune durée métier : il ne
 * connaît que le démarrage et la fin d'une réplique, que cette classe lui signale. La conséquence
 * est l'invariant qui compte : accélérer la course (`?fast=1`), activer la voix ou changer cette
 * durée ne modifie **jamais** une distance, un rang, un fait ni un événement.
 *
 * Une fois la durée écoulée, `finish()` libère la place et le candidat suivant de la file peut être
 * choisi — au même instant simulé que le dernier fait observé, car le speaker n'accepte pas de
 * remonter le temps.
 *
 * ## Voix : une sortie, pas une décision
 *
 * `CommentaryVoice` est une sortie **facultative** branchée sur une ligne déjà sélectionnée. Elle ne
 * peut ni déclencher, ni retarder, ni remplacer une réplique : elle vocalise ce que le speaker a déjà
 * décidé. Le **mode muet** (voir `src/app/settings.ts`) se résout donc en une seule question —
 * « une émission vocale est-elle autorisée ? » — et n'a aucun effet sur les faits, les cooldowns, la
 * file, les préemptions ou les sous-titres texte, qui continuent exactement à l'identique.
 */

/** Sortie vocale telle que le commentaire l'utilise. Une ligne **déjà choisie** en entrée. */
export interface CommentaryVoice {
  /**
   * Une émission vocale est-elle autorisée à cet instant ?
   *
   * C'est ici, et nulle part ailleurs, que se lit le mode muet : la logique du speaker n'en sait
   * rien, donc elle ne peut pas en dépendre.
   */
  allowsVoice(): boolean;
  /** Vocalise la réplique affichée. Appelée uniquement si `allowsVoice()` est vrai. */
  speak(text: string): void;
  /** Coupe l'énonciation en cours, s'il y en a une. */
  cancel(): void;
}

export class RaceCommentary {
  private readonly catalogue: SpeakerCatalogue;

  private readonly voice: CommentaryVoice | null;

  private readonly speaker = new Speaker();

  private stream: RngStream;

  private line: SpeakerLine | null = null;

  private remainingMs = 0;

  /**
   * Fait d'arrivée du noyau (`FINISH` ou `PHOTO_FINISH`), conservé tel quel.
   *
   * C'est la **seule** source de la mention « photo finish » de l'écran d'arrivée (P013) : l'écran de
   * fin ne recalcule aucun seuil, il lit ce fait réel. Il est enregistré même si le speaker décide de
   * ne pas le commenter, parce que c'est un fait mesuré, pas une décision de parole.
   */
  private arrival: RaceFact | null = null;

  /** Dernier instant simulé observé : le speaker refuse un `poll` antérieur. */
  private lastSimS = 0;

  constructor(
    seedValue: number,
    catalogue: SpeakerCatalogue,
    voice: CommentaryVoice | null = null,
  ) {
    this.catalogue = catalogue;
    this.voice = voice;
    this.stream = forkStream(seedValue, 'speaker:lines');
  }

  /**
   * Repart d'une course vierge **avec la même seed** : le flux `speaker:lines` reprend au premier
   * tirage et le speaker oublie cooldowns, file et réplique en cours. Une course rejouée dit donc
   * exactement les mêmes phrases.
   */
  reset(seedValue: number): void {
    this.stream = forkStream(seedValue, 'speaker:lines');
    this.speaker.reset();
    this.voice?.cancel();
    this.line = null;
    this.remainingMs = 0;
    this.arrival = null;
    this.lastSimS = 0;
  }

  /**
   * Fait d'arrivée réellement produit par le noyau, ou `null`.
   *
   * Lecture seule : c'est la preuve, pour l'écran d'arrivée, qu'un `PHOTO_FINISH` a bien eu lieu. Le
   * fait n'est jamais inventé ici — il vient du flux de faits du noyau, transmis par `sim/`.
   */
  arrivalFact(): RaceFact | null {
    return this.arrival;
  }

  /**
   * Reçoit les faits **d'un même pas** de simulation.
   *
   * Le lot passe par `feedAll`, jamais par une boucle de `feed` : le speaker doit voir tout le lot
   * avant de choisir, sinon un fait de priorité immédiate arrivé après un fait plus faible dans le
   * même pas pourrait être devancé (correctif P009-B).
   */
  feedFacts(facts: readonly RaceFact[]): void {
    if (facts.length === 0) {
      return;
    }
    const instant = facts[0]?.tSim;
    if (instant === undefined) {
      return;
    }
    this.lastSimS = instant;
    // Le fait d'arrivée est retenu indépendamment de la décision du speaker : c'est le noyau, et lui
    // seul, qui décide si la course s'est terminée sur une photo finish.
    for (const fact of facts) {
      if (fact.type === 'FINISH' || fact.type === 'PHOTO_FINISH') {
        this.arrival = fact;
      }
    }
    const wasSpeaking = this.speaker.isSpeaking();
    this.take(this.speaker.feedAll(facts), wasSpeaking);
  }

  /**
   * Avance la montre d'affichage, puis tente de parler au temps simulé **courant**.
   *
   * `realDtMs` est du temps **réel** : il ne sert qu'à savoir quand retirer la réplique, jamais à
   * faire avancer la course. `simNowS` est le `tSim` courant, fourni par le rendu qui possède déjà
   * l'instantané de la simulation — cette classe ne connaît donc toujours ni `RaceEngine`, ni
   * `RaceSimulation`, seulement un nombre.
   *
   * Ce paramètre est ce qui évite un blocage silencieux : un fait arrivé trop tôt est mis en file et
   * n'attend plus qu'une chose — que son cooldown simulé expire. Sans le temps courant, il faudrait
   * qu'un **nouveau** fait arrive pour le repoller, et une course silencieuse pourrait le laisser en
   * file indéfiniment. Repoller ne crée jamais de décision : cela ne fait que constater qu'un fait
   * **déjà mesuré** est devenu éligible, et aucun tirage n'est consommé tant qu'aucune réplique ne
   * démarre.
   *
   * Pendant une pause, `tSim` ne bouge pas : les appels répétés ne font donc progresser aucun
   * cooldown simulé, et la seule chose qui continue d'avancer est la durée d'affichage réelle.
   */
  update(realDtMs: number, simNowS?: number): void {
    const nowS = Math.max(simNowS ?? this.lastSimS, this.lastSimS);

    if (Number.isFinite(realDtMs) && realDtMs > 0 && this.line !== null) {
      this.remainingMs -= realDtMs;
      if (this.remainingMs <= 0) {
        // Fin de la réplique : la place se libère et la voix en cours est coupée proprement.
        this.remainingMs = 0;
        this.line = null;
        this.voice?.cancel();
        this.speaker.finish();
      }
    }

    // Candidat en attente et rien à l'écran : on retente au temps simulé courant, sans dépendre de
    // l'arrivée d'un nouveau fait.
    if (this.line === null && this.speaker.queuedCount() > 0) {
      const wasSpeaking = this.speaker.isSpeaking();
      this.take(this.speaker.poll(nowS), wasSpeaking);
    }
  }

  /** Réplique affichée, ou `null`. Le rendu lit cet état, il ne le modifie pas. */
  currentLine(): SpeakerLine | null {
    return this.line;
  }

  /**
   * Nombre de répliques réellement en attente dans la file du speaker.
   *
   * C'est la **vraie** file du speaker, pas une copie tenue par l'affichage : le rendu ne duplique
   * aucune logique de queue, sans quoi l'indicateur pourrait annoncer un commentaire qui n'existe pas.
   */
  queuedCount(): number {
    return this.speaker.queuedCount();
  }

  /** Temps réel restant avant la disparition de la réplique affichée, en millisecondes. */
  remainingDisplayMs(): number {
    return this.remainingMs;
  }

  /** Nombre de répliques réellement démarrées depuis le début : sert à prouver qu'un poll n'en crée pas. */
  linesStarted(): number {
    return this.speaker.totalLinesStarted();
  }

  /**
   * Enregistre la décision effectivement démarrée : elle **remplace** la précédente, sans retour.
   *
   * C'est ici, et nulle part dans le rendu, que la préemption se traduit en texte : `poll` a déjà
   * tranché, cette classe ne fait que constater. `wasSpeaking` décrit l'état d'**avant** l'appel :
   * une décision prise alors qu'une réplique était en cours est une préemption, et le rendu comme la
   * voix doivent alors traiter l'ancienne réplique comme réellement coupée.
   */
  private take(decision: SpeakerDecision | null, wasSpeaking: boolean): void {
    if (decision === null) {
      return;
    }

    const variants = this.catalogue.lines[decision.fact.type];
    if (variants.length === 0) {
      throw new RangeError(`Catalogue incomplet : aucune variante pour ${decision.fact.type}.`);
    }

    const variantIndex = this.stream.nextInt(0, variants.length - 1);
    const formatter = variants[variantIndex];
    if (formatter === undefined) {
      throw new RangeError(`Variante ${variantIndex} absente pour ${decision.fact.type}.`);
    }

    const text = formatter(decision.fact);
    const characterId = pickLineCharacter(text, decision.fact.characterIds, characterNameFr);

    this.line = Object.freeze({
      decision,
      variantIndex,
      text,
      characterId,
      characterName: characterId === null ? null : characterNameFr(characterId),
      preempted: wasSpeaking,
      startedAtS: decision.startedAtS,
    });
    this.remainingMs = subtitleDurationMs(text);

    // La voix ne fait que vocaliser une ligne déjà choisie : elle ne peut ni la remplacer ni la
    // retarder, et le mode muet la rend simplement silencieuse.
    if (this.voice?.allowsVoice() === true) {
      this.voice.speak(text);
    }
  }
}
