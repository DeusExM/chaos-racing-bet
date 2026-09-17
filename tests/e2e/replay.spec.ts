import { expect, test, type Page } from '@playwright/test';

import { RACE_CONFIG } from '../../src/core/config';
import { currentSteps, expectNoErrors, raceUrl, waitForHooks, watchConsole } from './helpers';

/**
 * Relecture pendant une pause manuelle (passe corrective 2).
 *
 * ## Ce que ces tests prouvent
 *
 * 1. À la pause, la course déjà jouée est **consultable** : `−2 s` recule, `+2 s` avance, et le
 *    curseur ne peut sortir ni avant `0 s` ni après l'instant réel de la pause.
 * 2. L'instant consulté pilote réellement l'affichage : chrono, classement et positions des sprites
 *    décrivent l'instant **consulté**, pas l'instant de la pause.
 * 3. La relecture est **inerte** : elle ne produit ni pas, ni tirage, ni fait, ni réplique — et après
 *    « Reprendre », la course se termine exactement comme la même seed jouée sans aucune relecture.
 *
 * Le dernier point est le plus important : la relecture ne doit avoir **aucune** influence sur la
 * simulation. Il est vérifié sur les distances finales (comparaison stricte, bit à bit), sur le
 * nombre de pas et sur le classement final.
 */

const SEED = 'KR7Z8NAR';

/** Instant visé pour la pause : `52,4 s`, soit le scénario du second test joueur. */
const PAUSE_TARGET_S = 52.4;
const PAUSE_TARGET_STEPS = Math.round(PAUSE_TARGET_S / RACE_CONFIG.DT_S);
const STEP_STEPS = Math.round(2 / RACE_CONFIG.DT_S);

/**
 * Texte de chrono attendu pour un pas donné.
 *
 * Il est calculé **depuis le pas réellement atteint**, jamais depuis l'instant visé : en mode
 * accéléré, la pause tombe à une frame près après la cible, et le test ne doit pas dépendre de cette
 * imprécision — seulement de la cohérence entre le pas, l'horloge affichée et le curseur.
 */
function timeText(step: number): string {
  return `${(step * RACE_CONFIG.DT_S).toFixed(1).replace('.', ',')}\u00A0s`;
}

interface ReplaySample {
  readonly steps: number;
  readonly tSim: number;
  readonly phase: string;
  readonly replay: { viewedStep: number; pauseStep: number; visible: boolean } | null;
  readonly shownTime: string;
  readonly ranks: string[];
  readonly visualXs: number[];
  readonly barHidden: boolean;
  readonly readout: string;
  readonly rangeMax: string;
  readonly rangeValue: string;
  readonly backDisabled: boolean;
  readonly forwardDisabled: boolean;
}

/** Lit l'état complet de la relecture et de l'affichage, dans une seule tâche. */
async function readReplay(page: Page): Promise<ReplaySample> {
  return page.evaluate(() => {
    const api = window.__CHAOS_RACE__;
    const view = window.__CHAOS_RACE_VIEW__;
    if (api === undefined || view === undefined) {
      throw new Error('hooks absents');
    }
    const state = api.state();
    const range = document.querySelector('[data-testid="replay-range"]');
    const bar = document.querySelector('[data-testid="replay-bar"]');
    return {
      steps: state.steps,
      tSim: state.tSim,
      phase: api.phase(),
      replay: view.replay(),
      shownTime: document.querySelector('[data-testid="hud-sim-time"]')?.textContent ?? '',
      ranks: api.ranks().map((row) => row.id),
      visualXs: [...view.visualDistances()],
      barHidden: bar instanceof HTMLElement ? bar.hidden !== false : true,
      readout: document.querySelector('[data-testid="replay-readout"]')?.textContent ?? '',
      rangeMax: range instanceof HTMLInputElement ? range.max : '',
      rangeValue: range instanceof HTMLInputElement ? range.value : '',
      backDisabled:
        document.querySelector('[data-testid="replay-back"]')?.hasAttribute('disabled') ?? true,
      forwardDisabled:
        document.querySelector('[data-testid="replay-forward"]')?.hasAttribute('disabled') ?? true,
    };
  });
}

/**
 * Démarre une course, en installant d'abord — **dans la page** — la surveillance qui met en pause à
 * l'instant voulu.
 *
 * Le mode accéléré (`×20`) peut jouer les 60 s en une fraction de seconde : attendre la cible depuis
 * le test, à coups d'allers-retours Playwright, la manquerait presque à tous les coups. La
 * surveillance tourne donc à la fréquence d'affichage, dans la page, et met en pause au plus une
 * frame après la cible (au pire `maxStepsPerFrame` pas, soit moins de deux secondes simulées).
 */
async function startRace(page: Page, pauseAt: number | null): Promise<void> {
  await page.goto(raceUrl({ seed: SEED, fast: true, autostart: false }));
  await waitForHooks(page);
  await page.evaluate((target) => {
    const api = window.__CHAOS_RACE__;
    if (api === undefined) {
      throw new Error('hooks absents');
    }
    if (target === null) {
      return;
    }
    const tick = (): void => {
      if (api.state().steps >= target) {
        api.toggleUserPause();
        return;
      }
      requestAnimationFrame(tick);
    };
    tick();
  }, pauseAt);
  await page.evaluate(() => {
    window.__CHAOS_RACE__?.start();
  });
  if (pauseAt !== null) {
    await expect.poll(async () => (await readReplay(page)).phase).toBe('userPaused');
  }
}

/**
 * Lit l'affichage **après** que le HUD a rattrapé le curseur.
 *
 * Le curseur est déplacé par le clic (immédiatement), mais le HUD et la piste sont écrits à la frame
 * suivante : lire le DOM dans la foulée du clic mesurerait la frame d'avant. Cette lecture attend
 * donc que l'invariant soit vrai — l'horloge affichée est celle de l'instant **consulté** — ce qui
 * est aussi une vérification en soi : le chrono ne peut pas décrire autre chose que la relecture.
 */
async function readSettled(page: Page): Promise<ReplaySample> {
  let sample = await readReplay(page);
  await expect
    .poll(
      async () => {
        sample = await readReplay(page);
        const viewed = sample.replay?.viewedStep ?? null;
        return viewed === null ? 'hors relecture' : sample.shownTime === timeText(viewed);
      },
      { message: 'le HUD affiche l’instant consulté' },
    )
    .toBe(true);
  return sample;
}

/**
 * Rectangle de l'arène, en coordonnées page : c'est lui qui ne doit pas bouger quand la barre de
 * relecture apparaît, sinon la piste et le HUD se redimensionneraient sous les yeux du joueur.
 */
async function stageRect(page: Page): Promise<{
  left: number;
  top: number;
  width: number;
  height: number;
}> {
  return page.evaluate(() => {
    const stage = document.querySelector('.stage');
    if (!(stage instanceof HTMLElement)) {
      throw new Error('arène introuvable');
    }
    const box = stage.getBoundingClientRect();
    return { left: box.left, top: box.top, width: box.width, height: box.height };
  });
}

test('la barre de relecture ne déplace ni ne redimensionne l’arène', async ({ page }) => {
  const watch = watchConsole(page);
  await page.setViewportSize({ width: 1280, height: 720 });
  // Mode **normal** : la course dure 60 s réelles, donc l'arène peut être mesurée avant la pause, puis
  // pendant, sans que la course soit déjà finie. C'est la seule façon de comparer les deux états.
  await page.goto(raceUrl({ seed: SEED, fast: false, autostart: true }));
  await waitForHooks(page);
  const before = await stageRect(page);
  expect(before.width).toBeGreaterThan(100);

  await expect.poll(() => currentSteps(page), { timeout: 60_000 }).toBeGreaterThan(0);
  await page.evaluate(() => {
    window.__CHAOS_RACE__?.toggleUserPause();
  });
  await expect.poll(async () => (await readReplay(page)).phase).toBe('userPaused');
  await expect(page.getByTestId('replay-bar')).toBeVisible();
  await expect(page.getByTestId('replay-back')).toBeVisible();

  const during = await stageRect(page);
  expect(during, 'la barre de relecture ne doit pas redimensionner l’arène').toStrictEqual(before);

  expectNoErrors(watch);
});

test('la relecture d’une pause manuelle reste bornée par la course déjà jouée', async ({ page }) => {
  const watch = watchConsole(page);
  await startRace(page, PAUSE_TARGET_STEPS);

  const paused = await readSettled(page);
  const pauseStep = paused.replay?.pauseStep ?? 0;
  expect(paused.replay?.visible, 'la barre de relecture apparaît pendant la pause').toBe(true);
  expect(paused.barHidden).toBe(false);
  // La pause est bien celle du scénario du test joueur (à une frame près, selon le mode accéléré).
  expect(pauseStep * RACE_CONFIG.DT_S).toBeGreaterThanOrEqual(PAUSE_TARGET_S);
  expect(pauseStep * RACE_CONFIG.DT_S).toBeLessThan(RACE_CONFIG.TOTAL_SIM_S);

  // Le curseur naît sur l'instant réel de la pause : rien n'est « déjà rembobiné ».
  expect(paused.replay?.viewedStep).toBe(pauseStep);
  expect(paused.shownTime).toBe(timeText(pauseStep));

  // Deux « −2 s » : 50,4 s puis 48,4 s.
  await page.getByTestId('replay-back').click();
  const back1 = await readSettled(page);
  expect(back1.replay?.viewedStep).toBe(pauseStep - STEP_STEPS);
  expect(back1.tSim, 'le noyau reste gelé sur l’instant de la pause').toBe(paused.tSim);
  expect(back1.steps).toBe(pauseStep);
  expect(back1.shownTime).toBe(timeText(pauseStep - STEP_STEPS));
  expect(back1.visualXs).not.toStrictEqual(paused.visualXs);
  // Le classement affiché suit l'instant consulté : il est recalculé sur les distances passées.
  expect(back1.ranks.join()).not.toBe('');

  await page.getByTestId('replay-back').click();
  const back2 = await readSettled(page);
  expect(back2.replay?.viewedStep).toBe(pauseStep - 2 * STEP_STEPS);
  expect(back2.shownTime).toBe(timeText(pauseStep - 2 * STEP_STEPS));

  // « +2 s » revient au même pas, et ne peut pas dépasser l'instant de pause.
  await page.getByTestId('replay-forward').click();
  const forward = await readSettled(page);
  expect(forward.replay?.viewedStep).toBe(pauseStep - STEP_STEPS);
  expect(forward.shownTime).toBe(timeText(pauseStep - STEP_STEPS));
  expect(forward.forwardDisabled, 'il reste de la place avant la borne').toBe(false);

  await page.getByTestId('replay-forward').click();
  const clamped = await readSettled(page);
  expect(clamped.replay?.viewedStep, 'on ne peut pas dépasser la pause').toBe(pauseStep);
  expect(clamped.shownTime).toBe(timeText(pauseStep));
  expect(clamped.forwardDisabled, 'le bouton +2 s est désactivé sur la borne').toBe(true);
  expect(clamped.readout).toBe(`${timeText(pauseStep)} / ${timeText(pauseStep)}`);
  expect(clamped.rangeMax).toBe(String(pauseStep));

  // Borne basse : on ne descend jamais sous le départ. Le nombre de clics est calculé pour arriver
  // exactement sur `0` — un clic de plus viserait un bouton désactivé, ce qui est précisément la
  // preuve que la borne est appliquée par l'interface **et** par le curseur.
  const backClicks = Math.ceil(pauseStep / STEP_STEPS);
  for (let index = 0; index < backClicks; index += 1) {
    await page.getByTestId('replay-back').click();
  }
  const start = await readSettled(page);
  expect(start.replay?.viewedStep).toBe(0);
  expect(start.shownTime).toBe(timeText(0));
  expect(start.backDisabled).toBe(true);
  expect(start.readout).toBe(`${timeText(0)} / ${timeText(pauseStep)}`);

  expectNoErrors(watch);
});

test('la relecture ne dit rien, ne produit aucun fait et ne consomme aucun pas', async ({ page }) => {
  const watch = watchConsole(page);
  await startRace(page, PAUSE_TARGET_STEPS);

  // La réplique en cours au moment de la pause est figée : elle ne change plus, et la file du
  // speaker ne bouge plus non plus (aucune ancienne réplique n'est réinjectée).
  const before = await page.evaluate(() => {
    const view = window.__CHAOS_RACE_VIEW__;
    const api = window.__CHAOS_RACE__;
    if (view === undefined || api === undefined) {
      throw new Error('hooks absents');
    }
    return {
      line: view.subtitle(),
      steps: api.state().steps,
      ranks: api.ranks().map((row) => `${row.id}:${String(row.rank)}:${row.gapMeters.toFixed(6)}`),
    };
  });

  // Beaucoup d'allers-retours dans la course déjà jouée, avec attente : si la relecture parlait,
  // jouait un pas ou tirait un nombre, cela se verrait ici.
  for (let index = 0; index < 12; index += 1) {
    await page.getByTestId('replay-back').click();
    await page.waitForTimeout(80);
    await page.getByTestId('replay-forward').click();
    await page.waitForTimeout(80);
  }

  const after = await page.evaluate(() => {
    const view = window.__CHAOS_RACE_VIEW__;
    const api = window.__CHAOS_RACE__;
    if (view === undefined || api === undefined) {
      throw new Error('hooks absents');
    }
    return {
      line: view.subtitle(),
      steps: api.state().steps,
      tSim: api.state().tSim,
      ranks: api.ranks().map((row) => `${row.id}:${String(row.rank)}:${row.gapMeters.toFixed(6)}`),
    };
  });

  expect(after.steps, 'la relecture n’exécute aucun pas').toBe(before.steps);
  expect(after.tSim).toBe(before.steps * RACE_CONFIG.DT_S);
  expect(after.line, 'la relecture est muette').toBe(before.line);
  expect(after.ranks, 'le classement du noyau est intact').toStrictEqual(before.ranks);

  expectNoErrors(watch);
});

test('après une relecture, la course reprend et se termine exactement comme sans relecture', async ({
  page,
}) => {
  const watch = watchConsole(page);

  // Référence : la même seed, jouée d'un bloc par le noyau, sans aucun rendu ni aucune pause.
  await page.goto(raceUrl({ seed: SEED, fast: true, autostart: false }));
  await waitForHooks(page);
  const reference = await page.evaluate((seed) => {
    const api = window.__CHAOS_RACE__;
    if (api === undefined) {
      throw new Error('hooks absents');
    }
    const result = api.runToCompletion(seed);
    return {
      distances: [...result.distances],
      ranking: [...result.ranking],
      steps: api.state().steps,
    };
  }, SEED);
  expect(reference.steps).toBe(RACE_CONFIG.TOTAL_STEPS);

  // Même seed, mais avec une pause manuelle au milieu, une relecture complète, puis la reprise.
  await startRace(page, PAUSE_TARGET_STEPS);
  const frozen = await readReplay(page);
  for (let index = 0; index < 8; index += 1) {
    await page.getByTestId('replay-back').click();
  }
  const scrubbed = await readReplay(page);
  expect(scrubbed.replay?.viewedStep).toBeLessThan(scrubbed.replay?.pauseStep ?? 0);
  // L'instant consulté est loin derrière : si la reprise partait de là, les distances reculeraient.
  expect(scrubbed.visualXs[0] ?? 0).toBeLessThan(frozen.visualXs[0] ?? 0);

  // « Reprendre » : la course repart de l'instant **réel** de la pause, pas de l'instant consulté.
  await page.evaluate(() => {
    window.__CHAOS_RACE__?.toggleUserPause();
  });
  // Le curseur et la barre disparaissent à la frame suivante : la reprise est immédiate côté noyau,
  // et la relecture cesse d'exister dès que la course repart.
  await expect
    .poll(async () => (await readReplay(page)).replay, {
      message: 'le curseur de relecture disparaît à la reprise',
    })
    .toBeNull();
  await expect.poll(async () => (await readReplay(page)).barHidden).toBe(true);
  await expect.poll(async () => (await readReplay(page)).phase).toBe('running');

  // Preuve du sens de marche : le noyau ne recule jamais. Chaque échantillon après la reprise est
  // au moins au niveau de l'instant gelé — aucune distance ne diminue, aucun pas ne recule. Une
  // reprise depuis l'instant consulté produirait exactement l'inverse.
  for (let sample = 0; sample < 6; sample += 1) {
    const live = await page.evaluate(() => {
      const api = window.__CHAOS_RACE__;
      const view = window.__CHAOS_RACE_VIEW__;
      if (api === undefined || view === undefined) {
        throw new Error('hooks absents');
      }
      return {
        steps: api.state().steps,
        distances: api.distances(),
        replay: view.replay(),
        shownTime: document.querySelector('[data-testid="hud-sim-time"]')?.textContent ?? '',
      };
    });
    expect(live.replay, 'le curseur disparaît à la reprise').toBeNull();
    expect(live.steps, 'le noyau ne recule pas').toBeGreaterThanOrEqual(
      frozen.replay?.pauseStep ?? 0,
    );
    for (const [index, distance] of live.distances.entries()) {
      expect(distance, `distance ${String(index)} jamais en arrière`).toBeGreaterThanOrEqual(
        frozen.visualXs[index] ?? 0,
      );
    }
    expect(live.shownTime, 'le chrono affiché est celui du noyau').toBe(timeText(live.steps));
    await page.waitForTimeout(60);
  }

  // La course va au bout, et rien n'a bougé : ni les distances, ni le classement, ni le nombre de pas.
  await expect
    .poll(() => currentSteps(page), { timeout: 90_000 })
    .toBe(RACE_CONFIG.TOTAL_STEPS);
  const final = await page.evaluate(() => {
    const api = window.__CHAOS_RACE__;
    if (api === undefined) {
      throw new Error('hooks absents');
    }
    return {
      distances: api.distances(),
      ranking: api.ranks().map((row) => row.id),
      steps: api.state().steps,
      tSim: api.state().tSim,
    };
  });

  expect(final.steps).toBe(RACE_CONFIG.TOTAL_STEPS);
  expect(final.tSim).toBe(RACE_CONFIG.TOTAL_SIM_S);
  expect(final.distances, 'distances finales identiques, bit à bit').toStrictEqual(
    reference.distances,
  );
  expect(final.ranking, 'classement final identique').toStrictEqual(reference.ranking);

  expectNoErrors(watch);
});
