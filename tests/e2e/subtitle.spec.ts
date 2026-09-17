import { expect, test } from '@playwright/test';

import { SPEAKER_CATALOGUE_FR, SPEAKER_FACT_TYPES } from '../../src/app/strings.fr';
import { CHARACTERS } from '../../src/core/characters';
import type { RaceFact } from '../../src/core/types';
import { SPEAKER_POLICY } from '../../src/speaker/policy';
import { OVERTAKE_SEED } from '../fixtures/seeds';
import {
  collectRace,
  expectNoErrors,
  raceUrl,
  watchConsole,
  type FrameSample,
} from './helpers';

/**
 * P012 — affichage du speaker.
 *
 * Deux exigences structurent ces tests : le texte montré doit correspondre à un **fait réellement
 * mesuré** (recalculé depuis le fait exposé par le hook, jamais « du texte existe »), et l'affichage
 * doit respecter la discipline de parole du speaker, y compris sa préemption.
 */

/** Rectangle mesuré dans la page, exprimé relativement à l'arène. */
interface Box {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

interface Measured {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

/** Vrai si deux rectangles se recouvrent réellement, avec une tolérance de 1 px. */
function overlaps(a: Box, b: Box): boolean {
  return a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
}

function relativeTo(box: Measured, arena: Measured): Box {
  return {
    left: box.left - arena.left,
    right: box.right - arena.left,
    top: box.top - arena.top,
    bottom: box.bottom - arena.top,
  };
}

/** Indices des frames où une **nouvelle** réplique commence à être affichée. */
function lineStarts(samples: readonly FrameSample[]): number[] {
  const starts: number[] = [];
  let previousText = '';
  samples.forEach((sample, index) => {
    const text = sample.subtitleLine?.text ?? '';
    if (text.length > 0 && text !== previousText) {
      starts.push(index);
    }
    if (text.length > 0) {
      previousText = text;
    }
  });
  return starts;
}

test('affiche une réplique réelle, reconstruite depuis le fait mesuré', async ({ page }) => {
  const watch = watchConsole(page);
  await page.goto(raceUrl({ seed: OVERTAKE_SEED, fast: true, autostart: true }));

  const samples = await collectRace(page);
  const index = samples.findIndex((sample) => sample.subtitleLine !== null);
  expect(index, 'au moins une réplique doit apparaître pendant la course').toBeGreaterThanOrEqual(0);

  const sample = samples[index];
  const line = sample?.subtitleLine ?? null;
  expect(line).not.toBeNull();
  expectNoErrors(watch);
  if (line === null) {
    return;
  }

  // 1) Le texte affiché est **exactement** la variante du catalogue appliquée au fait exposé : il ne
  //    s'agit donc pas d'un texte plausible, mais du texte que ce fait doit produire.
  expect(SPEAKER_FACT_TYPES).toContain(line.fact.type);
  const formatter = SPEAKER_CATALOGUE_FR.lines[line.fact.type][line.variantIndex];
  expect(formatter, `variante ${line.variantIndex} absente pour ${line.fact.type}`).toBeDefined();
  const expected = (formatter as (fact: RaceFact) => string)(line.fact);
  expect(line.text).toBe(expected);
  expect(sample?.subtitle, 'le texte affiché est celui du modèle').toBe(expected);

  // 2) Le fait est un fait **du noyau** : horodaté sur une frontière de pas, jamais dans le futur, et
  //    cohérent avec l'instant de démarrage de la réplique.
  expect(Number.isFinite(line.fact.tSim)).toBe(true);
  const steps = line.fact.tSim * 60;
  expect(Math.abs(steps - Math.round(steps)), 'tSim est un multiple du pas fixe').toBeLessThan(1e-6);
  const nowS = samples[index]?.tSim ?? 0;
  expect(line.fact.tSim).toBeLessThanOrEqual(nowS + 1e-9);
  expect(line.fact.tSim).toBeGreaterThanOrEqual(0);
  expect(line.startedAtS).toBeGreaterThanOrEqual(line.fact.tSim);
  expect(line.startedAtS).toBeLessThanOrEqual(nowS + 1e-9);

  // 3) Les personnages du fait appartiennent au roster, et la phrase ne contient aucun gabarit.
  const roster = CHARACTERS.map((character) => character.name);
  expect(CHARACTERS.map((character) => character.id)).toEqual(
    expect.arrayContaining([...line.fact.characterIds]),
  );
  expect(line.text).not.toMatch(/[{}]/);
  for (const magnitude of line.fact.magnitudes) {
    expect(Number.isFinite(magnitude)).toBe(true);
  }

  // 4) Le nom mis en avant est celui que la phrase prononce — jamais un nom plaqué.
  if (line.characterName === null) {
    expect(sample?.subtitleName).toBe('');
  } else {
    expect(roster).toContain(line.characterName);
    expect(line.text, 'le nom mis en avant est réellement cité').toContain(line.characterName);
    expect(sample?.subtitleName).toBe(line.characterName);
  }
});

test('n’affiche jamais deux nouvelles répliques à moins de 6 s simulées, hors préemption', async ({
  page,
}) => {
  // Mode **normal** (×1) volontairement. La durée d'affichage d'une réplique est exprimée en
  // millisecondes **réelles** (`VIEW.SUBTITLE_*`), alors que le cooldown du speaker l'est en secondes
  // **simulées** : à ×20, une course de 60 s dure ~3 s réelles, donc aucune réplique n'a le temps
  // d'expirer et chaque nouvelle réplique serait — à juste titre — comptée comme une préemption. À ×1
  // les deux horloges coïncident, et la discipline observée est celle que le joueur entend.
  test.setTimeout(120_000);
  const watch = watchConsole(page);
  await page.goto(raceUrl({ seed: OVERTAKE_SEED, autostart: true }));
  // ~33 s réelles : assez pour plusieurs répliques, sans attendre la fin de la course (72 s).
  const samples = await collectRace(page, 2000);

  const starts = lineStarts(samples);
  expect(starts.length, 'la course doit produire plusieurs répliques').toBeGreaterThan(2);

  let normalStarts = 0;
  let bypassStarts = 0;
  for (let position = 1; position < starts.length; position += 1) {
    const previous = samples[starts[position - 1] ?? 0]?.subtitleLine ?? null;
    const current = samples[starts[position] ?? 0]?.subtitleLine ?? null;
    expect(previous).not.toBeNull();
    expect(current).not.toBeNull();
    if (previous === null || current === null) {
      continue;
    }

    const delta = current.startedAtS - previous.startedAtS;
    if (delta < SPEAKER_POLICY.globalCooldownS) {
      // Un démarrage plus rapproché n'est ouvert qu'aux faits dont l'importance atteint
      // `PREEMPT_IMPORTANCE` : c'est la règle du speaker, vérifiée ici sur les répliques réellement
      // affichées par le navigateur.
      expect(
        current.fact.importance,
        `démarrage à ${delta.toFixed(2)} s simulées (types ${previous.fact.type} → ${current.fact.type})`,
      ).toBeGreaterThanOrEqual(SPEAKER_POLICY.preemptImportance);
      bypassStarts += 1;
      continue;
    }

    normalStarts += 1;
  }

  // Toute préemption — affichée comme telle — est elle aussi réservée aux faits majeurs.
  for (const sample of samples) {
    const line = sample.subtitleLine;
    if (line?.preempted === true) {
      expect(line.fact.importance).toBeGreaterThanOrEqual(SPEAKER_POLICY.preemptImportance);
    }
  }

  // Le test distingue réellement les deux cas : il ne se contente pas d'une marge arbitraire.
  expect(normalStarts, 'des démarrages normaux ont été observés').toBeGreaterThan(0);
  expect(bypassStarts).toBeGreaterThanOrEqual(0);
  expectNoErrors(watch);
});

test('la file affichée est celle du speaker, sans duplication', async ({ page }) => {
  const watch = watchConsole(page);
  await page.goto(raceUrl({ seed: OVERTAKE_SEED, fast: true, autostart: true }));
  const samples = await collectRace(page);

  let badges = 0;
  for (const sample of samples) {
    const line = sample.subtitleLine;
    if (line === null) {
      continue;
    }
    if (sample.subtitleQueue.length === 0) {
      expect(line.queuedCount, 'aucun libellé quand la file est vide').toBe(0);
      continue;
    }

    badges += 1;
    const shown = Number.parseInt(sample.subtitleQueue.replace(/[^0-9]/g, ''), 10);
    expect(shown, 'l’indicateur affiche le nombre réel de répliques en attente').toBe(
      line.queuedCount,
    );
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThanOrEqual(SPEAKER_POLICY.queueMax);
  }

  expect(badges, 'au moins une réplique en attente a été signalée').toBeGreaterThan(0);
  expectNoErrors(watch);
});

test('retire proprement le bandeau après l’arrivée', async ({ page }) => {
  const watch = watchConsole(page);
  await page.goto(raceUrl({ seed: OVERTAKE_SEED, fast: true, autostart: true }));
  const samples = await collectRace(page);
  expect(samples.at(-1)?.simPhase).toBe('finished');

  await page.waitForFunction(
    () => document.querySelector('[data-testid="subtitle"]')?.hasAttribute('hidden') ?? false,
    null,
    { timeout: 10_000 },
  );
  const state = await page.evaluate(() => {
    const banner = document.querySelector('[data-testid="subtitle"]');
    return {
      text: window.__CHAOS_RACE_VIEW__?.subtitle() ?? '',
      line: window.__CHAOS_RACE_VIEW__?.subtitleLine() ?? null,
      hidden: banner?.hasAttribute('hidden') ?? false,
      opacity: banner instanceof HTMLElement ? banner.style.opacity : '1',
    };
  });

  expect(state.text).toBe('');
  expect(state.line).toBeNull();
  expect(state.hidden, 'le bandeau masqué ne réserve aucune place').toBe(true);
  expect(state.opacity).toBe('0');
  expectNoErrors(watch);
});

const VIEWPORTS = [
  { name: '1280×720', width: 1280, height: 720 },
  { name: '1920×1080', width: 1920, height: 1080 },
  { name: '844×390 (téléphone paysage)', width: 844, height: 390 },
] as const;

for (const viewport of VIEWPORTS) {
  test(`le bandeau et les réglages cohabitent avec le HUD en ${viewport.name}`, async ({ page }) => {
    const watch = watchConsole(page);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto(raceUrl({ seed: OVERTAKE_SEED, fast: true, autostart: true }));

    // La scrutation tourne **dans la page** : la géométrie est figée dans la même tâche que
    // l'observation d'une réplique, sinon elle serait mesurée après la disparition du bandeau.
    const measured = await page.evaluate(async (timeoutMs: number) => {
      const read = (selector: string): DOMRect | null => {
        const element = document.querySelector(selector);
        return element === null ? null : element.getBoundingClientRect();
      };
      const asRect = (box: DOMRect | null): Measured | null =>
        box === null
          ? null
          : {
              left: box.left,
              right: box.right,
              top: box.top,
              bottom: box.bottom,
              width: box.width,
              height: box.height,
            };

      const deadline = performance.now() + timeoutMs;
      while ((window.__CHAOS_RACE_VIEW__?.subtitle() ?? '').length === 0) {
        if (performance.now() > deadline) {
          return null;
        }
        await new Promise((resolve) => {
          requestAnimationFrame(() => {
            resolve(null);
          });
        });
      }

      const text = document.querySelector('[data-testid="subtitle-text"]');
      const sound = document.querySelector('[data-testid="settings-sound"]');
      return {
        arena: asRect(read('.stage')),
        subtitle: asRect(read('[data-testid="subtitle"]')),
        settings: asRect(read('[data-testid="settings"]')),
        status: asRect(read('[data-testid="race-status"]')),
        leaderboard: asRect(read('[data-testid="leaderboard"]')),
        time: asRect(read('[data-testid="hud-time"]')),
        seed: asRect(read('[data-testid="hud-seed"]')),
        checkpoint: asRect(read('[data-testid="checkpoint-banner"]')),
        subtitleFontPx:
          text === null ? 0 : Number.parseFloat(getComputedStyle(text).fontSize),
        soundHeight: sound === null ? 0 : sound.getBoundingClientRect().height,
      };
    }, 60_000);

    expect(measured, `une réplique doit être visible en ${viewport.name}`).not.toBeNull();
    if (measured === null || measured.arena === null) {
      return;
    }
    const arenaBox: Box = { left: 0, right: measured.arena.width, top: 0, bottom: measured.arena.height };

    const subtitle = measured.subtitle === null ? null : relativeTo(measured.subtitle, measured.arena);
    const settings = measured.settings === null ? null : relativeTo(measured.settings, measured.arena);
    const status = measured.status === null ? null : relativeTo(measured.status, measured.arena);
    const leaderboard =
      measured.leaderboard === null ? null : relativeTo(measured.leaderboard, measured.arena);
    const time = measured.time === null ? null : relativeTo(measured.time, measured.arena);
    const seed = measured.seed === null ? null : relativeTo(measured.seed, measured.arena);

    // 1) Le bandeau et les réglages sont réellement affichés, et entièrement dans l'arène.
    expect(subtitle, 'le bandeau est affiché').not.toBeNull();
    expect(settings, 'les réglages sont affichés').not.toBeNull();
    for (const [name, box] of [
      ['bandeau', subtitle],
      ['réglages', settings],
    ] as const) {
      expect(box, name).not.toBeNull();
      if (box === null) {
        continue;
      }
      expect(box.left, `${name} ne sort pas à gauche`).toBeGreaterThanOrEqual(-1);
      expect(box.top, `${name} ne sort pas en haut`).toBeGreaterThanOrEqual(-1);
      expect(box.right, `${name} ne sort pas à droite`).toBeLessThanOrEqual(arenaBox.right + 1);
      expect(box.bottom, `${name} ne sort pas en bas`).toBeLessThanOrEqual(arenaBox.bottom + 1);
    }

    // 2) Aucune information essentielle du HUD n'est recouverte par le bandeau ou les réglages.
    if (subtitle !== null) {
      for (const [name, box] of [
        ['classement', leaderboard],
        ['chrono', time],
        ['seed', seed],
        ['état', status],
      ] as const) {
        if (box === null) {
          continue;
        }
        expect(overlaps(subtitle, box), `le bandeau ne recouvre pas ${name}`).toBe(false);
      }

      // 2 bis) Le commentaire est une **bande**, pas un panneau : largeur et hauteur bornées. C'est
      // l'exigence §6 de la passe corrective — le premier test joueur trouvait que le speaker masquait
      // l'action. La largeur est celle du texte (bornée par `max-width: min(100%, 34rem)`), donc la
      // borne vérifiée est une fraction de la piste : sous 90 %, le bandeau ne peut pas traverser
      // l'arène de part en part.
      const subtitleWidth = subtitle.right - subtitle.left;
      const subtitleHeight = subtitle.bottom - subtitle.top;
      expect(
        subtitleWidth,
        'le bandeau reste une bande, pas un bloc central',
      ).toBeLessThanOrEqual(arenaBox.right * 0.9);
      expect(
        subtitleHeight,
        'le bandeau ne prend qu’une fraction de la hauteur de la piste',
      ).toBeLessThanOrEqual(arenaBox.bottom * 0.2);
    }
    if (settings !== null) {
      for (const [name, box] of [
        ['état', status],
        ['chrono', time],
        ['seed', seed],
        ['classement', leaderboard],
      ] as const) {
        if (box === null) {
          continue;
        }
        expect(overlaps(settings, box), `les réglages ne recouvrent pas ${name}`).toBe(false);
      }
    }

    // 3) Le texte reste lisible, et les boutons de réglages utilisables à cette résolution.
    expect(measured.subtitleFontPx, 'le commentaire reste lisible').toBeGreaterThanOrEqual(8);
    expect(measured.soundHeight, 'le bouton « Son » est cliquable').toBeGreaterThanOrEqual(12);
    await page.getByTestId('settings-sound').click();
    await expect(page.getByTestId('settings-sound')).toHaveAttribute('aria-pressed', 'true');
    await page.getByTestId('settings-sound').click();
    await expect(page.getByTestId('settings-sound')).toHaveAttribute('aria-pressed', 'false');

    expectNoErrors(watch);
  });
}
