import { forkStream, type RngStream } from '../core/rng';
import type { RaceFact } from '../core/types';
import type { SpeakerCatalogue, SpeakerLine } from '../render/subtitle';
import { Speaker, type SpeakerDecision } from '../speaker/Speaker';

/**
 * `RaceCommentary` — intégration minimale du speaker dans une course visible (P009-C).
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
 * `SUBTITLE_DISPLAY_MS` est le **temps réel** pendant lequel une réplique reste à l'écran. Le
 * speaker n'a aucune durée métier : il ne connaît que le démarrage et la fin d'une réplique, que
 * cette classe lui signale. La conséquence est l'invariant qui compte : accélérer la course
 * (`?fast=1`) ou changer cette durée ne modifie **jamais** une distance, un rang ni un événement.
 *
 * Une fois la durée écoulée, `finish()` libère la place et le candidat suivant de la file peut être
 * choisi — au même instant simulé que le dernier fait observé, car le speaker n'accepte pas de
 * remonter le temps.
 */

/**
 * Durée d'affichage d'une réplique, en millisecondes de **temps réel**.
 *
 * 2 600 ms : assez pour lire une phrase courte à 26 px pendant une course, et assez court pour que
 * deux répliques ne se chevauchent presque jamais. C'est un réglage d'interface (P012 l'affinera),
 * pas une règle du speaker : le modifier ne change aucune course.
 */
export const SUBTITLE_DISPLAY_MS = 2600;

export class RaceCommentary {
  private readonly catalogue: SpeakerCatalogue;

  private readonly speaker = new Speaker();

  private stream: RngStream;

  private line: SpeakerLine | null = null;

  private remainingMs = 0;

  /** Dernier instant simulé observé : le speaker refuse un `poll` antérieur. */
  private lastSimS = 0;

  constructor(seedValue: number, catalogue: SpeakerCatalogue) {
    this.catalogue = catalogue;
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
    this.line = null;
    this.remainingMs = 0;
    this.lastSimS = 0;
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
    this.take(this.speaker.feedAll(facts));
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
        // Fin de la réplique : la place se libère. La suite est traitée par le poll ci-dessous.
        this.remainingMs = 0;
        this.line = null;
        this.speaker.finish();
      }
    }

    // Candidat en attente et rien à l'écran : on retente au temps simulé courant, sans dépendre de
    // l'arrivée d'un nouveau fait.
    if (this.line === null && this.speaker.queuedCount() > 0) {
      this.take(this.speaker.poll(nowS));
    }
  }

  /** Réplique affichée, ou `null`. Le rendu lit cet état, il ne le modifie pas. */
  currentLine(): SpeakerLine | null {
    return this.line;
  }

  /** Nombre de répliques réellement démarrées depuis le début : sert à prouver qu'un poll n'en crée pas. */
  linesStarted(): number {
    return this.speaker.totalLinesStarted();
  }

  /**
   * Enregistre la décision effectivement démarrée : elle **remplace** la précédente, sans retour.
   *
   * C'est ici, et nulle part dans le rendu, que la préemption se traduit en texte : `poll` a déjà
   * tranché, cette classe ne fait que constater.
   */
  private take(decision: SpeakerDecision | null): void {
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

    this.line = Object.freeze({
      decision,
      variantIndex,
      text: formatter(decision.fact),
    });
    this.remainingMs = SUBTITLE_DISPLAY_MS;
  }
}
