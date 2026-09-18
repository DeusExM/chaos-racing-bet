# CHAOS RACE — Règles précises du jeu (V1)

> Document de référence **normatif**. Toute valeur `NUMÉRIQUE` et tout invariant listé ici doit être
> implémenté tel quel, ou bien ce document doit être modifié **en même temps** que le code et les tests
> d'équilibrage (voir `AGENTS.md`).
>
> V1 : 100 % local dans le navigateur, aucun backend, aucune base de données, aucun multijoueur,
> aucune synchronisation entre spectateurs. Un seul MJ (l'utilisateur) lance la course.

---

## 1. Concept

6 personnages loufoques courent sur une piste linéaire. Une seule personne lance la course ; tout le
reste est automatique et imprévisible. Le plaisir vient de : (a) la variabilité permanente des vitesses
qui provoque des rapprochements et des dépassements naturels, (b) des événements rares et puissants,
(c) un speaker qui ne parle que quand il se passe vraiment quelque chose.

**Aucun personnage n'a de caractéristique permanente.** Les 6 personnages partagent exactement la même
configuration. Le résultat dépend uniquement des variations aléatoires de vitesse et des événements.

---

## 2. Unités et conventions

| Grandeur | Unité | Symbole |
| --- | --- | --- |
| Distance | mètre (m) | `x` |
| Temps simulé | seconde (s) | `tSim` |
| Vitesse | m/s | `v` |
| Pas de simulation | seconde | `DT = 1/60` |

* L'axe de piste est **1D** : `x` croît dans le sens de la course, à partir de `x(0) = 0`.
* **`x` n'a pas de borne supérieure et n'a aucune valeur d'arrêt.** Il n'existe **aucune**
  `FINISH_DISTANCE`, aucune ligne d'arrivée physique : la course se termine **uniquement au temps
  simulé** (voir §4).
* `x` et `v` sont des scalaires flottants (`float64`).
* La seule chose qui fait avancer un personnage est **l'intégration de sa vitesse**.
* Le temps simulé est **injecté** dans le moteur (`RaceEngine` ne lit aucune horloge). Le temps réel
  n'existe que dans `RaceSimulation` (§4.2) et dans le rendu.

---

## 3. Les 6 personnages

6 identités purement cosmétiques (nom + couleur + visuel PNG + animation). Aucune ne modifie la
simulation. Le roster vit dans `src/core/characters.ts` (données pures) et est figé :

```ts
export const CHARACTER_IDS = ['c0','c1','c2','c3','c4','c5'] as const;
```

* Indices **stables** `0..5` : ils servent de tie-break déterministe et d'ordre d'itération physique.
  On n'itère **jamais** un `Set`/`Map` pour la physique.
* Aucun modificateur par personnage : un test unitaire vérifie que les 6 configurations sont
  structurellement identiques (`assertAllCharactersEquivalent()`).
* Les noms définitifs sont choisis en P014 ; avant cela, des libellés provisoires suffisent.

---

## 4. Structure temporelle de la course

La course est **entièrement définie par le temps simulé** :

| Segment | Intervalle de temps simulé | Ce qui suit |
| --- | --- | --- |
| Segment 1 | `tSim = 0 → 20 s` | checkpoint 1 + pause |
| Segment 2 | `tSim = 20 → 40 s` | checkpoint 2 + pause |
| Segment 3 | `tSim = 40 → 60 s` | **fin de course à `tSim = 60 s`** |

> **Règle fondatrice** : `tSim = 60 s` ⇒ `finished`. Le gagnant est **simplement le personnage qui a
> parcouru la plus grande distance** à cet instant. Il n'existe **aucune condition d'arrivée basée sur
> une distance** : si tous les personnages étaient très lents, la course durerait quand même 60 s de
> temps simulé ; si l'un d'eux était très rapide, la course se terminerait au même instant.

> **Passe corrective (premier test joueur manuel après P013)** : la course durait 180 s, ce que le
> joueur a jugé **trop long**. La structure est passée à **3 segments de 20 s**, soit **60 s** et
> **2 checkpoints** (bornes à `20 s` et `40 s`). Aucune autre règle n'a changé : ni le pas fixe, ni
> le nombre de personnages, ni le catalogue d'événements, ni les constantes de vitesse.

### 4.1 Constantes

**a) Temps simulé — connu de `RaceEngine` (`RACE_CONFIG`)**

| Constante | Valeur | Description |
| --- | --- | --- |
| `RACE.SEGMENT_COUNT` | `3` | nombre de segments |
| `RACE.SEGMENT_DURATION_S` | `20` | durée **simulée** d'un segment |
| `RACE.TOTAL_SIM_S` | `60` | `SEGMENT_COUNT × SEGMENT_DURATION_S` |
| `RACE.DT_S` | `1/60` | pas fixe de simulation |
| `RACE.STEPS_PER_SEGMENT` | `1200` | `SEGMENT_DURATION_S / DT_S` |
| `RACE.TOTAL_STEPS` | `3600` | `TOTAL_SIM_S / DT_S` |

**b) Temps réel — connu de `RaceSimulation` uniquement (`SIM_CONFIG`)**

| Constante | Valeur | Description |
| --- | --- | --- |
| `SIM.COUNTDOWN_REAL_S` | `3.0` | compte à rebours avant le départ (mode ×1) |
| `SIM.CHECKPOINT_PAUSE_REAL_S` | `3.0` | durée **réelle** d'une pause checkpoint (mode ×1) |
| `SIM.TIME_SCALE` | `1` | mode normal (`20` en mode test `?fast=1`) |
| `SIM.MAX_STEPS_PER_FRAME` | `5` | garde-fou anti « spiral of death » (×1) |
| `SIM.TOTAL_REAL_S` | `72` | `60 + 2×3 + 3` en mode ×1 |

`RaceEngine` **ignore** `SIM_CONFIG` : il ne connaît ni le compte à rebours, ni la durée réelle des
pauses, ni le `timeScale`. Ces valeurs n'atteignent jamais le noyau.

### 4.2 Responsabilité du temps (séparation stricte)

| | `RaceEngine` (noyau, `src/core/`) | `RaceSimulation` (`src/sim/`) |
| --- | --- | --- |
| Temps | **temps simulé** uniquement | **temps réel** uniquement |
| Horloge | aucune : `step()` ne prend **aucun argument** | lit `performance.now()` via un `realDtMs` fourni par la boucle |
| Avance | pas fixes `DT` exclusivement | accumulateur : exécute `floor(acc / DT)` pas |
| Segments | connaît les 3 segments et l'index courant | connaît l'index courant (lecture, pour l'affichage) |
| `tSim` | le produit et le possède | le lit |
| Fin | produit `finished` à `tSim = 60 s` | relaie l'état `finished` au rendu |
| Countdown | **ne connaît pas** | gère le compte à rebours réel |
| Pause checkpoint | **ne connaît pas** la durée réelle ; signale seulement l'**instant** (`tSim = 20/40`) | décide de la pause, de sa durée, de la reprise automatique |
| Pause utilisateur | **ne connaît pas** | suspend l'appel à `step()`, reprend ensuite |
| `timeScale` / mode test | **ne connaît pas** | choisit le **nombre** de pas par frame, jamais leur taille |
| Événements aléatoires | tirés et appliqués dans `step()`, donc **jamais** pendant une pause | garantit qu'aucun `step()` n'a lieu pendant une pause |

**Règle clé** : *une pause réelle ne fait jamais avancer ni modifier `RaceEngine`*. Pendant une pause,
`RaceSimulation` **n'appelle simplement pas** `RaceEngine.step()`. Il n'existe aucun état de pause dans
le noyau, aucune notion de « temps restant de pause », aucun compteur réel.

Conséquences vérifiables :

* `tSim`, `x` et `v` sont **strictement gelés** pendant une pause.
* Aucune neutralisation, aucun rattrapage, aucun repositionnement pendant une pause.
* Le nombre total de pas d'une course est **toujours** `TOTAL_STEPS = 3600`, qu'il y ait eu 0, 2 ou
  100 pauses (checkpoint ou utilisateur).
* Le résultat d'une course est identique avec et sans pauses.

**Contrat d'exactitude des bornes.** Le temps simulé doit être dérivé du **numéro de pas** par
multiplication — `tSim = step × DT` — et **jamais** par accumulation (`tSim += DT`). Avec la
multiplication, `1200 × DT`, `2400 × DT` et `3600 × DT` valent **exactement** `20`, `40` et `60` : les
instants de checkpoint et la fin de course tombent donc pile sur un pas, et `track.ts` peut comparer
sans la moindre tolérance. En accumulant, on obtient `19.999999999999436` au pas 1200 et
`60.000000000011797` au pas 3600 — les checkpoints seraient manqués. Cette propriété est verrouillée
par les tests de `config.ts` et `track.ts`.

### 4.3 Déroulement

1. Le MJ clique « Lancer ». `RaceSimulation` gère le compte à rebours réel, puis démarre la boucle.
2. `SEGMENT k` dure exactement `20 s` de **temps simulé**, soit `1200` pas.
3. À la fin des segments 1 et 2 (soit à `tSim = 20` puis `40 s`), `RaceEngine` atteint l'instant de
   checkpoint : il émet un fait `CHECKPOINT_SPLIT` et **continue** d'être prêt à avancer. C'est
   `RaceSimulation` qui cesse d'appeler `step()` pendant `3 s` réelles.
4. La reprise est **automatique** après la pause. Aucune action du MJ n'est requise.
5. À `tSim = 60 s`, `RaceEngine` passe à `finished` et **plus aucun pas n'est exécuté**. Le classement
   final est calculé sur les distances gelées à cet instant.
6. Le MJ peut mettre en pause manuellement (`Espace`) à tout moment : `RaceSimulation` arrête
   d'appeler `step()`, puis reprend. Le nombre de pas reste identique, donc le résultat aussi.
   Pendant cette pause, le MJ peut **revoir** la course déjà jouée (passe corrective 2, §5.2) : la
   relecture est purement visuelle, bornée à l'instant réel de la pause, et la reprise repart de cet
   instant — jamais de l'instant consulté.
7. Le redémarrage relance une course **depuis zéro** avec la même seed (rejeu identique) ou une
   nouvelle seed.

### 4.4 Checkpoints

* Les checkpoints sont des **instants de temps simulé** : `tSim = 20` et `40 s`. Ils ne sont **pas**
  des positions, ni des distances, ni des conditions de fin de segment (la fin d'un segment est
  toujours `20 s` de temps simulé, quoi qu'il arrive).
* Le mot employé face au joueur est **`Checkpoint`** (`Checkpoint 1 · 20 s`). Le mot `Pointage`,
  employé avant la passe corrective, a été retiré : le premier test joueur manuel l'a jugé peu naturel.
  Les noms techniques internes (`CHECKPOINT_SPLIT`, `checkpointPause`, `checkpoint()`) restent, eux,
  inchangés.
* À chaque checkpoint, on fige un « split » (distances + classement + écarts) pour l'affichage et le
  speaker. Aucun point, aucun bonus, aucune pénalité n'est attribué. L'affichage du checkpoint est un
  retour **bref et léger** (bandeau du leader figé), pas un tableau permanent.
* `classement final = classement par distance décroissante à tSim = 60 s`. Les splits de checkpoint
  n'influencent **jamais** le résultat.
* **Repères visuels de distance** (décor : lignes au sol, arche d'arrivée, fanions) : purement
  facultatifs, définis **uniquement** dans `src/render/` (§5), et **jamais** lus par `src/core/` ni
  `src/sim/`. Ils ne conditionnent ni la fin de la course, ni les pauses, ni le classement.

---

## 5. Piste et caméra (règles de PRÉSENTATION uniquement)

Cette section ne définit **aucune** règle de simulation.

* **Échelle nominale d'affichage** : `VIEW.NOMINAL_SCALE_M = SPEED.BASE × RACE.TOTAL_SIM_S = 720 m`.
  C'est la longueur qu'aurait la piste si tout le monde courait exactement à `SPEED.BASE`. Elle sert
  **uniquement** à dimensionner le décor et à donner une échelle lisible. Ce n'est **pas** une ligne
  d'arrivée : un personnage peut parfaitement la dépasser (turbo) ou ne jamais l'atteindre, et cela ne
  change rien à la fin de la course.
* Écart typique attendu entre le 1er et le 6e à `tSim = 60 s` : **93 m** (médiane mesurée sur 1000
  seeds), 5e percentile 45,8 m, 95e percentile 166,2 m, extrêmes observés de 15,5 m à 291 m.
* Vue principale : caméra latérale qui suit le **peloton** avec fenêtre adaptative, **bornée à 260 m
  de large** ; au-delà, les personnages hors fenêtre sont signalés par un marqueur de bord.
* **Mini-carte : retirée du HUD par la passe corrective.** Le premier test joueur manuel a jugé que le
  HUD masquait trop la course ; la mini-carte était l'un des blocs permanents les plus coûteux en
  surface. Le modèle qui la calcule (`markers`, `minimap.ts`, `VIEW.NOMINAL_SCALE_M`) est **conservé**
  comme hook de test et de debug — il est encore vérifié par les tests unitaires et E2E — mais plus
  aucun élément DOM ne le dessine. La réintroduction éventuelle d'une carte appartient à P014.
* Le rendu est **lecture seule** : il ne modifie jamais `x`, `v` ni le classement.
* **Retour visuel des bonus et malus (passe corrective)** : un événement actif affiche un libellé
  court (`TURBO !`, `CHUTE !`…) **attaché au personnage concerné**, avec son sens (`BONUS !` /
  `MALUS !`) et une couleur. Ce retour est **temporaire** (il disparaît avec l'événement), **multiple**
  (plusieurs personnages peuvent en porter un en même temps), **non obscurcissant** (il est posé
  au-dessus du sprite, sans capturer les clics) et **purement dérivé** des événements réels du noyau :
  il ne crée, ne modifie et ne consomme rien. La direction artistique définitive (icônes, halo,
  particules) appartient à P014.
* **Après `FINISHED` (P013)** : le noyau ne fait **plus aucun pas**. Le rendu peut encore animer, mais
  uniquement des coordonnées **dérivées** de l'instantané final (`x` et `v` figés à `tSim = 60 s`).
  La courte décélération visuelle ajoute un décalage d'inertie **identique pour les six marcheurs**,
  purement décoratif : elle ne peut donc pas modifier l'ordre du classement figé, ne touche ni `tSim`,
  ni le compteur de pas, ni le RNG, et ne consomme aucun temps simulé.
* **Classement final et podium** : présentés à partir du classement du noyau à `tSim = 60 s`
  (`leaderboardOf` / `core/ranking.ts`), avec position, nom, distance finale et écart au vainqueur.
  Aucune ligne d'arrivée dessinée, aucune coordonnée de décor, aucune position de sprite ou d'écran
  n'est jamais un critère de victoire : le podium **présente**, il ne décide pas.
* **`PHOTO_FINISH`** : la mention n'apparaît que si le fait d'arrivée produit par l'observateur est
  réellement `PHOTO_FINISH`. Le rendu ne recalcule aucun seuil.

### 5.1 Direction artistique cible (consignée, **non implémentée**)

La présentation finale visée est une **retransmission de course 3D humoristique** : piste et
environnement en volume, personnages modèles animés, événements visuels absurdes, caméra de type
télévision / prise de vue hippique, **changements de caméra sur les moments importants**, et
profondeur de perspective exploitée pour rendre les dépassements spectaculaires. Le classement, les
paris et le HUD peuvent rester en **HTML/2D** au-dessus de la scène.

**Inspiration de mise en scène, jamais de contenu.** L'esprit visé est celui d'une retransmission de
course absurde (référence citée par l'utilisateur : « Japan World Cup »). C'est une inspiration de
**structure et de ton** : aucun personnage, asset, modèle, animation, texte ou élément protégé de
cette référence ne doit être reproduit. Chaos Race doit avoir son **identité propre**.

**Règle structurante — la 3D n'est jamais la simulation.**

* `RaceEngine` reste l'**unique source de vérité** et continue de produire `x`, `v`, le drift, le
  classement, les événements et la seed déterministe, par pas fixes de `DT_S`.
* Le renderer 3D se contente de **transformer la distance `x` en position sur une piste / courbe
  3D**, exactement comme le renderer 2D transforme aujourd'hui `x` en position écran.
* Aucune physique 3D ne décide **jamais** du vainqueur, des vitesses, des dépassements, ni d'un
  événement de gameplay. Aucun moteur physique, aucune collision, aucune interpolation ne peut
  modifier `x`.
* Les invariants de `AGENTS.md` §5 restent intégralement applicables : pas de téléportation, pas de
  rubber-banding, fin de course à `tSim = 60 s`, reproductibilité `(seed, config)`, et
  `src/core/**` continue de n'importer **rien** hors de `core/`.
* Changer de renderer ne doit **jamais** changer le résultat d'une course : la neutralité du rendu
  est déjà testée (le rendu n'écrit rien dans l'état) et devra le rester.

Tant que le **Jalon 3D** de `ROADMAP.md` (P013.5) n'a pas tranché, **aucune dépendance 3D n'est
installée** et le rendu reste le **2D actuel** (Phaser, avec les illustrations des six personnages).

### 5.2 HUD, retour d'événement, commentaire, son et voix (passe corrective)

Ces règles sont **de présentation**. Elles ne définissent aucune règle de simulation et découlent du
premier test joueur manuel après P013, qui a relevé un HUD trop envahissant, un speaker qui masquait
l'action, un retour visuel imperceptible pour les bonus/malus, des nombres bruts illisibles, des
libellés peu clairs et une voix trop lente.

**Lecture de l'écran — la piste d'abord.** Le HUD n'occupe que des zones **périphériques et basses**
de l'arène ; la piste doit rester largement visible. Il contient :

* les commandes (Lancer / Pause / Rejouer), le chrono et l'indicateur de segment (`1/3`, `2/3`, `3/3`,
  et **`Terminé`** une fois la course finie : le noyau n'a que trois segments, il n'existe donc aucun
  « segment 0/3 ») ;
* les réglages, réduits à deux pastilles compactes (voir plus bas) ;
* le **classement complet** des 6 personnages, dans une **bande latérale réservée**, avec l'écart en
  secondes ;
* la seed, discrète et copiable ;
* la bande de commentaire (voir plus bas) et les retours d'événement (voir plus bas).

Ce qui a été **retiré** parce qu'il masquait la course : la **mini-carte** permanente (son modèle reste
un hook de test) et tout affichage permanent du classement détaillé ailleurs qu'au podium. Le
classement final complet est présenté **au podium**, à l'arrivée.

**Le classement permanent ne recouvre jamais la piste (passe corrective 2).** Le second test joueur
manuel a montré que le panneau, posé *sur* l'arène, cachait les personnages et leurs noms. La piste
est donc dessinée dans une zone qui **exclut** la bande du classement : le rendu réserve
`VIEW.TRACK_WIDTH_RATIO = 0.78` de la largeur de l'arène, et le classement vit dans les 22 % restants.
Un personnage sorti du champ est **masqué** — son marqueur de bord, lui, reste dans la piste — plutôt
que dessiné sous le panneau. En **téléphone paysage** (hauteur ≤
`VIEW.COMPACT_VIEWPORT_MAX_HEIGHT_PX = 560`), la bande réservée devient une **colonne HTML à droite de
la piste** (voir « Disposition téléphone paysage ») : le classement y reste **affiché pendant la
course**, la piste occupant toute la zone de gauche. La vérification est **géométrique** : à plusieurs
instants de la course, et en 1280×720, 1920×1080, 844×390 et 926×428, aucun personnage dessiné ne
croise le rectangle du classement — une fraction de surface ne prouverait rien de la position.

**Disposition téléphone paysage (passe responsive issue du test sur iPhone).** Le premier essai sur un
vrai téléphone a montré une interface trop petite : l'en-tête, les marges extérieures et une arène en
16:9 centrée laissaient ≈ 150 px de vide de chaque côté, et le classement était masqué faute de place.
La disposition compacte est donc devenue, pour la même course :

* **titre et sous-titre masqués** : ils ne servent à rien pendant une partie et coûtaient la hauteur
  qui manquait aux voies ;
* **aucune marge extérieure** : l'arène occupe l'écran entier et la piste commence au bord gauche ;
* **une seule zone réservée**, la colonne de droite (`--hud-mobile-column`, 32 % de la largeur), qui
  porte de haut en bas : la **ligne d'état** (état · segment · chrono · son · commentateur, sur une
  seule ligne), le badge de checkpoint, le **classement**, l'écran d'arrivée, le **speaker**, la seed
  (avec un bouton **`Persos`** à sa droite), puis les **commandes** (`Lancer` · `Pause` · `Rejouer`
  sur **une seule rangée**, ~35 px de haut chacune) ;
* **la piste n'a plus aucun HUD textuel superposé** : les badges d'événement restent la seule
  surimpression, et ils sont attachés aux personnages ;
* **les personnages grandissent** : la hauteur récupérée revient aux voies, qui s'étendent
  (`COMPACT_LANE_TOP_RATIO` / `COMPACT_LANE_BOTTOM_RATIO`), et le rendu passe de la taille de bureau
  (`CHARACTER_HEIGHT_PX`) à `CHARACTER_HEIGHT_COMPACT_PX = 106` px logiques (police du nom
  `CHARACTER_NAME_FONT_COMPACT_PX = 20`) — la plus grande valeur de la fourchette demandée qui laisse
  une séparation visible entre silhouettes voisines (≥ 10 px logiques, marges transparentes des images
  comprises).

Deux précisions issues de la micro-correction suivante. La **seed n'est affichée qu'une fois** : son
ancien doublon déclaré dans `index.html` a été supprimé, le HUD (dans la colonne) en est le seul
porteur, sur tous les formats. Et **aucune place n'est réservée à une barre de relecture absente** : la
hauteur de la barre n'est ajoutée à la colonne que pendant une pause manuelle (`:has`), et le reste du
temps l'espace libre de la colonne se trouve juste au-dessus des commandes — c'est précisément la place
que la barre occupe quand on met Pause. Le bouton **`Persos`** ouvre enfin un panneau qui montre les six
personnages **en grand**, avec leur nom, en réutilisant les images déjà servies au rendu : c'est une
surcouche d'interface pure, sans aucun effet sur la course (elle ne connaît ni la simulation, ni le
speaker, ni la relecture).

**Textes attachés aux personnages, dans les deux formats.** Le **nom** et les mots d'événement
(`TURBO !`, `BONUS !`, `MALUS !`) ne sont posés **au-dessus** d'aucun sprite : ils vivent **dans la
voie**, sur l'axe du personnage, et **derrière lui au sens de la course** — c'est-à-dire à sa
**gauche**, puisque la course va de gauche à droite (`characterNameX`, `characterNameY`,
`CHARACTER_NAME_GAP_PX`). « Derrière » ne veut donc **pas** dire sous l'image : le texte s'arrête avant
le début du sprite, n'est **jamais** recouvert par lui, et n'a pour cette raison aucun contour à
porter — aucun mélange de texte sous le sprite n'est utilisé. La règle est **la même sur bureau et en
petit paysage** ; seules les tailles changent (`CHARACTER_HEIGHT_PX = 92` contre
`CHARACTER_HEIGHT_COMPACT_PX = 106`, polices `CHARACTER_NAME_FONT_PX = 16` contre
`CHARACTER_NAME_FONT_COMPACT_PX = 20`). La conséquence est celle qui était recherchée : plus aucun
texte ne consomme de hauteur au-dessus d'un sprite, donc les personnages peuvent grandir sans que les
voies se rapprochent. Les mots d'événement, eux, restent dans la couche DOM du HUD (comme le reste du
HUD) : ils sont recentrés sur l'axe de la voie et reculés de la **demi-largeur réelle du sprite** plus
une petite marge (`EVENT_BADGE_GAP_PX`), sans jamais fusionner avec l'image. Le recul est calculé en
pixels CSS, jamais en pourcentage : il reste donc exact à toutes les échelles de canvas.

**Timeline de pause, en petit paysage.** La barre de relecture est **remontée** du bord bas de l'écran
(marge de sécurité de `0.6rem` en plus de `env(safe-area-inset-bottom)`), et sa **zone tactile fait
30 px de haut** alors que la piste visible reste fine (4 px) : le curseur natif de Safari, haut de
~16 px et collé au bord, n'était pas attrapable au doigt. Le dessin du curseur est redéfini pour
WebKit et pour Gecko, uniquement dans la requête média compacte.

Techniquement, la piste n'a plus le rapport 16:9 de l'arène de bureau : la **largeur logique du canvas**
est donc déduite du rapport réel de la piste (`viewport.arenaBaseSize`), pour que le canvas et la
colonne du HUD coïncident au pixel — sans quoi les badges d'événement, posés en pourcentage de la
piste, seraient décalés. La **hauteur logique reste 720** : toute la géométrie verticale garde son sens,
et seule la correspondance mètres → pixels change, comme elle le fait déjà à chaque cadrage. Rien de
tout cela ne touche la simulation : ce sont des décisions de **présentation**, prises dans `render/` et
`styles.css`.

**Visuels des personnages (passe visuelle).** Les six coureurs ne sont plus des formes géométriques
provisoires : chacun affiche son **illustration** (`public/assets/characters/`, une par personnage,
associée par `src/render/characterAssets.ts` — la seule table du projet qui connaît un chemin
d'asset). Le rendu ne choisit qu'une **hauteur** (`VIEW.CHARACTER_HEIGHT_PX = 92` sur bureau,
`VIEW.CHARACTER_HEIGHT_COMPACT_PX = 106` en petit paysage) et déduit la largeur du ratio de l'image :
une image n'est donc **jamais** écrasée en carré, et la résolution du fichier n'est jamais une taille
d'affichage. Les fichiers servis font 320 px de haut (copies runtime produites par
`tools/optimizeCharacterAssets.mjs`, ≈ 0,75 Mio au total), les originaux fournis (~1448×1086,
~6,2 Mio) restant **intacts** hors du dépôt : c'est ce qui garde de la marge pour les écrans à haute
densité tout en respectant le budget de ressources d'`AGENTS.md` §3.6. Le nom partage l'axe du
personnage et s'arrête juste avant lui, à sa gauche, dans les deux formats (voir plus haut) ; il est
donc positionné à partir de la **largeur** réellement affichée du sprite et de la voie, jamais d'une
hauteur de texte supposée. La visibilité (`setDrawn`) est calculée sur la **taille réellement
dessinée** : les illustrations étant plus larges que hautes, un personnage qui ne tient pas entièrement
dans la piste est masqué au profit de son marqueur de bord.

**Relecture pendant une pause manuelle (passe corrective 2).** Pendant une pause du MJ, une petite
barre apparaît sous les commandes : `−2 s`, une barre de temps, `+2 s`, et une lecture
`38,4 s / 52,4 s` (instant consulté / instant réel de la pause). En téléphone paysage, cette barre
tient dans la colonne de droite, sur une ligne (son titre disparaît, les libellés `−2 s` / `+2 s`
portant déjà le contexte), et la place qu'elle occupe est **réservée** tant qu'elle est affichée, pour
qu'elle ne recouvre ni la seed ni le speaker. Le curseur est **borné** à
`[0, instant de pause]` : on ne remonte jamais avant le départ, et on n'avance jamais au-delà de ce
qui a réellement été joué. La relecture est **purement visuelle** : `RaceEngine` ne recule jamais,
aucun pas n'est exécuté, aucun fait n'est produit, aucun tirage n'a lieu, et la relecture est
**muette** — aucune ancienne réplique n'est remise dans la file du speaker. Le chrono, le classement,
les positions, le segment et les retours d'événement décrivent l'instant **consulté** ; le panneau de
debug, lui, continue de décrire l'état réel du noyau. « Reprendre » repart de l'**instant réel de la
pause**, sans recalcul : une course relue puis reprise se termine **exactement** comme la même seed
jouée sans relecture (distances finales identiques bit à bit, `3600` pas, même classement).

Ce que la relecture garde en mémoire est **minimal et borné** : la distance des 6 personnages à chaque
pas (`3601 × 6` nombres, `172,8 Ko` dans un `Float64Array` alloué une fois) et les événements rares
sous forme d'**intervalles** de pas (quelques centaines d'octets). Tout le reste — `tSim`, segment,
classement, écarts — se **déduit** de l'index de pas par les fonctions du noyau. Aucun sprite, aucun
objet Phaser, aucun élément DOM n'est conservé : moins de `200 Ko` au total, pour un maximum de
`3601` instants (les `3600` pas plus le départ).

**Checkpoint = retour bref, jamais un tableau.** À chaque checkpoint, l'écran affiche un **bandeau
temporaire** portant le numéro et l'instant atteint (`Checkpoint 1 · 20 s`) ainsi que le **leader figé**
du split. Ce n'est ni un tableau à six lignes, ni un panneau permanent : le bandeau apparaît puis
disparaît, et rien n'est attribué (aucun point, aucun bonus, aucune pénalité — §4.4). Le mot affiché
est **`Checkpoint`** ; `Pointage` a été retiré du vocabulaire visible.

**Commentaire = sous-titre de retransmission.** La réplique du speaker s'affiche dans une **bande
compacte** placée dans une zone **basse et non critique** de l'arène : largeur et hauteur bornées, deux
lignes au maximum, texte lisible. Elle porte le **nom du personnage** concerné quand le fait en
désigne un. Elle ne crée **aucune** file d'attente : la bande affiche la réplique réelle du speaker
(§9), et une nouvelle réplique **remplace** la précédente. Les textes restent ceux du speaker — le
rendu ne compose ni ne réécrit aucun commentaire.

**Bonus et malus = retour attaché au personnage.** Un événement actif affiche, **dans la voie du
personnage concerné, sur son axe et derrière lui** (voir « Textes attachés aux personnages »), et
uniquement pendant sa durée, un libellé court (`TURBO !`, `CHUTE !`, …) et son sens (`BONUS !` /
`MALUS !`) avec une couleur distincte. Plusieurs personnages peuvent en porter un en même temps, aucun
retour ne capture les clics, et **tout provient des événements réels du noyau** : le retour ne crée, ne
modifie et ne consomme rien (aucun tirage, aucune constante).

**Passe de finition de la version 2D (fin de P013).** Cette passe n'a **rien** changé aux règles : ni
probabilité, ni modèle de vitesse, ni surge, ni événement, ni tirage, ni nombre de pas, ni durée, ni
checkpoint, ni classement, ni speaker. Tout ce qui suit est de la **présentation**, de la **lecture** ou
de l'**historique de résultats déjà calculés**.

* **Géométrie de bureau.** Les voies s'étendent (`LANE_TOP_RATIO = 0,20`, `LANE_BOTTOM_RATIO = 0,90`)
  et les personnages passent de `73` à **`92` px logiques** : la plus grande taille propre qui tient
  dans les six voies en **1280×720** comme en **1920×1080**, sans recouvrement gênant, sans sprite sous
  la colonne du HUD et sans sortir du canvas. La marge noire apparente entre voies est réduite au profit
  des personnages ; la séparation **visible** entre deux silhouettes voisines (marges transparentes des
  images comprises) reste ≥ 10 px logiques, et le test de géométrie le vérifie. Aucun PNG source n'a été
  modifié : seule la **hauteur d'affichage** change, comme toujours.
* **Retour d'événement, sur bureau aussi.** Les mots d'événement suivent désormais la **même règle**
  qu'en petit paysage : dans la voie, sur l'axe du personnage, **derrière lui** (à sa gauche), sans
  jamais recouvrir l'image. Leur **durée et leur logique sont inchangées** : ils apparaissent et
  disparaissent exactement avec l'événement du noyau, et leur contenu reste celui des libellés.
* **Historique des passages en tête, sur l'écran d'arrivée.** Une section `Passages en tête` liste les
  bornes de la course : `Checkpoint 1 · 20 s`, `Checkpoint 2 · 40 s`, puis `Arrivée · 60 s`, chacune avec
  le **leader réellement observé** à cet instant. Il n'existe **pas** de « Checkpoint 3 » : la troisième
  borne est l'arrivée, et son leader est le vainqueur du classement final. Les valeurs proviennent
  **exclusivement** d'états réellement observés : le rendu note le premier du classement du noyau au
  moment de chaque checkpoint (`PassageRecorder`), et **ne recalcule rien** à partir des sprites. Le
  classement existant reste l'**unique source de vérité** : aucun second moteur de classement n'a été
  créé, l'enregistreur ne fait que lire `leaderboardOf(state)` et mémoriser un identifiant, un nom et un
  instant. Un rejeu, un redémarrage ou un changement de seed repart d'un historique vide.
* **`Rejouer` (bouton principal) tire une nouvelle seed.** Un clic **tire immédiatement une nouvelle
  seed**, met l'URL à jour, remet la simulation et le commentaire à zéro, et **relance la course** — par
  le mécanisme existant, sans second générateur de seed. Le bouton explicite de l'écran d'arrivée
  (`Rejouer la même seed`) garde son sens : même seed, donc même course, bit à bit.
* **Effets visuels d'événement, purement visuels.** Un **bonus** ajoute un léger halo derrière le
  personnage (et une pulsation discrète) ; un **malus** le teinte légèrement (sombre/rougeâtre) et
  laisse une petite traînée sombre vers l'arrière. Ces effets se contentent de **lire** `activeEvent` et
  la magnitude : ils ne déplacent **pas** le personnage, ne changent **pas** sa vitesse, ne tirent
  **aucun** nombre aléatoire et n'écrivent jamais `x` ni `v`. Aucune bibliothèque d'effets n'a été
  ajoutée. La preuve est faite par les tests : les distances et le classement finaux d'une seed sont
  **identiques** à ceux du noyau seul, effets et badges compris.
* **`Persos` en paysage de téléphone.** Le panneau des six personnages tient **entièrement** dans
  l'écran (844×390 comme 926×428) : la grille 3 × 2 reste, les six cartes et les six noms sont visibles,
  le bouton `Fermer` est utilisable, et aucun défilement n'est nécessaire. La hauteur suit la zone
  **réellement visible** (`100dvh`, avec `100vh` en secours) et les marges de sécurité
  (`env(safe-area-inset-*)`) sont ajoutées au rembourrage. La cause de la coupure était une rangée de
  grille **automatique** : elle se dimensionnait sur la hauteur minimale du panneau — six images — et
  dépassait donc l'écran même quand le panneau, lui, était correct. La rangée est maintenant définie
  (`minmax(0, 1fr)`), et l'en-tête, les rembourrages et les écarts sont légèrement resserrés en petit
  paysage avant de réduire les images.
* **Écran d'arrivée et Dynamic Island.** En paysage de téléphone, l'écran final est le **seul** bloc du
  HUD qui traverse toute la largeur de l'écran (`grid-column: 1 / -1`) : sans marge, son classement
  final, ses passages en tête ou ses boutons pouvaient passer sous la Dynamic Island. La zone protégée
  d'iOS se trouve sur l'un des deux **bords courts**, à gauche ou à droite selon le sens de rotation :
  les deux côtés sont donc protégés, en ajoutant `env(safe-area-inset-left)` et
  `env(safe-area-inset-right)` au rembourrage **intérieur** du panneau d'arrivée, et **seulement** là.
  La piste, le classement en course, la ligne d'état, les commandes, la timeline et la galerie gardent
  exactement leur géométrie : le test mesure la piste et les commandes avant et après l'arrivée et
  exige qu'elles soient **identiques au pixel**. `viewport-fit=cover` était déjà présent dans le
  viewport et n'a pas été modifié. La preuve est faite en imposant une vraie zone protégée
  (`Emulation.setSafeAreaInsetsOverride`, 59 px de chaque côté) à 844×390 et 926×428 : titre,
  six lignes de classement, passages et boutons restent tous à l'intérieur.
* **Repère d'échelle retiré.** L'**échelle nominale** affichée sur la piste a été supprimée : elle
  ressemblait à une ligne d'arrivée et induisait en erreur, alors que la course se termine **par le
  temps** (§5, invariant 3). Le repère n'a **pas** été renommé `Arrivée` — ce serait faux — et la
  logique d'arrivée n'a pas été touchée : la course se termine toujours à `tSim = 60 s`, sans aucune
  condition de distance. Les graduations de décor restent, elles ne sont lues par personne.

**Son et commentaire — deux réglages explicites.** Les commandes s'appellent **`Son`** et
**`Commentateur`**, chacune avec un état explicite (`activé` / `coupé`), à la place des anciens
`Muet` / `Voix` jugés ambigus. Le choix est **persisté** dans le navigateur, et une valeur corrompue ou
absente ne doit **jamais** faire échouer le démarrage. Comme tout l'audio de la V1, les deux réglages
sont **désactivés par défaut**.

* **Activer le son** joue un **court klaxon** de confirmation, synthétisé par l'API Web Audio du
  navigateur (aucun fichier, aucune dépendance, aucun appel réseau), **directement dans le clic** pour
  respecter la politique d'autoplay. **Désactiver le son ne joue rien.**
* **Activer le commentateur** prononce une confirmation très courte (`Let's go!`) via la synthèse
  vocale locale. Cette confirmation est liée à l'**action du joueur** : elle n'est **jamais** jouée au
  chargement, **jamais** à la désactivation, ne passe **pas** par le speaker (aucun `RaceFact`, aucune
  file, aucun cooldown) et n'a **aucun effet** sur la simulation.
* Le système audio complet (musique, ambiance, mixage) reste hors périmètre : il appartient à P015.

**Voix plus rapide.** Le débit de la synthèse vocale est porté par une **constante de présentation
centralisée** (`TTS_RATE = 1.6`, soit 1,6× le débit nominal), mesurée comme nettement plus confortable
par le test joueur sur une voix française. La voix ne peut **jamais** influencer la simulation, la
seed, le RNG ni l'horloge : elle ne fait que vocaliser un texte déjà choisi par le speaker.

**Nombres lisibles.** Aucun texte affiché au joueur ne montre une valeur brute de la simulation. Un
module unique de présentation (`src/render/format.ts`) décide de la mise en forme, par **nature** de la
grandeur :

| Grandeur | Règle | Avant | Après |
| --- | --- | --- | --- |
| Pourcentage | entier | `35.9333333333 %` | `36 %` |
| Durée, chrono | entier de secondes | `6.1333333333 s` | `6 s` |
| Distance | 1 décimale | `26.033333333333 m` | `26,0 m` |
| Comptage (places, événements) | entier | `3.0000000000000004` | `3` |

Une **valeur de simulation n'est jamais arrondie** pour autant : l'arrondi n'existe qu'au moment de
l'affichage, et les valeurs brutes restent disponibles pour les tests et le debug. L'audit couvre
**tous** les gabarits de texte du speaker, et la virgule décimale française est respectée.

**Durée d'affichage du commentaire.** `VIEW.SUBTITLE_MIN_MS = 800`,
`VIEW.SUBTITLE_PER_CHAR_MS = 60` et `VIEW.SUBTITLE_MAX_MS = 5800` bornent la durée **réelle**
d'affichage d'une réplique (mesurée : vitesse de lecture ≤ 20 caractères/s, catalogue de 40 à 110
caractères, et `SUBTITLE_MAX_MS` strictement inférieur au cooldown global du speaker). C'est une règle
**d'affichage** uniquement : elle ne touche ni les cooldowns, ni les faits, ni la simulation.

---

## 6. Modèle de vitesse

La vitesse instantanée d'un personnage `i` est la somme bornée de composantes, puis **intégrée** :

```
v_cible_i(t) = SPEED.BASE × (1 + drift_i(t) + surge_i(t) + event_i(t))
v_i(t)       = approche(v_i(t-1), v_cible_i(t), MAX_ACCEL, MAX_DECEL, DT)   // rampe progressive
v_i(t)       = clamp(v_i(t), SPEED.MIN, SPEED.MAX)
x_i(t)       = x_i(t-1) + v_i(t) × DT
```

### 6.1 Constantes de vitesse

| Constante | Valeur | Rôle |
| --- | --- | --- |
| `SPEED.BASE` | `12.0 m/s` | vitesse moyenne, **identique pour les 6** |
| `SPEED.MIN` | `3.0 m/s` (0,25 × base) | plancher : on ne s'arrête jamais net |
| `SPEED.MAX` | `48.0 m/s` (4,0 × base) | plafond dur (marge nécessaire pour `MEGA_TURBO`) |
| `SPEED.MAX_ACCEL` | `10.0 m/s²` | rampe de **montée** maximale |
| `SPEED.MAX_DECEL` | `12.0 m/s²` | rampe de **descente** maximale |

### 6.2 Invariant « progressivité » (directionnel)

La fonction `approche(currentV, targetV, MAX_ACCEL, MAX_DECEL, DT)` applique **deux limites
distinctes**, une par direction :

```
si targetV >= currentV :   v = min(targetV, currentV + MAX_ACCEL × DT)
si targetV <  currentV :   v = max(targetV, currentV - MAX_DECEL × DT)
```

Autrement dit, à chaque pas :

```
Δv = v(t) − v(t−1)
si Δv >= 0 :   Δv <= MAX_ACCEL × DT        // montée bornée par 10 m/s²
si Δv <  0 :  −Δv <= MAX_DECEL × DT        // descente bornée par 12 m/s²
```

> **Formulation interdite** (elle était fausse et ne doit apparaître ni dans le code ni dans un test) :
> `|Δv| <= MAX_ACCEL × DT` appliqué aux deux directions. Cela sous-estime la vitesse de descente
> autorisée (12 m/s²) et rendrait les ralentissements et les fins de bonus artificiellement mous.

Conséquences :

* Aucun changement de vitesse instantané, **y compris pour les gros événements**. Une décélération est
  légèrement plus franche qu'une accélération (`12` vs `10 m/s²`).
* Durées de rampe : `t_rampe = Δv / (MAX_ACCEL ou MAX_DECEL)`.
  Exemples : `TURBO` (Δv de `14,4` à `21,6 m/s`) ⇒ `1,44 – 2,16 s` à la montée, `1,20 – 1,80 s` à la
  descente. `MEGA_TURBO` (Δv `30 m/s`) ⇒ `3,0 s` à la montée, `2,5 s` à la descente.
* Le fait que la montée soit bornée est **intégré au design des événements** : les durées du §7.1 sont
  choisies pour que la rampe ait le temps de s'achever avant la fin de l'événement.

### 6.3 Dérive permanente (processus d'Ornstein–Uhlenbeck)

Petite variation **permanente** de vitesse, propre à chaque personnage, pour provoquer naturellement
rapprochements et dépassements :

```
drift_i(t) = drift_i(t−1) + (−THETA × drift_i(t−1) × DT) + SIGMA × √DT × gauss_i(t)
drift_i(t) = clamp(drift_i(t), −CLAMP, +CLAMP)
drift_i(0) = 0  pour les 6
```

| Constante | Valeur |
| --- | --- |
| `DRIFT.THETA` | `0.25 /s` (rappel vers 0) |
| `DRIFT.SIGMA` | `0.09 /√s` |
| `DRIFT.CLAMP` | `0.20` (±20 %) |
| `DRIFT.STATIONARY_SD` | `≈ 0.127` (dérivée : `SIGMA / √(2·THETA)`) |

Le bruit `gauss_i(t)` est une **approximation gaussienne déterministe** — somme de 12 tirages
uniformes, sans aucune fonction transcendante — et **non** Box-Muller : voir §10.3. C'est ce qui rend
le drift reproductible bit à bit d'un moteur JavaScript à l'autre.

> **Constat de mesure (P004).** `DRIFT.STATIONARY_SD` est l'écart-type stationnaire du processus
> **sans écrêtage**. Or avec `CLAMP = 0,20`, l'écrêtage coupe à `0,20 / 0,127 ≈ 1,57 σ` : ce n'est
> donc pas un filet de sécurité lointain, il participe réellement à la dynamique et resserre la
> distribution. L'écart-type **effectif** du drift vaut ainsi `≈ 0,100` (mesuré sur 2 160 000
> tirages : 6 personnages × 12 seeds × 30 000 pas), et non `0,127`. Le drift reste centré et borné à
> ±20 % comme spécifié ; il est simplement plus resserré que ne le suggère la valeur théorique. Si
> l'on veut un drift effectivement proche de ±13 %, il faut élargir `CLAMP` — `0,5` redonne `0,1272`,
> soit la valeur théorique à 0,1 % près. C'est une **décision de game design**, pas une conséquence
> de l'implémentation : aucune constante de ce tableau n'est modifiée par P004.

Pourquoi OU et pas une marche aléatoire : le rappel vers 0 garantit que **la vitesse moyenne de chaque
personnage reste `SPEED.BASE`** (personnages équivalents, aucun trait permanent) tout en créant une
variance locale qui fait que **le leader peut toujours être rattrapé**, sans jamais tirer un
personnage vers un autre. Aucun couplage entre personnages : les `drift_i` sont indépendants.

C'est cette dérive seule — active dès le premier pas, progressive par construction — qui produit les
premiers dépassements naturels, avant même l'ajout des surges et des événements.

### 6.4 Surges (petites accélérations / ralentissements occasionnels)

Par personnage, indépendant, via un flux aléatoire dédié :

| Constante | Valeur |
| --- | --- |
| `SURGE.INTERVAL_MEAN_S` | `9.0` |
| `SURGE.INTERVAL_MIN_S` | `4.0` |
| `SURGE.DURATION_MIN/MAX_S` | `1.5` / `4.0` |
| `SURGE.MAGNITUDE_MIN/MAX` | `0.10` / `0.35` (accélération) |
| `SURGE.BRAKE_PROBABILITY` | `0.45` |
| `SURGE.MAGNITUDE_BRAKE_MIN/MAX` | `0.10` / `0.30` (ralentissement) |

Un surge est un multiplicateur relatif borné, temporaire, appliqué via la rampe de vitesse
(§6.2). Les surges ne se cumulent pas : un seul surge actif par personnage.

**Intervalle entre deux débuts** *(clarification P007)*. `INTERVAL_MEAN_S = 9 s` est une **moyenne**,
et la loi de tirage est désormais explicite : le temps écoulé entre deux **débuts** de surge d'un
même personnage est **uniforme** sur `[INTERVAL_MIN_S, INTERVAL_MAX_S]`, avec

```
INTERVAL_MAX_S = 2 × INTERVAL_MEAN_S − INTERVAL_MIN_S = 2 × 9 − 4 = 14 s
```

Pour une loi uniforme, la moyenne vaut `(min + max) / 2` : cette borne haute est donc la **seule**
valeur qui donne exactement `INTERVAL_MEAN_S` en moyenne. `14 s` n'est pas une constante de jeu
indépendante — elle est **dérivée** dans le code de `INTERVAL_MEAN_S` et `INTERVAL_MIN_S`, si bien
que modifier l'une des deux fait suivre la borne haute sans rien retoucher ailleurs.

Le premier surge d'une course suit **la même loi** : l'attente initiale est tirée comme les
suivantes, donc le nombre attendu de surges sur `60 s` vaut `60 / 9 ≈ 6,67` — mesuré à **6,17 – 6,23**
selon le personnage sur le corpus canonique de 1000 seeds à 60 s (§13). `SURGE.INTERVAL_MEAN_S = 9 s`
est un **taux** et n'a pas été touché par la passe corrective.

**Quantification en pas** *(clarification P007)*. Le noyau ne connaît que des pas fixes de
`DT_S = 1/60 s` : les tirages sont donc faits en **numéros de pas entiers**, jamais par accumulation
de secondes flottantes, faute de quoi le planning dépendrait des arrondis d'un moteur à l'autre.

| Grandeur | Bornes en secondes | Bornes en pas (`DT_S`) |
| --- | --- | --- |
| Intervalle entre deux débuts | `4,0 – 14,0 s` | `240 – 840` pas |
| Durée d'un surge | `1,5 – 4,0 s` | `90 – 240` pas |

**Convention d'intervalle** *(clarification P007)*. Un surge de `N` pas est actif sur l'intervalle de
pas **semi-ouvert** `[startStep, endStep)`, avec `endStep = startStep + N` : le pas de début **subit**
le surge, le pas de fin ne le subit **plus**. Un surge de `N` pas influence donc exactement `N`
intégrations de vitesse, ni une de plus ni une de moins.

**Non-cumul** *(clarification P007)*. « Un seul surge actif par personnage » n'est pas une
vérification faite après coup : la règle découle de `DURATION_MAX_S ≤ INTERVAL_MIN_S` (ici
`4,0 ≤ 4,0`), c'est-à-dire qu'un surge est toujours terminé quand le suivant commence.
`validateConfig()` refuse désormais une configuration qui romprait cette inégalité.

---

## 7. Événements rares

### 7.1 Catalogue V1

Chaque événement est **uniquement une modulation de vitesse cible** (via `event_i`), jamais un
déplacement direct de `x`. La durée et la magnitude sont tirées dans l'intervalle au moment du
déclenchement.

| id | Nom affiché (FR) | Magnitude relative | Durée `D` (s) | Poids | Effet |
| --- | --- | --- | --- | --- | --- |
| `TURBO` | Fusée ! | `+0.78 .. +1.17` (×1,78 à ×2,17) | `2.5 – 4.0` | 22 | gros bonus |
| `CHUTE` | La gamelle | `−0.55 .. −0.75` (×0,45 à ×0,25) | `2.5 – 5.0` | 20 | gros malus |
| `VENT_DE_FACE` | Vent de face | `−0.30 .. −0.45` | `4.0 – 7.0` | 18 | malus long |
| `RACCOURCI` | Raccourci douteux | `+1.04 .. +1.30` (×2,04 à ×2,30) | `2.5 – 3.5` | 12 | bonus court et violent |
| `POULET` | Le poulet traverse | `−0.20 .. −0.35` | `2.0 – 4.0` | 10 | petit malus comique |
| `SIESTE` | Micro-sieste | `−0.70` (×0,30) | `5.0` | 6 | malus rare et très lourd |
| `MEGA_TURBO` | TURBO LÉGENDAIRE | `+1.63` (×2,63) | `5.0` | 4 | le gros bonus vitrine |

Poids total = `92`. Le tirage est un tirage pondéré **uniforme par poids**.
Vitesses cibles maximales atteintes : `TURBO` `26,0 m/s`, `RACCOURCI` `27,6 m/s`, `MEGA_TURBO`
`31,6 m/s` — toutes sous `SPEED.MAX = 48 m/s`, donc **aucun événement n'est écrasé par le plafond**.

**Neutralité en distance (P010).** Le catalogue **n'est pas** neutre en distance : les événements
**bonus** rapportent globalement plus de distance que les **malus** n'en retirent. **La formule d'un
événement isolé (§7.2) ne suffit pas à déduire la neutralité du catalogue** : `t_rampe` dépend
elle-même de `Δv`, les rampes sont directionnelles (`MAX_ACCEL ≠ MAX_DECEL`), les vitesses sont
écrêtées et les événements interagissent avec la dérive et les surges. **Le signe et l'amplitude du
biais global sont donc établis par la mesure du moteur réel**, pas par le calcul. Les effets en jeu
sont :

* **Magnitudes, durées et poids tels qu'ils sont tirés** dans le catalogue ci-dessus : les couples
  `TURBO`/`CHUTE` (poids 22 et 20) ne se compensent pas exactement, et rien ne garantit que la
  moyenne des magnitudes positives égale celle des négatives ;
* **Rampes** d'accélération et de décélération (`MAX_ACCEL = 10`, `MAX_DECEL = 12`) : chaque
  transition est rognée d'une quantité qui dépend du **signe** de `Δv` et de sa distance à la cible,
  donc le gain net d'un aller-retour n'est pas nul ;
* **Écrêtage** à `SPEED.MIN = 3` et `SPEED.MAX = 48` : un malus qui se compose avec une dérive et un
  surge déjà négatifs voit sa cible passer sous le plancher et retire **moins** de distance que §7.2
  ne l'annonce (une `SIESTE` peut ne retirer qu'une trentaine de mètres), tandis qu'un bonus peut
  buter sur le plafond ;
* **Interactions avec la dynamique existante** (dérive, surges, événements voisins) : ce que mesure
  §7.2 est le gain **d'un événement isolé**, `drift = surge = 0`, pas le net d'un catalogue complet
  sur 60 s.

Mesuré sur 100 seeds, le tableau d'origine (bonus `+1.20 .. +2.50`) ajoutait `+0,90 %` de distance
moyenne à lui seul. Les magnitudes de **bonus** ont donc été réduites de 35 % (`× 0,65`) ; les
**malus** sont inchangés, faute de raison mesurée de les aggraver. La **formule de gain avec rampe du
§7.2 reste la référence** pour le gain d'un événement isolé ; elle ne prédit pas le net d'un
catalogue.

Le facteur `× 0,65` vient d'un **balayage sur 300 seeds**, à `RATE_PER_S = 1/14` (table du §7.3) :
c'est **le plus grand facteur conforme parmi les valeurs testées**, celles qui ramènent le biais sous
`±1,5 %`.

| Facteur sur les bonus | Biais de vitesse maximal (300 seeds) |
| --- | --- |
| `× 1,00` (catalogue d'origine) | `2,190 %` — **hors plage** |
| `× 0,85` | `1,871 %` — hors plage |
| `× 0,75` | `1,659 %` — hors plage |
| **`× 0,65`** | **`1,444 %`** — conforme, facteur retenu |
| `× 0,55` | `1,225 %` |
| `× 0,50` | `1,115 %` |

Le balayage est **discret** : aucun facteur intermédiaire (par exemple `× 0,70`) n'a été mesuré, donc
`× 0,65` n'est pas démontré **minimal au sens mathématique** — c'est le plus grand facteur **testé**
qui soit conforme. La marge est **mince** (0,056 point sur le corpus réduit), et c'est le corpus
canonique de 1000 seeds qui tranche : **`1,277 %` à 60 s** — voir `docs/balance-report.md`.

### 7.2 Gain de distance réellement produit

Comme la vitesse ne peut monter qu'à `MAX_ACCEL = 10 m/s²`, un événement ne produit **pas**
instantanément `Δv × D`. Le gain exact (par rapport à un jumeau sans événement, en supposant
`drift = surge = 0`) vaut, avec `Δv = SPEED.BASE × magnitude` et `t_rampe = Δv / MAX_ACCEL` :

```
si t_rampe <= D :   gain = Δv × (D − t_rampe / 2)
si t_rampe >  D :   gain = 0,5 × MAX_ACCEL × D²        (la rampe ne s'achève pas)
```

Toutes les durées du §7.1 sont choisies pour que `t_rampe <= D` (la rampe s'achève toujours).

| Événement | `Δv` | `t_rampe` | Gain minimal | Gain maximal |
| --- | --- | --- | --- | --- |
| `TURBO` | `9,36 – 14,04 m/s` | `0,94 – 1,40 s` | `≈ +17 m` | `≈ +43 m` |
| `RACCOURCI` | `12,48 – 15,60 m/s` | `1,25 – 1,56 s` | `≈ +23 m` | `≈ +44 m` |
| `MEGA_TURBO` | `19,56 m/s` | `1,96 s` | — | `≈ +79 m` |
| `CHUTE` (perte) | `6,6 – 9,0 m/s` | `0,55 – 0,75 s` | `≈ −15 m` | `≈ −42 m` |
| `VENT_DE_FACE` (perte) | `3,6 – 5,4 m/s` | `0,30 – 0,45 s` | `≈ −14 m` | `≈ −37 m` |
| `POULET` (perte) | `2,4 – 4,2 m/s` | `0,20 – 0,35 s` | `≈ −5 m` | `≈ −16 m` |
| `SIESTE` (perte) | `8,4 m/s` | `0,70 s` | — | `≈ −39 m` |

**Le gain est définitivement conservé** après la fin du bonus : il est intégré dans `x`, ce n'est pas
un offset temporaire. La rampe de descente qui suit ne fait que ramener la vitesse vers la normale —
elle ne retire aucune distance. Un gros bonus vaut donc typiquement **une à deux places**.

Ces bornes supposent `drift = surge = 0`. En course, la dérive et les surges s'y ajoutent : un malus
combiné à des modulations négatives voit sa cible passer sous `SPEED.MIN` et retire alors **moins** de
distance que la table ne l'annonce (une `SIESTE` écrêtée peut perdre une trentaine de mètres de moins),
tandis qu'un bonus combiné à des modulations positives peut buter sur `SPEED.MAX`. La **moyenne** et la
**médiane**, elles, restent dans les bornes du tableau — c'est ce que vérifie le test de P008.

### 7.3 Planificateur

| Constante | Valeur | Rôle |
| --- | --- | --- |
| `EVENT.RATE_PER_S` | `1/14` | taux global des **candidats** (Poisson) : ≈ 4,3 candidats sur 60 s |
| `EVENT.GLOBAL_COOLDOWN_S` | `4.0` | délai minimum entre deux événements, tous personnages confondus |
| `EVENT.CHAR_COOLDOWN_S` | `8.0` | délai minimum entre deux événements sur le même personnage |
| `EVENT.MAX_PER_CHARACTER` | `5` | plafond par course, évite le dogpiling |
| `EVENT.MAX_ACTIVE_PER_CHARACTER` | `1` | pas de cumul de gros événements |

Règles d'application :

* Un événement ne s'applique que si la cible n'a **aucun** événement actif — sans exception.
  Jusqu'à P010, `CHUTE` pouvait remplacer un `TURBO` actif ; cette dérogation a été **supprimée**,
  parce qu'elle était inatteignable avec les constantes ci-dessus (un `TURBO` dure au plus `4,0 s`,
  alors que le cooldown global vaut `4,0 s` et le cooldown individuel `8,0 s` : mesuré **0 annulation
  sur 1000 courses**). Une règle normative qui ne peut jamais se déclencher est un piège pour le
  prochain réglage : elle a été retirée du catalogue, du planificateur et des tests, pas conservée
  comme garde dormante.
* Un candidat tiré pendant un cooldown — global ou individuel — est **rejeté**, jamais reporté. Le
  tirage a lieu à chaque pas, cooldown compris : les cooldowns **éclaircissent** (thinning) le
  processus de Poisson, qui garde ainsi son absence de mémoire. Reporter un candidat à la fin du
  cooldown ferait au contraire dépendre le taux réel de l'état des cooldowns. La mesure avec rejet
  donne `≈ 3,36` événements par course à 60 s, soit **exactement la cadence** des `≈ 10,2` événements
  par course de la version 180 s (un événement toutes les 17,9 s dans les deux cas) et le **bas** de la
  fourchette `[3 ; 6]` de §13.
  `RATE_PER_S` est resté à `1/14` : P010 l'a testé à `1/10` (ce qui donnait `≈ 12,9` événements par
  course et une moyenne de répliques légèrement plus haute), puis est **revenu à `1/14`**, parce que
  la moyenne des répliques de §13 était déjà conforme et qu'être proche d'une borne n'est pas un
  motif de réglage. La passe corrective 60 s a de nouveau **mesuré** `1/10` sur le corpus canonique
  (`4,35` événements par course, biais `1,31 %`, `8,90` répliques : rien d'anormal) puis est revenue à
  `1/14` : la mesure ne montrait **aucun défaut à corriger**, et `RATE_PER_S` est **un taux** qui n'a
  aucune raison de suivre la durée de la course. Le corpus canonique de référence reste donc celui de
  `1/14`. Aucun autre réglage de §7.3 n'a changé.
* La durée d'un événement se compte en **temps simulé**.
* Les événements sont tirés **dans `step()`**, donc jamais pendant une pause : `RaceSimulation` ne
  faisant aucun pas, rien n'est tiré, rien n'avance, et un événement en cours reste simplement
  « suspendu » (son temps restant ne diminue pas) jusqu'à la reprise.

### 7.4 Ciblage — invariant anti-triche

**Aucune règle ne dépend du rang ni de l'écart de distance.** La cible d'un événement est tirée
uniformément parmi les 6 personnages (filtrée par les cooldowns). Il n'existe :
* aucun rubber-banding,
* aucune pondération « donner un bonus au dernier »,
* aucun ralentissement du leader,
* aucune accélération du peloton.

Les remontées spectaculaires et les rattrapages du leader **émergent** de la variance (§6.3, §6.4,
§7.1) et ne sont jamais garantis.

La garantie est **structurelle**, pas seulement statistique : `stepEvents()` ne reçoit que le planning,
le flux, les constantes pré-calculées, la liste des identifiants de personnages et le numéro du pas.
Ni `x`, ni `v`, ni un rang, ni un écart ne peuvent donc entrer dans une décision — vérifié par un
garde-fou de source (`tests/unit/boundaries.test.ts`) et par un test qui rejoue le même flux sur un
« monde » artificiellement réordonné. Test de propriété complémentaire : sur 1000 seeds, la cible du
premier événement de chaque course est uniforme sur les 6 personnages.

> La corrélation littérale « nombre d'événements reçus vs position moyenne » ne peut **pas** servir de
> seuil : elle mesure l'effet causal revendiqué ci-dessus (« un gros bonus vaut 2 à 5 places ») et vaut
> `−0,13` mesuré sur 1800 couples (course, personnage) du corpus 180 s de P010. Ce n'est pas un critère
> de §13 et la passe corrective 60 s ne l'a pas re-mesurée ; le mécanisme qu'elle décrit (le ciblage
> ignore le rang) est, lui, verrouillé structurellement par les tests de source et par le rejeu sur un
> monde réordonné.

---

## 8. Classement et écarts

### 8.1 Définition

```
rang_i = 1 + |{ j : x_j > x_i  ou  (x_j === x_i et index_j < index_i) }|
```

Autrement dit, on compte les personnages qui devancent `i` : un personnage `j` devance `i` si sa
distance est **plus grande**, ou si les distances sont **égales** et que son index de personnage est
**plus petit**. Tri par **distance décroissante**, égalité départagée par **index de personnage
croissant** (stable, déterministe, indépendant du temps réel) : en cas d'égalité stricte,
`c0` devance `c1`, qui devance `c2`, et ainsi de suite.

* Le classement est une **conséquence physique** des distances. Il n'est jamais stocké, jamais
  ajusté, jamais « corrigé ». Il est recalculé à partir des `x`.
* **Interdit absolu** : écrire `x` pour obtenir un classement voulu. Aucune écriture dans `x` en
  dehors de l'intégration `x += v × DT`.
* **Interdit absolu** : resynchroniser/recentrer les personnages entre eux (regroupement artificiel,
  « catch-up », neutralisation de checkpoint, aspiration, élastique).
* **Interdit absolu** : classer selon autre chose que `x` (temps de passage, distance à un repère de
  décor, position d'affichage, ordre d'arrivée sur une ligne dessinée).

### 8.2 Écarts

* Écart en mètres : `gap_m_i = x_leader − x_i`.
* Écart en secondes : `gap_s_i = gap_m_i / SPEED.BASE` (référence constante, stable et lisible).
* Écart du peloton : `P1 − P6`.

### 8.3 Dépassements (pour le speaker)

* La détection est une **hystérésis** (bascule de Schmitt) menée **paire par paire** : chaque paire
  non ordonnée `(A, B)` mémorise le dernier côté **confirmé** (`neutral`, `A ahead`, `B ahead`).
* Un côté est confirmé lorsqu'il mène de **plus de** `OVERTAKE.MIN_MARGIN = 0.5 m`.
* Un **dépassement** `A overtakes B` n'est émis que si `B ahead` était confirmé et que `A` franchit la
  marge (`x_A − x_B > OVERTAKE.MIN_MARGIN`) : ce franchissement émet **exactement un** dépassement et
  confirme `A ahead`. Symétriquement pour `B`.
* L'établissement initial d'une paire n'est **jamais** un dépassement : au départ les 6 personnages
  sont à égalité, et le premier à s'éloigner de plus de 0,5 m ne fait que confirmer son côté. Un
  dépassement suppose qu'un côté ait **déjà** été confirmé puis cède la place.
* Dans la bande `±OVERTAKE.MIN_MARGIN`, rien n'est émis et le côté confirmé est **conservé** : une
  simple inversion de rang à quelques centimètres ne suffit pas, et deux personnages quasi à égalité
  qui s'échangent leur rang ne génèrent aucun dépassement.
* `OVERTAKE.MIN_MARGIN = 0.5 m` reste **inchangé** : c'est une règle d'observation, pas de simulation.
* Le détecteur (`src/core/overtakes.ts`) est alimenté **à chaque pas simulé** : le nombre de
  dépassements ne dépend ni du `timeScale`, ni du framerate, ni de la fréquence de rendu. C'est un
  état purement observationnel (mémoire bornée : une valeur par paire, soit 15 pour 6 personnages) :
  il ne modifie jamais `x`, `v`, le rang, les événements ni le résultat de la course.
* Un **changement de leader** n'est reconnu que si le nouveau leader conserve le rang 1 pendant
  `LEADER.DEBOUNCE_S = 0.75 s` **et** mène d'au moins `LEADER.MIN_MARGIN = 1.0 m`.

> Ces marges sont des règles **d'observation** (faits), pas de simulation. Elles n'écrivent jamais
> dans `x`/`v` et ne changent pas le classement.

---

## 9. Speaker

### 9.1 Principe

Le speaker commente **uniquement** des situations importantes, et **uniquement** ce qui s'est
réellement produit. Garantie architecturale : le module speaker ne reçoit que des `RaceFact` produits
par l'observateur, il n'a **aucun accès** à l'état du moteur. Il ne peut donc pas inventer.

### 9.2 Faits détectés (V1)

| id | Déclencheur exact | Importance de base |
| --- | --- | --- |
| `LEADER_CHANGE` | nouveau leader confirmé (§8.3) | `45 + min(25, secondes de règne du précédent)` |
| `BIG_COMEBACK` | +3 places ou plus en ≤ 10 s | `50 + 5 × (places − 3)` |
| `OVERTAKE_STREAK` | ≥ 3 dépassements par le même personnage en ≤ 5 s | `45 + 5 × (n − 3)` |
| `BIG_BONUS` | `TURBO`, `MEGA_TURBO` ou `RACCOURCI` déclenché | `40`, `+15` si la cible est le leader, `+10` si elle est dernière |
| `LEADER_MALUS` | le leader au moment du tirage subit `CHUTE`, `SIESTE` ou `VENT_DE_FACE` | `60`, `+15` si `SIESTE` |
| `CLOSE_RACE` | écart P1–P3 ≤ 15 m pendant ≥ 5 s consécutives | `40` |
| `LAST_COMEBACK` | le dernier passe à la 3e place ou mieux, ou gagne ≥ 4 places en ≤ 30 s | `55` |
| `CHECKPOINT_SPLIT` | instant de checkpoint atteint : `tSim = 20` ou `40 s` | `38`, `+20` si le leader a changé, `+10` si écart P1–P2 < 20 m |
| `FINISH` | `tSim = 60 s` atteint | `80` |
| `PHOTO_FINISH` | écart P1–P2 à `tSim = 60 s` < 5 m | `90` (remplace `FINISH`) |

Un fait n'est **jamais** émis sans la variation d'état correspondante. Chaque `RaceFact` porte :
`type`, `tSim`, `characterIds`, `magnitudes` (valeurs réelles), `importance`, `textKey`.

`CHECKPOINT_SPLIT` est émis par le **noyau** au pas qui atteint l'instant de checkpoint ; la pause qui
suit est décidée par `RaceSimulation` (§4.2). Le fait et la pause sont donc deux choses distinctes et
indépendantes : le fait existe même si l'on décide de ne pas pauser (mode test, avance rapide).

**Conventions d'implémentation (P009-A, `src/core/observer.ts`).** Elles ne modifient **aucune**
constante du tableau ci-dessus : elles fixent seulement ce que contient chaque fait, et la façon dont
il est détecté.

* L'observateur est le **seul** producteur de faits, alimenté à **chaque pas simulé** (jamais à la
  fréquence du rendu). Il ne lit que les distances et l'événement actif du pas, n'écrit jamais dans
  `x`/`v`/le rang, ne tire aucun hasard et ne connaît ni le rendu, ni l'horloge réelle, ni `timeScale`.
* `magnitudes` : `LEADER_CHANGE` = `[marge P1–P2, secondes de règne du précédent]` ;
  `BIG_COMEBACK` = `[places gagnées, rang courant]` ; `OVERTAKE_STREAK` = `[dépassements dans la
  fenêtre]` ; `BIG_BONUS` et `LEADER_MALUS` = `[magnitude de l'événement, durée, rang au moment du
  tirage]` ; `CLOSE_RACE` = `[écart P1–P3, secondes écoulées]` ; `LAST_COMEBACK` = `[places gagnées,
  rang courant]` ; `CHECKPOINT_SPLIT` = distances **dans l'ordre du classement** (P1 → P6) ;
  `FINISH` et `PHOTO_FINISH` = `[écart P1–P2, distance du 1er, distance du 2e]`.
* Les dépassements ne viennent **que** de `OvertakeTracker` (`src/core/overtakes.ts`), alimenté à
  chaque pas : aucune comparaison occasionnelle de classement ne peut créer un `OVERTAKE_STREAK`.
* Un fait « d'épisode » n'est émis qu'**une fois par épisode** (le verrou se lève quand la condition
  redevient fausse) et **jamais au premier relevé**, qui ne sert qu'à établir la référence ; seule
  `CLOSE_RACE` commence à compter dès le premier pas — elle est alors émise à 5 s pleines.
* `LEADER_CHANGE` est daté au **pas de confirmation** (rang 1 tenu `0,75 s` **et** marge ≥ `1,0 m`).
  Pour `CHECKPOINT_SPLIT`, « le leader a changé » signifie : au moins un `LEADER_CHANGE` confirmé a été
  émis depuis le checkpoint précédent — depuis le départ de la course pour le premier.
* Toutes les fenêtres (5 s, 10 s, 30 s) sont comptées en **pas entiers** ; la mémoire de l'observateur
  est constante (aucune photographie de course n'est conservée). Les seuils et importances vivent dans
  la section `FACT` de `src/core/config.ts`.

### 9.3 Discipline de parole

| Constante | Valeur | Rôle |
| --- | --- | --- |
| `SPEAK.MIN_IMPORTANCE` | `45` | en dessous, on ne parle pas |
| `SPEAK.GLOBAL_COOLDOWN_S` | `6.0` | silence minimum entre deux prises de parole |
| `SPEAK.PREEMPT_IMPORTANCE` | `85` | au-delà, peut court-circuiter le cooldown global (jamais le cooldown par type) |
| `SPEAK.INTERRUPT_DELTA` | `20` | une réplique en cours est coupée si `newImp ≥ currentImp + 20` |
| `SPEAK.QUEUE_MAX` | `3` | au-delà, on jette la réplique la moins importante |
| `SPEAK.MAX_LINES_PER_SEGMENT` | `12` | quota dur par segment de 20 s (structurellement non contraignant : le cooldown global de `6 s` plafonne une course de 60 s à ≈ 10 répliques, quota inclus) |
| `SPEAK.MIN_WINDOW_AVG_S` | `5.0` | moyenne minimale d'écart sur fenêtre glissante de 30 s |
| `SPEAK.FACT_MAX_AGE_S` | `12.0` | âge maximal d'un fait **épisodique** au moment où il est prononcé (mesure : `5,92 s` au pire sur le corpus) |
| `SPEAK.RANK_FACT_MAX_AGE_S` | `0.0` | âge maximal d'un fait qui **affirme une position** : une position ne se commente qu'à l'instant de sa mesure |

**Véracité des positions (passe corrective 2).** Un fait peut être **exact** et pourtant être prononcé
trop tard : la position qu'il décrit n'est vraie qu'à son propre instant. Rien ne bornait cet âge, si
bien qu'un fait mesuré à `tSim = 0,37 s` pouvait être dit à `30,05 s`, une fois les cooldowns retombés
— le commentaire annonçait alors un rang périmé (constaté sur la seed `KR7Z8NAR`). Les faits qui
**affirment un rang** (`LEADER_CHANGE`, `BIG_COMEBACK`, `LAST_COMEBACK`, `LEADER_MALUS`) ont donc une
fenêtre de fraîcheur **nulle** : ils sont dits au pas de leur mesure, ou pas du tout. Le speaker n'a
**aucun accès** au classement (§4.4) : il ne peut pas revérifier une position, seulement refuser de
parler en retard. Mesure sur le corpus canonique : avant, **301 des 1029** répliques de position
(29 %) étaient fausses au moment d'être dites ; après, **0 sur 585**. Coût : 9 % de répliques en
moins. Les faits épisodiques (`BIG_BONUS`, `CLOSE_RACE`, `OVERTAKE_STREAK`, `CHECKPOINT_SPLIT`,
`FINISH`, `PHOTO_FINISH`) gardent `FACT_MAX_AGE_S = 12.0`. Aucune constante de simulation n'est
concernée : ce sont des constantes de **discipline de parole**, et seul le flux `speaker:lines` change.

Cooldowns par type : `LEADER_CHANGE 12 s`, `BIG_COMEBACK 15 s`, `OVERTAKE_STREAK 12 s`,
`BIG_BONUS 8 s`, `LEADER_MALUS 10 s`, `CLOSE_RACE 25 s`, `LAST_COMEBACK 20 s`,
`CHECKPOINT_SPLIT 5 s`, `FINISH 0`. Déduplication : un fait identique (même type, mêmes personnages,
même tranche de magnitude) est supprimé pendant `10 s`. **Aucun de ces réglages n'a été touché par la
passe corrective 60 s** : la fenêtre glissante de `30 s` couvre désormais la moitié d'une course, ce
qui ne change pas la règle (elle porte sur la densité de parole, pas sur la durée totale) et reste
mesuré conforme.

**Cible statistique** : **moyenne de 6 à 14 répliques par course sur le corpus d'équilibrage**
(≈ 1 toutes les 8,5 à 10 s en moyenne). C'est bien une **moyenne de corpus**, pas une exigence par
course : la discipline de parole est déterministe mais elle dépend des faits réellement produits, donc
une course pauvre en faits saillants parle moins. Le quota dur de `12` par segment reste une borne
**par segment**, jamais un objectif à atteindre : **le speaker ne parle que sur un `RaceFact`**, il
n'est jamais forcé d'émettre une réplique pour remplir un quota, et il ne parle pas du tout si les
faits manquent. La distribution est surveillée en entier (min, percentiles, max, nombre de courses
sous la cible basse, courses muettes).

Mesuré par la passe corrective sur le corpus canonique de 1000 seeds **à 60 s** : **min 5** |
moyenne **8,906** | max **11**, **2 courses sur 1000 sous 6** répliques, **aucune course muette**
(`= 0` : 0 course, `> 14` : 0 course). La cible `12 – 30` de P010 était la **cadence** de la course de
180 s ; la borne haute `14` correspond au plafond mécanique du cooldown global, majoré des
préemptions. Détail dans `docs/balance-report.md` §4.2.

Mesuré par la **seconde** passe corrective, après la fenêtre de fraîcheur nulle des faits de position
(§9.3) : **min 4** | p10 **6** | médiane **8** | moyenne **7,97** | max **11**, **14 courses sur
1000 sous 6** répliques, **aucune course muette**. La cible `≥ 6` en moyenne et `≥ 8` en médiane reste
tenue : le correctif retire 9 % des répliques, pas la parole.

### 9.4 Textes

* Tous les textes sont en **français**, centralisés dans `src/app/strings.fr.ts` (aucun texte en dur
  dans le noyau).
* 3 à 6 variantes par type de fait, tirées dans un **flux aléatoire séparé** `speaker:lines`
  (dérivé de la seed). **Invariant** : modifier les textes ne doit **jamais** changer le déroulement
  d'une course. Test obligatoire.
* Les placeholders (`{nom}`, `{places}`, `{metres}`) sont remplis **exclusivement** depuis les champs
  du fait. Aucune valeur inventée, aucun arrondi trompeur : les nombres passent par le module de
  présentation (`src/render/format.ts`, §5.2), qui arrondit **à l'affichage** sans jamais toucher la
  valeur de simulation.
* Voix optionnelle via `speechSynthesis` (navigateur, local, gratuit), **désactivée par défaut**,
  comme tout l'audio de la V1 pour le moment. Elle est commandée par le réglage **`Commentateur`**
  (§5.2), parle à `TTS_RATE = 1.6`, et ne vocalise que le texte **déjà affiché** : elle ne peut ni le
  remplacer, ni le retarder, ni influencer la course. Son activation prononce une confirmation courte
  (`Let's go!`) qui ne passe **pas** par le speaker. Le système audio complet reste en P015.

---

## 10. Reproductibilité (seed)

### 10.1 Contrat de seed

* La **seed affichée est la source de vérité**. C'est une chaîne de 8 caractères Base32 Crockford
  (ex. `K7QM2X9A`) : c'est elle qui est lue à l'écran, recopiée dans `?seed=` et partagée.
* La **seed interne** est l'entier 32 bits `hash32(seed affichée)`. **Une seule règle** s'applique à
  toutes les entrées : une seed au format affichable comme une chaîne libre saisie par l'utilisateur
  sont hachées de la même façon. Aucune saisie n'est jamais rejetée.
* Conséquence, et c'est le point qui compte : **recopier la seed affichée dans `?seed=` reproduit
  exactement la même seed interne, donc exactement la même course.**
* Une seed neuve est tirée **directement sous forme de chaîne** : 8 caractères uniformes sur
  l'alphabet, soit 40 bits d'entropie. Aucune seed affichée n'est donc impossible à produire.
* La réduction de 40 bits (8 caractères) vers 32 bits **n'est pas injective** : deux textes différents
  peuvent donner la même seed interne. C'est admis, et jamais nié.
* Les streams sont dérivés de la seed interne : `sfc32` initialisé par
  `splitmix32(hash(seedInterne + ':' + label))`. **Streams indépendants** par usage :
  `drift:<charId>`, `surge:<charId>`, `events:global`, `events:<charId>`, `speaker:lines`,
  `cosmetic` (rendu). L'ordre et le nombre d'appels dans un stream n'influencent aucun autre stream.

### 10.2 Reproductibilité stricte

* **Invariant central** : `résultat(seed, config) = résultat(seed, config)`, bit pour bit, sur
  n'importe quel appareil, **n'importe quel moteur JavaScript**, n'importe quel framerate, n'importe
  quelle vitesse de test.
* Le moteur avance **par pas fixes** de `DT = 1/60 s`. `SIM.TIME_SCALE` (mode test) ne change que le
  **nombre de pas exécutés par frame**, jamais la taille du pas ⇒ même résultat en ×1 et en ×20.
* **Fonctions transcendantes interdites dans la simulation.** Aucun calcul influençant la course ne
  doit reposer sur une fonction `Math.*` dont le résultat peut varier d'un moteur à l'autre
  (`Math.log`, `Math.cos`, `Math.sin`, `Math.tan`, `Math.exp`, `Math.pow`, `Math.sqrt`, …) :
  ECMAScript ne les tient pas pour correctement arrondies, un dernier bit peut donc différer entre
  V8, SpiderMonkey et JavaScriptCore, et cette divergence suffirait à faire dériver deux courses. Une
  constante qui en dépend doit être **pré-calculée et figée** dans `src/core/config.ts`.
  Sont autorisées les opérations **exactes** : entiers 32 bits (`Math.imul`, décalages, `>>> 0`),
  additions, soustractions, multiplications, et divisions par une puissance de deux.
* Interdit dans `src/core/**` : `Math.random`, `Date.now`, `performance.now`, `setTimeout`,
  `window`, `document`, `phaser`. Vérifié par un test de frontière (ROADMAP P002).

### 10.3 Bruit du drift

Le bruit gaussien du drift (§6.3) **n'est pas produit par Box-Muller**. Il utilise l'approximation
déterministe classique : **somme de 12 tirages uniformes** sur `[0, 2^32)`, centrée sur son espérance
exacte `6 × (2^32 − 1)`, puis divisée par `2^32` (mise à l'échelle binaire exacte). La moyenne vaut
alors exactement 0, le bruit est borné à `±(6 − 6/2^32)`, et chaque résultat est un multiple exact de
`2^-32`.

La variance théorique de ce bruit vaut `1 − 2^-64`, et **non** exactement 1. L'écart (≈ 5,4 × 10^-20)
est très inférieur à la précision d'un flottant double, donc sans effet mesurable — mais il est réel
et il ne faut pas l'arrondir par confort dans la documentation.

Le fait que chaque résultat soit un multiple exact de `2^-32` est la **propriété structurelle
attendue** d'un calcul purement entier. Ce n'est **pas**, à lui seul, une preuve de l'absence de
fonction transcendante : l'interdiction effective de `Math.log`, `Math.cos`, `Math.sqrt`, … dans le
noyau est garantie par `tests/unit/boundaries.test.ts` (voir §10.2).

Cette approximation (Irwin-Hall à 12 termes) est suffisamment proche d'une gaussienne pour un drift
d'ambiance, et elle est la seule des deux méthodes à être bit à bit reproductible.

### 10.4 Affichage et paramètres

* Paramètres d'URL : `?seed=K7QM2X9A`, `&fast=1`, `&debug=1`, `&autostart=1`.
* Debug : seed affichée en permanence (coin d'écran, copiable), avec `tSim`, segment courant, et à la
  demande un panneau (`debug=1`) : distances, vitesses, drift/surge/événement actifs, classement brut.

---

## 11. Mode test accéléré

Le mode test ne touche **jamais** au noyau : il ne modifie que `SIM_CONFIG`.

| Constante (`SIM_CONFIG`) | ×1 (normal) | Mode test (`?fast=1`) |
| --- | --- | --- |
| `COUNTDOWN_REAL_S` | 3.0 | 0 |
| `CHECKPOINT_PAUSE_REAL_S` | 3.0 | 0.2 |
| `TIME_SCALE` | 1 | 20 (⇒ course en ≈ 3,2 s réelles) |
| `MAX_STEPS_PER_FRAME` | 5 | `20 × 5 = 100` |
| `runToCompletion(seed)` | — | disponible : course instantanée sans rendu |

`runToCompletion` exécute en boucle les `3600` pas du noyau, sans rendu ni pause, et renvoie l'état
final. C'est l'API utilisée par les tests unitaires et par Playwright pour vérifier la reproductibilité
sans attendre. Le mode `fast=1` sert aux tests d'intégration visibles : il doit produire
**exactement** le même résultat que ×1 pour la même seed.

> **Conséquence de la passe corrective, à connaître pour lire les tests.** Les durées d'affichage du
> commentaire (`VIEW.SUBTITLE_*`) sont exprimées en millisecondes **réelles**, alors que la course se
> mesure en secondes **simulées**. En mode `fast=1`, une course de 60 s dure ≈ 3,2 s réelles : aucune
> réplique n'a donc le temps d'expirer, et chaque nouvelle réplique **coupe** la précédente. Le
> comportement est correct (la réplique est remplacée, jamais empilée), mais un test qui veut observer
> un démarrage *non* préempté doit tourner en mode normal (×1), où les deux horloges coïncident —
> c'est ce que fait le test E2E de discipline du speaker.

---

## 12. Ce qui est explicitement interdit

1. Téléporter, recentrer, resynchroniser, aspirer ou « élastiquer » un personnage.
2. Écrire dans `x` autrement que par `x += v × DT`.
3. Faire dépendre la **fin de course** d'une distance, d'une ligne, d'une arche ou d'un repère
   graphique : la course se termine **exclusivement** à `tSim = 60 s`. Aucune `FINISH_DISTANCE`.
4. Toute règle dépendant du rang ou de l'écart (rubber-banding, bonus au dernier, malus au leader).
5. Tout changement de vitesse instantané (saut de `v`), et toute limite d'accélération appliquée
   uniformément aux deux directions.
6. Donner une caractéristique permanente ou un avantage à un personnage.
7. Maintenir artificiellement le peloton groupé, ou garantir un rattrapage du leader.
8. Faire parler le speaker sans fait réel, ou avec des chiffres non mesurés.
9. Utiliser `Math.random()` dans le noyau, ou coupler le flux des textes au flux du gameplay.
10. Faire dépendre le noyau de Phaser, du DOM ou de l'horloge réelle, ou lui faire connaître une
    durée de pause réelle / un compte à rebours / un `timeScale`.
11. Faire avancer ou modifier `RaceEngine` pendant une pause réelle.
12. Ajouter un backend, une base de données, un appel réseau ou une ressource CDN dans la V1.

---

## 13. Critères d'équilibrage (à vérifier par le harnais de P010 / P017)

Sur **1000 seeds**, 6 personnages, course complète (**60 s**) :

| Critère | Plage attendue | Mesure du corpus canonique |
| --- | --- | --- |
| Écart P1–P6 à `tSim = 60 s` (médiane) | 45 – 150 m | 93,00 m |
| Écart P1–P6 à `tSim = 60 s` (5e / 95e percentile) | ≥ 15 m / ≤ 290 m | 45,83 m / 166,25 m |
| Le leader à `tSim = 40 s` gagne | 55 % – 85 % des courses | 63,20 % |
| Changements de leader par course (moyenne) | 6 – 20 | 8,31 |
| Dépassements comptés par course (moyenne) | ≥ 25 | 27,98 |
| Taux de victoire par personnage | 12 % – 22 % chacun | 15,30 % – 18,40 % |
| Événements par course (moyenne) | 3 – 6 | 3,36 |
| Événements par personnage | ≤ 5, part de chacun entre 10 % et 27 % | 0,54 – 0,58 ; 16,14 % – 17,30 % |
| Surges par personnage | 4,7 – 8,7 | 6,17 – 6,23 |
| Répliques du speaker par course (moyenne) | 6 – 14 | 8,91 |
| Reproductibilité | 100/100 seeds identiques bit à bit | 100/100, distances et classement |
| Nombre de pas par course | exactement `3600`, avec ou sans pauses | 3600 exactement |
| Vitesse moyenne finale par personnage | `SPEED.BASE ± 1,5 %` (équivalence) | 1,277 % max |

Ces seuils sont **implémentés comme tests** (P010, `tools/balanceStats.ts`). Si un réglage change, le
document et les seuils changent ensemble.

> **Passe corrective issue du premier test joueur manuel après P013 — aucune constante de jeu
> modifiée.** La course est passée de 180 s à 60 s (§4). Les seules lignes de §13 qui **dépendent de la
> durée** ont été réinterprétées, jamais relâchées pour faire passer une mesure :
>
> | Ligne | Avant (180 s) | Après (60 s) | Pourquoi |
> | --- | --- | --- | --- |
> | Écart P1–P6 (médiane) | 80 – 260 m | 45 – 150 m | l'écart entre deux personnages est une marche aléatoire à dérive : son écart-type croît comme la **racine** du temps, donc l'échelle est divisée par `√3 ≈ 1,73`, pas par 3 |
> | Écart P1–P6 (p5 / p95) | ≥ 25 m / ≤ 500 m | ≥ 15 m / ≤ 290 m | même raison |
> | Leader à `tSim = 135 s` | 55 % – 85 % | **`tSim = 40 s`**, même plage | `135 s` était « début du dernier segment » (`4 × 45 s`) ; la notion est conservée telle quelle : `TOTAL_SIM_S − SEGMENT_DURATION_S = 40 s`. `135 s` n'existe plus dans une course de 60 s |
> | Événements par course | 10 – 16 | 3 – 6 | `EVENT.RATE_PER_S = 1/14` est un **taux** et n'a pas bougé : la plage est la même **cadence** (un événement toutes les 11 à 20 s) |
> | Surges par personnage | 14 – 26 | 4,7 – 8,7 | `SURGE.INTERVAL_MEAN_S = 9 s` n'a pas bougé : l'espérance passe de `180/9 = 20` à `60/9 ≈ 6,67`, et la plage reste `± 30 %` |
> | Répliques du speaker | 12 – 30 | 6 – 14 | la cadence du speaker est bornée par son cooldown global (`6 s`) : `≈ 10` répliques au maximum en 60 s, donc `[12 ; 30]` y est **structurellement inatteignable** (les 200 courses auditées ne violent aucune règle de §9.3) |
> | Nombre de pas | 10800 | 3600 | `TOTAL_SIM_S / DT_S` |
>
> **Seconde passe corrective (test joueur manuel n° 2) — toujours aucune constante de jeu modifiée.**
> Elle ne touche **ni** la course, **ni** le corpus d'équilibrage : elle n'ajoute qu'une **règle de
> discipline de parole** (§9.3, fenêtre de fraîcheur nulle pour les faits qui affirment une position).
> La cadence mesurée du speaker passe de `8,91` à `7,97` répliques par course, ce qui **reste dans la
> plage `6 – 14`** de la ligne ci-dessus : aucun seuil de §13 n'est modifié, et le corpus de 1000 seeds
> n'a pas été relancé — aucun calcul de course n'ayant changé, ses résultats restent valides. La
> véracité des positions est vérifiée par ses **propres** tests (§9.3), pas par ce corpus, qui mesure
> une cadence.
> Les lignes qui **ne dépendent pas** de la durée (`Changements de leader 6 – 20`,
> `Dépassements ≥ 25`, taux de victoire `12 % – 22 %`, part d'événements `10 % – 27 %`, biais de
> vitesse `± 1,5 %`, reproductibilité `100/100`) ont été **conservées telles quelles** : elles restent
> conformes sans être touchées. Aucune constante de `SPEED`, `SURGE`, `EVENT`, `DRIFT` ni `OVERTAKE`
> n'a été modifiée, et `EVENT.RATE_PER_S` vaut toujours `1/14` (une tentative à `1/10` a été mesurée
> puis **annulée** : elle sortait la cadence des événements de la plage).

> **Passe de vérification des leaders (test joueur n° 3) — aucune constante modifiée.** Un joueur a eu
> l'impression que « le même personnage est souvent premier à 20 s, à 40 s et à l'arrivée ». Mesuré sur
> **10 000 seeds** par `npm run balance:leaders` (rapports `.tmp/leader-audit.txt` et
> `.tmp/leader-audit.json`) :
>
> | Mesure | Valeur |
> | --- | --- |
> | Part de leader à 20 s | 16,24 % – 16,82 % (χ² = 1,54 ; seuil 5 % = 11,07) |
> | Part de leader à 40 s | 16,26 % – 17,04 % (χ² = 3,07) |
> | Part de leader à 60 s (= vainqueur) | 16,24 % – 17,10 % (χ² = 4,61) |
> | Même leader aux trois bornes | 34,04 % |
> | Exactement 2 leaders distincts | 53,25 % |
> | 3 leaders distincts | 12,71 % |
> | Leader 20 s = leader 40 s | 51,61 % |
> | Leader 40 s = vainqueur | 62,23 % |
> | Leader 20 s = vainqueur | 41,53 % |
> | Changements de leader (moyenne) | 8,19 sur 10 000 seeds ; **8,308** sur le sous-corpus de 1000 seeds |
> | 10 000 courses distinctes | oui : 10 000 vecteurs de distance, **720** classements, **216** triplets de leaders |
> | Flux RNG (15 streams) | aucune paire identique, aucune corrélation hors du hasard, χ²(9) ≤ 14,27 (seuil corrigé 27,88) |
>
> **Conclusion : aucune anomalie.** L'impression du joueur est **confirmée par la mesure** — un tiers
> des courses garde le même leader d'un bout à l'autre — mais elle n'est pas un défaut : les parts par
> personnage restent compatibles avec `1/6` (χ² très en dessous du seuil à 5 %, |z| maximal `1,16`
> contre `2,64` après correction de Bonferroni), aucun personnage n'est favorisé, et le sous-corpus de
> 1000 seeds **reproduit exactement** les références déjà publiées ici (`8,308`, `63,20 %`, `100/100`,
> `15,30 % – 18,40 %`). Aucune constante de `SPEED`, `DRIFT`, `SURGE`, `EVENT` ni `OVERTAKE` n'a été
> touchée, et aucun tirage aléatoire n'a été déplacé.


> **Biais de vitesse — résolu en P010, revérifié à 60 s.** La dérive, les surges et les événements ont
> chacun une espérance **nette positive**, et leur somme dépassait le seuil `±1,5 %` de §13. P008 avait
> mesuré **+2,03 %** de `SPEED.BASE` (384 courses). P010 a corrigé la part qui vient du catalogue : les
> **magnitudes de bonus du catalogue §7.1 ont été réduites à 65 %** (§7.1 recalculé, malus inchangés),
> facteur retenu par balayage — le **plus grand facteur conforme parmi les valeurs testées**, et rien
> de plus. Biais résiduel mesuré sur le corpus canonique de 1000 seeds **à 60 s** : **+1,277 %**, mesure
> par personnage comprise (`docs/balance-report.md` §4). L'invariant d'équivalence §5.6 tient toujours :
> aucun personnage ne s'écarte durablement de la moyenne des six.

> **Critère du leader — instant dérivé de la durée.** Le critère s'énonçait « le leader à
> `tSim = 171 s` gagne 55 % – 85 % des courses ». Mesuré sur le corpus canonique, il valait **88,10 %** :
> **hors plage**, et ce n'était pas un artefact de mesure.
>
> Le remplacement n'a pas été décidé parce que le chiffre arrangeait, mais parce que **l'instant choisi
> est le début du dernier segment** — un instant qui a un sens de game design pour dire « la course
> est-elle déjà jouée ? ». Neuf secondes avant l'arrivée, à l'inverse, l'avance médiane du leader vaut
> déjà 38,7 m alors que l'écart-type du chemin parcouru par deux personnages sur ces 9 s vaut 22–27 m :
> le critère mesurait surtout la **persistance mécanique** d'une avance, pas l'intérêt de la course.
> P010 a donc retenu `135 s` (`4 × 45 s`) ; la passe corrective 60 s conserve la **même notion** et la
> **dérive** de `RACE_CONFIG` : `LEADER_CHECK_S = TOTAL_SIM_S − SEGMENT_DURATION_S = 40 s`. Une course de
> 180 s retrouverait mécaniquement 135 s.
>
> Le diagnostic complet est dans `docs/balance-report.md` §2. Il a établi, par comparaison **appariée**
> seed par seed (test de McNemar, 400 seeds), qu'aucune constante **globale, symétrique et indépendante
> du classement** ne corrigeait l'écart de façon significative : atténuer ou supprimer la dérive ou
> les surges *augmente* même le taux, et seule la suppression des événements le ferait baisser —
> au prix de l'écart P1–P6 et du spectacle de §7. Aucun mécanisme de fin de course, aucun malus du
> leader, aucun bonus au dernier n'a été introduit : §7.4 et §5.5 l'interdisent.
>
> Le critère du leader à `40 s`, avec la même plage `55 % – 85 %`, est **conforme** : **63,20 %** sur le
> corpus canonique de 1000 seeds à 60 s.

---

## 14. Glossaire

* **Pas (step)** : une itération de `DT = 1/60 s` du moteur. `step()` ne prend aucun argument.
* **Segment** : 20 s de temps simulé.
* **Checkpoint** : instant de temps simulé (`tSim = 20` et `40 s`). Ce n'est pas une distance. Le mot
  est employé tel quel face au joueur (`Checkpoint 1 · 20 s`) ; `Pointage`, utilisé avant la passe
  corrective, a été retiré.
* **Pause checkpoint** : 3 s de temps réel, gérée par `RaceSimulation`, simulation gelée.
* **`tSim = 60 s`** : seule condition de fin de course. Le gagnant est celui qui a la plus grande
  distance à cet instant.
* **Échelle nominale** (`VIEW.NOMINAL_SCALE_M = 720 m`) : dimensionnement du décor. N'affecte aucune
  règle. La mini-carte qui s'y référait a été retirée du HUD par la passe corrective ; le modèle qui
  la calcule reste un hook de test et de debug.
* **Drift** : dérive permanente de vitesse (OU), ±20 %.
* **Surge** : petite accélération/ralentissement occasionnel.
* **Événement** : modulation de vitesse rare et puissante (turbo, chute…).
* **Fait (`RaceFact`)** : observation mesurée par le noyau, seule matière première du speaker.
* **Seed** : identifiant de course reproductible.
