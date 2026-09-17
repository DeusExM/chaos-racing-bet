import { expect, test, type Page } from '@playwright/test';

import { DEFAULT_SETTINGS, SETTINGS_STORAGE_KEY } from '../../src/app/settings';
import { UI_TEXT_FR } from '../../src/app/strings.fr';
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
 * Passe corrective (premier test joueur manuel après P013) — réglages `Son` et `Commentateur`.
 *
 * Trois exigences, toutes vérifiées ici **contre le build de production** :
 *
 * 1. §11 — les commandes s'appellent `Son` et `Commentateur` (et non plus `Muet` / `Voix`), elles
 *    gardent leur persistance, et un stockage corrompu ou hérité de l'ancien format ne casse rien.
 * 2. §12 / §13 — activer un réglage produit une **confirmation immédiate** : un court klaxon pour le
 *    son, « Let's go! » pour le commentateur. Jamais au chargement, jamais à la désactivation.
 * 3. §14–§21 — aucun réglage n'influence la course : mêmes distances, même classement, `3 600` pas.
 *
 * Les deux sorties sont **remplacées dans la page** par des sondes (Web Audio et Web Speech) : aucun
 * test ne dépend du son réellement produit par Chromium, et aucune synthèse vocale n'est nécessaire.
 */

declare global {
  interface Window {
    /** Sonde de test : appels réellement reçus par le faux `speechSynthesis`. */
    __TTS_PROBE__?: { spoken: string[]; cancels: number };
    /** Sonde de test : appels réellement reçus par le faux `AudioContext`. */
    __AUDIO_PROBE__?: { contexts: number; oscillators: number; gains: number; resumes: number };
  }
}

/** Remplace le Web Speech API par une sonde, avant tout script applicatif. */
function installSpeechProbe(page: Page): void {
  void page.addInitScript(() => {
    const probe = { spoken: [] as string[], cancels: 0 };
    class FakeUtterance {
      voice: { lang: string; name: string } | null = null;
      lang: string;
      rate = 1;

      constructor(readonly text: string) {
        this.lang = '';
      }
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

/**
 * Remplace le Web Audio API par une sonde, avant tout script applicatif.
 *
 * La sonde compte les **oscillateurs réellement créés** : c'est la mesure la plus directe de « un
 * klaxon a été joué », sans dépendre du rendu audio de la machine de test.
 */
function installAudioProbe(page: Page): void {
  void page.addInitScript(() => {
    const probe = { contexts: 0, oscillators: 0, gains: 0, resumes: 0 };
    const param = (): Record<string, unknown> => ({
      value: 0,
      setValueAtTime: () => undefined,
      exponentialRampToValueAtTime: () => undefined,
    });
    class FakeAudioContext {
      readonly destination = {};
      readonly sampleRate = 48_000;
      currentTime = 0;
      state = 'running';

      constructor() {
        probe.contexts += 1;
      }

      createOscillator(): Record<string, unknown> {
        probe.oscillators += 1;
        return {
          type: 'sine',
          frequency: param(),
          connect: () => undefined,
          start: () => undefined,
          stop: () => undefined,
        };
      }

      createGain(): Record<string, unknown> {
        probe.gains += 1;
        return { gain: param(), connect: () => undefined };
      }

      resume(): Promise<void> {
        probe.resumes += 1;
        return Promise.resolve();
      }
    }
    Object.defineProperty(window, 'AudioContext', { value: FakeAudioContext, configurable: true });
    Object.defineProperty(window, 'webkitAudioContext', { value: undefined, configurable: true });
    window.__AUDIO_PROBE__ = probe;
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

/** Retire le Web Audio API de la page : la confirmation sonore doit être un no-op silencieux. */
function removeAudioApi(page: Page): void {
  void page.addInitScript(() => {
    Object.defineProperty(window, 'AudioContext', { value: undefined, configurable: true });
    Object.defineProperty(window, 'webkitAudioContext', { value: undefined, configurable: true });
  });
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

/** Écrit des réglages **persistés** (au format brut fourni), puis recharge la page. */
async function startWithRawSettings(
  page: Page,
  raw: string,
  seed = OVERTAKE_SEED,
  autostart = true,
): Promise<ConsoleWatch> {
  const watch = watchConsole(page);
  // 1) Une première visite établit l'origine, sans quoi `localStorage` n'est pas accessible.
  await page.goto(raceUrl({ seed, fast: true }));
  await page.evaluate(
    (payload: { key: string; raw: string }) => window.localStorage.setItem(payload.key, payload.raw),
    { key: SETTINGS_STORAGE_KEY, raw },
  );
  // 2) Rechargement : les réglages doivent être relus au démarrage, et non appliqués à chaud.
  await page.goto(raceUrl({ seed, fast: true, autostart }));
  return watch;
}

/** Écrit des réglages **persistés** au format courant, puis recharge la page. */
async function startWithSettings(
  page: Page,
  settings: { sound: boolean; commentator: boolean },
  seed = OVERTAKE_SEED,
): Promise<ConsoleWatch> {
  return startWithRawSettings(page, JSON.stringify(settings), seed);
}

test('démarre « Son » et « Commentateur » coupés, sans rien écrire', async ({ page }) => {
  const watch = watchConsole(page);
  await page.goto(raceUrl({ seed: OVERTAKE_SEED, fast: true }));
  await waitForHooks(page);

  expect(await readSettingsButtons(page)).toEqual({ sound: false, commentator: false });
  await expect(page.getByTestId('settings-sound')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('settings-commentator')).toHaveAttribute('aria-pressed', 'false');
  expect(
    await readStoredSettings(page),
    'aucun réglage n’est écrit tant que le joueur n’a rien changé',
  ).toBeNull();
  expectNoErrors(watch);
});

test('les libellés visibles disent « Son » et « Commentateur », jamais « Muet » ni « Voix »', async ({
  page,
}) => {
  await page.goto(raceUrl({ seed: OVERTAKE_SEED, fast: true }));
  await waitForHooks(page);

  const labels = await page.evaluate(() => {
    const text = (testId: string): string =>
      document.querySelector(`[data-testid="${testId}"]`)?.textContent ?? '';
    return { sound: text('settings-sound'), commentator: text('settings-commentator') };
  });

  // Le mot affiché est celui du réglage, pas celui de l'ancien état : un joueur ne doit pas avoir à
  // deviner si « Muet » décrit ce qui est, ou ce qui sera.
  expect(labels.sound).toContain(UI_TEXT_FR.soundLabel);
  expect(labels.commentator).toContain(UI_TEXT_FR.commentatorLabel);
  expect(`${labels.sound} ${labels.commentator}`).not.toMatch(/Muet|Voix/);
});

test('persiste les deux réglages et les relit après rechargement', async ({ page }) => {
  const watch = watchConsole(page);
  await page.goto(raceUrl({ seed: OVERTAKE_SEED, fast: true }));
  await waitForHooks(page);

  await page.getByTestId('settings-sound').click();
  await page.getByTestId('settings-commentator').click();
  expect(await readSettingsButtons(page)).toEqual({ sound: true, commentator: true });
  expect(JSON.parse((await readStoredSettings(page)) ?? 'null')).toEqual({
    sound: true,
    commentator: true,
  });

  await page.reload();
  await waitForHooks(page);
  expect(await readSettingsButtons(page), 'les réglages survivent au rechargement').toEqual({
    sound: true,
    commentator: true,
  });

  // Un second basculement est persisté tout autant : le stockage suit l'état réel, dans les deux sens.
  await page.getByTestId('settings-sound').click();
  expect(await readSettingsButtons(page)).toEqual({ sound: false, commentator: true });
  expect(JSON.parse((await readStoredSettings(page)) ?? 'null')).toEqual({
    sound: false,
    commentator: true,
  });
  expectNoErrors(watch);
});

test('migre silencieusement les anciens réglages « muet / voix »', async ({ page }) => {
  const watch = watchConsole(page);
  // Ancien format réellement écrit par P012 : `tts` + `mute`.
  const watchStart = await startWithRawSettings(page, JSON.stringify({ mute: false, tts: true }));
  await waitForHooks(page);

  // « Voix active, pas muet » décrit exactement ce que le nouveau réglage `Commentateur` contrôle ;
  // le son, lui, n'existait pas : il retombe donc sur son défaut.
  expect(await readSettingsButtons(page), 'migration de l’ancien format').toEqual({
    sound: DEFAULT_SETTINGS.sound,
    commentator: true,
  });

  // Et le premier changement réécrit le stockage au **nouveau** format : la migration ne se répète pas.
  await page.getByTestId('settings-sound').click();
  expect(JSON.parse((await readStoredSettings(page)) ?? 'null')).toEqual({
    sound: true,
    commentator: true,
  });
  expectNoErrors(watchStart);
  expectNoErrors(watch);
});

test('« muet » hérité coupait la voix : la migration conserve ce silence', async ({ page }) => {
  const watch = await startWithRawSettings(page, JSON.stringify({ mute: true, tts: true }));
  await waitForHooks(page);

  expect(await readSettingsButtons(page)).toEqual({ sound: DEFAULT_SETTINGS.sound, commentator: false });
  expectNoErrors(watch);
});

test('réglages corrompus un par un : jamais de crash, jamais de valeur inventée', async ({ page }) => {
  const watch = watchConsole(page);
  const corrupted = [
    '{{{ pas du json',
    'null',
    '[]',
    '"texte"',
    '{"sound":"oui","commentator":3}',
    '{"commentator":true}',
  ];

  for (const raw of corrupted) {
    await page.goto(raceUrl({ seed: OVERTAKE_SEED, fast: true }));
    await page.evaluate(
      (payload: { key: string; raw: string }) => window.localStorage.setItem(payload.key, payload.raw),
      { key: SETTINGS_STORAGE_KEY, raw },
    );
    await page.reload();
    await waitForHooks(page);

    // Les deux boutons restent présents et cliquables, et l'état lu est un booléen exploitable.
    const buttons = await readSettingsButtons(page);
    expect(typeof buttons.sound, raw).toBe('boolean');
    expect(typeof buttons.commentator, raw).toBe('boolean');

    // Un clic sur un stockage corrompu fonctionne : le store réécrit une forme saine.
    await page.getByTestId('settings-commentator').click();
    expect(JSON.parse((await readStoredSettings(page)) ?? 'null')).toEqual({
      sound: buttons.sound,
      commentator: !buttons.commentator,
    });
  }

  expectNoErrors(watch);
});

test('une course complète aboutit avec un stockage corrompu', async ({ page }) => {
  const watch = watchConsole(page);
  await page.addInitScript((key: string) => {
    window.localStorage.setItem(key, '{{{ pas du json');
  }, SETTINGS_STORAGE_KEY);

  await page.goto(raceUrl({ seed: OVERTAKE_SEED, fast: true, autostart: true }));
  await waitForHooks(page);

  const final = await finishRace(page);
  expect(final.steps).toBe(RACE_CONFIG.TOTAL_STEPS);
  expect(final.tSim).toBe(RACE_CONFIG.TOTAL_SIM_S);
  expectNoErrors(watch);
});

test('aucun son ni aucune voix au chargement, même si les deux réglages sont actifs', async ({
  page,
}) => {
  installAudioProbe(page);
  installSpeechProbe(page);
  const watch = await startWithSettings(page, { sound: true, commentator: true });

  // Laisse tourner la course un instant : sans cela, « aucun son » pourrait simplement dire
  // « rien n'a encore eu le temps de se produire ».
  await page.waitForFunction(() => (window.__CHAOS_RACE__?.state().steps ?? 0) > 600, null, {
    timeout: 30_000,
  });

  const audio = await page.evaluate(() => window.__AUDIO_PROBE__);
  expect(audio?.oscillators, 'le klaxon ne part jamais au chargement').toBe(0);
  const probe = await page.evaluate(() => window.__TTS_PROBE__);
  // Le commentateur produit ses répliques, mais **aucune** confirmation d'activation : « Let's go! »
  // est la réponse à un clic, jamais une conséquence d'un réglage relu.
  expect(probe?.spoken ?? []).not.toContain(UI_TEXT_FR.voiceEnabledConfirmation);
  expectNoErrors(watch);
});

test('activer « Son » joue un court klaxon, le couper n’en joue aucun', async ({ page }) => {
  installAudioProbe(page);
  const watch = watchConsole(page);
  await page.goto(raceUrl({ seed: OVERTAKE_SEED, fast: true }));
  await waitForHooks(page);

  await page.getByTestId('settings-sound').click();
  const afterEnable = await page.evaluate(() => window.__AUDIO_PROBE__);
  // Le klaxon est **synthétisé** : deux appuis, donc exactement deux oscillateurs. C'est la seule
  // mesure fiable du son produit — Phaser crée son propre graphe audio (et donc des gains) au
  // démarrage du jeu, si bien que les compteurs de contextes et de gains ne lui sont pas propres.
  expect(afterEnable?.oscillators, 'le klaxon est synthétisé, donc des oscillateurs sont créés').toBe(
    2,
  );
  expect(afterEnable?.gains, 'les deux appuis passent chacun par un gain').toBeGreaterThanOrEqual(2);
  expect(afterEnable?.contexts, 'un contexte audio existe').toBeGreaterThanOrEqual(1);

  await page.getByTestId('settings-sound').click();
  const afterDisable = await page.evaluate(() => window.__AUDIO_PROBE__);
  expect(afterDisable?.oscillators, 'couper le son ne joue rien').toBe(2);
  expect(await readSettingsButtons(page)).toEqual({ sound: false, commentator: false });
  expectNoErrors(watch);
});

test('activer « Commentateur » dit « Let’s go! », le couper ne dit rien', async ({ page }) => {
  installSpeechProbe(page);
  const watch = watchConsole(page);
  // Course **non lancée** : la confirmation est alors la seule chose prononçable, ce qui rend la
  // mesure exacte au lieu d'être noyée dans le commentaire de course.
  await page.goto(raceUrl({ seed: OVERTAKE_SEED, fast: true }));
  await waitForHooks(page);

  expect(await page.evaluate(() => window.__TTS_PROBE__?.spoken ?? [])).toEqual([]);

  await page.getByTestId('settings-commentator').click();
  expect(await page.evaluate(() => window.__TTS_PROBE__?.spoken ?? [])).toEqual([
    UI_TEXT_FR.voiceEnabledConfirmation,
  ]);

  await page.getByTestId('settings-commentator').click();
  expect(
    await page.evaluate(() => window.__TTS_PROBE__?.spoken ?? []),
    'couper le commentateur ne dit rien de plus',
  ).toEqual([UI_TEXT_FR.voiceEnabledConfirmation]);
  expect(await readSettingsButtons(page)).toEqual({ sound: false, commentator: false });
  expectNoErrors(watch);
});

test('la confirmation vocale ne crée ni réplique, ni cooldown, ni pas de course', async ({ page }) => {
  installSpeechProbe(page);
  const watch = watchConsole(page);
  // Course **non lancée** : la confirmation est alors la seule chose prononçable, et l'absence de
  // réplique affichée prouve qu'elle n'a pas traversé le speaker.
  await page.goto(raceUrl({ seed: OVERTAKE_SEED, fast: true }));
  await waitForHooks(page);

  await page.getByTestId('settings-commentator').click();
  expect(await page.evaluate(() => window.__TTS_PROBE__?.spoken ?? [])).toEqual([
    UI_TEXT_FR.voiceEnabledConfirmation,
  ]);
  expect(
    await page.evaluate(() => window.__CHAOS_RACE_VIEW__?.subtitleLine() ?? null),
    'la confirmation ne fabrique aucune réplique',
  ).toBeNull();
  expect(await page.evaluate(() => window.__CHAOS_RACE__?.state().steps ?? -1)).toBe(0);

  // La course démarre ensuite normalement : la première réplique **réelle** arrive, et ce n'est pas
  // la confirmation — elle n'a donc consommé ni file ni cooldown.
  await page.getByTestId('start-button').click();
  const firstLine = await page.evaluate(async () => {
    for (let frame = 0; frame < 4000; frame += 1) {
      const line = window.__CHAOS_RACE_VIEW__?.subtitleLine();
      if (line !== null && line !== undefined) {
        return line.text;
      }
      await new Promise((resolve) => {
        requestAnimationFrame(() => {
          resolve(null);
        });
      });
    }
    return '';
  });

  expect(firstLine.length).toBeGreaterThan(10);
  expect(firstLine).not.toBe(UI_TEXT_FR.voiceEnabledConfirmation);
  expectNoErrors(watch);
});

test('les deux réglages n’altèrent jamais la simulation', async ({ page }) => {
  test.setTimeout(240_000);

  const runs: {
    label: string;
    steps: number;
    tSim: number;
    distances: number[];
    ranking: string[];
  }[] = [];

  for (const [label, settings] of [
    ['défauts', { sound: false, commentator: false }],
    ['commentateur activé', { sound: false, commentator: true }],
    ['son activé', { sound: true, commentator: false }],
    ['son + commentateur', { sound: true, commentator: true }],
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
    expect(run.steps).toBe(3600);
    expect(run.tSim).toBe(RACE_CONFIG.TOTAL_SIM_S);
  }
});

test('la course fonctionne sans aucune API de synthèse vocale', async ({ page }) => {
  removeSpeechApi(page, false);
  const watch = await startWithSettings(page, { sound: false, commentator: true });

  const final = await finishRace(page);
  expect(final.steps).toBe(RACE_CONFIG.TOTAL_STEPS);
  // Le sous-titre continue d'exister : la voix est une sortie facultative, pas une condition.
  expect(await page.evaluate(() => window.__CHAOS_RACE_VIEW__ !== undefined)).toBe(true);
  expectNoErrors(watch);
});

test('la course fonctionne quand seule la classe d’énonciation manque', async ({ page }) => {
  removeSpeechApi(page, true);
  const watch = await startWithSettings(page, { sound: false, commentator: true });

  const final = await finishRace(page);
  expect(final.steps).toBe(RACE_CONFIG.TOTAL_STEPS);
  expectNoErrors(watch);
});

test('la course fonctionne sans aucune API audio', async ({ page }) => {
  removeAudioApi(page);
  const watch = watchConsole(page);
  await page.goto(raceUrl({ seed: OVERTAKE_SEED, fast: true }));
  await waitForHooks(page);

  // Activer le son sans Web Audio ne doit ni lever, ni bloquer : le klaxon est un bonus, pas un dû.
  await page.getByTestId('settings-sound').click();
  expect(await readSettingsButtons(page)).toEqual({ sound: true, commentator: false });

  await page.goto(raceUrl({ seed: OVERTAKE_SEED, fast: true, autostart: true }));
  const final = await finishRace(page);
  expect(final.steps).toBe(RACE_CONFIG.TOTAL_STEPS);
  expectNoErrors(watch);
});

test('vocalise exactement une réplique réellement affichée', async ({ page }) => {
  installSpeechProbe(page);
  const watch = await startWithSettings(page, { sound: false, commentator: true });
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

test('le réglage coupé coupe la voix sans couper les sous-titres', async ({ page }) => {
  installSpeechProbe(page);
  const watch = await startWithSettings(page, { sound: false, commentator: false });
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
  expect(text.length, 'couper le commentateur ne supprime pas les sous-titres').toBeGreaterThan(10);

  // …et rien n'a été prononcé, alors même que la synthèse vocale est disponible.
  const probe = await page.evaluate(() => window.__TTS_PROBE__);
  expect(probe?.spoken).toEqual([]);
  expectNoErrors(watch);
});
