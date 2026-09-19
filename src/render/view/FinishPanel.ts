import type { CharacterId } from '../../core/types';
import type { LeaderboardRow } from '../../sim/leaderboard';
import type { UiText } from '../uiText';
import { formatSecondsFr } from '../format';
import type { FinishModel, FinishPassage, FinishPhotoFinish } from './finishModel';
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
  /**
   * Passages en tête réellement affichés : les checkpoints observés, puis l'arrivée.
   *
   * `checkpoint` vaut `null` pour l'arrivée. Un test peut donc comparer ces lignes au classement du
   * noyau relevé au même instant, sans dépendre du texte affiché.
   */
  readonly passages: readonly {
    readonly checkpoint: number | null;
    readonly tSim: number;
    readonly id: CharacterId;
    readonly name: string;
  }[];
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
    .concat(
      `#${model.photoFinish === null ? 'none' : String(model.photoFinish.gapMeters)}`,
      `#${model.passages.map((passage) => `${String(passage.checkpoint)}:${passage.characterId}:${String(passage.tSim)}`).join('|')}`,
    );
}

export class FinishPanel {
  private readonly text: UiText;

  private readonly root: HTMLElement;

  private readonly winnerLine: HTMLElement;

  private readonly photoBadge: HTMLElement;

  private readonly podiumRows: HTMLElement;

  private readonly rankingRows: HTMLElement;

  private readonly passageRows: HTMLElement;

  private readonly replayButton: HTMLButtonElement;

  private readonly newRaceButton: HTMLButtonElement;

  /**
   * Bouton de fermeture (×) : il **masque** l'écran d'arrivée, et rien de plus.
   *
   * Il ne relance aucune course, ne change pas la seed et ne touche pas au résultat : le classement
   * figé reste disponible (`snapshot()`), les commandes habituelles redeviennent simplement
   * accessibles sous le panneau.
   */
  private readonly closeButton: HTMLButtonElement;

  private lastSignature = '';

  private lastModel: FinishModel | null = null;

  private visible = false;

  /**
   * L'écran a-t-il été fermé par le joueur pour cette arrivée ?
   *
   * Le panneau reste un **reflet** de l'état : il se réaffiche donc à chaque nouvelle arrivée, et
   * cette marque n'est levée que lorsque la course quitte la phase `finished` (voir `hide()`).
   */
  private dismissed = false;

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

    // Fermeture : le bouton est dans l'en-tête, à droite. Il porte un libellé lisible par les
    // technologies d'assistance (`aria-label`) et un caractère visible (`×`) — un simple glyphe sans
    // nom accessible serait un bouton muet.
    this.closeButton = document.createElement('button');
    this.closeButton.type = 'button';
    this.closeButton.className = 'hud-finish-close';
    this.closeButton.dataset['testid'] = 'finish-close';
    this.closeButton.textContent = '×';
    this.closeButton.setAttribute('aria-label', text.finishCloseLabel);

    head.append(title, this.winnerLine, this.photoBadge, this.closeButton);

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

    // Passages en tête : un rappel court de qui menait aux deux checkpoints, puis à l'arrivée. Les
    // lignes viennent de relevés réels (`passageModel.ts`) et du classement final figé, jamais d'un
    // recalcul depuis les positions d'écran ; une borne non observée n'est simplement pas listée.
    const passagesSection = document.createElement('section');
    passagesSection.className = 'hud-finish-section hud-finish-passages';
    passagesSection.dataset['testid'] = 'finish-passages';
    const passagesTitle = document.createElement('p');
    passagesTitle.className = 'hud-finish-subtitle';
    passagesTitle.textContent = text.finishPassagesTitle;
    this.passageRows = document.createElement('ol');
    this.passageRows.className = 'hud-finish-list hud-finish-passage-list';
    passagesSection.append(passagesTitle, this.passageRows);

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
    section.append(head, body, passagesSection, footer);

    this.replayButton.addEventListener('click', () => {
      actions.replaySameSeed();
    });
    this.newRaceButton.addEventListener('click', () => {
      actions.newRace();
    });
    this.closeButton.addEventListener('click', () => {
      this.dismiss();
    });

    // Échap ferme aussi l'écran, sur les appareils qui ont un clavier. Le raccourci ne fait **rien**
    // quand le panneau n'est pas affiché : il ne peut donc pas voler une touche au reste de la page.
    window.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !this.visible) {
        return;
      }
      this.dismiss();
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

    this.lastModel = model;
    if (this.dismissed) {
      // Fermé par le joueur pour cette arrivée : le panneau reste masqué, mais le classement figé est
      // conservé tel quel (aucune donnée n'est recalculée ni effacée).
      return;
    }

    this.show();

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
    this.passageRows.replaceChildren(
      ...model.passages.map((passage) => this.passageElement(passage)),
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
      passages: this.lastModel.passages.map((passage) => ({
        checkpoint: passage.checkpoint,
        tSim: passage.tSim,
        id: passage.characterId,
        name: passage.name,
      })),
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

  /**
   * Une ligne de passage : la borne, son instant **mesuré**, et le nom du leader observé.
   *
   * L'instant vient du noyau (`20`, `40`, `60` s) : il n'est jamais recopié depuis une constante, et
   * une borne non observée n'est jamais complétée. La dernière ligne est l'arrivée, et il n'existe pas
   * de « checkpoint 3 ».
   */
  private passageElement(passage: FinishPassage): HTMLElement {
    const element = document.createElement('li');
    element.className = 'hud-finish-passage';
    element.dataset['testid'] = 'finish-passage';
    element.dataset['characterId'] = passage.characterId;
    element.dataset['tSim'] = String(passage.tSim);
    element.dataset['bound'] = passage.checkpoint === null ? 'arrival' : String(passage.checkpoint);

    const bound = document.createElement('span');
    bound.className = 'hud-finish-passage-bound';
    bound.textContent =
      passage.checkpoint === null
        ? this.text.finishTitle
        : `${this.text.checkpointTitle} ${String(passage.checkpoint)}`;

    const instant = document.createElement('span');
    instant.className = 'hud-finish-passage-time';
    instant.textContent = formatSecondsFr(passage.tSim);

    const name = document.createElement('span');
    name.className = 'hud-finish-passage-name';
    name.textContent = passage.name;

    element.append(bound, instant, name);
    return element;
  }

  private show(): void {
    this.visible = true;
    this.root.hidden = false;
  }

  /**
   * Masque l'écran sans rien oublier : le classement figé reste lisible par les tests et par le HUD.
   *
   * C'est ce que fait le bouton ×. `dismissed` empêche le panneau de se réafficher à la frame
   * suivante, puisque le modèle, lui, est toujours là.
   */
  private dismiss(): void {
    this.dismissed = true;
    this.visible = false;
    this.root.hidden = true;
  }

  /** Masque réellement l'écran : `hidden` retire l'élément, donc aucune place n'est réservée. */
  private hide(): void {
    this.visible = false;
    this.dismissed = false;
    this.lastModel = null;
    this.lastSignature = '';
    this.root.hidden = true;
    this.photoBadge.hidden = true;
    this.photoBadge.textContent = '';
    this.winnerLine.textContent = '';
    this.podiumRows.replaceChildren();
    this.rankingRows.replaceChildren();
    this.passageRows.replaceChildren();
  }
}
