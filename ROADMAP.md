# CHAOS RACE — Architecture & Roadmap

Voir `GAME_DESIGN.md` pour les règles de jeu (normatif) et `AGENTS.md` pour les règles de travail.

---

## Partie A — Architecture proposée

### A.1 Objectifs d'architecture

1. **Le moteur de simulation ne dépend pas de Phaser** (ni du DOM, ni d'une horloge) : il doit tourner
   dans Node pour être testé, et pouvoir être déplacé plus tard côté serveur.
2. **Séparation stricte simulation / rendu** : le rendu lit l'état, il ne l'écrit jamais.
3. **Séparation stricte temps simulé / temps réel** : le noyau ne connaît que des pas fixes ; seule
   `RaceSimulation` connaît le temps réel, les pauses et le `timeScale` (§A.5).
4. **Déterminisme total** : `(seed, config)` ⇒ course identique, indépendamment du framerate.
5. **Simplicité** : peu de fichiers, peu de dépendances, chaque module testable seul.
6. **Préparation serveur sans sur-ingénierie** : un état sérialisable + un flux de faits, rien de plus.

### A.2 Arborescence cible

```
chaos-race/
  index.html
  package.json
  tsconfig.json               # strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes
  vite.config.ts
  vitest.config.ts
  playwright.config.ts
  public/
    icons/                    # icônes PWA (locales, aucun CDN)
    audio/                    # sons locaux optionnels (P015)
  src/
    core/                     # NOYAU PUR — zéro dépendance, zéro Phaser, zéro DOM, zéro horloge
      types.ts                #   CharacterId, CharacterState, RaceState, RacePhase, ActiveEvent, RaceFact, RaceResult
      config.ts               #   RACE_CONFIG (temps SIMULÉ) + SPEED/DRIFT/SURGE/EVENT/RANK/OVERTAKE
      characters.ts           #   roster des 6 (données pures)
      rng.ts                  #   hash32, splitmix32, sfc32, RngStream, fork(seed, label)
      math.ts                 #   clamp, lerp, approach(up/down), gaussian, stepOu
      track.ts                #   structure TEMPORELLE : segments, instants de checkpoint, tSim total
      ranking.ts              #   rang, écarts (fonctions pures sur les distances)
      overtakes.ts            #   OvertakeTracker : hystérésis par paire (état observationnel borné)
      speedModel.ts           #   drift + surge + event ⇒ v_cible ⇒ v (rampe) ⇒ x
      events.ts               #   catalogue, tirage pondéré, planificateur, cooldowns
      observer.ts             #   détection des faits + buffer d'historique borné
      engine.ts               #   RaceEngine : step() sans argument, tSim, segments, finished à 60 s
      index.ts                #   surface publique du noyau
    sim/                      # TEMPS RÉEL (pas de Phaser)
      config.ts               #   SIM_CONFIG : countdown, pauses réelles, timeScale, mode test
      RaceSimulation.ts       #   accumulateur, countdown, pauses, timeScale, restart, runToCompletion
      testHooks.ts            #   window.__CHAOS_RACE__ (dev/e2e uniquement)
    speaker/                  # PUR — ne reçoit que des RaceFact
      importance.ts           #   score d'importance (fait + contexte)
      cooldowns.ts            #   cooldown global, par type, dédup, quotas
      Speaker.ts              #   file de répliques, arbitrage, préemption
    render/                   # PHASER — lecture seule
      Game.ts                 #   création du jeu Phaser, Scale.FIT
      format.ts               #   mise en forme d'affichage (arrondis) — jamais une valeur de simulation
      viewConfig.ts           #   VIEW.NOMINAL_SCALE_M = 720 m (dimensionnement DÉCOR uniquement)
      scenes/BootScene.ts
      scenes/RaceScene.ts
      scenes/FinishScene.ts
      view/TrackView.ts       #   sol, repères de distance décoratifs, décor
      view/CharacterSprite.ts #   1 sprite = 1 personnage, animation selon son état
      view/CameraRig.ts       #   suivi du peloton, zoom borné, marqueurs de bord
      view/Hud.ts             #   classement, chrono, segment, seed, bandeau checkpoint
      view/SubtitleBanner.ts  #   affichage des répliques du speaker (bande compacte)
      view/EventFeedback.ts   #   retour TURBO/CHUTE attaché au personnage (lecture seule)
      view/DebugPanel.ts      #   panneau debug (seed, tSim, x, v, modificateurs)
    app/
      main.ts                 #   bootstrap : URL params, seed, création sim + Phaser, input
      strings.fr.ts           #   TOUS les textes visibles (FR)
      settings.ts             #   localStorage : dernier seed, son, commentateur (n'affecte jamais la sim)
      SettingsPanel.ts        #   réglages `Son` / `Commentateur` (activé / coupé)
      sound.ts                #   klaxon de confirmation (Web Audio synthétisé, aucun asset)
      tts.ts                  #   synthèse vocale locale (rate centralisé, désactivée par défaut)
      pwa.ts                  #   enregistrement service worker + prompt d'installation
    styles.css                #   layout, safe-areas, overlay portrait, boutons ≥ 44px
  tests/
    unit/                     #   vitest — noyau, speaker, sim, garde-fous
    e2e/                      #   playwright — parcours réels dans un navigateur
  tools/
    balance.ts                #   harnais statistique (1000 seeds) hors navigateur
    blender/                  #   (PLUS TARD, P019+) scripts bpy reproductibles — jamais en P001
  docs/
    ARCHITECTURE.md           #   (P018) contrat de sérialisation + préparation serveur
  GAME_DESIGN.md  ROADMAP.md  AGENTS.md  README.md
```

### A.3 Dépendances entre couches (sens unique, jamais l'inverse)

```
app/  ──▶  sim/  ──▶  core/
  │         │
  ├──▶  render/ ──▶  sim/ (lecture seule)  +  speaker/ (lecture des répliques)
  └──▶  speaker/ ──▶  core/types.ts (RaceFact uniquement)

core/  ──▶  RIEN (aucun import hors de core/)
sim/   ──▶  core/ uniquement (jamais render/)
```

Règles vérifiées par test (`tests/unit/boundaries.test.ts`, P002) :

* `src/core/**` n'importe jamais `phaser`, `../render`, `../app`, `../sim`, ni un global navigateur.
* `src/core/**` ne contient jamais `Math.random`, `Date.now`, `performance.now`, `setTimeout`,
  `setInterval`, `requestAnimationFrame`.
* `src/core/**` ne contient **jamais** de durée de pause réelle, de compte à rebours ni de `timeScale`
  (ce sont des valeurs de `SIM_CONFIG`, qui vit dans `src/sim/`).
* `src/core/**` ne contient **aucune** constante de type `FINISH_DISTANCE` ni de condition de fin
  basée sur une distance.
* `src/speaker/**` n'importe jamais `core/engine`, `core/speedModel`, `core/events` : seulement
  `core/types` (donc aucun accès à l'état, donc aucune réplique inventée possible).
* `src/render/**` n'importe jamais une fonction d'écriture du noyau ; il reçoit un état `Readonly`.

### A.4 Le contrat central

```ts
// core/types.ts (esquisse)

/** Phase du NOYAU : ne connaît que le temps simulé. Aucune notion de pause. */
export type RacePhase =
  | { kind: 'idle' }
  | { kind: 'running'; segment: 1 | 2 | 3; segmentElapsedS: number }
  | { kind: 'finished' };            // atteint si et seulement si tSim >= 60

export interface CharacterState {
  readonly id: CharacterId;          // index stable 0..5
  x: number;                         // distance (m) — seule source du classement
  v: number;                         // vitesse (m/s)
  drift: number; surge: number; eventBonus: number;
  activeEvent: ActiveEvent | null;
}

export interface RaceState {
  readonly seed: string;
  readonly seedValue: number;
  tSim: number;                      // temps SIMULÉ cumulé (s)
  steps: number;                     // nombre de pas exécutés
  phase: RacePhase;
  characters: readonly CharacterState[];   // ordre = index stable
}
```

```ts
// sim/RaceSimulation.ts (esquisse) — seule couche qui connaît le TEMPS RÉEL
export type SimPhase =
  | 'idle' | 'countdown' | 'running' | 'checkpointPause' | 'userPaused' | 'finished';

export interface SimConfig {
  countdownRealS: number;
  checkpointPauseRealS: number;
  timeScale: number;
  maxStepsPerFrame: number;
}
```

`RaceEngine` (noyau, `src/core/engine.ts`) — **aucune horloge, aucune pause** :

```ts
class RaceEngine {
  constructor(seed: string, config?: RaceConfig);
  step(): void;                          // avance d'EXACTEMENT un DT. Aucun argument.
  runToCompletion(): RaceResult;         // 3 600 pas, sans rendu ni pause
  getState(): Readonly<RaceState>;
  drainFacts(): readonly RaceFact[];     // faits produits par les pas écoulés
  serialize(): string; deserialize(s: string): void;   // préparation serveur (P018)
}
```

`RaceSimulation` (`src/sim/`) — temps réel, pauses, mode test :

```ts
class RaceSimulation {
  update(realDtMs: number): void;   // accumulateur : floor(acc / DT) pas, borné par maxStepsPerFrame
  setTimeScale(n: number): void;    // plus de pas par frame, DT INCHANGÉ
  pause(): void; resume(): void;    // n'appelle simplement plus engine.step()
  restart(seed?: string): void;
  readonly simPhase: SimPhase;      // état TEMPS RÉEL (countdown, checkpointPause, userPaused…)
  readonly view: Readonly<RaceState>;   // état NOYAU (tSim, segment, distances)
}
```

### A.5 Responsabilité du temps (règle structurante)

| | `RaceEngine` | `RaceSimulation` |
| --- | --- | --- |
| Temps | **simulé** | **réel** |
| Avance | `step()` = 1 pas de `DT`, sans argument | `update(realDtMs)` = `floor(acc / DT)` pas |
| Countdown | inconnu | géré |
| Pause checkpoint | inconnu (signale seulement l'instant `tSim = 20/40`) | décidée, chronométrée, reprise automatique |
| Pause utilisateur | inconnu | suspend l'appel à `step()` |
| Mode test / `timeScale` | inconnu | nombre de pas par frame |
| Effet d'une pause | **aucun** : le noyau n'est pas appelé | gèle `tSim`, `x`, `v` |

**Conséquence non négociable** : une pause réelle ne fait jamais avancer ni modifier `RaceEngine`.
Le nombre total de pas d'une course est donc toujours `3 600`, avec ou sans pauses, et le résultat
est identique.

### A.6 Choix techniques et justification

| Sujet | Choix | Pourquoi |
| --- | --- | --- |
| Build | **Vite** + TypeScript `strict` | demandé, rapide, zéro config superflue |
| Rendu | **Phaser 4.2.1** (version installée) | demandé ; scènes + sprites adaptés au rendu 2D. Le projet est neuf : **aucune compatibilité Phaser 3 à préserver**. Voir la règle Phaser ci-dessous |
| PWA | **`vite-plugin-pwa`** (Workbox) | installable + offline avec une seule dépendance standard |
| Tests unitaires | **Vitest** | *validé par l'utilisateur* : le noyau doit être testable sans navigateur, et Vitest partage la config Vite |
| Tests E2E | **Playwright** | demandé ; projets desktop + smartphone paysage |
| Lint | **aucun** (pas d'ESLint en V1) | *validé par l'utilisateur* : `tsc --noEmit` + tests suffisent ; les garde-fous d'architecture sont des tests, pas un linter |
| Audio / TTS | **désactivés par défaut** | *validé par l'utilisateur* ; l'audio reste optionnel et n'est jamais requis pour comprendre |
| État global | aucun (pas de store) | l'état vit dans `RaceEngine`, exposé en lecture seule |
| Persistance | `localStorage` (seed, muet, TTS) | aucune base de données ; n'influence jamais la simulation |
| Backend | aucun | V1 100 % locale ; l'API `serialize()` prépare la suite |
| Langue | code/identifiants/commits en anglais, textes visibles en français (`strings.fr.ts`), docs en français | lisibilité + centralisation des traductions |
| Assets 3D | Blender local possible **plus tard** (`bpy`, scripts dans `tools/blender/`) | voir `AGENTS.md` §3.7 — jamais en P001, jamais d'influence sur la simulation |

#### Règle Phaser (V1)

* **Phaser 4.2.1 pour la V1**, exactement la version installée (`package.json` → `"phaser": "^4.2.1"`).
* Le projet est **neuf** : il n'y a **aucune compatibilité Phaser 3 à préserver**. Ne pas downgrader,
  ne pas ajouter de couche de compatibilité, ne pas conserver d'API obsolète par précaution.
* **Ne pas changer de version majeure de Phaser sans autorisation explicite de l'utilisateur.**
  Une montée de correctif reste possible dans la plage `^4.2.1`.
* **Utiliser les API et les imports Phaser 4.** Import nommé depuis le paquet (`phaser` expose des
  exports ESM nommés), par exemple :
  ```ts
  import { AUTO, Game, Scene } from 'phaser';
  ```
  Éviter `import Phaser from 'phaser'` (export par défaut), qui ne correspond pas aux types du paquet.
* **Ne jamais recopier aveuglément un exemple Phaser 3** trouvé en ligne : la documentation et les
  exemples antérieurs à la version 4 peuvent utiliser des API renommées, déplacées ou supprimées.
  En cas de doute, se référer aux types installés (`node_modules/phaser/types/phaser.d.ts`) ou à la
  documentation de la version 4, et vérifier par `npm run typecheck`.
* `src/render/` reste **lecture seule** (voir `AGENTS.md` §4) : le choix de Phaser ne change rien à
  cette frontière, ni au fait que le noyau et `sim/` n'importent jamais Phaser.

### A.7 Reproductibilité : comment elle est garantie

1. Un seul générateur (`sfc32`) et des **streams nommés** dérivés de `hash(seed + ':' + label)` :
   ajouter un appel dans un stream ne décale aucun autre stream.
2. Boucle à **pas fixe** : `DT = 1/60 s`. Le `timeScale` ne change que le nombre de pas par frame.
3. `step()` ne prend aucun argument de temps : il est impossible d'injecter un `dt` variable.
4. Aucune itération de `Set`/`Map` dans la physique ; tableaux à indices stables.
5. Aucune horloge dans `core/`.
6. Le rendu et les textes ont leurs propres streams (`cosmetic`, `speaker:lines`) ⇒ modifier un
   visuel ou un texte ne change **jamais** le résultat d'une course.
7. Test de non-régression : une table de seeds « dorées » (seed ⇒ distances finales arrondies)
   vérifiée à chaque exécution des tests. Si un changement de règle la casse, la table est mise à jour
   **volontairement**, jamais par opportunisme.

### A.8 Préparation à un futur mode « plusieurs spectateurs »

Non implémenté en V1, mais rien ne le bloque :

* `RaceEngine` est une machine à états pure et pas-à-pas : un serveur peut exécuter les mêmes pas et
  diffuser soit des **snapshots** (`state` + `steps`), soit le **flux de faits** (`RaceFact[]`).
* `serialize()/deserialize()` permettent de reprendre une course à n'importe quel pas.
* Le rendu ne consomme que `RaceState` + `RaceFact` + les répliques : côté spectateur, `sim/` serait
  remplacé par un client réseau, `render/` inchangé. Comme les pauses vivent dans `sim/`, le serveur
  décide du rythme sans toucher au noyau.
* Le speaker reste identique (il ne dépend que des faits, pas du moteur) : les commentaires sont donc
  déterministes et identiques pour tous les spectateurs.

---

## Partie B — Roadmap

> **Note de réorganisation (révision 2).** La roadmap a été réordonnée sur demande explicite de
> l'utilisateur, pour obtenir **une course visible très tôt** (P005) avant les gros événements, le
> speaker, l'équilibrage massif et les graphismes définitifs. C'est la **première** exception
> autorisée à la règle « ne jamais renuméroter » de `AGENTS.md` §1.5 (une seconde suit ci-dessous).
> À partir de maintenant, cette règle s'applique de nouveau : toute nouvelle étape s'ajoute à la fin
> (P019+).
>
> **Note d'insertion (révision 3).** Sur demande explicite de l'utilisateur, un **Jalon 3D** a été
> inséré **juste avant P014**, à l'endroit où il est décidé, afin de trancher le moteur de rendu
> **avant** de produire les graphismes définitifs. C'est une **seconde exception**, elle aussi
> explicitement demandée, à la règle « ne jamais renuméroter » de `AGENTS.md` §1.5. Elle
> n'entraîne **aucune renumérotation** : le jalon porte l'identifiant `P013.5`, les étapes existantes
> gardent leur numéro. Après lui, la règle s'applique de nouveau (P019+).

Règles : **une étape à la fois**, jamais deux en parallèle, chaque étape est terminée quand ses tests
et tous les tests précédents passent (voir `AGENTS.md`). Statuts : `[ ]` à faire, `[~]` en cours,
`[x]` terminé.

### Vue d'ensemble

| # | Étape | Dépend de | Livrable principal |
| --- | --- | --- | --- |
| P001 | Scaffolding, scripts et garde-fous | — | projet qui build, typecheck, teste |
| P002 | Seed, RNG déterministe, garde-fous de frontière | P001 | `core/rng.ts` + test de frontière |
| P003 | Types, config (temps simulé / temps réel), piste temporelle, classement | P002 | `core/config.ts`, `core/track.ts`, `core/ranking.ts` |
| P004 | Moteur minimal + modèle de vitesse (base + dérive + rampes) | P003 | `core/engine.ts` déterministe, fin au temps simulé total |
| **P005** | **Première course visible : `RaceSimulation` minimale + rendu Phaser minimal + classement** | P004 | **6 formes qui courent, se dépassent, classement à l'écran** |
| P006 | Structure en segments + checkpoints (segments au noyau, pauses réelles dans `sim/`) | P005 | 3 segments, 2 pauses automatiques |
| P007 | Variations occasionnelles (surges) | P006 | accélérations/ralentissements ponctuels |
| P008 | Événements rares + planificateur | P007 | turbos, chutes, raccourcis |
| P009 | Observateur de faits + speaker *(P009-A ✅ observateur, P009-B ✅ speaker, P009-C ⏳ textes)* | P008 | commentaires à cooldowns |
| P010 | Équilibrage statistique + verrouillage des constantes `[x]` *(25/25 critères sur 1000 seeds)* | P009 | `tools/balance.ts` + seuils testés |
| P011 | HUD complet + panneau debug `[x]` | P010 | classement détaillé, chrono (mini-carte retirée depuis la passe corrective) |
| P012 | Affichage du speaker + réglages `[x]` | P011 | bande de commentaires |
| P013 | Arrivée et podium `[x]` | P012 | course complète jouable |
| **P013-cor** | **Passe corrective après le premier test joueur manuel `[x]`** | P013 | course de 60 s, HUD dégagé, retours d'événement, son et commentateur explicites |
| **P013-cor2** | **Seconde passe corrective après le second test joueur manuel `[x]`** | P013-cor | commentaire véridique sur la position, relecture pendant la pause, classement hors piste, segment d'arrivée |
| **P013.5** | **Jalon 3D — prototype de rendu : choix du moteur** | P013 | prototype 3D minimal + décision A/B/C |
| P014 | Identité visuelle et animations des 6 personnages | P013.5 | personnages distincts et drôles |
| P015 | Polish, accessibilité, audio optionnel | P014 | finition |
| P016 | PWA installable, paysage, offline | P015 | installable sur téléphone |
| P017 | E2E complets + budget de performance | P016 | non-régression bout en bout |
| P018 | Sérialisation, préparation serveur, docs finales | P017 | V1 stable documentée |
| P019+ | *(backlog)* Blender, mode drame, multi-spectateurs… | P018 | voir backlog |

> **Les lignes ci-dessus décrivent l'état au moment de leur étape.** La passe corrective
> **P013-cor** (issue du premier test joueur manuel après P013) a ramené la course de `180 s`
> (4 × 45 s, 3 checkpoints) à **`60 s` (3 × 20 s, 2 checkpoints)** : là où une description d'étape
> antérieure mentionne `180 s`, `10800` pas, `4 × 45 s` ou `2160 m`, c'est un **compte rendu
> historique**, pas l'état courant. Les valeurs courantes sont celles de `GAME_DESIGN.md` §4 et §13.

**Jalon clé : à la fin de P005, on doit pouvoir juger si les mouvements et les dépassements sont
amusants à regarder.** Aucune étape lourde (événements, speaker, équilibrage, graphismes) ne doit
être commencée avant d'avoir ce verdict.

**Second jalon clé : P013.5.** Le moteur de rendu (2D ou 3D) se décide **sur prototype**, jamais sur
documentation. Aucun travail artistique lourd (P014) ne doit commencer avant cette décision.

---

### P001 — Scaffolding, scripts et garde-fous `[x]`

**Objectif** : un projet vide mais sain : il build, il typecheck, il teste, il se lance.

**Livrables**
* `git init` (le dossier n'est pas encore un dépôt) + `.gitignore` (`node_modules`, `dist`,
  `test-results`, `playwright-report`, `.vite`).
* `package.json` : Vite, TypeScript, Phaser, `vite-plugin-pwa`, Vitest, `@playwright/test`.
  *(toutes validées par l'utilisateur ; aucune autre dépendance.)*
* `tsconfig.json` strict (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `noImplicitOverride`, `verbatimModuleSyntax`, `noFallthroughCasesInSwitch`), `vite.config.ts`,
  `vitest.config.ts`, `playwright.config.ts`.
* `index.html` + `src/styles.css` + `src/app/main.ts` : page minimale montrant un canvas Phaser vide
  et le titre « Chaos Race ». Aucune logique de course.
* Scripts npm : `dev`, `build`, `preview`, `typecheck`, `test` (unit), `test:e2e`, `verify`
  (= `typecheck && test && build && test:e2e`).
* `README.md` : commandes exactes, y compris le contournement PowerShell propre à ce poste
  (`npm.ps1`/`pnpm.ps1` bloqués par l'ExecutionPolicy ⇒ utiliser `npm.cmd` / `pnpm.cmd`).
* Création des dossiers `src/core`, `src/sim`, `src/speaker`, `src/render`, `src/app`, `tests/unit`,
  `tests/e2e`, `tools` — même vides de contenu logique : ils matérialisent l'architecture cible.

**Tests (DoD)**
* `npm run typecheck` passe.
* `tests/unit/smoke.test.ts` : 1 test trivial sur une fonction pure (ex. `clamp`).
* `tests/e2e/boot.spec.ts` : la page charge, le canvas Phaser est présent, aucun message d'erreur
  console, le titre est affiché.
* `npm run build` produit un `dist/` servi correctement par `npm run preview` (vérifié par un test E2E
  en mode preview, ou en `dev` — décider et documenter).

**Hors périmètre** : toute simulation, tout personnage, tout rendu de piste, aucun asset, aucun
Blender.

---

### P002 — Seed, RNG déterministe, garde-fous de frontière `[x]`

**Objectif** : la base de la reproductibilité, et le mur qui protège le noyau.

**Livrables**
* `src/core/rng.ts` : `hash32(str)`, `splitmix32`, `sfc32`, classe `RngStream` (`next()`,
  `nextFloat()`, `nextInt(min,max)`, `nextGaussian()`, `pick<T>(arr)`, `weightedPick`),
  `forkStream(seed, label)`.
* `src/core/seed.ts` : seed affichée en 8 caractères Base32 Crockford (**source de vérité**) ⇄ seed
  interne 32 bits par hachage ; toute entrée est acceptée (hachée).
* Affichage de la seed + lecture de `?seed=` dans `app/main.ts`.
* `tests/unit/boundaries.test.ts` : scan des fichiers par `node:fs` et échec si `src/core/**`
  contient `phaser`, `window`, `document`, `Math.random`, `Date.now`, `performance.now`,
  `setTimeout`, `setInterval`, `requestAnimationFrame`, `timeScale`, `countdown`, `finishDistance`,
  ou importe `../render`, `../app`, `../sim`.
* `docs/ARCHITECTURE.md` : amorce (règles de dépendance).

**Tests (DoD)**
* Même seed ⇒ 10 000 valeurs identiques ; seeds différentes ⇒ séquences différentes.
* Les streams `drift:c0` et `events:global` sont indépendants : consommer 1000 valeurs de l'un ne
  change pas la séquence de l'autre. Idem pour l'ordre d'appel.
* Distribution : `nextFloat` moyenne ∈ [0,49 ; 0,51] et variance ≈ 1/12 sur 100 000 tirages ;
  `nextGaussian` moyenne ≈ 0, écart-type ≈ 1 (±2 %).
* `weightedPick` respecte les poids à ±2 % sur 100 000 tirages.
* La seed affichée correspond au paramètre d'URL et survit au rechargement.
* Le test de frontière passe, **et échoue bien** si on injecte volontairement un `Math.random` dans
  `core/` (vérifier le test lui-même, puis retirer l'injection).

**Passe corrective (même étape)** : le bruit gaussien n'utilise plus Box-Muller mais une **somme de
12 tirages uniformes** (multiples exacts de `2^-32`, donc reproductibles d'un moteur JavaScript à
l'autre) ; le garde-fou interdit désormais aussi les **fonctions transcendantes** dans le noyau ; le
contrat de seed est clarifié — la seed affichée est la source de vérité, `seedToText` est remplacé
par `seedTextFromBytes`. Détails dans `GAME_DESIGN.md` §10.

---

### P003 — Types, configuration, piste temporelle et classement `[x]`

**Objectif** : toutes les constantes du jeu au bon endroit, et un classement purement dérivé.

**Livrables**
* `src/core/types.ts` : `CharacterId`, `CharacterState`, `RaceState`, `RacePhase`
  (`idle` / `running{segment, segmentElapsedS}` / `finished` — **aucun état de pause**),
  `ActiveEvent`, `RaceFact`, `RaceResult`.
* `src/core/config.ts` :
  * `RACE_CONFIG` : `SEGMENT_COUNT`, `SEGMENT_DURATION_S`, `TOTAL_SIM_S`, `DT_S`,
    `STEPS_PER_SEGMENT`, `TOTAL_STEPS` ;
  * `SPEED`, `DRIFT`, `SURGE`, `EVENT`, `RANK`, `OVERTAKE`, `LEADER`, `SPEAK` (constantes de jeu) ;
  * `validateConfig()` ;
  * objet gelé profondément (`Object.freeze`).
  * **Aucune** constante `FINISH_DISTANCE` ; **aucune** durée réelle (countdown / pause / `timeScale`),
    qui appartiennent à `SIM_CONFIG` dans `src/sim/config.ts` (P005).
* `src/core/characters.ts` : roster des 6 (id stable, nom provisoire, couleur), figé.
* `src/core/track.ts` : **structure temporelle uniquement** — `segmentIndexAt(tSim)`,
  `segmentElapsedS(tSim)`, `isCheckpointInstant(tSim)` (vrai à `tSim = 45`, `90`, `135`),
  `isRaceOver(tSim)` (`tSim >= TOTAL_SIM_S`). **Aucune fonction de distance, aucun repère de décor.**
* `src/core/ranking.ts` : `computeRanks(xs, ids)`, `gapMeters`, `gapSeconds`, `isLeaderChange`,
  `sortByRank`. Fonctions **pures**, sans état. Le comptage des dépassements (`overtakesBetween`) a
  été **remplacé avant P009** par `src/core/overtakes.ts` (`OvertakeTracker`) — voir § Backlog.

**Tests (DoD)**
* 4 × 45 = 180 s ; `STEPS_PER_SEGMENT = 2700` ; `TOTAL_STEPS = 10800`.
* `segmentIndexAt` et `segmentElapsedS` exacts aux bornes (44,999 / 45,000 / 45,001 ; 179,999 /
  180,000 / 180,001), y compris juste avant et juste après un instant de checkpoint.
* `isRaceOver(tSim)` est vrai **à partir de** `tSim = 180` et seulement là : aucune distance
  n'intervient dans cette fonction.
* `RACE_CONFIG` ne contient aucune clé dont le nom évoque une durée réelle ou une distance d'arrivée
  (test explicite sur les clés).
* Les 6 configurations de personnages sont structurellement identiques (équivalence).
* `validateConfig()` rejette une config incohérente (`SPEED.MIN > SPEED.BASE`, poids ≤ 0,
  `MAX_DECEL <= 0`, `TOTAL_STEPS != TOTAL_SIM_S / DT_S`, etc.).
* Classement : tri décroissant, égalité stricte départagée par index croissant, stabilité.
* Propriété (*property test* sur 10 000 tableaux aléatoires) : `rang_i < rang_j ⇔ (x_i, i) > (x_j, j)`
  — le classement est bien une fonction des seules distances.
* `gapSeconds` cohérent (`gap_m / SPEED.BASE`), jamais négatif pour le leader.
* Dépassements : hystérésis à `OVERTAKE.MIN_MARGIN = 0,5 m` respectée ; un bruit autour de zéro et
  deux personnages qui s'échangent leur rang 100 fois de suite sous la marge ne produisent **aucun**
  dépassement compté (tests dans `tests/unit/overtakes.test.ts`).
* Test explicite « pas de téléportation » : un tableau de distances fixes produit toujours le même
  classement, quel que soit l'historique ou l'ordre d'appel.

---

### P004 — Moteur minimal + modèle de vitesse `[x]`

**Objectif** : un noyau déterministe qui fait courir 6 personnages pendant 180 s de temps simulé, avec
des vitesses qui varient **progressivement** et produisent des dépassements naturels. Pas encore de
segments officiels, pas de checkpoints, pas d'événements, pas de rendu.

**Livrables**
* `src/core/math.ts` : `clamp`, `lerp`, `gaussianFrom(rng)`, `stepOrnsteinUhlenbeck(...)`, et
  **`approach(current, target, upRate, downRate, dt)`** implémentant la progressivité directionnelle
  du §6.2 de `GAME_DESIGN.md` (deux limites distinctes selon la direction).
* `src/core/speedModel.ts` : `computeTargetSpeed(char, config)`
  (`SPEED.BASE × (1 + drift)`), `integrateSpeed(prevV, targetV, config, dt)`,
  `integratePosition(x, v, dt)`. Les surges et événements viendront en P007/P008.
* `src/core/engine.ts` : `RaceEngine` — un seul segment continu de 180 s de temps simulé,
  `step()` **sans argument** avançant d'exactement `DT`, `tSim`, `steps`,
  `phase: 'idle' | 'running' | 'finished'` avec `finished` atteint **si et seulement si**
  `tSim >= TOTAL_SIM_S`, `runToCompletion()`, `getState()`, `drainFacts()` (vide pour l'instant),
  `reset(seed)`. **Aucune notion de pause, de temps réel, d'horloge.**
* `tests/unit/fixtures/golden-seeds.json` : table de seeds dorées (seed ⇒ distances finales),
  introduite dès que le moteur est déterministe.

**Tests (DoD)**
* **Progressivité directionnelle** : sur 50 000 pas avec des cibles exagérées, on vérifie
  `Δv <= MAX_ACCEL × DT` quand `Δv >= 0` et `−Δv <= MAX_DECEL × DT` quand `Δv < 0`.
  Un test dédié échoue si l'on applique `MAX_ACCEL` aux deux directions (test de non-régression de
  cette correction).
* `SPEED.MIN <= v <= SPEED.MAX` toujours.
* Dérive : sur 30 000 pas, moyenne de `drift` ≈ 0 (±0,01), écart-type stationnaire ≈ 0,127 (±15 %),
  jamais hors de `±CLAMP`.
  * *Correction P004, mesurée* : `CLAMP = 0,20` coupe à 1,57 σ, donc l'écart-type **effectif** du
    drift vaut ≈ 0,100, pas 0,127 (constat détaillé dans `GAME_DESIGN.md` §6.3). Le test compare
    l'écart-type mesuré à cette valeur effective (±15 %), et vérifie **séparément** que le modèle
    retrouve bien 0,127 (±15 %) dès que l'écrêtage est rendu non contraignant. **Aucune constante de
    jeu n'a été modifiée** : élargir `CLAMP` est une décision de game design, pas une correction.
  * *Correction P004, statistique* : la moyenne est agrégée sur 2 160 000 tirages (6 personnages ×
    12 seeds × 30 000 pas). Sur un **seul** processus de 30 000 pas, l'écart-type de la moyenne vaut
    ≈ 0,0126 (temps de corrélation `1/THETA = 4 s`) : le seuil ±0,01 serait franchi une fois sur deux
    par simple bruit, et le test serait donc faux plutôt que strict.
* **Équivalence** : sur 200 000 pas, la vitesse moyenne des 6 personnages reste dans
  `SPEED.BASE ± 1,5 %` (aucun personnage ne « gagne » structurellement).
  * *Correction P004, statistique* : le test porte sur 96 courses, soit 1 036 800 pas. Sur 19 courses
    (205 200 pas), l'écart-type de la moyenne d'un personnage vaut ≈ 0,46 %, ce qui ne laisse que
    3 σ de marge à ±1,5 % : un test fragile, effectivement franchi par une seed du premier jeu
    essayé. Sur 96 courses il tombe à ≈ 0,21 %, et le seuil devient inatteignable par le hasard.
* Départ identique : `drift(0) = 0` ⇒ `x_i(0) = 0` et `v_i(0) = SPEED.BASE` pour les 6.
* Aucune dépendance croisée : simuler `c0` seul puis les 6 ensemble donne le même `x_c0`.
* **Fin par le temps, jamais par la distance** (test central de la correction 1) :
  * `runToCompletion()` fait exactement `10800` pas et `tSim === 180` ;
  * en divisant toutes les vitesses par 10 (config de test), la course dure **toujours** `10800` pas
    et aucune distance ne dépasse ~216 m ;
  * en multipliant la vitesse d'un personnage par 10, la course se termine **au même pas**, quelle que
    soit la distance atteinte ;
  * aucun `x` n'est écrasé ou plafonné à une valeur d'arrivée.
* `step()` ne prend aucun argument (vérification de type + test qu'un `dt` externe n'existe pas).
* Après `finished`, `step()` est un no-op et `steps` ne bouge plus.
* **Reproductibilité** : deux `runToCompletion()` même seed ⇒ distances identiques bit à bit ;
  seeds différentes ⇒ résultats différents ; table de seeds dorées respectée.

---

### P005 — Première course visible (JALON : « est-ce que c'est amusant ? ») `[x]`

**Objectif** : **voir la course le plus tôt possible.** 6 formes simples qui avancent réellement selon
les distances du noyau, se dépassent, avec le classement affiché à l'écran — jugeable avant toute
autre fonctionnalité.

**Livrables**
* `src/sim/config.ts` : `SIM_CONFIG` (`countdownRealS`, `checkpointPauseRealS`, `timeScale`,
  `maxStepsPerFrame`) + presets `normal` et `fast` (mode test).
* `src/sim/RaceSimulation.ts` (version minimale) : accumulateur `acc += realDtMs`,
  `while (acc >= DT) engine.step()`, borne `maxStepsPerFrame`, `setTimeScale`, `restart(seed?)`,
  `runToCompletion(seed)`, `readonly view`. **À ce stade : ni countdown ni pause** (P006).
* `src/sim/testHooks.ts` : `window.__CHAOS_RACE__ = { start, state, ranks, distances, runToCompletion }`
  en dev / `?e2e=1`.
* `src/app/main.ts` : lecture de `?seed=`, `?fast=`, `?debug=`, `?autostart=`, affichage de la seed,
  bouton « Lancer », bouton « Rejouer ».
* `src/render/Game.ts` (`Scale.FIT`, base 1280×720, `autoRound`), `BootScene`, `RaceScene`.
* `src/render/viewConfig.ts` : `VIEW.NOMINAL_SCALE_M = 2160` — **décor et mini-carte uniquement**,
  jamais lu par `core/` ni `sim/`.
* `src/render/view/TrackView.ts` : sol, bandes, défilement. Repères de distance **décoratifs**, avec un
  commentaire explicite « décor : ne conditionne ni la fin de course ni le classement ».
* `src/render/view/CharacterSprite.ts` : 6 placeholders **très simples** mais distincts (rond / carré /
  triangle + couleurs) positionnés **uniquement** par `x`.
* `src/render/view/CameraRig.ts` : suivi du peloton, fenêtre bornée à 260 m, marqueurs de bord.
* **Classement visible à l'écran** : les 6 personnages listés dans l'ordre, avec rang et écart en
  mètres (affichage volontairement brut à ce stade).

**Tests (DoD)**
* E2E `?seed=X&fast=1&autostart=1` : les 6 sprites existent ; leurs positions écran augmentent ; le
  classement affiché correspond **exactement** au classement du noyau exposé par les hooks, à
  plusieurs instants de la course.
  *Correction de formulation (constatée en P005)* : la caméra suit le peloton dans une fenêtre
  bornée (`GAME_DESIGN.md` §5), donc les positions écran **ne peuvent pas** croître indéfiniment —
  le peloton resterait sinon collé au bord droit. Ce qui est vérifié à la place, et qui est plus
  fort : les distances du noyau croissent **strictement et sans jamais décroître** (aucune
  téléportation), et sur **chaque** frame l'ordre des positions écran est exactement l'ordre des
  distances. Aucune constante n'a été modifiée pour obtenir ce résultat.
* **Dépassements visibles** : sur une course `fast=1`, au moins un changement de leader et au moins
  3 dépassements comptés par `core/overtakes.ts` sont observés (seuil volontairement bas à ce stade :
  on vérifie surtout que le mouvement est réellement visible et non figé).
* Mode test neutre : `timeScale = 1` et `timeScale = 20` ⇒ distances finales identiques au bit près.
* Un `realDt` énorme (2 s d'un coup) ne change pas le résultat final.
* `render/` n'écrit jamais dans l'état : assertions sur des `x` inchangés après plusieurs frames +
  test de frontière (aucun import d'écriture dans le noyau).
* Aucune erreur console ; Phaser n'est importé ni par `core/` ni par `sim/`.
* Le canvas s'adapte au redimensionnement (3 tailles testées) et reste lisible en 844×390.
* **Livrable de décision** : une note courte dans le compte rendu de l'étape — « les mouvements et
  les dépassements sont-ils amusants à regarder ? oui / non / à ajuster » — qui conditionne la suite.

**Hors périmètre** : segments et checkpoints (P006), surges (P007), événements (P008), speaker (P009),
vrais graphismes (P014), HUD soigné (P011).

---

### P006 — Structure 4 × 45 s et checkpoints `[x]`

**Objectif** : la structure temporelle officielle du jeu, avec la séparation stricte noyau / temps réel.

**Livrables**
* `src/core/engine.ts` : phase `running{segment, segmentElapsedS}` (segments 1..4) ; fin à
  `tSim = 180 s` ; émission d'un fait `CHECKPOINT_SPLIT` aux pas atteignant `tSim = 45`, `90`, `135`.
  Le noyau **ne s'arrête pas** et **ne connaît aucune durée de pause** : il signale seulement
  l'instant.
* `src/sim/RaceSimulation.ts` : `SimPhase` (`idle`, `countdown`, `running`, `checkpointPause`,
  `userPaused`, `finished`) ; countdown réel `3 s` ; à la réception d'un `CHECKPOINT_SPLIT`, arrêt des
  appels à `step()` pendant `3 s` réelles, puis reprise **automatique** ; pause utilisateur (`Espace`
  ou bouton) ; `timeScale` et presets `fast`.
* `render` : bannière minimale « CHECKPOINT n » pendant la pause (sobre à ce stade).

**Tests (DoD)**
* Noyau : `runToCompletion()` fait toujours exactement `10800` pas, `tSim === 180`.
* Le noyau n'a **aucun** état de pause : `RacePhase` ne contient pas `checkpointPause`
  (assertion de type + test de clés).
* **Aucun pas exécuté pendant une pause** : après une pause checkpoint de 3 s réelles, `steps` et
  toutes les distances sont strictement inchangés (comparaison avant/après).
* Total de pas d'une course avec les 3 pauses réelles = `10800` exactement, et distances finales
  **identiques** à celles d'une course jouée sans pause (même seed).
* Ordre des phases exact : `countdown` → `running(1)` → `checkpointPause(1)` → `running(2)` → …
  → `running(4)` → `finished`.
* Pause utilisateur : distances gelées, `simPhase === 'userPaused'`, reprise correcte, résultat final
  identique.
* **Une pause réelle ne modifie pas `RaceEngine`** : test qui instancie un `RaceEngine`, le met en
  pause 3 s réelles via `RaceSimulation` et vérifie que `steps`, `tSim`, `x` et `v` sont bit-à-bit
  identiques à l'instant de la pause.
* `?fast=1` : pause checkpoint de 0,2 s, countdown de 0 s, et distances finales identiques à ×1.
* E2E : 3 bannières de checkpoint apparaissent, une par pause.

---

### P007 — Surges (variations occasionnelles) `[x]`

**Objectif** : ajouter les petites accélérations / ralentissements ponctuels, en plus de la dérive
permanente déjà présente (P004).

**Livrables**
* Tirage des surges dans `src/core/events.ts` (ou un module dédié) avec les constantes `SURGE.*`, un
  flux `surge:<charId>`, `MAX_ACTIVE_PER_CHARACTER = 1`, `INTERVAL_MIN_S`.
* Application du multiplicateur dans `computeTargetSpeed` (`SPEED.BASE × (1 + drift + surge)`).

**Tests (DoD)**
* Sur 1000 seeds : nombre de surges par personnage sur 180 s ∈ [14 ; 26] (attendu ≈ 20, cohérent avec
  `INTERVAL_MEAN_S = 9`). Si le réglage change, mettre à jour la constante, ce seuil **et**
  `GAME_DESIGN.md` dans le même mouvement.
* Durée de chaque surge dans `[1,5 ; 4,0]`, magnitude dans les bornes, jamais deux surges simultanés
  sur un personnage.
* La progressivité directionnelle (§6.2) tient toujours : les surges passent par la rampe, y compris
  les ralentissements (`MAX_DECEL`).
* Aucun surge tiré ni appliqué pendant une pause (aucun `step()` ⇒ aucun tirage).
* La vitesse moyenne finale par personnage reste `SPEED.BASE ± 1,5 %`.
* Reproductibilité inchangée ; table de seeds dorées mise à jour **explicitement** (avec la raison).

---

### P008 — Événements rares et planificateur `[x]`

**Objectif** : les gros moments. Bonus et malus rares, puissants, sans jamais écrire dans `x`.

**Livrables**
* `src/core/events.ts` : catalogue complet (§7.1), tirage pondéré, planificateur Poisson, cooldowns
  global / par personnage, plafond par course, règle `CHUTE` annule `TURBO`, ciblage **uniforme sans
  dépendance au rang**. Application dans `computeTargetSpeed` (`… + event`).
* Les événements n'écrivent **que** `eventBonus` / `activeEvent` ; seule `integratePosition` écrit `x`.

**Tests (DoD)**
* Mécanismes (vérifiés ici) : sur 1000 seeds, 10 à 16 événements par course ; ≤ 5 par personnage ;
  cooldowns global et par personnage jamais violés ; aucun cumul sauf `CHUTE` sur `TURBO`.
* **Bonus réellement utile**, cohérent avec la formule de gain du §7.2 :
  `MEGA_TURBO` ⇒ gain ≈ `100 ± 10 m` par rapport à un jumeau sans événement ;
  `TURBO` ⇒ gain dans `[25 ; 64] m` ; `RACCOURCI` ⇒ gain dans `[29 ; 56] m`.
* **Gain conservé** : après la fin d'un bonus, la distance ne redescend jamais et l'avance acquise
  reste acquise (comparaison avec un jumeau sur tout l'intervalle restant).
* Malus cohérents : `CHUTE` ⇒ perte dans `[14 ; 42] m`, `SIESTE` ⇒ ≈ `39 m`, `VENT_DE_FACE` ⇒
  `[13 ; 37] m`.
* **Anti-rubber-banding** — deux preuves complémentaires :
  * *structurelle* (la principale) : `stepEvents()` ne reçoit que le planning, le flux, les constantes,
    l'ordre des personnages et le numéro du pas ; ni `x`, ni `v`, ni un rang, ni un écart ne peuvent
    entrer dans une décision. Vérifié par un garde-fou de source sur `src/core/events.ts`
    (signature exacte + aucune citation de classement ou d'état de personnage) et par un test qui
    rejoue **le même flux** en présentant les personnages dans l'ordre d'un « monde » artificiel
    réordonné à chaque pas : pas de déclenchement, identifiants, durées, magnitudes et index tiré
    restent identiques, seule l'identité du personnage suit l'ordre reçu.
  * *statistique* : sur 1000 seeds, la cible du **premier événement de chaque course** est uniforme
    sur les 6 personnages — aucun événement ne s'est encore appliqué, donc les positions ne doivent
    rien aux événements : rang moyen `3,5 ± 0,2` et `≈ 167` cibles par rang (écart-type 11,8).
  * La corrélation littérale « position moyenne vs nombre d'événements » n'est pas utilisable comme
    seuil : elle vaut `−0,13` mesuré sur 1800 couples (course, personnage), parce qu'elle mesure
    l'effet **voulu** des événements sur les positions (§7.2 : « un gros bonus vaut 2 à 5 places »),
    et `−0,10` même en prenant le rang d'avant le premier événement du personnage — les événements des
    autres personnages l'ont déjà déplacé.
* Aucune condition de fin liée à un événement ou à une distance : la course finit à `10800` pas quel
  que soit le nombre d'événements.
* Progressivité directionnelle et bornes de vitesse respectées, y compris pendant `MEGA_TURBO`
  (vérifier que `SPEED.MAX = 48 m/s` n'écrase jamais la cible maximale de `42 m/s`).
* L'équilibrage **statistique** (taux de victoire, écarts, changements de leader) n'est **pas** validé
  ici : il l'est en P010.

---

### P009 — Observateur de faits et speaker `[x]`

**Statut : découpée en trois sous-parties, sans renumérotation.**
* **P009-A ✅ — observateur de faits (terminé)** : `src/core/observer.ts`, l'extension de la section
  `FACT` de `src/core/config.ts`, le micro-correctif d'ordre du `OvertakeTracker`, l'intégration à
  `RaceEngine.step()` / `drainFacts()`, `tests/unit/observer.test.ts` et
  `tests/unit/observerSeeds.test.ts`. Le noyau publie des faits **mesurés**, et rien d'autre : aucun
  texte, aucun cooldown, aucun rendu.
* **P009-B ✅ — speaker (terminé)** : `src/speaker/policy.ts` (politique injectée : source unique des
  constantes de parole, sans import de `core/config`), `src/speaker/importance.ts`,
  `src/speaker/cooldowns.ts`, `src/speaker/Speaker.ts` (score, cooldowns global et par type,
  déduplication, quotas, file de 3, préemption), `tests/unit/speaker.test.ts`,
  `tests/unit/speakerBoundaries.test.ts` et `tests/unit/speakerSeeds.test.ts` (campagne de 200
  courses réelles). Aucun texte, aucun rendu : P009-B ne manipule que des faits et des candidats.
  Trois règles structurent `poll()` : la file est parcourue **dans l'ordre de priorité** jusqu'au
  premier candidat qui passe toutes ses portes (un candidat retenu par son cooldown de type ne fige
  pas la file), `feedAll` admet **tout** un lot avant de parler (un seul `poll`, donc un fait de 60
  du même pas ne peut pas être devancé par un fait de 50), et aucune durée de péremption arbitraire
  n'existe : la seule borne mémoire est `QUEUE_MAX`.
* **P009-C ✅ — textes et affichage (terminé)** : `src/app/strings.fr.ts` (catalogue français,
  3 à 6 variantes par type, fonction pure `RaceFact → string` par variante), `src/app/RaceCommentary.ts`
  (faits → `feedAll` → décision → tirage `speaker:lines` → texte, plus la durée d'affichage réelle),
  `src/render/subtitle.ts` (forme du catalogue et de la ligne), `src/render/view/SubtitleBanner.ts`
  (affichage minimal) et `RaceSimulation.onFacts()` (transmission des faits par lots d'un même pas).
  Tests : `tests/unit/speakerTexts.test.ts`, `tests/unit/speakerRng.test.ts`,
  `tests/unit/commentary.test.ts` et `tests/e2e/speaker.spec.ts`.

  *Note d'intégration* : `RaceSimulation` reste la **seule** à drainer les faits du noyau ; elle les
  transmet à un auditeur (`onFacts`) par lots d'un même pas. `RaceCommentary` (dans `app/`) possède
  le speaker, le flux `speaker:lines` et le catalogue, et le rendu ne fait que lire la ligne courante
  et l'afficher — aucune règle de parole n'est réécrite dans le rendu. La durée d'affichage est un
  temps **réel**, côté UI : elle ne change ni les distances, ni les événements, ni le classement, ce
  qu'un test E2E vérifie en comparant les distances finales d'une course commentée à celles d'une
  course jouée hors rendu. P012 a remplacé la constante fixe `SUBTITLE_DISPLAY_MS = 2600 ms` par une
  durée **adaptée à la longueur de la réplique** (`subtitleDurationMs`, bornée à `[2000 ; 5200] ms`) :
  même nature — purement visuelle —, mais une phrase longue ne disparaît plus avant d'être lisible.

**Objectif** : un speaker qui ne dit que des choses vraies et importantes, avec importance + cooldowns.

**Livrables**
* ✅ `src/core/observer.ts` : historique borné (mémoire constante, toutes les fenêtres en pas entiers)
  et détection de **tous** les faits du §9.2, avec marges et debounces (§8.3) : `LEADER_CHANGE`,
  `BIG_COMEBACK`, `OVERTAKE_STREAK`, `BIG_BONUS`, `LEADER_MALUS`, `CLOSE_RACE`, `LAST_COMEBACK`,
  `CHECKPOINT_SPLIT`, `FINISH`, `PHOTO_FINISH`. Chaque fait porte les valeurs mesurées
  (`characterIds`, `magnitudes`, `tSim`).
* ✅ `src/core/engine.ts` : `drainFacts()` renvoie les faits accumulés depuis le dernier drain.
* ✅ (`P009-B`) `src/speaker/policy.ts`, `src/speaker/importance.ts`, `src/speaker/cooldowns.ts`,
  `src/speaker/Speaker.ts` : score, cooldown global + par type, déduplication, quotas, file de 3,
  préemption (`INTERRUPT_DELTA`). Le module n'importe que `core/types`.
* ✅ (P009-C) `src/app/strings.fr.ts` : 3 à 6 variantes par type de fait, formatters purs, flux
  `speaker:lines` consommé par `src/app/RaceCommentary.ts`.
* ✅ (P009-C) `src/render/view/SubtitleBanner.ts` : **affichage minimal** des répliques (le soin
  visuel vient en P012) — mais suffisant pour voir le speaker fonctionner.

**Tests (DoD)**
* ✅ (P009-A) Observateur : séquences d'état fabriquées à la main ⇒ faits exactement attendus (un test
  par type).
* ✅ (P009-A) **Véracité** : pour chaque fait émis sur 200 seeds réelles, recalculer la variation depuis
  l'historique et vérifier qu'elle correspond (aucun fait sans cause mesurable).
* ✅ (P009-A) Anti-bruit : 3 000 pas où deux personnages s'échangent leur rang avec < 0,5 m de marge ⇒
  **zéro** `LEADER_CHANGE` et **zéro** `OVERTAKE_STREAK`.
* ✅ (P009-A) `drainFacts()` vide bien la file ; aucun fait dupliqué pour un même instant ; buffer
  borné (mémoire constante) ; course identique bit à bit quelle que soit la cadence de drain.
* ✅ (P009-B) Speaker : `MIN_IMPORTANCE`, cooldown global, cooldowns par type et quota par segment
  jamais violés (200 seeds) ; aucune réplique sans fait source, importance jamais altérée.
* ⏳ **Arbitrage d'équilibrage (P010)** : sur 200 courses, la discipline de parole donne
  **min 8, p25 13, médiane 16, moyenne 16,12, p75 19, max 27** répliques — plafond (30) jamais
  atteint et quota par segment jamais saturé, mais **26 courses sur 200 passent sous les 12
  répliques** de la cible §9.3. La règle qui filtre est le **cooldown par type** (838 099 refus sur
  la campagne, contre 329 584 pour le global) : `OVERTAKE_STREAK` (705 faits pour 60 paroles) et
  `BIG_COMEBACK` (1 773 faits pour 476 paroles) sont les plus étranglés. La fenêtre glissante de
  densité ne s'est déclenchée qu'**une** fois sur 200 courses : elle n'est pas la cause. Mesure faite
  à cadence **maximale** (une réplique libérée à chaque pas, aucune durée de texte) : c'est donc une
  borne supérieure, que P009-C ne pourra qu'abaisser. Aucune constante n'a été modifiée par P009-B :
  c'est à P010 de trancher entre assouplir les cooldowns de type, revoir la cible basse, ou accepter
  des courses à faible densité d'événements.
* ✅ (P009-C) **Véracité des textes** : les valeurs interpolées correspondent exactement aux champs du
  fait (`tests/unit/speakerTexts.test.ts` : placeholders, valeurs dérivables, noms du roster, arrondis).
* ✅ (P009-C) **Indépendance textes / gameplay** : remplacer tout le catalogue par un autre ne change
  **aucune** distance finale (`tests/unit/speakerRng.test.ts`), et le flux `speaker:lines` est
  indépendant des flux du noyau (100 tirages sans effet mesurable).
* ✅ (P009-B) Préemption : une réplique d'importance 90 remplace une réplique d'importance 60 en
  cours ; une réplique de 70 ne la remplace pas. Aucune réplique sans fait, jamais.
* ✅ (P009-B) Le module `speaker/` n'importe que `core/types` (test de frontière).

---

### P010 — Équilibrage statistique et verrouillage des constantes `[x]`

**Objectif** : prouver que le jeu est amusant et équilibré, puis **figer** les réglages.

**Livrables**
* `tools/balance.ts` : exécute N seeds en Node (aucun navigateur) via `runToCompletion` et imprime les
  statistiques du §13 de `GAME_DESIGN.md`.
* `tests/unit/balance.test.ts` : les seuils du §13 deviennent des assertions (N réduit pour rester
  rapide, ex. 300 seeds ; le harnais complet à 1000 seeds reste un script manuel).
* Table de seeds dorées consolidée + rapport `docs/balance-report.md`.
* **Ajustement final des constantes** : après cette étape, `GAME_DESIGN.md` et `core/config.ts` sont
  alignés à la valeur près.

**Tests (DoD)**
* Tous les seuils du §13 passent, ou sont ajustés avec mise à jour simultanée de `GAME_DESIGN.md`.
* ~~`tools/balance.ts` tourne en < 30 s~~ → **objectif P010 : < 60 s séquentiel (atteint)**. La cible de
  30 s est irréaliste sur cette machine : le noyau seul coûte 29,1 ms/course, soit un plancher de
  29 s pour 1000 courses. Parallélisation différée à P017 (voir backlog). Ne dépend ni de Phaser ni du DOM.
* Durée du test d'équilibrage < 10 s (sinon réduire N ou paralléliser).
* Reproductibilité : 100/100 seeds identiques bit à bit ; `10800` pas par course avec et sans pauses.

**Compte rendu P010**

* **Livré** : `tools/balanceStats.ts` (mesure), `tools/balance.ts` (CLI + rapport JSON structuré),
  `tools/balanceRunner.mjs` (lanceur npm), `tests/unit/balance.test.ts` (19 tests, ≈ 9 s),
  `docs/balance-report.md`, table de seeds dorées consolidée.
* **Mesure canonique** : 1000 seeds, corpus `balance-p010`, **25 critères conformes sur 25**.
  Reproductibilité **100/100** bit à bit, `10800` pas par course.
* **Constantes ajustées** (chacune justifiée par une mesure, aucune touche à §6.3/§6.4) :
  magnitudes de **bonus** du catalogue §7.1 `× 0,65` — **plus grand facteur conforme parmi les valeurs
  testées** lors d'un balayage de 300 seeds qui ramène le biais de vitesse sous `±1,5 %` (`× 0,75`
  échouait encore) ; malus inchangés. Le balayage est discret : `× 0,65` n'est pas démontré minimal au
  sens mathématique.
  `EVENT.RATE_PER_S` testé à `1/10` puis **rétabli à `1/14`** : le compte d'événements était déjà
  conforme, donc rien ne justifiait de déplacer la constante.
* **Critère du leader remplacé** : `tSim = 171 s` → `tSim = 135 s` (début du quatrième et dernier
  segment), même plage `55 % – 85 %`. Valeur normative : **66,90 %** sur le corpus canonique de
  1000 seeds (66,33 % sur le corpus réduit de 300 seeds). L'ancien critère mesurait **88,10 %** sur
  1000 seeds : hors
  plage, et aucun levier global/symétrique ne le corrigeait (diagnostic apparié McNemar dans
  `docs/balance-report.md` §2). Le nouveau critère est conforme, sans qu'aucun mécanisme de fin de
  course ni aucune règle dépendant du rang n'ait été introduit.
* **Règle supprimée** : « `CHUTE` annule un `TURBO` actif » — inatteignable avec les constantes V1
  (`CHAR_COOLDOWN_S = 8 s` > durée maximale d'un `TURBO`), mesurée à **0/1000**. Propriété
  `cancelsTurbo` retirée du catalogue, du planificateur, des tests et de `GAME_DESIGN.md` §7.1/§7.3.
  Aucun cooldown n'a été réduit.
* **Écarts de DoD assumés** : `tools/balance.ts` mesure **47,5 s** et non < 30 s. La cible est
  **irréaliste sur cette machine** : le noyau seul coûte 29,1 ms/course, donc 29 s plancher pour 1000
  courses, même avec une instrumentation gratuite. Objectif retenu pour P010 : **< 60 s séquentiel**
  (atteint). La parallélisation (`worker_threads`) est **différée à P017**, avec le profilage du pas
  de noyau. Le test d'équilibrage mesure **100 seeds** au lieu de 300 pour tenir le budget de 10 s ;
  c'est le harnais à 1000 seeds qui fait foi, l'erreur d'échantillonnage à 100 seeds (±≈ 5 points sur
  un taux) dépassant la largeur des plages testées.
* **Distribution du speaker publiée en entier** (min, p5, p25, médiane, moyenne, p75, p95, max,
  `< 12`, `= 0`, `> 30`) : la moyenne conforme ne doit pas masquer la traîne, et le critère §13 se lit
  sur la moyenne comme ses deux lignes voisines.
* **Correctif d'infrastructure (hors gameplay)** : convention de ports `18000–18999`, source unique
  `dev-ports.ts` lue par `vite.config.ts` et `playwright.config.ts`. Prévisualisation/E2E `4173` →
  **`18173`**, serveur de développement `5173` → **`18100`**. Motif : Windows réserve dynamiquement
  des plages dans sa plage dynamique `1024–15000`, et `bind()` sur un port réservé échoue en
  `EACCES` — cas constaté `4108–4207` (qui contenait `4173`), où `npm run verify` ne pouvait plus
  démarrer `vite preview` alors qu'aucun test n'était en cause. `5173` répondait encore au moment du
  déplacement : il a suivi la convention, il n'était pas cassé. Aucune règle de jeu, aucune constante
  de `core/` n'est concernée.
* **Passe de cohérence documentaire (post-P010, hors gameplay)** : §13 nomme le critère du speaker
  « par course **(moyenne)** » et §9.3 dit explicitement qu'il s'agit d'une **cible statistique de
  corpus**, pas d'une exigence par course (le quota de 12 reste une borne **par segment**, jamais un
  objectif, et aucune réplique n'est forcée). Les deux valeurs du critère du leader sont séparées
  (1000 seeds : **66,90 %**, normatif ; 300 seeds : 66,33 %). L'explication du biais de distance ne
  parle plus de « convexité » **ni de linéarité** : la formule d'un événement isolé (§7.2) ne permet
  pas d'en déduire la neutralité du catalogue (`t_rampe` dépend de `Δv`, rampes directionnelles,
  écrêtage, interactions avec dérive et surges), donc le signe et l'amplitude du biais sont **établis
  par la mesure du moteur réel**. `× 0,65` est présenté comme **le plus grand facteur conforme parmi
  les valeurs testées**, pas comme un minimum mathématique.

---

### P011 — HUD complet et panneau de debug

**Statut : `[x]`** (terminé — voir le compte rendu ci-dessous)

**Livrables**
* `src/render/view/Hud.ts` : mini-carte `0 → VIEW.NOMINAL_SCALE_M` avec les 6 marqueurs colorés (et
  indicateur `+xx m` si dépassement de l'échelle), classement live (6 lignes avec écarts en m et en s),
  chrono et numéro de segment, bandeau de checkpoint (splits), seed copiable.
* `src/render/view/DebugPanel.ts` : seed, `tSim`, segment, `x`, `v`, drift/surge/événement, rang.

**Tests (DoD)**
* E2E : le classement affiché est identique à celui du noyau à plusieurs instants (comparaison stricte
  via les hooks).
* Les 6 marqueurs de mini-carte sont dans l'ordre des distances (3 instants testés).
* Le bandeau de checkpoint apparaît 3 fois, une par pause.
* La seed affichée est copiable et identique à l'URL.
* Lisible et sans chevauchement en 1280×720, 1920×1080 et 844×390.
* `debug=1` n'altère jamais la simulation (distances finales identiques).

**Compte rendu**

Architecture retenue : le HUD est du **HTML dans l'arène** (grille CSS `#hud`), pas du canvas — il
reste lisible aux petites tailles et comparable par le DOM dans les tests. Les calculs sont sortis
dans des modules **sans Phaser** (`view/minimap.ts`, `view/hudModel.ts`, `view/debugModel.ts`), donc
testables en environnement `node`. `Hud` est le **seul** écrivain du classement affiché : l'ancienne
`view/LeaderboardView.ts`, qui écrivait les mêmes lignes en parallèle, a été **supprimée** (les deux
écritures produisaient 12 lignes au lieu de 6). L'ordre et les écarts viennent toujours de
`sim/leaderboard.ts` → `core/ranking.ts`, seule source du classement ; `LeaderboardRow` porte
désormais `gapSeconds`, et non un recalcul de vue.

Fichiers créés : `src/render/view/minimap.ts`, `src/render/view/Hud.ts`, `src/render/view/hudModel.ts`,
`src/render/view/debugModel.ts`, `tests/unit/hud.test.ts`, `tests/unit/hudModel.test.ts`,
`tests/e2e/hud.spec.ts`. Fichiers modifiés : `src/render/view/DebugPanel.ts`, `src/render/viewDebug.ts`,
`src/render/scenes/RaceScene.ts`, `src/render/Game.ts`, `src/app/main.ts`, `src/sim/leaderboard.ts`,
`src/sim/testHooks.ts`, `src/render/uiText.ts`, `src/app/strings.fr.ts`, `index.html`, `src/styles.css`,
`tests/e2e/helpers.ts`, `tests/e2e/race.spec.ts`, `tests/e2e/checkpoints.spec.ts`,
`playwright.config.ts`. Fichier supprimé : `src/render/view/LeaderboardView.ts`.

Tests : `npm run test` → **33 fichiers, 515 tests, tous verts** (dont 13 tests de mini-carte et 9 de
modèles HUD/debug) ; `npm run test:e2e` → **36 tests, tous verts** ; `npm run verify` → vert.

`debug=1` n'altère rien : le panneau ne fait que **lire** un `DebugModel` construit depuis l'état du
noyau, et le test E2E compare, pour la même seed, les distances finales et le classement final avec et
sans `debug=1`, plus le nombre exact de pas (`10800`).

Point de méthode : la pause d'un pointage dure `checkpointPauseRealS` (0,2 s à ×20). Les tests qui
doivent **observer** le bandeau pendant sa pause arment donc leur scrutation **dans la page** (à la
fréquence d'affichage) et figent la géométrie dans la même tâche que l'observation ; comparer des
mesures prises à deux instants différents produisait des tests instables.

---

### P012 — Affichage du speaker et réglages

**Statut : `[x]`** (terminé — voir le compte rendu ci-dessous)

**Livrables**
* `SubtitleBanner` soigné : nom du personnage mis en avant, durée adaptée à la longueur, file visible,
  disparition propre.
* `src/app/settings.ts` : muet / TTS, persistés en `localStorage` (n'influencent jamais la sim).
* TTS via `speechSynthesis` (voix fr) **désactivée par défaut**, dégradation silencieuse si absente.

**Tests (DoD)**
* E2E : au moins une réplique apparaît sur une course `fast=1`, le texte correspond à un fait réel
  exposé par les hooks, aucun message sans fait.
* Jamais deux bannières en < 6 s (hors préemption, testée).
* Activer/désactiver TTS et muet ne change aucune distance finale.
* Si `speechSynthesis` est absent, aucune exception.

**Compte rendu**

Créé : `src/app/settings.ts`, `src/app/tts.ts`, `src/app/SettingsPanel.ts`,
`src/render/view/subtitleModel.ts`, `tests/unit/settings.test.ts`, `tests/unit/tts.test.ts`,
`tests/unit/subtitleModel.test.ts`, `tests/e2e/subtitle.spec.ts`, `tests/e2e/settings.spec.ts`.
Modifié : `src/render/view/SubtitleBanner.ts`, `src/render/subtitle.ts`, `src/app/RaceCommentary.ts`,
`src/app/main.ts`, `src/app/strings.fr.ts`, `src/render/uiText.ts`, `src/render/viewConfig.ts`,
`src/render/viewDebug.ts`, `src/render/scenes/RaceScene.ts`, `src/styles.css`, `tests/e2e/helpers.ts`,
`tests/unit/commentary.test.ts`.

* **Le bandeau est passé du canvas au DOM, dans la grille du HUD.** Motif : le HUD de P011 est en HTML
  et sa géométrie dépend du viewport (`clamp`/`vw`), pas des unités logiques du canvas — un texte
  dessiné dans la scène ne pouvait donc pas être *garanti* hors des blocs du HUD à toutes les
  résolutions. Le bandeau occupe désormais la rangée souple de `.hud`, aligné en bas : il grandit vers
  le haut sans déplacer un seul bloc, et masqué (`hidden`) il ne réserve aucune place. Il reste
  lisible en 844×390 (`clamp(0.6rem, 1.2vw, 0.95rem)`) et comparable par le DOM.
* **Modèle pur** : `subtitleModel.ts` porte la durée adaptée à la longueur (`subtitleDurationMs`,
  bornée à `[2000 ; 5200] ms`), le personnage mis en avant, l'indicateur de file et la machine à
  états des transitions (`appear` / `hold` / `replace` / `leave`, opacité avancée par le temps réel).
* **Personnage mis en avant** : c'est le premier personnage du fait dont le nom **apparaît réellement
  dans la variante tirée**. Certaines variantes de `CLOSE_RACE` ne citent personne : le bandeau
  n'affiche alors aucun nom plutôt qu'un nom plaqué.
* **File visible** : le bandeau lit `Speaker.queuedCount()`, la vraie file du speaker. Aucune queue
  n'est dupliquée dans le rendu, et un test E2E vérifie que le nombre affiché est exactement celui du
  modèle de la frame.
* **Sémantique de `mute`** : « aucune sortie vocale ». Le speaker, les faits, les cooldowns, la file,
  les préemptions et les **sous-titres texte** continuent à l'identique ; seul `allowsVoice()` change
  de valeur. Aucune sémantique préexistante n'existait : rien n'a été modifié en silence.
* **TTS** : `speechSynthesis`/`SpeechSynthesisUtterance` sont **injectés** (`SpeechApiScope`), jamais
  lus directement. Choix de voix déterministe (première `fr-*`, sinon première disponible, sinon la
  voix par défaut avec `lang = fr-FR`), aucun tirage consommé. API absente ou incomplète ⇒ `null`,
  donc aucune exception. Une émission coupe d'abord l'énonciation en cours.
* **Écart assumé et documenté** : la constante fixe `SUBTITLE_DISPLAY_MS = 2600 ms` disparaît au
  profit de la durée adaptée à la longueur. La note d'intégration de P009-C a été mise à jour dans le
  même changement. La nature est inchangée — temps réel d'interface, hors `tSim`, hors cooldowns.
* **Tests existants adaptés** : `tests/unit/commentary.test.ts` utilisait la constante de durée pour
  faire expirer une réplique ; il passe désormais par `remainingDisplayMs()`, ce qui le rend
  indépendant de la longueur du texte produit.

Résultats réels : `npm run verify` **vert** — `typecheck` 0 erreur ; **569 tests unitaires** (36
fichiers) ; `vite build` OK ; **51 tests E2E** OK, aucune erreur console. Invariance mesurée : pour
`OVERTAKE_SEED`, quatre courses réelles (défauts, TTS, muet, muet + TTS) donnent des distances et un
classement **strictement identiques**, et **10 800 pas** exactement dans les quatre cas. Aucun
blocage.

---

### P013 — Arrivée et podium

**Statut : `[x]`** (terminé — voir le compte rendu ci-dessous)

**Livrables**
* `FINISHED` : décélération **visuelle** (le rendu anime, le noyau ne fait plus de pas), classement
  final figé, `FinishScene` avec podium, liste des 6 avec écarts, mise en avant de `PHOTO_FINISH`.
* Boutons « Rejouer la même seed » et « Nouvelle course ».

**Tests (DoD)**
* E2E : une course complète `fast=1` atteint le podium ; l'ordre du podium est exactement le classement
  du noyau à `tSim = 180 s` (comparaison stricte).
* Les distances affichées sont celles de `tSim = 180 s` et ne bougent plus.
* « Rejouer la même seed » ⇒ podium identique ; « Nouvelle course » ⇒ podium différent (5 essais).
* Aucun pas de simulation après `FINISHED` (compteur de pas stable via les hooks).
* Le podium n'utilise **jamais** un repère de décor ni une ligne d'arrivée dessinée comme critère.

**Compte rendu**

Créé : `src/render/view/finishModel.ts`, `src/render/view/FinishPanel.ts`,
`tests/unit/finishModel.test.ts`, `tests/e2e/finish.spec.ts`.
Modifié : `src/render/scenes/RaceScene.ts`, `src/render/Game.ts`, `src/render/viewDebug.ts`,
`src/render/view/Hud.ts`, `src/render/viewConfig.ts`, `src/render/uiText.ts`, `src/app/main.ts`,
`src/app/RaceCommentary.ts`, `src/app/strings.fr.ts`, `src/styles.css`, `tests/fixtures/seeds.ts`,
`tests/e2e/helpers.ts`, `GAME_DESIGN.md` §5.

* **`src/core/**` et `src/sim/**` sont strictement inchangés.** Aucun pas de noyau, aucune constante,
  aucun RNG, aucun événement, aucun cooldown du speaker, aucune règle avant 180 s n'a été touché : P013
  est une couche de fin de course et de présentation. `RaceSimulation.update()` n'appelait déjà plus
  `step()` après `finished` ; la frontière était donc déjà absolue, et tout le travail consiste à ne
  pas la franchir côté rendu.
* **Architecture : un panneau HTML, pas une scène Phaser.** Le rôle de `FinishScene` est tenu par
  `RaceScene` (branche `phase === 'finished'`) et par `FinishPanel`, un panneau HTML vivant dans la
  grille `.hud`, comme le HUD de P011 et le bandeau de P012 : c'est ce qui garantit **par
  construction** l'absence de recouvrement avec les blocs de course (cellules différentes de la même
  grille), garde les six résultats lisibles en 844×390, rend le podium comparable par le DOM dans les
  tests, et évite qu'une géométrie dessinée à la main devienne une donnée de course. Aucun fichier
  `scenes/FinishScene.ts` n'a donc été créé : il aurait été une scène Phaser vide ou un doublon.
* **Instantané final figé.** `captureFinishSnapshot(state)` refuse tout état qui n'est pas `finished`,
  copie distances, vitesses et classement (`leaderboardOf`, donc `core/ranking.ts`), et gèle le tout en
  profondeur (`Object.freeze` sur l'instantané, ses tableaux et chaque ligne). Il est pris **une seule
  fois**, à la frame où le noyau devient `finished` : le classement affiché ne peut plus changer, même
  si le rendu continue de vivre. Le modèle de présentation (`buildFinishModel`) ne trie rien, ne
  compare rien, n'importe ni `core/ranking` directement ni le décor, et n'affiche le podium que comme
  le **début** de la liste du noyau.
* **Décélération visuelle** : `decelerationOffset()` fait décroître linéairement une vitesse d'inertie
  jusqu'à zéro sur `VIEW.FINISH_DECELERATION_MS = 1200 ms` (décalage `v̄·T·(1−(1−u)²)/2`, soit au plus
  `v̄·0,6 ≈ 7 m`), et `deceleratedDistances()` l'ajoute aux distances figées. Le décalage est **le même
  pour les six marcheurs** : l'ordre visuel ne peut donc pas diverger du classement figé, et une
  position de sprite ne peut jamais devenir un critère. Le noyau, lui, ne reçoit aucun pas : la
  montre de la décélération est du temps réel, dans `RaceScene` uniquement.
* **`FINISH` / `PHOTO_FINISH`** : `RaceCommentary` conserve le fait d'arrivée réel (`FINISH` ou
  `PHOTO_FINISH`) indépendamment de la décision de parole, et l'expose en lecture seule
  (`arrivalFact()`). Le panneau n'affiche la mention que si ce fait est `PHOTO_FINISH` et publie
  l'écart **mesuré** du fait : aucun seuil n'est recalculé dans le rendu. Seed de référence mesurée :
  `SRS47J58` ⇒ `PHOTO_FINISH` avec un écart P1–P2 de `0,438 m` (le corpus canonique en produit 49 sur
  600, ≈ 8 % ; la campagne de 200 courses de P009-A : 181 `FINISH` / 19 `PHOTO_FINISH`). `POULET42`
  ⇒ `FINISH`, écart `62,935 m` : aucune mention.
* **Politique de commentaire d'arrivée** : choix simple et déterministe — le podium apparaît
  **immédiatement** à `FINISHED`, sans délai, et le bandeau de commentaire continue sa vie normale
  dans **sa propre cellule** de la grille, au-dessus du podium. Aucun cooldown, aucune préemption,
  aucune durée P012 n'a été modifié, et `FINISHED` n'est jamais retardé. Le commentaire d'arrivée
  finit donc de s'afficher puis disparaît proprement (comportement déjà couvert par
  `subtitle.spec.ts`), et le recouvrement est impossible par construction, pas « évité » par une marge.
* **Deux boutons** : « Rejouer la même seed » (`simulation.restart()` — aucune nouvelle seed) et
  « Nouvelle course » (`createRandomSeedText()` → URL → HUD → `restart(seed)` → `reset` du
  commentaire → `start()`). Le second réutilise le mécanisme de seed existant de `app/` : aucun
  deuxième système de seed n'a été créé, et la seed précédente est remplacée partout à la fois avant
  le départ. Les callbacks viennent de `app/` (seule couche qui connaît l'URL et la seed) et sont
  injectés dans le rendu par `GameOptions.finishActions`.
* **HUD à l'arrivée** : le classement **live** et la mini-carte sont masqués (le premier ferait doublon
  avec le classement final, la seconde représente une course qui n'avance plus). Le chrono s'arrête à
  `180,0 s`, l'état, la seed et les **réglages restent affichés et utilisables** sur l'écran d'arrivée
  (un test clique `Muet` à l'arrivée et vérifie `aria-pressed`) : la persistance P012 n'est pas
  touchée. Les lignes du classement sont mises à jour **avant** d'être masquées, donc le DOM ne peut
  pas conserver une frame en retard.
* **Responsive** : l'écran d'arrivée vit dans les cellules basses de la grille ; en `max-height:
  560px` les titres de section disparaissent et les gouttières se resserrent, sans retirer ni une ligne
  ni un bouton. Mesuré en 1280×720, 1920×1080 et 844×390 : tout est dans l'arène, le podium et le
  classement ne se recouvrent pas, rien ne recouvre le statut, les réglages, le chrono, la seed ou le
  commentaire, la police des résultats reste ≥ 8 px, et les deux boutons sont cliquables.
* **Écarts assumés** : aucun. `VIEW` accueille deux constantes de **présentation**
  (`FINISH_DECELERATION_MS`, `FINISH_PODIUM_SIZE`) ; `GAME_DESIGN.md` §5 documente la règle de
  présentation correspondante (décélération purement décorative, podium qui présente sans décider,
  mention de photo finish issue du seul fait du noyau).

Preuves `steps = 10800` : E2E, cinq lectures séparées (une immédiate puis quatre espacées de 400 ms),
toutes à `10800` pas et `tSim = 180 s`, avec des distances finales **strictement** identiques ; pendant
ce temps les positions de rendu augmentent (décélération réellement animée) puis se stabilisent.
Podium == noyau : les 6 identifiants, les rangs, le top 3, les distances et les écarts sont comparés
aux valeurs du noyau lues dans le même appel ; les valeurs brutes (`data-*`) sont comparées à
l'identique et les textes à la précision d'interface documentée (**une décimale**). Même seed ⇒ même
podium : deuxième course complète après clic, distances, classement et podium strictement identiques,
seed d'URL inchangée. Preuve structurelle « pas de ligne d'arrivée » : tests unitaires interdisant à
`finishModel.ts` toute règle de classement (`computeRanks`, `sortByRank`, tri), tout décor
(`NOMINAL_SCALE`, `screenX`, `sprite`, `phaser`) et à `FinishPanel.ts` tout import de `core/ranking`,
`sim/leaderboard` (fonctions) ou `viewConfig` ; plus un cas fabriqué où les distances dépassent
largement l'échelle nominale et où le podium suit quand même les distances.

Résultats réels : `npm run verify` **vert** — `typecheck` 0 erreur ; **585 tests unitaires** (37
fichiers, dont 16 nouveaux) ; `vite build` OK ; **59 tests E2E** OK (dont 8 nouveaux pour P013), aucune
erreur console. Cinq essais « Nouvelle course » exécutés réellement, depuis une course initiale sur
`POULET42` : seeds `SEQXK3H3`, `GK1MKB0Y`, `WF1JWY0Y`, `50ZW7HVN`, `0W44R56G` (5 seeds distinctes,
toutes différentes de la seed initiale) et six podiums observés — `c3,c2,c1` (course initiale),
`c2,c1,c3`, `c1,c3,c4`, `c5,c0,c4`, `c2,c5,c0`, `c1,c5,c0` : au moins un podium diffère (ici les cinq
diffèrent), et les courses diffèrent réellement, pas seulement leurs étiquettes. Aucun blocage.

---

### P013-cor — Passe corrective issue du premier test joueur manuel après P013 `[x]`

**Nature.** Ce n'est **pas** une nouvelle étape de la roadmap : c'est une **passe corrective** demandée
explicitement après le premier test joueur manuel de la course complète (P013), **avant** le jalon
P013.5. Elle ne renumérote rien, ne change aucun invariant et ne modifie **aucune constante de
simulation** : elle corrige neuf problèmes constatés en jouant — durée de course, HUD envahissant,
speaker qui masque l'action, voix trop lente, bonus/malus imperceptibles, nombres bruts affichés,
libellé `Pointage`, réglages `Muet` / `Voix` ambigus, absence de retour immédiat à l'activation du son
et du commentaire.

**1. Course de 60 s.** `RACE_CONFIG` passe à `SEGMENT_COUNT = 3`, `SEGMENT_DURATION_S = 20`,
`TOTAL_SIM_S = 60`, `STEPS_PER_SEGMENT = 1200`, `TOTAL_STEPS = 3600`. Les checkpoints tombent à
`tSim = 20` et `40 s` ; l'indicateur de segment affiche `1/3`, `2/3`, `3/3`. Après `FINISHED`, `tSim`
reste à `60` et le nombre de pas à `3600` : **aucun pas supplémentaire**, la décélération d'arrivée
reste **purement visuelle** (P013). Le mode test accéléré passe à ≈ 3,2 s réelles.

**2. Équilibrage : aucune constante de jeu touchée.** `SPEED.*`, `DRIFT.*`, `SURGE.*`, `EVENT.*`
(dont `RATE_PER_S = 1/14`) et `OVERTAKE.*` sont **inchangés**. Seules les lignes de §13 qui
**dépendent de la durée** ont été réinterprétées, chacune avec sa mesure :
écart P1–P6 `[45 ; 150] m` / `≥ 15` / `≤ 290` (l'écart-type croît comme la **racine** du temps),
critère du leader déplacé au **début du dernier segment** (`TOTAL_SIM_S − SEGMENT_DURATION_S = 40 s`,
valeur **dérivée**), événements `[3 ; 6]` et surges `[4,7 ; 8,7]` (mêmes **taux** qu'en 180 s),
répliques du speaker `[6 ; 14]` (plafonnées par le cooldown global de `6 s`). Les lignes indépendantes
de la durée (changements de leader, dépassements, taux de victoire, part d'événements, biais de
vitesse, reproductibilité) sont **conservées telles quelles**. Résultat du corpus canonique de
1000 seeds : **25/25 critères conformes**, reproductibilité **100/100** bit à bit.

**3. Vocabulaire.** `Pointage` disparaît de tout texte visible au profit de **`Checkpoint`**
(`Checkpoint 1 · 20 s`) ; les noms techniques internes sont conservés.

**4. Piste dégagée.** La **mini-carte** permanente est retirée du HUD (son modèle reste un hook de test
et de debug), le classement permanent est conservé mais compacté en bas à droite, le chrono est
resserré, la seed devient discrète, les réglages sont réduits à deux pastilles. Tous les hooks de test
et de debug restent en place.

**5. Checkpoint = retour bref.** Le grand tableau central a disparu : le checkpoint affiche un
**bandeau temporaire** (numéro, instant atteint, leader figé).

**6. Commentaire = bande de retransmission.** Zone basse non critique, largeur et hauteur bornées,
deux lignes, nom du personnage conservé, **aucune** seconde file d'attente : le texte reste celui du
speaker réel.

**7. Voix plus rapide.** `TTS_RATE = 1.6`, constante de **présentation** centralisée, vérifiée sur une
voix française. La voix ne peut influencer ni la simulation, ni le RNG, ni l'horloge.

**8. Sous-titres lisibles.** `VIEW.SUBTITLE_MIN_MS = 800`, `SUBTITLE_PER_CHAR_MS = 60`,
`SUBTITLE_MAX_MS = 5800` (mesures : ≤ 20 caractères/s, catalogue 40–110 caractères, et
`SUBTITLE_MAX_MS < SPEAK.GLOBAL_COOLDOWN_S`). Règle d'affichage : aucun cooldown ni fait n'est touché.

**9. Nombres lisibles.** Un module unique (`src/render/format.ts`) met en forme **toutes** les valeurs
affichées (`35.9333333333 %` → `36 %`, `6.1333333333 s` → `6 s`, `26.0 m` pour les distances) ; l'audit
couvre tous les gabarits du speaker, et **aucune valeur de simulation n'est arrondie**.

**10. Retour des bonus et malus.** Chaque événement actif affiche un libellé court et son sens
(`BONUS !` / `MALUS !`) **attaché au personnage**, temporaire, non obscurcissant, multiple, lu
**exclusivement** dans les événements réels du noyau (aucun tirage, aucune écriture).

**11. `Son` / `Commentateur`.** Les réglages `Muet` / `Voix` deviennent des commandes explicites à état
(`activé` / `coupé`), persistées, avec **migration** de l'ancien format et **aucun plantage** sur une
valeur corrompue. Activer le son joue un **court klaxon** synthétisé (Web Audio, dans le clic, aucun
asset, aucune dépendance) ; activer le commentateur prononce **`Let's go!`** (action du joueur
uniquement, jamais au chargement, jamais à la désactivation, hors file et cooldowns du speaker).
Le système audio complet reste en **P015**.

**Preuves.** Tests unitaires des helpers de mise en forme, du retour d'événement, du son, des réglages
et de la voix ; tests E2E de la course de 60 s (`3600` pas, `tSim = 60 s`), des deux checkpoints, du
bandeau de commentaire, du retour d'événement (comparé aux événements du noyau), du klaxon et de
`Let's go!`, de l'invariance TTS/audio et du responsive en 1280×720, 1920×1080 et 844×390 ;
`npm run balance` sur le corpus canonique de 1000 seeds (25/25) ; re-validation de P013 en 60 s.

**Décisions et écarts.** Aucun écart par rapport à la demande. Les hooks de debug sont conservés, la
mini-carte survit sous forme de modèle testable, et aucune tolérance de test n'a été relâchée pour
faire passer une mesure : là où un seuil gênait, c'est le **CSS** ou l'**échantillon** qui a été
corrigé (par exemple la police du classement en téléphone paysage, remontée à `0,6rem`).

---

### P013-cor2 — Seconde passe corrective, issue du second test joueur manuel `[x]`

**Nature.** Comme `P013-cor`, ce n'est **pas** une nouvelle étape : c'est une **passe corrective**
courte, demandée après un **second test joueur manuel** de la course complète, **avant** le jalon
P013.5. Elle ne renumérote rien, ne change **aucune constante de simulation** (`SPEED.*`, `DRIFT.*`,
`SURGE.*`, `EVENT.*`, `OVERTAKE.*` sont intacts), ne relance pas le corpus d'équilibrage — aucun
changement ne touche la course — et ne redessine pas l'arrivée, jugée satisfaisante. Elle corrige
**quatre** défauts constatés en jouant.

**1. Un commentaire ne peut plus annoncer une position fausse.** Sur une seed reproductible
(`KR7Z8NAR`), le speaker annonçait `Poulet 3000 fait une remontée, 1er` alors que Poulet 3000
n'était **pas** premier à l'écran. Diagnostic : chaque fait était **exact à son propre instant**
(les 22 faits de position de cette seed sont conformes), mais **rien ne bornait son âge** : un fait
mesuré à `tSim = 0,37 s` pouvait être prononcé à `30,05 s`, une fois les cooldowns de type et global
retombés — la position annoncée était alors périmée depuis longtemps. Correctif : une **position ne se
commente qu'à l'instant de sa mesure**. `SPEAK.RANK_FACT_MAX_AGE_S = 0.0` (nouvelle constante de
**discipline du speaker**, pas de simulation) s'applique aux faits qui **affirment un rang**
(`LEADER_CHANGE`, `BIG_COMEBACK`, `LAST_COMEBACK`, `LEADER_MALUS`) ; les faits épisodiques gardent
`SPEAK.FACT_MAX_AGE_S = 12.0`. Mesure : avant le correctif, **301 des 1029** répliques de position
(29 %) étaient fausses au moment d'être dites ; après, **0 sur 585**. Coût réel : 9 % de répliques en
moins. Aucune trajectoire, aucun tirage et aucune règle de course n'ont été touchés : seul le flux
`speaker:lines` change.

**2. Relecture visuelle pendant une pause manuelle.** Pendant une pause, une petite barre apparaît
sous les commandes : `−2 s`, une barre de temps et `+2 s`, avec une lecture `38,4 s / 52,4 s`
(instant consulté / instant réel de la pause). Le curseur est **borné** à `[0, instant de pause]` :
on ne peut ni remonter avant le départ, ni avancer au-delà de ce qui a réellement été joué. La
relecture est **purement visuelle** : `RaceEngine` ne recule jamais, aucun pas n'est exécuté, aucun
fait n'est produit, aucun tirage n'a lieu, la relecture est **muette** (aucune ancienne réplique n'est
remise dans la file du speaker), et « Reprendre » repart de l'**instant réel de la pause**. Les états
passés nécessaires au dessin (distances des 6 personnages + événements actifs) sont conservés
**compactement** : `3601` instants au maximum, `172,8 Ko` de distances en `Float64Array` alloué une
fois, plus quelques centaines d'octets de fiches d'événements — moins de `200 Ko` au total.

**3. Le classement permanent ne recouvre plus la piste.** Une **bande latérale** est réservée au
classement (`VIEW.TRACK_WIDTH_RATIO = 0.78`) : la piste est dessinée dans les 78 % de gauche, le
classement vit dans la bande de droite, et un personnage sorti du champ est **masqué** (son marqueur
de bord reste dans la piste) plutôt que dessiné sous le panneau. En **téléphone paysage**
(hauteur ≤ `VIEW.COMPACT_VIEWPORT_MAX_HEIGHT_PX = 560`), la bande disparaît et le classement permanent
est **masqué pendant la course** : masquer est préférable à recouvrir. Le reste du HUD est inchangé.

**4. Plus de segment invalide à l'arrivée.** Le HUD affichait `segment 0/3` à `60,0 s` : le modèle
publie désormais `segment: null` hors course, et l'affichage dit **`Terminé`**. Le noyau n'a que trois
segments (`1` à `3`) ; `0/3` n'existe plus nulle part.

**Preuves.** Tests unitaires : fraîcheur des faits de position (contrôle pas à pas sur `KR7Z8NAR`,
corpus de 24 seeds, deux niveaux de péremption, classification exhaustive des dix types de faits) ;
historique de relecture (distances exactes, bornes du curseur, taille mesurée, remise à zéro) ;
modèle de segment (`null` à l'arrivée). Tests E2E : pause à `52,4 s`, `−2 s` → `50,4 s` → `48,4 s`,
`+2 s` → `50,4 s`, bornes haute et basse infranchissables, relecture muette et sans pas, invariance
après relecture et reprise (distances finales **identiques bit à bit**, classement identique,
`3600` pas), géométrie du classement en 1280×720, 1920×1080 et 844×390 (aucun personnage dessiné sous
le panneau), et `Terminé` à l'arrivée.

---

### P013.5 — Jalon 3D : prototype de rendu et choix du moteur `[ ]`

**Objectif** : décider **par l'expérience**, et non sur le papier, si la présentation finale doit
passer en 3D — et avec quel moteur. Ce jalon ne produit **aucun** graphisme définitif et **aucun**
gameplay : c'est un prototype jetable dont la seule sortie utile est une **décision**.

**Pourquoi ici.** P014 (« identité visuelle et animations ») est l'étape où le travail artistique
devient lourd. Choisir le moteur après coup reviendrait à jeter ce travail. Le jalon est donc placé
**juste avant P014**, une fois la course complète et jugée (P013).

**Motivation issue de P005** (constats visuels de la revue du jalon, non bloquants) : le classement
en surimpression peut masquer une partie de la piste, les noms sont trop petits en téléphone
paysage, le rendu 2D est volontairement un placeholder, et la **sensation de vitesse absolue est
limitée** par une caméra qui suit le peloton. La profondeur et la perspective sont précisément ce
qu'un rendu 3D peut apporter sur ce dernier point : d'où ce prototype, à mener avant d'investir.

**Prototype minimal attendu**
* réutiliser `RaceEngine` **tel quel**, sans aucune modification ;
* seed **POULET42** (la seed de référence mesurée en P005) ;
* 6 primitives ou modèles temporaires 3D, sans direction artistique définitive ;
* une piste 3D basique (une courbe suffit) ;
* conversion `x` → position sur la piste, **dans le renderer uniquement** ;
* une caméra TV simple qui suit le peloton ;
* **aucun** nouveau gameplay, **aucun** nouvel événement, **aucune** constante de jeu touchée.

**Comparaison à mener**

| Option | Description |
| --- | --- |
| **A** | Continuer en Phaser / 2D (statu quo, éventuellement amélioré) |
| **B** | Renderer 3D **Three.js** |
| **C** | Renderer 3D **Babylon.js** |

**Critères de décision** — évalués **sur le prototype**, jamais sur la documentation des moteurs :
lisibilité des dépassements · sensation de vitesse · facilité de mise en place des caméras (suivi,
changements de plan) · intégration de modèles et d'animations · performances desktop **et** mobile
en paysage · coût de développement assisté par IA · **conservation stricte du moteur déterministe
existant**.

**Contraintes non négociables**
* `RaceEngine` reste l'**unique source de vérité** : le renderer 3D lit `x` et le transforme en
  position sur la piste, **jamais l'inverse**. Aucune physique 3D ne décide du vainqueur, des
  vitesses, des dépassements ou d'un événement de gameplay.
* Le résultat d'une course doit être **identique au bit près** avec et sans le renderer 3D.
* L'UI, le classement et les paris peuvent rester en **HTML/2D** au-dessus de la scène.
* **Aucune dépendance 3D n'est installée avant que ce jalon ne soit explicitement autorisé**
  (`AGENTS.md` §3.1). Le rendu reste le placeholder 2D de P005 jusque-là.
* Inspiration de **mise en scène** uniquement : aucun asset, personnage ou élément protégé d'une
  œuvre existante n'est reproduit — voir `GAME_DESIGN.md` §5.1.

**Tests (DoD)**
* Le prototype réutilise le noyau **sans le modifier** : `git diff` nul sur `src/core/**`.
* Prototype actif ⇒ `runToCompletion` donne **exactement** les mêmes distances que le renderer 2D,
  seed POULET42 comprise.
* Le prototype rend 6 objets mobiles dont l'**ordre à l'écran** est celui des distances du noyau.
* `tests/unit/boundaries.test.ts` reste vert : le renderer 3D n'écrit jamais dans l'état.
* **Livrable de décision** : une note courte « A / B / C », argumentée sur les 7 critères ci-dessus,
  dans le compte rendu de l'étape. **Aucun choix de moteur ne doit être fait avant ce prototype.**

**Hors périmètre** : graphismes définitifs, modèles 3D réels, animations, caméras scénarisées,
audio, budget de ressources définitif (P014 et suivants).

---

### P014 — Identité visuelle et animations des 6 personnages

**Dépend de P013.5** : le moteur de rendu doit être choisi avant de produire l'identité visuelle.
Si le jalon retient une option 3D, cette étape s'appuie dessus ; sinon elle reste en Phaser/2D.

**Livrables**
* 6 personnages visuellement très distincts (couleur **et** forme/silhouette), noms définitifs FR,
  animations par état (course, turbo, chute, sieste, vent de face, raccourci), bulles d'émotion.
* Palette accessible (daltonisme) : distinction jamais fondée sur la seule teinte.
* Ressources **locales** uniquement (aucun CDN, aucune police distante).

**Tests (DoD)**
* Les 6 personnages restent identifiables sur une capture en niveaux de gris.
* Chaque état d'événement a une animation associée, et aucune animation ne modifie `x` (assertion
  avant/après sur l'état du noyau).
* Poids total des ressources < 3 Mo (test de build).

---

### P015 — Polish, accessibilité, audio optionnel

**Livrables**
* Secousses d'écran et lignes de vitesse sur les gros événements, transitions de pause, poussière,
  suspense sur les fins serrées.
* Respect de `prefers-reduced-motion`.
* Sons locaux courts (départ, turbo, chute, arrivée) **coupés par défaut**, bouton muet.
* Message propre si le contexte WebGL échoue (fallback Canvas ou écran d'explication).

**Tests (DoD)**
* E2E avec `prefers-reduced-motion: reduce` : aucun effet de secousse déclenché (hook de debug),
  course correcte et jouable.
* Muet par défaut vérifié ; le son n'est jamais requis pour comprendre.
* Budget de performance non dégradé (mesuré en P017).

---

### P016 — PWA installable, paysage, offline

**Livrables**
* `vite-plugin-pwa` : `manifest.webmanifest` (`display: fullscreen` ou `standalone`,
  `orientation: landscape`, thème), icônes locales (192/512/maskable), service worker avec précache
  complet ⇒ hors ligne fonctionnel.
* `src/app/pwa.ts` : enregistrement + UI d'installation discrète.
* Overlay « tourne ton téléphone » en portrait sur mobile, jamais sur desktop.
* Gestion des `safe-area` (encoches), boutons tactiles ≥ 44 px.

**Tests (DoD)**
* E2E mobile paysage (844×390) : HUD entièrement visible, rien de coupé par les safe-areas simulées.
* E2E portrait (390×844) : overlay d'orientation affiché, course non lancée.
* Service worker enregistré, manifeste valide (`orientation === 'landscape'`, icônes présentes).
* Hors ligne : après un premier chargement, `context.setOffline(true)` puis rechargement ⇒ le jeu
  démarre et une course complète se déroule.
* Aucune requête vers un domaine externe (assertion sur les requêtes interceptées).

---

### P017 — E2E complets et budget de performance

**Livrables**
* Projets Playwright : `desktop-chromium` (1440×900), `mobile-landscape` (844×390),
  `mobile-landscape-touch`, plus WebKit/Firefox si disponible.
* Tests transverses : course complète, reproductibilité inter-projets (même seed ⇒ même podium sur
  desktop **et** mobile), mode debug, redimensionnement, aucune erreur console ni `unhandled rejection`.
* Mesure du framerate : ≥ 55 fps desktop, ≥ 30 fps mobile simulé ; cohérence entre pas de simulation
  et temps simulé.

**Tests (DoD)**
* Toute la suite passe en < 3 minutes en local.
* Zéro test `skip`/`fixme` restant (sauf justification écrite).
* Reproductibilité inter-projets validée — le point le plus important de la V1.
* **Reproductibilité du mode test** : `?fast=1` et ×1 donnent le même résultat, y compris à travers les
  3 pauses de checkpoint.

---

### P018 — Sérialisation, préparation serveur, documentation finale

**Livrables**
* `RaceEngine.serialize()/deserialize()` + test de round-trip ; `RaceSnapshot` documenté.
* `tools/headless-race.ts` : course complète en Node pur (sans Phaser, sans DOM), utilisé comme test
  d'intégration.
* `README.md` complet : install, scripts, paramètres d'URL, structure, comment ajouter un événement,
  comment ajouter un fait + un texte de speaker.
* `docs/ARCHITECTURE.md` final : couches, invariants, contrat de faits, séparation temps simulé /
  temps réel, feuille de route vers le mode multi-spectateurs.
* Bilan d'équilibrage final archivé (`docs/balance-report.md`) sur 1000 seeds.

**Tests (DoD)**
* `serialize → deserialize → continuer` produit exactement le même résultat qu'une course continue.
* `tools/headless-race.ts` s'exécute sans aucun global navigateur.
* Le test de frontière de P002 passe toujours (aucune régression d'architecture), y compris les
  nouvelles assertions : pas de `finishDistance`, pas de `timeScale`/`countdown` dans `core/`.
* `npm run verify` complet passe sur un dépôt fraîchement cloné.

---

### Backlog (P019+) — non planifié, ne pas commencer sans demande explicite

* **Paralléliser la campagne d'équilibrage — prévu en P017** (`worker_threads` dans
  `tools/balanceRunner.mjs`) : chaque seed est indépendante, donc la mesure est embarrassamment
  parallèle ; facteur ≈ 4 attendu, ce qui ramènerait `npm run balance -- --seeds=1000` autour de 12 s
  (43 s aujourd'hui, dont 29,1 ms/course pour le noyau seul, soit un plancher de 29 s en séquentiel).
  La reproductibilité n'est pas menacée : l'agrégation reste ordonnée par chunk.
* **Coût par pas du noyau** : `RaceEngine.step()` alloue à chaque pas (objet d'entrée de
  l'observateur, tableau de faits, itérateur `entries()` de la boucle des personnages). Un profil
  sérieux et une réutilisation de tampons rendraient le harnais et les tests nettement plus rapides —
  à faire sous couvert de tests de reproductibilité bit à bit.
* **Densité de parole du speaker dans les courses pauvres** : ≈ 10 % des courses descendent sous 12
  répliques alors que la moyenne est conforme (≈ 16,8). Les refus mesurés sont dominés par les
  cooldowns (`TYPE_COOLDOWN`, `GLOBAL_COOLDOWN`), donc le levier est la fenêtre de cooldown, pas le
  nombre de faits produits par le noyau — aucun réglage de P010 ne l'a déplacé.
* **Scripts Blender** (`tools/blender/`, `bpy` + CLI headless) : création/modification d'assets,
  import/export GLB/GLTF/OBJ, rendus PNG transparents, génération de sprites/spritesheets depuis des
  modèles 3D. Purement visuel, jamais d'influence sur la simulation — voir `AGENTS.md` §3.6.
* `DRAMA_MODE` (option **désactivée par défaut**) : pondération légère pilotée par le suspense — à
  n'ajouter qu'accompagné d'un test prouvant qu'il ne s'agit pas de rubber-banding caché.
* Plus d'événements (objets, interactions entre personnages, événements de piste).
* Mode multi-spectateurs synchronisé (serveur exécutant `RaceEngine` + diffusion de faits).
* Replay exportable / partage de seed avec classement.
* Classements cumulés sur plusieurs courses (localStorage uniquement, jamais une base de données).
* Banque de textes du speaker étendue — sans jamais toucher au gameplay.
* Localisation (EN) via `strings.*.ts`.
* **Moteur de rendu 3D (Three.js / Babylon.js)** : le choix est **volontairement non fait**. Il n'est
  ni Three.js ni Babylon.js par défaut, et **aucune dépendance 3D n'est installée** tant que le
  **Jalon 3D (P013.5)** n'a pas produit son prototype comparatif A/B/C. Toute demande d'installer un
  moteur 3D avant ce jalon est à signaler, pas à exécuter.
* **✅ Résolu avant P009 — Marge de dépassement dépendante de la fréquence d'observation**
  (constat P005, reconfirmé en P008). `overtakesBetween` ne comptait un dépassement que si le nouvel
  arrivant menait de plus de `OVERTAKE.MIN_MARGIN` (**0,5 m**) **au moment du relevé**. Or à la
  vitesse de base un pas ne fait avancer que de `SPEED.BASE × DT_S = 0,2 m` : observée **pas à pas**,
  une course ne produisait **aucun** dépassement compté (mesure P008 sur `OVERTAKE_SEED` : 20 pas →
  32 dépassements / 14 changements de leader ; 1 pas → **0** dépassement).
  **Correction** : `overtakesBetween` est remplacé par `src/core/overtakes.ts` (`OvertakeTracker`),
  une hystérésis par paire de personnages (§8.3 de `GAME_DESIGN.md`). `OVERTAKE.MIN_MARGIN` reste
  inchangée ; c'est le **franchissement de la marge par le nouveau côté confirmé**, et non une
  inversion de rang entre deux relevés, qui vaut dépassement. Le détecteur est alimenté à chaque pas
  simulé — donc indépendant du `timeScale`, du framerate et de la fréquence de rendu — et son état
  reste purement observationnel (aucun effet sur `x`, `v`, le rang ou le résultat).
  Nouvelle mesure sur `OVERTAKE_SEED`, pas à pas : **68 dépassements / 14 changements de leader**
  (65 pour un relevé tous les 20 pas : un observateur grossier peut manquer un aller-retour plus
  rapide que son intervalle, raison pour laquelle P009 observera chaque pas du noyau). Les seeds
  dorées sont inchangées au bit près.
