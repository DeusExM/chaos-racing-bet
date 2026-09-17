import { describe, expect, it } from 'vitest';

import { CHARACTERS } from '../../src/core/characters';
import { RACE_CONFIG, SPEAK } from '../../src/core/config';
import { RaceEngine } from '../../src/core/engine';
import { computeRanks } from '../../src/core/ranking';
import type { CharacterId, RaceFact, RaceFactType } from '../../src/core/types';
import { RaceCommentary } from '../../src/app/RaceCommentary';
import { SPEAKER_CATALOGUE_FR } from '../../src/app/strings.fr';
import { claimsCurrentRank } from '../../src/speaker/claims';
import { SPEAKER_POLICY, SPEAKER_TYPE_COOLDOWN_S, type SpeakerPolicy } from '../../src/speaker/policy';
import { Speaker } from '../../src/speaker/Speaker';
import { RaceSimulation } from '../../src/sim/RaceSimulation';
import { SIM_CONFIG } from '../../src/sim/config';

/**
 * Passe corrective 2 — **véracité d'une revendication de position**.
 *
 * ## Le bug mesuré
 *
 * Sur la seed reproductible `KR7Z8NAR`, le speaker annonçait « Poulet 3000 fait le ménage dans le
 * classement : 4 places de remontées, 1er ! » alors que Gérard le Paladin était premier à l'écran.
 * Le diagnostic ci-dessous est sans ambiguïté : **le fait était juste**. Le `LAST_COMEBACK` mesuré à
 * `tSim = 0,37 s` portait bien « rang 1 » — vérifié à cet instant — et toutes les autres
 * revendications de la course aussi. Le défaut n'était ni l'observateur, ni la sémantique du fait, ni
 * le gabarit de texte : c'était le **délai de diffusion**. Le fait a attendu 29,68 s en file (bloqué
 * par le cooldown de type `LAST_COMEBACK`, puis doublé par un checkpoint plus important) et a été
 * prononcé quand Poulet 3000 n'était plus que 2e. Une seconde ligne, mesurée à `2,77 s`, a même été
 * dite à `50,07 s`, alors que son personnage était 5e.
 *
 * ## Ce que ces tests verrouillent
 *
 * 1. Le fait reste vrai **à son instant** (aucune régression de l'observateur).
 * 2. Aucune réplique prononcée n'affirme une position fausse **à l'instant où elle est dite**, et
 *    aucune n'attend plus que l'âge maximal de son type.
 * 3. Les faits exacts qui ont produit le bug ne peuvent plus être prononcés.
 *
 * Le point 2 est celui qui échoue avec l'ancien comportement : il ne dépend d'aucune phrase, d'aucune
 * exception de seed et d'aucun gabarit — seulement du fait source, de son instant de diffusion et du
 * classement recalculé à cet instant.
 */

const IDS = CHARACTERS.map((character) => character.id);
const DT = RACE_CONFIG.DT_S;

/** Seed de non-régression : celle du test joueur manuel. */
const KR7Z8NAR = 'KR7Z8NAR';

/** Rang qu'un fait revendique, ou `null` quand il n'en revendique aucun. */
function claimedRank(fact: RaceFact): number | null {
  if (fact.type === 'LEADER_CHANGE') {
    return 1;
  }
  if (fact.type === 'BIG_COMEBACK' || fact.type === 'LAST_COMEBACK') {
    return fact.magnitudes[1] ?? null;
  }
  return null;
}

function nameOf(id: string | undefined): string {
  return CHARACTERS.find((character) => character.id === id)?.name ?? String(id);
}

/** Une réplique réellement prononcée : le fait source et l'instant simulé de son démarrage. */
interface SpokenLine {
  readonly fact: RaceFact;
  readonly startedAtS: number;
}

interface PlayedRace {
  readonly lines: readonly SpokenLine[];
  readonly ranksAtStep: (step: number) => readonly number[] | null;
}

/**
 * Rejoue une course **avec la cadence réelle** (`RaceCommentary` et ses durées d'affichage) et
 * relève, à chaque pas, le classement du noyau.
 *
 * C'est cette cadence-là qui a produit le bug : le harnais « cadence la plus favorable » du speaker
 * suppose des durées d'affichage nulles, donc des files qui se vident plus vite.
 *
 * Le classement de référence est calculé par une **course séparée**, rejouée sans aucun rendu et
 * sans aucun commentaire : l'invariant est donc vérifié contre le noyau seul, jamais contre la course
 * commentée — c'est ce qui interdit au test de se contenter de ce que le rendu a bien voulu montrer.
 */
function playWithCommentary(seed: string, policy?: SpeakerPolicy): PlayedRace {
  const simulation = new RaceSimulation(seed, SIM_CONFIG);
  const commentary = new RaceCommentary(
    simulation.view.seedValue,
    SPEAKER_CATALOGUE_FR,
    null,
    policy ?? SPEAKER_POLICY,
  );

  const lines: SpokenLine[] = [];
  simulation.onFacts((facts) => {
    commentary.feedFacts(facts);
  });

  simulation.start();
  const frameMs = 1000 / 60;
  let previousText: string | null = null;
  let guard = 0;

  while (simulation.phase !== 'finished' && guard < 200_000) {
    guard += 1;
    simulation.update(frameMs);
    commentary.update(frameMs, simulation.view.tSim);
    const line = commentary.currentLine();
    if (line !== null && line.text !== previousText) {
      previousText = line.text;
      lines.push({ fact: line.decision.fact, startedAtS: line.decision.startedAtS });
    }
    if (line === null) {
      previousText = null;
    }
  }

  // Classement de référence, pas par pas, obtenu par une course nue : la même seed donne exactement
  // les mêmes distances, sans dépendre d'un seul instant de rendu.
  const reference = new RaceEngine(seed);
  const ranksByStep: (readonly number[])[] = [
    computeRanks(
      reference.getState().characters.map((character) => character.x),
      IDS,
    ),
  ];
  for (let step = 0; step < RACE_CONFIG.TOTAL_STEPS; step += 1) {
    reference.step();
    ranksByStep.push(
      computeRanks(
        reference.getState().characters.map((character) => character.x),
        IDS,
      ),
    );
  }

  return { lines, ranksAtStep: (step) => ranksByStep[step] ?? null };
}

/**
 * Vérifie l'invariant complet sur une course déjà jouée : âge maximal respecté par type, et rang
 * revendiqué identique au rang réel à l'instant de diffusion.
 */
function expectOnlyTrueClaims(played: PlayedRace, label: string): void {
  for (const { fact, startedAtS } of played.lines) {
    const maxAgeS = claimsCurrentRank(fact.type)
      ? SPEAKER_POLICY.rankFactMaxAgeS
      : SPEAKER_POLICY.factMaxAgeS;
    expect(
      startedAtS - fact.tSim,
      `${label} : ${fact.type} mesuré à ${fact.tSim.toFixed(2)} s et prononcé à ${startedAtS.toFixed(2)} s`,
    ).toBeLessThanOrEqual(maxAgeS);

    const claimed = claimedRank(fact);
    if (claimed === null) {
      continue;
    }

    const ranks = played.ranksAtStep(Math.round(startedAtS / DT));
    expect(ranks, `${label} : classement manquant à ${startedAtS.toFixed(2)} s`).not.toBeNull();
    const index = IDS.indexOf(fact.characterIds[0] ?? 'c0');
    expect(
      ranks?.[index],
      `${label} : ${fact.type} prononcé à ${startedAtS.toFixed(2)} s revendique le rang ${String(claimed)} pour ${nameOf(fact.characterIds[0])}`,
    ).toBe(claimed);
  }
}

/** Seeds canoniques déterministes, distinctes et stables d'une exécution à l'autre. */
function canonicalSeeds(count: number): readonly string[] {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const seeds: string[] = [];

  for (let index = 0; index < count; index += 1) {
    let state = Math.imul(index + 1, 0x9e3779b1) | 0;
    let seed = '';
    for (let position = 0; position < 8; position += 1) {
      state = (Math.imul(state, 1103515245) + 12345) | 0;
      seed += alphabet[(state >>> 16) & 31] ?? '0';
    }
    seeds.push(seed);
  }

  return seeds;
}

describe('passe corrective 2 : le fait est vrai à son propre instant', () => {
  it('mesure le rang réel au tSim de chaque fait de position, sur KR7Z8NAR', () => {
    const simulation = new RaceSimulation(KR7Z8NAR, SIM_CONFIG);
    let checked = 0;

    simulation.onFacts((facts) => {
      const distances = simulation.view.characters.map((character) => character.x);
      const ranks = computeRanks(distances, IDS);
      for (const fact of facts) {
        const claimed = claimedRank(fact);
        if (claimed === null) {
          continue;
        }
        const index = IDS.indexOf(fact.characterIds[0] ?? 'c0');
        expect(
          ranks[index],
          `${fact.type} @${fact.tSim.toFixed(2)} s revendique le rang ${String(claimed)} pour ${nameOf(fact.characterIds[0])}`,
        ).toBe(claimed);
        checked += 1;
      }
    });

    simulation.start();
    while (simulation.phase !== 'finished') {
      simulation.update(1000 / 60);
    }

    // Le diagnostic n'a de sens que si la seed produit réellement des revendications de position.
    expect(checked).toBeGreaterThan(0);
  });
});

describe('passe corrective 2 : la diffusion ne peut plus être en retard', () => {
  it('ne prononce sur KR7Z8NAR que des positions encore vraies', () => {
    const played = playWithCommentary(KR7Z8NAR);
    expectOnlyTrueClaims(played, KR7Z8NAR);

    const claims = played.lines.filter((line) => claimedRank(line.fact) !== null);
    expect(claims.length, 'KR7Z8NAR doit produire des revendications de position').toBeGreaterThan(0);

    // Le motif exact du bug : un fait du tout début de course (les rangs y changent à chaque pas),
    // prononcé après le cooldown de type, donc une fois la position perdue. Les deux faits concernés
    // sont le `LAST_COMEBACK @0,37 s` (rang 1 revendiqué, dit à 30,05 s dans l'ancien comportement)
    // et le `LAST_COMEBACK @2,77 s` (rang 1 revendiqué, dit à 50,07 s).
    const lateStartClaims = played.lines.filter(
      (line) => line.fact.tSim < 3 && line.startedAtS - line.fact.tSim > SPEAKER_POLICY.rankFactMaxAgeS,
    );
    expect(
      lateStartClaims.map((line) => `${line.fact.type}@${line.fact.tSim.toFixed(2)}→${line.startedAtS.toFixed(2)}`),
    ).toEqual([]);

    // Témoin : l'ancien comportement, avec la péremption désactivée, produit bien ces lignes-là — le
    // test précédent ne passe donc pas « parce que le harnais ne dit rien ».
    const unbounded = playWithCommentary(KR7Z8NAR, {
      ...SPEAKER_POLICY,
      rankFactMaxAgeS: Number.POSITIVE_INFINITY,
      factMaxAgeS: Number.POSITIVE_INFINITY,
    });
    const unboundedLateStart = unbounded.lines.filter(
      (line) => claimedRank(line.fact) !== null && line.startedAtS - line.fact.tSim > 3,
    );
    expect(
      unboundedLateStart.length,
      'sans péremption, la seed doit reproduire le retard historique',
    ).toBeGreaterThan(0);
  });
});

describe('passe corrective 2 : corpus de seeds', () => {
  it('ne laisse passer aucune position fausse sur 24 seeds réelles', () => {
    for (const seed of canonicalSeeds(24)) {
      expectOnlyTrueClaims(playWithCommentary(seed), seed);
    }
  }, 60_000);
});

describe('passe corrective 2 : les deux âges maximaux du speaker', () => {
  /** Politique ou seule la péremption est active : les autres portes sont ouvertes. */
  const OPEN: SpeakerPolicy = Object.freeze({
    ...SPEAKER_POLICY,
    globalCooldownS: 0,
    minWindowAvgS: 0,
    typeCooldownS: Object.freeze({
      ...SPEAKER_TYPE_COOLDOWN_S,
      LEADER_CHANGE: 0,
      BIG_COMEBACK: 0,
      LAST_COMEBACK: 0,
      OVERTAKE_STREAK: 0,
    }),
  });

  function fact(
    type: RaceFactType,
    tSim: number,
    importance: number,
    magnitudes: readonly number[],
    characterId: CharacterId,
  ): RaceFact {
    return Object.freeze({
      type,
      tSim,
      characterIds: Object.freeze([characterId]),
      magnitudes: Object.freeze([...magnitudes]),
      importance,
      textKey: `fact.${type}`,
    });
  }

  /**
   * Amorce une réplique puis met le fait à tester **en file** : la réplique en cours (importance 60)
   * ne peut pas être coupée par un fait à 55/50 (`INTERRUPT_DELTA` vaut 20), donc le candidat attend.
   */
  function queued(type: RaceFactType, tSim: number, importance: number, magnitudes: readonly number[], characterId: CharacterId): Speaker {
    const speaker = new Speaker(OPEN);
    expect(speaker.feed(fact('LEADER_CHANGE', 0, 60, [1, 0], 'c0'))).not.toBeNull();
    expect(speaker.feed(fact(type, tSim, importance, magnitudes, characterId))).toBeNull();
    expect(speaker.queuedCount()).toBe(1);
    speaker.finish();
    return speaker;
  }

  it('jette une revendication de position qui a attendu plus de rankFactMaxAgeS', () => {
    // À la borne exacte, le fait est encore prononçable.
    const inTime = queued('LEADER_CHANGE', 0.5, 60, [1, 0], 'c1');
    expect(inTime.poll(0.5 + SPEAKER_POLICY.rankFactMaxAgeS)?.fact.characterIds).toStrictEqual(['c1']);
    expect(inTime.stats().expired).toBe(0);

    // Un centième de seconde plus tard, il n'y a plus rien à dire : le fait est jeté, pas re-daté.
    const tooLate = queued('LAST_COMEBACK', 1, 55, [4, 1], 'c2');
    expect(tooLate.poll(1 + SPEAKER_POLICY.rankFactMaxAgeS + 0.01)).toBeNull();
    expect(tooLate.stats().expired).toBe(1);
    expect(tooLate.queuedCount()).toBe(0);
    expect(tooLate.totalLinesStarted()).toBe(1);
  });

  it('laisse vivre plus longtemps un fait qui décrit un épisode passé', () => {
    // Un dépassement ne revendique aucune position : la borne longue s'applique.
    const inTime = queued('OVERTAKE_STREAK', 0.5, 50, [3], 'c1');
    expect(inTime.poll(0.5 + SPEAKER_POLICY.rankFactMaxAgeS + 1)?.fact.type).toBe('OVERTAKE_STREAK');
    expect(inTime.stats().expired).toBe(0);

    const tooLate = queued('OVERTAKE_STREAK', 1, 50, [4], 'c2');
    expect(tooLate.poll(1 + SPEAKER_POLICY.factMaxAgeS + 0.01)).toBeNull();
    expect(tooLate.stats().expired).toBe(1);
  });

  it('classe les dix types de faits, sans default silencieux', () => {
    const positional: readonly RaceFactType[] = ['LEADER_CHANGE', 'BIG_COMEBACK', 'LAST_COMEBACK', 'LEADER_MALUS'];
    const episodic: readonly RaceFactType[] = [
      'OVERTAKE_STREAK',
      'BIG_BONUS',
      'CLOSE_RACE',
      'CHECKPOINT_SPLIT',
      'FINISH',
      'PHOTO_FINISH',
    ];
    for (const type of positional) {
      expect(claimsCurrentRank(type), type).toBe(true);
    }
    for (const type of episodic) {
      expect(claimsCurrentRank(type), type).toBe(false);
    }
    // Les deux bornes sont du design, et la borne de position est bien la plus stricte.
    expect(SPEAKER_POLICY.rankFactMaxAgeS).toBe(SPEAK.RANK_FACT_MAX_AGE_S);
    expect(SPEAKER_POLICY.factMaxAgeS).toBe(SPEAK.FACT_MAX_AGE_S);
    expect(SPEAKER_POLICY.rankFactMaxAgeS).toBeLessThan(SPEAKER_POLICY.factMaxAgeS);
  });
});
