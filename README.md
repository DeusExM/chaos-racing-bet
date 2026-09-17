# Chaos Race

Course humoristique à 6 personnages, 100 % locale dans le navigateur et reproductible par seed.

* `GAME_DESIGN.md` — règles du jeu (normatif)
* `ROADMAP.md` — architecture cible et étapes de développement
* `AGENTS.md` — règles de travail (à lire avant toute contribution)

## État actuel

**P001 — échafaudage.** Le projet se typecheck, se teste, se build et se lance. Il n'y a **pas
encore de course** : `src/app/main.ts` ne monte qu'un canvas Phaser vide sur une scène sans logique.
Aucun personnage, aucun asset, aucune simulation.

## Prérequis

* Node.js (testé avec `v26.5.0`) et npm (`11.17.0`).
* **Windows + PowerShell** : la politique d'exécution de ce poste bloque `npm.ps1` et `pnpm.ps1`.
  Toujours utiliser les shims `.cmd` — `npm.cmd`, `pnpm.cmd`, `npx.cmd` — et **ne pas** modifier la
  politique d'exécution de la machine.

## Commandes

| Commande | Effet |
| --- | --- |
| `npm.cmd run dev` | Serveur de développement Vite sur `http://127.0.0.1:5173` |
| `npm.cmd run build` | Build de production dans `dist/` |
| `npm.cmd run preview` | Sert `dist/` sur `http://127.0.0.1:18173` (voir `dev-ports.ts`) |
| `npm.cmd run typecheck` | `tsc --noEmit` |
| `npm.cmd run test` | Tests unitaires Vitest (sans navigateur) |
| `npm.cmd run test:e2e` | Tests Playwright (build + preview automatiques) |
| `npm.cmd run test:e2e:install` | Installe Chromium dans `.playwright-browsers` (voir ci-dessous) |
| `npm.cmd run verify` | `typecheck` + `test` + `build` + `test:e2e` |

Les tests E2E tournent **contre le build de production** servi par `vite preview` : ils vérifient
donc aussi que `npm.cmd run build` produit un `dist/` réellement utilisable.

## Structure

```
src/
  core/      noyau pur : aucune dépendance, ni Phaser, ni DOM, ni horloge
  sim/       orchestration temps réel + noyau (pas fixes, pauses, timeScale)
  speaker/   commentaires, alimenté uniquement par des RaceFact
  render/    affichage Phaser, lecture seule
  app/       démarrage, câblage, textes français
tests/
  unit/      Vitest, environnement node
  e2e/       Playwright, sur le build de production
tools/       outillage de développement
```

Le sens des dépendances est à sens unique (`app → sim → core`, `app → render`, `app → speaker →
core/types`). Voir `AGENTS.md` §4.

## Environnement Windows et bac à sable : particularités

Tout est configuré pour rester **dans `D:\Code\chaos-race`** : aucun cache, aucun navigateur, aucun
artefact de test n'est écrit dans `AppData`.

### 1. Cache npm

`.npmrc` contient `cache=.npm-cache` (et `store-dir=.pnpm-store` pour un usage futur de pnpm).

> **Piège :** une variable d'environnement `npm_config_cache` injectée dans le shell est
> **prioritaire sur `.npmrc`**. Si elle est présente, npm écrit dans `AppData\Local\npm-cache`.
> Pour que le cache local s'applique :
>
> ```powershell
> Remove-Item Env:npm_config_cache -ErrorAction SilentlyContinue
> ```
>
> Vérification : `npm.cmd config get cache` doit afficher `D:\Code\chaos-race\.npm-cache`.

`store-dir` n'est pas une clé npm : npm affiche un avertissement
`Unknown project config "store-dir"` à chaque commande. C'est inoffensif, la clé est destinée à pnpm.

### 2. Navigateurs Playwright

Les navigateurs vivent dans `.playwright-browsers/`, **jamais** dans `AppData`. `.playwright.env`
définit `PLAYWRIGHT_BROWSERS_PATH`, chargé par les scripts npm via `node --env-file=.playwright.env`.

La variable doit être positionnée **avant le démarrage de Node** : `playwright-core` l'évalue une
seule fois au chargement de son module, donc la définir dans `playwright.config.ts` serait trop tard.

```powershell
node --env-file=.playwright.env --input-type=module -e "const {chromium}=await import('@playwright/test'); console.log(chromium.executablePath())"
# => D:\Code\chaos-race\.playwright-browsers\chromium-1243\chrome-win64\chrome.exe
```

Seul **Chromium** est nécessaire ; ne pas installer Firefox ni WebKit par anticipation.

#### Installer les navigateurs quand `playwright install` est bloqué

`npm.cmd run test:e2e:install` échoue dans le bac à sable de l'agent : Playwright télécharge via un
processus enfant forké avec IPC, et le bac à sable interdit les tubes nommés (`spawn EPERM`).
Le téléchargement n'étant que du HTTP, il peut être fait à la main, entièrement dans le projet :

1. Télécharger les archives (versions exactes dans `node_modules/playwright-core/browsers.json`,
   ou affichées par `... cli.js install chromium --dry-run`) :

   | Archive | URL |
   | --- | --- |
   | `chrome-win64.zip` | `https://cdn.playwright.dev/builds/cft/153.0.8010.12/win64/chrome-win64.zip` |
   | `chrome-headless-shell-win64.zip` | `https://cdn.playwright.dev/builds/cft/153.0.8010.12/win64/chrome-headless-shell-win64.zip` |
   | `ffmpeg-win64.zip` | `https://cdn.playwright.dev/dbazure/download/playwright/builds/ffmpeg/1011/ffmpeg-win64.zip` |
   | `winldd-win64.zip` | `https://cdn.playwright.dev/dbazure/download/playwright/builds/winldd/1007/winldd-win64.zip` |

   Utiliser `node` + `fetch` (et non `Invoke-WebRequest`, qui échoue ici sur la négociation TLS).

2. Extraire chaque archive dans le dossier attendu, puis créer le marqueur `INSTALLATION_COMPLETE`
   (fichier vide) à sa racine :

   | Archive | Dossier cible | Exécutable attendu |
   | --- | --- | --- |
   | `chrome-win64.zip` | `.playwright-browsers/chromium-1243/` | `chrome-win64/chrome.exe` |
   | `chrome-headless-shell-win64.zip` | `.playwright-browsers/chromium_headless_shell-1243/` | `chrome-headless-shell-win64/chrome-headless-shell.exe` |
   | `ffmpeg-win64.zip` | `.playwright-browsers/ffmpeg-1011/` | `ffmpeg-win64.exe` |
   | `winldd-win64.zip` | `.playwright-browsers/winldd-1007/` | `PrintDeps.exe` |

### 3. Fichiers temporaires

`.tmp/` est le répertoire temporaire local au projet. Pour une commande qui risque d'écrire hors du
workspace (Chromium notamment) :

```powershell
$env:TEMP="$PWD\.tmp"; $env:TMP="$PWD\.tmp"
```

**Ne jamais modifier les variables `TEMP`/`TMP` globales de Windows.**

### 4. Bac à sable de l'agent : tubes nommés interdits

En mode `workspace-write`, les programmes ne peuvent pas ouvrir de tubes nommés. Vite (qui appelle
`exec("net use")` sur Windows), Vitest et Playwright lancent des processus enfants avec `stdio` en
tube et échouent en `spawn EPERM`. C'est une **limite du bac à sable, pas un problème de chemin** :
rien ne peut être déplacé dans le workspace pour l'éviter. `npm.cmd run verify` doit donc être
exécuté avec un accès complet.

### 5. Git et réseau

* Aucune installation globale (`npm install -g`), aucune modification de la configuration git
  globale, aucun credential helper global.
* `git push` subit la **même limite de tubes nommés** que `verify` : Git pour Windows lance ses
  utilitaires MSYS (`sh.exe`, `bash.exe`), qui échouent en `couldn't create signal pipe, Win32 error
  5`, suivi d'un `could not read Username for 'https://github.com'` trompeur. Le push fonctionne avec
  un accès complet, en utilisant les identifiants déjà stockés par Windows.
* Vite écoute uniquement sur `127.0.0.1`, jamais sur `0.0.0.0`. Le pare-feu Windows n'est pas
  modifié.
* L'application finale ne fait **aucun** appel réseau à l'exécution (voir `AGENTS.md` §3.4) ; les
  accès réseau de développement (npm, téléchargement de navigateurs, git) sont autorisés.
