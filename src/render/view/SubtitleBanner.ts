import {
  advanceFade,
  bannerTransition,
  fadeInStart,
  fadeOutStart,
  isFadeComplete,
  subtitleKey,
  type FadeState,
  type SubtitleModel,
} from './subtitleModel';

/**
 * Bandeau de commentaire : **affichage uniquement** (P009-C, soigné en P012).
 *
 * ## Ce qu'il ne fait pas
 *
 * Il ne sait rien du speaker, des faits, des RNG ni des règles de parole : il reçoit un
 * `SubtitleModel` **déjà décidé et déjà formaté**, le montre, puis le retire. La source de vérité de
 * ce qui est dit — et de ce qui est coupé — reste `Speaker` ; la durée d'affichage est une propriété
 * d'interface, jamais une règle du speaker. Aucun texte n'est écrit ici : pas de libellé par défaut,
 * pas de placeholder, rien. Un bandeau sans texte est un bandeau masqué.
 *
 * ## Pourquoi du HTML dans l'arène
 *
 * Comme le HUD de P011, et pour la même raison : le bandeau partage l'arène avec le classement, le
 * chrono, la seed et le bandeau de checkpoint, dont la géométrie dépend de la taille de la fenêtre.
 * Une grille CSS place ces blocs **par construction** — ils ne peuvent pas se recouvrir —
 * alors qu'un texte dessiné dans le canvas suivrait les unités logiques de la scène et pourrait
 * passer sous un bloc du HUD selon la résolution. Le texte reste en outre lisible en 844×390, où une
 * police de canvas mise à l'échelle descendrait sous les 10 px, et il est comparable par le DOM dans
 * les tests. La direction artistique définitive appartient à P014.
 *
 * ## Transitions
 *
 * L'opacité est pilotée par une machine à états **pure** (`subtitleModel.ts`), avancée par le temps
 * réel de la frame comme le reste du rendu. Une apparition part de zéro, une **préemption** remplace
 * la réplique en cours sans jamais remettre l'ancienne, et une disparition s'efface avant de se
 * cacher. Aucune de ces transitions ne touche à la simulation.
 */
export class SubtitleBanner {
  private readonly root: HTMLElement;

  private readonly nameLabel: HTMLElement;

  private readonly textLabel: HTMLElement;

  private readonly queueLabel: HTMLElement;

  /** Clé de la réplique affichée : deux clés différentes signifient deux répliques différentes. */
  private key: string | null = null;

  /** Texte considéré comme affiché : vidé dès le début d'une disparition. */
  private text = '';

  private fade: FadeState = { alpha: 0, phase: 'steady' };

  private visible = false;

  private queueBadge = '';

  constructor(root: HTMLElement) {
    const section = document.createElement('section');
    section.className = 'hud-subtitle';
    section.dataset['testid'] = 'subtitle';
    // Le commentaire est une information vivante : il est annoncé, jamais interrompu de force.
    section.setAttribute('role', 'status');
    section.setAttribute('aria-live', 'polite');

    this.nameLabel = document.createElement('p');
    this.nameLabel.className = 'hud-subtitle-name';
    this.nameLabel.dataset['testid'] = 'subtitle-name';
    this.nameLabel.hidden = true;

    this.textLabel = document.createElement('p');
    this.textLabel.className = 'hud-subtitle-text';
    this.textLabel.dataset['testid'] = 'subtitle-text';

    this.queueLabel = document.createElement('p');
    this.queueLabel.className = 'hud-subtitle-queue';
    this.queueLabel.dataset['testid'] = 'subtitle-queue';
    this.queueLabel.hidden = true;

    section.append(this.nameLabel, this.textLabel, this.queueLabel);
    root.appendChild(section);

    this.root = section;
    this.hide();
  }

  /**
   * Applique le modèle de la frame, puis avance la transition d'opacité du temps réel écoulé.
   *
   * Remplacer un texte par un autre est le cas de la **préemption** : la réplique coupée disparaît
   * sans retour, elle n'est jamais remise en file par le rendu.
   */
  render(model: SubtitleModel, realDtMs: number): void {
    const transition = bannerTransition(this.key, subtitleKey(model));

    switch (transition) {
      case 'appear':
      case 'replace':
        this.key = subtitleKey(model);
        this.text = model.text;
        this.writeContent(model);
        this.fade = fadeInStart();
        this.show();
        break;

      case 'hold':
        // Même réplique : seul l'état de la file peut avoir changé.
        this.writeQueue(model.queueBadge);
        break;

      case 'leave':
        if (this.fade.phase !== 'out') {
          this.fade = fadeOutStart(this.fade);
        }
        // Le texte n'est plus « affiché » dès la première frame de la disparition, même si le DOM le
        // porte encore le temps de l'effacement.
        this.text = '';
        break;

      case 'hidden':
        break;
    }

    this.fade = advanceFade(this.fade, realDtMs);
    this.applyAlpha();

    if (transition === 'leave' && isFadeComplete(this.fade)) {
      this.key = null;
      this.hide();
    }
  }

  /** Texte réellement affiché, `''` quand le bandeau est masqué ou en train de disparaître. */
  visibleText(): string {
    return this.visible ? this.text : '';
  }

  /** Écrit la réplique complète : nom mis en avant, texte, indicateur de file. */
  private writeContent(model: SubtitleModel): void {
    const name = model.characterName;
    if (name === null || name.length === 0) {
      this.nameLabel.hidden = true;
      this.nameLabel.textContent = '';
    } else {
      this.nameLabel.hidden = false;
      this.nameLabel.textContent = name;
    }

    this.textLabel.textContent = model.text;
    this.writeQueue(model.queueBadge);
  }

  /** Indicateur de file : il reflète le nombre réel de commentaires en attente, rien de plus. */
  private writeQueue(badge: string): void {
    if (badge === this.queueBadge) {
      return;
    }
    this.queueBadge = badge;
    this.queueLabel.textContent = badge;
    this.queueLabel.hidden = badge.length === 0;
  }

  private show(): void {
    this.visible = true;
    this.root.hidden = false;
  }

  /** Masque réellement le bandeau : `hidden` retire l'élément, donc aucune place n'est réservée. */
  private hide(): void {
    this.visible = false;
    this.text = '';
    this.queueBadge = '';
    this.nameLabel.hidden = true;
    this.nameLabel.textContent = '';
    this.textLabel.textContent = '';
    this.queueLabel.hidden = true;
    this.queueLabel.textContent = '';
    this.root.hidden = true;
  }

  private applyAlpha(): void {
    this.root.style.opacity = String(this.fade.alpha);
  }
}
