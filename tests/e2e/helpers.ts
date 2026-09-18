import { expect, type Page } from '@playwright/test';

import { SETTINGS_STORAGE_KEY, type RaceSettings } from '../../src/app/settings';
import type { FinishDebugSnapshot, HudDebugSnapshot, SubtitleLineView } from '../../src/render/viewDebug';

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
  /** Écart en secondes, tel qu'affiché (virgule française). */
  readonly gapSecondsText: string;
}

export interface FrameSample {
  readonly steps: number;
  readonly tSim: number;
  /** Phase du **noyau** : `idle`, `running` ou `finished`. */
  readonly phase: string;
  /** Phase **temps réel** de `RaceSimulation` : `countdown`, `checkpointPause`, `userPaused`, … */
  readonly simPhase: string;
  /** Numéro du segment courant (1 à 4), `0` hors course. */
  readonly segment: number;
  /** Numéro du checkpoint en pause, sinon `null`. */
  readonly checkpoint: number | null;
  /** Texte de la bannière de checkpoint dans cette frame (`''` si aucune). */
  readonly banner: string;
  /** `true` si la bannière est masquée dans cette frame. */
  readonly bannerHidden: boolean;
  /** Texte réellement dessiné dans le bandeau de commentaire (`''` s'il n'y en a aucun). */
  readonly subtitle: string;
  /** Réplique affichée avec son **fait source** (P012), `null` quand rien n'est affiché. */
  readonly subtitleLine: SubtitleLineView | null;
  /** Nom mis en avant dans le bandeau (`''` quand la réplique ne cite personne). */
  readonly subtitleName: string;
  /** Indicateur de file affiché par le bandeau (`''` quand la file du speaker est vide). */
  readonly subtitleQueue: string;
  readonly distances: readonly number[];
  readonly sprites: readonly SpriteSample[];
  readonly camera: CameraSample;
  readonly ranks: readonly RankSample[];
  readonly hud: readonly HudRowSample[];
  /** Modèle réellement affiché par le HUD dans cette frame (P011), `null` avant la première frame. */
  readonly hudModel: HudDebugSnapshot | null;
}

export interface LeaderboardRowView {
  readonly id: string;
  readonly rank: number;
  readonly name: string;
  readonly gapMeters: number;
  /** Écart en secondes, tel qu'affiché. */
  readonly gapSeconds: number;
  /** Vrai pour la ligne du leader. */
  readonly leader: boolean;
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
          gapSecondsText: row.querySelector('.hud-gap-seconds')?.textContent ?? '',
        }));

        samples.push({
          steps: state.steps,
          tSim: state.tSim,
          phase: state.phase.kind,
          simPhase: api.phase(),
          segment: api.segment(),
          checkpoint: api.checkpoint(),
          banner: document.querySelector('[data-testid="checkpoint-banner"]')?.textContent ?? '',
          bannerHidden:
            document.querySelector('[data-testid="checkpoint-banner"]')?.hasAttribute('hidden') ??
            true,
          subtitle: view.subtitle(),
          subtitleLine: view.subtitleLine(),
          subtitleName:
            document.querySelector('[data-testid="subtitle-name"]')?.textContent ?? '',
          subtitleQueue:
            document.querySelector('[data-testid="subtitle-queue"]')?.textContent ?? '',
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
          hudModel: view.hud(),
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

/** Lit le classement **affiché** dans le DOM, dans l'ordre où il apparaît. */export async function readLeaderboard(page: Page): Promise<LeaderboardRowView[]> {
  return page.locator('[data-testid="leaderboard-row"]').evaluateAll((rows) =>
    rows.map((row) => {
      const gapText = row.querySelector('.hud-gap')?.textContent ?? '';
      const secondsText = row.querySelector('.hud-gap-seconds')?.textContent ?? '';
      return {
        id: row.getAttribute('data-character-id') ?? '',
        rank: Number(row.getAttribute('data-rank') ?? '0'),
        name: row.querySelector('.hud-name')?.textContent ?? '',
        // Le rendu affiche la virgule décimale française : on la ramène à un nombre comparable.
        gapMeters: Number(gapText.replace(',', '.').replace(/[^0-9.]/g, '')),
        gapSeconds: Number(secondsText.replace(',', '.').replace(/[^0-9.]/g, '')),
        leader: row.getAttribute('data-leader') === '1',
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

/** Résultat de référence complet (classement et distances) d'une seed, sans rendu. */
export async function referenceResult(
  page: Page,
  seed: string,
): Promise<{ ranking: string[]; distances: number[] }> {
  await waitForHooks(page);
  return page.evaluate((value) => {
    const api = window.__CHAOS_RACE__;
    if (api === undefined) {
      throw new Error('hooks absents');
    }
    const result = api.runToCompletion(value);
    return { ranking: [...result.ranking], distances: [...result.distances] };
  }, seed);
}

/**
 * Modèle du HUD réellement affiché à la dernière frame, plus l'état du noyau lu **dans le même
 * appel** : la comparaison entre les deux ne peut donc pas être décalée d'une frame.
 */
export async function readHudFrame(page: Page): Promise<{
  hudModel: HudDebugSnapshot;
  distances: number[];
  ranks: { id: string; rank: number; gapMeters: number }[];
  tSim: number;
  steps: number;
  segment: number;
}> {
  await waitForHooks(page);
  return page.evaluate(() => {
    const api = window.__CHAOS_RACE__;
    const view = window.__CHAOS_RACE_VIEW__;
    if (api === undefined || view === undefined) {
      throw new Error('hooks absents');
    }
    const hudModel = view.hud();
    if (hudModel === null) {
      throw new Error('le HUD n’a encore affiché aucune frame');
    }
    const state = api.state();
    return {
      hudModel,
      distances: state.characters.map((character) => character.x),
      ranks: api.ranks().map((row) => ({
        id: row.id,
        rank: row.rank,
        gapMeters: row.gapMeters,
      })),
      tSim: state.tSim,
      steps: state.steps,
      segment: api.segment(),
    };
  });
}

/**
 * Écrit les réglages P012 **avant** tout script applicatif, pour chaque navigation de la page.
 *
 * C'est le seul moyen de vérifier un démarrage sur réglages persistés : une écriture après
 * chargement testerait un changement à chaud, pas la relecture au démarrage.
 */
export function seedSettingsBeforeLoad(page: Page, settings: RaceSettings): void {
  const raw = JSON.stringify(settings);
  const key = SETTINGS_STORAGE_KEY;
  // `addInitScript` s'exécute dans la page avant ses propres scripts, à chaque navigation.
  void page.addInitScript(
    (payload: { key: string; raw: string }) => {
      window.localStorage.setItem(payload.key, payload.raw);
    },
    { key, raw },
  );
}

/** Réglages réellement présents dans `localStorage`, tels quels (donc éventuellement corrompus). */
export async function readStoredSettings(page: Page): Promise<string | null> {
  return page.evaluate((key) => window.localStorage.getItem(key), SETTINGS_STORAGE_KEY);
}

/**
 * État affiché par les deux boutons de réglages, lu depuis `aria-pressed`.
 *
 * Passe corrective (§11) : les commandes `Muet` / `Voix` sont devenues `Son activé/coupé` et
 * `Commentateur activé/coupé`, avec de nouveaux identifiants. La lecture reste une lecture de
 * `aria-pressed`, donc de ce que le joueur voit réellement.
 */
export async function readSettingsButtons(
  page: Page,
): Promise<{ sound: boolean; commentator: boolean }> {
  return page.evaluate(() => {
    const pressed = (testId: string): boolean =>
      document.querySelector(`[data-testid="${testId}"]`)?.getAttribute('aria-pressed') === 'true';
    return { sound: pressed('settings-sound'), commentator: pressed('settings-commentator') };
  });
}

// -------------------------------------------------------------------------------------------
// P013 — arrivée, podium et rejeu
// -------------------------------------------------------------------------------------------

/** Une ligne de résultat telle qu'elle est **présentée** sur l'écran d'arrivée. */
export interface FinishRowSample {
  readonly id: string;
  readonly rank: number;
  readonly name: string;
  /** Distance finale, relue depuis le **texte affiché** (précision UI : une décimale). */
  readonly distanceText: number;
  /** Écart au vainqueur, relu depuis le texte affiché. */
  readonly gapText: number;
  /** Valeurs brutes publiées en `data-*` : comparaison exacte avec le noyau. */
  readonly distanceRaw: number;
  readonly gapRaw: number;
}

/** Une ligne de « passages en tête » telle qu'elle est présentée. */
export interface FinishPassageSample {
  /** Numéro de checkpoint, `null` pour l'arrivée. */
  readonly checkpoint: number | null;
  /** Instant simulé publié en `data-t-sim` : comparaison exacte avec le noyau. */
  readonly tSim: number;
  readonly id: string;
  /** Texte de la borne affichée (`Checkpoint 1`, `Arrivée`). */
  readonly boundText: string;
  readonly timeText: string;
  readonly name: string;
}

/** Écran d'arrivée réellement lu dans le DOM. */
export interface FinishDomSample {
  readonly hidden: boolean;
  readonly winnerId: string;
  readonly winnerText: string;
  readonly photoVisible: boolean;
  readonly photoText: string;
  readonly podium: readonly FinishRowSample[];
  readonly rows: readonly FinishRowSample[];
  readonly passagesTitle: string;
  readonly passages: readonly FinishPassageSample[];
  readonly replayLabel: string;
  readonly replayEnabled: boolean;
  readonly newRaceLabel: string;
  readonly newRaceEnabled: boolean;
  readonly seedText: string;
}

/** Résultat final du **noyau** au moment de la lecture, plus le modèle de l'écran d'arrivée. */
export interface FinishCoreSample {
  readonly steps: number;
  readonly tSim: number;
  readonly seed: string;
  /** Phase du **noyau** : `idle`, `running` ou `finished`. */
  readonly phaseKind: string;
  /** Phase **temps réel** de `RaceSimulation`. */
  readonly simPhase: string;
  readonly distances: readonly number[];
  readonly ranks: readonly {
    readonly id: string;
    readonly rank: number;
    readonly distance: number;
    readonly gapMeters: number;
  }[];
  readonly visualDistances: readonly number[];
  readonly panel: FinishDebugSnapshot | null;
}

/** Attend l'arrivée réelle de la course (phase temps réel `finished`). */
export async function waitForFinished(page: Page, timeoutMs = 90_000): Promise<void> {
  await waitForHooks(page);
  await page.waitForFunction(() => window.__CHAOS_RACE__?.phase() === 'finished', null, {
    timeout: timeoutMs,
  });
}

/** Lit, dans un **seul** appel, le noyau figé, les distances de rendu et l'écran d'arrivée. */
export async function readFinishCore(page: Page): Promise<FinishCoreSample> {
  await waitForHooks(page);
  return page.evaluate(() => {
    const api = window.__CHAOS_RACE__;
    const view = window.__CHAOS_RACE_VIEW__;
    if (api === undefined || view === undefined) {
      throw new Error('hooks absents');
    }
    const state = api.state();
    return {
      steps: state.steps,
      tSim: state.tSim,
      seed: api.seed(),
      phaseKind: state.phase.kind,
      simPhase: api.phase(),
      distances: state.characters.map((character) => character.x),
      ranks: api.ranks().map((row) => ({
        id: row.id,
        rank: row.rank,
        distance: row.distance,
        gapMeters: row.gapMeters,
      })),
      visualDistances: [...view.visualDistances()],
      panel: view.finish(),
    };
  });
}

/** Lit l'écran d'arrivée tel qu'il est réellement affiché (textes, `data-*`, états des boutons). */
export async function readFinishDom(page: Page): Promise<FinishDomSample> {
  return page.evaluate(() => {
    const parse = (text: string): number =>
      Number(text.replace(',', '.').replace(/[^0-9.]/g, ''));

    const rowOf = (element: Element): FinishRowSample => ({
      id: element.getAttribute('data-character-id') ?? '',
      rank: Number(element.getAttribute('data-rank') ?? '0'),
      name: element.querySelector('.hud-finish-name')?.textContent ?? '',
      distanceText: parse(element.querySelector('.hud-finish-distance')?.textContent ?? ''),
      gapText: parse(element.querySelector('.hud-finish-gap')?.textContent ?? ''),
      distanceRaw: Number(element.getAttribute('data-distance') ?? 'NaN'),
      gapRaw: Number(element.getAttribute('data-gap') ?? 'NaN'),
    });

    const panel = document.querySelector('[data-testid="finish"]');
    const photo = document.querySelector('[data-testid="finish-photo"]');
    const replay = document.querySelector('[data-testid="finish-replay-same"]');
    const newRace = document.querySelector('[data-testid="finish-new-race"]');
    const winner = document.querySelector('[data-testid="finish-winner"]');
    const passages = document.querySelector('[data-testid="finish-passages"]');
    const passageBoundOf = (element: Element): number | null => {
      const bound = element.getAttribute('data-bound') ?? '';
      return bound === 'arrival' || bound === '' ? null : Number(bound);
    };

    return {
      hidden: panel?.hasAttribute('hidden') ?? true,
      winnerId: winner?.getAttribute('data-character-id') ?? '',
      winnerText: winner?.textContent ?? '',
      photoVisible:
        photo instanceof HTMLElement && !photo.hasAttribute('hidden') && photo.textContent !== '',
      photoText: photo?.textContent ?? '',
      podium: Array.from(document.querySelectorAll('[data-testid="finish-podium-row"]')).map(rowOf),
      rows: Array.from(document.querySelectorAll('[data-testid="finish-row"]')).map(rowOf),
      passagesTitle: passages?.querySelector('.hud-finish-subtitle')?.textContent ?? '',
      passages: Array.from(document.querySelectorAll('[data-testid="finish-passage"]')).map(
        (element) => ({
          checkpoint: passageBoundOf(element),
          tSim: Number(element.getAttribute('data-t-sim') ?? 'NaN'),
          id: element.getAttribute('data-character-id') ?? '',
          boundText: element.querySelector('.hud-finish-passage-bound')?.textContent ?? '',
          timeText: element.querySelector('.hud-finish-passage-time')?.textContent ?? '',
          name: element.querySelector('.hud-finish-passage-name')?.textContent ?? '',
        }),
      ),
      replayLabel: replay?.textContent ?? '',
      replayEnabled: replay instanceof HTMLButtonElement && !replay.disabled,
      newRaceLabel: newRace?.textContent ?? '',
      newRaceEnabled: newRace instanceof HTMLButtonElement && !newRace.disabled,
      seedText: document.querySelector('[data-testid="seed-value"]')?.textContent ?? '',
    };
  });
}
