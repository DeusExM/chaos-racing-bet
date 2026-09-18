import { expect, test, type Page } from '@playwright/test';

import { CHARACTER_IDS } from '../../src/core/characters';
import { characterHeightPx } from '../../src/render/viewConfig';
import { REPLAY_STEP_STEPS } from '../../src/render/view/replayModel';
import { expectNoErrors, raceUrl, waitForHooks, watchConsole } from './helpers';

/**
 * Disposition réelle d'un téléphone en paysage (passe responsive issue du test sur iPhone).
 *
 * ## Ce que le test joueur reprochait au layout précédent
 *
 * À 844×390, l'arène ne faisait plus que 522×294 au milieu de l'écran : ≈ 150 px de vide à gauche
 * **et** à droite, un titre qui consommait de la hauteur, les commandes sous la piste et le
 * classement masqué faute de place. L'interface était donc trop petite, et trop d'espace était perdu.
 *
 * ## Ce que ce test exige, dans l'ordre de la demande
 *
 * 1. le titre est **masqué** ;
 * 2. la piste commence au bord gauche, occupe toute la hauteur, et **aucune marge** ne la sépare du
 *    bord : il n'y a pas de bande vide à gauche ;
 * 3. la seule zone réservée est une **colonne à droite**, entre 30 % et 36 % de la largeur ;
 * 4. la ligne d'état (état · segment · chrono · son · commentateur) tient sur **une seule ligne** ;
 * 5. le classement est dans la colonne, au-dessus du speaker ;
 * 6. le speaker est sous le classement et ne recouvre jamais une voie ;
 * 7. les commandes sont au bas de la colonne, tactiles, et ne prennent aucune place hors de la
 *    colonne ;
 * 8. les personnages sont **plus grands** qu'au format de bureau, les six voies restent visibles et
 *    séparées.
 *
 * Toutes les mesures sont prises **dans la page, en une seule tâche**, pendant une course réelle :
 * une mesure Playwright par élément serait décalée par les frames suivantes.
 */

const SEED = 'KR7Z8NAR';

const VIEWPORTS = [
  { name: '844×390 (iPhone 12/13 paysage)', width: 844, height: 390 },
  { name: '926×428 (iPhone 14 Pro Max paysage)', width: 926, height: 428 },
] as const;

interface Box {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

interface CompactLayout {
  readonly viewport: { readonly width: number; readonly height: number };
  readonly shell: Box;
  readonly stage: Box;
  readonly canvas: Box;
  readonly hud: Box;
  readonly head: Box | null;
  readonly status: Box;
  readonly time: Box;
  readonly settings: Box;
  readonly topline: Box;
  readonly leaderboard: Box;
  readonly subtitle: Box | null;
  readonly seed: Box;
  readonly controls: Box;
  readonly buttons: readonly { readonly id: string; readonly box: Box }[];
  readonly logicalArenaWidth: number;
  readonly logicalArenaHeight: number;
  readonly trackWidth: number;
  readonly compact: boolean;
  /** Vrai si aucun libellé de la ligne d'état n'est tronqué (points de suspension). */
  readonly toplineFits: boolean;
  /** Largeurs réelles de la ligne d'état (`scrollWidth/clientWidth`), pour dater un échec. */
  readonly toplineWidths: string;
  readonly sprites: readonly {
    readonly id: string;
    readonly screenY: number;
    readonly height: number;
    readonly drawn: boolean;
  }[];
}

/** Mesure la disposition courante, dans le repère du viewport. */
async function measure(page: Page): Promise<CompactLayout> {
  return page.evaluate(async () => {
    const view = window.__CHAOS_RACE_VIEW__;
    const api = window.__CHAOS_RACE__;
    if (view === undefined || api === undefined) {
      throw new Error('hooks absents');
    }

    // La course est lancée par ce même appel : les mesures décrivent donc un état de course réel, et
    // non l'écran d'avant-course (où le speaker n'a encore rien dit).
    api.start();
    await new Promise<void>((resolve) => {
      const deadline = performance.now() + 20_000;
      const tick = (): void => {
        if (api.state().steps >= 600 || performance.now() > deadline) {
          resolve();
          return;
        }
        requestAnimationFrame(tick);
      };
      tick();
    });

    const box = (selector: string): Box | null => {
      const element = document.querySelector(selector);
      if (element === null) {
        return null;
      }
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      };
    };
    const required = (selector: string): Box => {
      const found = box(selector);
      if (found === null) {
        throw new Error(`élément absent : ${selector}`);
      }
      return found;
    };

    const track = view.track();
    // Aucun libellé de la ligne d'état ne doit être réduit à des points de suspension : la ligne est
    // unique, mais elle doit rester **lisible** — c'est ce qui justifie la largeur de la colonne.
    const fits = (element: Element | null): boolean =>
      element instanceof HTMLElement && element.scrollWidth <= element.clientWidth + 1;
    const toplineItems: readonly [string, Element | null][] = [
      ['état', document.querySelector('[data-testid="race-status"]')],
      ['chrono', document.querySelector('[data-testid="hud-time"]')],
      ...Array.from(document.querySelectorAll('.hud-settings-toggle-label')).map(
        (label, index): [string, Element | null] => [`réglage ${String(index + 1)}`, label],
      ),
    ];
    const toplineFits = toplineItems.every(([, element]) => fits(element));
    const toplineWidths = toplineItems
      .map(([name, element]) =>
        element instanceof HTMLElement
          ? `${name} ${String(element.scrollWidth)}/${String(element.clientWidth)}`
          : `${name} absent`,
      )
      .join(', ');

    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      shell: required('.shell'),
      stage: required('.stage'),
      canvas: required('#game canvas'),
      hud: required('.hud'),
      head: box('.head'),
      status: required('[data-testid="race-status"]'),
      time: required('[data-testid="hud-time"]'),
      settings: required('[data-testid="settings"]'),
      topline: required('.hud-topline'),
      leaderboard: required('[data-testid="leaderboard"]'),
      subtitle: box('[data-testid="subtitle"]'),
      seed: required('[data-testid="hud-seed"]'),
      controls: required('.controls'),
      buttons: ['start-button', 'pause-button', 'replay-button'].map((id) => ({
        id,
        box: required(`[data-testid="${id}"]`),
      })),
      logicalArenaWidth: track.arenaWidth,
      logicalArenaHeight: track.arenaHeight,
      trackWidth: track.trackWidth,
      compact: track.compact,
      toplineFits,
      toplineWidths,
      sprites: view.sprites().map((sprite) => ({
        id: sprite.id,
        screenY: sprite.screenY,
        height: sprite.height,
        drawn: sprite.drawn,
      })),
    };
  });
}

/** Vrai si les deux rectangles se recouvrent réellement (tolérance de 1 px). */
function overlaps(a: Box, b: Box): boolean {
  return a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
}

for (const viewport of VIEWPORTS) {
  test(`la piste occupe l’écran et le HUD tient dans une colonne en ${viewport.name}`, async ({
    page,
  }) => {
    const watch = watchConsole(page);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto(raceUrl({ seed: SEED, fast: true, autostart: false }));
    await waitForHooks(page);
    const layout = await measure(page);

    expect(layout.compact, 'le format petit paysage est actif').toBe(true);

    // 1) Le titre (et le sous-titre) ne prennent plus aucune hauteur.
    expect(layout.head, 'l’en-tête est retiré du flux').not.toBeNull();
    expect(layout.head?.height ?? 0, 'le titre ne prend aucune hauteur').toBeLessThanOrEqual(1);

    // 2) Aucune marge extérieure : la piste touche le bord gauche et le haut, et occupe toute la
    // hauteur de l'écran. C'est la fin de la « bande vide à gauche » signalée par le test joueur.
    expect(layout.canvas.left, 'la piste commence au bord gauche').toBeLessThanOrEqual(2);
    expect(layout.canvas.top, 'la piste commence en haut').toBeLessThanOrEqual(2);
    expect(layout.canvas.height, 'la piste occupe toute la hauteur').toBeGreaterThanOrEqual(
      layout.shell.height - 2,
    );
    expect(layout.canvas.bottom).toBeLessThanOrEqual(layout.viewport.height + 1);
    expect(layout.stage.height, 'l’arène occupe l’écran').toBeGreaterThanOrEqual(
      layout.shell.height - 2,
    );

    // 3) Une seule zone réservée : la colonne de droite, entre 30 % et 36 % de la largeur.
    const column = layout.shell.width - layout.canvas.width;
    expect(column / layout.shell.width, 'la colonne de droite mesure 30 à 36 %').toBeGreaterThanOrEqual(
      0.29,
    );
    expect(column / layout.shell.width).toBeLessThanOrEqual(0.36);
    expect(layout.controls.left, 'les commandes vivent dans la colonne').toBeGreaterThanOrEqual(
      layout.canvas.right - 1,
    );

    // 4) La ligne d'état tient sur une seule ligne : état, segment/chrono et réglages partagent la
    // même bande verticale, et se lisent de gauche à droite dans l'ordre demandé.
    expect(
      Math.max(layout.status.top, layout.time.top, layout.settings.top),
      'état, chrono et réglages sont sur la même ligne',
    ).toBeLessThan(Math.min(layout.status.bottom, layout.time.bottom, layout.settings.bottom));
    expect(layout.status.left).toBeLessThan(layout.time.left);
    expect(layout.time.left).toBeLessThan(layout.settings.left);
    expect(layout.topline.height, 'la ligne d’état reste une ligne').toBeLessThanOrEqual(
      Math.max(layout.status.height, layout.time.height, layout.settings.height) + 6,
    );
    expect(
      layout.toplineFits,
      `aucun libellé de la ligne d’état n’est tronqué (${layout.toplineWidths})`,
    ).toBe(true);

    // 5) Aucun bloc textuel du HUD ne se superpose à la piste : tout commence à droite du canvas.
    for (const [name, element] of [
      ['ligne d’état', layout.topline],
      ['classement', layout.leaderboard],
      ['seed', layout.seed],
    ] as const) {
      expect(element.left, `${name} ne recouvre pas la piste`).toBeGreaterThanOrEqual(
        layout.canvas.right - 1,
      );
      expect(element.right, `${name} reste dans l’écran`).toBeLessThanOrEqual(
        layout.viewport.width + 1,
      );
    }
    if (layout.subtitle !== null) {
      expect(layout.subtitle.left, 'le speaker ne recouvre pas la piste').toBeGreaterThanOrEqual(
        layout.canvas.right - 1,
      );
      expect(overlaps(layout.subtitle, layout.leaderboard), 'le speaker est sous le classement').toBe(
        false,
      );
      expect(layout.subtitle.top, 'le speaker est bien sous le classement').toBeGreaterThanOrEqual(
        layout.leaderboard.bottom - 1,
      );
      expect(layout.subtitle.bottom, 'le speaker reste dans l’écran').toBeLessThanOrEqual(
        layout.viewport.height + 1,
      );
    }

    // 6) Ordre vertical de la colonne : état, classement, speaker, commandes.
    expect(layout.leaderboard.top, 'le classement est sous la ligne d’état').toBeGreaterThanOrEqual(
      layout.topline.bottom - 1,
    );
    expect(layout.controls.top, 'les commandes sont sous le reste').toBeGreaterThan(
      layout.leaderboard.bottom,
    );
    expect(layout.controls.bottom, 'les commandes sont au bas de l’écran').toBeGreaterThanOrEqual(
      layout.viewport.height - 2,
    );

    // 7) Commandes tactiles, dans la colonne, sur deux rangées (Lancer · Pause, puis Rejouer).
    for (const button of layout.buttons) {
      expect(button.box.height, `${button.id} est tactile`).toBeGreaterThanOrEqual(36);
      expect(button.box.width, `${button.id} est tactile`).toBeGreaterThanOrEqual(60);
      expect(button.box.left, `${button.id} est dans la colonne`).toBeGreaterThanOrEqual(
        layout.canvas.right - 1,
      );
      expect(button.box.right, `${button.id} reste dans l’écran`).toBeLessThanOrEqual(
        layout.viewport.width + 1,
      );
    }
    const [start, pause, replay] = layout.buttons;
    expect(start?.box.top ?? 0).toBeCloseTo(pause?.box.top ?? 0, 0);
    expect(replay?.box.top ?? 0, '« Rejouer » est sur sa propre rangée').toBeGreaterThanOrEqual(
      (start?.box.bottom ?? 0) - 1,
    );

    // 8) Les personnages sont plus grands qu'au format de bureau, et les six voies restent séparées.
    const scale = layout.canvas.width / layout.logicalArenaWidth;
    const spriteHeight = layout.sprites[0]?.height ?? 0;
    expect(spriteHeight, 'la hauteur de rendu est celle du format compact').toBeCloseTo(
      characterHeightPx(true),
      0,
    );
    expect(characterHeightPx(true)).toBeGreaterThan(characterHeightPx(false));
    expect(
      spriteHeight * scale,
      'un personnage affiché mesure au moins 42 px CSS',
    ).toBeGreaterThanOrEqual(42);

    expect(layout.sprites, 'les six voies sont suivies').toHaveLength(CHARACTER_IDS.length);
    const laneYs = [...layout.sprites].map((sprite) => sprite.screenY).sort((a, b) => a - b);
    for (const [index, laneY] of laneYs.entries()) {
      expect(laneY - spriteHeight / 2, 'aucune voie ne sort par le haut').toBeGreaterThanOrEqual(
        -spriteHeight * 0.15,
      );
      expect(laneY + spriteHeight / 2, 'aucune voie ne sort par le bas').toBeLessThanOrEqual(
        layout.logicalArenaHeight + spriteHeight * 0.15,
      );
      if (index > 0) {
        expect(
          laneY - (laneYs[index - 1] ?? 0),
          'deux voies voisines ne se chevauchent pas',
        ).toBeGreaterThanOrEqual(spriteHeight);
      }
    }

    expectNoErrors(watch);
  });
}

/**
 * La barre de relecture (pause manuelle) tient dans la colonne.
 *
 * Elle apparaît sous les trois boutons, donc **dans** la colonne de droite : elle ne doit ni sortir de
 * l'écran, ni recouvrir la seed, ni pousser les commandes hors du bas. Le contrôle est fait pendant
 * une vraie pause, et le pas reculé est relu sur le hook du rendu — la barre ne peut pas mentir sur
 * l'instant qu'elle consulte.
 */
test('la barre de relecture tient dans la colonne de droite en 844×390', async ({ page }) => {
  const watch = watchConsole(page);
  await page.setViewportSize({ width: 844, height: 390 });
  await page.goto(raceUrl({ seed: SEED, fast: true, autostart: false }));
  await waitForHooks(page);

  await page.evaluate(() => {
    const api = window.__CHAOS_RACE__;
    if (api === undefined) {
      throw new Error('hooks absents');
    }
    const tick = (): void => {
      if (api.state().steps >= 1200) {
        api.toggleUserPause();
        return;
      }
      requestAnimationFrame(tick);
    };
    tick();
    api.start();
  });
  await expect
    .poll(async () => page.evaluate(() => window.__CHAOS_RACE__?.phase() ?? ''))
    .toBe('userPaused');
  await expect(page.getByTestId('replay-bar')).toBeVisible();

  const measured = await page.evaluate(() => {
    const box = (selector: string): Box => {
      const element = document.querySelector(selector);
      if (element === null) {
        throw new Error(`élément absent : ${selector}`);
      }
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      };
    };
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      canvas: box('#game canvas'),
      bar: box('[data-testid="replay-bar"]'),
      controls: box('.controls'),
      seed: box('[data-testid="hud-seed"]'),
      speaker: box('[data-testid="subtitle"]'),
      viewedStep: window.__CHAOS_RACE_VIEW__?.replay()?.viewedStep ?? -1,
      hudPaddingBottom:
        document.querySelector('.hud') === null
          ? ''
          : getComputedStyle(document.querySelector('.hud') as HTMLElement).paddingBottom,
      reserved: getComputedStyle(document.documentElement).getPropertyValue('--hud-mobile-controls'),
    };
  });

  // La barre est dans la colonne : à droite de la piste, et entièrement dans l'écran.
  expect(measured.bar.left, 'la barre est dans la colonne').toBeGreaterThanOrEqual(
    measured.canvas.right - 1,
  );
  expect(measured.bar.right).toBeLessThanOrEqual(measured.viewport.width + 1);
  expect(measured.controls.bottom, 'les commandes restent dans l’écran').toBeLessThanOrEqual(
    measured.viewport.height + 1,
  );
  expect(
    overlaps(measured.controls, measured.seed),
    `la seed reste visible sous la pause (contrôles ${measured.controls.top.toFixed(1)}→${measured.controls.bottom.toFixed(1)}, seed ${measured.seed.top.toFixed(1)}→${measured.seed.bottom.toFixed(1)}, réserve ${measured.hudPaddingBottom}, barre ${measured.bar.height.toFixed(1)})`,
  ).toBe(false);
  expect(
    overlaps(measured.controls, measured.speaker),
    'le speaker n’est pas recouvert par les commandes',
  ).toBe(false);

  // La barre est utilisable : « −2 s » recule réellement le curseur, et la course reste gelée.
  await page.getByTestId('replay-back').click();
  const afterBack = await page.evaluate(() => ({
    viewedStep: window.__CHAOS_RACE_VIEW__?.replay()?.viewedStep ?? -1,
    pauseStep: window.__CHAOS_RACE_VIEW__?.replay()?.pauseStep ?? -1,
    phase: window.__CHAOS_RACE__?.phase() ?? '',
  }));
  expect(afterBack.phase).toBe('userPaused');
  expect(afterBack.viewedStep).toBe(
    Math.max(0, Math.min(measured.viewedStep, afterBack.pauseStep) - REPLAY_STEP_STEPS),
  );

  expectNoErrors(watch);
});
