import { RACE_CONFIG } from '../../core/config';
import type { UiText } from '../uiText';
import { formatSimTime } from './Hud';
import { REPLAY_STEP_STEPS } from './replayModel';

/**
 * Barre de **relecture** (passe corrective 2) : écrite dans le DOM, hors de l'arène.
 *
 * ## Ce qu'elle pilote, et ce qu'elle ne pilote pas
 *
 * Elle ne produit qu'une chose : un **numéro de pas à consulter**, transmis par le rappel `onSeek`.
 * Elle ne connaît ni `RaceSimulation`, ni `RaceEngine`, ni le speaker, et elle ne peut donc pas faire
 * avancer, reculer ni redémarrer quoi que ce soit. La scène borne ce numéro (`replayModel.ts`) et
 * l'utilise pour dessiner un instant déjà joué.
 *
 * ## Pourquoi elle vit sous l'arène
 *
 * Le classement a quitté la piste (passe corrective 2) et le HUD ne doit plus rien recouvrir : la
 * barre est donc **dans la rangée des commandes**, avec « Pause » et « Rejouer ». Elle n'apparaît
 * que pendant une pause manuelle, et sa hauteur est réservée en permanence (`hidden` + `visibility`
 * plutôt que `display: none` n'est pas nécessaire : la rangée est en flux, donc l'arène ne bouge pas
 * quand elle apparaît).
 */
export class ReplayBar {
  private readonly root: HTMLElement;

  private readonly text: UiText;

  private readonly back: HTMLButtonElement;

  private readonly forward: HTMLButtonElement;

  private readonly range: HTMLInputElement;

  private readonly readout: HTMLElement;

  /** Pas consulté et pas de pause : ce que la barre affiche, sans jamais les recalculer. */
  private step = 0;

  private pauseStep = 0;

  constructor(root: HTMLElement, text: UiText, onSeek: (step: number) => void) {
    this.root = root;
    this.text = text;
    this.root.hidden = true;

    this.back = document.createElement('button');
    this.back.type = 'button';
    this.back.className = 'replay-step';
    this.back.dataset['testid'] = 'replay-back';
    this.back.textContent = text.replayBack;
    this.back.addEventListener('click', () => {
      onSeek(this.step - REPLAY_STEP_STEPS);
    });

    this.forward = document.createElement('button');
    this.forward.type = 'button';
    this.forward.className = 'replay-step';
    this.forward.dataset['testid'] = 'replay-forward';
    this.forward.textContent = text.replayForward;
    this.forward.addEventListener('click', () => {
      onSeek(this.step + REPLAY_STEP_STEPS);
    });

    this.range = document.createElement('input');
    this.range.type = 'range';
    this.range.className = 'replay-range';
    this.range.dataset['testid'] = 'replay-range';
    this.range.min = '0';
    // Le curseur natif accepte une granularité d'un pas de simulation : la navigation fine (1/60 s)
    // est donc disponible en plus des boutons à 2 s, sans un seul élément supplémentaire.
    this.range.step = '1';
    this.range.setAttribute('aria-label', text.replayTitle);
    this.range.addEventListener('input', () => {
      onSeek(Number(this.range.value));
    });

    this.readout = document.createElement('span');
    this.readout.className = 'replay-readout';
    this.readout.dataset['testid'] = 'replay-readout';

    const title = document.createElement('span');
    title.className = 'replay-title';
    title.textContent = text.replayTitle;

    this.root.append(title, this.back, this.range, this.forward, this.readout);
  }

  /**
   * Applique l'état de la relecture.
   *
   * `pauseStep` est la borne haute : elle vient du noyau, jamais d'un compteur tenu par la barre. La
   * barre ne peut donc pas proposer un instant que la course n'a pas atteint.
   */
  update(visible: boolean, step: number, pauseStep: number): void {
    this.step = step;
    this.pauseStep = pauseStep;
    this.root.hidden = !visible;
    if (!visible) {
      return;
    }

    this.range.max = String(pauseStep);
    if (this.range.value !== String(step)) {
      this.range.value = String(step);
    }
    // La borne est rappelée à l'écran : `38,4 s / 52,4 s` se lit « j'en suis là, la course en est
    // là ». Le second nombre est l'instant réel de la pause, celui où « Reprendre » repartira.
    setTextIfChanged(
      this.readout,
      `${formatSimTime(step * RACE_CONFIG.DT_S, this.text.gapSecondsLabel)} / ${formatSimTime(pauseStep * RACE_CONFIG.DT_S, this.text.gapSecondsLabel)}`,
    );
    this.back.disabled = step <= 0;
    this.forward.disabled = step >= pauseStep;
  }

  /** Instant consulté, en pas : lu par les tests, jamais par le rendu. */
  get viewedStep(): number {
    return this.step;
  }

  /** Instant de pause, en pas : lu par les tests, jamais par le rendu. */
  get boundStep(): number {
    return this.pauseStep;
  }

  /** Vrai quand la barre est réellement affichée (donc pendant une pause manuelle). */
  get visible(): boolean {
    return !this.root.hidden;
  }
}

/** Écrit un libellé, seulement s'il change : la barre n'est pas réécrite à chaque frame. */
function setTextIfChanged(element: HTMLElement, label: string): void {
  if (element.textContent !== label) {
    element.textContent = label;
  }
}
