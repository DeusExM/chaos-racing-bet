import { describe, expect, it } from 'vitest';

import { CHARACTER_IDS } from '../../src/core/characters';
import { arenaBaseSize } from '../../src/render/viewport';
import {
  VIEW,
  characterHeightPx,
  characterNameFontPx,
  characterNameOrigin,
  characterNameX,
  characterNameY,
  laneBand,
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
 * ## Ce qui a changé avec la micro-correction finale, puis avec la finition 2D
 *
 * En petit paysage, le nom n'est plus posé **au-dessus** du personnage : il vit dans la voie, sur son
 * axe (`characterNameY`), et **derrière lui au sens de la course** — c'est-à-dire à sa **gauche**,
 * puisque la course va de gauche à droite (`characterNameX`). « Derrière » ne veut donc pas dire sous
 * l'image : le texte est séparé du sprite par `CHARACTER_NAME_GAP_PX` et n'est **jamais** recouvert
 * par lui, ce qui explique qu'il n'ait plus besoin de contour.
 *
 * La passe de finition 2D a étendu cette règle aux **formats de bureau** : il n'existe plus qu'une
 * seule mise en place, et le format n'entre plus dans la décision. C'est ce qui a permis d'agrandir
 * les personnages sur bureau (73 → 92 px logiques) en élargissant la zone des voies, sans rapprocher
 * les silhouettes : le nom ne consomme plus de hauteur au-dessus du sprite.
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

/**
 * Part du cadre occupée par la silhouette dans le cas le plus défavorable, mesurée sur les mêmes
 * fichiers (95,6 % pour le personnage le plus haut). C'est la valeur qui décide de la séparation
 * visible entre deux voies voisines.
 */
const MAX_VISIBLE_FRACTION = 0.956;

/** Rapport largeur / hauteur des illustrations servies (427 × 320), mesuré sur les fichiers. */
const FRAME_ASPECT = 427 / 320;

/** Hauteur du libellé de nom d'un personnage, en pixels logiques, pour un effectif donné. */
function nameLabelHeight(compact: boolean, participants: number): number {
  return characterNameFontPx(participants, compact) * LABEL_LINE_HEIGHT_FACTOR;
}

/** Ordonnées des voies d'un effectif, dans l'ordre du roster. */
function laneCenters(compact: boolean, participants: number = CHARACTER_IDS.length): number[] {
  const band = laneBand(participants, compact);
  return Array.from({ length: participants }, (_, index) =>
    laneY(index, band, participants),
  );
}

/**
 * Ordonnée du bord supérieur du texte du nom, en pixels logiques.
 *
 * L'origine du texte est la même dans tous les formats (`characterNameOrigin`) : le nom est centré
 * verticalement sur l'axe de la voie, donc ancré par son milieu.
 */
function nameLabelTop(centerY: number, compact: boolean, participants: number): number {
  return (
    characterNameY(centerY) -
    nameLabelHeight(compact, participants) * characterNameOrigin().y
  );
}

/** Tous les effectifs d'une course : trois à six coureurs. */
const PARTICIPANT_COUNTS: readonly number[] = [3, 4, 5, CHARACTER_IDS.length];

describe('zone des voies', () => {
  it('répartit les voies entre les deux bords de la bande, sans en perdre aucune', () => {
    for (const compact of [false, true]) {
      for (const participants of PARTICIPANT_COUNTS) {
        const centers = laneCenters(compact, participants);
        const band = laneBand(participants, compact);
        expect(centers).toHaveLength(participants);
        expect(centers[0]).toBeCloseTo(band.top, 6);
        expect(centers[centers.length - 1]).toBeCloseTo(band.bottom, 6);
        // Espacement constant : les voies ne s'écrasent pas les unes contre les autres.
        const spacings = centers.slice(1).map((value, index) => value - (centers[index] ?? 0));
        for (const spacing of spacings) {
          expect(spacing).toBeCloseTo(spacings[0] ?? 0, 6);
          expect(spacing).toBeGreaterThan(0);
        }
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

  it('espace d’autant plus les voies que la course aligne moins de coureurs', () => {
    for (const compact of [false, true]) {
      const spacings = PARTICIPANT_COUNTS.map((participants) => {
        const centers = laneCenters(compact, participants);
        return (centers[1] ?? 0) - (centers[0] ?? 0);
      });
      // Trois coureurs occupent deux fois l'espace de six : l'espace libéré sert réellement.
      expect(spacings[0]).toBeGreaterThan(spacings[spacings.length - 1] ?? 0);
      for (let index = 1; index < spacings.length; index += 1) {
        expect(
          spacings[index - 1],
          `effectif ${String(PARTICIPANT_COUNTS[index - 1])} contre ${String(PARTICIPANT_COUNTS[index])}`,
        ).toBeGreaterThan(spacings[index] ?? 0);
      }
    }
  });

  it('garde le nom de la première voie entier, dans les deux formats et pour tout effectif', () => {
    for (const compact of [false, true]) {
      for (const participants of PARTICIPANT_COUNTS) {
        const first = laneCenters(compact, participants)[0] ?? 0;
        expect(
          nameLabelTop(first, compact, participants),
          `le nom de la première voie sort du haut du canvas (${String(participants)} coureurs)`,
        ).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('pose le nom à gauche du personnage, dans les deux formats, sans jamais le recouvrir', () => {
    // Une seule règle de mise en place depuis la finition 2D : le format ne la change plus. Le nom est
    // **derrière** le personnage au sens de la course (à sa gauche), sur l'axe de sa voie.
    expect(characterNameOrigin().x).toBe(1);
    expect(characterNameOrigin().y).toBe(0.5);
    for (const compact of [false, true]) {
      for (const participants of PARTICIPANT_COUNTS) {
        const height = characterHeightPx(participants, compact);
        const width = height * FRAME_ASPECT;
        for (const center of laneCenters(compact, participants)) {
          const nameY = characterNameY(center);
          // Même axe que le personnage : le nom ne réserve donc **aucune** hauteur au-dessus de lui.
          expect(nameY, 'le nom partage l’axe du personnage').toBe(center);
          const nameX = characterNameX(center, width);
          expect(nameX, 'le texte s’arrête avant le début du sprite').toBeLessThanOrEqual(
            center - width / 2,
          );
          expect(
            center - width / 2 - nameX,
            'un espace sépare la fin du texte du début du sprite',
          ).toBeCloseTo(VIEW.CHARACTER_NAME_GAP_PX, 6);
        }
      }
    }
    // Le nom est **au-dessus** des sprites : il n'est jamais derrière le personnage en profondeur.
    expect(VIEW.CHARACTER_NAME_DEPTH).toBeGreaterThan(VIEW.CHARACTER_SPRITE_DEPTH_BASE);
  });

  it('place les effets d’événement sous les sprites, jamais devant un autre coureur', () => {
    expect(VIEW.CHARACTER_EFFECT_DEPTH_BASE).toBeLessThan(VIEW.CHARACTER_SPRITE_DEPTH_BASE);
  });

  it('garde la dernière silhouette entière, dans les deux formats et pour tout effectif', () => {
    for (const compact of [false, true]) {
      for (const participants of PARTICIPANT_COUNTS) {
        const centers = laneCenters(compact, participants);
        const last = centers[centers.length - 1] ?? 0;
        expect(
          last + characterHeightPx(participants, compact) / 2,
          `la dernière silhouette sort du bas du canvas (${String(participants)} coureurs)`,
        ).toBeLessThanOrEqual(VIEW.BASE_HEIGHT);
      }
    }
  });

  it('ne laisse aucun nom recouvrir la silhouette visible de la voie au-dessus', () => {
    for (const compact of [false, true]) {
      for (const participants of PARTICIPANT_COUNTS) {
        const centers = laneCenters(compact, participants);
        const height = characterHeightPx(participants, compact);
        for (let index = 1; index < centers.length; index += 1) {
          const center = centers[index] ?? 0;
          const above = centers[index - 1] ?? 0;
          // Silhouette visible de la voie du dessus, dans l'hypothèse la plus défavorable : toute la
          // marge transparente est sous le personnage.
          const visibleBottom = above + height / 2 - height * WORST_CASE_TRANSPARENT_MARGIN;
          expect(
            nameLabelTop(center, compact, participants),
            `le nom de la voie ${String(index)} recouvre la silhouette de la voie ${String(index - 1)}`,
          ).toBeGreaterThanOrEqual(visibleBottom);
        }
      }
    }
  });

  it('ne laisse aucune silhouette empiéter sur la voie voisine', () => {
    for (const compact of [false, true]) {
      for (const participants of PARTICIPANT_COUNTS) {
        const centers = laneCenters(compact, participants);
        const height = characterHeightPx(participants, compact);
        for (let index = 1; index < centers.length; index += 1) {
          const gap = (centers[index] ?? 0) - (centers[index - 1] ?? 0);
          expect(
            gap - height,
            `les voies ${String(index - 1)} et ${String(index)} se chevauchent`,
          ).toBeGreaterThan(0);
        }
      }
    }
  });

  it('garde une séparation visible entre deux silhouettes voisines, pour tout effectif', () => {
    for (const compact of [false, true]) {
      for (const participants of PARTICIPANT_COUNTS) {
        const centers = laneCenters(compact, participants);
        const height = characterHeightPx(participants, compact);
        const gap = (centers[1] ?? 0) - (centers[0] ?? 0);
        // Pire cas : deux silhouettes occupant toute la hauteur visible de leur cadre (95,6 %), l'une
        // au-dessus de l'autre. C'est cette séparation-là que l'œil juge, pas l'écart entre cadres.
        const visibleGap = gap - height * MAX_VISIBLE_FRACTION;
        expect(
          visibleGap,
          `séparation visible de ${visibleGap.toFixed(1)} px logiques entre deux voies (${compact ? 'petit paysage' : 'bureau'}, ${String(participants)} coureurs)`,
        ).toBeGreaterThanOrEqual(10);
      }
    }
  });

  it('retient la plus grande hauteur qui respecte les contraintes, pour chaque effectif', () => {
    for (const compact of [false, true]) {
      for (const participants of PARTICIPANT_COUNTS) {
        const band = laneBand(participants, compact);
        const height = characterHeightPx(participants, compact);
        const spacing = (band.bottom - band.top) / (participants - 1);
        // 1) la séparation visible est respectée…
        expect(spacing - height * MAX_VISIBLE_FRACTION).toBeGreaterThanOrEqual(10);
        // 2) …et un pixel de plus la briserait, ou ferait sortir un cadre de l'arène : la valeur
        //    retenue est donc la plus grande possible, jamais un réglage « au feeling ».
        const canvasBound = 2 * Math.min(band.top, VIEW.BASE_HEIGHT - band.bottom);
        const ceiling = Math.min((spacing - 10) / MAX_VISIBLE_FRACTION, canvasBound);
        if (participants === CHARACTER_IDS.length) {
          // À six coureurs, la taille est **figée** par les constantes historiques, sous le plafond.
          expect(height).toBe(
            compact ? VIEW.CHARACTER_HEIGHT_COMPACT_PX : VIEW.CHARACTER_HEIGHT_PX,
          );
          expect(height).toBeLessThanOrEqual(Math.floor(ceiling));
        } else {
          expect(height).toBe(Math.floor(ceiling));
        }
      }
    }
  });

  it('garde la bande historique à six coureurs, dans les deux formats', () => {
    // La géométrie de l'effectif de référence est **gelée** : elle ne doit pas bouger d'un pixel,
    // puisque c'est elle qui définit « une course à six comme avant ».
    for (const compact of [false, true]) {
      expect(laneBand(CHARACTER_IDS.length, compact)).toEqual(laneRatios(compact));
    }
  });

  it('garde chaque cadre entier dans l’arène, grâce à une bande calculée par effectif', () => {
    // La bande est la plus grande qui laisse chaque cadre **entier** dans l'arène. C'est ce calcul qui
    // remplace l'ancienne borne fixe (`2 × 72 = 144 px`), qui écrasait tous les effectifs réduits à la
    // même taille : la bande s'élargit vers les bords à mesure que l'effectif diminue.
    for (const compact of [false, true]) {
      for (const participants of PARTICIPANT_COUNTS) {
        const band = laneBand(participants, compact);
        const height = characterHeightPx(participants, compact);
        expect(band.top).toBeGreaterThan(0);
        expect(band.bottom).toBeLessThan(VIEW.BASE_HEIGHT);
        // Le cadre de la première et de la dernière voie reste **entièrement** dans le canvas.
        expect(band.top - height / 2, 'la première voie sort par le haut').toBeGreaterThanOrEqual(0);
        expect(
          band.bottom + height / 2,
          'la dernière voie sort par le bas',
        ).toBeLessThanOrEqual(VIEW.BASE_HEIGHT);
        if (participants < CHARACTER_IDS.length) {
          // Le gain est réel : le cadre d'un effectif réduit est plus grand que celui de l'effectif de
          // référence, et la bande s'écarte du bord pour le laisser tenir entier.
          expect(height, `le cadre à ${String(participants)} n’a pas grandi`).toBeGreaterThan(
            characterHeightPx(CHARACTER_IDS.length, compact),
          );
        }
      }
    }
  });

  it('agrandit les personnages quand la course aligne moins de coureurs', () => {
    for (const compact of [false, true]) {
      const heights = PARTICIPANT_COUNTS.map((participants) =>
        characterHeightPx(participants, compact),
      );
      // Six coureurs gardent exactement la taille historique.
      expect(heights[heights.length - 1]).toBe(
        compact ? VIEW.CHARACTER_HEIGHT_COMPACT_PX : VIEW.CHARACTER_HEIGHT_PX,
      );
      // Les effectifs réduits sont plus grands, et jamais plus petits que l'effectif supérieur.
      for (let index = 0; index < heights.length - 1; index += 1) {
        expect(heights[index]).toBeGreaterThan(heights[heights.length - 1] ?? 0);
      }
      for (let index = 1; index < heights.length; index += 1) {
        expect(heights[index - 1]).toBeGreaterThanOrEqual(heights[index] ?? 0);
      }
      // Le gain est franc, pas cosmétique : au moins 30 % de hauteur en plus à trois coureurs.
      expect(heights[0]).toBeGreaterThanOrEqual(
        Math.round((heights[heights.length - 1] ?? 0) * 1.3),
      );
    }
  });

  it('fait suivre la taille du nom à celle du personnage', () => {
    for (const compact of [false, true]) {
      for (const participants of PARTICIPANT_COUNTS) {
        const height = characterHeightPx(participants, compact);
        const font = characterNameFontPx(participants, compact);
        const reference = characterHeightPx(CHARACTER_IDS.length, compact);
        // La proportion texte / silhouette ne dépend pas de l'effectif.
        expect(font / height).toBeCloseTo(
          (compact ? VIEW.CHARACTER_NAME_FONT_COMPACT_PX : VIEW.CHARACTER_NAME_FONT_PX) / reference,
          2,
        );
      }
    }
  });

  it('agrandit les personnages en petit paysage, dans la fourchette demandée', () => {
    const compactHeight = characterHeightPx(CHARACTER_IDS.length, true);
    expect(compactHeight).toBeGreaterThan(characterHeightPx(CHARACTER_IDS.length, false));
    // Fourchette issue du test joueur sur iPhone : 104 à 106 px logiques, la plus grande valeur qui
    // respecte les contraintes ci-dessus (séparation visible) étant retenue.
    expect(compactHeight).toBeGreaterThanOrEqual(104);
    expect(compactHeight).toBeLessThanOrEqual(106);
    // Le nom grandit aussi : le canvas d'un téléphone est réduit à ≈ 0,54, donc la police nominale
    // rendrait ≈ 7,5 px CSS, sous le plancher de lisibilité.
    expect(characterNameFontPx(CHARACTER_IDS.length, true)).toBeGreaterThan(
      characterNameFontPx(CHARACTER_IDS.length, false),
    );
  });

  it('agrandit les personnages de bureau sans sortir du canvas', () => {
    // Passe de finition 2D : les personnages de bureau étaient « plus petits relativement à l'espace
    // disponible ». La taille est choisie pour 1280×720 et 1920×1080, qui partagent la même géométrie
    // logique : 92 px de haut, soit ≈ 68 px CSS en 1280×720 et 92 px CSS en 1920×1080.
    const height = characterHeightPx(CHARACTER_IDS.length, false);
    expect(height).toBeGreaterThanOrEqual(88);
    expect(height).toBeLessThanOrEqual(96);
    const centers = laneCenters(false);
    const first = centers[0] ?? 0;
    const last = centers[centers.length - 1] ?? 0;
    // Les voies du haut et du bas restent entièrement dans le canvas.
    expect(first - height / 2).toBeGreaterThanOrEqual(0);
    expect(last + height / 2).toBeLessThanOrEqual(VIEW.BASE_HEIGHT);
    // Le nom de la première voie ne sort pas non plus par le haut.
    expect(nameLabelTop(first, false, CHARACTER_IDS.length)).toBeGreaterThanOrEqual(0);
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
