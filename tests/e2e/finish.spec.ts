import { expect, test, type Page } from '@playwright/test';

import { UI_TEXT_FR } from '../../src/app/strings.fr';
import { CHARACTERS } from '../../src/core/characters';
import { RACE_CONFIG } from '../../src/core/config';
import { VIEW } from '../../src/render/viewConfig';
import {
  PHOTO_FINISH_SEED,
  PHOTO_FINISH_SEED_EVIDENCE,
  PLAIN_FINISH_SEED,
} from '../fixtures/seeds';
import {
  expectNoErrors,
  raceUrl,
  readFinishCore,
  readFinishDom,
  waitForFinished,
  waitForHooks,
  watchConsole,
  type FinishCoreSample,
  type FinishDomSample,
} from './helpers';

/**
 * P013 — arrivée, podium et rejeu.
 *
 * Tous ces tests tournent contre le build de production, en `?fast=1` : la course dure alors une
 * dizaine de secondes réelles au lieu de trois minutes, **sans changer un seul chiffre du résultat**
 * (c'est le contrat de `SimConfig`). Chaque comparaison porte sur des identifiants et des nombres lus
 * sur les hooks en lecture seule, jamais sur une supposition : le podium doit être exactement le
 * classement du noyau à `tSim = 60 s`, et rien ne doit plus bouger ensuite.
 */

/** Rectangle d'élément mesuré dans la page. */
interface Measured {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

/** Rectangle exprimé relativement à l'arène. */
interface Box {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

/** Vrai si deux rectangles se recouvrent réellement, avec une tolérance de 1 px. */
function overlaps(a: Box, b: Box): boolean {
  return a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
}

/** Nom affichable officiel d'un identifiant : sert à vérifier que le DOM nomme bien le noyau. */
function nameOf(id: string): string {
  return CHARACTERS.find((character) => character.id === id)?.name ?? '';
}

/** Distance telle que l'interface l'affiche : une décimale, arrondie, sans dépendre du texte. */
function uiDistance(value: number): number {
  return Number(value.toFixed(1));
}

/** Lecture complète de l'arrivée : noyau figé, écran affiché, URL et HUD. */
async function readArrival(
  page: Page,
): Promise<{ core: FinishCoreSample; dom: FinishDomSample }> {
  const core = await readFinishCore(page);
  const dom = await readFinishDom(page);
  return { core, dom };
}

/** Vérifie que l'écran affiché est exactement le classement final du noyau. */
function expectPodiumMatchesCore(core: FinishCoreSample, dom: FinishDomSample): void {
  const coreIds = core.ranks.map((row) => row.id);

  expect(dom.hidden, 'l’écran d’arrivée est affiché').toBe(false);
  expect(dom.rows, 'les six marcheurs sont présentés').toHaveLength(coreIds.length);
  expect(dom.podium, 'le podium présente trois marcheurs').toHaveLength(VIEW.FINISH_PODIUM_SIZE);

  // 1) Les 6 identifiants, dans l'ordre exact du noyau — pas seulement les noms.
  expect(dom.rows.map((row) => row.id)).toEqual(coreIds);
  expect(dom.rows.map((row) => row.rank)).toEqual(core.ranks.map((row) => row.rank));
  // 2) Le top 3 est le début de ce même classement.
  expect(dom.podium.map((row) => row.id)).toEqual(coreIds.slice(0, VIEW.FINISH_PODIUM_SIZE));
  expect(dom.podium.map((row) => row.rank)).toEqual([1, 2, 3]);
  // 3) Le vainqueur est identifiable, et c'est bien celui du noyau.
  expect(dom.winnerId).toBe(coreIds[0]);
  expect(dom.winnerText).toContain(nameOf(dom.winnerId));
  expect(dom.winnerText).toContain(`${uiDistance(core.ranks[0]?.distance ?? 0).toFixed(1).replace('.', ',')}`);

  // 4) Chaque ligne : position, nom, distance finale et écart au vainqueur, dérivés des valeurs du
  // noyau. La précision d'interface documentée est **une décimale** (10 cm) : le texte affiché doit
  // donc être exactement l'arrondi à une décimale de la valeur du noyau, et les `data-*` la valeur
  // brute — aucune des deux ne peut être une approximation différente.
  for (const row of dom.rows) {
    const reference = core.ranks.find((candidate) => candidate.id === row.id);
    expect(reference, `ligne ${row.id} présente dans le noyau`).toBeDefined();
    if (reference === undefined) {
      continue;
    }
    expect(row.name).toBe(nameOf(row.id));
    expect(row.distanceRaw).toBe(reference.distance);
    expect(row.gapRaw).toBe(reference.gapMeters);
    expect(row.distanceText).toBe(uiDistance(reference.distance));
    expect(row.gapText).toBe(uiDistance(reference.gapMeters));
  }

  // 5) Le leader a bien un écart nul, et chaque écart est l'écart réel au vainqueur.
  const best = core.ranks[0]?.distance ?? 0;
  for (const row of dom.rows) {
    const reference = core.ranks.find((candidate) => candidate.id === row.id);
    expect(row.gapRaw).toBeCloseTo(best - (reference?.distance ?? 0), 9);
  }

  // 6) Les deux boutons de fin sont là, libellés et opérationnels.
  expect(dom.replayLabel).toBe(UI_TEXT_FR.finishReplaySameSeed);
  expect(dom.newRaceLabel).toBe(UI_TEXT_FR.finishNewRace);
  expect(dom.replayEnabled).toBe(true);
  expect(dom.newRaceEnabled).toBe(true);
}

test('une course fast=1 atteint l’écran d’arrivée : 3 600 pas, 60 s, podium affiché', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const watch = watchConsole(page);
  await page.goto(raceUrl({ seed: PLAIN_FINISH_SEED, fast: true, autostart: true }));
  await waitForFinished(page);

  const { core, dom } = await readArrival(page);

  // La frontière est absolue : phase terminée, 60 s simulées, exactement 3 600 pas.
  expect(core.simPhase).toBe('finished');
  expect(core.phaseKind).toBe('finished');
  expect(core.tSim).toBe(RACE_CONFIG.TOTAL_SIM_S);
  expect(core.steps).toBe(RACE_CONFIG.TOTAL_STEPS);
  expect(core.seed).toBe(PLAIN_FINISH_SEED);

  // Le modèle affiché date lui aussi de l'arrivée : ce n'est pas une frame intermédiaire.
  expect(core.panel).not.toBeNull();
  expect(core.panel?.steps).toBe(RACE_CONFIG.TOTAL_STEPS);
  expect(core.panel?.tSim).toBe(RACE_CONFIG.TOTAL_SIM_S);
  expect(core.panel?.seed).toBe(PLAIN_FINISH_SEED);

  expectPodiumMatchesCore(core, dom);

  // Le podium ne décide rien : c'est le même classement que celui des hooks de test.
  expect(core.panel?.rows.map((row) => row.id)).toEqual(core.ranks.map((row) => row.id));
  expect(core.panel?.podiumIds).toEqual(dom.podium.map((row) => row.id));

  // Le vainqueur est visuellement mis en avant (classe dédiée + couleur d'accent), pas seulement
  // écrit quelque part dans la liste.
  const winnerRow = page.locator('[data-testid="finish-row"][data-rank="1"]');
  await expect(winnerRow).toHaveClass(/is-winner/);
  expect(await winnerRow.evaluate((element) => getComputedStyle(element).color)).toBe(
    'rgb(255, 209, 102)',
  );

  // PLAIN_FINISH_SEED n'a pas produit de photo finish : la mention ne doit pas apparaître.
  expect(dom.photoVisible).toBe(false);
  expect(dom.photoText).toBe('');
  expect(core.panel?.photoFinish).toBeNull();

  // Le classement live du HUD a disparu : il ne peut pas y avoir deux classements à l'écran.
  await expect(page.getByTestId('leaderboard')).toBeHidden();
  // Le chrono et la seed restent, arrêtés sur les valeurs finales.
  await expect(page.getByTestId('hud-sim-time')).toHaveText('60,0\u00A0s');
  await expect(page.getByTestId('seed-value')).toHaveText(PLAIN_FINISH_SEED);

  // Les réglages restent utilisables **sur** l'écran d'arrivée : rien ne les recouvre, et leur
  // persistance n'est pas touchée par P013.
  await page.getByTestId('settings-sound').click();
  await expect(page.getByTestId('settings-sound')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('settings-sound').click();
  await expect(page.getByTestId('settings-sound')).toHaveAttribute('aria-pressed', 'false');

  expectNoErrors(watch);
});

test('l’écran d’arrivée rappelle qui menait aux deux checkpoints, puis à l’arrivée', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const watch = watchConsole(page);
  await page.goto(raceUrl({ seed: PLAIN_FINISH_SEED, fast: true, autostart: false }));
  await waitForHooks(page);

  // La course est observée **en direct** : à chaque checkpoint, le premier du classement du noyau est
  // relevé, avec l'instant simulé mesuré. C'est la seule source possible — le noyau ne conserve pas
  // les classements passés — et c'est exactement ce que le rendu doit avoir noté de son côté.
  const observed = await page.evaluate(async () => {
    const api = window.__CHAOS_RACE__;
    if (api === undefined) {
      throw new Error('hooks absents');
    }
    const seen: { checkpoint: number; tSim: number; id: string }[] = [];
    const deadline = performance.now() + 60_000;
    await new Promise<void>((resolve) => {
      const tick = (): void => {
        const checkpoint = api.checkpoint();
        if (checkpoint !== null && !seen.some((row) => row.checkpoint === checkpoint)) {
          seen.push({
            checkpoint,
            tSim: api.state().tSim,
            id: api.ranks()[0]?.id ?? '',
          });
        }
        if (api.phase() === 'finished' || performance.now() > deadline) {
          resolve();
          return;
        }
        requestAnimationFrame(tick);
      };
      tick();
      api.start();
    });
    return seen;
  });

  // Les deux checkpoints intermédiaires ont réellement été observés, dans l'ordre, à 20 s et 40 s.
  expect(observed.map((row) => row.checkpoint)).toEqual([1, 2]);
  expect(observed[0]?.tSim).toBe(RACE_CONFIG.SEGMENT_DURATION_S);
  expect(observed[1]?.tSim).toBe(RACE_CONFIG.SEGMENT_DURATION_S * 2);
  expect(observed.every((row) => row.id !== '')).toBe(true);

  await waitForFinished(page);
  const { core, dom } = await readArrival(page);

  // 1) La section existe, avec son titre, et elle présente exactement trois bornes.
  expect(dom.passagesTitle).toBe(UI_TEXT_FR.finishPassagesTitle);
  expect(dom.passages).toHaveLength(3);
  // 2) Les deux premières lignes sont celles **observées en direct** : même personnage, même instant.
  expect(dom.passages[0]?.checkpoint).toBe(1);
  expect(dom.passages[0]?.id).toBe(observed[0]?.id);
  expect(dom.passages[0]?.tSim).toBe(observed[0]?.tSim);
  expect(dom.passages[1]?.checkpoint).toBe(2);
  expect(dom.passages[1]?.id).toBe(observed[1]?.id);
  expect(dom.passages[1]?.tSim).toBe(observed[1]?.tSim);
  // 3) La troisième borne est l'**arrivée**, et son leader est le vainqueur du classement final : il
  //    n'existe pas de « checkpoint 3 ».
  expect(dom.passages[2]?.checkpoint).toBeNull();
  expect(dom.passages[2]?.id).toBe(core.ranks[0]?.id);
  expect(dom.passages[2]?.tSim).toBe(RACE_CONFIG.TOTAL_SIM_S);
  expect(dom.passages.filter((row) => row.checkpoint === 3)).toHaveLength(0);

  // 4) Les libellés et les instants affichés sont ceux du noyau, jamais des constantes inventées.
  expect(dom.passages[0]?.boundText).toBe(`${UI_TEXT_FR.checkpointTitle} 1`);
  expect(dom.passages[1]?.boundText).toBe(`${UI_TEXT_FR.checkpointTitle} 2`);
  expect(dom.passages[2]?.boundText).toBe(UI_TEXT_FR.finishTitle);
  expect(dom.passages.map((row) => row.timeText.replace(/\s/g, ' '))).toEqual([
    '20 s',
    '40 s',
    '60 s',
  ]);
  // 5) Les noms sont ceux du roster, et le modèle publié par le panneau dit la même chose que le DOM.
  for (const row of dom.passages) {
    expect(row.name).toBe(nameOf(row.id));
  }
  expect(core.panel?.passages.map((row) => row.checkpoint)).toEqual([1, 2, null]);
  expect(core.panel?.passages.map((row) => row.id)).toEqual(dom.passages.map((row) => row.id));
  expect(core.panel?.passages[2]?.id).toBe(core.panel?.winnerId);

  expectNoErrors(watch);
});

test('après l’arrivée, la décélération est purement visuelle : aucun pas, distances figées', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const watch = watchConsole(page);
  await page.goto(raceUrl({ seed: PLAIN_FINISH_SEED, fast: true, autostart: true }));
  await waitForFinished(page);

  const first = await readFinishCore(page);
  expect(first.steps).toBe(RACE_CONFIG.TOTAL_STEPS);

  // Plusieurs lectures séparées par du temps réel : c'est la seule façon de prouver que rien ne
  // « rattrape » après coup.
  const reads: FinishCoreSample[] = [];
  for (let index = 0; index < 4; index += 1) {
    await page.waitForTimeout(400);
    reads.push(await readFinishCore(page));
  }

  for (const [index, read] of reads.entries()) {
    expect(read.steps, `lecture ${String(index)} : pas inchangés`).toBe(RACE_CONFIG.TOTAL_STEPS);
    expect(read.tSim, `lecture ${String(index)} : temps simulé inchangé`).toBe(
      RACE_CONFIG.TOTAL_SIM_S,
    );
    expect(read.phaseKind).toBe('finished');
    // Distances finales **strictement** identiques : elles ne bougent plus d'un bit.
    expect([...read.distances], `lecture ${String(index)} : distances figées`).toEqual([
      ...first.distances,
    ]);
    // Le classement non plus, ni dans le noyau ni à l'écran.
    expect(read.ranks.map((row) => row.id)).toEqual(first.ranks.map((row) => row.id));
    expect(read.panel?.rows.map((row) => row.id)).toEqual(first.panel?.rows.map((row) => row.id));
    expect(read.panel?.steps).toBe(RACE_CONFIG.TOTAL_STEPS);
    // Les positions de rendu ne reculent jamais et ne passent jamais sous les distances figées.
    for (const [character, distance] of read.distances.entries()) {
      expect(read.visualDistances[character] ?? 0).toBeGreaterThanOrEqual(distance);
    }
  }

  // Le rendu, lui, a bien bougé : c'est ce qui donne l'impression que la meute ralentit.
  const moved = reads.some((read) =>
    read.visualDistances.some((value, index) => value > (read.distances[index] ?? 0)),
  );
  expect(moved, 'la décélération visuelle est réellement animée').toBe(true);

  // Puis l'inertie se stabilise : les deux dernières lectures, postérieures à la fin de la
  // transition, donnent exactement les mêmes positions de rendu.
  const last = reads[reads.length - 1];
  const previous = reads[reads.length - 2];
  expect(last).toBeDefined();
  expect(previous).toBeDefined();
  expect([...(last?.visualDistances ?? [])]).toEqual([...(previous?.visualDistances ?? [])]);

  // Et toujours aucun pas supplémentaire : l'invariant essentiel de P013.
  const after = await readFinishCore(page);
  expect(after.steps).toBe(RACE_CONFIG.TOTAL_STEPS);
  expect([...after.distances]).toEqual([...first.distances]);

  expectNoErrors(watch);
});

test('« Rejouer la même seed » rejoue exactement la même course', async ({ page }) => {
  test.setTimeout(150_000);
  const watch = watchConsole(page);
  await page.goto(raceUrl({ seed: PLAIN_FINISH_SEED, fast: true, autostart: true }));
  await waitForFinished(page);

  const first = await readArrival(page);
  expectPodiumMatchesCore(first.core, first.dom);
  const firstUrlSeed = new URL(page.url()).searchParams.get('seed');

  await page.getByTestId('finish-replay-same').click();
  // La course repart réellement : la phase quitte `finished`…
  await page.waitForFunction(() => window.__CHAOS_RACE__?.phase() !== 'finished', null, {
    timeout: 10_000,
  });
  // …et l'écran d'arrivée disparaît tant qu'aucune nouvelle arrivée n'a eu lieu.
  await expect(page.getByTestId('finish')).toBeHidden();
  // …puis la seconde course va à son terme.
  await waitForFinished(page);

  const second = await readArrival(page);
  expectPodiumMatchesCore(second.core, second.dom);

  // Même seed source, même course, mêmes distances, même classement, même podium, 3 600 pas.
  expect(second.core.seed).toBe(first.core.seed);
  expect(second.core.steps).toBe(RACE_CONFIG.TOTAL_STEPS);
  expect([...second.core.distances]).toEqual([...first.core.distances]);
  expect(second.core.ranks.map((row) => row.id)).toEqual(first.core.ranks.map((row) => row.id));
  expect(second.core.ranks.map((row) => row.distance)).toEqual(
    first.core.ranks.map((row) => row.distance),
  );
  expect(second.dom.podium.map((row) => row.id)).toEqual(first.dom.podium.map((row) => row.id));
  expect(second.dom.rows.map((row) => row.distanceRaw)).toEqual(
    first.dom.rows.map((row) => row.distanceRaw),
  );
  expect(second.dom.winnerText).toBe(first.dom.winnerText);

  // La seed n'a pas bougé, ni dans l'URL, ni dans le HUD.
  expect(new URL(page.url()).searchParams.get('seed')).toBe(firstUrlSeed);
  expect(second.dom.seedText).toBe(PLAIN_FINISH_SEED);

  expectNoErrors(watch);
});

test('« Nouvelle course » change réellement la seed et la course (5 essais)', async ({ page }) => {
  test.setTimeout(240_000);
  const watch = watchConsole(page);
  await page.goto(raceUrl({ seed: PLAIN_FINISH_SEED, fast: true, autostart: true }));
  await waitForFinished(page);

  const initial = await readFinishCore(page);
  const seeds = [initial.seed];
  const podiums = [(initial.panel?.podiumIds ?? []).join(',')];
  const courses = [initial.distances.map((distance) => distance.toFixed(4)).join('|')];

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const previousSeed = seeds[seeds.length - 1] ?? '';
    await page.getByTestId('finish-new-race').click();

    // La nouvelle seed est réellement appliquée : ni la précédente, ni un état intermédiaire.
    await page.waitForFunction(
      (previous) => window.__CHAOS_RACE__?.seed() !== previous,
      previousSeed,
      { timeout: 15_000 },
    );
    await waitForFinished(page);

    const core = await readFinishCore(page);
    expect(core.seed, `essai ${String(attempt)} : seed différente`).not.toBe(previousSeed);
    expect(core.seed).not.toBe(PLAIN_FINISH_SEED);
    expect(core.steps, `essai ${String(attempt)} : course réellement terminée`).toBe(
      RACE_CONFIG.TOTAL_STEPS,
    );
    expect(core.tSim).toBe(RACE_CONFIG.TOTAL_SIM_S);

    // L'URL et le HUD suivent la seed réellement jouée : une seule source, partout.
    expect(new URL(page.url()).searchParams.get('seed')).toBe(core.seed);
    expect(await page.getByTestId('seed-value').textContent()).toBe(core.seed);

    seeds.push(core.seed);
    podiums.push((core.panel?.podiumIds ?? []).join(','));
    courses.push(core.distances.map((distance) => distance.toFixed(4)).join('|'));
  }

  // Les six courses ont six seeds distinctes : le bouton ne peut pas recycler la précédente.
  expect(new Set(seeds).size, 'six seeds distinctes (course initiale incluse)').toBe(6);
  // Et les courses sont réellement différentes, pas seulement leurs étiquettes.
  expect(new Set(courses).size, 'au moins deux courses différentes').toBeGreaterThan(1);
  // Sur les cinq essais, au moins un podium diffère de celui de la première course : si le bouton
  // rejouait systématiquement la même course, cette assertion — comme les précédentes — échouerait.
  expect(
    podiums.slice(1).some((podium) => podium !== podiums[0]),
    'au moins un podium différent sur les cinq essais',
  ).toBe(true);
  expect(new Set(podiums).size, 'podiums réellement variés').toBeGreaterThan(1);

  // Résumé factuel des essais : les seeds sont tirées au hasard, donc les valeurs ne sont pas
  // reproductibles — ce sont les invariants ci-dessus qui le sont.
  console.log(`[P013] Nouvelle course, 5 essais — seeds : ${seeds.slice(1).join(' ')}`);
  console.log(`[P013] Nouvelle course, 5 essais — podiums : ${podiums.join(' / ')}`);

  expectNoErrors(watch);
});

test('la mention PHOTO_FINISH apparaît si, et seulement si, le noyau l’a produite', async ({
  page,
}) => {
  test.setTimeout(150_000);
  const watch = watchConsole(page);

  // 1) Seed mesurée produisant réellement une photo finish : l'écart P1–P2 du noyau est sous le seuil
  // du design, et la mention le signale.
  await page.goto(raceUrl({ seed: PHOTO_FINISH_SEED, fast: true, autostart: true }));
  await waitForFinished(page);
  const photo = await readArrival(page);

  expectPodiumMatchesCore(photo.core, photo.dom);
  expect(photo.dom.photoVisible, 'la mention est affichée').toBe(true);
  expect(photo.dom.photoText).toContain(UI_TEXT_FR.finishPhotoBadge);
  expect(photo.dom.photoText).toContain(
    uiDistance(PHOTO_FINISH_SEED_EVIDENCE.gapMeters).toFixed(1).replace('.', ','),
  );

  // La mention vient du **fait** d'arrivée du noyau, pas d'un seuil recalculé par le rendu : l'écart
  // publié est celui de l'observateur, et il correspond bien à l'écart réel des distances finales.
  expect(photo.core.panel?.photoFinish).not.toBeNull();
  expect(photo.core.panel?.photoFinish?.gapMeters).toBe(PHOTO_FINISH_SEED_EVIDENCE.gapMeters);
  expect(photo.core.panel?.photoFinish?.leaderId).toBe(PHOTO_FINISH_SEED_EVIDENCE.leader);
  expect(photo.core.panel?.photoFinish?.secondId).toBe(PHOTO_FINISH_SEED_EVIDENCE.second);
  const best = photo.core.ranks[0]?.distance ?? 0;
  const second = photo.core.ranks[1]?.distance ?? 0;
  expect(best - second).toBeCloseTo(PHOTO_FINISH_SEED_EVIDENCE.gapMeters, 9);

  // 2) Course sans photo finish : aucune mention, ni dans le DOM, ni dans le modèle.
  await page.goto(raceUrl({ seed: PLAIN_FINISH_SEED, fast: true, autostart: true }));
  await waitForFinished(page);
  const plain = await readArrival(page);

  expect(plain.dom.photoVisible, 'aucune mention sans photo finish').toBe(false);
  expect(plain.dom.photoText).toBe('');
  expect(plain.core.panel?.photoFinish).toBeNull();
  expect(plain.dom.podium.map((row) => row.id)).toEqual(
    plain.core.ranks.map((row) => row.id).slice(0, VIEW.FINISH_PODIUM_SIZE),
  );

  expectNoErrors(watch);
});

const VIEWPORTS = [
  { name: '1280×720', width: 1280, height: 720 },
  { name: '1920×1080', width: 1920, height: 1080 },
  { name: '844×390 (téléphone paysage)', width: 844, height: 390 },
] as const;

for (const viewport of VIEWPORTS) {
  test(`l’écran d’arrivée tient dans l’arène en ${viewport.name}`, async ({ page }) => {
    test.setTimeout(120_000);
    const watch = watchConsole(page);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto(raceUrl({ seed: PLAIN_FINISH_SEED, fast: true, autostart: true }));
    await waitForFinished(page);

    // La géométrie est relevée **dans la page**, en une seule tâche : aucune mesure ne peut être
    // décalée par une frame ou une transition.
    const measured = await page.evaluate(() => {
      const asBox = (element: Element | null): Measured | null => {
        if (element === null) {
          return null;
        }
        const box = element.getBoundingClientRect();
        return {
          left: box.left,
          right: box.right,
          top: box.top,
          bottom: box.bottom,
          width: box.width,
          height: box.height,
        };
      };

      const rowBoxes = (testId: string): Measured[] =>
        Array.from(document.querySelectorAll(`[data-testid="${testId}"]`)).map((element) => {
          const box = element.getBoundingClientRect();
          return {
            left: box.left,
            right: box.right,
            top: box.top,
            bottom: box.bottom,
            width: box.width,
            height: box.height,
          };
        });

      const rows = document.querySelectorAll('[data-testid="finish-row"]');
      const firstRow = rows[0];
      return {
        arena: asBox(document.querySelector('.stage')),
        panel: asBox(document.querySelector('[data-testid="finish"]')),
        podium: asBox(document.querySelector('[data-testid="finish-podium"]')),
        ranking: asBox(document.querySelector('[data-testid="finish-ranking"]')),
        status: asBox(document.querySelector('[data-testid="race-status"]')),
        settings: asBox(document.querySelector('[data-testid="settings"]')),
        seed: asBox(document.querySelector('[data-testid="hud-seed"]')),
        time: asBox(document.querySelector('[data-testid="hud-time"]')),
        subtitle: asBox(document.querySelector('[data-testid="subtitle"]')),
        replay: asBox(document.querySelector('[data-testid="finish-replay-same"]')),
        newRace: asBox(document.querySelector('[data-testid="finish-new-race"]')),
        podiumRows: rowBoxes('finish-podium-row'),
        rows: rowBoxes('finish-row'),
        rowFontPx:
          firstRow === undefined ? 0 : Number.parseFloat(getComputedStyle(firstRow).fontSize),
      };
    });

    const arena = measured.arena;
    expect(arena, 'l’arène est mesurable').not.toBeNull();
    if (arena === null) {
      return;
    }
    const area: Box = { left: 0, right: arena.width, top: 0, bottom: arena.height };
    const relative = (box: Measured | null): Box | null =>
      box === null
        ? null
        : {
            left: box.left - arena.left,
            right: box.right - arena.left,
            top: box.top - arena.top,
            bottom: box.bottom - arena.top,
          };
    const inside = (name: string, box: Box | null): void => {
      expect(box, `${name} mesurable`).not.toBeNull();
      if (box === null) {
        return;
      }
      expect(box.left, `${name} ne sort pas à gauche`).toBeGreaterThanOrEqual(-1);
      expect(box.top, `${name} ne sort pas en haut`).toBeGreaterThanOrEqual(-1);
      expect(box.right, `${name} ne sort pas à droite`).toBeLessThanOrEqual(area.right + 1);
      expect(box.bottom, `${name} ne sort pas en bas`).toBeLessThanOrEqual(area.bottom + 1);
    };

    const panel = relative(measured.panel);
    const podium = relative(measured.podium);
    const ranking = relative(measured.ranking);
    const replay = relative(measured.replay);
    const newRace = relative(measured.newRace);

    // 1) L'écran d'arrivée, ses trois marcheurs de podium, ses six résultats et ses deux boutons sont
    // entièrement dans l'arène : aucune information essentielle hors écran.
    inside('écran d’arrivée', panel);
    inside('podium', podium);
    inside('classement final', ranking);
    inside('bouton « Rejouer la même seed »', replay);
    inside('bouton « Nouvelle course »', newRace);
    expect(measured.rows, 'six résultats affichés').toHaveLength(6);
    expect(measured.podiumRows, 'trois marcheurs sur le podium').toHaveLength(3);
    for (const [index, box] of measured.rows.entries()) {
      inside(`résultat ${String(index + 1)}`, relative(box));
      expect(box.height, `résultat ${String(index + 1)} lisible`).toBeGreaterThan(6);
    }
    for (const [index, box] of measured.podiumRows.entries()) {
      inside(`podium ${String(index + 1)}`, relative(box));
      expect(box.height, `podium ${String(index + 1)} lisible`).toBeGreaterThan(6);
    }

    // 2) Les boutons sont utilisables : taille réelle et clics reçus.
    for (const [name, box, element] of [
      ['Rejouer la même seed', measured.replay, '[data-testid="finish-replay-same"]'],
      ['Nouvelle course', measured.newRace, '[data-testid="finish-new-race"]'],
    ] as const) {
      expect(box, `${name} mesurable`).not.toBeNull();
      expect(box?.height ?? 0, `${name} cliquable`).toBeGreaterThanOrEqual(14);
      expect(box?.width ?? 0, `${name} cliquable`).toBeGreaterThanOrEqual(40);
      const pointerEvents = await page
        .locator(element)
        .evaluate((node) => getComputedStyle(node).pointerEvents);
      expect(pointerEvents, `${name} reçoit les clics`).toBe('auto');
    }

    // 3) Aucun recouvrement : ni entre le podium et le classement, ni entre l'écran d'arrivée et les
    // blocs de course qui restent affichés (statut, réglages, chrono, seed, commentaire).
    expect(podium, 'podium mesurable').not.toBeNull();
    expect(ranking, 'classement mesurable').not.toBeNull();
    if (podium !== null && ranking !== null) {
      expect(overlaps(podium, ranking), 'le podium ne recouvre pas le classement').toBe(false);
    }
    if (panel !== null) {
      for (const [name, box] of [
        ['état', relative(measured.status)],
        ['réglages', relative(measured.settings)],
        ['chrono', relative(measured.time)],
        ['seed', relative(measured.seed)],
        ['commentaire', relative(measured.subtitle)],
      ] as const) {
        if (box === null) {
          continue;
        }
        expect(overlaps(panel, box), `l’écran d’arrivée ne recouvre pas ${name}`).toBe(false);
      }
    }

    // 4) Les résultats restent lisibles à cette résolution.
    expect(measured.rowFontPx, 'le classement final reste lisible').toBeGreaterThanOrEqual(8);

    // 5) Sur la résolution la plus contrainte, un bouton réellement cliqué doit lancer une course :
    // c'est la preuve que l'écran d'arrivée est utilisable, et pas seulement affiché.
    if (viewport.width === 844) {
      await page.getByTestId('finish-new-race').click();
      await expect(page.getByTestId('finish')).toBeHidden();
      await page.waitForFunction(() => window.__CHAOS_RACE__?.phase() !== 'finished', null, {
        timeout: 10_000,
      });
    }

    expectNoErrors(watch);
  });
}
