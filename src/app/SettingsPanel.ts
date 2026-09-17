import type { UiText } from '../render/uiText';
import type { RaceSettings, SettingsStore } from './settings';

/**
 * Panneau des réglages locaux (P012, libellés et forme revus par la passe corrective), posé dans
 * l'arène comme le HUD de P011.
 *
 * ## Pourquoi dans `app/`
 *
 * Parce qu'il ne touche qu'à deux choses : le DOM et `SettingsStore`. Le rendu (`src/render/`) ne
 * doit jamais lire ni écrire un réglage — il ne connaît que des faits, un état de course en lecture
 * seule et une ligne de commentaire déjà décidée. Garder l'interface des réglages ici est ce qui
 * conserve cette frontière intacte, et c'est aussi la raison pour laquelle un test E2E peut vérifier
 * les réglages sans que le rendu ait à en savoir quoi que ce soit.
 *
 * ## Ce que les boutons font, et comment ils sont nommés
 *
 * Le premier test joueur manuel a jugé `Muet` / `Voix` incompréhensibles : deux règles négatives
 * croisées, dont personne ne pouvait déduire ce qui allait sortir des haut-parleurs. Les réglages
 * sont donc renommés par ce qu'ils **activent** :
 *
 * * `Son` — les effets sonores de l'interface (aujourd'hui le klaxon de confirmation) ;
 * * `Commentateur` — la vocalisation des répliques.
 *
 * Chacun est un interrupteur indépendant, et son état est écrit en clair (`activé` / `coupé`) juste à
 * côté de son nom. Ni l'un ni l'autre ne parle au speaker, ne touche à la simulation ou à la seed :
 * les sous-titres texte restent visibles dans tous les cas.
 *
 * ## Pourquoi des rappels, et pas des effets ici
 *
 * Activer un réglage doit produire un **retour immédiat** : un klaxon pour le son, une courte
 * confirmation vocale pour le commentateur. Ces retours appartiennent à `app/` (Web Audio, Web
 * Speech) et non au panneau, qui ne connaît que des booléens. Les rappels sont donc appelés **dans
 * le gestionnaire de clic**, ce qui est la seule façon de respecter les politiques d'autoplay des
 * navigateurs — et jamais au chargement, ni à la désactivation.
 */
export class SettingsPanel {
  private readonly store: SettingsStore;

  private readonly text: UiText;

  private readonly soundButton: HTMLButtonElement;

  private readonly commentatorButton: HTMLButtonElement;

  private readonly soundState: HTMLElement;

  private readonly commentatorState: HTMLElement;

  constructor(
    root: HTMLElement,
    store: SettingsStore,
    text: UiText,
    handlers: SettingsHandlers = {},
  ) {
    this.store = store;
    this.text = text;

    const panel = document.createElement('section');
    panel.className = 'hud-settings';
    panel.dataset['testid'] = 'settings';
    // Le titre visible a été retiré (passe corrective) : chaque bouton dit ce qu'il active, et le
    // panneau se réduit donc à deux pastilles. Le libellé reste porté pour l'accessibilité.
    panel.setAttribute('aria-label', text.settingsTitle);

    const sound = createToggle(text.soundLabel, 'settings-sound');
    const commentator = createToggle(text.commentatorLabel, 'settings-commentator');
    this.soundButton = sound.button;
    this.soundState = sound.state;
    this.commentatorButton = commentator.button;
    this.commentatorState = commentator.state;

    panel.append(sound.button, commentator.button);
    root.appendChild(panel);

    this.soundButton.addEventListener('click', () => {
      const enabled = !this.store.get().sound;
      this.store.update({ sound: enabled });
      if (enabled) {
        // Dans le geste utilisateur : c'est le seul moment où un navigateur autorise un son.
        handlers.onSoundEnabled?.();
      }
    });
    this.commentatorButton.addEventListener('click', () => {
      const enabled = !this.store.get().commentator;
      this.store.update({ commentator: enabled });
      if (enabled) {
        handlers.onCommentatorEnabled?.();
      }
    });

    this.store.subscribe((settings) => {
      this.render(settings);
    });
    this.render(this.store.get());
  }

  /** Reflète l'état réel du store : jamais un état local qui pourrait diverger de la persistance. */
  private render(settings: RaceSettings): void {
    applyToggle(this.soundButton, this.soundState, settings.sound, this.text);
    applyToggle(this.commentatorButton, this.commentatorState, settings.commentator, this.text);
  }
}

/**
 * Retours immédiats d'activation.
 *
 * Ils sont optionnels, et l'absence de l'un d'eux n'empêche rien : si Web Audio est absent, le
 * panneau continue de basculer le réglage et de le persister.
 */
export interface SettingsHandlers {
  /** Appelé **uniquement** à l'activation du son, dans le clic. */
  readonly onSoundEnabled?: (() => void) | undefined;
  /** Appelé **uniquement** à l'activation du commentateur, dans le clic. */
  readonly onCommentatorEnabled?: (() => void) | undefined;
}

/** Fabrique un bouton bascule étiqueté, avec son indicateur d'état. */
function createToggle(
  label: string,
  testId: string,
): { button: HTMLButtonElement; state: HTMLElement } {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'hud-settings-toggle';
  button.dataset['testid'] = testId;
  button.setAttribute('aria-pressed', 'false');

  const name = document.createElement('span');
  name.className = 'hud-settings-toggle-label';
  name.textContent = label;

  const state = document.createElement('span');
  state.className = 'hud-settings-toggle-state';
  state.dataset['testid'] = `${testId}-state`;

  button.append(name, state);
  return { button, state };
}

/**
 * Applique l'état d'un réglage au bouton.
 *
 * `aria-pressed` porte l'état pour l'accessibilité, `data-state` le porte pour les tests : les deux
 * sont écrits depuis la **même** valeur, donc l'affichage ne peut pas mentir sur le réglage réel.
 */
function applyToggle(
  button: HTMLButtonElement,
  state: HTMLElement,
  enabled: boolean,
  text: UiText,
): void {
  button.setAttribute('aria-pressed', enabled ? 'true' : 'false');
  button.dataset['state'] = enabled ? 'on' : 'off';
  state.textContent = enabled ? text.settingsOn : text.settingsOff;
}