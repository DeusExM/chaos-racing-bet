/**
 * Génération pseudo-aléatoire déterministe du noyau.
 *
 * Tout repose sur des opérations entières 32 bits (`Math.imul`, décalages, `>>> 0`), dont le
 * résultat est spécifié exactement par ECMAScript : deux appareils qui partagent la même seed
 * produisent donc la même séquence. Aucune source de hasard ambiante n'est utilisée.
 */

const UINT32_RANGE = 0x1_0000_0000;

/**
 * Nombre de tirages uniformes additionnés pour approcher une loi normale.
 *
 * 12 est la valeur classique : la somme a alors exactement une variance de 1 après centrage, sans
 * aucune correction à appliquer.
 */
const GAUSSIAN_DRAWS = 12;

/**
 * Espérance exacte de la somme : `6 × (2^32 − 1)`.
 *
 * Chaque tirage uniforme sur `[0, 2^32)` a pour espérance `(2^32 − 1) / 2`, et non `2^31`. Centrer
 * sur cette valeur — et non sur `6 × 2^32` — est ce qui annule exactement la moyenne.
 */
const GAUSSIAN_OFFSET = (GAUSSIAN_DRAWS / 2) * (UINT32_RANGE - 1);

/**
 * Hachage FNV-1a 32 bits, calculé sur les unités de code UTF-16 de `text`.
 *
 * `charCodeAt` est utilisé volontairement : la spec ECMAScript garantit la même valeur partout,
 * y compris pour les caractères hors ASCII.
 */
export function hash32(text: string): number {
  let hash = 0x811c_9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x0100_0193);
  }
  return hash >>> 0;
}

/**
 * Mélangeur : transforme une graine 32 bits en une suite de graines de bonne qualité.
 *
 * Sert à étaler la graine d'un stream avant d'amorcer `sfc32`, dont les premiers tirages sont
 * sensibles à une amorce trop régulière.
 */
export function splitmix32(seed: number): () => number {
  let state = seed >>> 0;
  return (): number => {
    state = (state + 0x9e37_79b9) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 16), 0x21f0_aaad) >>> 0;
    mixed = Math.imul(mixed ^ (mixed >>> 15), 0x735a_2d97) >>> 0;
    return (mixed ^ (mixed >>> 15)) >>> 0;
  };
}

/**
 * Générateur sfc32 : rapide, de bonne qualité statistique, et dont l'état tient dans quatre
 * entiers 32 bits — donc entièrement reproductible.
 */
export function sfc32(a: number, b: number, c: number, d: number): () => number {
  let s0 = a >>> 0;
  let s1 = b >>> 0;
  let s2 = c >>> 0;
  let s3 = d >>> 0;

  return (): number => {
    const sum = ((s0 + s1) >>> 0) + s3;
    s3 = (s3 + 1) >>> 0;
    s0 = (s1 ^ (s1 >>> 9)) >>> 0;
    s1 = (s2 + (s2 << 3)) >>> 0;
    const rotated = ((s2 << 21) | (s2 >>> 11)) >>> 0;
    s2 = (rotated + sum) >>> 0;
    return sum >>> 0;
  };
}

/**
 * Un stream aléatoire nommé.
 *
 * Un stream est une suite indépendante : consommer des valeurs dans l'un ne décale jamais les
 * autres, et l'ordre dans lequel les streams sont appelés n'a aucune importance. C'est ce qui
 * permet d'ajouter un tirage quelque part sans invalider toutes les courses existantes.
 */
export class RngStream {
  readonly #nextUint32: () => number;

  constructor(nextUint32: () => number) {
    this.#nextUint32 = nextUint32;
  }

  /** Entier 32 bits non signé : la brique de base de tous les autres tirages. */
  next(): number {
    return this.#nextUint32() >>> 0;
  }

  /** Flottant uniforme dans `[0, 1)`. */
  nextFloat(): number {
    return this.next() / UINT32_RANGE;
  }

  /**
   * Entier uniforme dans `[min, max]`, bornes **incluses**.
   *
   * Le rejet des valeurs hors du plus grand multiple de `range` évite le biais du modulo :
   * chaque valeur de l'intervalle a exactement la même probabilité.
   */
  nextInt(min: number, max: number): number {
    if (!Number.isInteger(min) || !Number.isInteger(max)) {
      throw new TypeError(`nextInt : bornes entières attendues (min=${min}, max=${max}).`);
    }
    if (max < min) {
      throw new RangeError(`nextInt : bornes inversées (min=${min}, max=${max}).`);
    }

    const range = max - min + 1;
    if (range > UINT32_RANGE) {
      throw new RangeError(`nextInt : intervalle trop large (${range}).`);
    }

    const limit = Math.floor(UINT32_RANGE / range) * range;
    let value = this.next();
    while (value >= limit) {
      value = this.next();
    }
    return min + (value % range);
  }

  /**
   * Loi normale approchée, centrée réduite, **sans aucune fonction transcendante**.
   *
   * La somme de 12 tirages uniformes sur `[0, 2^32)` a pour espérance `6 × (2^32 − 1)` et pour
   * variance `2^64 − 1`. Après centrage exact sur cette espérance, puis division par `2^32` — une
   * mise à l'échelle binaire exacte —, la moyenne vaut exactement 0 et la variance `1 − 2^-64`.
   *
   * Chaque résultat est un multiple exact de `2^-32`. C'est la propriété structurelle attendue d'un
   * calcul purement entier, et elle est vérifiée par les tests ; l'interdiction effective des
   * fonctions transcendantes, elle, est garantie par le test de frontière.
   *
   * La somme maximale vaut `12 × (2^32 − 1) ≈ 5,15 × 10^10`, très en dessous de
   * `Number.MAX_SAFE_INTEGER` : tous les entiers intermédiaires sont exacts.
   */
  nextGaussian(): number {
    let total = 0;
    for (let index = 0; index < GAUSSIAN_DRAWS; index += 1) {
      total += this.next();
    }
    return (total - GAUSSIAN_OFFSET) / UINT32_RANGE;
  }

  /** Élément uniformément choisi dans `items`. */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) {
      throw new RangeError('pick : liste vide.');
    }
    const value = items[this.nextInt(0, items.length - 1)];
    if (value === undefined) {
      throw new RangeError('pick : index hors limites.');
    }
    return value;
  }

  /**
   * Élément choisi proportionnellement à son poids.
   *
   * Les poids doivent être positifs ; la somme n'a pas besoin de valoir 1.
   */
  weightedPick<T>(items: readonly T[], weights: readonly number[]): T {
    if (items.length === 0) {
      throw new RangeError('weightedPick : liste vide.');
    }
    if (items.length !== weights.length) {
      throw new RangeError(
        `weightedPick : ${items.length} éléments pour ${weights.length} poids.`,
      );
    }

    let total = 0;
    for (const weight of weights) {
      if (!Number.isFinite(weight) || weight < 0) {
        throw new RangeError(`weightedPick : poids invalide (${weight}).`);
      }
      total += weight;
    }
    if (total <= 0) {
      throw new RangeError('weightedPick : somme des poids nulle.');
    }

    let threshold = this.nextFloat() * total;
    let last: T | undefined;
    for (const [index, item] of items.entries()) {
      last = item;
      threshold -= weights[index] ?? 0;
      if (threshold < 0) {
        return item;
      }
    }

    // Atteint seulement si les flottants arrondissent à la toute dernière valeur.
    if (last === undefined) {
      throw new RangeError('weightedPick : aucun élément sélectionnable.');
    }
    return last;
  }
}

/**
 * Dérive un stream nommé à partir de la seed d'une course.
 *
 * Chaque couple `(seed, label)` donne une suite indépendante. Les labels prévus sont
 * `drift:<charId>`, `surge:<charId>`, `events:global`, `events:<charId>`, `speaker:lines`,
 * `cosmetic` et `participants` (voir `GAME_DESIGN.md` §10).
 */
export function forkStream(seed: number, label: string): RngStream {
  const streamSeed = hash32(`${seed >>> 0}:${label}`);
  const mixer = splitmix32(streamSeed);
  return new RngStream(sfc32(mixer(), mixer(), mixer(), mixer()));
}
