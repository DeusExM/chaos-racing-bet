import { expect, test, type Page } from '@playwright/test';

import { expectNoErrors, raceUrl, waitForHooks, watchConsole } from './helpers';

/**
 * Rotation de l'iPhone : écran de rotation en portrait, et retour en paysage **au pixel**.
 *
 * ## Le défaut corrigé
 *
 * Au démarrage direct en paysage, la mise en page est juste. Après un aller-retour
 * `paysage → portrait → paysage`, WebKit annonce d'abord une taille encore héritée de l'orientation
 * précédente puis la corrige en plusieurs fois : la page se retrouvait recadrée verticalement, et les
 * voies du haut et du bas pouvaient sortir du viewport. Deux causes, deux remèdes :
 *
 * 1. **Le moment.** La taille n'est plus lue au premier `resize` venu : `viewportWatch.ts` attend
 *    qu'elle se stabilise (trois mesures identiques, `orientationchange` + `resize` +
 *    `visualViewport.resize`), puis `refreshScale()` réapplique le cadrage Phaser. Aucun
 *    rechargement n'est déclenché : une course en cours ne doit pas être perdue.
 * 2. **La hauteur.** `100vh` vaut la fenêtre *large* sur iOS (barres d'outils repliées). La hauteur de
 *    l'application vient donc de `--app-height`, mesurée sur `visualViewport`.
 *
 * ## Ce que ce fichier prouve
 *
 * Le test central est celui demandé : après `paysage → portrait → paysage`, la géométrie est
 * **exactement** celle d'un lancement direct en paysage — canvas, arène, largeur de piste, format et
 * les **six voies**, comparés dans la même session de navigation, donc sans aucune tolérance de
 * circonstance. Et en portrait, la course n'est pas seulement masquée : elle **n'avance pas**, ce que
 * le nombre de pas du noyau prouve directement.
 */

/** Marge de comparaison, en pixels : deux mesures du même calcul doivent coïncider. */
const EPSILON_PX = 0.01;

/** Les deux formats d'iPhone paysage réellement utilisés par le projet. */
const PHONES = [
  { name: '844×390', width: 844, height: 390 },
  { name: '926×428', width: 926, height: 428 },
] as const;

/** Géométrie réellement dessinée, telle qu'elle doit être identique après une rotation. */
interface LandscapeGeometry {
  readonly canvasWidth: number;
  readonly canvasHeight: number;
  readonly canvasLeft: number;
  readonly canvasTop: number;
  readonly arenaWidth: number;
  readonly arenaHeight: number;
  readonly trackWidth: number;
  readonly compact: boolean;
  /** Ordonnée écran des six voies, en pixels logiques de l'arène, dans l'ordre du roster. */
  readonly lanes: readonly number[];
  readonly shellHeight: number;
  readonly appHeight: string;
  readonly documentScrollHeight: number;
  readonly scrollY: number;
}

/** Lit la géométrie courante depuis la page : une seule tâche, donc un seul instant. */
async function readLandscape(page: Page): Promise<LandscapeGeometry> {
  return page.evaluate(() => {
    const view = window.__CHAOS_RACE_VIEW__;
    if (view === undefined) {
      throw new Error('hooks de rendu absents');
    }
    const canvas = document.querySelector('#game canvas');
    const shell = document.querySelector('.shell');
    if (!(canvas instanceof HTMLElement) || !(shell instanceof HTMLElement)) {
      throw new Error('canvas ou coquille introuvable');
    }
    const rect = canvas.getBoundingClientRect();
    const track = view.track();
    const round = (value: number): number => Math.round(value * 100) / 100;
    return {
      canvasWidth: round(rect.width),
      canvasHeight: round(rect.height),
      canvasLeft: round(rect.left),
      canvasTop: round(rect.top),
      arenaWidth: track.arenaWidth,
      arenaHeight: track.arenaHeight,
      trackWidth: track.trackWidth,
      compact: track.compact,
      lanes: view.sprites().map((sprite) => sprite.screenY),
      shellHeight: round(shell.getBoundingClientRect().height),
      appHeight: getComputedStyle(document.documentElement)
        .getPropertyValue('--app-height')
        .trim(),
      documentScrollHeight: document.documentElement.scrollHeight,
      scrollY: window.scrollY,
    };
  });
}

/**
 * Attend que la géométrie ne bouge plus : c'est l'état « posé » que les deux chemins doivent partager.
 *
 * Trois mesures identiques à 150 ms d'intervalle sont exigées, et non deux : Phaser termine son
 * premier cadrage après le démarrage de l'application, et une lecture trop précoce décrirait un état
 * transitoire — exactement le genre de mesure que cette passe corrige.
 */
async function settledLandscape(page: Page): Promise<LandscapeGeometry> {
  let previous = await readLandscape(page);
  let repeats = 0;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await page.waitForTimeout(150);
    const current = await readLandscape(page);
    repeats = JSON.stringify(current) === JSON.stringify(previous) ? repeats + 1 : 0;
    if (repeats >= 2) {
      return current;
    }
    previous = current;
  }
  return previous;
}

/** Attend que le cadrage corresponde à une référence, puis renvoie la géométrie complète. */
async function waitForGeometry(
  page: Page,
  reference: LandscapeGeometry,
): Promise<LandscapeGeometry> {
  const key = (geometry: LandscapeGeometry): string =>
    `${String(geometry.canvasWidth)}x${String(geometry.canvasHeight)}@${String(geometry.canvasLeft)}|${String(geometry.arenaWidth)}`;
  await expect
    .poll(async () => key(await readLandscape(page)), {
      message: 'le cadrage revient à celui du lancement direct en paysage',
    })
    .toBe(key(reference));
  return readLandscape(page);
}

/** Vrai si le portrait est détecté : `data-rotation-gate` est la seule décision, elle vient du rendu. */
async function rotationGate(page: Page): Promise<string> {
  return page.evaluate(
    () => document.documentElement.dataset['rotationGate'] ?? 'absent',
  );
}

test.describe('écran de rotation et retour en paysage', () => {
  for (const phone of PHONES) {
    test(`le lancement direct en paysage ne montre aucun écran de rotation en ${phone.name}`, async ({
      page,
    }) => {
      const watch = watchConsole(page);
      await page.setViewportSize({ width: phone.width, height: phone.height });
      await page.goto(raceUrl({ seed: 'KR7Z8NAR', fast: true }));
      await waitForHooks(page);

      // Le cas qui fonctionnait déjà ne doit pas être cassé : rien ne recouvre la course, et la
      // hauteur de l'application est celle de la fenêtre.
      await expect(page.getByTestId('rotation-gate')).toBeHidden();
      expect(await rotationGate(page)).toBe('off');
      const geometry = await readLandscape(page);
      expect(geometry.compact, 'le format petit paysage est bien détecté').toBe(true);
      expect(geometry.appHeight).toBe(`${String(phone.height)}px`);
      expect(geometry.shellHeight).toBeCloseTo(phone.height, 0);
      // Phaser arrondit la taille d'affichage du canvas : elle peut valoir un pixel de moins que sa
      // boîte. Ce qui compte ici est que le canvas couvre bien toute la hauteur de l'écran.
      expect(
        Math.abs(geometry.canvasHeight - phone.height),
        `le canvas couvre la hauteur de l’écran (${String(geometry.canvasHeight)} px)`,
      ).toBeLessThanOrEqual(1);

      expectNoErrors(watch);
    });
  }

  for (const phone of PHONES) {
    test(`le portrait affiche l’écran de rotation et gèle la course en ${phone.name}`, async ({
      page,
    }) => {
      const watch = watchConsole(page);
      await page.setViewportSize({ width: phone.width, height: phone.height });
      await page.goto(raceUrl({ seed: 'KR7Z8NAR', fast: true }));
      await waitForHooks(page);

      // Une course est réellement lancée : c'est le seul moyen de prouver qu'elle ne se joue pas
      // pendant que le téléphone est droit.
      await page.evaluate(() => window.__CHAOS_RACE__?.start());
      await expect
        .poll(async () => page.evaluate(() => window.__CHAOS_RACE__?.state().steps ?? 0))
        .toBeGreaterThan(0);

      // Rotation vers le portrait : le même appareil, tenu droit.
      await page.setViewportSize({ width: phone.height, height: phone.width });
      await expect.poll(async () => rotationGate(page)).toBe('on');
      await expect(page.getByTestId('rotation-gate')).toBeVisible();
      await expect(page.getByTestId('rotation-gate-title')).toHaveText(
        'Tourne ton iPhone en paysage pour jouer',
      );

      // L'écran couvre **tout** : le centre du canvas et ses quatre coins sont recouverts par lui, et
      // il tient dans la hauteur réellement visible.
      const coverage = await page.evaluate(() => {
        const gate = document.querySelector('[data-testid="rotation-gate"]');
        const canvas = document.querySelector('#game canvas');
        if (!(gate instanceof HTMLElement) || !(canvas instanceof HTMLElement)) {
          throw new Error('écran de rotation ou canvas introuvable');
        }
        const gateRect = gate.getBoundingClientRect();
        const canvasRect = canvas.getBoundingClientRect();
        const corners: readonly (readonly [number, number])[] = [
          [canvasRect.left + 1, canvasRect.top + 1],
          [canvasRect.right - 1, canvasRect.top + 1],
          [canvasRect.left + 1, canvasRect.bottom - 1],
          [canvasRect.right - 1, canvasRect.bottom - 1],
          [canvasRect.left + canvasRect.width / 2, canvasRect.top + canvasRect.height / 2],
        ];
        return {
          gateTop: gateRect.top,
          gateLeft: gateRect.left,
          gateWidth: gateRect.width,
          gateHeight: gateRect.height,
          covered: corners.map(([x, y]) => gate.contains(document.elementFromPoint(x, y))),
          visibleHeight: window.innerHeight,
        };
      });
      expect(coverage.gateTop, 'l’écran part du haut').toBeCloseTo(0, 0);
      expect(coverage.gateLeft, 'l’écran part de la gauche').toBeCloseTo(0, 0);
      expect(coverage.gateWidth, 'l’écran occupe toute la largeur').toBeCloseTo(phone.height, 0);
      expect(coverage.gateHeight, 'l’écran occupe toute la hauteur').toBeCloseTo(phone.width, 0);
      expect(
        coverage.covered,
        'aucun coin du canvas n’est visible derrière l’écran de rotation',
      ).toEqual([true, true, true, true, true]);

      // Le noyau ne reçoit plus aucun pas : la course ne continue pas « visuellement » en portrait,
      // elle ne continue pas du tout. C'est le mécanisme de pause du projet (ne pas appeler `step()`).
      const before = await page.evaluate(() => window.__CHAOS_RACE__?.state().steps ?? -1);
      await page.waitForTimeout(600);
      const after = await page.evaluate(() => window.__CHAOS_RACE__?.state().steps ?? -1);
      expect(after, `la course est gelée en portrait (${String(before)} → ${String(after)})`).toBe(
        before,
      );

      expectNoErrors(watch);
    });
  }

  for (const phone of PHONES) {
    test(`paysage → portrait → paysage redonne exactement la géométrie du lancement direct en ${phone.name}`, async ({
      page,
    }) => {
      const watch = watchConsole(page);
      const portrait = { width: phone.height, height: phone.width };

      // 1. Lancement **direct** en paysage : c'est la référence, mesurée dans cette session.
      await page.setViewportSize({ width: phone.width, height: phone.height });
      await page.goto(raceUrl({ seed: 'KR7Z8NAR', fast: true }));
      await waitForHooks(page);
      const reference = await settledLandscape(page);

      // 2. Portrait, puis retour en paysage.
      await page.setViewportSize(portrait);
      await expect.poll(async () => rotationGate(page)).toBe('on');
      await page.setViewportSize({ width: phone.width, height: phone.height });
      await expect.poll(async () => rotationGate(page)).toBe('off');
      await expect(page.getByTestId('rotation-gate')).toBeHidden();

      // 3. La géométrie doit être **celle de la référence**, au pixel : canvas, arène, piste, format,
      //    six voies, hauteur de coquille, et aucune page plus haute que l'écran.
      const after = await waitForGeometry(page, reference);
      expect(after).toEqual(reference);
      expect(after.lanes.length, 'les six voies sont mesurées').toBe(6);
      expect(after.documentScrollHeight, 'la page ne dépasse pas l’écran').toBeLessThanOrEqual(
        phone.height + 1,
      );
      expect(after.scrollY, 'la page n’est pas décalée verticalement').toBe(0);
      expect(
        after.lanes.every((lane, index) => Math.abs(lane - (reference.lanes[index] ?? -1)) < EPSILON_PX),
        'les six voies sont à la même ordonnée qu’au lancement direct',
      ).toBe(true);

      expectNoErrors(watch);
    });
  }

  test('portrait → paysage redonne exactement la géométrie du lancement direct en 844×390', async ({
    page,
  }) => {
    const watch = watchConsole(page);

    // Référence : lancement direct en paysage.
    await page.setViewportSize({ width: 844, height: 390 });
    await page.goto(raceUrl({ seed: 'KR7Z8NAR', fast: true }));
    await waitForHooks(page);
    const reference = await settledLandscape(page);

    // Puis un démarrage **en portrait** : la page n'a jamais connu le paysage, et l'écran de rotation
    // est affiché dès la première image.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(raceUrl({ seed: 'KR7Z8NAR', fast: true }));
    await waitForHooks(page);
    expect(await rotationGate(page)).toBe('on');
    await expect(page.getByTestId('rotation-gate')).toBeVisible();

    // Le retour en paysage doit donner la géométrie de la référence, au pixel.
    await page.setViewportSize({ width: 844, height: 390 });
    await expect.poll(async () => rotationGate(page)).toBe('off');
    await expect(page.getByTestId('rotation-gate')).toBeHidden();

    const after = await waitForGeometry(page, reference);
    expect(after).toEqual(reference);
    expect(after.scrollY).toBe(0);

    expectNoErrors(watch);
  });
});
