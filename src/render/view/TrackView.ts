import type { GameObjects, Scene } from 'phaser';

import { CHARACTER_IDS } from '../../core/characters';
import type { UiText } from '../uiText';
import { VIEW, laneRatios, laneY } from '../viewConfig';
import type { CameraRig } from './CameraRig';

/**
 * Décor de la piste : voies et graduations de distance.
 *
 * **Décor uniquement.** Ces repères ne conditionnent ni la fin de la course ni le classement, et
 * aucun d'eux n'est lu par `src/core/` ni `src/sim/` : ils sont dessinés à partir du cadrage de la
 * caméra, jamais l'inverse. Il n'existe ici aucune ligne d'arrivée — la course se termine à
 * `tSim = 60 s`, quel que soit l'endroit où se trouve chaque personnage — et le repère d'« échelle
 * nominale » a été retiré de la piste : plus épais que les autres, il se lisait comme une ligne
 * d'arrivée et induisait en erreur.
 */
export class TrackView {
  private readonly lanes: GameObjects.Graphics;

  private readonly ticks: GameObjects.Graphics;

  private readonly labels: GameObjects.Text[] = [];

  private readonly text: UiText;

  private widthPx: number;

  private heightPx: number;

  /** Ratios des voies du format courant : une seule source pour les bandes, les repères et les noms. */
  private laneTop = VIEW.LANE_TOP_RATIO;

  private laneBottom = VIEW.LANE_BOTTOM_RATIO;

  constructor(scene: Scene, text: UiText) {
    this.text = text;
    this.widthPx = VIEW.BASE_WIDTH;
    this.heightPx = VIEW.BASE_HEIGHT;

    this.lanes = scene.add.graphics();
    this.ticks = scene.add.graphics();

    for (let index = 0; index < VIEW.TRACK_LABEL_POOL; index += 1) {
      const label = scene.add.text(0, 0, '', {
        fontFamily: 'monospace',
        fontSize: '13px',
        color: '#6f7ca6',
      });
      label.setOrigin(0.5, 1);
      label.setVisible(false);
      this.labels.push(label);
    }
  }

  /** Redessine le décor pour la taille courante. À appeler au démarrage et à chaque redimensionnement. */
  layout(widthPx: number, heightPx: number, compact = false): void {
    this.widthPx = widthPx;
    this.heightPx = heightPx;

    const ratios = laneRatios(compact);
    this.laneTop = ratios.top;
    this.laneBottom = ratios.bottom;

    this.lanes.clear();
    const bandHeight = heightPx / (CHARACTER_IDS.length + 1);
    for (const [index] of CHARACTER_IDS.entries()) {
      const center = laneY(index, heightPx, compact);
      const even = index % 2 === 0;
      this.lanes.fillStyle(even ? 0x131a2f : 0x101627, 1);
      this.lanes.fillRect(0, center - bandHeight / 2, widthPx, bandHeight);
    }

    // Ligne d'horizon : repère purement visuel du sol, sans aucun sens de course.
    this.lanes.lineStyle(2, 0x24305a, 1);
    this.lanes.lineBetween(0, this.horizonY(heightPx), widthPx, this.horizonY(heightPx));
  }

  /** Ordonnée de la ligne d'horizon : le haut de la zone des voies du format courant. */
  private horizonY(heightPx: number): number {
    const bandHeight = heightPx / (CHARACTER_IDS.length + 1);
    return heightPx * this.laneTop - bandHeight / 2;
  }

  /** Ordonnée du bas de la zone des voies : elle borne les graduations de distance. */
  private laneAreaBottom(heightPx: number): number {
    const bandHeight = heightPx / (CHARACTER_IDS.length + 1);
    return heightPx * this.laneBottom + bandHeight / 2;
  }

  /** Redessine les graduations visibles, d'après le cadrage courant. */
  update(rig: CameraRig): void {
    const leftM = rig.left;
    const rightM = leftM + rig.span;

    const top = this.horizonY(this.heightPx);
    const bottom = this.laneAreaBottom(this.heightPx);

    this.ticks.clear();
    this.ticks.lineStyle(1, 0x26315c, 1);

    const firstTick = Math.ceil(leftM / VIEW.TRACK_TICK_STEP_M) * VIEW.TRACK_TICK_STEP_M;
    for (let metre = firstTick; metre <= rightM; metre += VIEW.TRACK_TICK_STEP_M) {
      const x = rig.toScreenX(metre, this.widthPx);
      this.ticks.lineBetween(x, top, x, bottom);
    }

    // Aucun repère « d'échelle nominale » n'est plus dessiné ici : un trait vertical plus épais au
    // milieu de la piste se lisait comme une ligne d'arrivée, alors que la course se termine
    // exclusivement au temps (`tSim = 60 s`) et qu'aucune distance n'est une fin de course. La piste
    // ne montre donc plus que des graduations régulières, identiques entre elles.
    let used = 0;
    const firstLabel = Math.ceil(leftM / VIEW.TRACK_LABEL_STEP_M) * VIEW.TRACK_LABEL_STEP_M;
    for (let metre = firstLabel; metre <= rightM; metre += VIEW.TRACK_LABEL_STEP_M) {
      const label = this.labels[used];
      if (label === undefined) {
        break;
      }
      const x = rig.toScreenX(metre, this.widthPx);
      label.setText(`${String(Math.round(metre))}${this.text.metres}`);
      label.setPosition(x, top - 6);
      label.setVisible(true);
      used += 1;
    }

    for (let index = used; index < this.labels.length; index += 1) {
      this.labels[index]?.setVisible(false);
    }
  }
}
