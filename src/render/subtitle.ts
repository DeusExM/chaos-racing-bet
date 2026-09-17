import type { RaceFact, RaceFactType } from '../core/types';
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
}
