/**
 * Ports d'outillage local (jamais utilisés par l'application elle-même).
 *
 * **Convention du projet : plage `18000–18999`.** Elle a été choisie après qu'un correctif
 * d'infrastructure a dû être appliqué : Windows réserve dynamiquement des plages de ports autour de
 * `4000` (WinNAT/Hyper-V, par exemple `4108–4207` sur le poste de développement), et un `bind()` sur
 * un port réservé échoue en `EACCES` — `vite preview` ne pouvait alors plus démarrer, donc
 * `npm run verify` échouait à l'étape E2E sans qu'aucun test ne soit en cause.
 *
 * Source **unique** : le serveur de prévisualisation (`vite.config.ts`) et la `baseURL` des tests E2E
 * (`playwright.config.ts`) doivent impérativement désigner le même port. Deux copies d'un même numéro
 * de port finissent toujours par diverger.
 */
export const PREVIEW_HOST = '127.0.0.1';
export const PREVIEW_PORT = 18173;
export const PREVIEW_URL = `http://${PREVIEW_HOST}:${PREVIEW_PORT}`;
