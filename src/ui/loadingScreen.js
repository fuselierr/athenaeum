/**
 * The loading screen: what covers the page from the first paint until the
 * room is built and the shelf has its books -- and again, via show(), while
 * the outdoors is loaded behind the door (scene/outside/outside.js).
 *
 * Its markup and styles live in index.html, not here. They have to be on
 * screen before any script has loaded, and this module only arrives with
 * main.js -- so this just moves it along: a line saying what is happening, a
 * progress bar, and a fade when it is done.
 *
 * THE BAR IS THE WHOLE LOAD, not the current step. Each status() says how far
 * through everything its step begins (`progress`) and, optionally, how far the
 * step may take it before the next one does (`upTo`). In between, the bar
 * creeps toward `upTo` -- quickly at first, slowing as it closes in, never
 * reaching it -- so a step with nothing to count (a model downloading, shaders
 * compiling) still visibly moves without claiming to be done. A step that can
 * count (books shelved, textures loaded) just passes its own position each
 * time. Either way the bar never goes backwards.
 *
 * Everything here is a no-op if the element is missing, so a page without
 * the screen still starts normally.
 */

const root = document.getElementById('loading');
const statusLine = root?.querySelector('.loading-status');
const bar = root?.querySelector('.loading-bar');
const fill = root?.querySelector('.loading-fill');

const FADE_MS = 500; // matches #loading's transition in index.html
const FAILURE_HOLD_MS = 2800; // long enough to read a sentence, then out of the way
// How quickly the bar creeps toward a step's `upTo`: about two thirds of the
// way there in this many seconds, then slower and slower.
const CREEP_SECONDS = 4;

let finished = false;
let fadeTimer = null;
let failTimer = null;

let shown = 0; // what the bar shows, 0..1
let ceiling = 0; // how far the current step may creep it
let creepFrame = null;
let lastCreep = 0;

const clamp01 = (value) => Math.min(1, Math.max(0, value));

function render() {
  if (fill) fill.style.width = `${(shown * 100).toFixed(2)}%`;
  bar?.setAttribute('aria-valuenow', String(Math.round(shown * 100)));
}

function creep(now) {
  creepFrame = null;
  if (finished) return;
  const dt = Math.min((now - lastCreep) / 1000, 0.25);
  lastCreep = now;
  shown += (ceiling - shown) * (1 - Math.exp(-dt / CREEP_SECONDS));
  render();
  if (ceiling - shown > 0.0005) creepFrame = requestAnimationFrame(creep);
}

function startCreep() {
  if (creepFrame !== null || finished || ceiling - shown <= 0.0005) return;
  lastCreep = performance.now();
  creepFrame = requestAnimationFrame(creep);
}

function stopCreep() {
  if (creepFrame !== null) cancelAnimationFrame(creepFrame);
  creepFrame = null;
}

function hide() {
  if (!root || finished) return;
  finished = true;
  stopCreep();
  root.classList.add('done');
  root.setAttribute('aria-busy', 'false');
  // Kept, not removed: show() brings it back. Out of the layout once faded.
  fadeTimer = setTimeout(() => { root.style.display = 'none'; }, FADE_MS);
}

/**
 * Bring the screen back up over the page, saying `text`, for a load that
 * happens after startup. Fades in with an empty bar; finish() or fail() take
 * it away as usual.
 */
function show(text) {
  if (!root) return;
  clearTimeout(fadeTimer);
  clearTimeout(failTimer);
  finished = false;
  shown = 0;
  ceiling = 0;
  bar?.classList.remove('failed');
  // Emptied while the screen is still out of the layout, so the bar does not
  // visibly run backwards as it fades in.
  render();
  root.style.display = '';
  void root.offsetWidth; // lay it out transparent first, so it fades in
  root.classList.remove('done');
  root.setAttribute('aria-busy', 'true');
  status(text);
}

/**
 * Say what is happening, and how far through the whole load it has got.
 *
 * @param {string|null} text  null keeps the line as it is
 * @param {number} [progress]  0..1 through the WHOLE load; left out, the bar
 *   carries on as it was
 * @param {number} [upTo]  how far the bar may creep before the next step
 *   says otherwise; left out, it holds at `progress`
 */
function status(text, progress, upTo) {
  if (!root || finished) return;
  if (statusLine && text != null) statusLine.textContent = text;
  if (!Number.isFinite(progress)) return;
  const at = clamp01(progress);
  ceiling = Math.max(at, Number.isFinite(upTo) ? clamp01(upTo) : at);
  shown = Math.max(shown, at);
  render();
  startCreep();
}

/** Everything is in. Fill the bar, then fade. */
function finish() {
  status(null, 1);
  hide();
}

/** Something did not work. Say so briefly, then get out of the way. */
function fail(text) {
  if (!root || finished) return;
  status(text, 1);
  bar?.classList.add('failed');
  failTimer = setTimeout(hide, FAILURE_HOLD_MS);
}

// If starting up throws, nothing will ever call finish() -- so say so, and
// stay up: behind it is a room that did not finish building.
window.addEventListener('error', () => {
  if (!root || finished) return;
  status('Something went wrong opening the room. Try reloading the page.', 1);
  bar?.classList.add('failed');
  stopCreep();
});

export const loadingScreen = { status, finish, fail, show };
