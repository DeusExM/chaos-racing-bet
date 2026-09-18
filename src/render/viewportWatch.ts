import { isPortraitPhone, orientationOf, type ViewportOrientation } from './viewport';
import { ViewportSettle, type ViewportSample } from './viewportSettle';

/**
 * Surveillance de la fenêtre : une **seule** source de vérité pour la taille et l'orientation.
 *
 * ## Pourquoi un module, et pas un `addEventListener('resize')` de plus
 *
 * Sur iOS, une rotation n'est pas un événement : c'est une **séquence** — `orientationchange`,
 * plusieurs `resize`, et des `visualViewport.resize` pendant que la barre d'URL se replace. Chaque
 * mesure intermédiaire décrit une fenêtre qui n'existe plus. Ce module écoute les trois sources,
 * attend que la taille se stabilise (`viewportSettle.ts`), puis publie une seule fois le résultat.
 *
 * ## Ce qu'il écrit dans la page, et pourquoi
 *
 * 1. `--app-height`, sur `<html>` : la hauteur **réellement visible**. C'est le remède au
 *    `100vh`/`100dvh` de WebKit, qui vaut la hauteur de la fenêtre *large* (barres repliées) : après
 *    une rotation, la page se retrouvait plus haute que l'écran, donc recadrée, et les voies du haut
 *    et du bas sortaient du viewport. La valeur vient de `visualViewport` quand il est fiable.
 * 2. `data-rotation-gate`, sur `<html>` : `on` quand l'écran est un téléphone tenu droit. C'est
 *    l'**unique** décision d'affichage de l'écran de rotation ; `styles.css` ne fait que la styler, et
 *    le prédicat (`viewport.isPortraitPhone`) n'existe donc qu'une fois dans le projet.
 *
 * ## Ce qu'il ne fait jamais
 *
 * Il ne recharge pas la page : une course en cours ne doit pas être perdue pour un problème
 * d'affichage. Le repli, quand WebKit n'arrête pas de changer de taille, est d'accepter la dernière
 * mesure connue après `SETTLE_MAX_WAIT_MS` — jamais de relancer l'application.
 */

/** Attribut posé sur `<html>` : `on` quand la course ne doit pas être jouée (téléphone droit). */
export const ROTATION_GATE_ATTRIBUTE = 'data-rotation-gate';

/** Variable CSS qui porte la hauteur réellement visible, en pixels CSS. */
export const APP_HEIGHT_PROPERTY = '--app-height';

/** Ce que l'application sait de la fenêtre, une fois la taille stabilisée. */
export interface ViewportMetrics {
  readonly visibleWidth: number;
  readonly visibleHeight: number;
  readonly layoutWidth: number;
  readonly layoutHeight: number;
  /** Orientation de la **mise en page** : celle que voient les requêtes média. */
  readonly orientation: ViewportOrientation;
  /** Vrai quand l'écran est un téléphone tenu droit : l'écran de rotation recouvre tout. */
  readonly rotationGate: boolean;
}

export interface ViewportWatchOptions {
  /**
   * Appelé immédiatement avec la meilleure mesure connue, puis à chaque taille stabilisée.
   *
   * C'est le seul point d'entrée : le rendu y réapplique son cadrage, `app/` y gèle ou dégèle la
   * course. Aucun autre module n'a besoin d'écouter la fenêtre.
   */
  readonly onStable: (metrics: ViewportMetrics) => void;
}

/** Mesure la fenêtre : taille visible d'un côté, taille de mise en page de l'autre. */
export function readViewportSample(scope: Window): ViewportSample {
  const visual = scope.visualViewport;
  // Un pincement rétrécit le viewport **visuel** sans changer la mise en page : on ne redimensionne
  // donc pas l'application pour un zoom, on garde la taille de mise en page. C'est aussi le repli
  // documenté si `visualViewport` annonce une taille incohérente (nulle) : `innerWidth`/`innerHeight`.
  const visible =
    visual !== null && Math.abs(visual.scale - 1) <= 0.01 && visual.width > 0 && visual.height > 0
      ? { width: visual.width, height: visual.height }
      : null;

  return {
    visibleWidth: Math.round(visible?.width ?? scope.innerWidth),
    visibleHeight: Math.round(visible?.height ?? scope.innerHeight),
    layoutWidth: Math.round(scope.innerWidth),
    layoutHeight: Math.round(scope.innerHeight),
  };
}

/** Décisions de format déduites d'une mesure. Fonction pure. */
export function viewportMetricsOf(sample: ViewportSample): ViewportMetrics {
  return {
    visibleWidth: sample.visibleWidth,
    visibleHeight: sample.visibleHeight,
    layoutWidth: sample.layoutWidth,
    layoutHeight: sample.layoutHeight,
    orientation: orientationOf(sample.layoutWidth, sample.layoutHeight),
    rotationGate: isPortraitPhone(sample.layoutWidth, sample.layoutHeight),
  };
}

/**
 * Installe la surveillance. Renvoie la fonction de désinstallation, utilisée par les tests.
 *
 * La première mesure est publiée **immédiatement** : l'écran de rotation ne doit pas attendre une
 * stabilisation pour apparaître, et la hauteur de l'application doit être juste dès la première
 * image. Les mesures suivantes passent, elles, par la stabilisation.
 */
export function installViewportWatch(scope: Window, options: ViewportWatchOptions): () => void {
  const settle = new ViewportSettle();

  const apply = (metrics: ViewportMetrics): void => {
    const root = scope.document.documentElement;
    root.style.setProperty(APP_HEIGHT_PROPERTY, `${String(metrics.visibleHeight)}px`);
    root.dataset['rotationGate'] = metrics.rotationGate ? 'on' : 'off';
    options.onStable(metrics);
  };

  apply(viewportMetricsOf(readViewportSample(scope)));

  let frame = 0;

  const tick = (): void => {
    frame = 0;
    const stable = settle.push(readViewportSample(scope), scope.performance.now());
    if (stable === null) {
      schedule();
      return;
    }
    apply(viewportMetricsOf(stable));
  };

  function schedule(): void {
    if (frame === 0 && settle.pending) {
      frame = scope.requestAnimationFrame(tick);
    }
  }

  const onWindowChange = (): void => {
    settle.arm(scope.performance.now());
    schedule();
  };

  scope.addEventListener('resize', onWindowChange);
  scope.addEventListener('orientationchange', onWindowChange);
  const visual = scope.visualViewport;
  visual?.addEventListener('resize', onWindowChange);

  return () => {
    scope.removeEventListener('resize', onWindowChange);
    scope.removeEventListener('orientationchange', onWindowChange);
    visual?.removeEventListener('resize', onWindowChange);
    if (frame !== 0) {
      scope.cancelAnimationFrame(frame);
      frame = 0;
    }
  };
}
