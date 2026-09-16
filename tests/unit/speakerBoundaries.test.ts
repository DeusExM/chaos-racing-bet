import { describe, expect, it } from 'vitest';

/**
 * P009-B : garde-fou d'architecture du speaker.
 *
 * La frontière du ROADMAP est explicite : `src/speaker/**` n'a le droit de dépendre du noyau que par
 * ses **types**, et rien de plus. Ce test la vérifie structurellement, comme `boundaries.test.ts` le
 * fait pour le noyau, le temps réel et le rendu — pas par une règle de lint, qui n'existe pas en V1.
 *
 * La frontière garantit deux propriétés du design, et pas seulement la propreté du code :
 * 1. le speaker ne peut pas faire avancer la course, ni la modifier (`RaceEngine`, `RaceState`,
 *    `speedModel` et `events` sont hors de portée) ;
 * 2. le speaker ne peut pas consommer un flux aléatoire gameplay, ni lire l'horloge réelle : décider
 *    de parler ou non est donc **structurellement** sans effet sur les distances.
 */

const SPEAKER_SOURCES = import.meta.glob<string>('/src/speaker/**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
});

const FROM_IMPORT = /\bfrom\s*['"]([^'"]+)['"]/g;
const BARE_IMPORT = /\bimport\s*['"]([^'"]+)['"]/g;

interface Rule {
  readonly pattern: RegExp;
  readonly rule: string;
}

/** Retire commentaires de bloc et de ligne : une interdiction peut être *documentée* sans arriver. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const pattern of [FROM_IMPORT, BARE_IMPORT]) {
    pattern.lastIndex = 0;
    let match = pattern.exec(source);
    while (match !== null) {
      const specifier = match[1];
      if (specifier !== undefined) {
        specifiers.push(specifier);
      }
      match = pattern.exec(source);
    }
  }
  return specifiers;
}

const FORBIDDEN_TOKENS: readonly Rule[] = [
  { pattern: /\bRaceEngine\b/, rule: "le speaker n'a aucun accès au moteur" },
  { pattern: /\.\s*step\s*\(/, rule: 'le speaker ne fait jamais avancer la simulation' },
  {
    pattern: /\bcharacters?\s*\[[^\]]*\]\s*\.\s*(?:x|v|drift|surge|eventBonus)\s*=[^=]/,
    rule: 'le speaker ne peut pas écrire dans un état de personnage',
  },
  {
    pattern: /\bstate\s*\.\s*(?:tSim|steps|phase)\s*=[^=]/,
    rule: "le speaker ne peut pas écrire dans l'état du noyau",
  },
  { pattern: /\bMath\s*\.\s*random\b/, rule: 'le speaker ne tire aucun hasard ambiant' },
  { pattern: /\bDate\b/, rule: "le speaker ne lit jamais l'horloge réelle" },
  { pattern: /\bperformance\b/, rule: "le speaker ne lit jamais l'horloge réelle" },
  {
    pattern: /\bsetTimeout\b|\bsetInterval\b|\bsetImmediate\b|\brequestAnimationFrame\b/,
    rule: 'le speaker ne planifie rien dans le temps réel',
  },
  { pattern: /\bphaser\b/i, rule: 'Phaser est interdit dans le speaker' },
  { pattern: /\bwindow\b/, rule: 'le speaker ne touche pas aux globales du navigateur' },
  { pattern: /\bdocument\b/, rule: 'le speaker ne touche pas au DOM' },
  { pattern: /\bnavigator\b/, rule: 'le speaker ne touche pas au navigateur' },
  { pattern: /\blocalStorage\b|\bsessionStorage\b/, rule: 'le speaker ne persiste rien' },
  { pattern: /\btime[_-]?scale\b/i, rule: 'la vitesse réelle appartient à src/sim' },
  { pattern: /\bcountdown\b/i, rule: 'le temps réel appartient à src/sim' },
  {
    pattern: /\bfinish[_-]?distance\b/i,
    rule: 'la course se termine par le temps, jamais par une distance',
  },
  // Le speaker ne reçoit que des faits : il ne doit jamais lire un état de course.
  {
    pattern: /\.\s*(?:x|v|drift|surge|eventBonus|activeEvent)\b/,
    rule: "le speaker ne lit pas l'état d'un personnage",
  },
];

const FORBIDDEN_IMPORTS: readonly Rule[] = [
  { pattern: /^[^./]/, rule: "le speaker n'importe aucun paquet externe" },
  {
    pattern: /^\.\.\/core\/(?!types$)/,
    rule: 'le speaker ne dépend du noyau que par ses types (core/types)',
  },
  {
    pattern: /^\.\.\/(?:app|sim|render)(?:\/|$)/,
    rule: "le speaker n'importe ni app/, ni sim/, ni render/",
  },
];

/** Vérifie un échantillon de code comme s'il était un fichier du speaker. */
function violations(file: string, source: string): string[] {
  const stripped = stripComments(source);
  const found: string[] = [];
  for (const specifier of importSpecifiers(stripped)) {
    for (const { pattern, rule } of FORBIDDEN_IMPORTS) {
      if (pattern.test(specifier)) {
        found.push(`${rule} (« ${specifier} »)`);
      }
    }
  }
  for (const { pattern, rule } of FORBIDDEN_TOKENS) {
    const match = pattern.exec(stripped);
    if (match !== null) {
      found.push(`${file} — ${rule} : « ${match[0]} »`);
    }
  }
  return found;
}

describe('frontières du speaker', () => {
  it('analyse bien toutes les sources du speaker', () => {
    const files = Object.keys(SPEAKER_SOURCES);
    expect(files).toContain('/src/speaker/Speaker.ts');
    expect(files).toContain('/src/speaker/importance.ts');
    expect(files).toContain('/src/speaker/cooldowns.ts');
  });

  it('n’importe que core/types et ses propres modules', () => {
    const problems: string[] = [];
    for (const [file, source] of Object.entries(SPEAKER_SOURCES)) {
      for (const specifier of importSpecifiers(stripComments(source))) {
        const allowed = specifier.startsWith('./') || specifier === '../core/types';
        if (!allowed) {
          problems.push(`${file} importe « ${specifier} »`);
        }
      }
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('ne cite ni le moteur, ni l’état de course, ni le rendu, ni une API interdite', () => {
    const problems: string[] = [];
    for (const [file, source] of Object.entries(SPEAKER_SOURCES)) {
      problems.push(...violations(file, source));
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('ne modifie jamais un fait reçu : la source reste celle du noyau', () => {
    const problems: string[] = [];
    for (const [file, source] of Object.entries(SPEAKER_SOURCES)) {
      if (/\bfact\s*\.\s*\w+\s*=[^=]/.test(stripComments(source))) {
        problems.push(`${file} écrit dans un fait`);
      }
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('signale effectivement une violation si on en introduit une', () => {
    for (const sample of [
      "import { RaceEngine } from '../core/engine';",
      "import { RACE_CONFIG } from '../core/config';",
      "import { RaceSimulation } from '../sim/RaceSimulation';",
      "import { Scene } from 'phaser';",
      'const engine = new RaceEngine(seed);',
      'this.engine.step();',
      'const tirage = Math.random();',
      'const maintenant = Date.now();',
      'const largeur = window.innerWidth;',
      'const distance = character.x;',
    ]) {
      expect(violations('/src/speaker/faux.ts', sample).length, sample).toBeGreaterThan(0);
    }
  });

  it('accepte ce que le speaker a le droit de faire', () => {
    for (const sample of [
      "import type { RaceFact } from '../core/types';",
      "import { Speaker } from './Speaker';",
      'const importance = fact.importance;',
      'const instant = fact.tSim;',
      'this.counts.fed += 1;',
      'const tranche = Math.round(Math.abs(primary) * resolution);',
    ]) {
      expect(violations('/src/speaker/faux.ts', sample), sample).toEqual([]);
    }
  });
});
