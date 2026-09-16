import { describe, expect, it } from 'vitest';

import { SPEAK } from '../../src/core/config';
import type { CharacterId, RaceFact, RaceFactType } from '../../src/core/types';
import { magnitudeBucket, dedupFingerprint } from '../../src/speaker/importance';
import { segmentIndex, typeCooldownsOf } from '../../src/speaker/cooldowns';
import { SPEAKER_POLICY, SPEAKER_TYPE_COOLDOWN_S, type SpeakerPolicy } from '../../src/speaker/policy';
import { Speaker } from '../../src/speaker/Speaker';

/**
 * P009-B : discipline de parole du speaker, **sans aucun texte**.
 *
 * Tous les faits de ce fichier sont fabriques a la main : le speaker ne recoit que des `RaceFact`,
 * comme le prevoit la frontiere architecturale, et ne sait rien du moteur. Les instants utilises
 * respectent donc les contraintes reelles du design (cooldown global de 6 s, densite de parole) :
 * un test qui violerait deux regles a la fois ne prouverait rien sur celle qu'il vise.
 */

/** Fait minimal conforme au contrat de `RaceFact`. */
function fact(
  type: RaceFactType,
  tSim: number,
  importance: number,
  magnitudes: readonly number[] = [1],
  characterIds: readonly CharacterId[] = ['c0'],
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

/** Copie de la politique V1 avec des surcharges explicites : le reste vient du design. */
function withPolicy(overrides: Partial<SpeakerPolicy>): SpeakerPolicy {
  return { ...SPEAKER_POLICY, ...overrides };
}

/** Politique ou aucun cooldown de type n'existe : utile pour isoler une autre regle. */
function withoutTypeCooldowns(overrides: Partial<SpeakerPolicy> = {}): SpeakerPolicy {
  return withPolicy({
    typeCooldownS: Object.freeze({
      LEADER_CHANGE: 0,
      BIG_COMEBACK: 0,
      OVERTAKE_STREAK: 0,
      BIG_BONUS: 0,
      LEADER_MALUS: 0,
      CLOSE_RACE: 0,
      LAST_COMEBACK: 0,
      CHECKPOINT_SPLIT: 0,
      FINISH: 0,
      PHOTO_FINISH: 0,
    }),
    ...overrides,
  });
}

describe('P009-B : conformite des constantes au design', () => {
  it('reprend exactement SPEAK de GAME_DESIGN 9.3', () => {
    expect(SPEAKER_POLICY.minImportance).toBe(SPEAK.MIN_IMPORTANCE);
    expect(SPEAKER_POLICY.globalCooldownS).toBe(SPEAK.GLOBAL_COOLDOWN_S);
    expect(SPEAKER_POLICY.preemptImportance).toBe(SPEAK.PREEMPT_IMPORTANCE);
    expect(SPEAKER_POLICY.interruptDelta).toBe(SPEAK.INTERRUPT_DELTA);
    expect(SPEAKER_POLICY.queueMax).toBe(SPEAK.QUEUE_MAX);
    expect(SPEAKER_POLICY.maxLinesPerSegment).toBe(SPEAK.MAX_LINES_PER_SEGMENT);
    expect(SPEAKER_POLICY.minWindowAvgS).toBe(SPEAK.MIN_WINDOW_AVG_S);
    expect(SPEAKER_POLICY.minImportance).toBe(45);
    expect(SPEAKER_POLICY.globalCooldownS).toBe(6.0);
    expect(SPEAKER_POLICY.preemptImportance).toBe(85);
    expect(SPEAKER_POLICY.interruptDelta).toBe(20);
    expect(SPEAKER_POLICY.queueMax).toBe(3);
    expect(SPEAKER_POLICY.maxLinesPerSegment).toBe(12);
    expect(SPEAKER_POLICY.minWindowAvgS).toBe(5.0);
  });

  it('reprend exactement les cooldowns par type du design', () => {
    expect(typeCooldownsOf(SPEAKER_POLICY)).toStrictEqual({
      LEADER_CHANGE: 12,
      BIG_COMEBACK: 15,
      OVERTAKE_STREAK: 12,
      BIG_BONUS: 8,
      LEADER_MALUS: 10,
      CLOSE_RACE: 25,
      LAST_COMEBACK: 20,
      CHECKPOINT_SPLIT: 5,
      FINISH: 0,
      PHOTO_FINISH: 0,
    });
  });

  it('ne donne aucun cooldown de type aux deux faits d arrivee', () => {
    expect(SPEAKER_TYPE_COOLDOWN_S.FINISH).toBe(0);
    expect(SPEAKER_TYPE_COOLDOWN_S.PHOTO_FINISH).toBe(0);
  });

  it('decoupe les segments en [0,45[ [45,90[ [90,135[ [135,180]', () => {
    expect(segmentIndex(SPEAKER_POLICY, 0)).toBe(0);
    expect(segmentIndex(SPEAKER_POLICY, 44.999)).toBe(0);
    expect(segmentIndex(SPEAKER_POLICY, 45)).toBe(1);
    expect(segmentIndex(SPEAKER_POLICY, 89.999)).toBe(1);
    expect(segmentIndex(SPEAKER_POLICY, 90)).toBe(2);
    expect(segmentIndex(SPEAKER_POLICY, 135)).toBe(3);
    // L'arrivee a 180 s appartient au **dernier** segment : aucun segment 5 accidentel.
    expect(segmentIndex(SPEAKER_POLICY, 180)).toBe(3);
    expect(segmentIndex(SPEAKER_POLICY, 200)).toBe(3);
  });
});

describe('P009-B : importance minimale', () => {
  it('rejette une importance de 44 avant toute mise en file', () => {
    const speaker = new Speaker();
    expect(speaker.feed(fact('LEADER_CHANGE', 0, 44))).toBeNull();
    expect(speaker.queuedCount()).toBe(0);
    expect(speaker.totalLinesStarted()).toBe(0);
    expect(speaker.stats().rejectedImportance).toBe(1);
  });

  it('accepte une importance de 45 : la borne est inclusive', () => {
    const speaker = new Speaker();
    const decision = speaker.feed(fact('LEADER_CHANGE', 0, 45));
    expect(decision).not.toBeNull();
    expect(decision?.fact.importance).toBe(45);
    expect(speaker.totalLinesStarted()).toBe(1);
  });

  it('n altere jamais l importance calculee par P009-A', () => {
    const speaker = new Speaker();
    const source = fact('BIG_COMEBACK', 3, 62, [4, 3]);
    const decision = speaker.feed(source);
    expect(decision?.importance).toBe(62);
    expect(decision?.fact).toBe(source);
  });
});

describe('P009-B : cooldown global', () => {
  it('impose 6 s de silence apres un demarrage', () => {
    const speaker = new Speaker();
    expect(speaker.feed(fact('LEADER_CHANGE', 0, 60))).not.toBeNull();
    speaker.finish();

    // Un fait arrive a 5 s : la place est libre depuis la fin de la replique, mais le cooldown
    // global court depuis son *demarrage*. A 5,99 s la replique reste donc en file.
    expect(speaker.feed(fact('BIG_BONUS', 5, 60, [2], ['c1']))).toBeNull();
    expect(speaker.queuedCount()).toBe(1);
    expect(speaker.poll(5.99)).toBeNull();

    // 6,0 s : le cooldown global est leve, la replique en attente demarre.
    const decision = speaker.poll(6.0);
    expect(decision).not.toBeNull();
    expect(decision?.fact.type).toBe('BIG_BONUS');
    expect(decision?.startedAtS).toBe(6.0);
  });

  it('laisse un fait de PREEMPT_IMPORTANCE ou plus court-circuiter le cooldown global', () => {
    const speaker = new Speaker();
    expect(speaker.feed(fact('LEADER_CHANGE', 0, 60))).not.toBeNull();
    speaker.finish();

    // 6 s apres le demarrage : la densite de parole est respectee (moyenne de 6 s), donc le seul
    // obstacle restant est le cooldown global, que 90 >= PREEMPT_IMPORTANCE court-circuite.
    const decision = speaker.feed(fact('PHOTO_FINISH', 6.0, 90, [2]));
    expect(decision).not.toBeNull();
    expect(decision?.fact.type).toBe('PHOTO_FINISH');
    expect(decision?.startedAtS).toBe(6.0);
    // Le cooldown global court depuis ce nouveau demarrage.
    expect(speaker.globalCooldownReady(11.99)).toBe(false);
    expect(speaker.globalCooldownReady(12.0)).toBe(true);
  });

  it('ne laisse PAS un fait sous PREEMPT_IMPORTANCE contourner le cooldown global', () => {
    // Densite neutralisee : seule la porte du cooldown global peut encore refuser ce fait.
    const speaker = new Speaker(withoutTypeCooldowns({ minWindowAvgS: 0 }));
    expect(speaker.feed(fact('LEADER_CHANGE', 0, 84))).not.toBeNull();
    speaker.finish();
    // 84 < PREEMPT_IMPORTANCE : la replique reste en file tant que les 6 s ne sont pas ecoulees.
    expect(speaker.feed(fact('BIG_BONUS', 2, 84, [2], ['c1']))).toBeNull();
    expect(speaker.queuedCount()).toBe(1);
    expect(speaker.poll(5.99)).toBeNull();
    expect(speaker.poll(6.02)).not.toBeNull();
  });

  it('separe nettement le contournement du global de la preemption', () => {
    const speaker = new Speaker();
    expect(speaker.feed(fact('LEADER_CHANGE', 0, 60))).not.toBeNull();

    // 90 couperait la replique en cours (90 >= 60 + 20), mais la densite de parole interdit encore
    // un nouveau depart a 2 s : la fenetre glissante s'applique avant la preemption.
    expect(speaker.feed(fact('PHOTO_FINISH', 2, 90, [2]))).toBeNull();
    expect(speaker.currentDecision()?.importance).toBe(60);
    expect(speaker.queuedCount()).toBe(1);
    expect(speaker.stats().preempted).toBe(0);

    // A 6 s, toutes les portes sont ouvertes : la preemption a lieu.
    expect(speaker.poll(6)).not.toBeNull();
    expect(speaker.stats().preempted).toBe(1);
  });
});

describe('P009-B : cooldown par type', () => {
  const cases: readonly (readonly [RaceFactType, number])[] = [
    ['LEADER_CHANGE', 12],
    ['BIG_COMEBACK', 15],
    ['OVERTAKE_STREAK', 12],
    ['BIG_BONUS', 8],
    ['LEADER_MALUS', 10],
    ['CLOSE_RACE', 25],
    ['LAST_COMEBACK', 20],
  ];

  for (const [type, cooldownS] of cases) {
    it(`respecte les ${cooldownS} s de ${type}`, () => {
      // Densite neutralisee : le cooldown de type est, avec le global, la seule porte qui juge ce
      // fait. Le fait arrive **avant** la fin de son cooldown de type, donc il attend en file.
      const speaker = new Speaker(withPolicy({ minWindowAvgS: 0 }));
      const characters: readonly CharacterId[] = type === 'CLOSE_RACE' ? [] : ['c0'];

      // Premier fait : il demarre immediatement (aucun historique).
      expect(speaker.feed(fact(type, 0, 50, [1], characters))).not.toBeNull();
      speaker.finish();

      // Fait du **meme type**, d'identite differente (magnitude 2) pour echapper a la
      // deduplication : seul le cooldown de type peut encore le retenir.
      const second = fact(type, cooldownS - 0.01, 50, [2], characters);
      expect(speaker.feed(second), `${type} avant ${cooldownS} s`).toBeNull();
      expect(speaker.queuedCount()).toBe(1);
      expect(speaker.typeCooldownReady(type, cooldownS - 0.01)).toBe(false);
      expect(speaker.typeCooldownReady(type, cooldownS)).toBe(true);

      // Le fait attend en file ; il demarre des que le cooldown de type est ecoule, pas avant.
      expect(speaker.poll(cooldownS - 0.01)).toBeNull();
      const decision = speaker.poll(cooldownS + 0.02);
      expect(decision?.fact).toBe(second);
      expect(decision?.startedAtS).toBe(cooldownS + 0.02);
    });
  }

  it('respecte les 5 s de CHECKPOINT_SPLIT, plus court que le cooldown global', () => {
    // CHECKPOINT_SPLIT est le seul type dont le cooldown est **inferieur** au cooldown global :
    // il faut donc neutraliser ce dernier pour que la porte du type soit la seule a juger.
    const speaker = new Speaker(withPolicy({ globalCooldownS: 0, minWindowAvgS: 0 }));
    expect(speaker.feed(fact('CHECKPOINT_SPLIT', 0, 50, [1], []))).not.toBeNull();
    speaker.finish();

    const second = fact('CHECKPOINT_SPLIT', 4.99, 50, [2], []);
    expect(speaker.feed(second)).toBeNull();
    expect(speaker.typeCooldownReady('CHECKPOINT_SPLIT', 4.99)).toBe(false);
    expect(speaker.typeCooldownReady('CHECKPOINT_SPLIT', 5)).toBe(true);
    expect(speaker.poll(4.99)).toBeNull();
    expect(speaker.poll(5.02)?.fact).toBe(second);
  });

  it('n est jamais contourne, meme par un fait de PREEMPT_IMPORTANCE ou plus', () => {
    const speaker = new Speaker();
    expect(speaker.feed(fact('LEADER_CHANGE', 0, 50, [1], ['c0']))).not.toBeNull();
    speaker.finish();

    // Meme type, autres personnages : la deduplication ne peut pas retenir ce fait.
    expect(speaker.feed(fact('LEADER_CHANGE', 6, 95, [2], ['c1']))).toBeNull();
    expect(speaker.typeCooldownReady('LEADER_CHANGE', 11.99)).toBe(false);
    expect(speaker.poll(11.99)).toBeNull();

    const decision = speaker.poll(12);
    expect(decision).not.toBeNull();
    expect(decision?.fact.characterIds).toStrictEqual(['c1']);
  });

  it('distingue le bypass du global et le bypass du type sur le meme fait', () => {
    const speaker = new Speaker();
    expect(speaker.feed(fact('LEADER_CHANGE', 0, 50, [1], ['c0']))).not.toBeNull();
    speaker.finish();

    // Un fait a 95 de type LEADER_CHANGE reste bloque par son cooldown de type, meme a 2 s.
    expect(speaker.feed(fact('LEADER_CHANGE', 2, 95, [2], ['c1']))).toBeNull();
    expect(speaker.queuedCount()).toBe(1);

    // Alors qu'un fait du meme calibre d'un autre type passe : seul le global est contournable.
    const other = new Speaker();
    expect(other.feed(fact('LEADER_CHANGE', 0, 50, [1], ['c0']))).not.toBeNull();
    other.finish();
    const bypass = other.feed(fact('LEADER_MALUS', 6, 95, [2], ['c1']));
    expect(bypass).not.toBeNull();
    expect(bypass?.startedAtS).toBe(6);
  });

  it('ne consomme pas de cooldown pour un fait refuse, deduplique ou jete de la file', () => {
    const speaker = new Speaker();

    // Refuse par l'importance : rien n'est consomme.
    speaker.feed(fact('LEADER_CHANGE', 0, 44, [3, 1], ['c0', 'c1']));
    expect(speaker.typeCooldownReady('LEADER_CHANGE', 0)).toBe(true);
    expect(speaker.globalCooldownReady(0)).toBe(true);
    expect(speaker.stats().linesStarted).toBe(0);
    expect(speaker.stats().rejectedImportance).toBe(1);

    // Deduplique : rien n'est consomme non plus.
    speaker.feed(fact('LEADER_CHANGE', 1, 60, [3, 1], ['c0', 'c1']));
    speaker.finish();
    speaker.feed(fact('LEADER_CHANGE', 2, 60, [3, 1], ['c0', 'c1']));
    expect(speaker.stats().deduplicated).toBe(1);
    // La replique a reellement demarre a 1 s : le cooldown de 12 s est donc leve a 13 s.
    expect(speaker.typeCooldownReady('LEADER_CHANGE', 13)).toBe(true);
    expect(speaker.stats().linesStarted).toBe(1);

    // Jete de la file : le cooldown de son type reste intact.
    const queue = new Speaker();
    queue.feed(fact('CLOSE_RACE', 0, 100, [1], []));
    queue.feed(fact('BIG_BONUS', 6, 60, [1], ['c0']));
    queue.feed(fact('BIG_COMEBACK', 6.5, 62, [1], ['c1']));
    queue.feed(fact('LAST_COMEBACK', 7, 64, [1], ['c2']));
    expect(queue.feed(fact('LEADER_MALUS', 8, 65, [1], ['c3']))).toBeNull();
    expect(queue.stats().queuedDropped).toBe(1);
    // Le type BIG_BONUS n'a jamais parle : son cooldown est intact a 8 s.
    expect(queue.typeCooldownReady('BIG_BONUS', 8)).toBe(true);
    expect(queue.stats().linesStarted).toBe(1);
  });
});

describe('P009-B : deduplication', () => {
  it('supprime un fait identique pendant 10 s, puis le laisse repasser', () => {
    // Cooldowns de type, global et densite neutralises : seule la deduplication peut separer ces
    // faits, ce qui isole exactement la regle testee.
    const speaker = new Speaker(withoutTypeCooldowns({ globalCooldownS: 0, minWindowAvgS: 0 }));
    const identical = (tSim: number): RaceFact => fact('CLOSE_RACE', tSim, 60, [3, 1], []);

    expect(speaker.feed(identical(0))).not.toBeNull();
    speaker.finish();

    // 5 s plus tard : fait identique, supprime avant toute mise en file, rien n'est consomme.
    expect(speaker.feed(identical(5))).toBeNull();
    expect(speaker.stats().deduplicated).toBe(1);
    expect(speaker.queuedCount()).toBe(0);

    // 9,999 s : encore dans la fenetre de deduplication.
    expect(speaker.feed(identical(9.999))).toBeNull();
    expect(speaker.stats().deduplicated).toBe(2);

    // 10 s : la fenetre est ecoulee, le fait est de nouveau admissible.
    const decision = speaker.feed(identical(10.02));
    expect(decision).not.toBeNull();
    expect(decision?.fact.tSim).toBe(10.02);
    expect(speaker.stats().deduplicated).toBe(2);
  });

  it('ne deduplique ni un type different, ni des personnages differents', () => {
    const speaker = new Speaker();
    speaker.feed(fact('CHECKPOINT_SPLIT', 0, 60, [3, 1], ['c0', 'c1']));
    speaker.finish();
    // Meme type, autres personnages : autre fait. Le cooldown de type (5 s) est ecoule a 6,02 s,
    // et la densite est respectee : le fait demarre donc immediatement.
    expect(speaker.feed(fact('CHECKPOINT_SPLIT', 6.02, 60, [3, 1], ['c0', 'c2']))).not.toBeNull();
  });

  it('traite une tranche de magnitude differente comme un fait different', () => {
    // Avec une resolution de 1, 1,2 et 1,4 tombent dans la meme tranche (round(1,2) = round(1,4) = 1).
    const coarse = withoutTypeCooldowns({
      magnitudeBucketResolution: 1,
      globalCooldownS: 0,
      minWindowAvgS: 0,
    });
    const speaker = new Speaker(coarse);
    speaker.feed(fact('CLOSE_RACE', 0, 50, [1.2]));
    speaker.finish();
    expect(speaker.feed(fact('CLOSE_RACE', 1, 50, [1.4]))).toBeNull();
    expect(speaker.stats().deduplicated).toBe(1);
    // Alors que 1,6 tombe dans la tranche suivante : le fait n'est pas un doublon.
    expect(speaker.feed(fact('CLOSE_RACE', 2, 50, [1.6]))).not.toBeNull();
  });

  it('n enregistre aucune empreinte pour un fait jamais prononce', () => {
    const speaker = new Speaker();
    // 44 est refuse : il ne doit pas faire taire un fait identique a 50 plus tard.
    speaker.feed(fact('LEADER_CHANGE', 0, 44, [3, 1], ['c0', 'c1']));
    expect(speaker.feed(fact('LEADER_CHANGE', 1, 50, [3, 1], ['c0', 'c1']))).not.toBeNull();
  });

  it('calcule une empreinte stable : type + personnages ordonnes + tranche', () => {
    const source = fact('BIG_COMEBACK', 0, 50, [4, 3], ['c1', 'c0']);
    const resolution = SPEAKER_POLICY.magnitudeBucketResolution;
    expect(dedupFingerprint(source, resolution)).toBe('BIG_COMEBACK|c1,c0|16');
    expect(magnitudeBucket(source, resolution)).toBe(16);
    expect(magnitudeBucket(fact('BIG_COMEBACK', 0, 50, []), resolution)).toBe(0);
  });
});

describe('P009-B : file d attente', () => {
  /**
   * File remplie pendant qu'une replique d'importance maximale occupe la place : aucun des faits
   * suivants n'atteint `100 + INTERRUPT_DELTA`, donc aucun ne peut preempter, ils attendent tous
   * leur tour. Le fait de tete reste en cours : c'est ce qui distingue une file d'une simple
   * observation.
   */
  function filledQueue(): Speaker {
    const speaker = new Speaker();
    speaker.feed(fact('LEADER_CHANGE', 0, 100));
    speaker.feed(fact('BIG_BONUS', 6, 60, [1], ['c0']));
    speaker.feed(fact('BIG_COMEBACK', 6.5, 62, [1], ['c1']));
    speaker.feed(fact('LAST_COMEBACK', 7, 64, [1], ['c2']));
    return speaker;
  }

  it('ne depasse jamais 3 candidats et jette le moins important', () => {
    const speaker = filledQueue();
    expect(speaker.queuedCount()).toBe(3);

    // Quatrieme candidat, moins important que le plus faible (60) : rejete, file inchangee.
    expect(speaker.feed(fact('CHECKPOINT_SPLIT', 8, 50, [1], ['c3']))).toBeNull();
    expect(speaker.queuedCount()).toBe(3);
    expect(speaker.stats().rejectedQueue).toBe(1);
    expect(speaker.stats().queuedDropped).toBe(0);

    // Cinquieme, plus important que le plus faible (60) : le plus faible est jete.
    expect(speaker.feed(fact('LEADER_MALUS', 9, 65, [1], ['c4']))).toBeNull();
    expect(speaker.queuedCount()).toBe(3);
    expect(speaker.stats().queuedDropped).toBe(1);

    // La file sort strictement par ordre de priorite : 65, 64, 62. Aucune duree arbitraire
    // n'intervient : c'est la priorite seule qui decide. Un depart toutes les 6 s respecte le
    // cooldown global, donc rien d'autre ne filtre.
    speaker.finish();
    expect(speaker.poll(20)?.importance).toBe(65);
    speaker.finish();
    expect(speaker.poll(26)?.importance).toBe(64);
    speaker.finish();
    expect(speaker.poll(32)?.importance).toBe(62);

    // File vide : un fait frais, meme faible, demarre immediatement.
    speaker.finish();
    expect(speaker.queuedCount()).toBe(0);
    expect(speaker.feed(fact('LEADER_MALUS', 38, 55, [9], ['c5']))?.importance).toBe(55);
  });

  it('departage les egalites par ordre d arrivee, sans dependre d un Map ou d un Set', () => {
    const speaker = new Speaker();
    speaker.feed(fact('LEADER_CHANGE', 0, 100));
    speaker.feed(fact('BIG_BONUS', 6, 60, [1], ['c0']));
    speaker.feed(fact('BIG_COMEBACK', 6.5, 62, [1], ['c1']));
    speaker.feed(fact('LAST_COMEBACK', 7, 64, [1], ['c2']));
    expect(speaker.queuedCount()).toBe(3);

    // Quatrieme candidat, plus faible que le plus faible de la file (60) : il est rejete, et le
    // fait de 60, premier arrive de sa tranche, reste en place.
    expect(speaker.feed(fact('LEADER_MALUS', 8, 60, [1], ['c3']))).toBeNull();
    expect(speaker.queuedCount()).toBe(3);
    expect(speaker.stats().queuedDropped).toBe(0);
    expect(speaker.stats().rejectedQueue).toBe(1);

    // La file reste strictement ordonnee, a importance egale par ordre d'arrivee.
    speaker.finish();
    expect(speaker.poll(20)?.importance).toBe(64);
    speaker.finish();
    expect(speaker.poll(26)?.importance).toBe(62);
    speaker.finish();
    expect(speaker.poll(32)?.importance).toBe(60);
  });

  it('ne prononce jamais un fait jete de la file et ne consomme pas son cooldown', () => {
    const speaker = filledQueue();
    expect(speaker.feed(fact('LEADER_MALUS', 9, 65, [1], ['c4']))).toBeNull();
    expect(speaker.stats().queuedDropped).toBe(1);
    // Le type BIG_BONUS n'a jamais parle : son cooldown est intact a 8 s.
    expect(speaker.typeCooldownReady('BIG_BONUS', 8)).toBe(true);
    expect(speaker.stats().linesStarted).toBe(1);
  });

  it('conserve la file a l interieur de QUEUE_MAX quel que soit l ordre d arrivee', () => {
    const speaker = new Speaker();
    speaker.feed(fact('LEADER_CHANGE', 0, 100));
    speaker.finish();
    for (let index = 0; index < 12; index += 1) {
      speaker.feed(fact('BIG_BONUS', 6 + index, 45 + index, [index], ['c0']));
      expect(speaker.queuedCount()).toBeLessThanOrEqual(SPEAKER_POLICY.queueMax);
    }
    expect(speaker.queuedCount()).toBe(3);
  });

  it('ne bloque pas la file sur un candidat de tete retenu par son cooldown de type', () => {
    const speaker = new Speaker();
    // Le type de A a deja parle a 0 s : son cooldown de 12 s court jusqu'a 12 s, donc A sera retenu
    // alors que B, sans cooldown de type, sera eligible des la fin de la replique en cours.
    speaker.feed(fact('LEADER_CHANGE', 0, 60, [1], ['c0']));

    // A est plus important (90) mais reste bloque par son type ; B (70) ne peut pas couper la
    // replique en cours, il attend donc son tour en file.
    expect(speaker.feed(fact('LEADER_CHANGE', 6, 90, [2], ['c1']))).toBeNull();
    expect(speaker.feed(fact('PHOTO_FINISH', 6, 70, [3]))).toBeNull();
    expect(speaker.queuedCount()).toBe(2);

    // La replique en cours se termine : A est en tete de file mais echoue sur sa porte de type, B
    // est examine ensuite et passe. Sans parcours de file, A aurait fige la file entiere.
    speaker.finish();
    const decision = speaker.poll(6);
    expect(decision?.fact.type).toBe('PHOTO_FINISH');
    expect(decision?.importance).toBe(70);
    expect(speaker.currentDecision()?.fact.type).toBe('PHOTO_FINISH');

    // A est toujours en file, intact, et passe des que son cooldown de type est ecoule.
    expect(speaker.queuedCount()).toBe(1);
    expect(speaker.typeCooldownReady('LEADER_CHANGE', 11.99)).toBe(false);
    expect(speaker.typeCooldownReady('LEADER_CHANGE', 12)).toBe(true);
    speaker.finish();
    const later = speaker.poll(13);
    expect(later?.fact.type).toBe('LEADER_CHANGE');
    expect(later?.importance).toBe(90);
    expect(speaker.queuedCount()).toBe(0);
  });

  it('ne demarre pas un candidat sous INTERRUPT_DELTA pour autant qu il passe ses portes', () => {
    // Complement du test precedent : un candidat eligible mais trop faible pour couper la replique
    // en cours reste en file. Le parcours de file ne contourne pas la regle de preemption.
    const speaker = new Speaker();
    speaker.feed(fact('LEADER_CHANGE', 0, 80));
    expect(speaker.feed(fact('PHOTO_FINISH', 6, 70, [2]))).toBeNull();
    expect(speaker.currentDecision()?.importance).toBe(80);
    expect(speaker.queuedCount()).toBe(1);
    expect(speaker.stats().preempted).toBe(0);
  });
});

describe('P009-B : lots de faits d un meme pas', () => {
  /** Deux faits de types distincts, d'importances differentes, au meme instant. */
  function pair(first: number, second: number): readonly RaceFact[] {
    return [
      fact('LEADER_CHANGE', 6, first, [1], ['c0']),
      fact('BIG_BONUS', 6, second, [2], ['c1']),
    ];
  }

  /** Amorce une replique au pas 0 pour que le lot du pas 6 trouve l'horloge globale ouverte. */
  function seeded(): Speaker {
    const speaker = new Speaker();
    expect(speaker.feed(fact('CLOSE_RACE', 0, 60))).not.toBeNull();
    speaker.finish();
    return speaker;
  }

  it('considere tout le lot avant de parler : [50, 60] demarre le 60', () => {
    const decision = seeded().feedAll(pair(50, 60));
    expect(decision?.importance).toBe(60);
    expect(decision?.fact.type).toBe('BIG_BONUS');
  });

  it('donne le meme resultat pour [60, 50] : l ordre du lot ne decide pas', () => {
    const decision = seeded().feedAll(pair(60, 50));
    expect(decision?.importance).toBe(60);
    expect(decision?.fact.type).toBe('LEADER_CHANGE');
  });

  it('choisit toujours le fait le plus important du lot, quel que soit son rang d entree', () => {
    // Les deux ordres menent a la **meme importance** gagnante : le fait fort gagne dans les deux
    // cas, et le fait faible reste en file au lieu de demarrer en premier.
    const forward = seeded();
    const backward = seeded();
    const [first] = [forward.feedAll(pair(50, 60))];
    const [second] = [backward.feedAll(pair(60, 50))];
    expect(first?.importance).toBe(60);
    expect(second?.importance).toBe(60);
    expect(forward.queuedCount()).toBe(1);
    expect(backward.queuedCount()).toBe(1);
  });

  it('ne laisse pas un fait faible du lot demarrer avant un fait fort du meme pas', () => {
    // Le 50 arrive en premier dans le lot : sans admission groupee, il demarrerait avant que le 60
    // n'ait ete vu. C'est exactement ce que `feedAll` doit empecher.
    const speaker = seeded();
    const decision = speaker.feedAll(pair(50, 60));
    expect(decision?.importance, 'le 50 ne doit pas demarrer').not.toBe(50);
    expect(speaker.currentDecision()?.fact.type).toBe('BIG_BONUS');
    // Le 50 reste en file, intact, et pourra parler plus tard.
    expect(speaker.queuedCount()).toBe(1);
    speaker.finish();
    expect(speaker.poll(12)?.importance).toBe(50);
  });

  it('refuse un lot heterogene en temps plutot que de deviner l instant', () => {
    const speaker = new Speaker();
    expect(() =>
      speaker.feedAll([fact('LEADER_CHANGE', 6, 60), fact('BIG_BONUS', 6.5, 60, [1], ['c1'])]),
    ).toThrow(RangeError);
  });

  it('refuse un lot anterieur au dernier fait observe', () => {
    const speaker = new Speaker();
    speaker.feed(fact('LEADER_CHANGE', 10, 60));
    expect(() => speaker.feedAll([fact('BIG_BONUS', 9, 60, [1], ['c1'])])).toThrow(RangeError);
  });

  it('n altere pas le comportement de `feed` sur un fait isole', () => {
    // Un fait isole reste admis puis teste immediatement : `feed` et `feedAll([fait])` coincident.
    const single = new Speaker();
    const batched = new Speaker();
    expect(single.feed(fact('LEADER_CHANGE', 0, 60))?.importance).toBe(60);
    expect(batched.feedAll([fact('LEADER_CHANGE', 0, 60)])?.importance).toBe(60);
    expect(single.stats()).toStrictEqual(batched.stats());
  });

  it('accepte un lot vide sans rien changer', () => {
    const speaker = new Speaker();
    expect(speaker.feedAll([])).toBeNull();
    expect(speaker.queuedCount()).toBe(0);
    expect(speaker.stats().fed).toBe(0);
  });
});

describe('P009-B : quota par segment', () => {
  it('plafonne a 12 repliques par segment, meme pour un fait tres important', () => {
    // Cooldowns neutralises pour saturer le quota : seule la porte du quota doit refuser.
    const permissive = withoutTypeCooldowns({ globalCooldownS: 0, minWindowAvgS: 0 });
    const speaker = new Speaker(permissive);

    for (let index = 0; index < 12; index += 1) {
      const decision = speaker.feed(fact('BIG_BONUS', index, 60, [index], ['c0']));
      expect(decision, `replique ${index + 1}`).not.toBeNull();
      speaker.finish();
    }
    expect(speaker.linesInSegment(0)).toBe(12);

    expect(
      speaker.feed(fact('PHOTO_FINISH', 12, 95, [1])),
      'un fait a 95 ne depasse jamais le quota de 12',
    ).toBeNull();
    expect(speaker.linesInSegment(0)).toBe(12);
    expect(speaker.totalLinesStarted()).toBe(12);

    // Le segment suivant repart avec son propre quota : le blocage n'est pas definitif.
    const next = speaker.feed(fact('LEADER_MALUS', 45, 60, [1], ['c1']));
    expect(next).not.toBeNull();
    expect(speaker.linesInSegment(1)).toBe(1);
  });

  it('applique un quota independant au segment suivant', () => {
    const speaker = new Speaker();
    expect(speaker.feed(fact('LEADER_CHANGE', 0, 60))).not.toBeNull();
    speaker.finish();
    expect(speaker.feed(fact('BIG_BONUS', 45, 60, [1], ['c1']))).not.toBeNull();
    expect(speaker.linesInSegment(0)).toBe(1);
    expect(speaker.linesInSegment(1)).toBe(1);
  });

  it('place la replique a 44,999 s dans le segment 0 et celle a 45 s dans le segment 1', () => {
    const speaker = new Speaker();
    expect(speaker.feed(fact('LEADER_CHANGE', 44.999, 60))).not.toBeNull();
    speaker.finish();
    expect(speaker.segmentIndexAt(44.999)).toBe(0);
    expect(speaker.linesInSegment(0)).toBe(1);
    expect(speaker.linesInSegment(1)).toBe(0);

    // La replique suivante ne peut demarrer qu'une fois le cooldown global ecoule, donc dans le
    // segment 1, et elle doit tomber dans le **bon** segment selon son instant de demarrage.
    expect(speaker.feed(fact('BIG_BONUS', 51, 60, [1], ['c1']))).not.toBeNull();
    expect(speaker.segmentIndexAt(51)).toBe(1);
    expect(speaker.linesInSegment(0)).toBe(1);
    expect(speaker.linesInSegment(1)).toBe(1);
  });

  it('traite l arrivee a 180 s dans le dernier segment, sans creer de segment 5', () => {
    const speaker = new Speaker();
    const decision = speaker.feed(fact('PHOTO_FINISH', 180, 90, [2, 1]));
    expect(decision).not.toBeNull();
    expect(decision?.startedAtS).toBe(180);
    expect(speaker.segmentIndexAt(180)).toBe(3);
    expect(speaker.linesInSegment(3)).toBe(1);
    expect(speaker.policyInUse().segmentCount).toBe(4);
  });

  it('n oppose aucun cooldown de type a un fait d arrivee, FINISH comme PHOTO_FINISH', () => {
    for (const type of ['FINISH', 'PHOTO_FINISH'] as const) {
      const speaker = new Speaker();
      const decision = speaker.feed(fact(type, 180, type === 'PHOTO_FINISH' ? 90 : 80, [2, 1]));
      expect(decision, type).not.toBeNull();
      expect(decision?.startedAtS).toBe(180);
      expect(speaker.linesInSegment(3)).toBe(1);
    }
  });
});

describe('P009-B : fenetre glissante de densite', () => {
  /** Demarre une replique au temps demande et libere la place dans la foulee. */
  function speakAt(speaker: Speaker, tSim: number, index: number): boolean {
    const decision = speaker.feed(fact('BIG_BONUS', tSim, 60, [index], ['c0']));
    if (decision === null) {
      return false;
    }
    speaker.finish();
    return true;
  }

  it('refuse une cadence plus rapide que 5 s de moyenne sur 30 s', () => {
    const density = withoutTypeCooldowns({ globalCooldownS: 0 });
    const speaker = new Speaker(density);
    // Six departs a 0, 5, 10, 15, 20, 25 : la fenetre de 30 s contient 5 ecarts de 5 s, soit
    // exactement la moyenne minimale. Un septieme a 26 s la ferait tomber sous 5 s : refus.
    for (let index = 0; index < 6; index += 1) {
      expect(speakAt(speaker, index * 5, index), `depart ${index}`).toBe(true);
    }
    expect(speakAt(speaker, 26, 6)).toBe(false);

    // Apres un silence, la fenetre se vide et la parole redevient possible.
    expect(speakAt(speaker, 60, 7)).toBe(true);
  });

  it('accepte la cadence limite de windowS / minWindowAvgS secondes', () => {
    const density = withoutTypeCooldowns({ globalCooldownS: 0 });
    const speaker = new Speaker(density);
    for (let index = 0; index < 6; index += 1) {
      expect(speakAt(speaker, index * 6, index), `depart ${index}`).toBe(true);
    }
  });

  it('ne se declenche jamais pour une cadence conforme au cooldown global', () => {
    const speaker = new Speaker();
    // PHOTO_FINISH a un cooldown de type nul : le cooldown global (6 s) est donc le **seul** rythme
    // impose. Une replique toutes les 6,05 s doit passer de bout en bout, sans que la fenetre
    // glissante ne bloque quoi que ce soit. `finish` simule la fin normale de la replique.
    for (let index = 0; index < 12; index += 1) {
      const decision = speaker.feed(fact('PHOTO_FINISH', index * 6.05, 60, [index]));
      expect(decision, `depart ${index}`).not.toBeNull();
      speaker.finish();
    }
    expect(speaker.totalLinesStarted()).toBe(12);
    expect(speaker.queuedCount()).toBe(0);
  });

  it('ne memorise que la fenetre : un ancien depart tres espace ne bloque plus rien', () => {
    const density = withoutTypeCooldowns({ globalCooldownS: 0 });
    const speaker = new Speaker(density);
    for (let index = 0; index < 5; index += 1) {
      expect(speakAt(speaker, index * 6, index), `depart ${index}`).toBe(true);
    }
    // Dernier depart a 24 s. A 39 s, l'ancien depart de 0 s est sorti de la fenetre de 30 s : la
    // memoire bornee ne le retient plus, et la parole est de nouveau possible.
    expect(speakAt(speaker, 39, 6)).toBe(true);
    expect(speakAt(speaker, 45, 7)).toBe(true);
  });
});

describe('P009-B : replique en cours, preemption et reprise', () => {
  it('remplace une replique d importance 60 par une replique d importance 90', () => {
    const speaker = new Speaker();
    const first = speaker.feed(fact('LEADER_CHANGE', 0, 60));
    expect(first).not.toBeNull();
    expect(speaker.isSpeaking()).toBe(true);

    // 90 >= 60 + 20 : la preemption est autorisee. Elle n'est pas retenue par le cooldown global,
    // que 90 >= PREEMPT_IMPORTANCE court-circuite.
    const second = speaker.feed(fact('PHOTO_FINISH', 6, 90, [2]));
    expect(second).not.toBeNull();
    expect(second?.fact.type).toBe('PHOTO_FINISH');
    expect(speaker.currentDecision()).toBe(second);
    expect(speaker.stats().preempted).toBe(1);

    // Le fait preempte n'est jamais rejoue : la file est vide.
    expect(speaker.queuedCount()).toBe(0);
    expect(speaker.drain()).toStrictEqual([first, second]);
  });

  it('ne remplace PAS une replique d importance 60 par une replique d importance 70', () => {
    const speaker = new Speaker();
    const first = speaker.feed(fact('LEADER_CHANGE', 0, 60));
    expect(first).not.toBeNull();

    // 70 < 60 + 20 : la replique en cours reste. Le fait est mis en file.
    expect(speaker.feed(fact('BIG_BONUS', 6, 70, [2], ['c1']))).toBeNull();
    expect(speaker.currentDecision()).toBe(first);
    expect(speaker.queuedCount()).toBe(1);

    // A 8 s, le cooldown de type de BIG_BONUS est ecoule : la replique en attente demarre alors que
    // la precedente est toujours ouverte, mais 70 n'a jamais coupe le 60.
    speaker.finish();
    expect(speaker.poll(8)?.importance).toBe(70);
    expect(speaker.stats().preempted).toBe(0);
  });

  it('remplace a la limite exacte de INTERRUPT_DELTA', () => {
    const speaker = new Speaker();
    speaker.feed(fact('BIG_BONUS', 0, 50, [1], ['c0']));
    // 70 >= 50 + 20 : borne inclusive.
    const decision = speaker.feed(fact('PHOTO_FINISH', 6, 70, [2]));
    expect(decision).not.toBeNull();
    expect(speaker.stats().preempted).toBe(1);
  });

  it('ne remplace pas un cran sous la limite', () => {
    const speaker = new Speaker();
    speaker.feed(fact('BIG_BONUS', 0, 50, [1], ['c0']));
    expect(speaker.feed(fact('PHOTO_FINISH', 6, 69.999, [2]))).toBeNull();
    expect(speaker.stats().preempted).toBe(0);
    expect(speaker.currentDecision()?.importance).toBe(50);
  });

  it('fait dependre la preemption de INTERRUPT_DELTA, pas de PREEMPT_IMPORTANCE', () => {
    const speaker = new Speaker();
    speaker.feed(fact('BIG_BONUS', 0, 50, [1], ['c0']));
    // 70 < PREEMPT_IMPORTANCE mais 70 >= 50 + 20 : la preemption a lieu sans aucun contournement.
    const decision = speaker.feed(fact('LEADER_MALUS', 6, 70, [2], ['c1']));
    expect(decision).not.toBeNull();
    expect(decision?.fact.type).toBe('LEADER_MALUS');
    expect(speaker.stats().preempted).toBe(1);
  });

  it('debloque la replique suivante quand la replique en cours se termine', () => {
    const speaker = new Speaker();
    expect(speaker.feed(fact('LEADER_CHANGE', 0, 60))).not.toBeNull();

    // Pendant la replique, rien ne demarre : le fait attend.
    expect(speaker.feed(fact('CHECKPOINT_SPLIT', 1, 48, []))).toBeNull();
    expect(speaker.poll(2)).toBeNull();
    expect(speaker.currentDecision()).not.toBeNull();

    speaker.finish();
    expect(speaker.isSpeaking()).toBe(false);
    const decision = speaker.poll(6);
    expect(decision?.fact.type).toBe('CHECKPOINT_SPLIT');
    expect(speaker.isSpeaking()).toBe(true);
  });

  it('laisse `begin` retablir la replique courante signalee par l appelant', () => {
    const speaker = new Speaker();
    const decision = speaker.feed(fact('LEADER_CHANGE', 0, 60));
    expect(decision).not.toBeNull();
    speaker.finish();
    expect(speaker.isSpeaking()).toBe(false);

    if (decision !== null) {
      speaker.begin(decision);
    }
    expect(speaker.isSpeaking()).toBe(true);
    expect(speaker.currentDecision()).toBe(decision);
  });
});

describe('P009-B : sortie et invariants', () => {
  it('n emet jamais de candidat sans fait source', () => {
    const speaker = new Speaker();
    const sources: RaceFact[] = [
      fact('LEADER_CHANGE', 0, 60),
      fact('BIG_BONUS', 6, 60, [1], ['c1']),
      fact('PHOTO_FINISH', 12, 90, [2]),
    ];
    for (const source of sources) {
      const decision = speaker.feed(source);
      expect(decision?.fact).toBe(source);
      speaker.finish();
    }
    for (const decision of speaker.drain()) {
      expect(sources).toContain(decision.fact);
      expect(decision.fact.type).toBeDefined();
    }
  });

  it('refuse une suite de faits non chronologique plutot que de la deviner', () => {
    const speaker = new Speaker();
    speaker.feed(fact('LEADER_CHANGE', 10, 60));
    expect(() => speaker.feed(fact('BIG_BONUS', 9, 60, [1], ['c1']))).toThrow(RangeError);
  });

  it('produit une decision gelee, dont le fait source reste intact', () => {
    const speaker = new Speaker();
    const source = fact('BIG_COMEBACK', 3, 62, [4, 3]);
    const decision = speaker.feed(source);
    expect(Object.isFrozen(decision)).toBe(true);
    expect(source.magnitudes).toStrictEqual([4, 3]);
    expect(source.importance).toBe(62);
    expect(source.characterIds).toStrictEqual(['c0']);
  });

  it('remet a zero cooldowns, file, quota et historique', () => {
    const speaker = new Speaker();
    speaker.feed(fact('LEADER_CHANGE', 0, 60));
    speaker.feed(fact('BIG_BONUS', 1, 60, [1], ['c1']));
    speaker.drain();
    expect(speaker.queuedCount()).toBe(1);
    expect(speaker.totalLinesStarted()).toBe(1);
    expect(speaker.isSpeaking()).toBe(true);

    speaker.reset();

    expect(speaker.currentDecision()).toBeNull();
    expect(speaker.queuedCount()).toBe(0);
    expect(speaker.totalLinesStarted()).toBe(0);
    expect(speaker.drain()).toStrictEqual([]);
    expect(speaker.linesInSegment(0)).toBe(0);
    expect(speaker.linesInSegment(3)).toBe(0);
    expect(speaker.globalCooldownReady(0)).toBe(true);
    expect(speaker.typeCooldownReady('LEADER_CHANGE', 0)).toBe(true);
    expect(speaker.stats()).toStrictEqual({
      fed: 0,
      rejectedImportance: 0,
      deduplicated: 0,
      rejectedQueue: 0,
      queued: 0,
      linesStarted: 0,
      preempted: 0,
      queuedDropped: 0,
    });

    // Et la premiere replique de la course suivante demarre immediatement.
    expect(speaker.feed(fact('LEADER_CHANGE', 0, 60))).not.toBeNull();
  });
});
