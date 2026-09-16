/**
 * Score d'un fait et identité de déduplication.
 *
 * Ce module ne contient **aucun texte** et ne connaît que `RaceFact` (type du noyau) : c'est ce qui
 * garantit que le speaker ne peut ni inventer un fait, ni dépendre d'une variante de texte future.
 * L'importance vient de P009-A : elle n'est **jamais** recalculée ni modifiée ici.
 */

import type { RaceFact } from '../core/types';

/** Un fait mérite d'être commenté. Le score est celui, mesuré, du noyau. */
export interface ScoredFact {
  readonly fact: RaceFact;
  /** Importance mesurée par l'observateur (P009-A), recopiée telle quelle. */
  readonly importance: number;
}

/** Enveloppe un fait sans le modifier : `RaceFact` est gelé et reste la seule source de vérité. */
export function scoreFact(fact: RaceFact): ScoredFact {
  return { fact, importance: fact.importance };
}

export function isImportantEnough(fact: RaceFact, minImportance: number): boolean {
  return fact.importance >= minImportance;
}

/**
 * Tranche de magnitude d'un fait — définie **sans aucun texte** et **sans aucun cas particulier par
 * type**, pour rester déterministe et testable.
 *
 * Règle retenue : la tranche porte sur la **première magnitude** du fait — celle que §9.2 décrit en
 * premier pour chaque type (marge P1–P2, places gagnées, dépassements, magnitude d'événement, écart
 * P1–P3, écart P1–P2) — quantifiée en tranches de `1 / resolution` par arrondi au plus proche :
 *
 *     tranche = round(|magnitudes[0]| × resolution)
 *
 * Un fait sans magnitude a la tranche `0`. Formulation volontairement générique : elle ne dépend
 * d'aucune table de correspondance type → indice, donc elle ne peut pas diverger silencieusement
 * d'une future évolution de l'observateur. `magnitudes[0]` étant finie par contrat, la tranche l'est
 * aussi.
 */
export function magnitudeBucket(fact: RaceFact, resolution: number): number {
  const primary = fact.magnitudes[0];
  if (primary === undefined) {
    return 0;
  }
  return Math.round(Math.abs(primary) * resolution);
}

/**
 * Identité de déduplication d'un fait : **type + personnages (dans l'ordre du fait) + tranche de
 * magnitude**. Deux faits de même identité sont considérés identiques ; le speaker supprime alors le
 * second pendant `dedupWindowS`. Le séparateur `|` ne peut pas apparaître deux fois au même endroit
 * dans la clé, donc deux identités distinctes ne peuvent pas produire la même empreinte.
 */
export function dedupFingerprint(fact: RaceFact, resolution: number): string {
  const characters = fact.characterIds.join(',');
  return `${fact.type}|${characters}|${magnitudeBucket(fact, resolution)}`;
}