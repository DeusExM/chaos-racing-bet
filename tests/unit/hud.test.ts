import { describe, expect, it } from 'vitest';

import { RACE_CONFIG, SPEED } from '../../src/core/config';
import { CHARACTERS } from '../../src/core/characters';
import { UI_TEXT_FR } from '../../src/app/strings.fr';
import { minimapMarkers } from '../../src/render/view/minimap';
import type { MinimapMarkerInput } from '../../src/render/view/minimap';
import {
  formatCheckpointInstant,
  formatGapMeters,
  formatGapSeconds,
  formatScaleLabel,
  formatScaleOverflow,
  formatSimTime,
} from '../../src/render/view/Hud';
import { VIEW } from '../../src/render/viewConfig';

/**
 * Mini-carte : le placement des 6 marqueurs est une fonction **pure**, testée sans navigateur.
 *
 * C'est ce qui permet de vérifier le cas du dépassement de l'échelle nominale sans jamais toucher au
 * gameplay : une course réelle ne fait presque jamais dépasser `NOMINAL_SCALE_M`, mais la fonction,
 * elle, doit être correcte pour n'importe quelle distance.
 */

const SCALE = VIEW.NOMINAL_SCALE_M;

function inputs(distances: readonly number[]): MinimapMarkerInput[] {
  return CHARACTERS.map((character, index) => ({
    id: character.id,
    distance: distances[index] ?? 0,
    color: character.color,
  }));
}

describe('mini-carte : échelle et ordre', () => {
  it('place le départ à 0 et l’échelle nominale à 1', () => {
    const markers = minimapMarkers(inputs([0, SCALE / 2, SCALE, 0, 0, 0]), SCALE);
    expect(markers[0]?.position).toBe(0);
    expect(markers[1]?.position).toBe(0.5);
    expect(markers[2]?.position).toBe(1);
  });

  it('conserve strictement l’ordre des distances', () => {
    const markers = minimapMarkers(inputs([100, 900, 400, 2160, 12, 1400]), SCALE);
    const ordered = [...markers].sort((a, b) => a.distance - b.distance).map((marker) => marker.id);
    const byPosition = [...markers].sort((a, b) => a.position - b.position).map((marker) => marker.id);
    expect(byPosition).toEqual(ordered);
  });

  it('ne signale aucun dépassement tant que l’échelle n’est pas franchie', () => {
    const markers = minimapMarkers(inputs([SCALE, SCALE - 0.001, 0, 10, 500, 1000]), SCALE);
    for (const marker of markers) {
      expect(marker.overflow, `dépassement de ${marker.id}`).toBe(false);
      expect(marker.overflowM).toBe(0);
    }
  });

  it('borne le marqueur à l’extrémité et publie le dépassement au-delà de l’échelle', () => {
    const markers = minimapMarkers(inputs([SCALE + 12, SCALE * 1.5, 0, 0, 0, 0]), SCALE);
    expect(markers[0]?.position).toBe(1);
    expect(markers[0]?.overflow).toBe(true);
    expect(markers[0]?.overflowM).toBeCloseTo(12, 10);
    expect(markers[1]?.position).toBe(1);
    expect(markers[1]?.overflowM).toBeCloseTo(SCALE * 0.5, 6);
  });

  it('n’écrit jamais une position hors de [0 ; 1]', () => {
    const markers = minimapMarkers(inputs([-50, 0, SCALE * 3, 1, 2, 3]), SCALE);
    for (const marker of markers) {
      expect(marker.position).toBeGreaterThanOrEqual(0);
      expect(marker.position).toBeLessThanOrEqual(1);
    }
  });

  it('conserve la distance du noyau telle quelle', () => {
    const markers = minimapMarkers(inputs([123.456, 0, 0, 0, 0, 0]), SCALE);
    expect(markers[0]?.distance).toBe(123.456);
    expect(markers[0]?.color).toBe(CHARACTERS[0]?.color);
  });

  it('refuse une échelle inutilisable', () => {
    expect(() => minimapMarkers(inputs([0, 0, 0, 0, 0, 0]), 0)).toThrow(RangeError);
    expect(() => minimapMarkers(inputs([0, 0, 0, 0, 0, 0]), Number.NaN)).toThrow(RangeError);
  });

  it('refuse une distance non finie', () => {
    expect(() => minimapMarkers(inputs([Number.POSITIVE_INFINITY, 0, 0, 0, 0, 0]), SCALE)).toThrow(
      RangeError,
    );
  });
});

describe('HUD : formats affichés', () => {
  const metres = UI_TEXT_FR.metres;

  it('écrit les écarts en mètres à la française, signés sauf pour le leader', () => {
    expect(formatGapMeters(0, metres)).toBe(`0,0${metres}`);
    expect(formatGapMeters(3.24, metres)).toBe(`+3,2${metres}`);
  });

  it('écrit les écarts en secondes à la française, signés sauf pour le leader', () => {
    expect(formatGapSeconds(0, 's')).toBe('0,0\u00A0s');
    expect(formatGapSeconds(0.35, 's')).toBe('+0,3\u00A0s');
  });

  it('écrit le temps simulé et les bornes de pointage', () => {
    expect(formatSimTime(45, 's')).toBe('45,0\u00A0s');
    expect(formatSimTime(180, 's')).toBe('180,0\u00A0s');
    expect(formatCheckpointInstant(135, 's')).toBe('135\u00A0s');
  });

  it('n’affiche l’indicateur de dépassement que s’il existe', () => {
    expect(formatScaleOverflow(0, metres)).toBe('');
    expect(formatScaleOverflow(-3, metres)).toBe('');
    expect(formatScaleOverflow(12.4, metres)).toBe(`+12${metres}`);
  });

  it('nomme l’échelle nominale avec sa valeur réelle', () => {
    expect(formatScaleLabel(VIEW.NOMINAL_SCALE_M, 'échelle nominale', metres)).toBe(
      `échelle nominale ${String(VIEW.NOMINAL_SCALE_M)}${metres}`,
    );
    // L'échelle du décor est la distance qu'aurait parcourue un coureur exactement à `SPEED.BASE`.
    expect(VIEW.NOMINAL_SCALE_M).toBe(SPEED.BASE * RACE_CONFIG.TOTAL_SIM_S);
  });
});
