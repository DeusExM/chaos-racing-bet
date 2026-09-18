import { CHARACTERS } from '../../core/characters';
import { characterAssetUrl } from '../characterAssets';
import type { UiText } from '../uiText';

/**
 * Panneau « persos » (micro-correction responsive) : les six personnages en grand, par-dessus le jeu.
 *
 * ## Pourquoi il existe
 *
 * En course, un personnage mesure ~45 px de haut sur un téléphone : c'est assez pour suivre la course,
 * pas pour regarder les illustrations. Le bouton discret placé à côté de la seed ouvre donc ce
 * panneau, qui affiche les **six visuels déjà intégrés au projet** (`characterAssets`, les mêmes
 * fichiers que le rendu charge) en grand, avec leur nom.
 *
 * ## Ce qu'il ne fait pas
 *
 * C'est une **surcouche d'interface** : elle ne connaît ni `RaceSimulation`, ni `RaceEngine`, ni le
 * speaker, ni la relecture, et elle ne lit que deux choses — le roster (`CHARACTERS`, des noms) et les
 * URL d'images. Ouvrir ou fermer le panneau ne peut donc rien changer à la course : aucun pas n'est
 * exécuté, aucun fait n'est produit, aucun tirage n'a lieu, la course continue derrière.
 *
 * ## DOM et fermeture
 *
 * Le contenu est construit **au premier affichage** : aucun `<img>` n'est créé tant que le panneau
 * n'a pas été ouvert, donc aucun téléchargement ni décodage inutile. La surcouche est ajoutée au
 * `body` — et non dans le HUD — parce qu'elle doit couvrir l'écran sans être rognée par la boîte de
 * l'arène (`overflow: hidden` en petit paysage). Elle se ferme par le bouton « Fermer », par un clic
 * sur le fond, ou par `Échap`.
 */
export class CharacterGallery {
  private readonly button: HTMLElement;

  private readonly text: UiText;

  /** Surcouche créée au premier `open()` : `null` tant que rien n'a été affiché. */
  private overlay: HTMLElement | null = null;

  private closeButton: HTMLButtonElement | null = null;

  /** Élément à re-focaliser à la fermeture : le panneau ne doit pas « perdre » le clavier. */
  private returnFocus: HTMLElement | null = null;

  constructor(button: HTMLElement, text: UiText) {
    this.button = button;
    this.text = text;

    this.button.textContent = text.galleryButton;
    this.button.setAttribute('aria-label', text.galleryTitle);
    this.button.addEventListener('click', () => {
      this.open();
    });
  }

  /** Vrai quand le panneau est réellement affiché. Lu par les tests, jamais par le rendu. */
  get isOpen(): boolean {
    return this.overlay !== null && !this.overlay.hidden;
  }

  /** Affiche le panneau, en le construisant à la première ouverture. */
  open(): void {
    if (this.isOpen) {
      return;
    }
    const overlay = this.ensureOverlay();
    this.returnFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : this.button;
    overlay.hidden = false;
    document.addEventListener('keydown', this.onKeyDown);
    this.closeButton?.focus();
  }

  /** Masque le panneau. Sans effet s'il n'a jamais été ouvert. */
  close(): void {
    if (this.overlay !== null) {
      this.overlay.hidden = true;
    }
    document.removeEventListener('keydown', this.onKeyDown);
    this.returnFocus?.focus();
    this.returnFocus = null;
  }

  /** `Échap` ferme : c'est le geste attendu d'un panneau modal, et il ne dépend d'aucun clic. */
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      this.close();
    }
  };

  /** Construit la surcouche et son contenu, une seule fois. */
  private ensureOverlay(): HTMLElement {
    if (this.overlay !== null) {
      return this.overlay;
    }

    const overlay = document.createElement('div');
    overlay.className = 'gallery';
    overlay.dataset['testid'] = 'gallery';
    overlay.hidden = true;
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', this.text.galleryTitle);
    // Un clic sur le fond — et seulement sur le fond — ferme le panneau.
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) {
        this.close();
      }
    });

    const panel = document.createElement('div');
    panel.className = 'gallery-panel';

    const head = document.createElement('div');
    head.className = 'gallery-head';

    const title = document.createElement('h2');
    title.className = 'gallery-title';
    title.textContent = this.text.galleryTitle;

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'gallery-close';
    close.dataset['testid'] = 'gallery-close';
    close.textContent = this.text.galleryClose;
    close.addEventListener('click', () => {
      this.close();
    });

    head.append(title, close);

    const grid = document.createElement('ul');
    grid.className = 'gallery-grid';
    for (const character of CHARACTERS) {
      const card = document.createElement('li');
      card.className = 'gallery-card';
      card.dataset['testid'] = 'gallery-card';

      const image = document.createElement('img');
      image.className = 'gallery-image';
      // Les fichiers servis sont ceux du rendu : aucune copie, aucun autre asset n'est ajouté.
      image.src = characterAssetUrl(character.id);
      // Le nom est juste en dessous : l'image est décorative et ne doit pas être lue deux fois.
      image.alt = '';
      image.draggable = false;

      const name = document.createElement('span');
      name.className = 'gallery-name';
      name.textContent = character.name;

      card.append(image, name);
      grid.append(card);
    }

    panel.append(head, grid);
    overlay.append(panel);
    document.body.append(overlay);

    this.overlay = overlay;
    this.closeButton = close;
    return overlay;
  }
}
