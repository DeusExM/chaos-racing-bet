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
 * ## Propriété exacte vis-à-vis de l'échantillonnage
 *
 * La propriété garantie est : **lorsque `OvertakeTracker` est alimenté à CHAQUE PAS SIMULÉ**, les
 * faits de dépassement sont indépendants du FPS, du rendu et du `timeScale`. Ce n'est **pas** un
 * invariant général de fréquence d'échantillonnage : l'hystérésis mémorise un côté confirmé, donc un
 * observateur qui ne relève qu'un pas sur `k` peut manquer un aller-retour plus rapide que son
 * intervalle de relevé. Une mesure « tous les 2, 5 ou 10 pas » ne vaut que pour la seed mesurée.
 *
 * ## Ordre des identifiants : un contrat explicite
 *
 * Les paires sont mémorisées **par index** : l'ordre de `ids` fait donc partie du contrat. Il est
 * mémorisé à la première observation non vide, puis vérifié à chaque appel. Un ordre différent —
 * liste plus courte, identifiant remplacé ou permuté — lève une `RangeError` au lieu de produire
 * silencieusement des dépassements faux. `reset()` oublie à la fois les côtés confirmés et cet ordre
 * mémorisé, afin qu'une nouvelle course puisse repartir proprement sur son propre roster.
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

/** Côté confirmé d'une paire : aucun des deux, le premier observé, ou le second. */
const NEUTRAL = 0;
const FIRST_CONFIRMED = 1;
const SECOND_CONFIRMED = 2;

/**
 * Résultat vide partagé : la très grande majorité des pas ne confirme aucun dépassement, et allouer
 * un tableau à chaque pas coûterait cher pour rien. Il est figé, donc un appelant ne peut pas le
 * corrompre.
 */
const NO_OVERTAKES: readonly Overtake[] = Object.freeze([]);

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

  /**
   * Ordre exact des identifiants, mémorisé à la première observation non vide.
   *
   * Les paires étant indexées par position, réutiliser l'état d'une course pour un roster différent
   * produirait des dépassements attribués aux mauvais personnages. L'ordre est donc un contrat, pas
   * une convention : il est vérifié, et une divergence lève une `RangeError`.
   */
  private ids: readonly CharacterId[] | null = null;

  /**
   * Observe un pas et renvoie les dépassements confirmés par cette observation.
   *
   * La première observation non vide fixe l'ordre des identifiants ; les suivantes doivent présenter
   * exactement la même liste, dans le même ordre. Une liste vide ne dit rien de l'ordre et ne
   * l'engage donc pas.
   */
  observe(xs: readonly number[], ids: readonly CharacterId[]): readonly Overtake[] {
    requireObservable(xs, ids);

    if (xs.length === 0) {
      return NO_OVERTAKES;
    }

    this.requireSameRoster(ids);

    const n = xs.length;
    let overtakes: Overtake[] | null = null;

    for (let i = 0; i < n; i += 1) {
      const firstX = xs[i];
      const firstId = ids[i];
      if (firstX === undefined || firstId === undefined) {
        throw new RangeError(`Observation incomplète à l'index ${i}.`);
      }

      for (let j = i + 1; j < n; j += 1) {
        const secondX = xs[j];
        const secondId = ids[j];
        if (secondX === undefined || secondId === undefined) {
          throw new RangeError(`Observation incomplète à l'index ${j}.`);
        }

        const pair = pairIndex(i, j, n);
        const side = this.sides[pair] ?? NEUTRAL;
        if (firstX - secondX > OVERTAKE.MIN_MARGIN) {
          if (side === SECOND_CONFIRMED) {
            (overtakes ??= []).push({ overtaker: firstId, overtaken: secondId });
          }
          this.sides[pair] = FIRST_CONFIRMED;
        } else if (secondX - firstX > OVERTAKE.MIN_MARGIN) {
          if (side === FIRST_CONFIRMED) {
            (overtakes ??= []).push({ overtaker: secondId, overtaken: firstId });
          }
          this.sides[pair] = SECOND_CONFIRMED;
        }
        // Dans la bande `±OVERTAKE.MIN_MARGIN`, on n'émet rien et on ne touche pas au côté confirmé.
      }
    }

    // Aucun dépassement est le cas courant : renvoyer une valeur partagée évite une allocation par pas.
    return overtakes === null ? NO_OVERTAKES : overtakes;
  }

  /**
   * Fixe l'ordre à la première observation non vide, puis exige qu'il ne change plus jamais.
   *
   * Comparer les identifiants un à un (et non seulement la longueur) est indispensable : deux
   * rosters de même taille mais d'ordre différent réutiliseraient les mêmes index pour des
   * personnages différents, et l'hystérésis attribuerait alors un dépassement au mauvais couple.
   */
  private requireSameRoster(ids: readonly CharacterId[]): void {
    const memorized = this.ids;

    if (memorized === null) {
      this.ids = Object.freeze([...ids]);
      this.sides = new Int8Array((ids.length * (ids.length - 1)) / 2);
      return;
    }

    if (memorized.length !== ids.length) {
      throw new RangeError(
        `OvertakeTracker : l'observateur fournit ${ids.length} identifiants alors que l'ordre mémorisé en compte ${memorized.length}. Appeler reset() pour changer de roster.`,
      );
    }

    for (const [index, id] of ids.entries()) {
      if (memorized[index] !== id) {
        throw new RangeError(
          `OvertakeTracker : l'ordre des identifiants a changé en position ${index} (« ${memorized[index]} » attendu, « ${id} » reçu). Appeler reset() pour changer de roster.`,
        );
      }
    }
  }

  /** Remet toutes les paires au repos **et** oublie l'ordre mémorisé, comme au départ d'une course. */
  reset(): void {
    this.sides = new Int8Array(0);
    this.ids = null;
  }
}
