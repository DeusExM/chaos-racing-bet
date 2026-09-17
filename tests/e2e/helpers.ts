import { expect, type Page } from '@playwright/test';

/**
 * Helpers des tests E2E.
 *
 * Les tests tournent contre le **build de production** servi par `vite preview`, avec `?e2e=1` pour
 * que les hooks soient exposés. Ils n'accèdent à rien d'autre qu'à ce que l'application expose
 * réellement : les hooks de simulation, les positions écran du rendu, et le DOM.
 */

export interface SpriteSample {
  readonly id: string;
  readonly screenX: number;
  readonly screenY: number;
}

export interface CameraSample {
  readonly leftM: number;
  readonly windowM: number;
}

export interface RankSample {
  readonly id: string;
  readonly rank: number;
  readonly gapMeters: number;
}

export interface HudRowSample {
  readonly id: string;
  readonly rank: number;
  readonly name: string;
  readonly gapText: string;
}

export interface FrameSample {
  readonly steps: number;
  readonly tSim: number;
  /** Phase du **noyau** : `idle`, `running` ou `finished`. */
  readonly phase: string;
  /** Phase **temps réel** de `RaceSimulation` : `countdown`, `checkpointPause`, `userPaused`, … */
  readonly simPhase: string;
  /** Numéro du checkpoint en pause, sinon `null`. */
  readonly checkpoint: number | null;
  /** Texte de la bannière de checkpoint dans cette frame (`''` si aucune). */
  readonly banner: string;
  /** `true` si la bannière est masquée dans cette frame. */
  readonly bannerHidden: boolean;
  /** Texte réellement dessiné dans le bandeau de commentaire (`''` s'il n'y en a aucun). */
  readonly subtitle: string;
  readonly distances: readonly number[];
  readonly sprites: readonly SpriteSample[];
  readonly camera: CameraSample;
  readonly ranks: readonly RankSample[];
  readonly hud: readonly HudRowSample[];
}

export interface LeaderboardRowView {
  readonly id: string;
  readonly rank: number;
  readonly name: string;
  readonly gapMeters: number;
}

export interface ConsoleWatch {
  readonly errors: string[];
}

export interface RaceUrlOptions {
  readonly seed: string;
  readonly fast?: boolean;
  readonly debug?: boolean;
  readonly autostart?: boolean;
}

/** Construit l'URL d'une course. `?e2e=1` est toujours présent : sans lui, aucun hook n'existe. */
export function raceUrl(options: RaceUrlOptions): string {
  const params = new URLSearchParams({ seed: options.seed, e2e: '1' });
  if (options.fast === true) {
    params.set('fast', '1');
  }
  if (options.debug === true) {
    params.set('debug', '1');
  }
  if (options.autostart === true) {
    params.set('autostart', '1');
  }
  return `/?${params.toString()}`;
}

/** Collecte les erreurs console, les erreurs JavaScript et les requêtes échouées de la page. */
export function watchConsole(page: Page): ConsoleWatch {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(`console: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => errors.push(`javascript: ${error.message}`));
  page.on('requestfailed', (request) =>
    errors.push(`requête: ${request.method()} ${request.url()}`),
  );
  page.on('response', (response) => {
    if (response.status() >= 400) {
      errors.push(`HTTP ${response.status()}: ${response.url()}`);
    }
  });
  return { errors };
}

/** Vérifie qu'aucune erreur n'a été relevée pendant le test. */
export function expectNoErrors(watch: ConsoleWatch): void {
  expect(watch.errors, `erreurs détectées : ${watch.errors.join(' | ')}`).toEqual([]);
}

/**
 * Attend que les hooks soient réellement installés.
 *
 * Indispensable : `page.goto` rend la main dès que la page est chargée, mais le module applicatif
 * peut ne pas avoir fini de s'exécuter. Sans cette attente, tout accès immédiat aux hooks échoue de
 * façon intermittente — un test qui passe « la plupart du temps » est un test cassé.
 */
export async function waitForHooks(page: Page): Promise<void> {
  await page.waitForFunction(
    () => window.__CHAOS_RACE__ !== undefined && window.__CHAOS_RACE_VIEW__ !== undefined,
    null,
    { timeout: 30_000 },
  );
}

/** Nombre de pas simulés déjà exécutés. */
export async function currentSteps(page: Page): Promise<number> {
  await waitForHooks(page);
  return page.evaluate(() => {
    const api = window.__CHAOS_RACE__;
    if (api === undefined) {
      throw new Error('hooks absents');
    }
    return api.state().steps;
  });
}

/**
 * Enregistre la course **image par image**, depuis la page.
 *
 * Un échantillon par frame d'animation : c'est exactement la granularité à laquelle un spectateur
 * voit la course, et donc la seule qui permette de compter ce qui a réellement été visible. Faire
 * des allers-retours Playwright serait bien trop lent pour ne rien manquer.
 */
export async function collectRace(page: Page, maxFrames = 4000): Promise<FrameSample[]> {
  await waitForHooks(page);
  return page.evaluate(async (limit) => {
    const api = window.__CHAOS_RACE__;
    const view = window.__CHAOS_RACE_VIEW__;
    if (api === undefined || view === undefined) {
      throw new Error('hooks absents');
    }

    const samples: FrameSample[] = [];
    await new Promise<void>((resolve) => {
      const tick = (): void => {
        const state = api.state();
        // Le HUD est lu dans la MÊME frame que l'état : les deux sont écrits par le même
        // `RaceScene.update()`, donc ils ne peuvent pas être décalés d'une frame l'un par rapport à
        // l'autre. C'est ce qui rend la comparaison affichage ↔ noyau concluante.
        const hud = Array.from(
          document.querySelectorAll('[data-testid="leaderboard-row"]'),
        ).map((row) => ({
          id: row.getAttribute('data-character-id') ?? '',
          rank: Number(row.getAttribute('data-rank') ?? '0'),
          name: row.querySelector('.hud-name')?.textContent ?? '',
          gapText: row.querySelector('.hud-gap')?.textContent ?? '',
        }));

        samples.push({
          steps: state.steps,
          tSim: state.tSim,
          phase: state.phase.kind,
          simPhase: api.phase(),
          checkpoint: api.checkpoint(),
          banner: document.querySelector('[data-testid="checkpoint-banner"]')?.textContent ?? '',
          bannerHidden:
            document.querySelector('[data-testid="checkpoint-banner"]')?.hasAttribute('hidden') ??
            true,
          subtitle: view.subtitle(),
          distances: state.characters.map((character) => character.x),
          sprites: view.sprites().map((sprite) => ({
            id: sprite.id,
            screenX: sprite.screenX,
            screenY: sprite.screenY,
          })),
          camera: view.camera(),
          ranks: api.ranks().map((row) => ({
            id: row.id,
            rank: row.rank,
            gapMeters: row.gapMeters,
          })),
          hud,
        });

        if (api.phase() === 'finished' || samples.length >= limit) {
          resolve();
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    return samples;
  }, maxFrames);
}

/** Lit le classement **affiché** dans le DOM, dans l'ordre où il apparaît. */
export async function readLeaderboard(page: Page): Promise<LeaderboardRowView[]> {
  return page.locator('[data-testid="leaderboard-row"]').evaluateAll((rows) =>
    rows.map((row) => {
      const gapText = row.querySelector('.hud-gap')?.textContent ?? '';
      return {
        id: row.getAttribute('data-character-id') ?? '',
        rank: Number(row.getAttribute('data-rank') ?? '0'),
        name: row.querySelector('.hud-name')?.textContent ?? '',
        // Le rendu affiche la virgule décimale française : on la ramène à un nombre comparable.
        gapMeters: Number(gapText.replace(',', '.').replace(/[^0-9.]/g, '')),
      };
    }),
  );
}

/** Bloque le thread principal pendant `durationMs` et vérifie que rien n'a avancé pendant ce temps. */
export async function blockMainThread(page: Page, durationMs: number): Promise<void> {
  await waitForHooks(page);
  const result = await page.evaluate((duration) => {
    const api = window.__CHAOS_RACE__;
    if (api === undefined) {
      throw new Error('hooks absents');
    }
    const before = api.state().steps;
    const until = performance.now() + duration;
    while (performance.now() < until) {
      // Attente active volontaire : c'est le seul moyen de figer réellement la boucle d'animation.
    }
    return { before, after: api.state().steps };
  }, durationMs);

  expect(
    result.after,
    'le thread principal doit être réellement bloqué : aucun pas ne peut avancer pendant le gel',
  ).toBe(result.before);
}

/** Résultat de référence d'une course, obtenu sans rendu ni attente. */
export async function referenceDistances(page: Page, seed: string): Promise<number[]> {
  await waitForHooks(page);
  return page.evaluate((value) => {
    const api = window.__CHAOS_RACE__;
    if (api === undefined) {
      throw new Error('hooks absents');
    }
    return [...api.runToCompletion(value).distances];
  }, seed);
}
