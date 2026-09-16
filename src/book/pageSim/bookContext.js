import {
  HINGE_LEN, PANEL_REACH, SPINE_GAP, SPINE_ROTATION,
  setPageDimensions, setSpineGap, setSpineRotation,
} from './config.js';
import { updateLocalCorners } from './math.js';

/**
 * Whose book the mechanism is working on.
 *
 * Several books can be out at once, each its own size and thickness. But the
 * page mechanism reads its dimensions as MODULE-LEVEL bindings (config.js) --
 * live, from ten files and a couple of hundred places: the spreads read them
 * every frame, the covers bake them into geometry, a drag reads them to bend a
 * leaf, the physics bakes them into bodies. Handing every one of those an
 * instance to read from would be a rewrite of the mechanism, and the mechanism
 * is the part of this app least worth destabilising.
 *
 * So the numbers stay where they are, and what changes is WHICH BOOK'S numbers
 * they currently are. Every book keeps its own set; `use` puts one set in force
 * for a piece of work and puts back whatever was in force before it. Stepping
 * book A and then book B gives each its own size without either one knowing the
 * other exists.
 *
 * TWO RULES, and everything here follows from them:
 *
 *   1. Anything done to a book must happen inside that book's `use` -- its
 *      step, its rebuilds, a drag moving one of its leaves. Work done outside
 *      one reads whichever book went last. The book in your hands is kept
 *      installed between frames (main.js) precisely so that the handlers that
 *      fire between frames -- a pointer drag, a menu -- land on it.
 *   2. The mechanism WRITES some of these as it runs: the spine leans a little
 *      further every step (config.js's setSpineRotation). So leaving a book's
 *      window reads the live numbers back into it, or the lean would be handed
 *      to whichever book is stepped next.
 */

/**
 * A book's own numbers. Defaults are config.js's own starting values, which is
 * what a book that has not been sized yet should be.
 */
export function createBookConfig({
  hingeLen = HINGE_LEN,
  panelReach = PANEL_REACH,
  spineGap = SPINE_GAP,
  spineRotation = 0,
} = {}) {
  return { hingeLen, panelReach, spineGap, spineRotation };
}

/** Whose numbers are in force right now, or null before any book exists. */
let current = null;

/** The book whose numbers are in force. */
export function currentBookConfig() {
  return current;
}

/**
 * Put a book's numbers in force and leave them there -- for the book being
 * read, so that whatever happens between frames happens to it. Work on any
 * OTHER book belongs in `use`.
 */
export function install(config) {
  current = config;
  if (!config) return;
  setPageDimensions(config.hingeLen, config.panelReach);
  setSpineGap(config.spineGap);
  setSpineRotation(config.spineRotation);
  // The wedge-loft corners are precomputed from those dimensions rather than
  // read fresh, so they are part of what it means to install a book.
  updateLocalCorners();
}

/** Read back whatever the mechanism changed while this book's numbers were in force. */
export function capture(config) {
  if (!config) return;
  config.hingeLen = HINGE_LEN;
  config.panelReach = PANEL_REACH;
  config.spineGap = SPINE_GAP;
  config.spineRotation = SPINE_ROTATION;
}

/**
 * Do a piece of work on `config`'s book: its numbers in force for the duration,
 * what the work changed read back into it, and whatever was in force before put
 * back. Returns whatever the work returned.
 */
export function use(config, work) {
  const previous = current;
  install(config);
  try {
    return work();
  } finally {
    capture(config);
    install(previous);
  }
}

/**
 * The same, for work that spans awaits -- building a book, or rebuilding one at
 * a new size. The numbers stay in force ACROSS the awaits, which is safe
 * because `use` always puts back whatever it found: a frame stepping other
 * books in the middle of a build leaves this book's numbers where they were.
 */
export async function useAsync(config, work) {
  const previous = current;
  install(config);
  try {
    return await work();
  } finally {
    capture(config);
    install(previous);
  }
}
