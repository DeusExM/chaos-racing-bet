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

function findViolations(
  file: string,
  rawSource: string,
  tokens: readonly Rule[] = FORBIDDEN_TOKENS,
  imports: readonly Rule[] = FORBIDDEN_IMPORTS,
): Violation[] {
  const source = stripComments(rawSource);
  const violations: Violation[] = [];

  for (const { pattern, rule } of tokens) {
    const match = pattern.exec(source);
    if (match !== null) {
      violations.push({ file, rule, excerpt: excerptAround(source, match.index) });
    }
  }

  for (const { pattern, rule } of imports) {
    for (const specifier of importSpecifiers(source)) {
      if (pattern.test(specifier)) {
        violations.push({ file, rule: `${rule} (« ${specifier} »)`, excerpt: specifier });
      }
    }
  }

  return violations;
}

/** Analyse un ensemble de sources et renvoie un rapport lisible, vide s'il n'y a aucune violation. */
function violationsIn(
  sources: Record<string, string>,
  tokens: readonly Rule[],
  imports: readonly Rule[],
): Violation[] {
  const violations: Violation[] = [];
  for (const [file, source] of Object.entries(sources)) {
    violations.push(...findViolations(file, source, tokens, imports));
  }
  return violations;
}

function report(violations: readonly Violation[]): string {
  return violations
    .map((violation) => `${violation.file} — ${violation.rule} : « ${violation.excerpt} »`)
    .join('\n');
}

/**
 * `src/sim/` a le droit de lire l'horloge réelle ? Non : il ne la lit **jamais** lui-même. Le temps
 * réel lui est apporté par `update(realDtMs)`. Il n'a donc aucune raison de connaître `Date`,
 * `performance` ou une fonction de planification — et surtout, il ne doit jamais choisir la taille
 * du pas, qui reste la propriété exclusive du noyau.
 */
const SIM_TOKEN_RULES: readonly Rule[] = [
  { pattern: /\bphaser\b/i, rule: 'Phaser est interdit dans src/sim : la simulation est indépendante du rendu' },
  {
    pattern: /\bMath\s*\.\s*random\b/,
    rule: 'src/sim ne tire aucun hasard ambiant : le noyau est seul maître du hasard',
  },
  { pattern: /\bDate\b/, rule: "src/sim ne lit jamais l'horloge réelle : le temps lui est fourni" },
  {
    pattern: /\bperformance\b/,
    rule: "src/sim ne lit jamais l'horloge réelle : le temps lui est fourni",
  },
  {
    pattern: /\bsetTimeout\b|\bsetInterval\b|\bsetImmediate\b|\brequestAnimationFrame\b/,
    rule: 'src/sim ne planifie rien : il avance quand on le lui demande',
  },
  {
    pattern: /\.\s*step\s*\(\s*[^)\s]/,
    rule: 'RaceEngine.step() ne prend aucun argument : la taille du pas appartient au noyau',
  },
  { pattern: /\bDT_S\s*=[^=]/, rule: 'la taille du pas ne se redéfinit jamais' },
  { pattern: /\b1\s*\/\s*60\b/, rule: 'la taille du pas est lue depuis le noyau, jamais recopiée' },
  {
    pattern: /\bfinish[_-]?distance/i,
    rule: 'la course se termine par le temps, jamais par une distance',
  },
];

const SIM_IMPORT_RULES: readonly Rule[] = [
  { pattern: /^[^./]/, rule: "src/sim n'importe aucun paquet externe" },
  { pattern: /^(?:\.\.\/)+(?:render|app)(?:\/|$)/, rule: "src/sim n'importe ni render/ ni app/" },
];

/**
 * `src/render/` est en **lecture seule**. Il n'a donc aucun accès au moteur, aucune possibilité de
 * le faire avancer, et aucune possibilité d'écrire dans un état de personnage. Ce qui est interdit
 * ici n'est pas le style, c'est la capacité même de tricher.
 */
const RENDER_TOKEN_RULES: readonly Rule[] = [
  { pattern: /\bRaceEngine\b/, rule: "le rendu n'a aucun accès au moteur" },
  { pattern: /\.\s*step\s*\(/, rule: 'le rendu ne fait jamais avancer la simulation' },
  {
    pattern: /\bcharacters?\s*\[[^\]]*\]\s*\.\s*(?:x|v|drift|surge|eventBonus)\s*=[^=]/,
    rule: 'le rendu ne peut pas écrire dans un état de personnage',
  },
  {
    pattern: /\bstate\s*\.\s*(?:tSim|steps|phase)\s*=[^=]/,
    rule: 'le rendu ne peut pas écrire dans l’état du noyau',
  },
];

const RENDER_IMPORT_RULES: readonly Rule[] = [
  { pattern: /^(?:\.\.\/)+(?:app)(?:\/|$)/, rule: "le rendu n'importe jamais app/" },
  {
    pattern: /core\/(?:engine|speedModel)/,
    rule: 'le rendu ne peut pas atteindre le moteur ni le modèle de vitesse',
  },
];

const SIM_SOURCES = import.meta.glob<string>('/src/sim/**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
});

const RENDER_SOURCES = import.meta.glob<string>('/src/render/**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
});

describe('frontières du noyau', () => {
  it('analyse bien toutes les sources du noyau', () => {
    const files = Object.keys(CORE_SOURCES);
    expect(files.length).toBeGreaterThanOrEqual(3);

    for (const expected of ['/src/core/math.ts', '/src/core/rng.ts', '/src/core/seed.ts']) {
      expect(files).toContain(expected);
    }
  });

  it('ne trouve aucune violation dans les sources du noyau', () => {
    const violations = violationsIn(CORE_SOURCES, FORBIDDEN_TOKENS, FORBIDDEN_IMPORTS);
    expect(violations, report(violations)).toEqual([]);
  });
});

describe('frontières de la couche temps réel', () => {
  it('analyse bien toutes les sources de src/sim', () => {
    const files = Object.keys(SIM_SOURCES);
    expect(files).toContain('/src/sim/RaceSimulation.ts');
    expect(files).toContain('/src/sim/config.ts');
  });

  it('ne trouve aucune violation dans src/sim', () => {
    const violations = violationsIn(SIM_SOURCES, SIM_TOKEN_RULES, SIM_IMPORT_RULES);
    expect(violations, report(violations)).toEqual([]);
  });

  it('n’accède au navigateur que dans les hooks de test', () => {
    // `testHooks.ts` est le seul fichier autorisé : c'est précisément son rôle d'exposer une API sur
    // `window`. Partout ailleurs, `src/sim` reste indépendant du navigateur.
    for (const [file, source] of Object.entries(SIM_SOURCES)) {
      if (file === '/src/sim/testHooks.ts') {
        continue;
      }
      const stripped = stripComments(source);
      expect(/\bwindow\b|\bdocument\b/.test(stripped), `${file} ne doit pas toucher au navigateur`)
        .toBe(false);
    }
  });
});

describe('frontières du rendu', () => {
  it('analyse bien toutes les sources de src/render', () => {
    const files = Object.keys(RENDER_SOURCES);
    expect(files).toContain('/src/render/scenes/RaceScene.ts');
    expect(files).toContain('/src/render/viewConfig.ts');
  });

  it('ne trouve aucune violation dans src/render', () => {
    const violations = violationsIn(RENDER_SOURCES, RENDER_TOKEN_RULES, RENDER_IMPORT_RULES);
    expect(violations, report(violations)).toEqual([]);
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

  it('signale ce que src/sim n’a pas le droit de faire', () => {
    for (const source of [
      'this.engine.step(dtS);',
      'const dt = 1 / 60;',
      'const t = Date.now();',
      'setTimeout(() => {}, 10);',
      'const d = Math.random();',
      "import { Scene } from 'phaser';",
      "import { RaceScene } from '../render/scenes/RaceScene';",
      "import { bootstrap } from '../app/main';",
      'const FINISH_DISTANCE = 2160;',
    ]) {
      expect(
        findViolations('/src/sim/faux.ts', source, SIM_TOKEN_RULES, SIM_IMPORT_RULES).length,
        source,
      ).toBeGreaterThan(0);
    }
  });

  it('accepte ce que src/sim a le droit de faire', () => {
    for (const source of [
      "import { RaceEngine } from '../core/engine';",
      "import { RACE_CONFIG } from '../core/config';",
      'this.engine.step();',
      'const dt = RACE_CONFIG.DT_S;',
      'const total = this.tSim * DT_S;',
    ]) {
      expect(
        findViolations('/src/sim/faux.ts', source, SIM_TOKEN_RULES, SIM_IMPORT_RULES),
        source,
      ).toEqual([]);
    }
  });

  it('signale ce que src/render n’a pas le droit de faire', () => {
    for (const source of [
      'const engine = new RaceEngine(seed);',
      'this.engine.step();',
      'state.characters[0].x = 10;',
      'state.tSim = 12;',
      "import { bootstrap } from '../../app/main';",
      "import { computeTargetSpeed } from '../../core/speedModel';",
    ]) {
      expect(
        findViolations('/src/render/faux.ts', source, RENDER_TOKEN_RULES, RENDER_IMPORT_RULES).length,
        source,
      ).toBeGreaterThan(0);
    }
  });

  it('accepte ce que src/render a le droit de faire', () => {
    for (const source of [
      "import { Scene } from 'phaser';",
      "import { computeRanks } from '../core/ranking';",
      'sprite.setPosition(x, y);',
      'const distance = character.x;',
      'image.x = 100;',
      'this.options.simulation.update(delta);',
    ]) {
      expect(
        findViolations('/src/render/faux.ts', source, RENDER_TOKEN_RULES, RENDER_IMPORT_RULES),
        source,
      ).toEqual([]);
    }
  });
});
