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
  /** État affiché pendant le compte à rebours. */
  readonly statusCountdown: string;
  /** État affiché pendant la course. */
  readonly statusRunning: string;
  /** État affiché pendant une pause de checkpoint. */
  readonly statusCheckpointPause: string;
  /** État affiché pendant une pause demandée par le MJ. */
  readonly statusUserPaused: string;
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
  /** Surge courant d'un personnage (P007) : `0` quand aucun surge n'est actif. */
  readonly debugSurge: string;
  /** Événement rare actif d'un personnage (P011), ou son absence. */
  readonly debugEvent: string;
  /** Modulation de vitesse apportée par l'événement en cours (P011). */
  readonly debugEventBonus: string;
  /** Écart du personnage au leader, en mètres, dans le panneau de debug (P011). */
  readonly debugGap: string;
  /** Absence d'événement rare actif, dans le panneau de debug (P011). */
  readonly debugNoEvent: string;
  /** Numéro de segment courant, dans le panneau de debug (P011). */
  readonly debugSegment: string;
  /** Titre de la mini-carte du HUD. */
  readonly minimapTitle: string;
  /** Libellé du repère de départ de la mini-carte. */
  readonly minimapStart: string;
  /** Libellé de l'échelle nominale, en tête de la mini-carte. */
  readonly minimapEnd: string;
  /** Titre du bloc chrono / segment. */
  readonly timeTitle: string;
  /** Libellé du temps simulé écoulé. */
  readonly timeLabel: string;
  /** Libellé du numéro de segment courant. */
  readonly segmentLabel: string;
  /** Libellé de la seed affichée dans le HUD. */
  readonly seedLabel: string;
  /** Libellé du bouton qui copie la seed. */
  readonly copySeedButton: string;
  /** Confirmation affichée après une copie réussie. */
  readonly copySeedDone: string;
  /** Libellé de l'écart en secondes dans le classement. */
  readonly gapSecondsLabel: string;
  /** Titre du bandeau de checkpoint, suivi du numéro et de l'instant. */
  readonly checkpointTitle: string;
  /** Libellé du split de tête dans le bandeau de checkpoint. */
  readonly checkpointLeaderSplit: string;
  /** Libellé du repère décoratif de l'échelle nominale. */
  readonly nominalScale: string;
  /** Libellé du bouton qui lance la course. */
  readonly startButton: string;
  /** Libellé du bouton qui rejoue la même course. */
  readonly replayButton: string;
  /** Libellé du bouton qui suspend la course. */
  readonly pauseButton: string;
  /** Libellé du même bouton quand la course est suspendue. */
  readonly resumeButton: string;
  /** Début de la bannière de checkpoint ; le rendu y ajoute le numéro (`CHECKPOINT 2`). */
  readonly checkpointBanner: string;
  /**
   * Gabarit de l'indicateur de file du bandeau de commentaire (P012).
   *
   * Le rendu y remplace `{n}` par le nombre réel de répliques en attente dans la file du speaker, et
   * n'affiche rien du tout quand cette file est vide.
   */
  readonly queuedLines: string;
  /** Titre du bloc de réglages locaux (P012). */
  readonly settingsTitle: string;
  /** Libellé du bouton qui coupe **toutes** les sorties vocales. */
  readonly muteLabel: string;
  /** Libellé du bouton qui autorise la vocalisation des répliques. */
  readonly ttsLabel: string;
  /** État affiché d'un réglage activé. */
  readonly settingsOn: string;
  /** État affiché d'un réglage désactivé. */
  readonly settingsOff: string;
  /** Titre de l'écran d'arrivée (P013). */
  readonly finishTitle: string;
  /** Étiquette du vainqueur, suivie de son nom et de sa distance. */
  readonly finishWinnerLabel: string;
  /** Titre de la section podium (top 3). */
  readonly finishPodiumTitle: string;
  /** Titre de la section classement complet (les 6). */
  readonly finishRankingTitle: string;
  /** Mention mise en avant quand le noyau a réellement produit `PHOTO_FINISH`. */
  readonly finishPhotoBadge: string;
  /** Libellé du bouton qui rejoue **exactement** la même seed. */
  readonly finishReplaySameSeed: string;
  /** Libellé du bouton qui tire une nouvelle seed et démarre réellement une nouvelle course. */
  readonly finishNewRace: string;
}
