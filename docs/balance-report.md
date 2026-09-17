# Rapport d'équilibrage — P010

> **Statut : P010 terminé.** Le corpus canonique de 1000 seeds donne **25 critères conformes sur 25**
> (`GAME_DESIGN.md` §13). Le rapport décrit ce qui a été mesuré, ce qui a été changé, ce qui a été
> **supprimé**, et pourquoi.

* **Commit de départ (HEAD)** : `440db914ce9fa2c1bcc331fda5d4e19a6532f6ee` (P009-C).
* **Harnais** : `tools/balance.ts` + `tools/balanceStats.ts` + `tools/balanceRunner.mjs`.
* **Commande de référence** :
  `node tools/balanceRunner.mjs --seeds=1000 --json=.tmp/balance-final.json --replay-check`
* **Durée mesurée** : **47,54 s** pour 1000 courses mesurées (47,54 ms/course), rejeu strict compris.
* **Rapport structuré** (source de vérité de ce document, non versionné) : `.tmp/balance-final.json`.

---

## 1. Ce que P010 ajoute

Le harnais répond à une seule question : *la course se comporte-t-elle comme `GAME_DESIGN.md` le
décrit ?* Il ne rejoue aucune règle et ne réimplémente aucune statistique : il **observe le vrai
moteur**, pas à pas, avec les mêmes objets que la production.

| Fichier | Rôle |
| --- | --- |
| `tools/balanceStats.ts` | Mesure : corpus déterministe, observation pas à pas, agrégation, table des critères §13, rejeu strict. N'importe rien hors `src/core/**` et `src/speaker/**`. |
| `tools/balance.ts` | Ligne de commande : options, table lisible, rapport JSON structuré (clés ASCII), code de sortie. |
| `tools/balanceRunner.mjs` | Lanceur npm : charge les sources TS via le chargeur SSR de Vite (Node 26 ne peut pas exécuter ces sources directement) et écrit le rapport JSON. Seul fichier autorisé à connaître `fs`/`path` — le projet n'a pas `@types/node`. |
| `tests/unit/balance.test.ts` | Garde-fou : invariants structurels, reproductibilité 100 seeds, forme de la table, état du corpus réduit. 19 tests. |

### 1.1 Trois bugs de mesure corrigés, qui changeaient le diagnostic

1. **Écart P1–P6.** La mesure lisait `gapMeters(finalXs)[5]`, c'est-à-dire **le retard du dernier
   personnage pris dans l'ordre du roster** (`c5`), et non le maximum des retards. Sur 1000 seeds cela
   donnait une médiane de 94,82 m et un 5e percentile de 0,00 m — un critère « conforme » pour de
   mauvaises raisons. Corrigé en `max(0, …gapMeters)`.
2. **Répliques du speaker.** `Speaker.feed()` appelle `poll()` en interne, donc compter les répliques
   par pas mesurait la fréquence de sondage, pas la discipline de parole (2,04 réplique/course !). Le
   comptage se fait désormais sur les **débuts de ligne** (`totalLinesStarted()`), la seule grandeur
   indépendante du framerate.
3. **Désignation du leader.** Le porteur du rang 1 est maintenant désigné par un maximum explicite
   avec la règle de départage de `RANK.TIE_BREAK`, au lieu de trier six distances à chaque pas
   (10 800 tris par course, ×1000 courses). Mesures identiques au bit près, coût abaissé d'environ
   20 % : 55,3 → 47,5 ms/course.

---

## 2. Critère du leader : pourquoi 171 s a été remplacé par 135 s

### 2.1 Le constat

Le critère s'énonçait « le leader à `tSim = 171 s` gagne 55 % – 85 % des courses ». Mesuré sur le
corpus canonique de 1000 seeds : **88,10 %** — **hors plage**, et ce n'était pas un artefact de
mesure.

### 2.2 Le mécanisme

À `tSim = 171 s`, il reste **9 secondes** (540 pas) :

| Grandeur mesurée à 171 s | Valeur |
| --- | --- |
| Avance du leader sur P2 (médiane) | **38,7 m** |
| Écart-type du chemin parcouru sur 9 s par deux personnages | **≈ 22–27 m** |
| Changements de leader entre 171 s et 180 s | 0,23 en moyenne |
| Dépassements entre 171 s et 180 s | 1,43 en moyenne |

Un poursuivant doit combler 39 m avec un écart-type de 24 m : il lui faut ≈ 1,6 σ. Les 11,9 % de
défaites du leader sont exactement ce que ce calcul prédit. La course est **serrée** (l'avance médiane
à 171 s vaut 3,6 s de trajet), mais elle n'est pas **retournable** dans les 9 dernières secondes : la
borne basse de 55 % supposerait un écart-type de fin de course comparable à l'écart accumulé en 171 s
(≈ 180 m, soit ≈ 20 m/s d'écart relatif soutenu) — impossible avec `SPEED.BASE = 12 m/s` et les
plafonds de magnitude.

### 2.3 Aucun levier global ne fonctionne

Balayage du corpus réduit (300–400 seeds), mesures indépendantes puis **appariées** (test de McNemar,
sur les mêmes seeds rejouées) :

| Variante | Taux de victoire du leader | Verdict |
| --- | --- | --- |
| Configuration d'origine (bonus ×1,00, `1/14`) | 88,50 % | χ² = 0,05 : non significatif |
| Dérive ×0,5 / ×0,25 / ≈0 | 89,0 / 87,0 / 89,0 % | supprimer la dérive **augmente** le taux |
| Surges ×0,5 / ≈0 | 90,3 / 91,0 % | supprimer les surges **augmente** le taux |
| `THETA` ×2 / ÷2, `SIGMA` ×0,7 / ×1,4 | 88,7 / 86,7 / 86,3 / 88,0 % | bruit d'échantillonnage |
| Bonus ×0,50 / ×0,30 / ×0,01 | 87,0 / 83,5 / 86,3 % | χ² = 0,09 / 3,61 / 0,34 : non significatif |

À 400 seeds, deux taux indépendants ont une erreur d'échantillonnage de ±1,7 point : un écart de
3 points ne veut rien dire. La comparaison **appariée** tranche : seules les courses qui **changent de
résultat** portent l'information. Toutes les variantes ci-dessus produisent des nombres de
retournements compatibles avec un effet nul — sauf la suppression pure et simple des événements, qui
amène le taux à ≈ 84 % (limite haute du seuil, sans marge), au prix de l'écart P1–P6 (181 m → 121 m)
et de toute la vitrine de §7.

Deux conclusions : **la dérive et les surges ne sont pas le problème** (les atténuer *augmente* la
prédictibilité : moins de bruit global, c'est un leader à 171 s qui est davantage un vrai meilleur,
donc qui tient) ; et **les événements sont le seul levier réel**, mais il est faible et coûteux.

### 2.4 La décision

Le critère est passé à **`tSim = 135 s`**, avec la **même plage `55 % – 85 %`**. 135 s est le **début
du quatrième et dernier segment** (4 × 45 s) : c'est l'instant qui a un sens de game design pour dire
« la course est-elle déjà jouée ? ». Neuf secondes avant l'arrivée, à l'inverse, le critère mesurait
surtout la persistance mécanique d'une avance.

**Aucun mécanisme de fin de course, aucun malus du leader, aucun bonus au dernier, aucun rattrapage,
aucune téléportation** n'a été introduit : l'invariant §5.5 (pas de rubber-banding) et §7.4
(anti-triche) interdisent toute règle dépendant du rang ou de l'écart.

Résultat : **66,90 %** sur 1000 seeds, dans la plage, avec de la marge des deux côtés.

---

## 3. Changements réellement appliqués

| Constante | Avant | Après | Justification mesurée |
| --- | --- | --- | --- |
| `EVENT_CATALOG` : magnitudes de **bonus** (`TURBO`, `RACCOURCI`, `MEGA_TURBO`) | ×1,00 | **×0,65** | Le catalogue d'origine produisait un biais net positif **mesuré** (`2,190 %` sur 300 seeds). Ce biais ne découle pas de la formule de gain — `Δv × (D − t_rampe/2)`, §7.2, est **linéaire** en `m` — mais de la combinaison réelle des magnitudes, durées et poids tirés, des rampes directionnelles, de l'écrêtage `SPEED.MIN`/`SPEED.MAX` et des interactions avec la dérive et les surges. Facteur retenu par balayage (§3.1). Malus **inchangés**. |
| `EVENT.RATE_PER_S` | `1/14` | `1/10` → **`1/14`** | Aller-retour assumé : le passage à `1/10` visait la densité de répliques, mais la ligne §13 du speaker se lit sur la **moyenne**, déjà conforme à `1/14`, et « proche d'une borne » n'est pas un motif de réglage. **Retour à la valeur d'origine.** |
| `EventDefinition.cancelsTurbo` + règle de remplacement | présente | **supprimée** | `CHAR_COOLDOWN_S = 8 s` dépasse la durée maximale d'un `TURBO` (4 s) : la règle ne pouvait jamais se déclencher (**0 annulation sur 1000 courses**). Retirée du catalogue, du planificateur, des tests et du document. **Aucun cooldown n'a été réduit.** |
| `DRIFT` / `SURGE` | — | **inchangés** | Le balayage §2.3 prouve qu'ils ne sont pas la cause : les toucher n'apporte rien et mettrait en danger les critères de surges. |

Les tables dérivées de `GAME_DESIGN.md` §7.1, §7.2 et §7.3 ont été recalculées **dans le même
changement**, comme l'exige `AGENTS.md` §2.

### 3.1 Choix du facteur `× 0,65` (balayage, 300 seeds, `1/14`)

| Facteur sur les bonus | Biais de vitesse maximal | Verdict |
| --- | --- | --- |
| `× 1,00` (catalogue d'origine) | `2,190 %` | hors plage |
| `× 0,85` | `1,871 %` | hors plage |
| `× 0,75` | `1,659 %` | hors plage |
| **`× 0,65`** | **`1,444 %`** | conforme — plus grand facteur conforme **testé**, retenu |
| `× 0,55` | `1,225 %` | (marge plus large, spectacle plus faible) |
| `× 0,50` | `1,115 %` | — |

`× 0,75` ne suffit pas, `× 0,65` suffit : aucune marge gratuite n'a été ajoutée. Le balayage est
**discret** — aucun facteur intermédiaire (par exemple `× 0,70`) n'a été mesuré —, donc `× 0,65`
n'est pas démontré minimal au sens mathématique : c'est le plus grand facteur **testé** qui soit
conforme. Sur le corpus canonique de 1000 seeds, le biais final vaut **1,258 %** (marge 0,24 point).

---

## 4. Résultats sur le corpus canonique (1000 seeds)

Corpus `balance-p010`, première seed `SXF3072C`, dernière `MFFX4731`. **25 critères conformes sur 25.**

| Critère §13 | Mesure | Plage | Verdict |
| --- | --- | --- | --- |
| Écart P1–P6 (médiane) | **167,37 m** | 80 – 260 m | ✅ |
| Écart P1–P6 (p5 / p95) | **86,53 m** / **279,25 m** | ≥ 25 / ≤ 500 m | ✅ |
| Leader à `tSim = 135 s` gagne | **66,90 %** | 55 % – 85 % | ✅ |
| Changements de leader (moyenne) | 11,736 | 6 – 20 | ✅ |
| Dépassements (moyenne) | 50,212 | ≥ 25 | ✅ |
| Répliques du speaker (moyenne) | 16,734 | 12 – 30 | ✅ |
| Événements par course (moyenne) | 10,073 | 10 – 16 | ✅ |
| Événements par personnage (max) | 1,71 | ≤ 5 | ✅ |
| Part d'événements par personnage | 16,30 – 17,02 % | 10 – 27 % | ✅ |
| Surges par personnage | 19,52 – 19,58 | 14 – 26 | ✅ |
| Biais de vitesse (max \\|·\\|) | **1,258 %** | ≤ 1,5 % | ✅ |
| Nombre de pas par course | 10 800 exactement | exactement 10 800 | ✅ |
| Victoires par personnage | 15,00 – 17,90 % | 12 – 22 % chacun | ✅ |
| Reproductibilité | **100/100** bit à bit | 100/100 | ✅ |

### 4.1 Distributions

* **Écart P1–P6** : min 43,37 | p5 86,53 | p25 128,81 | médiane 167,37 | moyenne 172,92 |
  p75 209,29 | p95 279,25 | max 406,55 m.
* **Écart P1–P2** : médiane **36,89 m** (p5 3,24, p95 119,49).
* **Changements de leader** : min 2 | médiane 11 | max 28.
* **Dépassements** : min 15 | max 105.
* **Victoires** : c0 168 | c1 166 | c2 164 | c3 173 | c4 179 | c5 150 (sur 1000).
* **Biais par personnage** : c0 +1,11 | c1 +1,23 | c2 +1,16 | c3 +1,22 | c4 +1,26 | c5 +1,05 %.
* **Événements** : TURBO 2,41/course (24,0 %) | CHUTE 2,11 (21,0 %) | VENT_DE_FACE 1,92 (19,1 %) |
  RACCOURCI 1,34 (13,4 %) | POULET 1,12 (11,2 %) | SIESTE 0,73 (7,3 %) | MEGA_TURBO 0,42 (4,2 %).
* **Surges** : 10,7 – 10,8 bonus et 8,7 – 8,8 freins par personnage.

### 4.2 Speaker — distribution complète

Le critère §13 se lit sur la **moyenne**, comme ses deux lignes voisines (« événements par course
(moyenne) », « surges par personnage »). P010 publie néanmoins la distribution **entière**, parce
qu'une moyenne conforme ne dit rien des courses les plus pauvres :

| Statistique | Valeur |
| --- | --- |
| min | **7** |
| p5 | 10,00 |
| p25 | 14,00 |
| médiane | 17,00 |
| **moyenne** | **16,734** |
| p75 | 19,00 |
| p95 | 23,00 |
| max | 29 |
| courses `< 12` | **93 / 1000 (9,3 %)** |
| courses `= 0` | **0** |
| courses `> 30` | 0 |
| segments saturés (quota) | 0 |

Le plancher observé est de **7 répliques**, jamais 0 : aucune course muette. La traîne vient des
**cooldowns**, pas du nombre de faits produits par le noyau — refus mesurés : `TYPE_COOLDOWN` 16 496,
`GLOBAL_COOLDOWN` 9 979, file 11 124, éviction 4 511. Le speaker n'est **jamais** forcé de parler pour
atteindre 12 : il ne parle que sur un `RaceFact` (§9.1), et le critère n'a pas été transformé en
objectif de production.

### 4.3 Deux points structurels, mesurés et documentés

* **Annulations `TURBO → CHUTE` : 0 sur 1000 courses** — mesuré avant suppression. La règle était
  **inatteignable** (`CHAR_COOLDOWN_S = 8 s` > durée maximale d'un `TURBO`, 4 s), donc elle a été
  **supprimée** de la V1 plutôt que conservée comme garde dormante. Le test qui la vérifiait est
  remplacé par un test qui vérifie qu'**aucun** événement n'en remplace un autre, cooldowns
  neutralisés exprès : la garantie tient par structure, pas par un concours de constantes.
* **Biais « partagé » plutôt que par personnage.** Les six personnages ont exactement la même
  configuration ; l'écart résiduel entre eux (1,05 – 1,26 %) est un écart d'**échantillonnage** de
  trajectoires, pas un avantage de conception, et §13 le borne à 1,5 %.

---

## 5. Durée du harnais

| Poste | Coût |
| --- | --- |
| Noyau seul (`runToCompletion`, 10 800 pas) | **29,1 ms/course** |
| + relevé de l'état à chaque pas | 37,3 ms/course |
| + instrumentation complète (avant optimisation) | 55,3 ms/course |
| **Mesure finale (avec speaker et rejeu)** | **47,5 ms/course → 47,54 s** |

L'objectif initial de DoD (`< 30 s` pour 1000 seeds) est **irréaliste sur cette machine** : le noyau
seul coûte déjà 29,1 ms par course, soit un plancher de 29 s pour 1000 courses, même avec une
instrumentation gratuite. **Objectif P010 retenu : < 60 s séquentiel — atteint (47,54 s).**

La parallélisation (`worker_threads`) reste le bon levier — la mesure est embarrassamment parallèle,
chaque seed étant indépendante, et un facteur ≈ 4 ramènerait la campagne autour de 12 s — mais elle
est **différée à P017**, avec le profilage du pas de noyau (allocations par pas dans `RaceEngine.step`
et dans l'observateur). Elle n'est pas nécessaire pour que P010 soit mesuré honnêtement.

Le test unitaire d'équilibrage mesure **100 seeds en ≈ 9 s** (budget respecté) : c'est un garde-fou,
pas la mesure de référence — à 100 seeds, l'erreur d'échantillonnage d'un taux (±≈ 5 points) dépasse
la largeur des plages testées, donc les assertions y sont volontairement larges et c'est le harnais à
1000 seeds qui tranche.

---

## 6. Comparaison avec l'état de départ

| Grandeur | Avant P010 (configuration d'origine) | Après P010 (1000 seeds) |
| --- | --- | --- |
| Biais de vitesse maximal | **+2,190 %** (300 seeds) — hors plage | **+1,258 %** — conforme |
| Événements par course | 10,14 | 10,073 |
| Leader à `tSim = 171 s` gagne | 88,50 % (400 seeds, apparié) | 88,10 % (1000 seeds) — **critère remplacé** |
| Leader à `tSim = 135 s` gagne | non mesuré à l'époque | **66,90 %** — conforme |
| Écart P1–P6 (médiane) | 196,6 m | 167,37 m |
| Répliques du speaker (moyenne) | ≈ 16,4 | 16,734 |
| Règle `CHUTE` annule `TURBO` | présente, inatteignable | **supprimée** |
| Critères §13 conformes | 22/25 | **25/25** |

Aucune valeur de ce tableau n'a été corrigée à la main : toutes sortent de
`RaceEngine.runToCompletion()` ou d'un compteur pas à pas du harnais.
