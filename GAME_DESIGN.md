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

6 identités purement cosmétiques (nom + couleur + silhouette + animation). Aucune ne modifie la
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
| Segment 1 | `tSim = 0 → 45 s` | checkpoint 1 + pause |
| Segment 2 | `tSim = 45 → 90 s` | checkpoint 2 + pause |
| Segment 3 | `tSim = 90 → 135 s` | checkpoint 3 + pause |
| Segment 4 | `tSim = 135 → 180 s` | **fin de course à `tSim = 180 s`** |

> **Règle fondatrice** : `tSim = 180 s` ⇒ `finished`. Le gagnant est **simplement le personnage qui a
> parcouru la plus grande distance** à cet instant. Il n'existe **aucune condition d'arrivée basée sur
> une distance** : si tous les personnages étaient très lents, la course durerait quand même 180 s de
> temps simulé ; si l'un d'eux était très rapide, la course se terminerait au même instant.

### 4.1 Constantes

**a) Temps simulé — connu de `RaceEngine` (`RACE_CONFIG`)**

| Constante | Valeur | Description |
| --- | --- | --- |
| `RACE.SEGMENT_COUNT` | `4` | nombre de segments |
| `RACE.SEGMENT_DURATION_S` | `45` | durée **simulée** d'un segment |
| `RACE.TOTAL_SIM_S` | `180` | `SEGMENT_COUNT × SEGMENT_DURATION_S` |
| `RACE.DT_S` | `1/60` | pas fixe de simulation |
| `RACE.STEPS_PER_SEGMENT` | `2700` | `SEGMENT_DURATION_S / DT_S` |
| `RACE.TOTAL_STEPS` | `10800` | `TOTAL_SIM_S / DT_S` |

**b) Temps réel — connu de `RaceSimulation` uniquement (`SIM_CONFIG`)**

| Constante | Valeur | Description |
| --- | --- | --- |
| `SIM.COUNTDOWN_REAL_S` | `3.0` | compte à rebours avant le départ (mode ×1) |
| `SIM.CHECKPOINT_PAUSE_REAL_S` | `3.0` | durée **réelle** d'une pause checkpoint (mode ×1) |
| `SIM.TIME_SCALE` | `1` | mode normal (`20` en mode test `?fast=1`) |
| `SIM.MAX_STEPS_PER_FRAME` | `5` | garde-fou anti « spiral of death » (×1) |
| `SIM.TOTAL_REAL_S` | `192` | `180 + 3×3 + 3` en mode ×1 |

`RaceEngine` **ignore** `SIM_CONFIG` : il ne connaît ni le compte à rebours, ni la durée réelle des
pauses, ni le `timeScale`. Ces valeurs n'atteignent jamais le noyau.

### 4.2 Responsabilité du temps (séparation stricte)

| | `RaceEngine` (noyau, `src/core/`) | `RaceSimulation` (`src/sim/`) |
| --- | --- | --- |
| Temps | **temps simulé** uniquement | **temps réel** uniquement |
| Horloge | aucune : `step()` ne prend **aucun argument** | lit `performance.now()` via un `realDtMs` fourni par la boucle |
| Avance | pas fixes `DT` exclusivement | accumulateur : exécute `floor(acc / DT)` pas |
| Segments | connaît les 4 segments et l'index courant | connaît l'index courant (lecture, pour l'affichage) |
| `tSim` | le produit et le possède | le lit |
| Fin | produit `finished` à `tSim = 180 s` | relaie l'état `finished` au rendu |
| Countdown | **ne connaît pas** | gère le compte à rebours réel |
| Pause checkpoint | **ne connaît pas** la durée réelle ; signale seulement l'**instant** (`tSim = 45/90/135`) | décide de la pause, de sa durée, de la reprise automatique |
| Pause utilisateur | **ne connaît pas** | suspend l'appel à `step()`, reprend ensuite |
| `timeScale` / mode test | **ne connaît pas** | choisit le **nombre** de pas par frame, jamais leur taille |
| Événements aléatoires | tirés et appliqués dans `step()`, donc **jamais** pendant une pause | garantit qu'aucun `step()` n'a lieu pendant une pause |

**Règle clé** : *une pause réelle ne fait jamais avancer ni modifier `RaceEngine`*. Pendant une pause,
`RaceSimulation` **n'appelle simplement pas** `RaceEngine.step()`. Il n'existe aucun état de pause dans
le noyau, aucune notion de « temps restant de pause », aucun compteur réel.

Conséquences vérifiables :

* `tSim`, `x` et `v` sont **strictement gelés** pendant une pause.
* Aucune neutralisation, aucun rattrapage, aucun repositionnement pendant une pause.
* Le nombre total de pas d'une course est **toujours** `TOTAL_STEPS = 10800`, qu'il y ait eu 0, 3 ou
  100 pauses (checkpoint ou utilisateur).
* Le résultat d'une course est identique avec et sans pauses.

**Contrat d'exactitude des bornes.** Le temps simulé doit être dérivé du **numéro de pas** par
multiplication — `tSim = step × DT` — et **jamais** par accumulation (`tSim += DT`). Avec la
multiplication, `2700 × DT`, `5400 × DT`, `8100 × DT` et `10800 × DT` valent **exactement** `45`,
`90`, `135` et `180` : les instants de checkpoint et la fin de course tombent donc pile sur un pas, et
`track.ts` peut comparer sans la moindre tolérance. En accumulant, on obtient `44.99999999999873` au
pas 2700 et `180.00000000003539` au pas 10800 — les checkpoints seraient manqués. Cette propriété est
verrouillée par les tests de `config.ts` et `track.ts`.

### 4.3 Déroulement

1. Le MJ clique « Lancer ». `RaceSimulation` gère le compte à rebours réel, puis démarre la boucle.
2. `SEGMENT k` dure exactement `45 s` de **temps simulé**, soit `2700` pas.
3. À la fin des segments 1, 2 et 3 (soit à `tSim = 45`, `90` puis `135 s`), `RaceEngine` atteint
   l'instant de checkpoint : il émet un fait `CHECKPOINT_SPLIT` et **continue** d'être prêt à avancer.
   C'est `RaceSimulation` qui cesse d'appeler `step()` pendant `3 s` réelles.
4. La reprise est **automatique** après la pause. Aucune action du MJ n'est requise.
5. À `tSim = 180 s`, `RaceEngine` passe à `finished` et **plus aucun pas n'est exécuté**. Le
   classement final est calculé sur les distances gelées à cet instant.
6. Le MJ peut mettre en pause manuellement (`Espace`) à tout moment : `RaceSimulation` arrête
   d'appeler `step()`, puis reprend. Le nombre de pas reste identique, donc le résultat aussi.
7. Le redémarrage relance une course **depuis zéro** avec la même seed (rejeu identique) ou une
   nouvelle seed.

### 4.4 Checkpoints

* Les checkpoints sont des **instants de temps simulé** : `tSim = 45`, `90` et `135 s`. Ils ne sont
  **pas** des positions, ni des distances, ni des conditions de fin de segment (la fin d'un segment est
  toujours `45 s` de temps simulé, quoi qu'il arrive).
* À chaque checkpoint, on fige un « split » (distances + classement + écarts) pour l'affichage et le
  speaker. Aucun point, aucun bonus, aucune pénalité n'est attribué.
* `classement final = classement par distance décroissante à tSim = 180 s`. Les splits de checkpoint
  n'influencent **jamais** le résultat.
* **Repères visuels de distance** (décor : lignes au sol, arche d'arrivée, fanions) : purement
  facultatifs, définis **uniquement** dans `src/render/` (§5), et **jamais** lus par `src/core/` ni
  `src/sim/`. Ils ne conditionnent ni la fin de la course, ni les pauses, ni le classement.

---

## 5. Piste et caméra (règles de PRÉSENTATION uniquement)

Cette section ne définit **aucune** règle de simulation.

* **Échelle nominale d'affichage** : `VIEW.NOMINAL_SCALE_M = SPEED.BASE × RACE.TOTAL_SIM_S = 2160 m`.
  C'est la longueur qu'aurait la piste si tout le monde courait exactement à `SPEED.BASE`. Elle sert
  **uniquement** à dimensionner le décor et la mini-carte, et à donner une échelle lisible. Ce n'est
  **pas** une ligne d'arrivée : un personnage peut parfaitement la dépasser (turbo) ou ne jamais
  l'atteindre, et cela ne change rien à la fin de la course.
* Écart typique attendu entre le 1er et le 6e à `tSim = 180 s` : **80 à 260 m** (médiane), avec des
  extrêmes possibles de ~25 m à ~500 m. C'est cette amplitude qui rend la mini-carte obligatoire.
* Vue principale : caméra latérale qui suit le **peloton** avec fenêtre adaptative, **bornée à 260 m
  de large** ; au-delà, les personnages hors fenêtre sont signalés par un marqueur de bord.
* Mini-carte : barre de progression `0 → VIEW.NOMINAL_SCALE_M` avec les 6 marqueurs, toujours visible.
  Si un personnage dépasse l'échelle nominale, son marqueur est collé au bord avec un indicateur
  `+xx m` (le rendu ne recadre jamais l'échelle en cours de course).
* Le rendu est **lecture seule** : il ne modifie jamais `x`, `v` ni le classement.

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
  rubber-banding, fin de course à `tSim = 180 s`, reproductibilité `(seed, config)`, et
  `src/core/**` continue de n'importer **rien** hors de `core/`.
* Changer de renderer ne doit **jamais** changer le résultat d'une course : la neutralité du rendu
  est déjà testée (le rendu n'écrit rien dans l'état) et devra le rester.

Tant que le **Jalon 3D** de `ROADMAP.md` (P013.5) n'a pas tranché, **aucune dépendance 3D n'est
installée** et le rendu reste le placeholder 2D de P005.

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
suivantes, donc le nombre attendu de surges sur `180 s` vaut `180 / 9 = 20`.

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
| `TURBO` | Fusée ! | `+1.20 .. +1.80` (×2,2 à ×2,8) | `2.5 – 4.0` | 22 | gros bonus |
| `CHUTE` | La gamelle | `−0.55 .. −0.75` (×0,45 à ×0,25) | `2.5 – 5.0` | 20 | gros malus ; **annule un `TURBO` actif** |
| `VENT_DE_FACE` | Vent de face | `−0.30 .. −0.45` | `4.0 – 7.0` | 18 | malus long |
| `RACCOURCI` | Raccourci douteux | `+1.60 .. +2.00` (×2,6 à ×3,0) | `2.5 – 3.5` | 12 | bonus court et violent |
| `POULET` | Le poulet traverse | `−0.20 .. −0.35` | `2.0 – 4.0` | 10 | petit malus comique |
| `SIESTE` | Micro-sieste | `−0.70` (×0,30) | `5.0` | 6 | malus rare et très lourd |
| `MEGA_TURBO` | TURBO LÉGENDAIRE | `+2.50` (×3,5) | `5.0` | 4 | le gros bonus vitrine |

Poids total = `92`. Le tirage est un tirage pondéré **uniforme par poids**.
Vitesses cibles maximales atteintes : `TURBO` `33,6 m/s`, `RACCOURCI` `36 m/s`, `MEGA_TURBO`
`42 m/s` — toutes sous `SPEED.MAX = 48 m/s`, donc **aucun événement n'est écrasé par le plafond**.

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
| `TURBO` | `14,4 – 21,6 m/s` | `1,44 – 2,16 s` | `≈ +26 m` | `≈ +63 m` |
| `RACCOURCI` | `19,2 – 24,0 m/s` | `1,92 – 2,40 s` | `≈ +30 m` | `≈ +55 m` |
| `MEGA_TURBO` | `30,0 m/s` | `3,00 s` | — | `≈ +105 m` |
| `CHUTE` (perte) | `6,6 – 9,0 m/s` | `0,55 – 0,75 s` | `≈ −15 m` | `≈ −42 m` |
| `VENT_DE_FACE` (perte) | `3,6 – 5,4 m/s` | `0,30 – 0,45 s` | `≈ −14 m` | `≈ −37 m` |
| `POULET` (perte) | `2,4 – 4,2 m/s` | `0,20 – 0,35 s` | `≈ −5 m` | `≈ −16 m` |
| `SIESTE` (perte) | `8,4 m/s` | `0,70 s` | — | `≈ −39 m` |

**Le gain est définitivement conservé** après la fin du bonus : il est intégré dans `x`, ce n'est pas
un offset temporaire. La rampe de descente qui suit ne fait que ramener la vitesse vers la normale —
elle ne retire aucune distance. Un gros bonus vaut donc typiquement **2 à 5 places**.

Ces bornes supposent `drift = surge = 0`. En course, la dérive et les surges s'y ajoutent : un malus
combiné à des modulations négatives voit sa cible passer sous `SPEED.MIN` et retire alors **moins** de
distance que la table ne l'annonce (mesuré sur 40 courses : jusqu'à `−29 m` pour une `SIESTE`), tandis
qu'un bonus combiné à des modulations positives peut buter sur `SPEED.MAX`. La **moyenne** et la
**médiane**, elles, restent dans les bornes du tableau — c'est ce que vérifie le test de P008.

### 7.3 Planificateur

| Constante | Valeur | Rôle |
| --- | --- | --- |
| `EVENT.RATE_PER_S` | `1/14` | taux global (Poisson), ⇒ ≈ 12,9 événements sur 180 s |
| `EVENT.GLOBAL_COOLDOWN_S` | `4.0` | délai minimum entre deux événements, tous personnages confondus |
| `EVENT.CHAR_COOLDOWN_S` | `8.0` | délai minimum entre deux événements sur le même personnage |
| `EVENT.MAX_PER_CHARACTER` | `5` | plafond par course, évite le dogpiling |
| `EVENT.MAX_ACTIVE_PER_CHARACTER` | `1` | pas de cumul de gros événements |

Règles d'application :

* Un événement ne s'applique que si la cible n'a **aucun** événement actif.
  Exception unique : `CHUTE` remplace un `TURBO` actif (annulation dramatisante).
* Un candidat tiré pendant le `GLOBAL_COOLDOWN` n'est **pas** perdu : il reste en attente et déclenche
  le premier pas autorisé. Sans cela, chaque cooldown consommerait tout le délai d'attente suivant (le
  processus de Poisson est sans mémoire) et la course ne compterait plus que `180 / (4 + 14) ≈ 10`
  événements au lieu des `≈ 13` annoncés ci-dessus. La mesure donne `≈ 12,4` événements par course.
* Avec les constantes de la V1, l'exception `CHUTE` sur `TURBO` **ne peut pas se produire en course** :
  un `TURBO` dure au plus `4,0 s`, alors que le cooldown global vaut `4,0 s` et le cooldown individuel
  `8,0 s`. La règle reste implémentée comme une garde structurelle — elle s'appliquerait sans
  modification de code si l'un de ces réglages changeait — et elle est vérifiée par un test à
  cooldowns nuls. La rendre atteignable suppose de modifier un réglage de §7.1 ou §7.3 : c'est une
  décision de game design, pas une conséquence du planificateur.
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
§7.1) et ne sont jamais garantis. Test de propriété obligatoire : sur N seeds, un personnage ne doit
recevoir ni plus ni moins d'événements en fonction de sa position moyenne.

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

* Un **dépassement** n'est compté que si le dépassé est effectivement franchi avec une marge :
  au pas où `rang_i` s'améliore de `k`, on compte `k` dépassements pour `i`, **à condition** que
  `x_i − x_j > OVERTAKE.MIN_MARGIN` pour chaque personnage `j` franchi.
* `OVERTAKE.MIN_MARGIN = 0.5 m` : filtre le bruit numérique (deux personnages quasi à égalité qui
  s'échangent leur rang 20 fois par seconde ne génèrent pas 20 « dépassements »).
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
| `CHECKPOINT_SPLIT` | instant de checkpoint atteint : `tSim = 45`, `90` ou `135 s` | `38`, `+20` si le leader a changé, `+10` si écart P1–P2 < 20 m |
| `FINISH` | `tSim = 180 s` atteint | `80` |
| `PHOTO_FINISH` | écart P1–P2 à `tSim = 180 s` < 5 m | `90` (remplace `FINISH`) |

Un fait n'est **jamais** émis sans la variation d'état correspondante. Chaque `RaceFact` porte :
`type`, `tSim`, `characterIds`, `magnitudes` (valeurs réelles), `importance`, `textKey`.

`CHECKPOINT_SPLIT` est émis par le **noyau** au pas qui atteint l'instant de checkpoint ; la pause qui
suit est décidée par `RaceSimulation` (§4.2). Le fait et la pause sont donc deux choses distinctes et
indépendantes : le fait existe même si l'on décide de ne pas pauser (mode test, avance rapide).

### 9.3 Discipline de parole

| Constante | Valeur | Rôle |
| --- | --- | --- |
| `SPEAK.MIN_IMPORTANCE` | `45` | en dessous, on ne parle pas |
| `SPEAK.GLOBAL_COOLDOWN_S` | `6.0` | silence minimum entre deux prises de parole |
| `SPEAK.PREEMPT_IMPORTANCE` | `85` | au-delà, peut court-circuiter le cooldown global (jamais le cooldown par type) |
| `SPEAK.INTERRUPT_DELTA` | `20` | une réplique en cours est coupée si `newImp ≥ currentImp + 20` |
| `SPEAK.QUEUE_MAX` | `3` | au-delà, on jette la réplique la moins importante |
| `SPEAK.MAX_LINES_PER_SEGMENT` | `12` | quota dur par segment de 45 s |
| `SPEAK.MIN_WINDOW_AVG_S` | `5.0` | moyenne minimale d'écart sur fenêtre glissante de 30 s |

Cooldowns par type : `LEADER_CHANGE 12 s`, `BIG_COMEBACK 15 s`, `OVERTAKE_STREAK 12 s`,
`BIG_BONUS 8 s`, `LEADER_MALUS 10 s`, `CLOSE_RACE 25 s`, `LAST_COMEBACK 20 s`,
`CHECKPOINT_SPLIT 5 s`, `FINISH 0`. Déduplication : un fait identique (même type, mêmes personnages,
même tranche de magnitude) est supprimé pendant `10 s`.

**Cible d'équilibre** : 12 à 30 répliques par course (≈ 1 toutes les 6 à 15 s), jamais 0, jamais
plus de 12 par segment.

### 9.4 Textes

* Tous les textes sont en **français**, centralisés dans `src/app/strings.fr.ts` (aucun texte en dur
  dans le noyau).
* 3 à 6 variantes par type de fait, tirées dans un **flux aléatoire séparé** `speaker:lines`
  (dérivé de la seed). **Invariant** : modifier les textes ne doit **jamais** changer le déroulement
  d'une course. Test obligatoire.
* Les placeholders (`{nom}`, `{places}`, `{metres}`) sont remplis **exclusivement** depuis les champs
  du fait. Aucune valeur inventée, aucun arrondi trompeur.
* Voix optionnelle via `speechSynthesis` (navigateur, local, gratuit), **désactivée par défaut**,
  comme tout l'audio de la V1 pour le moment.

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
| `TIME_SCALE` | 1 | 20 (⇒ course en ≈ 9,6 s réelles) |
| `MAX_STEPS_PER_FRAME` | 5 | `20 × 5 = 100` |
| `runToCompletion(seed)` | — | disponible : course instantanée sans rendu |

`runToCompletion` exécute en boucle les `10800` pas du noyau, sans rendu ni pause, et renvoie l'état
final. C'est l'API utilisée par les tests unitaires et par Playwright pour vérifier la reproductibilité
sans attendre. Le mode `fast=1` sert aux tests d'intégration visibles : il doit produire
**exactement** le même résultat que ×1 pour la même seed.

---

## 12. Ce qui est explicitement interdit

1. Téléporter, recentrer, resynchroniser, aspirer ou « élastiquer » un personnage.
2. Écrire dans `x` autrement que par `x += v × DT`.
3. Faire dépendre la **fin de course** d'une distance, d'une ligne, d'une arche ou d'un repère
   graphique : la course se termine **exclusivement** à `tSim = 180 s`. Aucune `FINISH_DISTANCE`.
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

Sur **1000 seeds**, 6 personnages, course complète :

| Critère | Plage attendue |
| --- | --- |
| Écart P1–P6 à `tSim = 180 s` (médiane) | 80 – 260 m |
| Écart P1–P6 à `tSim = 180 s` (5e / 95e percentile) | ≥ 25 m / ≤ 500 m |
| Le leader à `tSim = 171 s` gagne | 55 % – 85 % des courses |
| Changements de leader par course (moyenne) | 6 – 20 |
| Dépassements comptés par course (moyenne) | ≥ 25 |
| Taux de victoire par personnage | 12 % – 22 % chacun |
| Événements par course (moyenne) | 10 – 16 |
| Événements par personnage | ≤ 5, part de chacun entre 10 % et 27 % |
| Surges par personnage | 14 – 26 |
| Répliques du speaker par course | 12 – 30 |
| Reproductibilité | 100/100 seeds identiques bit à bit |
| Nombre de pas par course | exactement `10800`, avec ou sans pauses |
| Écart de vitesse moyenne entre personnages | ≤ 0,5 % autour de la moyenne des six (équivalence) |

Ces seuils sont **implémentés comme tests** (P010). Si un réglage change, le document et les seuils
changent ensemble.

> **Biais partagé, et pourquoi la ligne ci-dessus a changé en P008.** La dérive, les surges et les
> événements ont chacun une espérance **nette positive** : les constantes de surge de §6.4 valent
> ≈ +0,9 %, et le catalogue d'événements de §7.1 ajoute ≈ +1,1 point de plus, parce qu'à poids et
> durées égaux les bonus rapportent plus de distance que les malus n'en retirent — l'écrêtage à
> `SPEED.MIN` rabote encore les malus. Mesuré sur 384 courses en P008 : **+2,03 %** de `SPEED.BASE`
> en moyenne, identique pour les six personnages (écart maximal entre personnages : 0,38 %).
> Le seuil historique `SPEED.BASE ± 1,5 %`, écrit avant les événements, ne pouvait donc plus servir
> de borne **absolue** ; il est remplacé par l'**écart à la moyenne des six**, qui est la vraie
> formulation de l'invariant d'équivalence §5.6 et ne dépend pas de l'amplitude du biais partagé.
> Rendre le catalogue net neutre en distance (malus plus longs ou plus forts) est un réglage de §7.1,
> donc une décision de game design — signalée au compte rendu P008, à trancher avant P010.

---

## 14. Glossaire

* **Pas (step)** : une itération de `DT = 1/60 s` du moteur. `step()` ne prend aucun argument.
* **Segment** : 45 s de temps simulé.
* **Checkpoint** : instant de temps simulé (`tSim = 45`, `90`, `135 s`). Ce n'est pas une distance.
* **Pause checkpoint** : 3 s de temps réel, gérée par `RaceSimulation`, simulation gelée.
* **`tSim = 180 s`** : seule condition de fin de course. Le gagnant est celui qui a la plus grande
  distance à cet instant.
* **Échelle nominale** (`VIEW.NOMINAL_SCALE_M = 2160 m`) : dimensionnement du décor et de la
  mini-carte. N'affecte aucune règle.
* **Drift** : dérive permanente de vitesse (OU), ±20 %.
* **Surge** : petite accélération/ralentissement occasionnel.
* **Événement** : modulation de vitesse rare et puissante (turbo, chute…).
* **Fait (`RaceFact`)** : observation mesurée par le noyau, seule matière première du speaker.
* **Seed** : identifiant de course reproductible.
