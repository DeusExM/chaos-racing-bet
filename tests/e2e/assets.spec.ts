import { expect, test } from '@playwright/test';

import { CHARACTER_IDS } from '../../src/core/characters';
import { characterAssetFile, characterAssetUrl } from '../../src/render/characterAssets';
import { VIEW } from '../../src/render/viewConfig';

/**
 * Visuels servis : ce sont les fichiers du **build** qui comptent, pas ceux du disque.
 *
 * Ces vérifications sont ici, et pas dans un test unitaire, parce que le rendu ne lit jamais le dépôt :
 * il lit des URL. Elles interrogent donc le serveur de prévisualisation, exactement comme le fait le
 * navigateur — c'est la seule façon de prouver que le build embarque bien les six images.
 *
 * Ce qui est vérifié, image par image :
 *
 * * le fichier est servi (200), en PNG, **avec canal alpha** (sinon les personnages auraient un fond
 *   noir opaque) ;
 * * ses dimensions sont celles des copies runtime (427×320) et **son ratio est celui des sources**
 *   (1448×1086) : aucune image n'a été écrasée en carré ;
 * * sa hauteur (320) est bien supérieure à la hauteur affichée (`VIEW.CHARACTER_HEIGHT_PX`) : la
 *   résolution du fichier n'est pas une taille de rendu, et il reste de la marge pour les écrans
 *   haute densité ;
 * * les six fichiers sont **différents** : aucun personnage ne peut se retrouver avec l'image d'un
 *   autre ;
 * * le poids total reste sous le budget, pour que le build tienne l'invariant < 3 Mo d'`AGENTS.md`
 *   §3.6 (le bundle Phaser pèse ~1,4 Mo à lui seul).
 */

/** Hauteur des copies runtime : choisie par `tools/optimizeCharacterAssets.mjs`. */
const RUNTIME_HEIGHT_PX = 320;

/** Dimensions d'origine des sources fournies, qui fixent le ratio à conserver. */
const SOURCE_RATIO = 1448 / 1086;

/** Budget des six copies runtime : au-delà, l'invariant < 3 Mo du build n'est plus tenable. */
const RUNTIME_BUDGET_BYTES = 1.5 * 1024 * 1024;

interface PngHeader {
  readonly width: number;
  readonly height: number;
  readonly bitDepth: number;
  readonly colorType: number;
}

/** En-tête PNG : signature, dimensions, profondeur, type de couleur. Aucun décodage d'image. */
function pngHeader(body: Uint8Array): PngHeader {
  const signature = [...body.subarray(0, 8)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  expect(signature, 'signature PNG').toBe('89504e470d0a1a0a');
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  return {
    width: view.getUint32(16),
    height: view.getUint32(20),
    bitDepth: body[24] ?? 0,
    colorType: body[25] ?? 0,
  };
}

/**
 * Empreinte FNV-1a d'un fichier servi.
 *
 * Elle sert à prouver que les six images sont **différentes** (aucun personnage ne peut se retrouver
 * avec le visuel d'un autre). Une empreinte suffit : on ne compare pas des secrets, on compare des
 * fichiers entre eux.
 */
function fingerprint(body: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (const byte of body) {
    hash = (hash ^ byte) >>> 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${body.length.toString(16)}-${hash.toString(16)}`;
}

test('les six visuels sont servis en PNG transparent, au ratio des sources et dans le budget', async ({
  request,
}) => {
  const fingerprints = new Set<string>();
  let total = 0;

  for (const id of CHARACTER_IDS) {
    const response = await request.get(characterAssetUrl(id));
    expect(response.status(), `${characterAssetFile(id)} est servi`).toBe(200);
    const body = await response.body();
    const header = pngHeader(body);

    // Type 6 = RGBA : la transparence du visuel fait partie du rendu (fond noir sinon).
    expect(header.colorType, `canal alpha de ${id}`).toBe(6);
    expect(header.bitDepth, `profondeur de ${id}`).toBe(8);
    expect(header.height, `hauteur de ${id}`).toBe(RUNTIME_HEIGHT_PX);
    expect(header.width, `largeur de ${id}`).toBe(
      Math.round((SOURCE_RATIO * RUNTIME_HEIGHT_PX * 1000) / 1000),
    );

    const ratio = header.width / header.height;
    expect(Math.abs(ratio - SOURCE_RATIO), `ratio de ${id}`).toBeLessThan(0.005);

    // La résolution du fichier n'est pas la taille de rendu : le rendu divise par plus de 4.
    expect(header.height).toBeGreaterThan(VIEW.CHARACTER_HEIGHT_PX * 3);
    // L'image est plus large que haute : un sprite n'est jamais un carré écrasé.
    expect(ratio).toBeGreaterThan(1);

    fingerprints.add(fingerprint(body));
    total += body.length;
  }

  // Six images distinctes : deux personnages ne peuvent pas partager le même fichier.
  expect(fingerprints.size, 'les six visuels sont des images différentes').toBe(CHARACTER_IDS.length);

  expect(total, `poids total des visuels (${(total / 1024).toFixed(0)} Ko)`).toBeLessThan(
    RUNTIME_BUDGET_BYTES,
  );
});