import { clamp, lerp } from '../../core/math';
import { VIEW } from '../viewConfig';

/**
 * Cadrage de la vue principale.
 *
 * La caméra suit le **peloton** avec une fenêtre adaptative, bornée à
 * `VIEW.CAMERA_WINDOW_MAX_M` (260 m) comme l'exige `GAME_DESIGN.md` §5. Elle ne lit que des
 * distances et ne renvoie qu'un cadrage : elle n'écrit **jamais** dans l'état du noyau.
 *
 * La fenêtre s'élargit avec l'écart entre le premier et le dernier, ce qui garde tout le monde à
 * l'écran quand le peloton s'étire, et se resserre quand il se regroupe — c'est ce zoom
 * automatique qui rend les dépassements lisibles. Au-delà de 260 m d'écart, les personnages les
 * plus éloignés sortent de la fenêtre et sont signalés par un marqueur de bord.
 */
export class CameraRig {
  private leftM = 0;

  private windowM = VIEW.CAMERA_WINDOW_MIN_M;

  private placed = false;

  /** Recalcule le cadrage à partir des distances, puis lisse le déplacement. */
  follow(distances: readonly number[]): void {
    if (distances.length === 0) {
      return;
    }

    let min = distances[0] ?? 0;
    let max = min;
    for (const distance of distances) {
      min = distance < min ? distance : min;
      max = distance > max ? distance : max;
    }

    const spread = max - min;
    const targetWindowM = clamp(
      spread * VIEW.CAMERA_SPREAD_FACTOR + VIEW.CAMERA_SPREAD_MARGIN_M,
      VIEW.CAMERA_WINDOW_MIN_M,
      VIEW.CAMERA_WINDOW_MAX_M,
    );
    // Le centre suit le milieu de l'écart réel : le premier et le dernier restent à égale distance
    // des bords, donc tout le monde reste visible aussi longtemps que la fenêtre le permet.
    const targetLeftM = (min + max) / 2 - targetWindowM / 2;

    if (!this.placed) {
      this.leftM = targetLeftM;
      this.windowM = targetWindowM;
      this.placed = true;
      return;
    }

    this.leftM = lerp(this.leftM, targetLeftM, VIEW.CAMERA_SMOOTHING);
    this.windowM = lerp(this.windowM, targetWindowM, VIEW.CAMERA_SMOOTHING);
  }

  /** Abscisse du bord gauche de la fenêtre, en mètres. */
  get left(): number {
    return this.leftM;
  }

  /** Largeur de la fenêtre, en mètres. */
  get span(): number {
    return this.windowM;
  }

  /** Conversion mètres → pixels écran. */
  toScreenX(distanceM: number, widthPx: number): number {
    return (distanceM - this.leftM) * (widthPx / this.windowM);
  }

  /** Un personnage est-il hors de la fenêtre ? Sert à décider d'un marqueur de bord. */
  isOffscreen(distanceM: number, widthPx: number): boolean {
    const screenX = this.toScreenX(distanceM, widthPx);
    return screenX < VIEW.EDGE_MARGIN_PX || screenX > widthPx - VIEW.EDGE_MARGIN_PX;
  }

  /** Repart de zéro lors d'une nouvelle course. */
  reset(): void {
    this.leftM = 0;
    this.windowM = VIEW.CAMERA_WINDOW_MIN_M;
    this.placed = false;
  }
}
