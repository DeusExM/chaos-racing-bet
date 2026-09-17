import { expect, test, type Page } from '@playwright/test';

import { CHARACTERS } from '../../src/core/characters';
import { OVERTAKE_SEED } from '../fixtures/seeds';
import {
  collectRace,
  expectNoErrors,
  raceUrl,
  waitForHooks,
  watchConsole,
  type FrameSample,
} from './helpers';

/**
 * P009-C — le speaker s'affiche vraiment (E2E ciblé).
 *
 * Objectif : prouver qu'une réplique **réellement choisie** apparaît dans une course visible, que le
 * texte est déterministe pour une seed, et que la course se termine normalement sans aucune erreur.
 *
 * Le mode accéléré (`?fast=1`) est utilisé partout : il ne change que le **temps réel**, jamais la
 * simulation, donc la course reste bit à bit identique en ×1 et en ×20.
 */

/** Une réplique réelle : une phrase complète, qui nomme un personnage du roster. */
function isCommentary(text: string, names: readonly string[]): boolean {
  return text.length >= 20 && names.some((name) => text.includes(name));
}

function lastFrame(samples: readonly FrameSample[]): FrameSample | null {
  return samples.at(-1) ?? null;
}

interface FirstLine {
  /** Texte de la première réplique affichée. */
  readonly text: string;
  /** Nombre de frames d'animation écoulées avant qu'elle apparaisse. */
  readonly frames: number;
}

/**
 * Observe la course frame par frame et s'arrête **dès la première réplique**.
 *
 * Bien plus rapide qu'une collecte de course entière, et surtout déterministe : le nombre de frames
 * avant la première réplique ne dépend que du noyau et du speaker, puisque la durée d'affichage est
 * un temps réel consommé frame par frame.
 */
async function firstLine(page: Page, maxFrames = 3000): Promise<FirstLine | null> {
  // `page.goto` rend la main avant que le module applicatif ait fini de s'exécuter : sans cette
  // attente, l'accès aux hooks est intermittent — un test qui passe « la plupart du temps » est cassé.
  await waitForHooks(page);

  return page.evaluate(async (limit) => {
    const view = window.__CHAOS_RACE_VIEW__;
    if (view === undefined) {
      throw new Error('hooks absents');
    }

    return await new Promise<FirstLine | null>((resolve) => {
      let frames = 0;
      const tick = (): void => {
        const text = view.subtitle();
        if (text.length > 0) {
          resolve({ text, frames });
          return;
        }
        if (frames >= limit) {
          resolve(null);
          return;
        }
        frames += 1;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }, maxFrames);
}

/** Démarre la course depuis les hooks, sans attendre le compte à rebours. */
async function startRace(page: Page): Promise<void> {
  await waitForHooks(page);
  await page.evaluate(() => {
    window.__CHAOS_RACE__?.start();
  });
}

test('affiche un commentaire pendant la course, sans erreur console', async ({ page }) => {
  const watch = watchConsole(page);
  const names = CHARACTERS.map((character) => character.name);

  // Sans démarrage, la course est en attente : aucun fait, donc aucun texte.
  await page.goto(raceUrl({ seed: OVERTAKE_SEED, fast: true }));
  await startRace(page);
  const first = await firstLine(page);
  expect(first, 'une réplique doit apparaître pendant la course').not.toBeNull();
  expect(isCommentary(first?.text ?? '', names), `« ${first?.text} » n'est pas une réplique`).toBe(true);
  expect(first?.text ?? '').not.toMatch(/[{}]/);

  const samples = await collectRace(page);
  const final = lastFrame(samples);
  expect(final?.simPhase, 'arrivée toujours normale').toBe('finished');

  // Après la course, plus aucun fait n'est produit : le bandeau se retire tout seul et ne reste pas.
  await page.waitForFunction(() => window.__CHAOS_RACE_VIEW__?.subtitle() === '', null, {
    timeout: 10_000,
  });
  expect(await page.evaluate(() => window.__CHAOS_RACE_VIEW__?.subtitle())).toBe('');
  expectNoErrors(watch);
});

test('dit la même chose, au même moment, pour la même seed', async ({ page }) => {
  const seen: FirstLine[] = [];
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await page.goto(raceUrl({ seed: OVERTAKE_SEED, fast: true, autostart: true }));
    const line = await firstLine(page);
    expect(line, `chargement n°${String(attempt + 1)}`).not.toBeNull();
    seen.push(line as FirstLine);
  }

  for (const line of seen.slice(1)) {
    expect(line.text).toBe(seen[0]?.text);
    expect(line.frames).toBe(seen[0]?.frames);
  }
});

test('rejoue la même première réplique après un redémarrage explicite', async ({ page }) => {
  await page.goto(raceUrl({ seed: OVERTAKE_SEED, fast: true }));
  await startRace(page);
  const first = await firstLine(page);
  expect(first).not.toBeNull();

  await waitForHooks(page);
  await page.evaluate(() => {
    window.__CHAOS_RACE__?.restart();
    window.__CHAOS_RACE__?.start();
  });
  const replayed = await firstLine(page);
  expect(replayed?.text).toBe(first?.text);
  expect(replayed?.frames).toBe(first?.frames);
});

test('remplace le texte quand une nouvelle réplique est choisie', async ({ page }) => {
  const watch = watchConsole(page);
  await page.goto(raceUrl({ seed: OVERTAKE_SEED, fast: true, autostart: true }));

  const samples = await collectRace(page);
  const texts: string[] = [];
  for (const sample of samples) {
    if (sample.subtitle.length > 0 && texts[texts.length - 1] !== sample.subtitle) {
      texts.push(sample.subtitle);
    }
  }

  expect(texts.length, 'la course doit produire plusieurs répliques distinctes').toBeGreaterThan(1);
  expectNoErrors(watch);
});

test('arrive exactement aux mêmes distances qu’une course sans commentaire', async ({ page }) => {
  const watch = watchConsole(page);
  await page.goto(raceUrl({ seed: OVERTAKE_SEED, fast: true, autostart: true }));

  const samples = await collectRace(page);
  const final = lastFrame(samples);
  expect(final?.simPhase).toBe('finished');

  // `runToCompletion` joue la course hors rendu : la comparaison porte donc sur les distances réelles.
  const reference = await page.evaluate((seed) => {
    const api = window.__CHAOS_RACE__;
    if (api === undefined) {
      throw new Error('hooks absents');
    }
    return [...api.runToCompletion(seed).distances];
  }, OVERTAKE_SEED);

  expect(final?.distances).toEqual(reference);
  expectNoErrors(watch);
});