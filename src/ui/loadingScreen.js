/**
 * The loading screen: what covers the page from the first paint until the
 * room is built and the shelf has its books -- and again, via show(), while
 * the outdoors is loaded behind the door (scene/outside/outside.js).
 *
 * Its markup and styles live in index.html, not here. They have to be on
 * screen before any script has loaded, and this module only arrives with
 * main.js -- so this just moves it along: a line saying what is happening, a
 * bar once there is something to count, and a fade when it is done.
 *
 * Everything here is a no-op if the element is missing, so a page without
 * the screen still starts normally.
 */

const root = document.getElementById('loading');
const statusLine = root?.querySelector('.loading-status');
const bar = root?.querySelector('.loading-bar');
const fill = root?.querySelector('.loading-fill');
const skip = root?.querySelector('.loading-skip');

const FADE_MS = 500; // matches #loading's transition in index.html
const FAILURE_HOLD_MS = 2800; // long enough to read a sentence, then out of the way

// An escape hatch even if startup never reaches allowSkip() -- a scene that
// fails to build should not leave a screen nobody can get past.
const FALLBACK_SKIP_MS = 15000;

let finished = false;
let skipTimer = null;
let fadeTimer = null;
let failTimer = null;

function hide() {
  if (!root || finished) return;
  finished = true;
  clearTimeout(skipTimer);
  root.classList.add('done');
  root.setAttribute('aria-busy', 'false');
  // Kept, not removed: show() brings it back. Out of the layout once faded.
  fadeTimer = setTimeout(() => { root.style.display = 'none'; }, FADE_MS);
}

/**
 * Bring the screen back up over the page, saying `text`, for a load that
 * happens after startup. Fades in; finish() or fail() take it away as usual.
 * No "enter without waiting" here -- there is nothing behind it to enter.
 */
function show(text) {
  if (!root) return;
  clearTimeout(fadeTimer);
  clearTimeout(failTimer);
  clearTimeout(skipTimer);
  finished = false;
  if (skip) skip.hidden = true;
  bar?.classList.remove('failed');
  root.style.display = '';
  void root.offsetWidth; // lay it out transparent first, so it fades in
  root.classList.remove('done');
  root.setAttribute('aria-busy', 'true');
  status(text);
}

/**
 * Say what is happening. `fraction` (0..1) fills the bar; leave it out when
 * there is nothing to count yet, and the bar sweeps instead.
 */
function status(text, fraction) {
  if (!root || finished) return;
  if (statusLine && text != null) statusLine.textContent = text;
  const known = Number.isFinite(fraction);
  bar?.classList.toggle('indeterminate', !known);
  if (fill) fill.style.width = known ? `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%` : '';
}

/**
 * Offer "Enter without waiting" after `afterMs`. Worth it once the room
 * itself is standing: a sleeping server can take a long time to wake, and
 * there is no reason to hold someone at the door while the shelf fills.
 * The books keep arriving behind the screen either way.
 */
function allowSkip(afterMs) {
  if (!skip || finished) return;
  clearTimeout(skipTimer);
  skipTimer = setTimeout(() => {
    if (!finished) skip.hidden = false;
  }, afterMs);
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

skip?.addEventListener('click', hide);
allowSkip(FALLBACK_SKIP_MS);

export const loadingScreen = { status, allowSkip, finish, fail, show };