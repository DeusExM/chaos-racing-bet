/**
 * Tests de l'audit des courses de 3 à 6 coureurs (`tools/participantsAudit.ts`).
 *
 * ## Ce que ce fichier teste, et pourquoi il est **court**
 *
 * Le corpus complet (2 000 courses par effectif) est mesuré par `npm run balance:participants` : une
 * suite unitaire ne peut pas le rejouer. Ce fichier vérifie donc ce qui est vérifiable vite et sans
 * ambiguïté :
 *
 * 1. une course réelle auditée à trois, quatre, cinq et six partants rend des mesures **cohérentes**
 *    avec le noyau (plateau, vainqueur, `3600` pas, `60 s`, classement officiel) ;
 * 2. les **maths statistiques** sont justes, sur des corpus construits à la main — χ², parts,
 *    persistance du leader — donc sans aucune variabilité d'échantillonnage ;
 * 3. les **énumérations** sont exactes : `C(6, N)` plateaux possibles, clés canoniques ;
 * 4. la **conclusion** ne signale une anomalie que sur une anomalie réelle, et la ligne de commande
 *    refuse un argument illisible au lieu de le deviner.
 *
 * Aucune assertion ne porte sur une part mesurée à petit N : ces valeurs appartiennent au rapport du
 * corpus complet, pas à un test qui deviendrait instable (`AGENTS.md` §2).
 */

import { describe, expect, it } from 'vitest';

import { CHARACTER_IDS } from '../../src/core/characters';
import { RACE_CONFIG } from '../../src/core/config';
import { MAX_PARTICIPANTS, MIN_PARTICIPANTS } from '../../src/core/participants';
import {
  DEFAULT_AUDIT_JSON,
  DEFAULT_AUDIT_TEXT,
  LEADER_BOUNDS_S,
  auditParticipantsRace,
  buildParticipantsAuditJson,
  combinations,
  conclusionLines,
  parseParticipantsAuditArgs,
  renderParticipantsAuditText,
  subsetKey,
  subsetSpaceSize,
  summarizeParticipantsAudit,
  totalSteps,
  uniformityTest,
  type ParticipantsAuditRace,
  type ParticipantsAuditReport,
} from '../../tools/participantsAudit';

/** Course synthétique : un plateau donné, un vainqueur donné, tout le reste neutre. */
function syntheticRace(
  seed: string,
  participants: readonly number[],
  winner: number,
  options: {
    readonly leaderChanges?: number;
    readonly events?: readonly number[];
    /** Rend les distances distinctes d'une course à l'autre (contrôle « courses distinctes »). */
    readonly nonce?: number;
  } = {},
): ParticipantsAuditRace {
  const events = new Array<number>(CHARACTER_IDS.length).fill(0);
  for (const [index, value] of (options.events ?? []).entries()) {
    events[index] = value;
  }
  return {
    seed,
    players: participants.length,
    participants,
    winner,
    leaders: [winner, winner, winner],
    leaderChanges: options.leaderChanges ?? 0,
    events,
    surges: new Array<number>(CHARACTER_IDS.length).fill(0),
    distances: participants.map((_index, slot) => 1_000 - slot + (options.nonce ?? 0)),
    leaderConsistent: true,
    steps: RACE_CONFIG.TOTAL_STEPS,
    tSim: RACE_CONFIG.TOTAL_SIM_S,
  };
}

describe('audit d’une course réelle', () => {
  it('mesure le plateau, le vainqueur et la fin de course à chaque effectif', () => {
    for (let players = MIN_PARTICIPANTS; players <= MAX_PARTICIPANTS; players += 1) {
      const race = auditParticipantsRace('K7QM2X9A', players);

      expect(race.players).toBe(players);
      expect(race.participants).toHaveLength(players);
      expect(new Set(race.participants).size).toBe(players);
      expect(race.steps).toBe(RACE_CONFIG.TOTAL_STEPS);
      expect(race.tSim).toBe(RACE_CONFIG.TOTAL_SIM_S);
      expect(race.distances).toHaveLength(players);
      // Le suivi pas à pas doit concorder avec le classement officiel : sinon l'audit le dirait.
      expect(race.leaderConsistent).toBe(true);
      // Le vainqueur est un partant, et le leader à l'arrivée est le vainqueur.
      expect(race.participants).toContain(race.winner);
      expect(race.leaders[LEADER_BOUNDS_S.length - 1]).toBe(race.winner);
      // Aucun événement ni surge ne peut être attribué à un non-partant.
      for (let index = 0; index < CHARACTER_IDS.length; index += 1) {
        if (race.participants.includes(index)) {
          continue;
        }
        expect(race.events[index]).toBe(0);
        expect(race.surges[index]).toBe(0);
      }
    }
  });

  it('donne le même plateau que la règle de sélection, seed et effectif égaux', () => {
    for (let players = MIN_PARTICIPANTS; players <= MAX_PARTICIPANTS; players += 1) {
      const first = auditParticipantsRace('K7QM2X9A', players);
      const second = auditParticipantsRace('K7QM2X9A', players);
      expect(first.participants).toEqual(second.participants);
      expect(first.distances).toEqual(second.distances);
    }
  });
});

describe('énumération des plateaux', () => {
  it('compte exactement les combinaisons du roster', () => {
    expect(subsetSpaceSize(3)).toBe(20);
    expect(subsetSpaceSize(4)).toBe(15);
    expect(subsetSpaceSize(5)).toBe(6);
    expect(subsetSpaceSize(6)).toBe(1);
  });

  it('produit des clés canoniques, dans l’ordre du roster', () => {
    expect(subsetKey([0, 2, 5])).toBe('c0,c2,c5');
    expect(subsetKey([])).toBe('');
    for (const subset of combinations(CHARACTER_IDS.length, 3)) {
      const positions = [...subset];
      expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    }
  });
});

describe('maths statistiques', () => {
  it('calcule un χ² nul sur une distribution exactement uniforme', () => {
    const test = uniformityTest('parts', ['a', 'b', 'c'], [10, 10, 10], [30, 30, 30], 1 / 3);
    expect(test.chiSquare).toBe(0);
    expect(test.uniform).toBe(true);
    expect(test.rows.map((row) => row.share)).toEqual([1 / 3, 1 / 3, 1 / 3]);
  });

  it('détecte une distribution franchement biaisée', () => {
    const test = uniformityTest('parts', ['a', 'b'], [100, 0], [100, 100], 0.5);
    // (100 − 50)² / 50 + (0 − 50)² / 50 = 100.
    expect(test.chiSquare).toBe(100);
    expect(test.uniform).toBe(false);
    expect(test.rows[1]?.deviation).toBeCloseTo(-0.5, 10);
  });

  it('utilise la base propre à chaque ligne, jamais un total commun', () => {
    // Deux personnages, deux bases différentes : 10/20 = 50 % et 10/40 = 25 %. Un total commun
    // afficherait 25 % pour les deux — c'est exactement l'erreur que ce test interdit.
    const test = uniformityTest('taux', ['a', 'b'], [10, 10], [20, 40], 0.5);
    expect(test.rows[0]?.share).toBeCloseTo(0.5, 10);
    expect(test.rows[1]?.share).toBeCloseTo(0.25, 10);
    expect(test.rows[1]?.expected).toBeCloseTo(20, 10);
    // χ² = 0 + (10 − 20)² / 20 = 5.
    expect(test.chiSquare).toBeCloseTo(5, 10);
  });

  it('couvre tous les degrés de liberté que l’audit peut produire', () => {
    // Une entrée manquante rendrait un test « non concluant » au lieu de « conforme » : la table doit
    // donc couvrir les 5 ddl des six personnages et les 5/14/19 ddl des plateaux possibles.
    for (const labels of [2, 6, 7, 15, 20]) {
      const test = uniformityTest(
        'couverture',
        Array.from({ length: labels }, (_value, index) => `l${String(index)}`),
        new Array<number>(labels).fill(1),
        new Array<number>(labels).fill(labels),
        1 / labels,
      );
      expect(test.threshold, `${String(labels - 1)} ddl`).not.toBeNull();
    }
  });

  it('ne conclut jamais à une anomalie quand il n’y a qu’une catégorie', () => {
    const test = uniformityTest('plateau unique', ['c0,c1,c2,c3,c4,c5'], [50], [50], 1);
    expect(test.chiSquare).toBe(0);
    expect(test.uniform).toBe(true);
  });
});

describe('synthèse d’un corpus', () => {
  it('agrège les parts de sélection, les victoires et les compteurs par personnage', () => {
    const races: ParticipantsAuditRace[] = [
      syntheticRace('A', [0, 1, 2], 0, { events: [2, 0, 0, 0, 0, 0], nonce: 0 }),
      syntheticRace('B', [0, 1, 2], 1, { events: [0, 3, 0, 0, 0, 0], nonce: 1 }),
      syntheticRace('C', [0, 1, 2], 0, { events: [0, 0, 1, 0, 0, 0], nonce: 2 }),
    ];
    const summary = summarizeParticipantsAudit(races, true);

    expect(summary.players).toBe(3);
    expect(summary.races).toBe(3);
    expect(summary.selection.rows[0]?.count).toBe(3);
    expect(summary.selection.rows[3]?.count).toBe(0);
    // Deux victoires pour c0, une pour c1 : c'est bien ce qui est publié…
    expect(summary.wins.rows[0]?.count).toBe(2);
    expect(summary.wins.rows[1]?.count).toBe(1);
    // …et le **taux** est conditionnel à la participation : c0 a couru trois fois et gagné deux fois.
    expect(summary.wins.rows[0]?.base).toBe(3);
    expect(summary.wins.rows[0]?.share).toBeCloseTo(2 / 3, 10);
    expect(summary.wins.rows[1]?.share).toBeCloseTo(1 / 3, 10);
    // Un personnage qui n'a jamais couru garde une base nulle : aucun taux inventé.
    expect(summary.wins.rows[3]?.base).toBe(0);
    expect(summary.wins.rows[3]?.share).toBe(0);
    // Moyennes par **participation** : c0 court trois fois et reçoit deux événements.
    expect(summary.eventsPerCharacter[0]).toBeCloseTo(2 / 3, 10);
    expect(summary.eventsPerCharacter[1]).toBeCloseTo(1, 10);
    expect(summary.eventsPerCharacter[2]).toBeCloseTo(1 / 3, 10);
    // Un non-partant ne reçoit rien : sa moyenne reste nulle, sans division par zéro.
    expect(summary.eventsPerCharacter[3]).toBe(0);
    expect(summary.distinctRaces).toBe(3);
    expect(summary.leaderConsistent).toBe(true);
    expect(summary.reproducible).toBe(true);
  });

  it('mesure la persistance du leader entre les bornes', () => {
    const steady = syntheticRace('A', [0, 1, 2], 0);
    const changed: ParticipantsAuditRace = {
      ...syntheticRace('B', [0, 1, 2], 1),
      leaders: [0, 1, 1],
    };
    const summary = summarizeParticipantsAudit([steady, changed], true);

    // 20 → 40 s : un seul des deux garde son leader ; 40 → 60 s : les deux.
    const early = summary.persistence.find((row) => row.fromS === 20 && row.toS === 40);
    const late = summary.persistence.find((row) => row.fromS === 40 && row.toS === 60);
    expect(early?.kept).toBe(1);
    expect(early?.share).toBe(0.5);
    expect(late?.kept).toBe(2);
    expect(late?.share).toBe(1);
  });

  it('signale un corpus incohérent sans jamais lever', () => {
    const broken: ParticipantsAuditRace = {
      ...syntheticRace('A', [0, 1, 2], 0),
      leaderConsistent: false,
    };
    const summary = summarizeParticipantsAudit([broken], false);
    expect(summary.leaderConsistent).toBe(false);
    expect(summary.reproducible).toBe(false);
  });

  it('refuse un corpus vide plutôt que de publier des parts inventées', () => {
    expect(() => summarizeParticipantsAudit([], true)).toThrow(RangeError);
  });
});

describe('rapport', () => {
  /**
   * Corpus **exactement uniforme** : chaque plateau possible de trois coureurs apparaît trois fois, et
   * dans chacun les trois membres gagnent une fois. Toutes les espérances sont donc atteintes au
   * chiffre près (χ² = 0 partout), ce qui permet de tester la conclusion « aucune anomalie » sans
   * dépendre d'un échantillon réel.
   */
  function uniformCorpus(): ParticipantsAuditRace[] {
    const races: ParticipantsAuditRace[] = [];
    let nonce = 0;
    for (const subset of combinations(CHARACTER_IDS.length, 3)) {
      for (let round = 0; round < 3; round += 1) {
        races.push(
          syntheticRace(`S${String(nonce)}`, subset, subset[round] ?? 0, { nonce }),
        );
        nonce += 1;
      }
    }
    return races;
  }

  /** Rapport minimal, construit à partir d'un corpus uniforme. */
  function report(): ParticipantsAuditReport {
    return {
      racesPerCount: uniformCorpus().length,
      summaries: [summarizeParticipantsAudit(uniformCorpus(), true)],
      reproducible: true,
      elapsedMs: 1_000,
    };
  }

  it('rend un rapport texte qui cite chaque mesure demandée', () => {
    const text = renderParticipantsAuditText(report());
    for (const expected of [
      'AUDIT — COURSES DE 3 À 6 COUREURS',
      'changements de leader',
      'Événements',
      'Surges par personnage',
      'Persistance du leader',
      'sélection par personnage',
      'victoires conditionnelles',
      'Sous-ensembles',
      'Conclusion',
    ]) {
      expect(text, `le rapport doit contenir « ${expected} »`).toContain(expected);
    }
  });

  it('rend un rapport JSON sérialisable, avec les mêmes mesures', () => {
    const json = buildParticipantsAuditJson(report());
    const text = JSON.stringify(json);
    expect(text).toContain('"players":3');
    expect(text).toContain('"meanLeaderChanges"');
    expect(text).toContain('"persistence"');
    expect(text).toContain('"base"');
    // Aucune valeur non finie ne peut se retrouver dans un rapport : `null` en JSON est un mensonge
    // silencieux, donc le test l'interdit explicitement.
    expect(text).not.toContain('null');
  });

  it('conclut à l’absence d’anomalie sur un corpus exactement uniforme', () => {
    const summary = report().summaries[0];
    // Le corpus est construit pour atteindre toutes les espérances : les χ² doivent être nuls.
    expect(summary?.selection.chiSquare).toBeCloseTo(0, 10);
    expect(summary?.wins.chiSquare).toBeCloseTo(0, 10);
    expect(summary?.subsets.chiSquare).toBeCloseTo(0, 10);
    const lines = conclusionLines(report());
    expect(lines.join('\n')).toContain('Aucune anomalie statistique détectée');
  });

  it('rappelle qu’un écart se rapporte et ne se corrige pas', () => {
    const races = [syntheticRace('A', [0, 1, 2], 0)];
    const broken: ParticipantsAuditReport = {
      racesPerCount: 1,
      summaries: [summarizeParticipantsAudit(races, false)],
      reproducible: false,
      elapsedMs: 1,
    };
    const lines = conclusionLines(broken).join('\n');
    expect(lines).toContain('À EXAMINER');
    expect(lines).toContain('Aucun paramètre n’a été modifié');
  });

  it('compte le volume de pas simulés du corpus', () => {
    const reportValue = report();
    expect(totalSteps(reportValue)).toBe(reportValue.racesPerCount * 4 * RACE_CONFIG.TOTAL_STEPS);
  });
});

describe('ligne de commande', () => {
  it('applique les valeurs par défaut', () => {
    expect(parseParticipantsAuditArgs([])).toEqual({
      racesPerCount: 2_000,
      jsonPath: DEFAULT_AUDIT_JSON,
      textPath: DEFAULT_AUDIT_TEXT,
    });
  });

  it('lit les options explicites', () => {
    expect(
      parseParticipantsAuditArgs(['--races=250', '--json=a.json', '--text=a.txt']),
    ).toEqual({ racesPerCount: 250, jsonPath: 'a.json', textPath: 'a.txt' });
  });

  it('affiche l’aide sur demande', () => {
    expect(parseParticipantsAuditArgs(['--help'])).toBe('help');
  });

  it('refuse un argument illisible au lieu de le deviner', () => {
    expect(() => parseParticipantsAuditArgs(['--races=abc'])).toThrow(RangeError);
    expect(() => parseParticipantsAuditArgs(['--races=0'])).toThrow(RangeError);
    expect(() => parseParticipantsAuditArgs(['--inconnu'])).toThrow(RangeError);
  });
});
