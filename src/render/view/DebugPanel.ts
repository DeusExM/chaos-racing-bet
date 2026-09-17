import type { UiText } from '../uiText';
import type { DebugModel } from './debugModel';

/**
 * Panneau de debug (`?debug=1`), affiché en HTML sous l'arène.
 *
 * C'est une **vue en lecture seule** : il reçoit un `DebugModel` déjà extrait de l'état du noyau et
 * se contente de l'écrire. Il n'a aucun accès à `RaceSimulation`, à `RaceEngine` ou à un état
 * mutable — il ne peut donc pas provoquer un pas supplémentaire, consommer un RNG ni modifier une
 * constante. `debug=1` produit exactement la même course que sans le paramètre, bit à bit.
 *
 * Contrairement au HUD, il vit **sous** l'arène et non dedans : il est large, lisible, et ne masque
 * jamais la course.
 */
export class DebugPanel {
  private readonly text: UiText;

  private readonly pre: HTMLPreElement;

  private lastSnapshot = '';

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
  update(model: DebugModel): void {
    const lines: string[] = [
      `${this.text.debugPhase} : ${model.phase}`,
      `${this.text.debugSeed} : ${model.seed}`,
      `${this.text.debugSimTime} : ${model.tSim.toFixed(3)} s`,
      `${this.text.debugSteps} : ${String(model.steps)}`,
      `${this.text.debugSegment} : ${String(model.segment)}`,
      `${this.text.debugTimeScale} : ×${String(model.timeScale)}`,
    ];

    for (const row of model.rows) {
      const values = [
        `${this.text.debugDistance}=${formatFr(row.x, 2)}`,
        `${this.text.debugSpeed}=${formatFr(row.v, 3)}`,
        `${this.text.debugGap}=${formatFr(row.gapMeters, 2)}${this.text.metres}`,
        `${this.text.debugDrift}=${formatFr(row.drift, 4)}`,
        `${this.text.debugSurge}=${formatFr(row.surge, 4)}`,
        `${this.text.debugEvent}=${row.event ?? this.text.debugNoEvent}`,
        `${this.text.debugEventBonus}=${formatFr(row.eventBonus, 4)}`,
      ];
      lines.push(`${String(row.rank)}. ${row.name} (${row.id})  ${values.join('  ')}`);
    }

    const snapshot = lines.join('\n');
    if (snapshot === this.lastSnapshot) {
      return;
    }
    this.lastSnapshot = snapshot;
    this.pre.textContent = snapshot;
  }
}

/**
 * Nombre à `decimals` décimales, virgule française.
 *
 * Le remplacement est fait à la main plutôt qu'avec `Intl` : le rendu d'un test ne doit pas dépendre
 * des données de locale du moteur JavaScript qui exécute la page.
 */
function formatFr(value: number, decimals: number): string {
  return value.toFixed(decimals).replace('.', ',');
}
