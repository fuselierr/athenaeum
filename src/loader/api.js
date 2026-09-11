/**
 * Where the conversion server is.
 *
 * In development it is this same origin: Vite proxies /api to the local
 * server (vite.config.js), so every path can stay relative. Deployed, the
 * site (Vercel) and the server are on different hosts, and the build is told
 * the server's address through ATHENAEUM_API_URL -- also vite.config.js.
 *
 * Every server address goes through api(), including the ones the server
 * sends back itself. pdfUrl and coverUrl arrive RELATIVE ("/api/books/.../pdf"),
 * and a relative url is resolved by the browser against the SITE -- which, once
 * the two are apart, is not where the file is.
 */

// `typeof` rather than a bare read, as in auth/session.js: a build that did
// not define it just talks to its own origin instead of throwing on load.
const CONFIGURED = (typeof __ATHENAEUM_API_URL__ === 'string' ? __ATHENAEUM_API_URL__ : '')
  .trim()
  .replace(/\/+$/, ''); // "https://host/" and "https://host" mean the same server

// A bare "host.up.railway.app", with no scheme, is not an address to fetch():
// it is a relative path, resolved against the SITE, and every request would
// quietly go to the site instead and come back 404. Taken as https.
const BASE = CONFIGURED && !/^[a-z][a-z\d+.-]*:\/\//i.test(CONFIGURED)
  ? `https://${CONFIGURED}`
  : CONFIGURED;

/**
 * A server path ("/api/...") as a url this page can fetch. Anything already
 * absolute -- a full url, a data: or blob: url -- and null pass through
 * untouched, so a response field can be handed over as-is.
 */
export function api(path) {
  if (typeof path !== 'string' || !path.startsWith('/')) return path;
  return `${BASE}${path}`;
}