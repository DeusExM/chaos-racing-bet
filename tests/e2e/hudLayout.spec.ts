import { expect, test, type Page } from '@playwright/test';

import { CHARACTER_IDS } from '../../src/core/characters';
import { VIEW, characterHeightPx } from '../../src/render/viewConfig';
import { expectNoErrors, raceUrl, waitForHooks, watchConsole } from './helpers';

/**
 * Géométrie du HUD : le classement permanent ne recouvre **jamais** la zone active de la piste.
 *
 * ## Pourquoi un test dédié
 *
 * L'ancienne vérification se contentait d'une **fraction de surface** (« le classement occupe moins
 * d'un quart de l'arène »). Une surface ne dit rien de la position : un panneau deux fois plus petit
 * posé au milieu de la piste passait le test, alors que c'est exactement le défaut signalé par le
 * test joueur — les personnages passaient **sous** le classement.
 *
 * Ce test mesure donc deux choses, dans la **même** tâche que l'observation :
 *
 * 1. le rectangle du classement, ramené dans le repère de l'arène, et la largeur de piste publiée par
 *    le rendu : le panneau doit commencer après la piste ;
 * 2. les rectangles réels des six personnages, à plusieurs instants de la course : aucun de ceux qui
 *    sont dessinés ne doit croiser le rectangle du classement.
 *
 * ## Les deux formats
 *
 * Sur bureau, la bande du classement est **dans** le canvas (`VIEW.TRACK_WIDTH_RATIO`) : la piste est
 * plus étroite que l'arène. En téléphone paysage (passe responsive iPhone), la bande est devenue une
 * **colonne HTML à droite de la piste** : le canvas lui-même est la piste, et la colonne commence
 * exactement à son bord droit. Les deux cas partagent la même preuve — les rectangles mesurés ne se
 * croisent pas — mais pas le même calcul de largeur, d'où la branche explicite.
 */

const SEED = 'KR7Z8NAR';

interface Rect {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

interface CharacterGeometry extends Rect {
  readonly id: string;
  /** Position logique du **nom** : ancré par son bord droit, sur l'axe de la voie. */
  readonly nameX: number;
  readonly nameY: number;
  /** Centre et dimensions du sprite, en pixels **logiques** du canvas (unités du rendu). */
  readonly screenX: number;
  readonly screenY: number;
  readonly logicalWidth: number;
  readonly logicalHeight: number;
}

interface GeometrySample {
  /** Rectangle du classement permanent, dans le repère de l'arène (`null` s'il est masqué). */
  readonly leaderboard: Rect | null;
  /** Rectangles des personnages **réellement dessinés**, dans le repère de l'arène. */
  readonly characters: readonly CharacterGeometry[];
  /** Nombre de personnages réellement dessinés (les autres sont hors champ, marqués au bord). */
  readonly drawnCount: number;
  /** Piste utilisable, en pixels CSS de l'arène. */
  readonly trackWidth: number;
  /** Même largeur, en pixels **logiques** du canvas : c'est l'unité dans laquelle le rendu décide. */
  readonly logicalTrackWidth: number;
  readonly logicalArenaWidth: number;
  readonly arenaWidth: number;
  readonly arenaHeight: number;
  /** Échelle entre pixels logiques du canvas et pixels CSS de l'arène. */
  readonly scale: number;
  readonly compact: boolean;
  readonly leaderboardVisible: boolean;
  /** Hauteur du canvas dans le repère de l'arène : en petit paysage, il remplit la piste. */
  readonly canvasHeight: number;
  /** Hauteur de l'en-tête (titre) : nulle en petit paysage. */
  readonly titleHeight: number;
  readonly steps: number;
}

/**
 * Démarre la course et échantillonne la géométrie aux instants voulus, **depuis la page**.
 *
 * L'échantillonnage vit dans la page, à la fréquence d'affichage : le mode accéléré peut jouer les
 * 60 s en une fraction de seconde, et des allers-retours Playwright manqueraient la plupart des
 * instants visés. Chaque échantillon lit le DOM et le rendu dans la **même** tâche, donc au même
 * instant, et la course est démarrée par le même appel : le premier instant observé est bien celui
 * demandé, pas un état déjà avancé.
 */
async function collectGeometry(page: Page, targets: readonly number[]): Promise<GeometrySample[]> {
  await page.goto(raceUrl({ seed: SEED, fast: true, autostart: false }));
  await waitForHooks(page);
  return page.evaluate(async (wanted: number[]) => {
    const api = window.__CHAOS_RACE__;
    const view = window.__CHAOS_RACE_VIEW__;
    if (api === undefined || view === undefined) {
      throw new Error('hooks absents');
    }
    const stage = document.querySelector('.stage');
    const canvas = document.querySelector('#game canvas');
    if (!(stage instanceof HTMLElement) || !(canvas instanceof HTMLElement)) {
      throw new Error('arène ou canvas introuvable');
    }

    const sample = (): GeometrySample => {
      const stageBox = stage.getBoundingClientRect();
      const canvasBox = canvas.getBoundingClientRect();
      const track = view.track();
      const scale = canvasBox.width / track.arenaWidth;
      const leaderboardElement = document.querySelector('[data-testid="leaderboard"]');
      const leaderboardBox =
        leaderboardElement instanceof HTMLElement
          ? leaderboardElement.getBoundingClientRect()
          : null;
      const visible =
        leaderboardBox !== null &&
        leaderboardBox.width > 0 &&
        leaderboardBox.height > 0 &&
        getComputedStyle(leaderboardElement as HTMLElement).display !== 'none';
      const inArena = (box: DOMRect): Rect => ({
        left: box.left - stageBox.left,
        right: box.right - stageBox.left,
        top: box.top - stageBox.top,
        bottom: box.bottom - stageBox.top,
        width: box.width,
        height: box.height,
      });

      const drawn = view.sprites().filter((sprite) => sprite.drawn);
      return {
        leaderboard: visible && leaderboardBox !== null ? inArena(leaderboardBox) : null,
        characters: drawn.map((sprite) => {
          // `screenX` est le **centre** du sprite (origine 0,5 / 0,5) : le rectangle en découle, avec
          // les dimensions réellement appliquées par `layout()` — largeur et hauteur séparées, puisque
          // les illustrations ne sont pas carrées.
          const halfWidth = (sprite.width * scale) / 2;
          const halfHeight = (sprite.height * scale) / 2;
          const centerX = canvasBox.left - stageBox.left + sprite.screenX * scale;
          const centerY = canvasBox.top - stageBox.top + sprite.screenY * scale;
          return {
            id: sprite.id,
            left: centerX - halfWidth,
            right: centerX + halfWidth,
            top: centerY - halfHeight,
            bottom: centerY + halfHeight,
            width: sprite.width * scale,
            height: sprite.height * scale,
            // Position du nom et du centre, en unités **logiques** du rendu : c'est là que se décide
            // la mise en place, et ces valeurs sont donc comparables aux constantes de `viewConfig`.
            nameX: sprite.nameX,
            nameY: sprite.nameY,
            screenX: sprite.screenX,
            screenY: sprite.screenY,
            logicalWidth: sprite.width,
            logicalHeight: sprite.height,
          };
        }),
        drawnCount: drawn.length,
        trackWidth: track.trackWidth * scale,
        logicalTrackWidth: track.trackWidth,
        logicalArenaWidth: track.arenaWidth,
        arenaWidth: stageBox.width,
        arenaHeight: stageBox.height,
        scale,
        compact: track.compact,
        leaderboardVisible: visible,
        canvasHeight: canvasBox.height,
        titleHeight: document.querySelector('.head')?.getBoundingClientRect().height ?? 0,
        steps: api.state().steps,
      };
    };

    const samples: GeometrySample[] = [];
    let index = 0;
    await new Promise<void>((resolve) => {
      const deadline = performance.now() + 60_000;
      const tick = (): void => {
        const target = wanted[index];
        if (target !== undefined && api.state().steps >= target) {
          samples.push(sample());
          index += 1;
        }
        if (index >= wanted.length || performance.now() > deadline) {
          resolve();
          return;
        }
        requestAnimationFrame(tick);
      };
      tick();
      // Le premier pas ne peut pas être exécuté avant l'installation de la surveillance : la course
      // est donc observée dès son premier instant, sans état déjà avancé.
      api.start();
    });
    return samples;
  }, [...targets]);
}

/** Vrai si deux rectangles se recouvrent réellement, avec une tolérance de 1 px. */
function overlaps(a: Rect, b: Rect): boolean {
  return (
    a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1
  );
}

const VIEWPORTS = [
  { name: '1280×720', width: 1280, height: 720 },
  { name: '1920×1080', width: 1920, height: 1080 },
  { name: '844×390 (téléphone paysage)', width: 844, height: 390 },
] as const;

/** Instants observés, en pas : du départ au dernier segment, répartis sur toute la course. */
const SAMPLED_STEPS = [0, 300, 900, 1500, 2100, 2700, 3300] as const;

for (const viewport of VIEWPORTS) {
  test(`le classement ne recouvre aucun personnage en ${viewport.name}`, async ({ page }) => {
    const watch = watchConsole(page);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const samples = await collectGeometry(page, SAMPLED_STEPS);

    expect(samples).toHaveLength(SAMPLED_STEPS.length);
    const first = samples[0];
    expect(first).toBeDefined();
    expect(first?.compact, 'le mode compact suit la hauteur de la fenêtre').toBe(
      viewport.height <= VIEW.COMPACT_VIEWPORT_MAX_HEIGHT_PX,
    );

    for (const [position, sample] of samples.entries()) {
      // Chaque échantillon correspond bien à l'instant visé : la surveillance ne saute pas d'étape.
      expect(sample.steps).toBeGreaterThanOrEqual(SAMPLED_STEPS[position] ?? 0);
      // Les six personnages sont suivis ; la plupart sont réellement dessinés à chaque instant (les
      // autres sont hors champ et signalés au bord). Sans ce plancher, le test pourrait passer en ne
      // dessinant plus personne.
      expect(sample.drawnCount, 'au moins quatre personnages sont dessinés').toBeGreaterThanOrEqual(4);
      expect(sample.drawnCount).toBeLessThanOrEqual(CHARACTER_IDS.length);

      // Les visuels sont des **images**, jamais des carrés : la hauteur suit la constante du format
      // courant et la largeur se déduit du ratio du fichier. Une image écrasée, une texture manquante
      // ou une résolution utilisée comme taille d'affichage seraient détectées ici, aux résolutions de
      // référence — et le format compact est celui où les personnages sont les plus grands.
      const expectedHeight = characterHeightPx(CHARACTER_IDS.length, sample.compact) * sample.scale;
      for (const character of sample.characters) {
        expect(
          character.height,
          `pas ${String(sample.steps)} : ${character.id} mesure la hauteur de rendu`,
        ).toBeCloseTo(expectedHeight, 0);
        expect(
          character.width / character.height,
          `pas ${String(sample.steps)} : ${character.id} garde le ratio de son image`,
        ).toBeGreaterThan(1.3);
        expect(character.width / character.height).toBeLessThan(1.37);
      }

      if (sample.compact) {
        // Téléphone paysage : la piste occupe la zone de gauche du canvas, le HUD vit dans une colonne
        // HTML à droite. Le classement est donc **affiché**, et il commence au bord droit de la piste.
        expect(sample.leaderboardVisible, 'le classement permanent est affiché').toBe(true);
        expect(sample.logicalTrackWidth, 'la piste occupe toute la largeur du canvas').toBe(
          sample.logicalArenaWidth,
        );
        expect(sample.titleHeight, 'le titre ne prend plus de hauteur').toBeLessThanOrEqual(1);
        expect(sample.canvasHeight, 'la piste occupe toute la hauteur de l’écran').toBeGreaterThanOrEqual(
          sample.arenaHeight - 2,
        );

        const leaderboard = sample.leaderboard;
        expect(leaderboard).not.toBeNull();
        if (leaderboard === null) {
          throw new Error('classement invisible');
        }
        // Le canvas **est** la piste : sa largeur est celle de la piste, et le panneau commence après.
        expect(sample.trackWidth, 'la piste occupe la zone de gauche').toBeLessThan(sample.arenaWidth);
        expect(
          leaderboard.left,
          `pas ${String(sample.steps)} : le classement commence après la piste`,
        ).toBeGreaterThanOrEqual(sample.trackWidth - 1);
        for (const character of sample.characters) {
          expect(
            overlaps(character, leaderboard),
            `pas ${String(sample.steps)} : ${character.id} ne passe pas sous le classement`,
          ).toBe(false);
          expect(
            character.right,
            `pas ${String(sample.steps)} : ${character.id} reste dans la piste`,
          ).toBeLessThanOrEqual(sample.trackWidth + 1);
          expect(
            character.left,
            `pas ${String(sample.steps)} : ${character.id} reste dans la piste`,
          ).toBeGreaterThanOrEqual(-1);
        }
      } else {
        expect(sample.leaderboardVisible, 'le classement permanent est affiché').toBe(true);
        expect(
          sample.logicalTrackWidth,
          'la piste réserve la bande latérale du classement',
        ).toBeLessThan(sample.logicalArenaWidth);
        const leaderboard = sample.leaderboard;
        expect(leaderboard).not.toBeNull();
        if (leaderboard === null) {
          throw new Error('classement invisible');
        }
        // 1) Le panneau commence **après** la piste : les deux zones sont disjointes en largeur.
        expect(
          leaderboard.left,
          `pas ${String(sample.steps)} : le classement commence après la piste`,
        ).toBeGreaterThanOrEqual(sample.trackWidth - 1);
        // 2) Aucun personnage dessiné n'empiète sur le classement, et tout personnage dessiné est
        // dans la piste : les deux ensembles sont donc séparés, pas seulement « plutôt à gauche ».
        for (const character of sample.characters) {
          expect(
            overlaps(character, leaderboard),
            `pas ${String(sample.steps)} : ${character.id} ne passe pas sous le classement`,
          ).toBe(false);
          expect(
            character.right,
            `pas ${String(sample.steps)} : ${character.id} reste dans la piste`,
          ).toBeLessThanOrEqual(sample.trackWidth + 1);
          expect(
            character.left,
            `pas ${String(sample.steps)} : ${character.id} reste dans la piste`,
          ).toBeGreaterThanOrEqual(-1);
        }
      }

      // Le classement reste dans l'arène, quel que soit le mode.
      if (sample.leaderboard !== null) {
        expect(sample.leaderboard.left).toBeGreaterThanOrEqual(-1);
        expect(sample.leaderboard.right).toBeLessThanOrEqual(sample.arenaWidth + 1);
      }
    }

    expectNoErrors(watch);
  });

  test(`le nom vit dans la voie, derrière le personnage, en ${viewport.name}`, async ({ page }) => {
    const watch = watchConsole(page);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const samples = await collectGeometry(page, SAMPLED_STEPS);

    expect(samples).toHaveLength(SAMPLED_STEPS.length);
    for (const sample of samples) {
      for (const character of sample.characters) {
        // 1) Le nom partage l'axe de la voie : il ne réserve **aucune** hauteur au-dessus du sprite,
        //    et il n'est donc jamais « au-dessus de la tête ».
        expect(
          Math.abs(character.nameY - character.screenY),
          `pas ${String(sample.steps)} : ${character.id} — le nom est sur l'axe de la voie`,
        ).toBeLessThanOrEqual(1);
        // 2) Le nom est **derrière** le personnage au sens de la course : à sa gauche, puisque la
        //    course va de gauche à droite. Son bord droit s'arrête avant le bord gauche du sprite.
        const spriteLeft = character.screenX - character.logicalWidth / 2;
        expect(
          character.nameX,
          `pas ${String(sample.steps)} : ${character.id} — le nom s'arrête avant le sprite`,
        ).toBeLessThanOrEqual(spriteLeft);
        // 3) Un espace constant les sépare : le texte n'est jamais recouvert par l'illustration, et
        //    il n'en est pas collé non plus.
        expect(
          spriteLeft - character.nameX,
          `pas ${String(sample.steps)} : ${character.id} — espace entre le nom et le sprite`,
        ).toBeCloseTo(VIEW.CHARACTER_NAME_GAP_PX, 0);
        // 4) Le nom est dessiné au-dessus du sprite : il reste lisible même si les silhouettes se
        //    croisent en profondeur.
        expect(character.nameY).toBeGreaterThan(0);
        expect(character.nameY).toBeLessThan(VIEW.BASE_HEIGHT);
      }
    }

    expectNoErrors(watch);
  });

  test(`les personnages gardent une taille utile en ${viewport.name}`, async ({ page }) => {
    const watch = watchConsole(page);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const samples = await collectGeometry(page, SAMPLED_STEPS);

    const first = samples[0];
    expect(first).toBeDefined();
    if (first === undefined) {
      throw new Error('aucun échantillon');
    }

    // La taille logique est celle du format **et de l'effectif** : 92 px sur bureau à six coureurs,
    // 106 px en petit paysage à six, davantage dès que la course aligne moins de monde. Le test la
    // compare à la fonction du format courant, donc une régression de réglage est détectée ici.
    const expected = characterHeightPx(CHARACTER_IDS.length, first.compact);
    for (const sample of samples) {
      for (const character of sample.characters) {
        expect(character.logicalHeight).toBeCloseTo(expected, 0);
        // En pixels CSS, le personnage reste réellement visible : c'est cette valeur que l'œil juge.
        expect(
          character.height,
          `pas ${String(sample.steps)} : ${character.id} mesure au moins 55 px CSS`,
        ).toBeGreaterThanOrEqual(55);
      }
    }

    // Sur bureau, les deux résolutions de référence partagent la même géométrie logique : la taille
    // choisie doit donc tenir dans le canvas dans les deux cas (voies du haut et du bas comprises).
    if (!first.compact) {
      expect(expected).toBeGreaterThanOrEqual(88);
      expect(expected).toBeLessThanOrEqual(96);
    }

    expectNoErrors(watch);
  });

  test(`les textes d’événement restent dans la voie du personnage en ${viewport.name}`, async ({
    page,
  }) => {
    const watch = watchConsole(page);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto(raceUrl({ seed: SEED, fast: true, autostart: true }));
    await waitForHooks(page);

    // Un badge n'apparaît que pendant un événement réel : on attend qu'il y en ait un.
    await expect
      .poll(
        async () =>
          page.evaluate(() => document.querySelectorAll('[data-testid="event-badge"]').length),
        { timeout: 25_000, message: 'la course a produit un événement visible' },
      )
      .toBeGreaterThan(0);

    // Les constantes du format sont passées en argument : `page.evaluate` s'exécute dans la page, où
    // les modules du projet ne sont pas accessibles.
    const laneSpanRatio = VIEW.LANE_BOTTOM_RATIO - VIEW.LANE_TOP_RATIO;
    const laneCount = CHARACTER_IDS.length - 1;
    const measured = await page.evaluate(
      ({ span, lanes }) => {
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
            centerY: (rect.top + rect.bottom) / 2,
          },
          characterId,
          sprite:
            sprite === null
              ? null
              : {
                  axisY: canvasRect.top + sprite.screenY * scale,
                  leftX: canvasRect.left + (sprite.screenX - sprite.width / 2) * scale,
                  topY: canvasRect.top + (sprite.screenY - sprite.height / 2) * scale,
                },
          laneGap: ((track.arenaHeight * span) / lanes) * scale,
        };
      },
      { span: laneSpanRatio, lanes: laneCount },
    );

    expect(measured.characterId, 'le badge désigne un personnage réel').not.toBe('');
    const sprite = measured.sprite;
    expect(sprite, 'le personnage du badge est suivi par le rendu').not.toBeNull();
    if (sprite === null) {
      throw new Error('personnage absent');
    }

    // 1) Le mot est **dans la voie**, sur l'axe du personnage : il ne monte plus au-dessus de sa tête.
    expect(
      Math.abs(measured.badge.centerY - sprite.axisY),
      `le badge est sur l’axe de la voie (badge ${measured.badge.centerY.toFixed(1)}, axe ${sprite.axisY.toFixed(1)}, voie ${measured.laneGap.toFixed(1)})`,
    ).toBeLessThanOrEqual(measured.laneGap / 2);
    expect(measured.badge.centerY, 'le badge n’est pas posé au-dessus du sprite').toBeGreaterThan(
      sprite.topY,
    );
    // 2) Il est **derrière** le personnage au sens de la course : il s'arrête avant le début du sprite,
    //    donc il ne fusionne jamais avec l'image.
    expect(
      measured.badge.right,
      `le badge s’arrête avant le sprite (badge ${measured.badge.right.toFixed(1)}, sprite ${sprite.leftX.toFixed(1)})`,
    ).toBeLessThanOrEqual(sprite.leftX);

    expectNoErrors(watch);
  });
}
