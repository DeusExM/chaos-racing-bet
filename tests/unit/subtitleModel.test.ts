import { describe, expect, it } from 'vitest';

import type { CharacterId, RaceFact } from '../../src/core/types';
import type { SpeakerDecision } from '../../src/speaker/Speaker';
import type { SpeakerLine } from '../../src/render/subtitle';
import { VIEW } from '../../src/render/viewConfig';
import {
  EMPTY_SUBTITLE_MODEL,
  advanceFade,
  bannerTransition,
  buildSubtitleModel,
  fadeInStart,
  fadeOutStart,
  isFadeComplete,
  pickLineCharacter,
  queueBadgeLabel,
  subtitleDurationMs,
  subtitleKey,
  subtitleLineView,
} from '../../src/render/view/subtitleModel';

/**
 * P012 — modèle du bandeau de commentaire.
 *
 * Le bandeau lui-même est du DOM : ce qui se teste ici, ce sont les **décisions d'affichage** —
 * durée, personnage mis en avant, file, transitions — qui sont des fonctions pures. Elles ne lisent
 * ni le moteur, ni le speaker, ni un réglage : seulement la ligne déjà décidée.
 */

const NAMES: Readonly<Record<CharacterId, string>> = Object.freeze({
  c0: 'Alphonse',
  c1: 'Berthe',
  c2: 'Cunégonde',
  c3: 'Dédé',
  c4: 'Eulalie',
  c5: 'Fernand',
});

function nameOf(id: CharacterId): string {
  return NAMES[id];
}

function fact(type: RaceFact['type'], characterIds: readonly CharacterId[]): RaceFact {
  return Object.freeze({
    type,
    tSim: 12,
    characterIds: Object.freeze([...characterIds]),
    magnitudes: Object.freeze([1, 2]),
    importance: 60,
    textKey: `fact.${type}`,
  });
}

function line(text: string, characterIds: readonly CharacterId[], preempted = false): SpeakerLine {
  const decision: SpeakerDecision = Object.freeze({
    fact: fact('LEADER_CHANGE', characterIds),
    importance: 60,
    startedAtS: 12,
  });
  const characterId = pickLineCharacter(text, characterIds, nameOf);
  return Object.freeze({
    decision,
    variantIndex: 0,
    text,
    characterId,
    characterName: characterId === null ? null : nameOf(characterId),
    preempted,
    startedAtS: 12,
  });
}

describe('P012 : durée d’affichage adaptée à la longueur', () => {
  it('grandit avec la longueur de la réplique', () => {
    const short = subtitleDurationMs('Court !');
    const long = subtitleDurationMs('Une phrase nettement plus longue, avec des mots et des virgules.');
    expect(long).toBeGreaterThan(short);
  });

  it('reste bornée des deux côtés', () => {
    expect(subtitleDurationMs('')).toBe(VIEW.SUBTITLE_MIN_MS);
    expect(subtitleDurationMs('ok')).toBeGreaterThanOrEqual(VIEW.SUBTITLE_MIN_MS);
    expect(subtitleDurationMs('x'.repeat(10_000))).toBe(VIEW.SUBTITLE_MAX_MS);
  });

  it('ignore les espaces de bord, sans changer de valeur pour autant', () => {
    expect(subtitleDurationMs('  Bonjour  ')).toBe(subtitleDurationMs('Bonjour'));
  });

  it('est une fonction pure : deux appels identiques donnent la même durée', () => {
    expect(subtitleDurationMs('Même phrase')).toBe(subtitleDurationMs('Même phrase'));
  });
});

describe('P012 : personnage mis en avant', () => {
  it('retient le premier personnage du fait réellement nommé par la phrase', () => {
    expect(pickLineCharacter('Alphonse passe devant !', ['c0', 'c1'], nameOf)).toBe('c0');
    expect(pickLineCharacter('Berthe passe devant !', ['c0', 'c1'], nameOf)).toBe('c1');
  });

  it('n’affiche aucun nom quand la phrase ne cite personne', () => {
    expect(pickLineCharacter('Ils sont trois dans 12,4 m !', ['c0', 'c1'], nameOf)).toBeNull();
    expect(pickLineCharacter('', ['c0', 'c1'], nameOf)).toBeNull();
  });

  it('ne retient jamais un personnage absent de la phrase, même cité ailleurs', () => {
    // « Cunégonde » n'est pas dans le fait : le rendu ne peut donc pas l'afficher.
    expect(pickLineCharacter('Cunégonde mène !', ['c0', 'c1'], nameOf)).toBeNull();
  });

  it('ne nomme personne quand le fait ne porte aucun personnage', () => {
    expect(pickLineCharacter('Alphonse mène !', [], nameOf)).toBeNull();
  });
});

describe('P012 : file visible', () => {
  it('n’annonce rien quand la file est vide', () => {
    expect(queueBadgeLabel(0, '{n} en attente')).toBe('');
  });

  it('reflète le nombre réel de répliques en attente', () => {
    expect(queueBadgeLabel(1, '{n} en attente')).toBe('1 en attente');
    expect(queueBadgeLabel(3, '{n} en attente')).toBe('3 en attente');
  });

  it('refuse une valeur qui ne décrit pas une file', () => {
    expect(queueBadgeLabel(-1, '{n} en attente')).toBe('');
    expect(queueBadgeLabel(1.5, '{n} en attente')).toBe('');
    expect(queueBadgeLabel(Number.NaN, '{n} en attente')).toBe('');
  });
});

describe('P012 : modèle d’affichage', () => {
  it('produit un bandeau masqué sans réplique', () => {
    expect(buildSubtitleModel(null, 2, '{n} en attente')).toEqual(EMPTY_SUBTITLE_MODEL);
    expect(buildSubtitleModel(line('', ['c0']), 2, '{n} en attente')).toEqual(EMPTY_SUBTITLE_MODEL);
  });

  it('porte le texte, le nom, la file et la préemption de la ligne', () => {
    const model = buildSubtitleModel(line('Alphonse mène !', ['c0'], true), 2, '{n} en attente');
    expect(model.text).toBe('Alphonse mène !');
    expect(model.characterId).toBe('c0');
    expect(model.characterName).toBe('Alphonse');
    expect(model.queuedCount).toBe(2);
    expect(model.queueBadge).toBe('2 en attente');
    expect(model.preempted).toBe(true);
  });

  it('distingue deux répliques différentes et reconnaît la même', () => {
    const first = buildSubtitleModel(line('Alphonse mène !', ['c0']), 0, '{n}');
    const same = buildSubtitleModel(line('Alphonse mène !', ['c0']), 0, '{n}');
    const other = buildSubtitleModel(line('Berthe mène !', ['c1']), 0, '{n}');
    expect(subtitleKey(first)).toBe(subtitleKey(same));
    expect(subtitleKey(first)).not.toBe(subtitleKey(other));
    expect(subtitleKey(EMPTY_SUBTITLE_MODEL)).toBeNull();
  });

  it('expose la vue de test avec le fait source, ou rien quand le bandeau est masqué', () => {
    const displayed = line('Alphonse mène !', ['c0']);
    const view = subtitleLineView(displayed, 1);
    expect(view?.text).toBe('Alphonse mène !');
    expect(view?.fact).toBe(displayed.decision.fact);
    expect(view?.queuedCount).toBe(1);
    expect(view?.preempted).toBe(false);
    expect(subtitleLineView(null, 1)).toBeNull();
    expect(subtitleLineView(line('', ['c0']), 1)).toBeNull();
  });
});

describe('P012 : transitions du bandeau', () => {
  it('distingue apparition, maintien, remplacement et disparition', () => {
    expect(bannerTransition(null, null)).toBe('hidden');
    expect(bannerTransition(null, 'A')).toBe('appear');
    expect(bannerTransition('A', 'A')).toBe('hold');
    // Préemption : une autre réplique remplace celle en cours, sans file intermédiaire.
    expect(bannerTransition('A', 'B')).toBe('replace');
    expect(bannerTransition('A', null)).toBe('leave');
  });

  it('fait apparaître le bandeau depuis une opacité nulle', () => {
    expect(fadeInStart()).toEqual({ alpha: 0, phase: 'in' });

    const half = advanceFade(fadeInStart(), VIEW.SUBTITLE_FADE_IN_MS / 2);
    expect(half.alpha).toBeCloseTo(0.5, 5);
    expect(half.phase).toBe('in');

    const done = advanceFade(half, VIEW.SUBTITLE_FADE_IN_MS);
    expect(done).toEqual({ alpha: 1, phase: 'steady' });
  });

  it('fait disparaître le bandeau avant de le cacher, sans saut brutal', () => {
    const leaving = fadeOutStart({ alpha: 1, phase: 'steady' });
    expect(leaving).toEqual({ alpha: 1, phase: 'out' });
    expect(isFadeComplete(leaving)).toBe(false);

    const half = advanceFade(leaving, VIEW.SUBTITLE_FADE_OUT_MS / 2);
    expect(half.alpha).toBeCloseTo(0.5, 5);

    const done = advanceFade(half, VIEW.SUBTITLE_FADE_OUT_MS);
    expect(done.alpha).toBe(0);
    expect(isFadeComplete(done)).toBe(true);
  });

  it('borne l’opacité et ignore un temps de frame invalide', () => {
    expect(advanceFade(fadeInStart(), -50).alpha).toBe(0);
    expect(advanceFade(fadeInStart(), Number.NaN).alpha).toBe(0);
    expect(advanceFade({ alpha: 1, phase: 'steady' }, 1000).alpha).toBe(1);
    expect(advanceFade({ alpha: 0, phase: 'steady' }, 1000).alpha).toBe(0);
  });
});
