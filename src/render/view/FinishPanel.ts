import type { CharacterId } from '../../core/types';
import type { LeaderboardRow } from '../../sim/leaderboard';
import type { UiText } from '../uiText';
import type { FinishModel, FinishPhotoFinish } from './finishModel';
import { formatDecimalFr, formatGapMeters } from './Hud';

/**
 * Écran d'arrivée (P013) : **présentation** du classement final, en HTML dans l'arène.
 *
 * ## Pourquoi un panneau HTML, et non une scène Phaser
 *
 * Comme le HUD de P011 et le bandeau de P012, et pour les mêmes raisons : les six résultats, les
 * écarts et les deux boutons doivent rester lisibles en 844×390, être comparables par le DOM dans les
 * tests, et partager une grille CSS qui **interdit par construction** le recouvrement avec les blocs
 * de course. Un texte dessiné dans le canvas suivrait les unités logiques de la scène, et un podium
 * « à la main » en coordonnées serait précisément le genre de géométrie dont on ne veut pas qu'elle
 * serve de critère. Le rôle de scène de fin est donc tenu par `RaceScene` (phase `finished`) et ce
 * panneau, qui lit un `FinishModel` déjà dérivé du noyau.
 *
 * ## Ce qu'il ne fait pas
 *
 * Il ne trie rien, ne compare aucune distance et ne connaît ni le moteur, ni `core/ranking`, ni le
 * décor : il reçoit un `FinishModel` **déjà calculé** (`finishModel.ts`, à partir du classement du
 * noyau) et l'écrit. Le podium ne peut donc pas contredire le noyau, ni dépendre d'une position de
 * sprite ou d'une ligne d'arrivée dessinée. Les deux boutons ne décident rien non plus : ils appellent
 * les actions fournies par `app/`, qui est la seule couche à connaître la seed et l'URL.
 */

/** Photographie de l'écran d'arrivée réellement affiché, pour les tests E2E. */
export interface FinishDebugSnapshot {
  readonly seed: string;
  readonly tSim: number;
  readonly steps: number;
  readonly winnerId: CharacterId;
  readonly podiumIds: readonly CharacterId[];
  readonly rows: readonly {
    readonly id: CharacterId;
    readonly rank: number;
    /** Distance finale brute, telle qu'affichée (mètres). */
    readonly distance: number;
    readonly gapMeters: number;
  }[];
  readonly photoFinish: FinishPhotoFinish | null;
  readonly visible: boolean;
}

/** Actions fournies par `app/` : le panneau les déclenche, il n'en décide jamais le contenu. */
export interface FinishActions {
  /** Relance une course **exactement** avec la seed source. */
  replaySameSeed(): void;
  /** Tire une nouvelle seed et lance réellement une nouvelle course. */
  newRace(): void;
}

/** Clé d'identité d'un affichage : sert à éviter toute réécriture inutile du DOM. */
function signatureOf(model: FinishModel): string {
  return model.rows
    .map((row) => `${row.id}:${String(row.rank)}:${row.distance}:${row.gapMeters}`)
    .join('|')
    .concat(`#${model.photoFinish === null ? 'none' : String(model.photoFinish.gapMeters)}`);
}

export class FinishPanel {
  private readonly text: UiText;

  private readonly root: HTMLElement;

  private readonly winnerLine: HTMLElement;

  private readonly photoBadge: HTMLElement;

  private readonly podiumRows: HTMLElement;

  private readonly rankingRows: HTMLElement;

  private readonly replayButton: HTMLButtonElement;

  private readonly newRaceButton: HTMLButtonElement;

  private lastSignature = '';

  private lastModel: FinishModel | null = null;

  private visible = false;

  constructor(root: HTMLElement, text: UiText, actions: FinishActions) {
    this.text = text;

    const section = document.createElement('section');
    section.className = 'hud-finish';
    section.dataset['testid'] = 'finish';

    const head = document.createElement('div');
    head.className = 'hud-finish-head';

    const title = document.createElement('p');
    title.className = 'hud-finish-title';
    title.textContent = text.finishTitle;

    this.winnerLine = document.createElement('p');
    this.winnerLine.className = 'hud-finish-winner';
    this.winnerLine.dataset['testid'] = 'finish-winner';

    this.photoBadge = document.createElement('p');
    this.photoBadge.className = 'hud-finish-photo';
    this.photoBadge.dataset['testid'] = 'finish-photo';
    this.photoBadge.hidden = true;

    head.append(title, this.winnerLine, this.photoBadge);

    const body = document.createElement('div');
    body.className = 'hud-finish-body';

    const podiumSection = document.createElement('section');
    podiumSection.className = 'hud-finish-section';
    const podiumTitle = document.createElement('p');
    podiumTitle.className = 'hud-finish-subtitle';
    podiumTitle.textContent = text.finishPodiumTitle;
    this.podiumRows = document.createElement('ol');
    this.podiumRows.className = 'hud-finish-list hud-finish-podium';
    this.podiumRows.dataset['testid'] = 'finish-podium';
    podiumSection.append(podiumTitle, this.podiumRows);

    const rankingSection = document.createElement('section');
    rankingSection.className = 'hud-finish-section';
    const rankingTitle = document.createElement('p');
    rankingTitle.className = 'hud-finish-subtitle';
    rankingTitle.textContent = text.finishRankingTitle;
    this.rankingRows = document.createElement('ol');
    this.rankingRows.className = 'hud-finish-list hud-finish-ranking';
    this.rankingRows.dataset['testid'] = 'finish-ranking';
    rankingSection.append(rankingTitle, this.rankingRows);

    body.append(podiumSection, rankingSection);

    const footer = document.createElement('div');
    footer.className = 'hud-finish-actions';

    this.replayButton = document.createElement('button');
    this.replayButton.type = 'button';
    this.replayButton.dataset['testid'] = 'finish-replay-same';
    this.replayButton.textContent = text.finishReplaySameSeed;

    this.newRaceButton = document.createElement('button');
    this.newRaceButton.type = 'button';
    this.newRaceButton.dataset['testid'] = 'finish-new-race';
    this.newRaceButton.textContent = text.finishNewRace;

    footer.append(this.replayButton, this.newRaceButton);
    section.append(head, body, footer);

    this.replayButton.addEventListener('click', () => {
      actions.replaySameSeed();
    });
    this.newRaceButton.addEventListener('click', () => {
      actions.newRace();
    });

    this.root = section;
    root.appendChild(section);
    this.hide();
  }

  /**
   * Affiche le modèle, ou masque l'écran quand `model` est `null`.
   *
   * L'appelant fournit `null` dès que la phase n'est plus `finished` : l'écran d'arrivée est donc un
   * **reflet** de l'état, jamais un drapeau que quelqu'un devrait penser à baisser.
   */
  update(model: FinishModel | null): void {
    if (model === null) {
      this.hide();
      return;
    }

    this.show();
    this.lastModel = model;

    const signature = signatureOf(model);
    if (signature === this.lastSignature) {
      return;
    }
    this.lastSignature = signature;

    const { winner } = model;
    this.winnerLine.textContent = `${this.text.finishWinnerLabel} : ${winner.name} · ${formatDecimalFr(winner.distance)}${this.text.metres}`;
    this.winnerLine.dataset['characterId'] = winner.id;
    this.winnerLine.dataset['rank'] = String(winner.rank);
    this.winnerLine.dataset['distance'] = String(winner.distance);

    this.updatePhotoFinish(model.photoFinish);

    this.podiumRows.replaceChildren(
      ...model.podium.map((row) => this.rowElement(row, 'finish-podium-row')),
    );
    this.rankingRows.replaceChildren(
      ...model.rows.map((row) => this.rowElement(row, 'finish-row')),
    );
  }

  /** Photographie de l'écran réellement affiché, `null` tant qu'aucune arrivée n'est présentée. */
  snapshot(): FinishDebugSnapshot | null {
    if (this.lastModel === null) {
      return null;
    }
    return {
      seed: this.lastModel.seed,
      tSim: this.lastModel.tSim,
      steps: this.lastModel.steps,
      winnerId: this.lastModel.winner.id,
      podiumIds: this.lastModel.podium.map((row) => row.id),
      rows: this.lastModel.rows.map((row) => ({
        id: row.id,
        rank: row.rank,
        distance: row.distance,
        gapMeters: row.gapMeters,
      })),
      photoFinish: this.lastModel.photoFinish,
      visible: this.visible,
    };
  }

  /**
   * Mention de photo finish.
   *
   * Elle n'apparaît que si le noyau a réellement produit `PHOTO_FINISH` : le panneau ne recalcule
   * aucun seuil et n'affiche donc jamais la mention sur une course qui ne l'a pas eue.
   */
  private updatePhotoFinish(photo: FinishPhotoFinish | null): void {
    this.photoBadge.hidden = photo === null;
    this.photoBadge.textContent =
      photo === null
        ? ''
        : `${this.text.finishPhotoBadge} · ${formatGapMeters(photo.gapMeters, this.text.metres)}`;
    if (photo !== null) {
      this.photoBadge.dataset['gap'] = String(photo.gapMeters);
      this.photoBadge.dataset['characterId'] = photo.leaderId;
    }
  }

  /**
   * Une ligne de résultat : position, nom, distance finale et écart au vainqueur.
   *
   * Les nombres bruts sont aussi publiés en `data-*` : un test peut donc comparer **exactement** ce
   * qui est présenté aux valeurs du noyau, sans dépendre d'un arrondi de texte.
   */
  private rowElement(row: LeaderboardRow, testId: string): HTMLElement {
    const element = document.createElement('li');
    element.className = 'hud-finish-row';
    element.dataset['testid'] = testId;
    element.dataset['characterId'] = row.id;
    element.dataset['rank'] = String(row.rank);
    element.dataset['distance'] = String(row.distance);
    element.dataset['gap'] = String(row.gapMeters);
    if (row.rank === 1) {
      element.classList.add('is-winner');
    }

    const rank = document.createElement('span');
    rank.className = 'hud-finish-rank';
    rank.textContent = `${String(row.rank)}.`;

    const name = document.createElement('span');
    name.className = 'hud-finish-name';
    name.textContent = row.name;

    const distance = document.createElement('span');
    distance.className = 'hud-finish-distance';
    distance.textContent = `${formatDecimalFr(row.distance)}${this.text.metres}`;

    const gap = document.createElement('span');
    gap.className = 'hud-finish-gap';
    gap.textContent = formatGapMeters(row.gapMeters, this.text.metres);

    element.append(rank, name, distance, gap);
    return element;
  }

  private show(): void {
    this.visible = true;
    this.root.hidden = false;
  }

  /** Masque réellement l'écran : `hidden` retire l'élément, donc aucune place n'est réservée. */
  private hide(): void {
    this.visible = false;
    this.lastModel = null;
    this.lastSignature = '';
    this.root.hidden = true;
    this.photoBadge.hidden = true;
    this.photoBadge.textContent = '';
    this.winnerLine.textContent = '';
    this.podiumRows.replaceChildren();
    this.rankingRows.replaceChildren();
  }
}
