/**
 * Ports d'outillage local (jamais utilisés par l'application elle-même).
 *
 * **Convention du projet : plage `18000–18999`.** Elle a été choisie après qu'un correctif
 * d'infrastructure a dû être appliqué : Windows réserve **dynamiquement** des plages de ports à
 * l'intérieur de sa plage dynamique (`1024–15000` sur ce poste), et un `bind()` sur un port réservé
 * échoue en `EACCES`. Cas constaté : la plage `4108–4207`, qui contenait `4173` — `vite preview` ne
 * démarrait donc plus, et `npm run verify` échouait à l'étape E2E sans qu'aucun test ne soit en cause.
 *
 * Le serveur de développement a suivi le même déplacement pour **une raison de convention**, pas de
 * panne : `5173` répondait encore (`bind` testé : OK) et n'était pas dans la liste des plages
 * exclues au moment du changement, mais il se trouve dans la plage dynamique où Windows peut en
 * créer une à tout moment. Une seule convention pour tout l'outillage évite d'y revenir au cas par
 * cas, et rien n'obligeait à garder `5173` : c'est un port de développement, sans contrat externe.
 *
 * Source **unique** : chaque paire hôte/port est lue ici par le fichier de configuration concerné, et
 * les deux copies d'une même URL finissent toujours par diverger.
 *
 * Réservations :
 * * `18100` — serveur de développement Vite (`vite.config.ts`, `server`) ;
 * * `18173` — serveur de prévisualisation (`vite.config.ts`, `preview`) et `baseURL` des E2E
 *   (`playwright.config.ts`).
 *
 * Le harnais d'outillage externe au projet utilise `18080` : cette valeur n'a pas à être intégrée ici,
 * c'est un outil hors dépôt.
 */
export const DEV_HOST = '127.0.0.1';
export const DEV_PORT = 18100;
export const DEV_URL = `http://${DEV_HOST}:${DEV_PORT}`;

export const PREVIEW_HOST = '127.0.0.1';
export const PREVIEW_PORT = 18173;
export const PREVIEW_URL = `http://${PREVIEW_HOST}:${PREVIEW_PORT}`;