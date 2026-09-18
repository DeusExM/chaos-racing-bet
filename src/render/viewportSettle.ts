/**
 * Stabilisation de la taille de la fenêtre.
 *
 * ## Le problème, tel qu'il se voit sur un iPhone
 *
 * Au démarrage direct en paysage, iOS connaît déjà la bonne taille : la mise en page est juste. Après
 * une rotation (paysage → portrait → paysage), WebKit annonce d'abord des dimensions encore héritées
 * de l'orientation précédente, puis les corrige **en plusieurs fois** (barre d'URL repliée, encoche,
 * `visualViewport`). Recalculer la mise en page sur la première valeur venue donne donc une arène
 * cadrée pour l'ancienne orientation — piste zoomée, voies du haut et du bas hors de l'écran.
 *
 * ## Ce que fait ce module
 *
 * Il ne décide de **rien** sur le format : il attend. Une mesure n'est déclarée stable que lorsqu'elle
 * s'est répétée `SETTLE_SAMPLES` fois de suite, et un délai maximal borne l'attente pour qu'une
 * séquence d'événements sans fin (barre d'URL animée) ne bloque jamais la mise en page : au pire, la
 * dernière taille connue est acceptée.
 *
 * Le temps est **injecté** (`nowMs`) : la classe est donc pure, testable sans navigateur, et ne
 * contient ni `Date.now` ni `requestAnimationFrame` — ce sont `viewportWatch.ts` et la boucle
 * d'animation qui les fournissent.
 */

/** Nombre de mesures consécutives identiques qui valent stabilisation (≈ 50 ms à 60 Hz). */
export const SETTLE_SAMPLES = 3;

/**
 * Attente maximale, en millisecondes, avant d'accepter la dernière taille connue.
 *
 * C'est le **repli documenté** : sur un WebKit qui n'arrête jamais d'annoncer des tailles qui
 * changent, on préfère une mise en page légèrement optimiste à une page figée. Aucun rechargement
 * n'est jamais déclenché — une course en cours ne doit pas être perdue.
 */
export const SETTLE_MAX_WAIT_MS = 600;

/** Taille de fenêtre mesurée, en pixels CSS. Comparée telle quelle, sans arrondi supplémentaire. */
export interface ViewportSample {
  /** Largeur réellement visible : elle décide de la largeur de l'application. */
  readonly visibleWidth: number;
  /** Hauteur réellement visible : elle décide de la hauteur de l'application. */
  readonly visibleHeight: number;
  /** Largeur de **mise en page** : c'est elle que lisent les requêtes média de `styles.css`. */
  readonly layoutWidth: number;
  /** Hauteur de mise en page : elle décide du format « petit paysage ». */
  readonly layoutHeight: number;
}

/** Deux mesures décrivent-elles la même fenêtre ? */
export function sameViewport(a: ViewportSample, b: ViewportSample): boolean {
  return (
    a.visibleWidth === b.visibleWidth &&
    a.visibleHeight === b.visibleHeight &&
    a.layoutWidth === b.layoutWidth &&
    a.layoutHeight === b.layoutHeight
  );
}

/**
 * Détecteur de stabilisation.
 *
 * Usage : `arm()` à chaque événement de fenêtre (`resize`, `orientationchange`,
 * `visualViewport.resize`), puis `push()` à chaque frame. Tant que `push()` renvoie `null`, la taille
 * n'est pas encore fiable et rien ne doit être recalculé.
 */
export class ViewportSettle {
  private candidate: ViewportSample | null = null;

  private repeats = 0;

  private armedAtMs = 0;

  private armed = false;

  /** Signale un événement de fenêtre : la stabilisation repart de zéro. */
  arm(nowMs: number): void {
    this.armed = true;
    this.armedAtMs = nowMs;
    this.candidate = null;
    this.repeats = 0;
  }

  /** Vrai tant qu'une stabilisation est en cours. */
  get pending(): boolean {
    return this.armed;
  }

  /**
   * Ajoute une mesure.
   *
   * Renvoie la taille **stabilisée** — et désarme le détecteur — ou `null` tant qu'il faut attendre.
   */
  push(sample: ViewportSample, nowMs: number): ViewportSample | null {
    if (!this.armed) {
      return null;
    }

    if (this.candidate !== null && sameViewport(this.candidate, sample)) {
      this.repeats += 1;
    } else {
      this.candidate = sample;
      this.repeats = 0;
    }

    if (this.repeats >= SETTLE_SAMPLES - 1 || nowMs - this.armedAtMs >= SETTLE_MAX_WAIT_MS) {
      this.armed = false;
      return sample;
    }

    return null;
  }
}
