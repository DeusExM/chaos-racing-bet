import { expect, test, type Page } from '@playwright/test';

import { CHARACTERS, CHARACTER_IDS } from '../../src/core/characters';
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
  /** Nombre de blocs qui affichent la seed : il doit valoir 1 (aucun doublon). */
  readonly seedDisplays: number;
  readonly galleryButton: Box;
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
    readonly screenX: number;
    readonly screenY: number;
    readonly nameX: number;
    readonly nameY: number;
    readonly nameDepth: number;
    readonly depth: number;
    readonly width: number;
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
      /** Nombre de blocs qui affichent la seed : il doit valoir 1 (aucun doublon). */
      seedDisplays: document.querySelectorAll('.seed, [data-testid="hud-seed"]').length,
      galleryButton: required('[data-testid="gallery-button"]'),
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
        screenX: sprite.screenX,
        screenY: sprite.screenY,
        nameX: sprite.nameX,
        nameY: sprite.nameY,
        nameDepth: sprite.nameDepth,
        depth: sprite.depth,
        width: sprite.width,
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
      ['bouton persos', layout.galleryButton],
    ] as const) {
      expect(element.left, `${name} ne recouvre pas la piste`).toBeGreaterThanOrEqual(
        layout.canvas.right - 1,
      );
      expect(element.right, `${name} reste dans l’écran`).toBeLessThanOrEqual(
        layout.viewport.width + 1,
      );
    }

    // 5 bis) La seed n'est affichée qu'**une** fois : le doublon déclaré dans `index.html` a été
    // supprimé, et le bloc du HUD (dans la colonne) est le seul porteur — il n'y a donc rien à
    // afficher deux fois, ni en haut à gauche de la piste, ni ailleurs.
    expect(layout.seedDisplays, 'un seul affichage de seed').toBe(1);
    expect(layout.seed.left, 'la seed est dans la colonne, pas sur la piste').toBeGreaterThanOrEqual(
      layout.canvas.right - 1,
    );
    // Le bouton « persos » est à côté de la seed, sur la même rangée, sans la recouvrir.
    expect(
      overlaps(layout.galleryButton, layout.seed),
      'le bouton persos ne recouvre pas la seed',
    ).toBe(false);
    expect(
      Math.abs(layout.galleryButton.top - layout.seed.top),
      'le bouton persos est sur la rangée de la seed',
    ).toBeLessThanOrEqual(6);
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

    // 7) Commandes tactiles, dans la colonne, sur **une seule rangée** (Lancer · Pause · Rejouer), et
    // la bande réservée sous elles ne garde pas la place d'une barre de relecture absente.
    for (const button of layout.buttons) {
      expect(button.box.height, `${button.id} est tactile`).toBeGreaterThanOrEqual(34);
      expect(button.box.height, `${button.id} reste compact`).toBeLessThanOrEqual(40);
      expect(button.box.width, `${button.id} est tactile`).toBeGreaterThanOrEqual(60);
      expect(button.box.left, `${button.id} est dans la colonne`).toBeGreaterThanOrEqual(
        layout.canvas.right - 1,
      );
      expect(button.box.right, `${button.id} reste dans l’écran`).toBeLessThanOrEqual(
        layout.viewport.width + 1,
      );
    }
    const [start, pause, replay] = layout.buttons;
    expect(start?.box.top ?? 0, '« Lancer » et « Pause » sont sur la même rangée').toBeCloseTo(
      pause?.box.top ?? 0,
      0,
    );
    expect(replay?.box.top ?? 0, '« Rejouer » est sur la même rangée').toBeCloseTo(
      start?.box.top ?? 0,
      0,
    );
    expect(start?.box.left ?? 0, '« Lancer » est à gauche').toBeLessThan(pause?.box.left ?? 0);
    expect(pause?.box.left ?? 0, '« Rejouer » est à droite').toBeLessThan(replay?.box.left ?? 0);
    expect(
      layout.controls.height,
      'la bande des commandes se limite aux boutons quand la relecture est masquée',
    ).toBeLessThanOrEqual(48);
    expect(
      overlaps(layout.controls, layout.seed),
      'les commandes ne recouvrent pas la seed',
    ).toBe(false);

    // 8) Les personnages sont plus grands qu'au format de bureau, et les six voies restent séparées.
    const scale = layout.canvas.width / layout.logicalArenaWidth;
    const spriteHeight = layout.sprites[0]?.height ?? 0;
    expect(spriteHeight, 'la hauteur de rendu est celle du format compact').toBeCloseTo(
      characterHeightPx(true),
      0,
    );
    expect(characterHeightPx(true), 'fourchette demandée sur téléphone').toBeGreaterThanOrEqual(104);
    expect(characterHeightPx(true), 'fourchette demandée sur téléphone').toBeLessThanOrEqual(106);
    expect(characterHeightPx(true)).toBeGreaterThan(characterHeightPx(false));
    expect(
      spriteHeight * scale,
      'un personnage affiché mesure au moins 55 px CSS',
    ).toBeGreaterThanOrEqual(55);

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

    // 9) Le nom vit **dans** la voie, sur l'axe du personnage, et **derrière lui au sens de la
    // course** — à sa gauche, puisque la course va de gauche à droite. Il ne réserve donc aucune
    // hauteur au-dessus du sprite, et il n'est jamais recouvert par l'illustration : c'est ce qui
    // autorise la taille ci-dessus.
    for (const sprite of layout.sprites) {
      expect(sprite.nameY, `le nom de ${sprite.id} est sur l’axe du personnage`).toBeCloseTo(
        sprite.screenY,
        3,
      );
      expect(
        sprite.nameX,
        `le nom de ${sprite.id} s’arrête avant le début du sprite`,
      ).toBeLessThanOrEqual(sprite.screenX - sprite.width / 2);
      expect(
        sprite.screenX - sprite.width / 2 - sprite.nameX,
        `un espace sépare le nom de ${sprite.id} de son sprite`,
      ).toBeGreaterThanOrEqual(1);
      expect(
        sprite.nameDepth,
        `le nom de ${sprite.id} n’est pas derrière le sprite en profondeur`,
      ).toBeGreaterThan(sprite.depth);
    }

    expectNoErrors(watch);
  });
}

/**
 * La barre de relecture (pause manuelle) prend sa place dans la colonne.
 *
 * Elle apparaît **sous** la rangée des trois boutons, donc dans la colonne de droite : elle ne doit
 * ni sortir de l'écran, ni recouvrir la seed, le speaker ou les boutons, ni pousser les commandes
 * hors du bas. La place qu'elle occupe est réservée pendant qu'elle est là (`:has`), ce que le test
 * vérifie en comparant la hauteur réservée à celle de la barre. Le pas reculé, lui, est relu sur le
 * hook du rendu — la barre ne peut pas mentir sur l'instant qu'elle consulte.
 */
test('la barre de relecture prend sa place dans la colonne en 844×390', async ({ page }) => {
  const watch = watchConsole(page);
  await page.setViewportSize({ width: 844, height: 390 });
  await page.goto(raceUrl({ seed: SEED, fast: true, autostart: false }));
  await waitForHooks(page);

  /** Mesure la bande des commandes, la barre et ses voisins immédiats. */
  const readCommands = async (): Promise<{
    readonly controls: Box;
    readonly bar: Box | null;
    readonly range: Box | null;
    readonly seed: Box;
    readonly speaker: Box;
    readonly buttons: readonly Box[];
    readonly reserved: string;
  }> =>
    page.evaluate(() => {
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
      return {
        controls: required('.controls'),
        bar: box('[data-testid="replay-bar"]'),
        range: box('[data-testid="replay-range"]'),
        seed: required('[data-testid="hud-seed"]'),
        speaker: required('[data-testid="subtitle"]'),
        buttons: ['start-button', 'pause-button', 'replay-button'].map((id) =>
          required(`[data-testid="${id}"]`),
        ),
        reserved: getComputedStyle(document.documentElement).getPropertyValue(
          '--hud-mobile-controls',
        ),
      };
    });

  // Avant la pause : aucune barre, et la bande des commandes se limite à la rangée de boutons (pas de
  // place laissée vide pour une barre absente).
  const idle = await readCommands();
  expect(idle.bar?.height ?? 0, 'la barre est masquée hors pause').toBe(0);
  expect(idle.controls.height, 'aucune bande vide pour la barre absente').toBeLessThanOrEqual(48);
  const idleButtonsMargin = 390 - Math.max(...idle.buttons.map((button) => button.bottom));
  expect(
    idleButtonsMargin,
    `la rangée de boutons est remontée du bord bas (marge ${idleButtonsMargin.toFixed(1)} px)`,
  ).toBeGreaterThanOrEqual(8);

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

  const paused = await readCommands();
  const bar = paused.bar;
  expect(bar, 'la barre est affichée pendant la pause').not.toBeNull();
  if (bar === null) {
    throw new Error('barre absente pendant la pause');
  }

  // La barre est dans la colonne : à droite de la piste, et entièrement dans l'écran.
  expect(paused.controls.bottom, 'les commandes restent dans l’écran').toBeLessThanOrEqual(
    390 + 1,
  );
  expect(bar.left).toBeGreaterThanOrEqual(0);
  expect(bar.right).toBeLessThanOrEqual(844 + 1);
  expect(bar.height, 'la barre a sa vraie hauteur').toBeGreaterThanOrEqual(20);

  // Elle ne recouvre **rien** : ni les boutons (elle est en dessous), ni la seed, ni le speaker.
  for (const [name, neighbour] of [
    ['la seed', paused.seed],
    ['le speaker', paused.speaker],
  ] as const) {
    expect(
      overlaps(paused.controls, neighbour),
      `les commandes ne recouvrent pas ${name} (réserve ${paused.reserved})`,
    ).toBe(false);
  }
  expect(overlaps(bar, paused.seed), 'la barre ne recouvre pas la seed').toBe(false);
  expect(overlaps(bar, paused.speaker), 'la barre ne recouvre pas le speaker').toBe(false);
  for (const [index, button] of paused.buttons.entries()) {
    expect(overlaps(bar, button), `la barre ne recouvre pas le bouton ${String(index)}`).toBe(false);
    expect(bar.top, 'la barre est sous les boutons').toBeGreaterThanOrEqual(button.bottom - 1);
  }
  // La place réservée a grandi pour elle : la barre passe de la rangée de boutons à la colonne.
  expect(paused.controls.height, 'la bande des commandes accueille la barre').toBeGreaterThan(
    idle.controls.height,
  );

  /*
   * La timeline est **réellement attrapable au doigt** : c'est la correction demandée après le test
   * sur un vrai iPhone, où le curseur natif était trop bas et trop fin. Trois mesures le prouvent :
   * une zone tactile d'au moins 28 px de haut, une barre remontée du bord bas de l'écran, et une
   * rangée de boutons elle aussi remontée.
   */
  const range = paused.range;
  expect(range, 'la timeline existe pendant la pause').not.toBeNull();
  if (range === null) {
    throw new Error('timeline absente pendant la pause');
  }
  expect(range.height, 'la zone tactile de la timeline fait au moins 28 px').toBeGreaterThanOrEqual(
    28,
  );
  expect(range.width, 'la timeline est assez large pour glisser le doigt').toBeGreaterThanOrEqual(
    60,
  );
  const rangeBottomMargin = 390 - range.bottom;
  expect(
    rangeBottomMargin,
    `la timeline est remontée du bord bas (marge ${rangeBottomMargin.toFixed(1)} px)`,
  ).toBeGreaterThanOrEqual(8);
  const buttonsBottomMargin = 390 - Math.max(...paused.buttons.map((button) => button.bottom));
  expect(
    buttonsBottomMargin,
    `la rangée de boutons est remontée au-dessus de la timeline (marge ${buttonsBottomMargin.toFixed(1)} px)`,
  ).toBeGreaterThanOrEqual(38);

  // La barre est utilisable : « −2 s » recule réellement le curseur, et la course reste gelée.
  const before = await page.evaluate(
    () => window.__CHAOS_RACE_VIEW__?.replay()?.viewedStep ?? -1,
  );
  await page.getByTestId('replay-back').click();
  const afterBack = await page.evaluate(() => ({
    viewedStep: window.__CHAOS_RACE_VIEW__?.replay()?.viewedStep ?? -1,
    pauseStep: window.__CHAOS_RACE_VIEW__?.replay()?.pauseStep ?? -1,
    phase: window.__CHAOS_RACE__?.phase() ?? '',
  }));
  expect(afterBack.phase).toBe('userPaused');
  expect(afterBack.viewedStep).toBe(
    Math.max(0, Math.min(before, afterBack.pauseStep) - REPLAY_STEP_STEPS),
  );

  // Après la reprise, la barre disparaît et la place réservée redescend : rien ne reste vide.
  await page.getByTestId('pause-button').click();
  await expect
    .poll(async () => page.evaluate(() => window.__CHAOS_RACE__?.phase() ?? ''))
    .not.toBe('userPaused');
  await expect(page.getByTestId('replay-bar')).toBeHidden();
  const resumed = await readCommands();
  expect(resumed.bar?.height ?? 0, 'la barre disparaît à la reprise').toBe(0);
  expect(resumed.controls.height, 'la bande vide disparaît avec la barre').toBeLessThanOrEqual(48);

  expectNoErrors(watch);
});

/**
 * Bouton « persos » : il ouvre les six personnages en grand, et il ne touche à rien d'autre.
 *
 * Le panneau est une surcouche d'interface : les images sont celles du projet (les mêmes fichiers que
 * le rendu), les noms sont ceux du roster, et la course continue derrière — le test vérifie donc aussi
 * que la piste, la colonne et le noyau sont dans le même état avant et après.
 *
 * Depuis la passe de finition 2D, le test tourne sur les **deux** formats d'iPhone paysage réellement
 * utilisés (844×390 et 926×428) et prouve géométriquement que le panneau tient **entièrement** dans
 * l'écran : les six cartes, les six noms et le bouton « Fermer » sont dans la fenêtre, sans défilement.
 */
for (const phone of [
  { name: '844×390', width: 844, height: 390 },
  { name: '926×428', width: 926, height: 428 },
] as const) {
  test(`le bouton persos ouvre les six personnages en grand en ${phone.name}`, async ({ page }) => {
    const watch = watchConsole(page);
    await page.setViewportSize({ width: phone.width, height: phone.height });
    await page.goto(raceUrl({ seed: SEED, fast: true, autostart: false }));
    await waitForHooks(page);

    await page.evaluate(() => {
      window.__CHAOS_RACE__?.start();
    });
    await expect(page.getByTestId('gallery-button')).toBeVisible();
    await expect(page.getByTestId('gallery')).toBeHidden();

    const before = await page.evaluate(() => ({
      arena: window.__CHAOS_RACE_VIEW__?.track().arenaWidth ?? -1,
      steps: window.__CHAOS_RACE__?.state().steps ?? -1,
      canvas: document.querySelector('#game canvas')?.getBoundingClientRect().width ?? -1,
    }));

    await page.getByTestId('gallery-button').click();
    await expect(page.getByTestId('gallery')).toBeVisible();

    const panel = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('[data-testid="gallery-card"]'));
      const overlay = document.querySelector('[data-testid="gallery"]');
      const rect = overlay?.getBoundingClientRect();
      const panelElement = document.querySelector('.gallery-panel');
      const panelRect = panelElement?.getBoundingClientRect();
      const close = document.querySelector('[data-testid="gallery-close"]');
      const closeRect = close?.getBoundingClientRect();
      const boxOf = (element: Element | null | undefined): Box => {
        const box = element?.getBoundingClientRect();
        const left = box?.left ?? -1;
        const top = box?.top ?? -1;
        const right = box?.right ?? -1;
        const bottom = box?.bottom ?? -1;
        return { left, top, right, bottom, width: right - left, height: bottom - top };
      };
      return {
        cards: cards.length,
        names: cards.map((card) => card.querySelector('.gallery-name')?.textContent ?? ''),
        cardBoxes: cards.map((card) => boxOf(card)),
        nameBoxes: cards.map((card) => boxOf(card.querySelector('.gallery-name'))),
        images: cards.map((card) => {
          const image = card.querySelector('img');
          return image === null
            ? { complete: false, width: 0, height: 0, src: '' }
            : {
                complete: image.complete && image.naturalWidth > 0,
                width: image.getBoundingClientRect().width,
                height: image.getBoundingClientRect().height,
                src: image.getAttribute('src') ?? '',
              };
        }),
        overlay: {
          left: rect?.left ?? -1,
          top: rect?.top ?? -1,
          right: rect?.right ?? -1,
          bottom: rect?.bottom ?? -1,
        },
        panel: {
          left: panelRect?.left ?? -1,
          top: panelRect?.top ?? -1,
          right: panelRect?.right ?? -1,
          bottom: panelRect?.bottom ?? -1,
        },
        close: {
          left: closeRect?.left ?? -1,
          top: closeRect?.top ?? -1,
          right: closeRect?.right ?? -1,
          bottom: closeRect?.bottom ?? -1,
        },
        viewport: { width: window.innerWidth, height: window.innerHeight },
      };
    });

    // Les six personnages, avec les noms du roster et les images du projet.
    expect(panel.cards, 'six personnages').toBe(CHARACTER_IDS.length);
    expect(
      panel.names,
      'les noms affichés sont exactement ceux du roster, dans l’ordre',
    ).toStrictEqual(CHARACTERS.map((character) => character.name));
    for (const image of panel.images) {
      expect(image.complete, `image chargée : ${image.src}`).toBe(true);
      expect(image.src, 'les images sont celles du projet').toContain('assets/characters/');
      expect(image.width, 'l’image est affichée en grand').toBeGreaterThan(40);
      expect(image.height, 'l’image est affichée en grand').toBeGreaterThan(40);
    }
    // Le panneau couvre l'écran sans sortir de l'écran.
    expect(panel.overlay.left).toBeLessThanOrEqual(1);
    expect(panel.overlay.top).toBeLessThanOrEqual(1);
    expect(panel.overlay.right).toBeGreaterThanOrEqual(phone.width - 1);
    expect(panel.overlay.bottom).toBeGreaterThanOrEqual(phone.height - 1);

    // Le panneau lui-même ne dépasse jamais la fenêtre : c'est la preuve que le bas n'est pas sous la
    // barre d'outils d'iOS (d'où `100dvh` et les marges de sécurité).
    expect(panel.panel.left, 'le panneau commence dans la fenêtre').toBeGreaterThanOrEqual(-1);
    expect(panel.panel.top, 'le panneau commence dans la fenêtre').toBeGreaterThanOrEqual(-1);
    expect(panel.panel.right, 'le panneau ne sort pas à droite').toBeLessThanOrEqual(
      panel.viewport.width + 1,
    );
    expect(panel.panel.bottom, 'le panneau ne sort pas en bas').toBeLessThanOrEqual(
      panel.viewport.height + 1,
    );

    // **Les six cartes sont entièrement visibles** : première et dernière comprises, y compris la
    // deuxième rangée, qui était coupée sur un vrai iPhone.
    for (const [index, box] of panel.cardBoxes.entries()) {
      expect(box.left, `carte ${String(index)} dans la fenêtre (gauche)`).toBeGreaterThanOrEqual(-1);
      expect(box.right, `carte ${String(index)} dans la fenêtre (droite)`).toBeLessThanOrEqual(
        panel.viewport.width + 1,
      );
      expect(box.top, `carte ${String(index)} dans la fenêtre (haut)`).toBeGreaterThanOrEqual(-1);
      expect(
        box.bottom,
        `carte ${String(index)} entièrement visible (bas ${box.bottom.toFixed(1)} sur ${String(panel.viewport.height)})`,
      ).toBeLessThanOrEqual(panel.viewport.height + 1);
    }
    // Les six noms sont visibles, pas seulement présents dans le DOM.
    for (const [index, box] of panel.nameBoxes.entries()) {
      expect(box.bottom, `nom ${String(index)} visible`).toBeLessThanOrEqual(
        panel.viewport.height + 1,
      );
      expect(box.top).toBeGreaterThanOrEqual(-1);
      expect(box.right - box.left, `nom ${String(index)} non écrasé`).toBeGreaterThan(8);
    }
    // Le bouton « Fermer » est entièrement dans la fenêtre, et donc réellement utilisable au doigt.
    expect(panel.close.top).toBeGreaterThanOrEqual(-1);
    expect(panel.close.left).toBeGreaterThanOrEqual(-1);
    expect(panel.close.bottom).toBeLessThanOrEqual(panel.viewport.height + 1);
    expect(panel.close.right).toBeLessThanOrEqual(panel.viewport.width + 1);

    // Fermeture par le bouton, puis par le fond, puis par `Échap`.
    await page.getByTestId('gallery-close').click();
    await expect(page.getByTestId('gallery')).toBeHidden();
    await page.getByTestId('gallery-button').click();
    await expect(page.getByTestId('gallery')).toBeVisible();
    await page.mouse.click(8, Math.round(phone.height / 2));
    await expect(page.getByTestId('gallery')).toBeHidden();
    await page.getByTestId('gallery-button').click();
    await expect(page.getByTestId('gallery')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('gallery')).toBeHidden();

    // Le panneau n'a rien changé : même piste, même canvas, et le noyau n'a jamais reculé.
    const after = await page.evaluate(() => ({
      arena: window.__CHAOS_RACE_VIEW__?.track().arenaWidth ?? -1,
      steps: window.__CHAOS_RACE__?.state().steps ?? -1,
      canvas: document.querySelector('#game canvas')?.getBoundingClientRect().width ?? -1,
    }));
    expect(after.arena).toBe(before.arena);
    expect(after.canvas).toBe(before.canvas);
    expect(after.steps).toBeGreaterThanOrEqual(before.steps - 1);

    expectNoErrors(watch);
  });
}

/**
 * Les mots d'événement (`TURBO !`, `BONUS !`, `MALUS !`) restent **dans la voie** en 844×390.
 *
 * Ils étaient posés au-dessus du sprite, donc dans la bande de la voie du dessus : ils consommaient
 * la hauteur qui manquait aux personnages. Le test attend un événement **réel** (la course en produit
 * d'elle-même, en mode accéléré), puis compare la position du badge à celle du personnage que le
 * noyau a désigné : le badge doit être sur l'axe de sa voie, pas au-dessus de la tête.
 */
test('les textes d’événement restent dans la voie du personnage en 844×390', async ({ page }) => {
  const watch = watchConsole(page);
  await page.setViewportSize({ width: 844, height: 390 });
  await page.goto(raceUrl({ seed: SEED, fast: true, autostart: true }));
  await waitForHooks(page);

  // Un badge n'apparaît que pendant un événement réel : on attend qu'il y en ait un.
  await expect
    .poll(
      async () => page.evaluate(() => document.querySelectorAll('[data-testid="event-badge"]').length),
      { timeout: 25_000, message: 'la course a produit un événement visible' },
    )
    .toBeGreaterThan(0);

  const measured = await page.evaluate(() => {
    const badge = document.querySelector('[data-testid="event-badge"]');
    const canvas = document.querySelector('#game canvas');
    const view = window.__CHAOS_RACE_VIEW__;
    if (badge === null || canvas === null || view === undefined) {
      throw new Error('mesure impossible');
    }
    const rect = badge.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    const track = view.track();
    const scale = canvasRect.height / track.arenaHeight;
    const characterId = badge.getAttribute('data-character-id') ?? '';
    const sprite = view.sprites().find((candidate) => candidate.id === characterId) ?? null;
    return {
      badge: {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        centerY: (rect.top + rect.bottom) / 2,
      },
      characterId,
      sprite:
        sprite === null
          ? null
          : {
              axisY: canvasRect.top + sprite.screenY * scale,
              centerX: canvasRect.left + sprite.screenX * scale,
              leftX: canvasRect.left + (sprite.screenX - sprite.width / 2) * scale,
              topY: canvasRect.top + (sprite.screenY - sprite.height / 2) * scale,
              height: sprite.height * scale,
            },
      laneGap: (track.arenaHeight * 0.8) / 5 * scale,
    };
  });

  expect(measured.characterId, 'le badge désigne un personnage réel').not.toBe('');
  const sprite = measured.sprite;
  expect(sprite, 'le personnage du badge est suivi par le rendu').not.toBeNull();
  if (sprite === null) {
    throw new Error('personnage absent');
  }

  // Sur l'axe de la voie : le badge ne monte plus au-dessus du sprite…
  expect(
    Math.abs(measured.badge.centerY - sprite.axisY),
    `le badge est sur l’axe de la voie (badge ${measured.badge.centerY.toFixed(1)}, axe ${sprite.axisY.toFixed(1)}, voie ${measured.laneGap.toFixed(1)})`,
  ).toBeLessThanOrEqual(measured.laneGap / 2);
  expect(
    measured.badge.centerY,
    'le badge n’est plus posé au-dessus du sprite',
  ).toBeGreaterThan(sprite.topY);
  // …et il reste **derrière** lui au sens de la course : il s'arrête avant le début du sprite, donc il
  // ne fusionne jamais avec l'image.
  expect(
    measured.badge.right,
    `le badge s’arrête avant le sprite (badge ${measured.badge.right.toFixed(1)}, sprite ${sprite.leftX.toFixed(1)})`,
  ).toBeLessThanOrEqual(sprite.leftX);

  expectNoErrors(watch);
});
