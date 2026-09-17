import { describe, expect, it } from 'vitest';

import { CHARACTERS } from '../../src/core/characters';
import type { CharacterId, RaceFact, RaceFactType } from '../../src/core/types';
import {
  SPEAKER_CATALOGUE_FR,
  SPEAKER_FACT_TYPES,
  SPEAKER_LINES_FR,
  characterNameFr,
} from '../../src/app/strings.fr';

/**
 * P009-C — véracité et structure des textes français du speaker.
 *
 * Ces tests ne figent **aucune** phrase : ils vérifient des propriétés. Une phrase peut donc être
 * réécrite librement, tant qu'elle reste dérivable du fait qui la produit.
 */

/** Fait conforme au contrat de `RaceFact`, fabriqué à la main. */
function fact(
  type: RaceFactType,
  magnitudes: readonly number[],
  characterIds: readonly CharacterId[] = CHARACTERS.map((character) => character.id),
): RaceFact {
  return Object.freeze({
    type,
    tSim: 12,
    characterIds: Object.freeze([...characterIds]),
    magnitudes: Object.freeze([...magnitudes]),
    importance: 50,
    textKey: `fact.${type}`,
  });
}

/**
 * Magnitudes **réalistes** par type, dans l'ordre exact documenté par `GAME_DESIGN.md` §9.2.
 *
 * Elles servent à produire une phrase représentative de chaque variante : un test qui ne
 * remplirait pas correctement un placeholder mesurerait la robustesse des erreurs, pas la véracité.
 */
const SAMPLE_MAGNITUDES: Readonly<Record<RaceFactType, readonly number[]>> = Object.freeze({
  LEADER_CHANGE: [3.24, 12.0],
  BIG_COMEBACK: [4, 2],
  OVERTAKE_STREAK: [5],
  BIG_BONUS: [1.35, 8, 1],
  // Magnitude **réellement négative** : c'est ce que publie P009-A (`CHUTE` : `-0.6`, `SIESTE` : `-0.7`).
  LEADER_MALUS: [-0.6, 3, 1],
  CLOSE_RACE: [8.42, 5.05],
  LAST_COMEBACK: [4, 3],
  CHECKPOINT_SPLIT: [812.4, 809.1, 804.6, 800.2, 798.9, 790.3],
  FINISH: [12.5, 2160.0, 2147.5],
  PHOTO_FINISH: [0.42, 2159.9, 2159.5],
});

function sampleFact(type: RaceFactType): RaceFact {
  return fact(type, SAMPLE_MAGNITUDES[type]);
}

/** Valeurs que la phrase a le droit d'écrire, **dérivées** du fait, jamais inventées. */
function derivableNumbers(source: RaceFact): Set<string> {
  const values: string[] = [String(source.tSim)];
  for (const magnitude of source.magnitudes) {
    // Une magnitude négative (malus) est présentée en valeur absolue : `Math.abs` est la seule
    // transformation autorisée, et elle est explicite des deux côtés — ici et dans le catalogue.
    const shown = Math.abs(magnitude);
    values.push(
      String(magnitude),
      magnitude.toFixed(1),
      String(Math.trunc(magnitude)),
      String(Math.floor(magnitude)),
      String(shown),
      shown.toFixed(1),
      String(Math.trunc(shown)),
      // Le pourcentage est la magnitude relative exprimée en pour cent.
      String(Math.round(shown * 100)),
    );
  }
  for (const id of source.characterIds) {
    values.push(characterNameFr(id));
  }
  // Indices de position du classement publiés par le fait (P1 → P6) : ce sont des repères
  // structurels, pas des mesures. Aucun n'est un chiffre inventé sur la course.
  for (let position = 1; position <= source.magnitudes.length; position += 1) {
    values.push(String(position));
  }
  return new Set(values.map((value) => value.replace('.', ',')));
}

/**
 * Nombres présents dans un texte, avec le mot qui les précède immédiatement.
 *
 * Le mot précédent sert à écarter les **noms** du roster : « Poulet 3000 » contient un nombre, mais
 * ce n'est pas une mesure commentée.
 */
function numbersIn(text: string): { value: string; precedingWord: string; raw: string }[] {
  const matches = [...text.matchAll(/([A-Za-zÀ-ÿ]+)?\s*(-?\d+(?:,\d+)?)/g)];
  return matches.map((match) => ({
    value: match[2] ?? '',
    precedingWord: match[1] ?? '',
    raw: match[0],
  }));
}

/**
 * Sources brutes, fournies par Vite : c'est le seul moyen de vérifier qu'un texte **n'existe pas**
 * ailleurs que dans le catalogue, sans dépendre d'une API de système de fichiers.
 */
const CATALOGUE_SOURCES = import.meta.glob<string>(
  ['/src/core/**/*.ts', '/src/speaker/**/*.ts', '/src/render/**/*.ts'],
  { query: '?raw', import: 'default', eager: true },
);

/** Origine de chaque phrase : `strings.fr.ts` est le seul fichier autorisé à en contenir. */
function catalogueLines(): readonly string[] {
  const lines: string[] = [];
  for (const type of SPEAKER_FACT_TYPES) {
    for (const formatter of SPEAKER_LINES_FR[type]) {
      lines.push(formatter(sampleFact(type)));
    }
  }
  return lines;
}

/** Chaînes littérales d'au moins 12 caractères, commentaires retirés : candidates au texte visible. */
function visibleStringLiterals(source: string): readonly string[] {
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  const literals = withoutComments.match(/'[^'\n]{12,}'|"[^"\n]{12,}"|`[^`]{12,}`/g) ?? [];
  return literals.map((literal) => literal.slice(1, -1));
}

describe('P009-C : étanchéité des textes', () => {
  it('garde toutes les variantes françaises dans strings.fr.ts', () => {
    const lines = catalogueLines();
    // 10 types × 3 variantes au minimum : le catalogue est réellement peuplé.
    expect(lines.length).toBeGreaterThanOrEqual(30);

    for (const [path, source] of Object.entries(CATALOGUE_SOURCES)) {
      for (const literal of visibleStringLiterals(source)) {
        for (const line of lines) {
          expect(
            literal.includes(line),
            `${path} contient une réplique du catalogue : « ${literal.slice(0, 40)}… »`,
          ).toBe(false);
        }
      }
    }
  });

  it('n’écrit aucun texte final de commentaire hors de app/', () => {
    // Seuil volontairement élevé : un fragment court (« vitesse », « leader ») apparaît légitimement
    // dans un message d'erreur ou une clé technique. Une réplique recopiée, elle, l'est en entier.
    const fragments = catalogueLines()
      .flatMap((line) => line.split(/[.!?:]/))
      .map((segment) => segment.trim())
      .filter((segment) => segment.length >= 30);

    const offenders: string[] = [];
    for (const [path, source] of Object.entries(CATALOGUE_SOURCES)) {
      for (const literal of visibleStringLiterals(source)) {
        for (const fragment of fragments) {
          if (literal.includes(fragment)) {
            offenders.push(`${path} → « ${literal.slice(0, 40)} » reprend « ${fragment.slice(0, 30)}… »`);
            break;
          }
        }
      }
    }
    expect(offenders, `textes en dur détectés :\n${offenders.join('\n')}`).toEqual([]);
  });
});

describe('P009-C : catalogue de textes', () => {
  it('couvre exactement les 10 types de faits, sans oubli ni doublon', () => {
    expect(Object.keys(SPEAKER_LINES_FR).sort()).toEqual([...SPEAKER_FACT_TYPES].sort());
    expect(SPEAKER_FACT_TYPES).toHaveLength(10);
  });

  it('propose entre 3 et 6 variantes par type, et jamais un tableau vide', () => {
    for (const type of SPEAKER_FACT_TYPES) {
      const variants = SPEAKER_LINES_FR[type];
      expect(variants.length, `${type} doit avoir au moins 3 variantes`).toBeGreaterThanOrEqual(3);
      expect(variants.length, `${type} doit avoir au plus 6 variantes`).toBeLessThanOrEqual(6);
      expect(variants.length, `${type} ne doit pas être vide`).toBeGreaterThan(0);
    }
  });

  it('produit une chaîne non vide pour chaque variante de chaque type', () => {
    for (const type of SPEAKER_FACT_TYPES) {
      const source = sampleFact(type);
      for (const [index, formatter] of SPEAKER_LINES_FR[type].entries()) {
        const line = formatter(source);
        expect(typeof line, `${type}[${index}]`).toBe('string');
        expect(line.trim().length, `${type}[${index}] ne doit pas être vide`).toBeGreaterThan(0);
      }
    }
  });

  it('ne laisse jamais un placeholder non résolu dans une phrase', () => {
    for (const type of SPEAKER_FACT_TYPES) {
      for (const formatter of SPEAKER_LINES_FR[type]) {
        expect(formatter(sampleFact(type))).not.toMatch(/[{}]/);
      }
    }
  });

  it('n’écrit que des valeurs dérivables du fait : aucun chiffre inventé', () => {
    const nameWithDigits = CHARACTERS.map((character) => character.name).filter((name) => /\d/.test(name));

    for (const type of SPEAKER_FACT_TYPES) {
      const source = sampleFact(type);
      const allowed = derivableNumbers(source);
      for (const formatter of SPEAKER_LINES_FR[type]) {
        const line = formatter(source);
        for (const { value, precedingWord, raw } of numbersIn(line)) {
          // Un nom du roster peut contenir un nombre (« Poulet 3000 ») : ce n'est pas une mesure.
          if (nameWithDigits.some((name) => raw.includes(name) || name.includes(`${precedingWord} ${value}`))) {
            continue;
          }
          // Le signe d'un écart négatif est une présentation : la valeur absolue doit venir du fait.
          const bare = value.startsWith('-') ? value.slice(1) : value;
          expect(
            allowed.has(bare),
            `« ${value} » (${type}) n'est pas dérivable de ${JSON.stringify(source.magnitudes)}`,
          ).toBe(true);
        }
      }
    }
  });

  it('utilise les magnitudes réelles : les valeurs mesurées apparaissent dans le texte', () => {
    const metresFact = fact('LEADER_CHANGE', [3.24, 12]);
    expect(SPEAKER_LINES_FR.LEADER_CHANGE[0]?.(metresFact)).toContain('3,2 m');
    expect(SPEAKER_LINES_FR.LEADER_CHANGE[4]?.(metresFact)).toContain('12,0');

    const bonusFact = fact('BIG_BONUS', [1.35, 8, 1]);
    expect(SPEAKER_LINES_FR.BIG_BONUS[0]?.(bonusFact)).toContain('135');
    expect(SPEAKER_LINES_FR.BIG_BONUS[0]?.(bonusFact)).toContain('8');

    const streakFact = fact('OVERTAKE_STREAK', [4]);
    expect(SPEAKER_LINES_FR.OVERTAKE_STREAK[0]?.(streakFact)).toContain('4');
  });

  it('exprime BIG_COMEBACK en places, jamais en mètres', () => {
    const source = fact('BIG_COMEBACK', [4, 2]);
    const lines = SPEAKER_LINES_FR.BIG_COMEBACK.map((formatter) => formatter(source));

    for (const line of lines) {
      expect(line, `« ${line} »`).toContain('4 places');
      expect(line, `« ${line} » ne doit pas parler de mètres`).not.toContain('4 m');
      // Aucune distance en mètres : le motif « unité m » est cherché, pas la lettre « m ».
      expect(line).not.toMatch(/\d\s?m\b/);
    }
    // Le rang courant est une position, pas une distance : il s'écrit en ordinal.
    expect(lines.some((line) => line.includes('2e'))).toBe(true);
  });

  it('exprime LAST_COMEBACK en places, avec un pluriel correct', () => {
    const source = fact('LAST_COMEBACK', [3, 3]);
    const lines = SPEAKER_LINES_FR.LAST_COMEBACK.map((formatter) => formatter(source));

    for (const line of lines) {
      expect(line, `« ${line} »`).not.toContain('3 m');
      expect(line).not.toMatch(/\d\s?m\b/);
    }
    expect(lines.filter((line) => line.includes('3 places')).length).toBeGreaterThanOrEqual(4);

    // Une seule place gagnée s'écrit au singulier.
    const single = SPEAKER_LINES_FR.LAST_COMEBACK.map((formatter) => formatter(fact('LAST_COMEBACK', [1, 2])));
    expect(single.some((line) => line.includes('1 place') && !line.includes('1 places'))).toBe(true);
  });

  it('affiche la pénalité du leader en pour cent positifs, sans double négation', () => {
    // Faits réels de P009-A : `CHUTE` puis `SIESTE`.
    const chute = fact('LEADER_MALUS', [-0.6, 4, 1]);
    const sieste = fact('LEADER_MALUS', [-0.7, 5, 1]);

    const chuteLines = SPEAKER_LINES_FR.LEADER_MALUS.map((formatter) => formatter(chute));
    const siesteLines = SPEAKER_LINES_FR.LEADER_MALUS.map((formatter) => formatter(sieste));

    for (const line of chuteLines) {
      expect(line, `« ${line} »`).toContain('60 % en moins');
      expect(line, `« ${line} » ne doit pas doubler la négation`).not.toContain('-60');
      expect(line).not.toContain('+-');
      expect(line).not.toContain('60 % de moins');
    }
    for (const line of siesteLines) {
      expect(line, `« ${line} »`).toContain('70 % en moins');
      expect(line).not.toContain('-70');
      expect(line).not.toContain('+-');
    }
  });

  it('écrit le premier rang « 1er », et les suivants en « e »', () => {
    const bonusRank1 = SPEAKER_LINES_FR.BIG_BONUS[4]?.(fact('BIG_BONUS', [1.35, 8, 1])) ?? '';
    expect(bonusRank1).toContain('1er rang');
    expect(bonusRank1).not.toContain('1re');
    expect(bonusRank1).not.toContain('1e ');
    expect(bonusRank1).not.toContain('100 %');

    const bonusRank2 = SPEAKER_LINES_FR.BIG_BONUS[4]?.(fact('BIG_BONUS', [1.35, 8, 2])) ?? '';
    expect(bonusRank2).toContain('2e rang');

    const comebackRank1 = SPEAKER_LINES_FR.BIG_COMEBACK[0]?.(fact('BIG_COMEBACK', [3, 1])) ?? '';
    expect(comebackRank1).toContain('1er');
    expect(comebackRank1).not.toContain('1re');
    expect(comebackRank1).not.toContain('1e ');

    // Aucun « 1re » ne doit subsister hors du féminin « 1re place ».
    for (const type of SPEAKER_FACT_TYPES) {
      const line = SPEAKER_LINES_FR[type][0]?.(sampleFact(type)) ?? '';
      expect(line, `« ${line} »`).not.toMatch(/1re(?!\s+place)/);
    }
  });

  it('accorde le féminin « 1re place » seulement là où « place » est écrit', () => {
    const first = fact('LAST_COMEBACK', [2, 1]);
    const line = SPEAKER_LINES_FR.LAST_COMEBACK[1]?.(first) ?? '';
    expect(line).toContain('1re place');

    const third = SPEAKER_LINES_FR.LAST_COMEBACK[1]?.(fact('LAST_COMEBACK', [2, 3])) ?? '';
    expect(third).toContain('3e place');
  });

  it('tronque les distances de pointage au mètre, sans jamais les surestimer', () => {
    const splitFact = fact('CHECKPOINT_SPLIT', [812.4, 809.1, 804.6, 800.2, 798.9, 790.3]);
    const line = SPEAKER_LINES_FR.CHECKPOINT_SPLIT[0]?.(splitFact) ?? '';
    expect(line).toContain('812 m');
    expect(line).toContain('809 m');
    expect(line).not.toContain('813');
  });

  it('n’utilise que des noms du roster officiel, tirés du fait lui-même', () => {
    const rosterNames = CHARACTERS.map((character) => character.name);
    const source = sampleFact('CHECKPOINT_SPLIT');

    for (const type of SPEAKER_FACT_TYPES) {
      for (const formatter of SPEAKER_LINES_FR[type]) {
        const line = formatter(sampleFact(type));
        for (const name of rosterNames) {
          if (!line.includes(name)) {
            continue;
          }
          expect(
            source.characterIds.some((id) => characterNameFr(id) === name),
            `« ${name} » ne vient pas des personnages du fait`,
          ).toBe(true);
        }
      }
    }

    for (const character of CHARACTERS) {
      expect(characterNameFr(character.id)).toBe(character.name);
    }
    expect(() => characterNameFr('c9' as CharacterId)).toThrow(RangeError);
  });

  it('donne le même texte pour le même fait et la même variante', () => {
    for (const type of SPEAKER_FACT_TYPES) {
      const source = sampleFact(type);
      for (const [index, formatter] of SPEAKER_LINES_FR[type].entries()) {
        expect(SPEAKER_LINES_FR[type][index]?.(source), `${type}[${index}]`).toBe(formatter(source));
      }
    }
  });

  it('affiche un texte distinct pour FINISH et PHOTO_FINISH', () => {
    const finish = fact('FINISH', [12.5, 2160, 2147.5]);
    const photo = fact('PHOTO_FINISH', [0.42, 2159.9, 2159.5]);

    const finishLines = SPEAKER_LINES_FR.FINISH.map((formatter) => formatter(finish));
    const photoLines = SPEAKER_LINES_FR.PHOTO_FINISH.map((formatter) => formatter(photo));

    for (const line of finishLines) {
      expect(photoLines, `« ${line} » ne doit pas être aussi une phrase de photo-finish`).not.toContain(line);
    }
    // Le texte de photo-finish dit ce qui le distingue : une arrivée serrée.
    expect(photoLines.some((line) => line.includes('photo') || line.includes('Photo') || line.includes('PHOTO'))).toBe(true);
  });

  it('expose le catalogue sous la forme attendue par le rendu', () => {
    expect(SPEAKER_CATALOGUE_FR.lines).toBe(SPEAKER_LINES_FR);
  });
});