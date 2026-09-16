import type { LeaderboardRow } from '../../sim/leaderboard';
import type { UiText } from '../uiText';

/**
 * Panneau de classement, en HTML **au-dessus** du canvas.
 *
 * Le choix du DOM est délibéré : le classement doit être lisible et comparable à celui du noyau par
 * un test E2E, ce qu'un texte dessiné dans le canvas rendrait pénible. Il ne contient **aucune**
 * logique de classement : il affiche les lignes qu'on lui donne, calculées par `core/ranking.ts` via
 * `src/sim/leaderboard.ts`.
 */
export class LeaderboardView {
  private readonly text: UiText;

  private readonly list: HTMLElement;

  private readonly rows = new Map<string, HTMLElement>();

  private lastSnapshot = '';

  constructor(root: HTMLElement, text: UiText) {
    this.text = text;
    this.list = root;

    const title = document.createElement('p');
    title.className = 'hud-title';
    title.textContent = text.rankingTitle;
    this.list.appendChild(title);
  }

  /** Met à jour les lignes. L'écriture DOM n'a lieu que si le classement a réellement changé. */
  update(rows: readonly LeaderboardRow[]): void {
    const snapshot = rows
      .map((row) => `${row.id}:${row.rank}:${row.gapMeters.toFixed(1)}`)
      .join('|');
    if (snapshot === this.lastSnapshot) {
      return;
    }
    this.lastSnapshot = snapshot;

    const seen = new Set<string>();
    for (const row of rows) {
      seen.add(row.id);
      let element = this.rows.get(row.id);
      if (element === undefined) {
        element = document.createElement('div');
        element.className = 'hud-row';
        element.dataset['testid'] = 'leaderboard-row';
        element.dataset['characterId'] = row.id;
        const rank = document.createElement('span');
        rank.className = 'hud-rank';
        const name = document.createElement('span');
        name.className = 'hud-name';
        const gap = document.createElement('span');
        gap.className = 'hud-gap';
        element.append(rank, name, gap);
        this.rows.set(row.id, element);
        this.list.appendChild(element);
      }

      element.dataset['rank'] = String(row.rank);
      const rank = element.querySelector('.hud-rank');
      const name = element.querySelector('.hud-name');
      const gap = element.querySelector('.hud-gap');
      if (rank !== null) {
        rank.textContent = `${String(row.rank)}.`;
      }
      if (name !== null) {
        name.textContent = row.name;
      }
      if (gap !== null) {
        const formatted = formatMetres(row.gapMeters, this.text.metres);
        gap.textContent = row.gapMeters > 0 ? `+${formatted}` : formatted;
      }
      // L'ordre visuel doit suivre l'ordre du classement, pas l'ordre de création des lignes.
      this.list.appendChild(element);
    }

    for (const [id, element] of this.rows) {
      if (!seen.has(id)) {
        element.remove();
        this.rows.delete(id);
      }
    }
  }
}

/**
 * Formate une distance en mètres, avec la virgule décimale française.
 *
 * Le remplacement est fait à la main plutôt qu'avec `Intl` : le rendu d'un test ne doit pas dépendre
 * des données de locale du moteur JavaScript qui exécute la page.
 */
function formatMetres(value: number, unit: string): string {
  return `${value.toFixed(1).replace('.', ',')}${unit}`;
}
