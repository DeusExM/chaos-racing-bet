import { OVERTAKE } from './config';
import type { CharacterId } from './types';

/**
 * Détection des dépassements à **hystérésis** (bascule de Schmitt), par paire de personnages.
 *
 * ## Pourquoi un état, et pas deux relevés
 *
 * Comparer deux relevés de classement ne suffit pas : un simple échange de rang à quelques
 * centimètres produit une « inversion » qui n'est pas un dépassement, et une marge mesurée entre
 * deux relevés rend le résultat dépendant de la **fréquence d'observation** (le pas vaut 0,2 m,
 * donc observer pas à pas ne franchit jamais `OVERTAKE.MIN_MARGIN`). Ici, chaque paire non ordonnée
 * `(A, B)` mémorise le dernier côté **confirmé** ; un dépassement n'existe que lorsqu'un côté
 * confirmé cède la place à l'autre côté confirmé. Franchir la marge est donc nécessaire, mais une
 * inversion de rang seule ne suffit jamais.
 *
 * ## Ce que ce module ne fait jamais
 *
 * * Il n'écrit **jamais** dans `x`/`v` : sa seule mémoire est observationnelle.
 * * Il ne lit **jamais** le rang, le temps, la vitesse ou les événements : seulement les distances.
 * * Il ne tire **jamais** de hasard et n'influence **jamais** le résultat d'une course.
 * * Sa mémoire est bornée par le nombre de paires de personnages (`15` pour 6 personnages).
 */

/** Un dépassement effectivement constaté. */
export interface Overtake {
  readonly overtaker: CharacterId;
  readonly overtaken: CharacterId;
}

interface Observation {
  readonly x: number;
  readonly id: CharacterId;
}

/** Côté confirmé d'une paire : aucun des deux, le premier observé, ou le second. */
const NEUTRAL = 0;
const FIRST_CONFIRMED = 1;
const SECOND_CONFIRMED = 2;

function requireObservable(xs: readonly number[], ids: readonly CharacterId[]): void {
  if (xs.length !== ids.length) {
    throw new RangeError(`xs (${xs.length}) et ids (${ids.length}) doivent avoir la même longueur.`);
  }

  for (const [index, x] of xs.entries()) {
    if (!Number.isFinite(x)) {
      throw new RangeError(`xs[${index}] doit être une distance finie (reçu : ${x}).`);
    }
  }

  for (const [index, id] of ids.entries()) {
    if (ids.indexOf(id) !== index) {
      throw new RangeError(`ids contient deux fois « ${id} » : les paires seraient ambiguës.`);
    }
  }
}

/**
 * Index de la paire `(i, j)` avec `i < j` dans un tableau triangulaire de `n` personnages.
 *
 * Les paires sont rangées par premier personnage croissant puis second croissant : l'ordre des
 * dépassements émis est donc déterministe, sans `Map` ni tri.
 */
function pairIndex(i: number, j: number, n: number): number {
  return (i * (2 * n - i - 1)) / 2 + (j - i - 1);
}

/**
 * Détecteur à hystérésis des dépassements.
 *
 * À chaque pas simulé, l'appelant fournit les distances et les identifiants ; le détecteur renvoie
 * les dépassements **nouvellement confirmés** à ce pas. Le premier personnage qui s'éloigne de plus
 * de `OVERTAKE.MIN_MARGIN` ne fait qu'initialiser la relation de paire : le départ à égalité ne
 * produit donc aucun dépassement fictif.
 */
export class OvertakeTracker {
  private sides: Int8Array = new Int8Array(0);
  private size = 0;

  /**
   * Observe un pas et renvoie les dépassements confirmés par cette observation.
   *
   * L'ordre des tableaux définit l'index de chaque personnage : il doit rester stable d'un pas à
   * l'autre. Un changement de longueur (nouvelle course) réinitialise l'état des paires.
   */
  observe(xs: readonly number[], ids: readonly CharacterId[]): readonly Overtake[] {
    requireObservable(xs, ids);

    const n = xs.length;
    if (n !== this.size) {
      this.sides = new Int8Array((n * (n - 1)) / 2);
      this.size = n;
    }

    const observations: Observation[] = [];
    for (const [index, x] of xs.entries()) {
      const id = ids[index];
      if (id === undefined) {
        throw new RangeError(`ids[${index}] est manquant.`);
      }
      observations.push({ x, id });
    }

    const overtakes: Overtake[] = [];
    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) {
        const first = observations[i];
        const second = observations[j];
        if (first === undefined || second === undefined) {
          throw new RangeError(`paire (${i}, ${j}) hors bornes.`);
        }

        const pair = pairIndex(i, j, n);
        const side = this.sides[pair] ?? NEUTRAL;
        if (first.x - second.x > OVERTAKE.MIN_MARGIN) {
          if (side === SECOND_CONFIRMED) {
            overtakes.push({ overtaker: first.id, overtaken: second.id });
          }
          this.sides[pair] = FIRST_CONFIRMED;
        } else if (second.x - first.x > OVERTAKE.MIN_MARGIN) {
          if (side === FIRST_CONFIRMED) {
            overtakes.push({ overtaker: second.id, overtaken: first.id });
          }
          this.sides[pair] = SECOND_CONFIRMED;
        }
        // Dans la bande `±OVERTAKE.MIN_MARGIN`, on n'émet rien et on ne touche pas au côté confirmé.
      }
    }

    return overtakes;
  }

  /** Remet toutes les paires au repos, comme au départ d'une course. */
  reset(): void {
    this.sides.fill(NEUTRAL);
  }
}
