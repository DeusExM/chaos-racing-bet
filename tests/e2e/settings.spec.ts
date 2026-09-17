import { expect, test, type Page } from '@playwright/test';

import { SETTINGS_STORAGE_KEY } from '../../src/app/settings';
import { RACE_CONFIG } from '../../src/core/config';
import { OVERTAKE_SEED } from '../fixtures/seeds';
import {
  expectNoErrors,
  raceUrl,
  readSettingsButtons,
  readStoredSettings,
  waitForHooks,
  watchConsole,
  type ConsoleWatch,
} from './helpers';

/**
 * P012 — réglages `mute` / `tts` : persistance, dégradation et **invariance de la simulation**.
 *
 * Ces tests tournent contre le build de production, avec `?e2e=1` pour les hooks. Le Web Speech API
 * n'est jamais requis : quand une assertion porte sur la voix, `speechSynthesis` est **remplacé dans
 * la page** par une sonde qui enregistre les appels — aucune synthèse vocale réelle n'est nécessaire,
 * et aucun test ne dépend du son produit par Chromium.
 */

declare global {
  interface Window {
    /** Sonde de test : appels réellement reçus par le faux `speechSynthesis`. */
    __TTS_PROBE__?: { spoken: string[]; cancels: number };
  }
}

/** Remplace le Web Speech API par une sonde, avant tout script applicatif. */
function installSpeechProbe(page: Page): void {
  void page.addInitScript(() => {
    const probe = { spoken: [] as string[], cancels: 0 };
    class FakeUtterance {
      voice: { lang: string; name: string } | null = null;
      lang = '';
      constructor(readonly text: string) {}
    }
    Object.defineProperty(window, 'SpeechSynthesisUtterance', {
      value: FakeUtterance,
      configurable: true,
    });
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: {
        cancel: () => {
          probe.cancels += 1;
        },
        speak: (utterance: { text?: string }) => {
          probe.spoken.push(utterance.text ?? '');
        },
        getVoices: () => [{ lang: 'fr-FR', name: 'Voix de test' }],
      },
    });
    window.__TTS_PROBE__ = probe;
  });
}

/** Retire le Web Speech API de la page : ni synthèse, ni classe d'énonciation. */
function removeSpeechApi(page: Page, keepUtterance: boolean): void {
  void page.addInitScript((utteranceKept: boolean) => {
    Object.defineProperty(window, 'speechSynthesis', { value: undefined, configurable: true });
    if (!utteranceKept) {
      Object.defineProperty(window, 'SpeechSynthesisUtterance', {
        value: undefined,
        configurable: true,
      });
    }
  }, keepUtterance);
}

/** Joue la course jusqu'à l'arrivée et renvoie l'état **final** réel, lu sur les hooks. */
async function finishRace(
  page: Page,
): Promise<{ steps: number; tSim: number; distances: number[]; ranking: string[] }> {
  await waitForHooks(page);
  await page.waitForFunction(() => window.__CHAOS_RACE__?.phase() === 'finished', null, {
    timeout: 90_000,
  });
  return page.evaluate(() => {
    const api = window.__CHAOS_RACE__;
    if (api === undefined) {
      throw new Error('hooks absents');
    }
    const state = api.state();
    return {
      steps: state.steps,
      tSim: state.tSim,
      distances: state.characters.map((character) => character.x),
      ranking: api.ranks().map((row) => row.id),
    };
  });
}

/** Écrit des réglages **persistés**, puis recharge la page : l'application doit les relire. */
async function startWithSettings(
  page: Page,
  settings: { mute: boolean; tts: boolean },
  seed = OVERTAKE_SEED,
): Promise<ConsoleWatch> {
  const watch = watchConsole(page);
  // 1) Une première visite établit l'origine, sans quoi `localStorage` n'est pas accessible.
  await page.goto(raceUrl({ seed, fast: true }));
  await page.evaluate(
    (payload: { key: string; raw: string }) => window.localStorage.setItem(payload.key, payload.raw),
    { key: SETTINGS_STORAGE_KEY, raw: JSON.stringify(settings) },
  );
  // 2) Rechargement : les réglages doivent être relus au démarrage, et non appliqués à chaud.
  await page.goto(raceUrl({ seed, fast: true, autostart: true }));
  return watch;
}

test('démarre muet désactivé et TTS désactivé, sans rien écrire', async ({ page }) => {
  const watch = watchConsole(page);
  await page.goto(raceUrl({ seed: OVERTAKE_SEED, fast: true }));
  await waitForHooks(page);

  expect(await readSettingsButtons(page)).toEqual({ mute: false, tts: false });
  await expect(page.getByTestId('settings-mute')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('settings-tts')).toHaveAttribute('aria-pressed', 'false');
  expect(
    await readStoredSettings(page),
    'aucun réglage n’est écrit tant que le joueur n’a rien changé',
  ).toBeNull();
  expectNoErrors(watch);
});

test('persiste un réglage modifié et le relit après rechargement', async ({ page }) => {
  const watch = watchConsole(page);
  await page.goto(raceUrl({ seed: OVERTAKE_SEED, fast: true }));
  await waitForHooks(page);

  await page.getByTestId('settings-mute').click();
  await page.getByTestId('settings-tts').click();
  expect(await readSettingsButtons(page)).toEqual({ mute: true, tts: true });
  expect(JSON.parse((await readStoredSettings(page)) ?? 'null')).toEqual({ mute: true, tts: true });

  await page.reload();
  await waitForHooks(page);
  expect(await readSettingsButtons(page), 'les réglages survivent au rechargement').toEqual({
    mute: true,
    tts: true,
  });

  // Un second basculement est persisté tout autant : le stockage suit l'état réel, dans les deux sens.
  await page.getByTestId('settings-mute').click();
  expect(await readSettingsButtons(page)).toEqual({ mute: false, tts: true });
  expect(JSON.parse((await readStoredSettings(page)) ?? 'null')).toEqual({ mute: false, tts: true });
  expectNoErrors(watch);
});

test('démarre quand même si les réglages stockés sont corrompus', async ({ page }) => {
  const watch = watchConsole(page);
  await page.addInitScript((key: string) => {
    window.localStorage.setItem(key, '{{{ pas du json');
  }, SETTINGS_STORAGE_KEY);

  await page.goto(raceUrl({ seed: OVERTAKE_SEED, fast: true, autostart: true }));
  await waitForHooks(page);

  // Les défauts s'appliquent, la course tourne, et rien n'a été signalé en console.
  expect(await readSettingsButtons(page)).toEqual({ mute: false, tts: false });
  const frame = await page.evaluate(() => window.__CHAOS_RACE__?.state().steps ?? 0);
  expect(frame).toBeGreaterThan(0);
  const final = await finishRace(page);
  expect(final.steps).toBe(RACE_CONFIG.TOTAL_STEPS);
  expectNoErrors(watch);
});

test('muet et TTS n’altèrent jamais la simulation', async ({ page }) => {
  test.setTimeout(180_000);

  const runs: {
    label: string;
    steps: number;
    distances: number[];
    ranking: string[];
  }[] = [];

  for (const [label, settings] of [
    ['défauts', { mute: false, tts: false }],
    ['TTS activé', { mute: false, tts: true }],
    ['muet activé', { mute: true, tts: false }],
    ['muet + TTS', { mute: true, tts: true }],
  ] as const) {
    const watch = await startWithSettings(page, settings);
    // Preuve que le réglage a bien été **appliqué** : l'UI est construite depuis le store relu.
    expect(await readSettingsButtons(page), label).toEqual(settings);

    const final = await finishRace(page);
    expectNoErrors(watch);
    runs.push({ label, ...final });
  }

  const reference = runs[0];
  expect(reference).toBeDefined();
  for (const run of runs.slice(1)) {
    expect(run.distances, `distances finales identiques (${run.label})`).toEqual(
      reference?.distances,
    );
    expect(run.ranking, `classement final identique (${run.label})`).toEqual(reference?.ranking);
  }
  for (const run of runs) {
    expect(run.steps, `nombre de pas (${run.label})`).toBe(RACE_CONFIG.TOTAL_STEPS);
    expect(run.steps).toBe(10_800);
  }
});

test('vocalise exactement une réplique réellement affichée', async ({ page }) => {
  installSpeechProbe(page);
  const watch = await startWithSettings(page, { mute: false, tts: true });
  await waitForHooks(page);

  // Scrutation **dans la page** : au premier appel vocal, on lit la réplique affichée dans la même
  // image. Le bandeau est alimenté dans la même frame que la décision, donc les deux coïncident.
  const observed = await page.evaluate(async () => {
    for (let frame = 0; frame < 4000; frame += 1) {
      const probe = window.__TTS_PROBE__;
      if (probe !== undefined && probe.spoken.length > 0) {
        const line = window.__CHAOS_RACE_VIEW__?.subtitleLine() ?? null;
        return { spoken: probe.spoken[0] ?? '', text: line?.text ?? '', cancels: probe.cancels };
      }
      await new Promise((resolve) => {
        requestAnimationFrame(() => {
          resolve(null);
        });
      });
    }
    return null;
  });

  expect(observed, 'une réplique a été vocalisée').not.toBeNull();
  expect(observed?.text.length ?? 0).toBeGreaterThan(10);
  expect(observed?.spoken, 'le TTS vocalise le texte affiché, sans le réécrire').toBe(
    observed?.text,
  );
  // `speak` coupe d'abord toute énonciation en cours : la première émission produit donc exactement
  // une annulation, jamais deux phrases superposées.
  expect(observed?.cancels).toBe(1);
  expectNoErrors(watch);
});

test('le mode muet coupe la voix sans couper les sous-titres', async ({ page }) => {
  installSpeechProbe(page);
  const watch = await startWithSettings(page, { mute: true, tts: true });
  await waitForHooks(page);

  // Le sous-titre texte reste produit normalement…
  const text = await page.evaluate(async () => {
    for (let frame = 0; frame < 4000; frame += 1) {
      const line = window.__CHAOS_RACE_VIEW__?.subtitle() ?? '';
      if (line.length > 0) {
        return line;
      }
      await new Promise((resolve) => {
        requestAnimationFrame(() => {
          resolve(null);
        });
      });
    }
    return '';
  });
  expect(text.length, 'le mode muet ne supprime pas les sous-titres').toBeGreaterThan(10);

  // …et rien n'a été prononcé, alors même que le TTS est activé.
  const probe = await page.evaluate(() => window.__TTS_PROBE__);
  expect(probe?.spoken).toEqual([]);
  expectNoErrors(watch);
});

test('la course fonctionne sans aucune API de synthèse vocale', async ({ page }) => {
  removeSpeechApi(page, false);
  const watch = await startWithSettings(page, { mute: false, tts: true });

  const final = await finishRace(page);
  expect(final.steps).toBe(RACE_CONFIG.TOTAL_STEPS);
  // Le sous-titre continue d'exister : la voix est une sortie facultative, pas une condition.
  expect(await page.evaluate(() => window.__CHAOS_RACE_VIEW__ !== undefined)).toBe(true);
  expectNoErrors(watch);
});

test('la course fonctionne quand seule la classe d’énonciation manque', async ({ page }) => {
  removeSpeechApi(page, true);
  const watch = await startWithSettings(page, { mute: false, tts: true });

  const final = await finishRace(page);
  expect(final.steps).toBe(RACE_CONFIG.TOTAL_STEPS);
  expectNoErrors(watch);
});
