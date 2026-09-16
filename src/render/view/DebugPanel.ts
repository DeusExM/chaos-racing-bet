import type { RaceState } from '../../core/types';
import type { SimPhase } from '../../sim/types';
import type { UiText } from '../uiText';

/**
 * Panneau de debug (`?debug=1`).
 *
 * Il n'affiche que des valeurs lues dans l'état du noyau : `tSim`, nombre de pas, distances,
 * vitesses, drift, surge. C'est un outil de mise au point, pas une interface de jeu, et il ne
 * participe jamais au rendu de la course.
 */
export class DebugPanel {
  private readonly text: UiText;

  private readonly pre: HTMLPreElement;

  constructor(root: HTMLElement, text: UiText) {
    this.text = text;
    root.hidden = false;

    const title = document.createElement('p');
    title.className = 'hud-title';
    title.textContent = text.debugTitle;

    this.pre = document.createElement('pre');
    this.pre.className = 'debug-body';
    this.pre.dataset['testid'] = 'debug-body';

    root.append(title, this.pre);
  }

  /** Réécrit le panneau en une seule affectation, sans reconstruire le DOM. */
  update(state: Readonly<RaceState>, phase: SimPhase, timeScale: number): void {
    const lines: string[] = [
      `${this.text.debugPhase} : ${phase}`,
      `${this.text.debugSeed} : ${state.seed}`,
      `${this.text.debugSimTime} : ${state.tSim.toFixed(3)} s`,
      `${this.text.debugSteps} : ${String(state.steps)}`,
      `${this.text.debugTimeScale} : ×${String(timeScale)}`,
    ];

    for (const character of state.characters) {
      const distance = character.x.toFixed(2).replace('.', ',');
      const speed = character.v.toFixed(3).replace('.', ',');
      const drift = character.drift.toFixed(4).replace('.', ',');
      const surge = character.surge.toFixed(4).replace('.', ',');
      lines.push(
        `${character.id}  ${this.text.debugDistance}=${distance}${this.text.metres}  ` +
          `${this.text.debugSpeed}=${speed}  ${this.text.debugDrift}=${drift}  ` +
          `${this.text.debugSurge}=${surge}`,
      );
    }

    this.pre.textContent = lines.join('\n');
  }
}
