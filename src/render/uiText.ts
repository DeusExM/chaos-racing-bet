/**
 * Textes visibles attendus par `src/render/`.
 *
 * Les valeurs vivent dans `src/app/strings.fr.ts` : `render/` ne contient **jamais** de texte en dur
 * (AGENTS §7), et il ne peut pas importer `app/` non plus (le sens des dépendances est à sens
 * unique). Seule la **forme** du contrat est donc déclarée ici, et `app/` fournit l'implémentation.
 */
export interface UiText {
  /** État affiché quand la course n'a pas commencé. */
  readonly statusIdle: string;
  /** État affiché pendant la course. */
  readonly statusRunning: string;
  /** État affiché quand la course est terminée. */
  readonly statusFinished: string;
  /** Titre du panneau de classement. */
  readonly rankingTitle: string;
  /** Suffixe d'unité des distances et écarts, avec son espace insécable. */
  readonly metres: string;
  /** Titre du panneau de debug (`?debug=1`). */
  readonly debugTitle: string;
  readonly debugPhase: string;
  readonly debugSimTime: string;
  readonly debugSteps: string;
  readonly debugSeed: string;
  readonly debugTimeScale: string;
  readonly debugDistance: string;
  readonly debugSpeed: string;
  readonly debugDrift: string;
  /** Libellé du repère décoratif de l'échelle nominale. */
  readonly nominalScale: string;
  /** Libellé du bouton qui lance la course. */
  readonly startButton: string;
  /** Libellé du bouton qui rejoue la même course. */
  readonly replayButton: string;
}
