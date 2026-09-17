import type { CharacterId, RaceFact, RaceFactType } from '../core/types';
import type { SpeakerDecision } from '../speaker/Speaker';

/**
 * Catalogue de textes du speaker (P009-C).
 *
 * Le speaker ne produit **aucun** texte : il produit des décisions (quel fait, à quel instant). Le
 * catalogue est ce qui transforme une décision en phrase affichable. Il est injecté dans
 * `RaceCommentary`, ce qui rend l'invariant « remplacer le catalogue ne change pas la course »
 * démontrable en quelques lignes : il suffit de brancher un autre objet de cette forme.
 *
 * Une variante est une **fonction pure** `RaceFact → string`. Elle ne peut donc lire que les champs
 * du fait — type, `tSim`, `characterIds`, `magnitudes` — et rien d'autre : ni le moteur, ni le rang
 * courant, ni le classement, ni un tirage au sort. C'est la garantie structurelle de véracité.
 *
 * La **forme** du catalogue vit ici — `src/render/subtitle.ts` — parce que c'est le contrat que le
 * rendu accepte. Les textes, eux, vivent dans `src/app/strings.fr.ts` : `render/` n'en contient
 * aucun (AGENTS §7), et `app/` fournit l'implémentation comme il fournit déjà `UiText`.
 */
export interface SpeakerCatalogue {
  readonly lines: Readonly<Record<RaceFactType, readonly SpeakerLineFormatter[]>>;
}

/** Une variante de phrase : le fait mesuré entre, le texte français sort. */
export type SpeakerLineFormatter = (fact: RaceFact) => string;

/** Ligne du bandeau : décision du speaker, variante tirée, texte affiché. */
export interface SpeakerLine {
  readonly decision: SpeakerDecision;
  /** Index de la variante dans `lines[fact.type]`, tiré du flux `speaker:lines`. */
  readonly variantIndex: number;
  /** Texte français déjà formaté, prêt à afficher. */
  readonly text: string;
  /**
   * Personnage réellement **nommé par cette phrase**, ou `null`.
   *
   * Il n'est pas déduit du type de fait mais du texte : un `CLOSE_RACE` peut citer deux noms comme
   * n'en citer aucun, selon la variante tirée. Le personnage mis en avant est donc toujours celui que
   * la phrase prononce, jamais un personnage plaqué à côté d'une réplique qui ne le mentionne pas.
   */
  readonly characterId: CharacterId | null;
  /** Nom affiché de ce personnage, ou `null` : le rendu ne nomme jamais un personnage lui-même. */
  readonly characterName: string | null;
  /**
   * Vrai si cette réplique a **coupé** la précédente (règle `INTERRUPT_DELTA` du speaker).
   *
   * L'information vient du speaker, pas du rendu : elle sert à expliquer une transition plus rapide
   * et à distinguer, dans les tests, une préemption d'un démarrage normal.
   */
  readonly preempted: boolean;
  /** Instant simulé du démarrage effectif de la réplique (celui de la décision). */
  readonly startedAtS: number;
}
