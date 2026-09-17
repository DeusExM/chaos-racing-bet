import { RACE_CONFIG } from '../../core/config';
import type { CharacterId } from '../../core/types';
import type { LeaderboardRow } from '../../sim/leaderboard';
import type { SimPhase } from '../../sim/types';
import type { UiText } from '../uiText';
import { VIEW } from '../viewConfig';
import type { MinimapMarker } from './minimap';

/**
 * HUD complet de la course, en HTML au-dessus du canvas.
 *
 * ## Lecture seule, par construction
 *
 * Le HUD **reçoit** un modèle déjà calculé (`HudModel`) et se contente de l'écrire dans le DOM. Il
 * n'a aucun accès à `RaceSimulation`, à `RaceEngine` ni à un état de course mutable : rien de ce
 * qu'il affiche ne peut donc remonter vers la simulation. C'est la raison pour laquelle les positions
 * de la mini-carte sont calculées ailleurs (`minimap.ts`, fonction pure) et lui sont fournies.
 *
 * ## Pourquoi du HTML et pas du canvas
 *
 * Le classement, les écarts, la seed et les pointages doivent rester lisibles quand l'arène est
 * réduite à un téléphone en paysage, et doivent être comparables à ceux du noyau par un test E2E. Un
 * texte dessiné dans le canvas ne serait ni l'un ni l'autre. Le soin graphique définitif appartient à
 * P014 ; ici, le HUD est volontairement sobre et fonctionnel.
 *
 * ## Responsive
 *
 * Aucune position n'est calculée à la main : les blocs sont des boîtes de la grille `.hud`, dont la
 * géométrie est définie dans `styles.css` pour les trois résolutions de référence. Le DOM ne fait
 * donc que recevoir des valeurs, jamais une mise en page.
 */

/** Segment courant : numéro humain (1 à 4) et temps écoulé depuis le début de ce segment. */
export interface HudSegment {
  readonly number: number;
  readonly elapsedS: number;
}

/**
 * Pointage en cours : la pause de checkpoint et les écarts **figés** à la borne.
 *
 * Il n'existe ici aucune notion nouvelle de checkpoint : le numéro, l'instant et les écarts sont
 * exactement ceux du noyau et de `sim/leaderboard.ts` à l'instant de la pause. Le HUD ne fait que
 * les afficher pendant que le noyau est gelé.
 */
export interface HudCheckpoint {
  readonly number: number;
  /** Instant simulé de la borne, en secondes : `45`, `90` ou `135`. */
  readonly timeS: number;
  /** Classement figé à la borne, du 1er au dernier. */
  readonly rows: readonly LeaderboardRow[];
}

/** Tout ce que le HUD affiche à une frame donnée, déjà calculé. */
export interface HudModel {
  readonly seed: string;
  readonly phase: SimPhase;
  readonly tSim: number;
  /** Nombre de pas du noyau à cet instant : date la frame affichée, sans rien ajouter à la course. */
  readonly steps: number;
  readonly segment: HudSegment;
  readonly rows: readonly LeaderboardRow[];
  readonly markers: readonly MinimapMarker[];
  readonly checkpoint: HudCheckpoint | null;
}

/** `null` est refusé ici : `index.html` porte toujours l'état et le bandeau de checkpoint. */
function requireElement(element: HTMLElement | null, id: string): HTMLElement {
  if (element === null) {
    throw new Error(`Élément #${id} introuvable dans index.html.`);
  }
  return element;
}

/** Éléments d'interface fournis par `index.html` et réorganisés par le HUD. */
export interface HudElements {
  /** Bandeau de checkpoint (`#checkpoint-banner`) : il porte le titre du pointage. */
  readonly banner: HTMLElement | null;
  /** Liste du classement (`#leaderboard`), dont le HUD devient propriétaire à l'exécution. */
  readonly leaderboard: HTMLElement | null;
  /** Valeur de seed (`#seed-value`) : `app/` y écrit la seed au démarrage. */
  readonly seedValue: HTMLElement | null;
}

/** Durée réelle d'affichage de la confirmation de copie, en millisecondes. */
const COPY_FEEDBACK_MS = 1500;

/** Écrit un libellé dans un élément, seulement s'il change : le DOM n'est pas réécrit à chaque frame. */
function setTextIfChanged(element: HTMLElement | null, label: string): void {
  if (element !== null && element.textContent !== label) {
    element.textContent = label;
  }
}

/** Formate un nombre avec une décimale et la virgule française, sans dépendre de la locale du moteur. */
export function formatDecimalFr(value: number): string {
  return value.toFixed(1).replace('.', ',');
}

/** Écart en mètres : `+3,2 m`, et `0,0 m` pour le leader. */
export function formatGapMeters(value: number, metres: string): string {
  const magnitude = `${formatDecimalFr(Math.abs(value))}${metres}`;
  return value > 0 ? `+${magnitude}` : magnitude;
}

/** Écart en secondes : `+0,3 s`, et `0,0 s` pour le leader. */
export function formatGapSeconds(value: number, seconds: string): string {
  const magnitude = `${formatDecimalFr(Math.abs(value))}\u00A0${seconds}`;
  return value > 0 ? `+${magnitude}` : magnitude;
}

/** Temps simulé : `45,0 s`. */
export function formatSimTime(tSim: number, seconds: string): string {
  return `${formatDecimalFr(tSim)}\u00A0${seconds}`;
}

/** Instant d'un pointage : `45 s` — un pointage est toujours une borne entière du noyau. */
export function formatCheckpointInstant(timeS: number, seconds: string): string {
  return `${String(Math.trunc(timeS))}\u00A0${seconds}`;
}

/**
 * Indicateur de dépassement de l'échelle nominale : `+12 m`.
 *
 * Il n'est produit que si le dépassement est strictement positif : un personnage pile sur l'échelle
 * n'a rien à signaler.
 */
export function formatScaleOverflow(overflowM: number, metres: string): string {
  if (!(overflowM > 0)) {
    return '';
  }
  return `+${String(Math.round(overflowM))}${metres}`;
}

/** Libellé de la borne haute de la mini-carte : `échelle nominale 2160 m`. */
export function formatScaleLabel(scaleM: number, label: string, metres: string): string {
  return `${label} ${String(Math.round(scaleM))}${metres}`;
}

/** Libellé d'état correspondant à une phase temps réel. Exhaustif par construction. */
export function statusLabelFor(phase: SimPhase, text: UiText): string {
  switch (phase) {
    case 'idle':
      return text.statusIdle;
    case 'countdown':
      return text.statusCountdown;
    case 'running':
      return text.statusRunning;
    case 'checkpointPause':
      return text.statusCheckpointPause;
    case 'userPaused':
      return text.statusUserPaused;
    case 'finished':
      return text.statusFinished;
  }
}

/**
 * Représentation du HUD telle qu'un test E2E peut la comparer à l'état du noyau.
 *
 * Elle est dérivée du **modèle de la dernière frame**, donc de ce qui a réellement été écrit dans le
 * DOM. Ce n'est pas une seconde source de vérité : c'est la photographie de ce qui est affiché. Les
 * nombres y sont bruts (mètres, secondes, position dans `[0 ; 1]`) pour qu'un test puisse les
 * comparer exactement, sans passer par un texte arrondi.
 *
 * `tSim` et `steps` de l'instantané datent la frame affichée : un test peut donc dire si l'affichage
 * est en retard sur le noyau, et de combien — au lieu de comparer des nombres pris à des instants
 * différents et de tolérer une différence inexpliquée.
 */
export interface HudDebugSnapshot {
  /** Instant simulé de la frame affichée. */
  readonly tSim: number;
  /** Nombre de pas de la frame affichée. */
  readonly steps: number;
  readonly seed: string;
  readonly segment: number;
  readonly rows: readonly {
    readonly id: CharacterId;
    readonly rank: number;
    readonly gapMeters: number;
    readonly gapSeconds: number;
  }[];
  readonly markers: readonly {
    readonly id: CharacterId;
    readonly position: number;
    readonly distance: number;
    readonly overflow: boolean;
    readonly overflowM: number;
  }[];
  readonly checkpoint: {
    readonly number: number;
    readonly timeS: number;
    readonly rows: readonly {
      readonly id: CharacterId;
      readonly rank: number;
      readonly gapMeters: number;
    }[];
  } | null;
}

/** Copie profonde d'un modèle de HUD, sans référence partagée avec la frame suivante. */
export function snapshotOf(model: HudModel): HudDebugSnapshot {
  return {
    tSim: model.tSim,
    steps: model.steps,
    seed: model.seed,
    segment: model.segment.number,
    rows: model.rows.map((row) => ({
      id: row.id,
      rank: row.rank,
      gapMeters: row.gapMeters,
      gapSeconds: row.gapSeconds,
    })),
    markers: model.markers.map((marker) => ({
      id: marker.id,
      position: marker.position,
      distance: marker.distance,
      overflow: marker.overflow,
      overflowM: marker.overflowM,
    })),
    checkpoint:
      model.checkpoint === null
        ? null
        : {
            number: model.checkpoint.number,
            timeS: model.checkpoint.timeS,
            rows: model.checkpoint.rows.map((row) => ({
              id: row.id,
              rank: row.rank,
              gapMeters: row.gapMeters,
            })),
          },
  };
}

export class Hud {
  private readonly text: UiText;

  /** Bandeau de checkpoint : le même élément porte le titre du pointage et reçoit les écarts. */
  private readonly checkpointTitle: HTMLElement;

  private readonly checkpoint: HTMLElement;

  private readonly checkpointSplits: HTMLElement;

  private readonly time: HTMLElement;

  private readonly segment: HTMLElement;

  /** Mini-carte : masquée à l'arrivée par l'écran de fin (P013), qui prend toute la largeur utile. */
  private readonly minimapSection: HTMLElement;

  private readonly seedValue: HTMLElement;

  /** Liste du classement (`#leaderboard`), dont le HUD est propriétaire à l'exécution. */
  private readonly leaderboard: HTMLElement | null;

  private readonly copyButton: HTMLButtonElement;

  private readonly copyState: HTMLElement;

  private readonly markerLayer: HTMLElement;

  private readonly markers = new Map<CharacterId, HTMLElement>();

  private readonly overflow: HTMLElement;

  private readonly rows = new Map<CharacterId, HTMLElement>();

  private readonly splitRows = new Map<CharacterId, HTMLElement>();

  private lastRowsSnapshot = '';

  private lastSplitSnapshot = '';

  /** Dernier modèle reçu : c'est lui que la photographie de test décrit. */
  private lastModel: HudModel | null = null;

  /** Vrai quand les blocs de course sont masqués au profit de l'écran d'arrivée. */
  private finished = false;

  private copyTimer: ReturnType<typeof setTimeout> | null = null;

  /** Vrai tant que la copie est confirmée à l'écran : lu par les tests, jamais par le rendu. */
  private copied = false;

  constructor(root: HTMLElement, text: UiText, elements: HudElements) {
    this.text = text;
    this.seedValue = elements.seedValue ?? document.createElement('span');

    // Le bandeau de checkpoint appartient déjà à `index.html` : le HUD le réinstalle dans la cellule
    // qu'il possède, pour qu'il n'existe qu'un seul endroit qui écrit dans le DOM.
    this.checkpointTitle = requireElement(elements.banner, 'checkpoint-banner');
    this.checkpointTitle.classList.add('hud-banner');
    this.checkpointSplits = document.createElement('div');
    this.checkpointSplits.className = 'hud-splits';
    this.checkpoint = document.createElement('section');
    this.checkpoint.className = 'hud-checkpoint';
    this.checkpoint.dataset['testid'] = 'checkpoint-splits';
    this.checkpoint.hidden = true;
    this.checkpoint.append(this.checkpointTitle, this.checkpointSplits);
    root.appendChild(this.checkpoint);

    const time = document.createElement('section');
    time.className = 'hud-time';
    time.dataset['testid'] = 'hud-time';
    const timeTitle = document.createElement('p');
    timeTitle.className = 'hud-title';
    timeTitle.textContent = text.timeTitle;
    this.time = document.createElement('p');
    this.time.className = 'hud-time-value';
    this.time.dataset['testid'] = 'hud-sim-time';
    this.segment = document.createElement('p');
    this.segment.className = 'hud-segment-value';
    this.segment.dataset['testid'] = 'hud-segment';
    time.append(timeTitle, this.time, this.segment);
    root.appendChild(time);

    // Le classement reste l'élément existant (`#leaderboard`) : ses identifiants de test ne changent
    // pas, et `app/` continue de le résoudre par identifiant.
    this.leaderboard = elements.leaderboard;
    if (this.leaderboard !== null) {
      const rankingTitle = document.createElement('p');
      rankingTitle.className = 'hud-title';
      rankingTitle.textContent = text.rankingTitle;
      this.leaderboard.appendChild(rankingTitle);
      root.appendChild(this.leaderboard);
    }

    const minimap = document.createElement('section');
    minimap.className = 'hud-minimap';
    minimap.dataset['testid'] = 'hud-minimap';
    this.minimapSection = minimap;
    const minimapTitle = document.createElement('p');
    minimapTitle.className = 'hud-title';
    minimapTitle.textContent = text.minimapTitle;
    const start = document.createElement('span');
    start.className = 'hud-track-bound';
    start.textContent = `${text.minimapStart}${text.metres}`;
    const end = document.createElement('span');
    end.className = 'hud-track-bound';
    end.textContent = formatScaleLabel(VIEW.NOMINAL_SCALE_M, text.minimapEnd, text.metres);
    const rail = document.createElement('div');
    rail.className = 'hud-rail';
    this.markerLayer = document.createElement('div');
    this.markerLayer.className = 'hud-markers';
    this.markerLayer.dataset['testid'] = 'hud-markers';
    this.overflow = document.createElement('span');
    this.overflow.className = 'hud-overflow';
    this.overflow.dataset['testid'] = 'hud-overflow';
    rail.append(this.markerLayer, this.overflow);
    const track = document.createElement('div');
    track.className = 'hud-track';
    track.dataset['testid'] = 'hud-track';
    track.append(start, rail, end);
    minimap.append(minimapTitle, track);
    root.appendChild(minimap);

    const seed = document.createElement('section');
    seed.className = 'hud-seed';
    seed.dataset['testid'] = 'hud-seed';
    const seedLabel = document.createElement('span');
    seedLabel.className = 'hud-seed-label';
    seedLabel.textContent = text.seedLabel;
    this.seedValue.classList.add('hud-seed-value');
    this.seedValue.dataset['testid'] = 'seed-value';
    this.copyButton = document.createElement('button');
    this.copyButton.type = 'button';
    this.copyButton.className = 'hud-seed-copy';
    this.copyButton.dataset['testid'] = 'seed-copy';
    this.copyButton.textContent = text.copySeedButton;
    this.copyState = document.createElement('span');
    this.copyState.className = 'hud-seed-state';
    this.copyState.dataset['testid'] = 'seed-copy-state';
    this.copyState.textContent = '';
    seed.append(seedLabel, this.seedValue, this.copyButton, this.copyState);
    root.appendChild(seed);

    // Le bouton déclenche la copie, mais ne décide jamais de son succès : `copySeed` renvoie le
    // résultat réel, que la confirmation affichée reflète.
    this.copyButton.addEventListener('click', () => {
      void this.copySeed();
    });
  }

  /**
   * Met à jour tout le HUD à partir d'un instantané déjà calculé.
   *
   * L'ordre d'écriture n'a aucune importance pour la simulation : rien de ce qui suit ne peut la
   * toucher. Les écritures DOM sont filtrées par changement, une frame sans évolution ne réécrit rien.
   */
  update(model: HudModel): void {
    this.lastModel = model;

    setTextIfChanged(this.checkpointTitle, this.checkpointTitleLabel(model.checkpoint));

    setTextIfChanged(this.seedValue, model.seed);
    setTextIfChanged(this.time, formatSimTime(model.tSim, this.text.gapSecondsLabel));
    setTextIfChanged(
      this.segment,
      `${this.text.segmentLabel} ${String(model.segment.number)}/${String(RACE_CONFIG.SEGMENT_COUNT)}`,
    );

    this.updateMinimap(model.markers);
    this.updateLeaderboard(model.rows);
    this.updateCheckpoint(model.checkpoint);
    this.applyArrivalState(model.phase === 'finished');
  }

  /**
   * À l'arrivée, retire les blocs que l'écran de fin remplace ou rend inutiles (P013).
   *
   * Seuls le **classement live** et la **mini-carte** disparaissent : le premier ferait doublon avec
   * le classement final, la seconde représente une course qui n'avance plus. Le chrono (arrêté à
   * `180,0 s`), l'état, la seed et les réglages restent : ils sont utiles sur l'écran d'arrivée et ne
   * recouvrent rien, puisque l'écran de fin occupe d'autres cellules de la grille.
   *
   * Les lignes du classement **continuent d'être écrites** avant d'être masquées : ce qui est masqué
   * est exactement ce que le noyau a calculé au dernier pas, jamais une frame en retard.
   */
  private applyArrivalState(finished: boolean): void {
    if (finished === this.finished) {
      return;
    }
    this.finished = finished;
    if (this.leaderboard !== null) {
      this.leaderboard.hidden = finished;
    }
    this.minimapSection.hidden = finished;
  }

  /** Titre du bandeau : `Pointage 2 · 90 s`, ou vide hors pointage. */
  private checkpointTitleLabel(checkpoint: HudCheckpoint | null): string {
    if (checkpoint === null) {
      return '';
    }
    return `${this.text.checkpointTitle} ${String(checkpoint.number)} · ${formatCheckpointInstant(checkpoint.timeS, this.text.gapSecondsLabel)}`;
  }

  /** Positions des 6 marqueurs, bornées à l'échelle, plus l'indicateur de dépassement. */
  private updateMinimap(markers: readonly MinimapMarker[]): void {
    let maxOverflow = 0;

    for (const marker of markers) {
      let element = this.markers.get(marker.id);
      if (element === undefined) {
        element = document.createElement('span');
        element.className = 'hud-marker';
        element.dataset['testid'] = 'hud-marker';
        element.dataset['characterId'] = marker.id;
        this.markers.set(marker.id, element);
        this.markerLayer.appendChild(element);
      }

      element.style.left = `${String(marker.position * 100)}%`;
      element.style.background = marker.color;
      element.dataset['position'] = marker.position.toFixed(6);
      element.dataset['distance'] = marker.distance.toFixed(4);
      element.dataset['overflow'] = marker.overflow ? '1' : '0';
      element.title = `${marker.id} ${formatDecimalFr(marker.distance)}${this.text.metres}`;
      maxOverflow = Math.max(maxOverflow, marker.overflowM);
    }

    setTextIfChanged(this.overflow, formatScaleOverflow(maxOverflow, this.text.metres));
  }

  /**
   * Classement live : 6 lignes, dans l'ordre du noyau, écart en mètres et en secondes.
   *
   * Le leader est marqué par `data-leader="1"` et par une classe dédiée, afin qu'il reste
   * identifiable même en petit.
   */
  private updateLeaderboard(rows: readonly LeaderboardRow[]): void {
    const snapshot = rows
      .map((row) => `${row.id}:${row.rank}:${row.gapMeters.toFixed(2)}:${row.gapSeconds.toFixed(2)}`)
      .join('|');
    if (snapshot === this.lastRowsSnapshot) {
      return;
    }
    this.lastRowsSnapshot = snapshot;

    const seen = new Set<CharacterId>();
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
        const seconds = document.createElement('span');
        seconds.className = 'hud-gap-seconds';
        seconds.dataset['testid'] = 'leaderboard-gap-seconds';
        element.append(rank, name, gap, seconds);
        this.rows.set(row.id, element);
        this.leaderboard?.appendChild(element);
      }

      element.dataset['rank'] = String(row.rank);
      element.dataset['leader'] = row.rank === 1 ? '1' : '0';
      element.classList.toggle('is-leader', row.rank === 1);

      setTextIfChanged(element.querySelector<HTMLElement>('.hud-rank'), `${String(row.rank)}.`);
      setTextIfChanged(element.querySelector<HTMLElement>('.hud-name'), row.name);
      setTextIfChanged(
        element.querySelector<HTMLElement>('.hud-gap'),
        formatGapMeters(row.gapMeters, this.text.metres),
      );
      setTextIfChanged(
        element.querySelector<HTMLElement>('.hud-gap-seconds'),
        formatGapSeconds(row.gapSeconds, this.text.gapSecondsLabel),
      );

      // L'ordre visuel suit l'ordre du classement, pas l'ordre de création des lignes.
      this.leaderboard?.appendChild(element);
    }

    for (const [id, element] of this.rows) {
      if (!seen.has(id)) {
        element.remove();
        this.rows.delete(id);
      }
    }
  }

  /**
   * Bandeau de pointage : visible pendant la pause uniquement, avec les écarts figés à la borne.
   *
   * Le numéro de checkpoint vient de `RaceSimulation`, donc d'un fait `CHECKPOINT_SPLIT` du noyau :
   * aucun pointage n'est inventé ici, et le bandeau ne peut pas apparaître ailleurs.
   */
  private updateCheckpoint(checkpoint: HudCheckpoint | null): void {
    if (checkpoint === null) {
      this.checkpoint.hidden = true;
      this.checkpointTitle.hidden = true;
      if (this.lastSplitSnapshot !== '') {
        this.lastSplitSnapshot = '';
        this.checkpointSplits.replaceChildren();
        this.splitRows.clear();
      }
      return;
    }

    this.checkpoint.hidden = false;
    this.checkpointTitle.hidden = false;

    const snapshot = checkpoint.rows
      .map((row) => `${row.id}:${row.rank}:${row.gapMeters.toFixed(2)}`)
      .join('|');
    if (snapshot === this.lastSplitSnapshot) {
      return;
    }
    this.lastSplitSnapshot = snapshot;

    const seen = new Set<CharacterId>();
    for (const row of checkpoint.rows) {
      seen.add(row.id);
      let element = this.splitRows.get(row.id);
      if (element === undefined) {
        element = document.createElement('div');
        element.className = 'hud-split';
        element.dataset['testid'] = 'checkpoint-split';
        element.dataset['characterId'] = row.id;
        const name = document.createElement('span');
        name.className = 'hud-split-name';
        const gap = document.createElement('span');
        gap.className = 'hud-split-gap';
        element.append(name, gap);
        this.splitRows.set(row.id, element);
        this.checkpointSplits.appendChild(element);
      }

      element.dataset['rank'] = String(row.rank);
      setTextIfChanged(element.querySelector<HTMLElement>('.hud-split-name'), row.name);
      setTextIfChanged(
        element.querySelector<HTMLElement>('.hud-split-gap'),
        row.rank === 1
          ? `${this.text.checkpointLeaderSplit} · ${formatCheckpointInstant(checkpoint.timeS, this.text.gapSecondsLabel)}`
          : formatGapMeters(row.gapMeters, this.text.metres),
      );
      this.checkpointSplits.appendChild(element);
    }

    for (const [id, element] of this.splitRows) {
      if (!seen.has(id)) {
        element.remove();
        this.splitRows.delete(id);
      }
    }
  }

  /**
   * Photographie de la dernière frame affichée, pour les tests.
   *
   * Elle est prise **après** l'écriture : ce qu'elle décrit est donc exactement ce que le DOM porte.
   */
  snapshot(): HudDebugSnapshot | null {
    return this.lastModel === null ? null : snapshotOf(this.lastModel);
  }

  /**
   * Copie la seed affichée dans le presse-papiers.
   *
   * Aucune valeur n'est recalculée : c'est la seed **affichée** qui part, donc exactement celle de
   * l'URL. La copie n'a aucun effet sur la simulation — elle n'écrit que dans un presse-papiers.
   *
   * Dégradation : si l'API Clipboard est absente ou refusée (contexte non sécurisé, permission), on
   * retente par `document.execCommand('copy')` sur une sélection de secours. Si les deux échouent, la
   * seed reste lisible et sélectionnable dans le HUD, et rien ne casse.
   */
  async copySeed(): Promise<boolean> {
    const seed = this.seedValue.textContent ?? '';
    if (seed.length === 0) {
      return false;
    }

    let copied = await writeClipboard(seed);
    if (!copied) {
      copied = copyThroughSelection(this.seedValue);
    }

    if (copied) {
      this.showCopyState();
    }
    return copied;
  }

  /**
   * La copie vient-elle d'être confirmée ?
   *
   * Lecture seule, destinée aux tests : elle permet de vérifier que le chemin de copie a réellement
   * abouti, y compris par la sélection de secours quand l'API Clipboard est refusée.
   */
  get copyConfirmed(): boolean {
    return this.copied;
  }

  /** Affiche brièvement la confirmation de copie, puis rend au bouton son libellé normal. */
  private showCopyState(): void {
    this.copied = true;
    setTextIfChanged(this.copyState, this.text.copySeedDone);
    setTextIfChanged(this.copyButton, this.text.copySeedDone);

    if (this.copyTimer !== null) {
      clearTimeout(this.copyTimer);
    }
    this.copyTimer = setTimeout(() => {
      this.copyTimer = null;
      this.copied = false;
      setTextIfChanged(this.copyState, '');
      setTextIfChanged(this.copyButton, this.text.copySeedButton);
    }, COPY_FEEDBACK_MS);
  }
}

/** Écrit dans le presse-papiers si l'API est disponible **et autorisée**. Ne lève jamais. */
async function writeClipboard(value: string): Promise<boolean> {
  const clipboard: Clipboard | undefined = navigator.clipboard;
  if (clipboard === undefined || typeof clipboard.writeText !== 'function') {
    return false;
  }

  // Certains navigateurs exposent `writeText` sans l'accorder pour autant : l'appeler à l'aveugle
  // produirait une confirmation mensongère. On vérifie donc l'état de la permission quand l'API
  // existe, et on laisse `undefined` (API absente) mener directement au chemin de secours.
  const permissions: Permissions | undefined = navigator.permissions;
  if (permissions !== undefined && typeof permissions.query === 'function') {
    try {
      const status = await permissions.query({ name: 'clipboard-write' as PermissionName });
      if (status.state === 'denied') {
        return false;
      }
    } catch {
      // Requête non supportée pour ce nom : on tente l'écriture, qui tranchera.
    }
  }

  try {
    await clipboard.writeText(value);
    return true;
  } catch {
    // Refus de permission ou contexte non sécurisé : on retombe sur la sélection, sans jamais
    // avaler l'erreur silencieusement puisque le résultat est retourné à l'appelant.
    return false;
  }
}

/**
 * Sélection de secours : sélectionne la valeur affichée puis copie la sélection. Ne lève jamais.
 *
 * `document.execCommand` renvoie `false` quand la copie n'a pas abouti : c'est ce résultat qui est
 * propagé, jamais un succès supposé.
 */
function copyThroughSelection(element: HTMLElement): boolean {
  const selection = window.getSelection();
  if (selection === null) {
    return false;
  }
  const range = document.createRange();
  range.selectNodeContents(element);
  selection.removeAllRanges();
  selection.addRange(range);

  try {
    return document.execCommand('copy') === true;
  } catch {
    return false;
  }
}
