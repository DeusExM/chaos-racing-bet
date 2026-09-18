import { describe, expect, it } from 'vitest';

import { CHARACTER_IDS } from '../../src/core/characters';
import { arenaBaseSize } from '../../src/render/viewport';
import {
  VIEW,
  characterHeightPx,
  characterNameDepth,
  characterNameFontPx,
  characterNameStrokePx,
  characterNameY,
  laneRatios,
  laneY,
} from '../../src/render/viewConfig';

/**
 * Géométrie des voies : c'est elle qui décide si les personnages se chevauchent, si leur nom reste
 * lisible et si la voie du haut ne sort pas du canvas.
 *
 * ## Pourquoi ces vérifications sont ici et pas seulement en E2E
 *
 * Le test E2E mesure ce qui est **réellement dessiné** dans un navigateur, à trois ou quatre
 * résolutions. Mais il ne dit pas *pourquoi* une valeur tient : ces contrôles-ci portent sur les
 * constantes et sur la fonction pure, donc ils échouent **avant** qu'un réglage ne casse la mise en
 * page, et ils expliquent la contrainte plutôt que de la constater.
 *
 * ## Ce qui a changé avec la micro-correction finale
 *
 * En petit paysage, le nom n'est plus posé **au-dessus** du personnage : il partage son axe et passe
 * derrière lui (`characterNameY`, `characterNameDepth`). La contrainte « le nom tient au-dessus de la
 * tête » disparaît donc au profit de deux autres, plus simples : le nom reste **dans le cadre du
 * sprite** (donc il ne réserve aucune hauteur) et deux cadres voisins ne se touchent pas. C'est ce
 * qui permet d'agrandir les personnages sans rapprocher les voies. Sur bureau, rien ne change : le
 * nom reste au-dessus de la tête, au-dessus du sprite, sans contour.
 *
 * Le facteur `1.25` est la hauteur de ligne retenue pour le nom : c'est la valeur usuelle d'un texte
 * `system-ui` (ascendante + descendante + interligne) et elle est **conservatrice** — Phaser mesure
 * un peu moins. Une marge de quelques pixels reste donc disponible.
 */

const LABEL_LINE_HEIGHT_FACTOR = 1.25;

/**
 * Marge transparente des illustrations, en fraction de leur hauteur.
 *
 * Mesurée sur les fichiers servis par `tools/optimizeCharacterAssets.mjs` : la silhouette visible
 * occupe 89,4 % à 95,6 % du cadre. La borne retenue est la **pire** des deux, et elle est appliquée
 * en entier sous la silhouette : c'est donc une borne conservatrice, pas une mesure.
 */
const WORST_CASE_TRANSPARENT_MARGIN = 1 - 0.894;

/** Hauteur du libellé de nom d'un personnage, en pixels logiques. */
function nameLabelHeight(compact: boolean): number {
  return characterNameFontPx(compact) * LABEL_LINE_HEIGHT_FACTOR;
}

/** Ordonnées des six voies, dans l'ordre du roster. */
function laneCenters(compact: boolean): number[] {
  return CHARACTER_IDS.map((_, index) => laneY(index, VIEW.BASE_HEIGHT, compact));
}

describe('zone des voies', () => {
  it('répartit les six voies entre les ratios du format, sans en perdre aucune', () => {
    for (const compact of [false, true]) {
      const centers = laneCenters(compact);
      const ratios = laneRatios(compact);
      expect(centers).toHaveLength(CHARACTER_IDS.length);
      expect(centers[0]).toBeCloseTo(VIEW.BASE_HEIGHT * ratios.top, 6);
      expect(centers[centers.length - 1]).toBeCloseTo(VIEW.BASE_HEIGHT * ratios.bottom, 6);
      // Espacement constant : les voies ne s'écrasent pas les unes contre les autres.
      const spacings = centers.slice(1).map((value, index) => value - (centers[index] ?? 0));
      for (const spacing of spacings) {
        expect(spacing).toBeCloseTo(spacings[0] ?? 0, 6);
        expect(spacing).toBeGreaterThan(0);
      }
    }
  });

  it('donne plus de place aux voies en petit paysage', () => {
    const desktop = laneCenters(false);
    const compact = laneCenters(true);
    const desktopSpacing = (desktop[1] ?? 0) - (desktop[0] ?? 0);
    const compactSpacing = (compact[1] ?? 0) - (compact[0] ?? 0);
    expect(compactSpacing).toBeGreaterThan(desktopSpacing);
  });

  it('garde le nom de la première voie entier, dans les deux formats', () => {
    for (const compact of [false, true]) {
      const centers = laneCenters(compact);
      const first = centers[0] ?? 0;
      // Le nom a son origine en bas (`setOrigin(0.5, 1)`) : il occupe donc la bande juste au-dessus
      // de l'ordonnée calculée.
      const labelTop =
        characterNameY(first, characterHeightPx(compact), compact) - nameLabelHeight(compact);
      expect(labelTop, 'le nom de la première voie sort du haut du canvas').toBeGreaterThanOrEqual(0);
    }
  });

  it('dessine le nom dans la voie et derrière le personnage en petit paysage', () => {
    const compact = true;
    const height = characterHeightPx(compact);
    for (const center of laneCenters(compact)) {
      const nameY = characterNameY(center, height, compact);
      // Même axe que le personnage : le nom ne réserve donc **aucune** hauteur au-dessus de lui.
      expect(nameY, 'le nom partage l’axe du personnage').toBe(center);
      // Et il tient entièrement dans le cadre du sprite : rien ne dépasse de son encombrement.
      expect(nameY - nameLabelHeight(compact)).toBeGreaterThanOrEqual(center - height / 2);
      expect(nameY).toBeLessThanOrEqual(center + height / 2);
    }
    // Derrière : sa profondeur est sous celle du premier sprite. Et il porte un contour, sans quoi la
    // partie recouverte se confondrait avec l'illustration.
    expect(characterNameDepth(compact)).toBeLessThan(VIEW.CHARACTER_SPRITE_DEPTH_BASE);
    expect(characterNameStrokePx(compact)).toBeGreaterThan(0);
  });

  it('laisse le nom au-dessus de la tête sur les formats de bureau', () => {
    const height = characterHeightPx(false);
    const first = laneCenters(false)[0] ?? 0;
    expect(characterNameY(first, height, false)).toBe(first - height / 2 - 2);
    expect(characterNameDepth(false)).toBeGreaterThanOrEqual(VIEW.CHARACTER_SPRITE_DEPTH_BASE);
    expect(characterNameStrokePx(false)).toBe(0);
  });

  it('garde la dernière silhouette entière, dans les deux formats', () => {
    for (const compact of [false, true]) {
      const centers = laneCenters(compact);
      const last = centers[centers.length - 1] ?? 0;
      expect(last + characterHeightPx(compact) / 2).toBeLessThanOrEqual(VIEW.BASE_HEIGHT);
    }
  });

  it('ne laisse aucun nom recouvrir la silhouette visible de la voie au-dessus', () => {
    for (const compact of [false, true]) {
      const centers = laneCenters(compact);
      const height = characterHeightPx(compact);
      for (let index = 1; index < centers.length; index += 1) {
        const center = centers[index] ?? 0;
        const above = centers[index - 1] ?? 0;
        const labelTop =
          characterNameY(center, height, compact) - nameLabelHeight(compact);
        // Silhouette visible de la voie du dessus, dans l'hypothèse la plus défavorable : toute la
        // marge transparente est sous le personnage.
        const visibleBottom = above + height / 2 - height * WORST_CASE_TRANSPARENT_MARGIN;
        expect(
          labelTop,
          `le nom de la voie ${String(index)} recouvre la silhouette de la voie ${String(index - 1)}`,
        ).toBeGreaterThanOrEqual(visibleBottom);
      }
    }
  });

  it('ne laisse aucune silhouette empiéter sur la voie voisine', () => {
    for (const compact of [false, true]) {
      const centers = laneCenters(compact);
      const height = characterHeightPx(compact);
      for (let index = 1; index < centers.length; index += 1) {
        const gap = (centers[index] ?? 0) - (centers[index - 1] ?? 0);
        expect(
          gap - height,
          `les voies ${String(index - 1)} et ${String(index)} se chevauchent`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it('agrandit les personnages en petit paysage, dans la fourchette demandée', () => {
    const compactHeight = characterHeightPx(true);
    expect(compactHeight).toBeGreaterThan(characterHeightPx(false));
    // Fourchette issue du test joueur sur iPhone : 94 à 100 px logiques, la plus grande valeur qui
    // respecte les contraintes ci-dessus étant retenue.
    expect(compactHeight).toBeGreaterThanOrEqual(94);
    expect(compactHeight).toBeLessThanOrEqual(100);
    // Le nom grandit aussi : le canvas d'un téléphone est réduit à ≈ 0,54, donc la police nominale
    // rendrait ≈ 7,5 px CSS, sous le plancher de lisibilité.
    expect(characterNameFontPx(true)).toBeGreaterThan(characterNameFontPx(false));
  });
});

describe('taille logique de l’arène', () => {
  it('reste 1280×720 sur les formats de bureau', () => {
    for (const box of [
      { width: 1280, height: 720 },
      { width: 1920, height: 1080 },
      { width: 1440, height: 900 },
    ]) {
      expect(arenaBaseSize(box.width, box.height, false)).toEqual({
        width: VIEW.BASE_WIDTH,
        height: VIEW.BASE_HEIGHT,
      });
    }
  });

  it('épouse le rapport de la piste en petit paysage, en gardant la hauteur logique', () => {
    // 844×390 avec une colonne de 30 % : la piste fait 590,8 × 390.
    const size = arenaBaseSize(590.8, 390, true);
    expect(size.height).toBe(VIEW.BASE_HEIGHT);
    expect(size.width / size.height).toBeCloseTo(590.8 / 390, 2);
    // La hauteur logique ne change pas : toute la géométrie verticale (voies, noms) garde son sens.
    expect(size.width).not.toBe(VIEW.BASE_WIDTH);
  });

  it('ne descend jamais sous la largeur logique minimale', () => {
    const size = arenaBaseSize(200, 500, true);
    expect(size.width).toBe(VIEW.COMPACT_MIN_BASE_WIDTH);
    expect(size.height).toBe(VIEW.BASE_HEIGHT);
  });

  it('retombe sur l’arène de bureau quand la boîte n’est pas mesurable', () => {
    expect(arenaBaseSize(0, 0, true)).toEqual({
      width: VIEW.BASE_WIDTH,
      height: VIEW.BASE_HEIGHT,
    });
    expect(arenaBaseSize(-10, 40, true)).toEqual({
      width: VIEW.BASE_WIDTH,
      height: VIEW.BASE_HEIGHT,
    });
  });
});
