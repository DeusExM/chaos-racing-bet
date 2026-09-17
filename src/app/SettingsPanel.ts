import type { UiText } from '../render/uiText';
import type { RaceSettings, SettingsStore } from './settings';

/**
 * Panneau des réglages locaux (P012), posé dans l'arène comme le HUD de P011.
 *
 * ## Pourquoi dans `app/`
 *
 * Parce qu'il ne touche qu'à deux choses : le DOM et `SettingsStore`. Le rendu (`src/render/`) ne
 * doit jamais lire ni écrire un réglage — il ne connaît que des faits, un état de course en lecture
 * seule et une ligne de commentaire déjà décidée. Garder l'interface des réglages ici est ce qui
 * conserve cette frontière intacte, et c'est aussi la raison pour laquelle un test E2E peut vérifier
 * les réglages sans que le rendu ait à en savoir quoi que ce soit.
 *
 * ## Ce que les boutons font
 *
 * Strictement basculer un booléen persisté. `Muet` coupe **toutes** les sorties vocales ; `Voix`
 * autorise la vocalisation des répliques. Ni l'un ni l'autre ne parle au speaker, ne touche à la
 * simulation ou à la seed : les sous-titres texte restent visibles dans tous les cas.
 */
export class SettingsPanel {
  private readonly store: SettingsStore;

  private readonly text: UiText;

  private readonly muteButton: HTMLButtonElement;

  private readonly ttsButton: HTMLButtonElement;

  private readonly muteState: HTMLElement;

  private readonly ttsState: HTMLElement;

  constructor(root: HTMLElement, store: SettingsStore, text: UiText) {
    this.store = store;
    this.text = text;

    const panel = document.createElement('section');
    panel.className = 'hud-settings';
    panel.dataset['testid'] = 'settings';

    const title = document.createElement('span');
    title.className = 'hud-settings-title';
    title.textContent = text.settingsTitle;

    const mute = createToggle(text.muteLabel, 'settings-mute');
    const tts = createToggle(text.ttsLabel, 'settings-tts');
    this.muteButton = mute.button;
    this.muteState = mute.state;
    this.ttsButton = tts.button;
    this.ttsState = tts.state;

    panel.append(title, mute.button, tts.button);
    root.appendChild(panel);

    this.muteButton.addEventListener('click', () => {
      this.store.update({ mute: !this.store.get().mute });
    });
    this.ttsButton.addEventListener('click', () => {
      this.store.update({ tts: !this.store.get().tts });
    });

    this.store.subscribe((settings) => {
      this.render(settings);
    });
    this.render(this.store.get());
  }

  /** Reflète l'état réel du store : jamais un état local qui pourrait diverger de la persistance. */
  private render(settings: RaceSettings): void {
    applyToggle(this.muteButton, this.muteState, settings.mute, this.text);
    applyToggle(this.ttsButton, this.ttsState, settings.tts, this.text);
  }
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
