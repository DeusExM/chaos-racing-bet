import { describe, expect, it } from 'vitest';

import { RaceCommentary, type CommentaryVoice } from '../../src/app/RaceCommentary';
import { SPEAKER_CATALOGUE_FR, characterNameFr } from '../../src/app/strings.fr';
import { forkStream } from '../../src/core/rng';
import type { CharacterId, RaceFact, RaceFactType } from '../../src/core/types';
import { RaceSimulation } from '../../src/sim/RaceSimulation';
import { SIM_FAST_CONFIG } from '../../src/sim/config';
import type { SpeakerLine } from '../../src/render/subtitle';
import { subtitleDurationMs } from '../../src/render/view/subtitleModel';
import { VIEW } from '../../src/render/viewConfig';

/**
 * P009-C — intégration `RaceFact → SpeakerDecision → texte → bandeau`.
 *
 * Le bandeau n'est pas instancié ici : il ne contient aucune décision et ne fait qu'afficher une
 * chaîne. Ce qui se teste à ce niveau, c'est la chaîne complète **jusqu'au texte** : quel fait,
 * quelle décision, quel texte. Le rendu réel est vérifié par le test E2E ciblé.
 *
 * Toutes les assertions passent par l'API publique : `feedFacts`, `update`, `currentLine`.
 */

/** Fait conforme au contrat de `RaceFact`. */
function fact(
  type: RaceFactType,
  tSim: number,
  importance: number,
  magnitudes: readonly number[] = [3.24, 12],
  characterIds: readonly CharacterId[] = ['c0', 'c1'],
): RaceFact {
  return Object.freeze({
    type,
    tSim,
    characterIds: Object.freeze([...characterIds]),
    magnitudes: Object.freeze([...magnitudes]),
    importance,
    textKey: `fact.${type}`,
  });
}

function director(): { commentary: RaceCommentary; simulation: RaceSimulation } {
  const simulation = new RaceSimulation('POULET42', SIM_FAST_CONFIG);
  return { commentary: new RaceCommentary(simulation.view.seedValue, SPEAKER_CATALOGUE_FR), simulation };
}

describe('P009-C : intégration visible du speaker', () => {
  it('ne dit rien sans fait : aucune réplique sans RaceFact', () => {
    const { commentary } = director();
    expect(commentary.currentLine()).toBeNull();

    // Beaucoup d'images d'horloge réelle : sans fait, il ne se passe rien.
    for (let index = 0; index < 600; index += 1) {
      commentary.update(16);
    }
    expect(commentary.currentLine()).toBeNull();
  });

  it('ignore un fait sous MIN_IMPORTANCE : il n’existe aucune réplique sans décision', () => {
    const { commentary } = director();
    commentary.feedFacts([fact('LEADER_CHANGE', 0, 44)]);
    expect(commentary.currentLine()).toBeNull();
  });

  it('transforme un fait réellement produit pendant une course en ligne affichable', () => {
    const simulation = new RaceSimulation('POULET42', SIM_FAST_CONFIG);
    const commentary = new RaceCommentary(simulation.view.seedValue, SPEAKER_CATALOGUE_FR);
    simulation.onFacts((facts) => commentary.feedFacts(facts));
    simulation.start();

    let firstFact: RaceFact | null = null;
    let line: SpeakerLine | null = null;
    let guard = 0;
    while (line === null && guard < 4000) {
      simulation.update(100);
      const candidate = commentary.currentLine();
      if (candidate !== null) {
        line = candidate;
        firstFact = candidate.decision.fact;
        break;
      }
      guard += 1;
    }

    expect(firstFact, 'une course réelle produit au moins un fait commentable').not.toBeNull();
    expect(line).not.toBeNull();
    expect(line?.decision.fact.type).toBe(firstFact?.type);
    // Le texte vient du catalogue et du fait : il n'est ni vide, ni générique.
    expect(line?.text.length ?? 0).toBeGreaterThan(10);
    expect(line?.text).toBe(SPEAKER_CATALOGUE_FR.lines[firstFact?.type ?? 'FINISH'][line?.variantIndex ?? 0]?.(firstFact as RaceFact));
  });

  it('remplace immédiatement le texte lors d’une préemption, sans jamais revenir en arrière', () => {
    const { commentary } = director();

    commentary.feedFacts([fact('LEADER_CHANGE', 0, 60, [3.24, 12])]);
    const before = commentary.currentLine();
    expect(before).not.toBeNull();
    expect(before?.decision.importance).toBe(60);

    // Importance 80 : au-dessus du seuil de préemption, la réplique en cours est coupée.
    commentary.feedFacts([fact('LAST_COMEBACK', 30, 80, [4, 2])]);
    const after = commentary.currentLine();
    expect(after).not.toBeNull();
    expect(after?.decision.fact.type).toBe('LAST_COMEBACK');
    expect(after?.text).not.toBe(before?.text);

    // La réplique coupée ne revient jamais : elle a quitté la file en démarrant.
    commentary.update(16);
    expect(commentary.currentLine()?.decision.fact.type).toBe('LAST_COMEBACK');
  });

  it('ne coupe pas une réplique pour un fait trop faible, qui attend son tour', () => {
    const { commentary } = director();

    commentary.feedFacts([fact('LEADER_CHANGE', 0, 60, [3.24, 12])]);
    const before = commentary.currentLine();

    commentary.feedFacts([fact('BIG_COMEBACK', 30, 70, [4, 2])]);
    expect(commentary.currentLine()?.text).toBe(before?.text);

    // À l'expiration, le fait en attente prend la place : il n'a pas été perdu.
    commentary.update(commentary.remainingDisplayMs() + 1);
    expect(commentary.currentLine()?.decision.fact.type).toBe('BIG_COMEBACK');
  });

  it('libère la place à l’expiration, et le fait suivant n’a pas été perdu', () => {
    const { commentary } = director();

    commentary.feedFacts([fact('LEADER_CHANGE', 0, 60, [3.24, 12])]);
    const first = commentary.currentLine();
    expect(first?.decision.fact.type).toBe('LEADER_CHANGE');

    // Fait trop faible pour couper : il reste en file, invisible.
    commentary.feedFacts([fact('LAST_COMEBACK', 30, 70, [4, 2])]);
    expect(commentary.currentLine()?.text).toBe(first?.text);

    commentary.update(commentary.remainingDisplayMs() - 1);
    expect(commentary.currentLine()?.text).toBe(first?.text);

    commentary.update(1);
    expect(commentary.currentLine()?.decision.fact.type).toBe('LAST_COMEBACK');
  });

  it('libère réellement la place après expiration, et le fait suivant repart de là', () => {
    const simulation = new RaceSimulation('POULET42', SIM_FAST_CONFIG);
    const facts = collectFacts(simulation, 'POULET42');
    expect(facts.length, 'une course réelle produit des faits').toBeGreaterThan(10);

    const restartable = facts[0];
    expect(restartable).toBeDefined();
    const follow = facts.find((candidate) => (restartable?.tSim ?? 0) + 10 < candidate.tSim);
    expect(follow, 'une course réelle fournit un fait nettement plus tard').toBeDefined();

    const commentary = new RaceCommentary(simulation.view.seedValue, SPEAKER_CATALOGUE_FR);
    commentary.feedFacts([restartable as RaceFact]);
    const first = commentary.currentLine();
    expect(first).not.toBeNull();

    commentary.feedFacts([follow as RaceFact]);
    const during = commentary.currentLine();
    if (during?.decision.fact.type === first?.decision.fact.type) {
      // Le fait suivant n'a pas coupé : à l'expiration, la place se libère et l'ancien texte ne revient pas.
      commentary.update(commentary.remainingDisplayMs() + 1);
      const afterExpiry = commentary.currentLine();
      expect(afterExpiry?.decision.fact.type ?? null).not.toBe(first?.decision.fact.type);
    } else {
      expect(during?.decision.fact.type).toBe(follow?.type);
      commentary.update(commentary.remainingDisplayMs() + 1);
      expect(commentary.currentLine()?.decision.fact.type ?? null).not.toBe(first?.decision.fact.type);
    }

    // Un nouveau fait, une fois la place libre, redémarre réellement le commentaire.
    commentary.update(commentary.remainingDisplayMs() + 1);
    commentary.feedFacts([fact('FINISH', 40, 80, [4.2, 2160, 2155.8])]);
    expect(commentary.currentLine()?.decision.fact.type).toBe('FINISH');
  });

  it('reçoit les faits d’un même pas en un seul lot', () => {
    const simulation = new RaceSimulation('POULET42', SIM_FAST_CONFIG);
    const batches: (readonly RaceFact[])[] = [];
    simulation.onFacts((facts) => batches.push(facts));

    // Course jouée par pas, comme dans l'application : c'est le seul chemin qui alimente un auditeur.
    driveToCompletion(simulation);

    expect(batches.length).toBeGreaterThan(0);
    for (const batch of batches) {
      expect(batch.length).toBeGreaterThan(0);
      const instant = batch[0]?.tSim;
      for (const fact of batch) {
        expect(fact.tSim).toBe(instant);
      }
    }
    // Le noyau produit réellement des pas à plusieurs faits : le lot n'est pas un cas d'école.
    expect(batches.some((batch) => batch.length > 1)).toBe(true);
  });

  it('laisse le speaker voir tout le lot avant de choisir le fait prioritaire', () => {
    const { commentary } = director();

    // Deux faits du même pas : 50 puis 70. Alimentés en lot, c'est bien le plus important qui parle.
    commentary.feedFacts([
      fact('BIG_BONUS', 0, 50, [1.2, 6, 1]),
      fact('LEADER_MALUS', 0, 70, [-0.6, 3, 1]),
    ]);

    const line = commentary.currentLine();
    expect(line?.decision.fact.type).toBe('LEADER_MALUS');
    expect(line?.decision.importance).toBe(70);
  });

  it('reprend un fait en file dès que le temps simulé courant le rend éligible', () => {
    const { commentary } = director();

    commentary.feedFacts([fact('LEADER_CHANGE', 0, 60, [3.24, 12])]);
    expect(commentary.currentLine()?.decision.fact.type).toBe('LEADER_CHANGE');

    // B arrive à t=2, plus important mais pas assez pour couper (écart < INTERRUPT_DELTA) : il entre
    // en file sans parler, et il y est retenu par sa **propre** fenêtre d'éligibilité.
    commentary.feedFacts([fact('BIG_COMEBACK', 2, 70, [4, 2])]);
    expect(commentary.currentLine()?.decision.fact.type).toBe('LEADER_CHANGE');

    // Plus aucun fait n'arrive ensuite : le seul instant connu du commentaire reste t=2.
    // A expire alors que la course est déjà bien plus loin — un `poll` au temps courant le prouve.
    commentary.update(commentary.remainingDisplayMs() + 1, 15);
    expect(commentary.currentLine()?.decision.fact.type).toBe('BIG_COMEBACK');

    // Preuve du bug corrigé : repoller avec l'ancien instant (t=2) laissait B en file pour toujours.
    const stale = director();
    stale.commentary.feedFacts([fact('LEADER_CHANGE', 0, 60, [3.24, 12])]);
    stale.commentary.feedFacts([fact('BIG_COMEBACK', 2, 70, [4, 2])]);
    stale.commentary.update(stale.commentary.remainingDisplayMs() + 1, 2);
    expect(stale.commentary.currentLine()).toBeNull();
  });

  it('ne contourne aucun cooldown quand le temps simulé est figé (pause)', () => {
    const { commentary } = director();

    commentary.feedFacts([fact('LEADER_CHANGE', 0, 60, [3.24, 12])]);
    commentary.feedFacts([fact('BIG_COMEBACK', 2, 70, [4, 2])]);

    // Pause : `tSim` ne bouge pas, seules les frames réelles défilent. Les cooldowns simulés ne
    // progressent donc pas, et B ne peut pas démarrer, quel que soit le nombre d'appels.
    commentary.update(commentary.remainingDisplayMs() + 1, 3);
    for (let frame = 0; frame < 600; frame += 1) {
      commentary.update(16, 3);
      expect(commentary.currentLine()).toBeNull();
    }
    expect(commentary.linesStarted()).toBe(1);

    // Le temps simulé reprend et dépasse la fenêtre d'éligibilité : B démarre, une seule fois.
    commentary.update(16, 15);
    expect(commentary.currentLine()?.decision.fact.type).toBe('BIG_COMEBACK');
    expect(commentary.linesStarted()).toBe(2);
  });

  it('ne consomme aucun tirage de variante tant qu’aucune réplique ne démarre', () => {
    const simulation = new RaceSimulation('POULET42', SIM_FAST_CONFIG);
    const seedValue = simulation.view.seedValue;

    const commentary = new RaceCommentary(seedValue, SPEAKER_CATALOGUE_FR);
    commentary.feedFacts([fact('LEADER_CHANGE', 0, 60, [3.24, 12])]);
    commentary.feedFacts([fact('BIG_COMEBACK', 2, 70, [4, 2])]);

    // La première réplique expire (sa durée dépend de la longueur du texte), puis beaucoup de polls
    // infructueux (tSim trop tôt, puis pause) : aucun tirage ne doit être consommé.
    commentary.update(commentary.remainingDisplayMs() + 1, 3);
    for (let frame = 0; frame < 200; frame += 1) {
      commentary.update(16, 3);
    }
    expect(commentary.currentLine()).toBeNull();

    // Le flux attendu est celui d'une seule réplique démarrée : la 2e décision consomme le 2e tirage.
    commentary.update(16, 15);
    const second = commentary.currentLine();
    expect(second?.decision.fact.type).toBe('BIG_COMEBACK');

    const stream = forkStream(seedValue, 'speaker:lines');
    const firstVariant = stream.nextInt(0, SPEAKER_CATALOGUE_FR.lines.LEADER_CHANGE.length - 1);
    const secondVariant = stream.nextInt(0, SPEAKER_CATALOGUE_FR.lines.BIG_COMEBACK.length - 1);
    expect(second?.variantIndex).toBe(secondVariant);
    expect(firstVariant).toBeGreaterThanOrEqual(0);
    expect(firstVariant).toBeLessThan(SPEAKER_CATALOGUE_FR.lines.LEADER_CHANGE.length);
  });
});

/**
 * Faux appareil vocal : il enregistre ce qu'on lui demande de dire, sans jamais synthétiser quoi que
 * ce soit. Le mode muet n'est ici qu'une question d'**autorisation**, pas de capacités du navigateur.
 */
function fakeVoice(allowed: boolean): {
  voice: CommentaryVoice;
  spoken: string[];
  cancels: () => number;
} {
  const spoken: string[] = [];
  let cancels = 0;
  return {
    voice: {
      allowsVoice: () => allowed,
      speak: (text) => spoken.push(text),
      cancel: () => {
        cancels += 1;
      },
    },
    spoken,
    cancels: () => cancels,
  };
}

describe('P012 : voix, muet et durée d’affichage', () => {
  it('reste totalement silencieux quand aucune voix n’est branchée (défaut de la V1)', () => {
    const commentary = new RaceCommentary(1, SPEAKER_CATALOGUE_FR);
    expect(() => {
      commentary.feedFacts([fact('LEADER_CHANGE', 0, 60, [3.24, 12])]);
    }).not.toThrow();
    expect(commentary.currentLine()).not.toBeNull();
  });

  it('vocalise la réplique exactement telle qu’elle est affichée', () => {
    const fake = fakeVoice(true);
    const commentary = new RaceCommentary(1, SPEAKER_CATALOGUE_FR, fake.voice);

    commentary.feedFacts([fact('LEADER_CHANGE', 0, 60, [3.24, 12])]);
    const line = commentary.currentLine();
    expect(line).not.toBeNull();
    expect(fake.spoken).toEqual([line?.text]);
  });

  it('reste muet sans changer une seule décision du speaker', () => {
    const muted = fakeVoice(false);
    const speaking = fakeVoice(true);

    const mutedCommentary = new RaceCommentary(1, SPEAKER_CATALOGUE_FR, muted.voice);
    const speakingCommentary = new RaceCommentary(1, SPEAKER_CATALOGUE_FR, speaking.voice);

    const feed = [
      fact('LEADER_CHANGE', 0, 60, [3.24, 12]),
      fact('LAST_COMEBACK', 30, 80, [4, 2]),
    ];
    for (const item of feed) {
      mutedCommentary.feedFacts([item]);
      speakingCommentary.feedFacts([item]);
    }

    // Le muet ne coupe rien : mêmes décisions, même texte, même file, même préemption.
    expect(muted.spoken).toEqual([]);
    expect(mutedCommentary.currentLine()?.text).toBe(speakingCommentary.currentLine()?.text);
    expect(mutedCommentary.currentLine()?.decision.fact.type).toBe(
      speakingCommentary.currentLine()?.decision.fact.type,
    );
    expect(mutedCommentary.currentLine()?.preempted).toBe(
      speakingCommentary.currentLine()?.preempted,
    );
    expect(mutedCommentary.linesStarted()).toBe(speakingCommentary.linesStarted());
    expect(mutedCommentary.queuedCount()).toBe(speakingCommentary.queuedCount());
  });

  it('coupe l’énonciation en cours quand la réplique expire', () => {
    const fake = fakeVoice(true);
    const commentary = new RaceCommentary(1, SPEAKER_CATALOGUE_FR, fake.voice);

    commentary.feedFacts([fact('LEADER_CHANGE', 0, 60, [3.24, 12])]);
    expect(fake.cancels()).toBe(0);

    commentary.update(commentary.remainingDisplayMs() + 1);
    expect(commentary.currentLine()).toBeNull();
    expect(fake.cancels()).toBe(1);
  });

  it('signale une préemption et vocalise la nouvelle réplique', () => {
    const fake = fakeVoice(true);
    const commentary = new RaceCommentary(1, SPEAKER_CATALOGUE_FR, fake.voice);

    commentary.feedFacts([fact('LEADER_CHANGE', 0, 60, [3.24, 12])]);
    expect(commentary.currentLine()?.preempted).toBe(false);

    commentary.feedFacts([fact('LAST_COMEBACK', 30, 80, [4, 2])]);
    const after = commentary.currentLine();
    expect(after?.preempted).toBe(true);
    expect(fake.spoken).toHaveLength(2);
    expect(fake.spoken[1]).toBe(after?.text);
  });

  it('démarre sans préemption sur un fait qui a attendu son tour', () => {
    const subordinate = new RaceCommentary(1, SPEAKER_CATALOGUE_FR);

    subordinate.feedFacts([fact('LEADER_CHANGE', 0, 60, [3.24, 12])]);
    subordinate.feedFacts([fact('BIG_COMEBACK', 2, 70, [4, 2])]);
    expect(subordinate.currentLine()?.preempted).toBe(false);

    // Le fait suivant a réellement été mis en file : à son propre instant, il est encore retenu par
    // le cooldown global du speaker, donc il attend au lieu d'être jeté.
    subordinate.update(subordinate.remainingDisplayMs() + 1, 2);
    expect(subordinate.currentLine()).toBeNull();
    expect(subordinate.queuedCount()).toBe(1);
    subordinate.update(16, 15);
    const next = subordinate.currentLine();
    expect(next?.decision.fact.type).toBe('BIG_COMEBACK');
    // Elle n'a pas coupé : elle a attendu la place.
    expect(next?.preempted).toBe(false);
    expect(subordinate.queuedCount()).toBe(0);
  });

  it('adapte la durée d’affichage à la longueur de la réplique produite', () => {
    const commentary = new RaceCommentary(1, SPEAKER_CATALOGUE_FR);
    commentary.feedFacts([fact('LEADER_CHANGE', 0, 60, [3.24, 12])]);

    const line = commentary.currentLine();
    expect(line).not.toBeNull();
    expect(commentary.remainingDisplayMs()).toBe(subtitleDurationMs(line?.text ?? ''));
    // Et la durée reste dans les bornes d'interface, jamais dans les règles du speaker.
    expect(commentary.remainingDisplayMs()).toBeGreaterThanOrEqual(VIEW.SUBTITLE_MIN_MS);
    expect(commentary.remainingDisplayMs()).toBeLessThanOrEqual(VIEW.SUBTITLE_MAX_MS);
  });

  it('met en avant le personnage réellement nommé par la réplique produite', () => {
    const commentary = new RaceCommentary(1, SPEAKER_CATALOGUE_FR);

    // Fait en lot : le speaker choisit le plus important, et la variante nomme l'un des personnages.
    commentary.feedFacts([fact('LEADER_MALUS', 0, 70, [-0.6, 3, 1], ['c1'])]);
    const line = commentary.currentLine();
    expect(line).not.toBeNull();
    expect(line?.characterId).toBe('c1');
    expect(line?.characterName).toBe(characterNameFr('c1'));
    expect(line?.text).toContain(line?.characterName ?? '');
  });

  it('n’affiche aucun nom quand la variante tirée ne cite personne', () => {
    const commentary = new RaceCommentary(1, SPEAKER_CATALOGUE_FR);

    // `CLOSE_RACE` possède des variantes sans aucun nom : le fait porte pourtant deux personnages.
    const closeRace = fact('CLOSE_RACE', 0, 60, [12.4, 6], ['c0', 'c2']);
    commentary.feedFacts([closeRace]);
    const line = commentary.currentLine();
    expect(line).not.toBeNull();

    const cited = (line?.characterName ?? '') !== '' && (line?.text.includes(line?.characterName ?? ''));
    expect(line?.characterId === null).toBe(!cited);
  });
});

/** Tous les faits d'une course, dans l'ordre, sans commentaire : la matière première des tests. */
function collectFacts(simulation: RaceSimulation, seed: string): readonly RaceFact[] {
  const facts: RaceFact[] = [];
  simulation.onFacts((batch) => facts.push(...batch));
  driveToCompletion(simulation, seed);
  return facts;
}

/**
 * Joue une course image par image, comme l'application, jusqu'à l'arrivée.
 *
 * `runToCompletion()` ne convient pas ici : c'est le raccourci des tests d'équilibrage, il court
 * -circuite la boucle réelle et ne produit donc aucun lot de faits à observer.
 */
function driveToCompletion(simulation: RaceSimulation, seed?: string): void {
  simulation.restart(seed);
  simulation.start();
  let guard = 0;
  while (simulation.phase !== 'finished' && guard < 20_000) {
    simulation.update(100);
    guard += 1;
  }
  expect(simulation.phase, 'la course doit atteindre l’arrivée').toBe('finished');
}