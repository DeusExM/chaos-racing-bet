import { CHARACTER_IDS } from '../src/core/characters';
import { GAME_CONFIG, RACE_CONFIG } from '../src/core/config';
import { RaceEngine } from '../src/core/engine';
import { MAX_PARTICIPANTS, MIN_PARTICIPANTS, selectParticipants } from '../src/core/participants';
import { computeRanks } from '../src/core/ranking';
import { normalizeSeed } from '../src/core/seed';
import type { CharacterId, RaceFact } from '../src/core/types';

/**
 * Audit statistique des courses de 3 à 6 coureurs — `npm run balance:participants`.
 *
 * ## Ce que cet outil fait, et ce qu'il ne fait pas
 *
 * Il **mesure** : pour chaque effectif (`3`, `4`, `5`, `6`) et sur un corpus de seeds, il relève qui
 * est sélectionné, qui gagne, combien de fois le leader change, combien d'événements et de surges
 * chaque personnage reçoit, et à quelle fréquence le leader tient d'une borne à l'autre. Il compare
 * ensuite ces mesures aux espérances **exactes** que la règle du jeu implique :
 *
 * * sélection d'un personnage : `N / 6` (un sous-ensemble uniforme) ;
 * * sous-ensemble donné : `1 / C(6, N)` ;
 * * victoire conditionnelle à la participation : `1 / N` ;
 * * classement : les six personnages sont **structurellement identiques** (aucun modificateur), donc
 *   aucun d'eux ne peut être favori.
 *
 * Il ne **change aucun paramètre**. Si une mesure s'écarte de son espérance, le rapport le dit et
 * s'arrête là : l'équilibrage d'un mode ne se « corrige » pas parce qu'il diffère du mode à six
 * coureurs — c'est une décision de design, et elle appartient au joueur, pas à l'outil.
 *
 * ## Pourquoi un outil, et pas un test
 *
 * Un test unitaire vérifie des **règles** sur un corpus court ; cet audit mesure des **fréquences**
 * sur un corpus long (2 000 courses × 4 effectifs par défaut, soit 8 000 courses complètes). Le
 * séparer garde la suite de tests rapide, tout en gardant la mesure reproductible et versionnée.
 */

/** Nombre de courses par effectif, par défaut : assez pour des parts stables au millième. */
export const DEFAULT_AUDIT_RACES = 2_000;

/** Corpus de reproductibilité : rejoué deux fois, comparé bit à bit. */
export const DEFAULT_REPRODUCIBILITY_RACES = 100;

export const DEFAULT_AUDIT_JSON = '.tmp/participants-audit.json';
export const DEFAULT_AUDIT_TEXT = '.tmp/participants-audit.txt';

/** Bornes de leadership mesurées, en secondes simulées : les deux checkpoints, puis l'arrivée. */
export const LEADER_BOUNDS_S: readonly number[] = Object.freeze([20, 40, 60]);

/**
 * Seuil du χ² à 5 % pour les degrés de liberté utilisés par cet audit.
 *
 * Les tests portent sur 6 catégories (5 ddl), sur les plateaux possibles (5, 14 ou 19 ddl) et sur un
 * plateau unique (1 ddl) : la table couvre `1..20`, donc **aucun** test de cet outil ne tombe sur une
 * entrée manquante. Une entrée manquante rendrait le test « non concluant » au lieu de « conforme »,
 * ce qui serait un silence trompeur — c'est pourquoi la table est complète et vérifiée par un test.
 */
const CHI2_AT_05: Readonly<Record<number, number>> = Object.freeze({
  1: 3.841,
  2: 5.991,
  3: 7.815,
  4: 9.488,
  5: 11.07,
  6: 12.592,
  7: 14.067,
  8: 15.507,
  9: 16.919,
  10: 18.307,
  11: 19.675,
  12: 21.026,
  13: 22.362,
  14: 23.685,
  15: 24.996,
  16: 26.296,
  17: 27.587,
  18: 28.869,
  19: 30.144,
  20: 31.41,
});

/** Une course auditée : tout ce qu'un effectif donné produit, ramené au **roster** (index `0..5`). */
export interface ParticipantsAuditRace {
  readonly seed: string;
  readonly players: number;
  /** Index de roster des partants, dans l'ordre canonique. */
  readonly participants: readonly number[];
  /** Index de roster du vainqueur. */
  readonly winner: number;
  /** Index de roster du leader à chaque borne (`null` si la borne n'a pas été observée). */
  readonly leaders: readonly (number | null)[];
  /** Changements **bruts** du porteur du rang 1. */
  readonly leaderChanges: number;
  /** Événements reçus par personnage, indexés par index de roster (`0` pour un non-partant). */
  readonly events: readonly number[];
  /** Surges démarrés par personnage, indexés par index de roster (`0` pour un non-partant). */
  readonly surges: readonly number[];
  /** Distances finales des partants, dans l'ordre canonique : sert au contrôle de reproductibilité. */
  readonly distances: readonly number[];
  /** Le suivi pas à pas et le classement officiel désignent-ils le même leader aux trois bornes ? */
  readonly leaderConsistent: boolean;
  readonly steps: number;
  readonly tSim: number;
}

/** Clé stable d'un sous-ensemble de partants, dans l'ordre canonique : `c0,c2,c5`. */
export function subsetKey(participants: readonly number[]): string {
  return participants.map((index) => CHARACTER_IDS[index] ?? `?${String(index)}`).join(',');
}

/** Index de roster du porteur du rang 1 (égalité départagée par index croissant). */
function leaderIndexFrom(
  characters: readonly { readonly id: CharacterId; readonly x: number }[],
  slotOf: ReadonlyMap<CharacterId, number>,
): number {
  let leaderIndex = 0;
  let leaderX = Number.NEGATIVE_INFINITY;
  for (const character of characters) {
    if (character.x > leaderX) {
      leaderX = character.x;
      leaderIndex = slotOf.get(character.id) ?? 0;
    }
  }
  return leaderIndex;
}

/**
 * Joue **une** course complète d'un effectif et relève toutes les mesures de l'audit.
 *
 * Le suivi du leader pas à pas est vérifié contre le classement officiel du noyau : si les deux
 * divergeaient, `leaderConsistent` passerait à `false` et le rapport le dirait au lieu de publier un
 * chiffre douteux.
 */
export function auditParticipantsRace(seed: string, players: number): ParticipantsAuditRace {
  const engine = new RaceEngine(seed, GAME_CONFIG, { players });
  const participants = engine.participantIds.map((id) => CHARACTER_IDS.indexOf(id));
  const slotOf = new Map<CharacterId, number>(CHARACTER_IDS.map((id, index) => [id, index]));

  const leaders: (number | null)[] = LEADER_BOUNDS_S.map(() => null);
  const events = new Array<number>(CHARACTER_IDS.length).fill(0);
  const surges = new Array<number>(CHARACTER_IDS.length).fill(0);
  const countedSurge = new Array<number>(CHARACTER_IDS.length).fill(0);
  const facts: RaceFact[] = [];

  let leaderConsistent = true;
  let leaderChanges = 0;
  let previousLeader = leaderIndexFrom(engine.getState().characters, slotOf);
  const xs = new Array<number>(CHARACTER_IDS.length).fill(0);

  while (engine.getState().phase.kind !== 'finished') {
    engine.step();
    const state = engine.getState();

    facts.push(...engine.drainFacts());

    if (state.characters.length !== players) {
      // Le plateau d'une course ne change jamais en cours de route : s'il changeait, l'audit le dirait
      // au lieu de publier des parts calculées sur un effectif flottant.
      leaderConsistent = false;
    }

    for (const character of state.characters) {
      const index = slotOf.get(character.id) ?? 0;
      xs[index] = character.x;
      // Un surge est republié à chaque pas tant qu'il dure : on ne compte qu'un **démarrage**, sinon
      // on mesurerait une durée et non un nombre de surges.
      const surge = character.surge;
      if (surge !== (countedSurge[index] ?? 0)) {
        countedSurge[index] = surge;
        if (surge !== 0) {
          surges[index] = (surges[index] ?? 0) + 1;
        }
      }
    }

    const leaderIndex = leaderIndexFrom(state.characters, slotOf);
    if (leaderIndex !== previousLeader) {
      leaderChanges += 1;
    }
    previousLeader = leaderIndex;

    for (const [boundIndex, boundS] of LEADER_BOUNDS_S.entries()) {
      if (leaders[boundIndex] !== null || state.tSim < boundS) {
        continue;
      }
      leaders[boundIndex] = leaderIndex;
      // Contrôle indépendant : le classement officiel du noyau doit désigner le même leader.
      if (computeRanks(xs, CHARACTER_IDS).indexOf(1) !== leaderIndex) {
        leaderConsistent = false;
      }
    }
  }

  for (const fact of facts) {
    if (fact.type !== 'BIG_BONUS' && fact.type !== 'LEADER_MALUS') {
      continue;
    }
    const target = fact.characterIds[0];
    if (target === undefined) {
      continue;
    }
    const index = slotOf.get(target) ?? 0;
    events[index] = (events[index] ?? 0) + 1;
  }

  const state = engine.getState();
  const winnerIndex = leaderIndexFrom(state.characters, slotOf);
  if (leaders[LEADER_BOUNDS_S.length - 1] !== winnerIndex) {
    // L'arrivée **est** la troisième borne : le leader à 60 s et le vainqueur ne peuvent pas diverger.
    leaderConsistent = false;
  }

  return Object.freeze({
    seed,
    players,
    participants: Object.freeze([...participants]),
    winner: winnerIndex,
    leaders: Object.freeze([...leaders]),
    leaderChanges,
    events: Object.freeze([...events]),
    surges: Object.freeze([...surges]),
    distances: Object.freeze(state.characters.map((character) => character.x)),
    leaderConsistent,
    steps: state.steps,
    tSim: state.tSim,
  });
}

/** Une part observée, avec son écart à l'espérance et sa contribution au χ². */
export interface ShareRow {
  readonly label: string;
  readonly count: number;
  /**
   * Base de la ligne : le nombre de courses **où la ligne pouvait se produire**.
   *
   * Ce n'est pas toujours le nombre de courses du corpus — pour un taux de victoire **conditionnel à
   * la participation**, la base d'un personnage est le nombre de courses où il court réellement. Une
   * base par ligne est donc indispensable : diviser par le total du corpus donnerait un taux faux.
   */
  readonly base: number;
  /** Espérance exacte, en nombre d'occurrences (`base × expectedShare`). */
  readonly expected: number;
  /** Taux observé : `count / base`. */
  readonly share: number;
  /** Taux attendu (0 à 1). */
  readonly expectedShare: number;
  readonly deviation: number;
}

/** Résultat d'un test d'uniformité. */
export interface UniformityTest {
  readonly name: string;
  readonly chiSquare: number;
  readonly degreesOfFreedom: number;
  /** Seuil du χ² à 5 % pour ces degrés de liberté, ou `null` si la table ne le couvre pas. */
  readonly threshold: number | null;
  /** Vrai quand le χ² reste sous le seuil : aucune anomalie détectée. */
  readonly uniform: boolean;
  readonly rows: readonly ShareRow[];
}

/**
 * Construit les lignes d'un test d'uniformité à partir de comptes observés et de leurs **bases**.
 *
 * Chaque ligne a sa propre base (voir `ShareRow.base`) et une espérance `base × expectedShare` : le
 * χ² est donc celui d'un test d'adéquation classique, où chaque catégorie a sa propre espérance.
 */
export function uniformityTest(
  name: string,
  labels: readonly string[],
  counts: readonly number[],
  bases: readonly number[],
  expectedShare: number,
): UniformityTest {
  const rows: ShareRow[] = labels.map((label, index) => {
    const count = counts[index] ?? 0;
    const base = bases[index] ?? 0;
    const expected = base * expectedShare;
    return Object.freeze({
      label,
      count,
      base,
      expected,
      share: base === 0 ? 0 : count / base,
      expectedShare,
      deviation: base === 0 ? 0 : count / base - expectedShare,
    });
  });

  let chiSquare = 0;
  for (const row of rows) {
    if (row.expected <= 0) {
      continue;
    }
    chiSquare += ((row.count - row.expected) * (row.count - row.expected)) / row.expected;
  }

  const degreesOfFreedom = Math.max(1, labels.length - 1);
  const threshold = CHI2_AT_05[degreesOfFreedom] ?? null;

  return Object.freeze({
    name,
    chiSquare,
    degreesOfFreedom,
    threshold,
    uniform: threshold === null ? true : chiSquare <= threshold,
    rows: Object.freeze(rows),
  });
}

/** Persistance du leader d'une borne à l'autre, sur un corpus. */
export interface PersistenceRow {
  readonly fromS: number;
  readonly toS: number;
  /** Nombre de courses où le leader est le même aux deux bornes. */
  readonly kept: number;
  readonly share: number;
}

/** Synthèse d'un effectif : tout ce que le rapport publie pour lui. */
export interface ParticipantsAuditSummary {
  readonly players: number;
  readonly races: number;
  readonly selection: UniformityTest;
  readonly subsets: UniformityTest;
  readonly wins: UniformityTest;
  readonly meanLeaderChanges: number;
  readonly eventsPerRace: number;
  readonly eventsPerCharacter: readonly number[];
  readonly surgesPerCharacter: readonly number[];
  readonly persistence: readonly PersistenceRow[];
  readonly distinctRaces: number;
  readonly leaderConsistent: boolean;
  /** Vrai si la reproductibilité bit à bit a été vérifiée sur ce corpus. */
  readonly reproducible: boolean;
}

/** Toutes les combinaisons de `k` index parmi `n`, dans l'ordre lexicographique. */
export function combinations(n: number, k: number): readonly (readonly number[])[] {
  const result: number[][] = [];
  const current: number[] = [];

  const walk = (start: number): void => {
    if (current.length === k) {
      result.push([...current]);
      return;
    }
    for (let index = start; index < n; index += 1) {
      current.push(index);
      walk(index + 1);
      current.pop();
    }
  };

  walk(0);
  return Object.freeze(result.map((entry) => Object.freeze(entry)));
}

/** Agrège un corpus déjà audité pour un effectif. */
export function summarizeParticipantsAudit(
  races: readonly ParticipantsAuditRace[],
  reproducible: boolean,
): ParticipantsAuditSummary {
  if (races.length === 0) {
    throw new RangeError('summarizeParticipantsAudit : corpus vide.');
  }
  const players = races[0]?.players ?? MIN_PARTICIPANTS;
  const total = races.length;

  const selectionCounts = new Array<number>(CHARACTER_IDS.length).fill(0);
  const winCounts = new Array<number>(CHARACTER_IDS.length).fill(0);
  const participationCounts = new Array<number>(CHARACTER_IDS.length).fill(0);
  const eventTotals = new Array<number>(CHARACTER_IDS.length).fill(0);
  const surgeTotals = new Array<number>(CHARACTER_IDS.length).fill(0);
  const subsetCounts = new Map<string, number>();
  const signatures = new Set<string>();

  let leaderChanges = 0;
  let eventsTotal = 0;
  let leaderConsistent = true;
  const persistenceKept = new Map<string, number>();

  for (const race of races) {
    for (const index of race.participants) {
      selectionCounts[index] = (selectionCounts[index] ?? 0) + 1;
      participationCounts[index] = (participationCounts[index] ?? 0) + 1;
      eventTotals[index] = (eventTotals[index] ?? 0) + (race.events[index] ?? 0);
      surgeTotals[index] = (surgeTotals[index] ?? 0) + (race.surges[index] ?? 0);
    }
    winCounts[race.winner] = (winCounts[race.winner] ?? 0) + 1;
    leaderChanges += race.leaderChanges;
    eventsTotal += race.events.reduce((sum, value) => sum + value, 0);
    leaderConsistent = leaderConsistent && race.leaderConsistent;

    const key = subsetKey(race.participants);
    subsetCounts.set(key, (subsetCounts.get(key) ?? 0) + 1);
    signatures.add(race.distances.map((distance) => distance.toFixed(9)).join('|'));

    for (let from = 0; from < LEADER_BOUNDS_S.length; from += 1) {
      for (let to = from + 1; to < LEADER_BOUNDS_S.length; to += 1) {
        const id = `${String(LEADER_BOUNDS_S[from])}→${String(LEADER_BOUNDS_S[to])}`;
        const same = race.leaders[from] !== null && race.leaders[from] === race.leaders[to];
        persistenceKept.set(id, (persistenceKept.get(id) ?? 0) + (same ? 1 : 0));
      }
    }
  }

  const allSubsets = combinations(CHARACTER_IDS.length, players);
  const subsetLabels = allSubsets.map((subset) => subsetKey(subset));
  const subsetObserved = subsetLabels.map((label) => subsetCounts.get(label) ?? 0);
  const raceBases = new Array<number>(CHARACTER_IDS.length).fill(total);
  const subsetBases = subsetLabels.map(() => total);

  const persistence: PersistenceRow[] = [];
  for (let from = 0; from < LEADER_BOUNDS_S.length; from += 1) {
    for (let to = from + 1; to < LEADER_BOUNDS_S.length; to += 1) {
      const id = `${String(LEADER_BOUNDS_S[from])}→${String(LEADER_BOUNDS_S[to])}`;
      const kept = persistenceKept.get(id) ?? 0;
      persistence.push(
        Object.freeze({
          fromS: LEADER_BOUNDS_S[from] ?? 0,
          toS: LEADER_BOUNDS_S[to] ?? 0,
          kept,
          share: kept / total,
        }),
      );
    }
  }

  return Object.freeze({
    players,
    races: total,
    // Un personnage est sélectionné avec la probabilité `N / 6` : c'est l'espérance d'un sous-ensemble
    // uniforme, et c'est ce que cette ligne mesure.
    selection: uniformityTest(
      'sélection par personnage',
      [...CHARACTER_IDS],
      selectionCounts,
      raceBases,
      players / CHARACTER_IDS.length,
    ),
    subsets: uniformityTest(
      'sous-ensembles',
      subsetLabels,
      subsetObserved,
      subsetBases,
      1 / allSubsets.length,
    ),
    // Taux de victoire **conditionnel à la participation** : la base d'un personnage est le nombre de
    // courses où il court, pas le nombre de courses du corpus. Diviser par le total donnerait un taux
    // faux — et c'est précisément l'erreur que cette ligne évite.
    wins: uniformityTest(
      'victoires conditionnelles',
      [...CHARACTER_IDS],
      winCounts,
      participationCounts,
      1 / players,
    ),
    meanLeaderChanges: leaderChanges / total,
    eventsPerRace: eventsTotal / total,
    eventsPerCharacter: Object.freeze(
      eventTotals.map((value, index) => value / Math.max(1, participationCounts[index] ?? 0)),
    ),
    surgesPerCharacter: Object.freeze(
      surgeTotals.map((value, index) => value / Math.max(1, participationCounts[index] ?? 0)),
    ),
    persistence: Object.freeze(persistence),
    distinctRaces: signatures.size,
    leaderConsistent,
    reproducible,
  });
}

/** Options de campagne. */
export interface ParticipantsAuditOptions {
  readonly onRace?: (players: number, index: number, total: number) => void;
}

/** Corpus d'audit complet : `races` courses par effectif, plus la reproductibilité. */
export interface ParticipantsAuditReport {
  readonly racesPerCount: number;
  readonly summaries: readonly ParticipantsAuditSummary[];
  readonly reproducible: boolean;
  readonly elapsedMs: number;
}

/** Seeds canoniques déterministes : distinctes, stables d'une exécution à l'autre. */
export function canonicalSeeds(count: number): readonly string[] {
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

/** Joue le corpus complet : chaque effectif, puis la reproductibilité. */
export function runParticipantsAudit(
  racesPerCount: number = DEFAULT_AUDIT_RACES,
  options: ParticipantsAuditOptions = {},
): ParticipantsAuditReport {
  if (!Number.isInteger(racesPerCount) || racesPerCount < 10) {
    throw new RangeError(`Nombre de courses invalide : ${String(racesPerCount)}.`);
  }

  const started = Date.now();
  const seeds = canonicalSeeds(racesPerCount);
  const summaries: ParticipantsAuditSummary[] = [];

  // Reproductibilité : chaque effectif est rejoué deux fois sur un sous-corpus, et les distances sont
  // comparées **bit à bit** — la même seed doit produire exactement la même course.
  const reproducibilitySeeds = seeds.slice(0, Math.min(DEFAULT_REPRODUCIBILITY_RACES, seeds.length));
  let reproducible = true;

  for (let players = MIN_PARTICIPANTS; players <= MAX_PARTICIPANTS; players += 1) {
    const races: ParticipantsAuditRace[] = [];
    for (const [index, seed] of seeds.entries()) {
      races.push(auditParticipantsRace(seed, players));
      options.onRace?.(players, index + 1, seeds.length);
    }

    for (const seed of reproducibilitySeeds) {
      const first = auditParticipantsRace(seed, players);
      const second = auditParticipantsRace(seed, players);
      if (first.distances.length !== second.distances.length) {
        reproducible = false;
        continue;
      }
      for (const [index, distance] of first.distances.entries()) {
        if (!Object.is(distance, second.distances[index])) {
          reproducible = false;
        }
      }
      if (first.participants.join(',') !== second.participants.join(',')) {
        reproducible = false;
      }
    }

    summaries.push(summarizeParticipantsAudit(races, reproducible));
  }

  return Object.freeze({
    racesPerCount,
    summaries: Object.freeze(summaries),
    reproducible,
    elapsedMs: Date.now() - started,
  });
}

/** Nombre de combinaisons `C(6, N)` : la taille de l'espace des plateaux possibles. */
export function subsetSpaceSize(players: number): number {
  return combinations(CHARACTER_IDS.length, players).length;
}

/** Nombre total de pas simulés du corpus : sert de contrôle de volume dans le rapport. */
export function totalSteps(report: ParticipantsAuditReport): number {
  return report.racesPerCount * (MAX_PARTICIPANTS - MIN_PARTICIPANTS + 1) * RACE_CONFIG.TOTAL_STEPS;
}

/** Vérifie qu'une seed donnée produit bien le plateau attendu (contrôle ponctuel du rapport). */
export function participantsOf(seed: string, players: number): readonly CharacterId[] {
  return selectParticipants(normalizeSeed(seed), players);
}

// -------------------------------------------------------------------------------------------
// Rapport
// -------------------------------------------------------------------------------------------

/** Formate un nombre avec une virgule décimale, comme les rapports du projet. */
function decimal(value: number, digits = 2): string {
  return value.toFixed(digits).replace('.', ',');
}

/** Formate une part en pourcentage. */
function percent(value: number): string {
  return `${decimal(value * 100, 2)} %`;
}

/** Lignes d'un test d'uniformité. La base de chaque ligne est affichée : un taux sans sa base ne veut rien dire. */
function uniformityLines(test: UniformityTest): readonly string[] {
  const lines: string[] = [
    `${test.name} : χ² = ${decimal(test.chiSquare)} pour ${String(test.degreesOfFreedom)} ddl ` +
      `(seuil 5 % : ${test.threshold === null ? 'n/a' : decimal(test.threshold)}) → ` +
      `${test.uniform ? 'conforme' : 'À EXAMINER'}`,
  ];
  for (const row of test.rows) {
    lines.push(
      `    ${row.label.padEnd(14)} ${String(row.count).padStart(7)} / ${String(row.base).padStart(6)} ` +
        `attendu ${decimal(row.expected, 1).padStart(8)} · taux ${percent(row.share)} ` +
        `(attendu ${percent(row.expectedShare)}, écart ${percent(row.deviation)})`,
    );
  }
  return lines;
}

/** Rapport texte compact, destiné à l'humain. */
export function renderParticipantsAuditText(report: ParticipantsAuditReport): string {
  const lines: string[] = [
    'AUDIT — COURSES DE 3 À 6 COUREURS',
    '',
    `Corpus : ${String(report.racesPerCount)} seeds par effectif (${String(report.racesPerCount * 4)} courses, ` +
      `${String(totalSteps(report))} pas simulés) en ${decimal(report.elapsedMs / 1000, 1)} s.`,
    'Aucun paramètre de jeu n’a été modifié pour produire ce rapport.',
    '',
  ];

  for (const summary of report.summaries) {
    lines.push(`── ${String(summary.players)} coureurs ─────────────────────────────────────────────`);
    lines.push(
      `Courses : ${String(summary.races)} · courses distinctes : ${String(summary.distinctRaces)} ` +
        `· reproductibilité bit à bit : ${summary.reproducible ? 'OUI' : 'NON'} ` +
        `· classement cohérent : ${summary.leaderConsistent ? 'OUI' : 'NON'}`,
    );
    lines.push(
      `Plateaux possibles : ${String(subsetSpaceSize(summary.players))} · ` +
        `changements de leader : ${decimal(summary.meanLeaderChanges)} / course`,
    );
    lines.push(
      `Événements : ${decimal(summary.eventsPerRace)} / course · par personnage : ` +
        summary.eventsPerCharacter.map((value) => decimal(value)).join(' · '),
    );
    lines.push(
      `Surges par personnage : ${summary.surgesPerCharacter.map((value) => decimal(value)).join(' · ')}`,
    );
    lines.push(
      `Persistance du leader : ${summary.persistence
        .map((row) => `${String(row.fromS)}→${String(row.toS)} s ${percent(row.share)}`)
        .join(' · ')}`,
    );
    lines.push('');
    for (const line of uniformityLines(summary.selection)) {
      lines.push(line);
    }
    lines.push('');
    for (const line of uniformityLines(summary.wins)) {
      lines.push(line);
    }
    lines.push('');
    // Les sous-ensembles sont nombreux : on ne détaille que l'écart le plus fort, et on résume.
    const subsetTest = summary.subsets;
    const worst = [...subsetTest.rows].sort(
      (left, right) => Math.abs(right.deviation) - Math.abs(left.deviation),
    )[0];
    if (subsetTest.rows.length === 1) {
      // À six coureurs, il n'existe qu'un plateau : le roster complet. Il n'y a donc rien à tester.
      lines.push('Sous-ensembles : un seul plateau possible (le roster complet) — sans objet à six.');
    } else {
      lines.push(
        `Sous-ensembles : ${String(subsetTest.rows.length)} plateaux possibles, χ² = ${decimal(subsetTest.chiSquare)} ` +
          `pour ${String(subsetTest.degreesOfFreedom)} ddl ` +
          `(seuil 5 % : ${subsetTest.threshold === null ? 'n/a' : decimal(subsetTest.threshold)}) → ` +
          `${subsetTest.uniform ? 'conforme' : 'À EXAMINER'}`,
      );
      if (worst !== undefined) {
        lines.push(
          `    écart le plus fort : ${worst.label} ${String(worst.count)} occurrences ` +
            `(taux ${percent(worst.share)}, attendu ${percent(worst.expectedShare)})`,
        );
      }
    }
    lines.push('');
  }

  lines.push('── Conclusion ───────────────────────────────────────────────────');
  lines.push(...conclusionLines(report));
  return lines.join('\n');
}

/**
 * Conclusion de l'audit : elle **constate**, elle ne corrige rien.
 *
 * Si une mesure s'écarte, le rapport le dit explicitement et rappelle que l'équilibrage d'un mode
 * réduit est une décision de design — jamais une retouche automatique de constantes.
 */
export function conclusionLines(report: ParticipantsAuditReport): readonly string[] {
  const lines: string[] = [];
  const anomalies: string[] = [];

  for (const summary of report.summaries) {
    const expectedWinShare = 1 / summary.players;
    const worstWin = [...summary.wins.rows].sort(
      (left, right) => Math.abs(right.deviation) - Math.abs(left.deviation),
    )[0];
    lines.push(
      `${String(summary.players)} coureurs : victoire attendue ${percent(expectedWinShare)} par partant ; ` +
        `écart le plus fort ${worstWin === undefined ? 'n/a' : `${worstWin.label} ${percent(worstWin.share)}`}.`,
    );
    if (!summary.wins.uniform || !summary.selection.uniform || !summary.subsets.uniform) {
      anomalies.push(`${String(summary.players)} coureurs`);
    }
    if (!summary.leaderConsistent || !summary.reproducible) {
      anomalies.push(`${String(summary.players)} coureurs (cohérence/reproductibilité)`);
    }
  }

  lines.push('');
  if (anomalies.length === 0) {
    lines.push('Aucune anomalie statistique détectée : toutes les mesures restent sous leur seuil à 5 %.');
    lines.push(
      'Rappel : les six personnages sont structurellement identiques, donc aucune part ne peut être ' +
        'favorisée par le moteur.',
    );
  } else {
    lines.push(`À EXAMINER : ${anomalies.join(', ')}.`);
    lines.push(
      'Aucun paramètre n’a été modifié : un écart se rapporte ici, il ne se corrige pas tout seul. ' +
        'Un mode réduit n’a pas à reproduire les chiffres du mode à six coureurs.',
    );
  }
  return Object.freeze(lines);
}

/** Rapport JSON structuré, destiné à la machine. */
export function buildParticipantsAuditJson(report: ParticipantsAuditReport): unknown {
  return {
    racesPerCount: report.racesPerCount,
    elapsedMs: report.elapsedMs,
    reproducible: report.reproducible,
    steps: totalSteps(report),
    summaries: report.summaries.map((summary) => ({
      players: summary.players,
      races: summary.races,
      distinctRaces: summary.distinctRaces,
      leaderConsistent: summary.leaderConsistent,
      reproducible: summary.reproducible,
      meanLeaderChanges: summary.meanLeaderChanges,
      eventsPerRace: summary.eventsPerRace,
      eventsPerCharacter: summary.eventsPerCharacter,
      surgesPerCharacter: summary.surgesPerCharacter,
      persistence: summary.persistence,
      selection: summary.selection,
      subsets: summary.subsets,
      wins: summary.wins,
    })),
    conclusion: conclusionLines(report),
  };
}

// -------------------------------------------------------------------------------------------
// Ligne de commande
// -------------------------------------------------------------------------------------------

export interface ParticipantsAuditCliOptions {
  readonly racesPerCount: number;
  readonly jsonPath: string;
  readonly textPath: string;
}

const AUDIT_HELP: readonly string[] = Object.freeze([
  'Audit statistique des courses de 3 à 6 coureurs.',
  '',
  'Usage : npm run balance:participants -- [options]',
  '',
  'Options :',
  `  --races=<n>     courses par effectif (défaut ${String(DEFAULT_AUDIT_RACES)})`,
  `  --json=<path>   rapport JSON (défaut ${DEFAULT_AUDIT_JSON})`,
  `  --text=<path>   rapport texte (défaut ${DEFAULT_AUDIT_TEXT})`,
  '  --help          affiche cette aide',
]);

/** Lit les arguments de la ligne de commande. Toute valeur illisible est refusée, jamais devinée. */
export function parseParticipantsAuditArgs(
  argv: readonly string[],
): ParticipantsAuditCliOptions | 'help' {
  let racesPerCount = DEFAULT_AUDIT_RACES;
  let jsonPath = DEFAULT_AUDIT_JSON;
  let textPath = DEFAULT_AUDIT_TEXT;

  for (const argument of argv) {
    if (argument === '--help' || argument === '-h') {
      return 'help';
    }
    if (argument.startsWith('--races=')) {
      const value = Number(argument.slice('--races='.length));
      if (!Number.isInteger(value) || value < 10) {
        throw new RangeError(`--races attend un entier ≥ 10 (reçu : « ${argument} »).`);
      }
      racesPerCount = value;
      continue;
    }
    if (argument.startsWith('--json=')) {
      jsonPath = argument.slice('--json='.length);
      continue;
    }
    if (argument.startsWith('--text=')) {
      textPath = argument.slice('--text='.length);
      continue;
    }
    throw new RangeError(`Argument inconnu : « ${argument} ».`);
  }

  return Object.freeze({ racesPerCount, jsonPath, textPath });
}

/** Résultat d'un lancement en ligne de commande. */
export interface ParticipantsAuditCliResult {
  readonly report: unknown;
  readonly text: string;
  readonly jsonPath: string;
  readonly textPath: string;
  readonly exitCode: number;
}

/** Lance l'audit et prépare les deux rapports. */
export function runParticipantsAuditWithReport(
  argv: readonly string[],
): ParticipantsAuditCliResult {
  const options = parseParticipantsAuditArgs(argv);
  if (options === 'help') {
    return Object.freeze({
      report: { help: AUDIT_HELP },
      text: AUDIT_HELP.join('\n'),
      jsonPath: '',
      textPath: '',
      exitCode: 0,
    });
  }

  const report = runParticipantsAudit(options.racesPerCount, {
    onRace: (players, index, total) => {
      if (index % 500 === 0 || index === total) {
        console.log(`  ${String(players)} coureurs : ${String(index)}/${String(total)} courses`);
      }
    },
  });

  const anomalies = report.summaries.some(
    (summary) => !summary.leaderConsistent || !summary.reproducible,
  );

  return Object.freeze({
    report: buildParticipantsAuditJson(report),
    text: renderParticipantsAuditText(report),
    jsonPath: options.jsonPath,
    textPath: options.textPath,
    exitCode: anomalies ? 1 : 0,
  });
}
