# Architecture — Chaos Race

Amorce du document d'architecture. Il décrit **la seule chose qui ne se négocie pas** : le sens des
dépendances. Le détail de l'arborescence cible et des étapes vit dans `ROADMAP.md` (partie A), les
règles de jeu dans `GAME_DESIGN.md`.

---

## 1. Principe : un noyau pur, tout le reste autour

La simulation doit être rejouable à l'identique et testable sans navigateur. Cela impose une
frontière nette : d'un côté un **noyau sans aucune dépendance**, de l'autre tout ce qui touche au
temps réel, au rendu ou au navigateur.

```
app/  ──▶ sim/ ──▶ core/                 core/ n'importe RIEN hors de core/
app/  ──▶ render/ ──▶ (lecture seule de sim/ et speaker/)
app/  ──▶ speaker/ ──▶ core/types uniquement
```

## 2. Règles par couche

| Couche | Peut importer | Ne peut jamais importer |
| --- | --- | --- |
| `src/core/**` | uniquement `src/core/**` | `phaser`, `src/render`, `src/app`, `src/sim`, tout global navigateur |
| `src/sim/**` | `src/core/**` | `src/render`, `src/app`, `phaser` |
| `src/render/**` | `src/sim/**` (lecture), `src/speaker/**`, `phaser` | — (il ne modifie rien) |
| `src/speaker/**` | `src/core/**` (types et faits) | `src/sim/**`, `src/render/**`, `phaser` |
| `src/app/**` | tout ce qui précède | — |

Deux règles de fond complètent le tableau :

* `src/core/**` ne lit **jamais** l'horloge réelle ni une source de hasard ambiante : le temps est
  injecté sous forme de pas fixes, l'aléatoire vient de streams nommés dérivés de la seed.
* `src/render/**` est **lecture seule**. Aucune écriture de position, de vitesse, de rang ou
  d'événement ne peut y être faite : la seule écriture légitime de `x` est l'intégration
  `x += v × DT`, dans le noyau.

## 3. Ce que le test de frontière verrouille

`tests/unit/boundaries.test.ts` lit les sources de `src/core/**` et échoue si l'une d'elles :

* mentionne une API interdite : `phaser`, `window`, `document`, `navigator`, `localStorage`,
  `sessionStorage`, `Math.random`, `Date`, `performance`, `setTimeout`, `setInterval`,
  `setImmediate`, `requestAnimationFrame`, `timeScale`, `countdown`, `finishDistance`,
  `FINISH_DISTANCE` ;
* importe quelque chose hors du noyau : un paquet externe (`phaser`, un module Node) ou
  `../render`, `../app`, `../sim`.

Deux points d'implémentation à connaître :

* Les sources sont lues via `import.meta.glob(..., { query: '?raw' })`. C'est Vite qui fournit le
  texte : aucun accès au système de fichiers, donc aucune dépendance de types supplémentaire.
* Les **commentaires sont retirés avant l'analyse**. On peut donc documenter une interdiction dans un
  commentaire du noyau sans déclencher le garde-fou ; seule une utilisation réelle échoue.

Le test vérifie aussi **le détecteur lui-même**, sur des sources synthétiques : c'est ce qui garantit
qu'il n'est pas devenu un test qui passe toujours.

Ce test ne doit jamais être affaibli, désactivé ni contourné. S'il échoue, on corrige le code qui
franchit la frontière — pas le test.

## 4. Reproductibilité : seed et streams

* Une course est identifiée par une **seed 32 bits**, affichée en Base32 Crockford sur 8 caractères
  (`src/core/seed.ts`). Toute chaîne saisie est acceptée : elle est hachée (`hash32`, FNV-1a 32 bits).
* L'aléatoire vient de générateurs entièrement entiers — `sfc32` amorcé par `splitmix32` — pour que
  le résultat soit identique sur n'importe quel appareil (`src/core/rng.ts`).
* Chaque usage a son **stream nommé**, dérivé de `hash32(seed + ':' + label)` :
  `drift:<charId>`, `surge:<charId>`, `events:global`, `events:<charId>`, `speaker:lines`,
  `cosmetic`. Consommer ou modifier un stream ne décale jamais les autres, et l'ordre des appels
  entre streams est sans effet. C'est ce qui permettra d'ajouter un tirage quelque part sans
  invalider toutes les courses déjà partagées.
* La seed vit dans l'URL (`?seed=…`). `src/app/main.ts` la lit, en tire une au hasard si elle est
  absente, et l'écrit dans l'URL : un rechargement rejoue donc exactement la même course.

## 5. Ce que ce document n'est pas

Il ne fixe ni les constantes de jeu (voir `GAME_DESIGN.md`), ni le découpage des étapes (voir
`ROADMAP.md`), ni les conventions de travail (voir `AGENTS.md`).
