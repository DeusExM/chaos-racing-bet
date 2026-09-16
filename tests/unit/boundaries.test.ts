import { describe, expect, it } from 'vitest';

/**
 * Garde-fou d'architecture : `src/core/**` doit rester un noyau pur.
 *
 * Ce test lit les sources du noyau et échoue si elles utilisent une API interdite ou importent
 * quelque chose hors du noyau. Il remplace un linter, volontairement absent du projet.
 *
 * Les sources sont récupérées via `import.meta.glob(..., { query: '?raw' })` : c'est Vite qui
 * fournit le texte, sans dépendre d'une API de système de fichiers, et donc sans dépendance
 * supplémentaire. Les commentaires sont retirés avant l'analyse, afin de pouvoir *documenter* une
 * interdiction sans la déclencher.
 */

const CORE_SOURCES = import.meta.glob<string>('/src/core/**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
});

interface Rule {
  readonly pattern: RegExp;
  readonly rule: string;
}

/**
 * Fonctions dont ECMAScript ne garantit pas l'arrondi : leur dernier bit peut différer d'un moteur
 * JavaScript à l'autre. Elles sont donc interdites dans le noyau, où tout calcul influence la
 * course. Les constantes qui en dépendent doivent être pré-calculées et figées.
 */
const TRANSCENDENTAL_FUNCTIONS = [
  'log',
  'log2',
  'log10',
  'log1p',
  'exp',
  'expm1',
  'sqrt',
  'cbrt',
  'pow',
  'hypot',
  'sin',
  'cos',
  'tan',
  'asin',
  'acos',
  'atan',
  'atan2',
  'sinh',
  'cosh',
  'tanh',
  'asinh',
  'acosh',
  'atanh',
];

const FORBIDDEN_TOKENS: readonly Rule[] = [
  {
    pattern: new RegExp(`\\bMath\\s*\\.\\s*(?:${TRANSCENDENTAL_FUNCTIONS.join('|')})\\b`),
    rule: "aucune fonction transcendante dans le noyau : leur arrondi peut varier d'un moteur à l'autre",
  },
  { pattern: /\bphaser\b/i, rule: 'Phaser est interdit dans le noyau' },
  { pattern: /\bwindow\b/, rule: 'le noyau ne touche pas aux globales du navigateur' },
  { pattern: /\bdocument\b/, rule: 'le noyau ne touche pas au DOM' },
  { pattern: /\bnavigator\b/, rule: 'le noyau ne touche pas au navigateur' },
  { pattern: /\blocalStorage\b/, rule: 'le noyau ne persiste rien' },
  { pattern: /\bsessionStorage\b/, rule: 'le noyau ne persiste rien' },
  { pattern: /\bMath\s*\.\s*random\b/, rule: 'le noyau ne tire jamais de hasard ambiant' },
  { pattern: /\bDate\b/, rule: "le noyau ne lit jamais l'horloge réelle" },
  { pattern: /\bperformance\b/, rule: "le noyau ne lit jamais l'horloge réelle" },
  { pattern: /\bsetTimeout\b/, rule: 'le noyau ne planifie rien dans le temps réel' },
  { pattern: /\bsetInterval\b/, rule: 'le noyau ne planifie rien dans le temps réel' },
  { pattern: /\bsetImmediate\b/, rule: 'le noyau ne planifie rien dans le temps réel' },
  { pattern: /\brequestAnimationFrame\b/, rule: 'le noyau ne dépend pas du rendu' },
  { pattern: /\btime[_-]?scale/i, rule: 'la vitesse réelle appartient à src/sim' },
  { pattern: /\bcountdown/i, rule: 'le temps réel appartient à src/sim' },
  { pattern: /\bfinish[_-]?distance/i, rule: 'la course se termine par le temps, jamais par une distance' },
];

const FORBIDDEN_IMPORTS: readonly Rule[] = [
  { pattern: /^[^./]/, rule: "le noyau n'importe aucun paquet externe" },
  { pattern: /^(?:\.\.\/)+(?:render|app|sim)(?:\/|$)/, rule: "le noyau n'importe ni render/, ni app/, ni sim/" },
];

const FROM_IMPORT = /\bfrom\s*['"]([^'"]+)['"]/g;
const BARE_IMPORT = /\bimport\s*['"]([^'"]+)['"]/g;

interface Violation {
  readonly file: string;
  readonly rule: string;
  readonly excerpt: string;
}

/** Retire commentaires de bloc et de ligne, pour n'analyser que le code. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

function excerptAround(source: string, index: number): string {
  const start = Math.max(0, index - 40);
  const end = Math.min(source.length, index + 40);
  return source.slice(start, end).replace(/\s+/g, ' ').trim();
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

function findViolations(file: string, rawSource: string): Violation[] {
  const source = stripComments(rawSource);
  const violations: Violation[] = [];

  for (const { pattern, rule } of FORBIDDEN_TOKENS) {
    const match = pattern.exec(source);
    if (match !== null) {
      violations.push({ file, rule, excerpt: excerptAround(source, match.index) });
    }
  }

  for (const { pattern, rule } of FORBIDDEN_IMPORTS) {
    for (const specifier of importSpecifiers(source)) {
      if (pattern.test(specifier)) {
        violations.push({ file, rule: `${rule} (« ${specifier} »)`, excerpt: specifier });
      }
    }
  }

  return violations;
}

describe('frontières du noyau', () => {
  it('analyse bien toutes les sources du noyau', () => {
    const files = Object.keys(CORE_SOURCES);
    expect(files.length).toBeGreaterThanOrEqual(3);

    for (const expected of ['/src/core/math.ts', '/src/core/rng.ts', '/src/core/seed.ts']) {
      expect(files).toContain(expected);
    }
  });

  it('ne trouve aucune violation dans les sources du noyau', () => {
    const violations: Violation[] = [];
    for (const [file, source] of Object.entries(CORE_SOURCES)) {
      violations.push(...findViolations(file, source));
    }

    const report = violations
      .map((violation) => `${violation.file} — ${violation.rule} : « ${violation.excerpt} »`)
      .join('\n');

    expect(violations, report).toEqual([]);
  });
});

describe('le détecteur lui-même', () => {
  it('signale chaque API interdite', () => {
    const cases = [
      'const tirage = Math.random();',
      'const racine = Math.sqrt(valeur);',
      'const puissance = Math.pow(valeur, 2);',
      'const logarithme = Math.log(valeur);',
      'const angle = Math.cos(valeur);',
      'const maintenant = Date.now();',
      'const mesure = performance.now();',
      'setTimeout(fn, 100);',
      'setInterval(fn, 100);',
      'requestAnimationFrame(fn);',
      'const largeur = window.innerWidth;',
      'document.title = "x";',
      'navigator.userAgent;',
      'localStorage.setItem("a", "b");',
      'const d = 10 * timeScale;',
      'const d = TIME_SCALE * 10;',
      'const restant = countdownS;',
      'const restant = COUNTDOWN_REAL_S;',
      'const arrivee = finishDistance;',
      'const ARRIVEE = FINISH_DISTANCE;',
      'import { Scene } from "phaser";',
    ];

    for (const source of cases) {
      expect(findViolations('/src/core/faux.ts', source).length, source).toBeGreaterThan(0);
    }
  });

  it('accepte les opérations exactes', () => {
    for (const source of [
      'const a = Math.imul(x, y);',
      'const b = Math.floor(x);',
      'const c = Math.ceil(x);',
      'const d = Math.trunc(x);',
      'const e = Math.abs(x);',
      'const f = Math.min(x, y);',
      'const g = Math.max(x, y);',
      'const h = Math.round(x * 32);',
    ]) {
      expect(findViolations('/src/core/faux.ts', source), source).toEqual([]);
    }
  });

  it('signale les imports sortants du noyau', () => {
    for (const source of [
      "import { Scene } from 'phaser';",
      "import { TrackView } from '../render/track-view';",
      "import { main } from '../app/main';",
      "import { RaceEngine } from '../sim/engine';",
      "import { Engine } from '../../sim/engine';",
    ]) {
      expect(findViolations('/src/core/faux.ts', source).length, source).toBeGreaterThan(0);
    }
  });

  it('accepte les imports internes au noyau', () => {
    for (const source of [
      "import { hash32 } from './rng';",
      "import { clamp } from './math';",
      "import { X } from '../core/y';",
    ]) {
      expect(findViolations('/src/core/faux.ts', source), source).toEqual([]);
    }
  });

  it('ignore une interdiction mentionnée dans un commentaire', () => {
    expect(findViolations('/src/core/faux.ts', '// ne jamais utiliser Math.random ici')).toEqual([]);
    expect(findViolations('/src/core/faux.ts', '/* setTimeout, Date.now, window */')).toEqual([]);
    expect(findViolations('/src/core/faux.ts', 'const valeur = 1; // pas de performance.now()'))
      .toEqual([]);
  });
});
