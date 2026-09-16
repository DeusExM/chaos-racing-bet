# AGENTS.md — Règles de travail (Chaos Race)

Ce fichier s'adresse à **toute future session d'agent** travaillant sur ce dépôt.
Il est prioritaire sur toute autre considération de confort ou de rapidité.
Lire d'abord `GAME_DESIGN.md` (règles du jeu, normatif) et `ROADMAP.md` (architecture + étapes).

---

## 1. Règle numéro un : une seule étape de roadmap à la fois

1. **Avant de commencer** : lire `ROADMAP.md`, identifier l'étape en cours (`[~]`) ou la prochaine
   non terminée (`[ ]`), et vérifier ses dépendances (colonne « Dépend de »).
2. **Ne jamais commencer une étape sans autorisation explicite de l'utilisateur.** S'il demande
   « continue », il autorise **l'étape suivante unique**, pas la suivante plus trois.
3. **Ne jamais implémenter d'avance** du code destiné à une étape future, même « pour gagner du
   temps ». Pas de stubs, pas de TODO dans le code de production, pas de dépendance ajoutée par
   anticipation.
4. Toute idée utile hors périmètre va dans le backlog de `ROADMAP.md` (§ Backlog) — pas dans le code.
5. **Ne jamais renuméroter ni réorganiser** les étapes existantes. On ajoute à la fin.
   *Exception unique et déjà consommée* : la roadmap a été réordonnée **une seule fois** (révision 2,
   pour obtenir une course visible dès P005) sur demande explicite de l'utilisateur. Cette exception
   est **close** : toute nouvelle étape s'ajoute désormais à la fin (P019+).
6. Mettre à jour le statut de l'étape dans `ROADMAP.md` : `[ ]` → `[~]` au début, `[x]` à la fin
   **seulement** quand tous ses tests passent.

---

## 2. Tests obligatoires avant de considérer une étape terminée

Une étape n'est **pas** terminée tant que :

1. Les **nouveaux tests** décrits dans la section « Tests (DoD) » de l'étape existent et passent.
2. **Tous les tests précédents** passent encore (aucune régression).
3. `npm run verify` passe intégralement (`typecheck` + tests unitaires + build + tests E2E).
4. Aucune erreur, aucun avertissement de type, aucune erreur console dans les tests E2E.
5. Aucun test laissé en `.skip`, `fixme`, `only`, commenté ou désactivé. **Interdit.**
   Si un test est réellement impossible à faire passer, c'est un **blocage** : le signaler à
   l'utilisateur, ne pas contourner.

Précisions :

* Le noyau (`src/core/**`) se teste **sans navigateur** (Vitest, environnement node). Un test du
  noyau qui a besoin de Phaser ou du DOM est le signe d'une erreur d'architecture : corriger
  l'architecture, pas le test.
* Un bug découvert pendant une étape se corrige **dans l'étape en cours** s'il concerne son
  périmètre, sinon il est ajouté comme nouvelle étape en fin de roadmap.
* Les valeurs numériques des tests d'équilibrage vivent dans `GAME_DESIGN.md` §13. Les seuils codés
  et le document doivent rester cohérents.
* Quand un changement de règle invalide volontairement une table de seeds dorées ou des seuils, la
  mise à jour se fait **explicitement**, dans le même changement, avec la raison écrite dans le
  compte rendu. Jamais « pour faire passer le test ».
* En cas de test qui échoue de façon intermittente : le rendre déterministe ou augmenter N.
  Un test flaky est un bug bloquant, pas une fatalité.

---

## 3. Dépendances : ne rien ajouter d'inutile

1. **Aucune nouvelle dépendance sans autorisation explicite** de l'utilisateur, y compris une
   dépendance de développement ou un outil de lint.
2. Toute proposition de dépendance doit être justifiée en une phrase + une alternative sans
   dépendance. **Dépendances déjà validées par l'utilisateur** (les seules autorisées pour la V1) :
   Vite, TypeScript, **Phaser 4.2.1**, `vite-plugin-pwa`, Vitest, `@playwright/test`. Aucun linter
   (pas d'ESLint en V1) : les garde-fous d'architecture sont des tests, pas des règles de lint.
3. Interdits en V1 : backend, base de données, état global externe (Redux/Zustand), framework UI,
   librairie d'UI, librairie d'animation, CDN, police distante, service d'analytics, télémétrie,
   **tout appel réseau sortant de l'application Chaos Race à l'exécution (runtime)**.
4. **Portée de cette interdiction réseau : runtime uniquement.** Elle vise l'application finale :
   une fois lancée dans le navigateur, la V1 ne doit effectuer **aucun** appel réseau externe
   (aucun CDN, aucune police distante, aucune API, aucun analytics, aucune télémétrie).
   Elle **n'interdit pas** les accès réseau nécessaires au **développement**, par exemple :
   * `npm` / `pnpm` pour installer les dépendances validées du point 2 ;
   * `npx` pour exécuter un outil validé ;
   * le téléchargement des navigateurs Playwright si nécessaire (`npx playwright install`) ;
   * `git` (clone, fetch, push…) ;
   * le téléchargement d'une dépendance ou d'un outil **explicitement autorisé** par l'utilisateur.
5. Les ressources (images, sons, polices) sont **locales** et versionnées dans `public/` : elles ne
   sont jamais chargées depuis un domaine externe.
6. Poids total des ressources < 3 Mo (testé au build).
7. **Blender (assets 3D) — autorisé plus tard, pas maintenant.**
   Il est **autorisé** d'utiliser plus tard un Blender installé localement, via son interface Python
   `bpy` et son mode CLI / headless, par exemple pour :
   * créer ou modifier des assets ;
   * importer / exporter du GLB, GLTF, OBJ ;
   * rendre des PNG transparents ;
   * produire des sprites ou des spritesheets à partir de modèles 3D.

   Règles encadrant cet usage :
   * **ne pas installer Blender** maintenant, **ne pas l'utiliser en P001**, **ne créer aucun asset**
     pour l'instant ;
   * c'est une activité de **backlog** (P019+), à ne commencer que sur demande explicite ;
   * tout asset produit par Blender reste **purement visuel** et ne doit **jamais** influencer la
     simulation : aucun asset ne fournit de constante de jeu, de distance, de vitesse ni de règle ;
   * privilégier des **scripts reproductibles** placés dans `tools/blender/`, versionnés avec leurs
     sources, afin qu'un asset puisse être régénéré à l'identique ;
   * les fichiers produits sont **locaux** (aucun CDN) et soumis au budget de 3 Mo du point 6, sauf
     décision explicite de l'utilisateur.
8. **Phaser — version et API (V1).**
   * La V1 utilise **Phaser 4.2.1**, exactement la version installée (`"phaser": "^4.2.1"`).
   * Le projet est **neuf** : il n'y a **aucune compatibilité Phaser 3 à préserver**. Ne pas
     downgrader, ne pas ajouter de couche de compatibilité, ne pas conserver une API obsolète par
     précaution.
   * **Ne pas changer de version majeure sans autorisation explicite de l'utilisateur.** Une montée
     de correctif dans la plage `^4.2.1` reste possible.
   * **Utiliser les API et les imports Phaser 4** : import nommé depuis le paquet `phaser`, par
     exemple `import { AUTO, Game, Scene } from 'phaser';`. Éviter `import Phaser from 'phaser'`,
     qui ne correspond pas aux types du paquet.
   * **Ne jamais recopier aveuglément un exemple Phaser 3** : les exemples antérieurs à la version 4
     peuvent utiliser des API renommées, déplacées ou supprimées. En cas de doute, se référer aux
     types installés (`node_modules/phaser/types/phaser.d.ts`) et vérifier par `npm run typecheck`.

---

## 4. Séparation simulation / rendu : non négociable

Le sens des dépendances est **à sens unique** :

```
app/  ──▶ sim/ ──▶ core/          core/ n'importe RIEN hors de core/
app/  ──▶ render/ ──▶ (lecture de sim/ et speaker/)
app/  ──▶ speaker/ ──▶ core/types uniquement
```

Règles concrètes :

1. `src/core/**` n'importe **jamais** `phaser`, `src/render`, `src/app`, `src/sim`, ni un global
   navigateur (`window`, `document`, `navigator`, `localStorage`).
2. `src/core/**` ne contient **jamais** `Math.random`, `Date.now`, `performance.now`, `setTimeout`,
   `setInterval`, `requestAnimationFrame`. Le temps est toujours injecté sous forme de pas fixes.
   Il ne contient **jamais** non plus de durée réelle (`countdown`, pause, `timeScale`, `maxStepsPerFrame`)
   ni de constante de distance d'arrivée (`finishDistance`, `FINISH_DISTANCE`) : la fin de course est
   `tSim = 180 s`, et le temps réel appartient à `SIM_CONFIG` (`src/sim/`).
3. `src/render/**` est **lecture seule** : il ne modifie jamais `x`, `v`, le rang, les événements ou
   les faits. Il positionne des sprites à partir des distances.
4. `src/speaker/**` ne reçoit que des `RaceFact`. Il n'a **aucun accès** à `RaceEngine`, `RaceState`,
   `speedModel` ou `events`. C'est ce qui garantit qu'il ne peut pas inventer un commentaire.
5. Toute écriture dans `x` en dehors de l'intégration `x += v × DT` est un **bug critique**.
6. Ces règles sont vérifiées par `tests/unit/boundaries.test.ts` (P002). Ce test ne doit jamais être
   affaibli, désactivé ou contourné. S'il échoue, on corrige le code qui viole la frontière.

---

## 5. Invariants à ne jamais casser

À vérifier mentalement à chaque changement, et par les tests :

1. **Reproductibilité** : `(seed, config)` ⇒ course identique, bit à bit, sur n'importe quel appareil
   et n'importe quel framerate.
2. **Pas fixe** : la simulation avance par pas de `DT = 1/60 s`. `RaceEngine.step()` ne prend
   **aucun argument** de temps. Le mode test ne change que le **nombre** de pas par frame, jamais
   leur taille.
3. **Fin de course par le temps, jamais par la distance** : la course se termine **exclusivement** à
   `tSim = 180 s`, soit exactement `10800` pas. Il n'existe **aucune** `FINISH_DISTANCE`, aucune
   condition d'arrivée, de victoire ou de classement fondée sur une distance, une ligne ou une arche
   dessinée. Les repères de distance de `src/render/` sont du **décor** et ne sont jamais lus par
   `src/core/` ni `src/sim/`.
4. **Pas de téléportation** : aucune écriture de position autre que l'intégration de la vitesse.
   Aucun recentrage, aucune resynchronisation, aucune neutralisation de checkpoint.
5. **Pas de rubber-banding** : aucune règle (événement, vitesse, malus, bonus) ne dépend du rang ni
   de l'écart de distance. Les remontées émergent de la variance, elles ne sont jamais garanties.
6. **Équivalence des personnages** : les 6 configurations sont strictement identiques. Aucun trait
   permanent. Vitesse moyenne de chacun = `SPEED.BASE`.
7. **Progressivité directionnelle** : à chaque pas, avec `Δv = v(t) − v(t−1)` :
   `Δv ≤ MAX_ACCEL × DT` si `Δv ≥ 0`, et `−Δv ≤ MAX_DECEL × DT` si `Δv < 0`.
   **Ne jamais** appliquer `|Δv| ≤ MAX_ACCEL × DT` aux deux directions : les décélérations ont leur
   propre limite (`MAX_DECEL = 12 m/s²`). Cela vaut pour **tous** les changements de vitesse, y
   compris les gros événements et la fin d'un bonus.
8. **Classement dérivé** : le classement est toujours recalculé à partir des distances, jamais
   stocké, jamais ajusté. Égalité départagée par index de personnage croissant.
9. **Véracité du speaker** : aucune réplique sans `RaceFact`, aucun chiffre non mesuré.
10. **Indépendance des flux aléatoires** : `drift:*`, `surge:*`, `events:*`, `speaker:lines`,
    `cosmetic`. Modifier les visuels ou les textes ne doit **jamais** changer le résultat d'une course.
11. **Responsabilité du temps** : `RaceEngine` ne connaît que le **temps simulé** (pas fixes, `tSim`,
    segments, fin à `180 s`). Il ne connaît **ni** le compte à rebours, **ni** la durée réelle d'une
    pause, **ni** le `timeScale`, **ni** l'horloge réelle : ces valeurs vivent dans `SIM_CONFIG`
    (`src/sim/`) et n'atteignent jamais le noyau.
12. **Pauses** : pendant une pause (checkpoint ou utilisateur), `RaceSimulation` **n'appelle
    simplement pas** `RaceEngine.step()`. Une pause réelle ne fait donc **jamais** avancer ni modifier
    le noyau : `tSim`, `x` et `v` sont strictement gelés, le nombre total de pas reste `10800`, et le
    résultat final est identique à une course sans pause.

Si un changement proposé par l'utilisateur viole un de ces invariants, **le signaler avant
d'implémenter** et proposer une variante compatible (ou demander une modification explicite de
`GAME_DESIGN.md`).

---

## 6. Corriger les erreurs avant de poursuivre

1. Dès qu'une erreur apparaît (typecheck, test, runtime, console), **on s'arrête et on la corrige**.
   On ne l'ignore pas, on ne la contourne pas, on ne la reporte pas à l'étape suivante.
2. Pas de `any` implicite ou explicite pour faire taire TypeScript. Pas de `@ts-ignore`,
   `@ts-expect-error`, `as unknown as` non justifié, pas de `!` non nul par confort.
3. Pas de `try/catch` silencieux qui avale une erreur.
4. Une erreur de fond (mauvaise architecture, mauvaise abstraction) se corrige **maintenant**, même
   si cela demande de défaire du travail. Ne jamais empiler du code sur une base Cassée.
5. Si une erreur résiste après 2 tentatives sérieuses : décrire précisément le problème à
   l'utilisateur (message exact, fichier, ligne, ce qui a été essayé) au lieu d'improviser un
   contournement.

---

## 7. Conventions de code

* **Identifiants, noms de fichiers, commits : en anglais.** **Textes visibles : en français**,
  centralisés dans `src/app/strings.fr.ts` (jamais en dur dans `core/`, `sim/`, `render/`).
  **Documentation : en français.**
* TypeScript `strict` complet : `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `noImplicitOverride`, `verbatimModuleSyntax`, `noFallthroughCasesInSwitch`.
* Modules courts, une responsabilité par fichier, fonctions **pures** dans `core/` autant que
  possible. L'état mutable est concentré dans `RaceEngine` et `RaceSimulation`.
* Pas de classe pour une simple fonction ; pas de fonction pour un module entier.
* Commentaires : expliquer **pourquoi**, pas **quoi**. Un commentaire qui paraphrase le code est
  supprimé. Pas de commentaire mort, pas de code commenté.
* Les tableaux ordonnés (`readonly CharacterState[]`) sont la structure de référence ; aucune
  itération de `Map`/`Set` dans la physique.
* Une constante de jeu vit **uniquement** dans `src/core/config.ts` et doit correspondre exactement à
  `GAME_DESIGN.md`. Aucune valeur magique dans le code.
* Nommage des tests : décrire le comportement attendu (`'conserve le gain de distance après un
  turbo'`), pas le nom de la fonction testée.

---

## 8. Git et comptes rendus

* Un dépôt git est initialisé en P001. **Un commit par étape**, message **en anglais** (voir §7),
  préfixé par l'étape : `P001: scaffolding, scripts and guard rails`.
* Jamais de commit de `node_modules/`, `dist/`, `test-results/`, rapports Playwright, fichiers
  temporaires ou secrets (il n'y en a aucun, et il ne doit pas y en avoir).
* Ne pas committer une étape dont les tests échouent. Ne pas `--amend`/`--force` un commit poussé.
* **À la fin de chaque étape, produire un compte rendu** contenant :
  1. l'étape traitée et son statut ;
  2. ce qui a été créé/modifié (fichiers principaux) ;
  3. les commandes de test exécutées et leur **résultat réel** (pas une supposition) ;
  4. les décisions prises et les écarts éventuels par rapport au plan ;
  5. les blocages ou incertitudes ;
  6. la proposition d'**une seule** étape suivante, sans la commencer.

---

## 9. Environnement de travail (constats à connaître)

* Le dépôt vit dans `D:\Code\chaos-race`. Depuis P001 c'est un dépôt git dont le code vit dans
  `src/` (`core/`, `sim/`, `speaker/`, `render/`, `app/`), les tests dans `tests/`, les outils dans
  `tools/`. Les trois documents de référence restent à la racine.
* Node `v26.5.0`, npm `11.17.0`, pnpm `11.23.0` sont installés.
* **La politique d'exécution PowerShell de ce poste bloque `npm.ps1` et `pnpm.ps1`.** Utiliser les
  shims `.cmd` : `npm.cmd`, `pnpm.cmd`, `npx.cmd`. Ne pas modifier la politique d'exécution de la
  machine pour contourner cela ; documenter la commande exacte dans `README.md`.
* Écrire les fichiers avec les outils fichier du harnais, pas via des redirections shell
  (`>`, `Out-File`), qui produisent des encodages inattendus.
* Encodage : **UTF-8 sans BOM** pour tous les fichiers texte (les textes français contiennent des
  accents). Vérifier l'encodage si un test E2E compare des chaînes françaises.
* Le rendu se teste dans Chromium headless par défaut ; ne pas installer de navigateur
  supplémentaire sans nécessité.
* **Tout doit rester dans le workspace.** Les caches et artefacts sont locaux au projet et ignorés
  par git : `.npm-cache/` (npm), `.pnpm-store/` (pnpm), `.playwright-browsers/` (navigateurs),
  `.tmp/` (fichiers temporaires), `test-results/`, `playwright-report/`, `coverage/`, `dist/`.
  Aucune installation globale (`npm install -g`), aucune modification de la configuration git
  globale, aucun port sur `0.0.0.0`, aucune modification du pare-feu Windows.
* **Piège npm : `.npmrc` seul ne suffit pas.** Une variable d'environnement `npm_config_cache`
  injectée dans le shell est **prioritaire** sur `.npmrc` et renvoie le cache vers
  `AppData\Local\npm-cache` (hors workspace, donc refusé par le bac à sable). Avant tout `npm.cmd`,
  faire `Remove-Item Env:npm_config_cache -ErrorAction SilentlyContinue` pour que
  `cache=.npm-cache` s'applique.
* **pnpm n'est pas utilisé en V1** : npm fait foi. La clé `store-dir` a été retirée de `.npmrc`
  parce que npm ne la connaît pas et émettait `Unknown project config "store-dir"` à chaque
  commande. Si pnpm est adopté plus tard, rendre son store local au projet **sans** polluer la
  configuration lue par npm (par exemple via `pnpm-workspace.yaml`), et garder `.pnpm-store/` dans
  `.gitignore`.
* **Bac à sable : les tubes nommés sont interdits.** Vite, Vitest et Playwright lancent tous des
  processus enfants avec `stdio` en tube (IPC), ce qui échoue en `spawn EPERM` en mode
  `workspace-write`. C'est une limite du bac à sable, **pas un problème de chemin** : rien ne peut
  être déplacé dans le workspace pour l'éviter. `npm run verify` doit donc être exécuté avec un
  accès complet. Ne pas contourner en modifiant la configuration du projet (essayé :
  `resolve.preserveSymlinks` ne corrige rien, le plantage a lieu pendant le bundling du fichier de
  configuration, avant sa lecture).
* **`git push` relève de la même limite.** L'opération réseau elle-même n'est pas le problème : Git
  pour Windows lance ses utilitaires MSYS (`sh.exe`, `bash.exe`), qui ne parviennent pas à créer
  leur *signal pipe* et échouent en `couldn't create signal pipe, Win32 error 5`, suivi d'un
  `could not read Username for 'https://github.com'` trompeur. Le push fonctionne avec un accès
  complet (les identifiants déjà stockés par le gestionnaire Windows sont alors utilisés). Ne jamais
  configurer de gestionnaire d'identifiants global pour contourner cela.
* **Navigateurs Playwright : installés dans `.playwright-browsers`, jamais dans AppData.**
  `.playwright.env` définit `PLAYWRIGHT_BROWSERS_PATH`, chargé par les scripts npm via
  `node --env-file=.playwright.env`. `playwright install` lui-même **échoue** dans le bac à sable
  (téléchargement via processus forké + IPC) : la procédure manuelle est décrite dans `README.md`.
  Chromium est le seul navigateur nécessaire ; ne pas installer Firefox ni WebKit par anticipation.
* `$env:TEMP` / `$env:TMP` peuvent être redirigés ponctuellement vers `$PWD\.tmp` pour une commande
  (Chromium y écrit alors son profil). **Ne jamais modifier les variables globales de Windows.**

---

## 10. Périmètre produit (V1) — rappel

**Dans le périmètre** : 6 personnages, une course déclenchée par un seul MJ, 4 segments de 45 s,
3 checkpoints avec pause automatique, arrivée + podium, moteur de simulation pur et testable,
speaker à cooldowns, seed reproductible visible, mode test accéléré, PWA installable hors ligne,
responsive desktop + smartphone paysage.

**Hors périmètre (V1)** : multijoueur, synchronisation entre spectateurs, backend, base de données,
comptes utilisateurs, classements en ligne, monétisation, réseau social, traduction, éditeur de
personnages, caractéristiques permanentes par personnage, progression persistante.

Toute demande sortant de ce périmètre : la signaler, proposer de l'ajouter au backlog de
`ROADMAP.md`, et **ne pas l'implémenter** sans accord.

---

## 11. Résumé opérationnel (à relire avant chaque session)

1. Lire `ROADMAP.md`, trouver l'étape autorisée, la passer en `[~]`.
2. Implémenter **uniquement** cette étape.
3. Écrire les tests de l'étape ; les faire passer ; ne rien casser.
4. `npm run verify` vert, aucune erreur, aucun test désactivé, aucune dépendance ajoutée sans accord.
5. Vérifier les 12 invariants du §5 (dont progressivité **directionnelle**, fin de course par le
   temps, et responsabilité du temps).
6. Commit `P0xx: ...`, étape en `[x]`, compte rendu, proposition de l'étape suivante.
7. **S'arrêter et attendre l'autorisation.**
