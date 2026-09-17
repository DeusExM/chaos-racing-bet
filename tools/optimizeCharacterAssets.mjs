/**
 * Outil d'asset (versionné, sans dépendance) : produit les copies **runtime** des 6 personnages.
 *
 * ## Pourquoi cet outil existe
 *
 * Les six PNG livrés par le joueur sont des originaux **haute résolution** (~1448×1086, ~1 Mo chacun,
 * soit ~6,2 Mio au total) : ils doivent rester **intacts** sur le disque, mais ils ne peuvent pas être
 * servis tels quels au navigateur, car `AGENTS.md` §3.6 impose un poids total de ressources < 3 Mo
 * (le bundle Phaser en pèse déjà ~1,4). Cet outil en dérive donc des copies dédiées au web :
 *
 * * **transparence conservée** (canal alpha rééchantillonné en alpha prémultiplié, sans halo) ;
 * * **ratio conservé** : seule la hauteur est choisie, la largeur est calculée (jamais de carré) ;
 * * **hauteur** par défaut 320 px : largement au-dessus des ~68 px logiques affichés, y compris sur
 *   un écran haute densité, et bien en dessous des 1448 px d'origine ;
 * * **PNG** réencodé (choix retenu plutôt que WebP : aucune dépendance, aucune bibliothèque, et un
 *   décodeur PNG est universel — WebP n'apporterait ici que quelques dizaines de kilo-octets).
 *
 * Aucune bibliothèque n'est utilisée : décodage PNG (zlib de Node), rééchantillonnage par **moyenne de
 * surface** (le filtre correct pour une forte réduction : pas de repliement, pas de ringing), puis
 * encodage PNG avec choix du filtre par ligne et `deflate` niveau 9.
 *
 * ## Usage
 *
 * ```sh
 * node tools/optimizeCharacterAssets.mjs            # hauteur 320 px
 * node tools/optimizeCharacterAssets.mjs 256        # autre hauteur
 * ```
 *
 * Les fichiers d'entrée sont **lus uniquement** ; rien n'écrit jamais dans les originaux.
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inflateSync, deflateSync, constants as zlibConstants } from 'node:zlib';

/** Hauteur des copies runtime, en pixels (surchargeable par argument). */
const DEFAULT_TARGET_HEIGHT = 320;

/** Répertoire des copies runtime, relatif à la racine du dépôt. */
const OUTPUT_DIR = 'public/assets/characters';

/**
 * Sources (à la racine, **jamais modifiées**) et copies runtime.
 *
 * Les noms de sortie sont techniques : sans espace, sans accent, stables — c'est ce que référence le
 * mapping `src/render/characterAssets.ts`.
 */
export const CHARACTER_ASSET_SOURCES = [
  { id: 'c0', name: 'Mamie Nitro', source: 'mamie Nitro.png', output: 'mamie-nitro.png' },
  { id: 'c1', name: 'Saucisse Mécanique', source: 'saucisse mécanique.png', output: 'saucisse-mecanique.png' },
  { id: 'c2', name: 'Poulet 3000', source: 'Poulet 3000.png', output: 'poulet-3000.png' },
  { id: 'c3', name: 'Jean-Michel Turbo', source: 'Jean-Michel Turbo.png', output: 'jean-michel-turbo.png' },
  { id: 'c4', name: 'Bananix', source: 'Bananix.png', output: 'bananix.png' },
  { id: 'c5', name: 'Gérard le Paladin', source: 'Gérard le Paladin.png', output: 'gerard-le-paladin.png' },
];

const CHANNELS_BY_COLOR_TYPE = { 0: 1, 2: 3, 4: 2, 6: 4 };

/** Décode un PNG non entrelacé 8 bits en RGBA (canal alpha à 255 s'il n'existe pas). */
export function decodePng(file) {
  const buffer = readFileSync(file);
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];

  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }

  const channels = CHANNELS_BY_COLOR_TYPE[colorType];
  if (channels === undefined || bitDepth !== 8 || interlace !== 0) {
    throw new Error(
      `${file} : PNG non pris en charge (type ${colorType}, ${bitDepth} bits, entrelacement ${interlace})`,
    );
  }

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const rgba = Buffer.alloc(width * height * 4);
  let previous = Buffer.alloc(stride);

  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)] ?? 0;
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const current = Buffer.alloc(stride);
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? current[x - channels] : 0;
      const b = previous[x] ?? 0;
      const c = x >= channels ? (previous[x - channels] ?? 0) : 0;
      const value = line[x] ?? 0;
      let result;
      switch (filter) {
        case 0:
          result = value;
          break;
        case 1:
          result = value + a;
          break;
        case 2:
          result = value + b;
          break;
        case 3:
          result = value + ((a + b) >> 1);
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          result = value + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          throw new Error(`${file} : filtre PNG ${filter} inconnu`);
      }
      current[x] = result & 0xff;
    }
    for (let x = 0; x < width; x += 1) {
      const s = x * channels;
      const d = (y * width + x) * 4;
      rgba[d] = current[s] ?? 0;
      rgba[d + 1] = channels >= 3 ? (current[s + 1] ?? 0) : (current[s] ?? 0);
      rgba[d + 2] = channels >= 3 ? (current[s + 2] ?? 0) : (current[s] ?? 0);
      rgba[d + 3] = channels === 4 ? (current[s + 3] ?? 255) : channels === 2 ? (current[s + 1] ?? 255) : 255;
    }
    previous = current;
  }

  return { width, height, rgba };
}

/** Rééchantillonne en **alpha prémultiplié** : les pixels transparents ne tirent pas les bords vers le noir. */
function resample(source, sourceWidth, sourceHeight, targetWidth, targetHeight) {
  const horizontal = new Float32Array(targetWidth * sourceHeight * 4);
  const scaleX = sourceWidth / targetWidth;

  for (let y = 0; y < sourceHeight; y += 1) {
    for (let x = 0; x < targetWidth; x += 1) {
      const start = x * scaleX;
      const end = start + scaleX;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let weightSum = 0;
      for (let i = Math.floor(start); i < Math.min(sourceWidth, Math.ceil(end)); i += 1) {
        const weight = Math.min(end, i + 1) - Math.max(start, i);
        if (weight <= 0) {
          continue;
        }
        const s = (y * sourceWidth + i) * 4;
        const alpha = (source[s + 3] ?? 0) / 255;
        r += (source[s] ?? 0) * alpha * weight;
        g += (source[s + 1] ?? 0) * alpha * weight;
        b += (source[s + 2] ?? 0) * alpha * weight;
        a += (source[s + 3] ?? 0) * weight;
        weightSum += weight;
      }
      const o = (y * targetWidth + x) * 4;
      horizontal[o] = r / weightSum;
      horizontal[o + 1] = g / weightSum;
      horizontal[o + 2] = b / weightSum;
      horizontal[o + 3] = a / weightSum;
    }
  }

  const output = Buffer.alloc(targetWidth * targetHeight * 4);
  const scaleY = sourceHeight / targetHeight;
  for (let y = 0; y < targetHeight; y += 1) {
    const start = y * scaleY;
    const end = start + scaleY;
    for (let x = 0; x < targetWidth; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let weightSum = 0;
      for (let i = Math.floor(start); i < Math.min(sourceHeight, Math.ceil(end)); i += 1) {
        const weight = Math.min(end, i + 1) - Math.max(start, i);
        if (weight <= 0) {
          continue;
        }
        const s = (i * targetWidth + x) * 4;
        r += (horizontal[s] ?? 0) * weight;
        g += (horizontal[s + 1] ?? 0) * weight;
        b += (horizontal[s + 2] ?? 0) * weight;
        a += (horizontal[s + 3] ?? 0) * weight;
        weightSum += weight;
      }
      const alpha = a / weightSum;
      const opaque = alpha / 255;
      const o = (y * targetWidth + x) * 4;
      output[o] = opaque > 0 ? Math.min(255, Math.round(r / weightSum / opaque)) : 0;
      output[o + 1] = opaque > 0 ? Math.min(255, Math.round(g / weightSum / opaque)) : 0;
      output[o + 2] = opaque > 0 ? Math.min(255, Math.round(b / weightSum / opaque)) : 0;
      output[o + 3] = Math.min(255, Math.round(alpha));
    }
  }

  return output;
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** `sum of absolute differences` : heuristique standard de choix du filtre, ligne par ligne. */
function filteredLine(filter, line, previous, bpp) {
  const out = Buffer.alloc(line.length);
  for (let x = 0; x < line.length; x += 1) {
    const a = x >= bpp ? (line[x - bpp] ?? 0) : 0;
    const b = previous[x] ?? 0;
    const c = x >= bpp ? (previous[x - bpp] ?? 0) : 0;
    const value = line[x] ?? 0;
    switch (filter) {
      case 0:
        out[x] = value;
        break;
      case 1:
        out[x] = (value - a) & 0xff;
        break;
      case 2:
        out[x] = (value - b) & 0xff;
        break;
      case 3:
        out[x] = (value - ((a + b) >> 1)) & 0xff;
        break;
      default:
        out[x] = (value - paeth(a, b, c)) & 0xff;
        break;
    }
  }
  return out;
}

/** Encode du RGBA 8 bits en PNG (couleur type 6), filtre optimal par ligne, `deflate` niveau 9. */
export function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  let previous = Buffer.alloc(stride);

  for (let y = 0; y < height; y += 1) {
    const line = rgba.subarray(y * stride, (y + 1) * stride);
    let bestFilter = 0;
    let bestLine = filteredLine(0, line, previous, 4);
    let bestScore = Number.POSITIVE_INFINITY;
    for (let filter = 0; filter < 5; filter += 1) {
      const candidate = filteredLine(filter, line, previous, 4);
      let score = 0;
      for (const byte of candidate) {
        score += byte < 128 ? byte : 256 - byte;
      }
      if (score < bestScore) {
        bestScore = score;
        bestFilter = filter;
        bestLine = candidate;
      }
    }
    raw[y * (stride + 1)] = bestFilter;
    bestLine.copy(raw, y * (stride + 1) + 1);
    previous = line;
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  const idat = deflateSync(raw, { level: 9, memLevel: 9, strategy: zlibConstants.Z_DEFAULT_STRATEGY });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Boîte utile (canal alpha > 24) : sert de contrôle de cadrage, jamais au rendu. */
function alphaBox(rgba, width, height) {
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  let opaque = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if ((rgba[(y * width + x) * 4 + 3] ?? 0) > 24) {
        opaque += 1;
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
    }
  }
  return { x0, y0, x1, y1, coverage: opaque / (width * height) };
}

const kilobytes = (bytes) => (bytes / 1024).toFixed(0).padStart(5);

/** Produit les 6 copies runtime et affiche le compte rendu de poids et de cadrage. */
export function main(argv = process.argv.slice(2)) {
  const targetHeight = Number(argv[0] ?? DEFAULT_TARGET_HEIGHT);
  if (!Number.isInteger(targetHeight) || targetHeight < 64) {
    throw new Error(`hauteur cible invalide : ${String(argv[0])}`);
  }

  let totalSource = 0;
  let totalOutput = 0;
  const rows = [];

  for (const asset of CHARACTER_ASSET_SOURCES) {
    const { width, height, rgba } = decodePng(asset.source);
    const targetWidth = Math.max(1, Math.round((width * targetHeight) / height));
    const resized = resample(rgba, width, height, targetWidth, targetHeight);
    const png = encodePng(targetWidth, targetHeight, resized);
    const outputPath = join(OUTPUT_DIR, asset.output);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, png);

    // Relit le fichier écrit : dimensions, cadrage utile et intégrité (CRC) sont ainsi vérifiés.
    const check = decodePng(outputPath);
    const box = alphaBox(check.rgba, check.width, check.height);
    const sourceBytes = statSync(asset.source).size;
    const outputBytes = statSync(outputPath).size;
    totalSource += sourceBytes;
    totalOutput += outputBytes;

    const visibleRatio = (box.y1 - box.y0 + 1) / check.height;
    rows.push({
      id: asset.id,
      name: asset.name,
      source: asset.source,
      sourceSize: `${width}×${height}`,
      sourceBytes,
      output: asset.output,
      outputSize: `${check.width}×${check.height}`,
      outputBytes,
      visible: `${(visibleRatio * 100).toFixed(1)} %`,
    });
  }

  console.log(`hauteur cible : ${targetHeight} px\n`);
  for (const row of rows) {
    console.log(
      `${row.id} ${row.name.padEnd(22)} ${row.source.padEnd(24)} ${row.sourceSize} ${kilobytes(row.sourceBytes)} Ko` +
        `  ->  ${row.output.padEnd(24)} ${row.outputSize} ${kilobytes(row.outputBytes)} Ko  (silhouette ${row.visible})`,
    );
  }
  console.log(
    `\ntotal origine : ${kilobytes(totalSource)} Ko\n` +
      `total runtime : ${kilobytes(totalOutput)} Ko (${(totalOutput / (1024 * 1024)).toFixed(2)} Mo)`,
  );

  return rows;
}

// Le script n'agit que s'il est exécuté directement : l'importer (tests) n'écrit rien.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}