import * as THREE from 'three';
import { COVER_START_NEAR, COVER_START_FAR } from '../pageSim/config.js';

/**
 * Opening a shut book from the keyboard.
 *
 * Nothing stops a page turn in a shut book -- it just cannot be seen. A
 * turning leaf sweeps from one pseudo body's angle to the other's
 * (dragPageTurn's shapeTargets), and in a shut book both lie on the same
 * side of the spine, so the sweep goes from there to there. Opening one
 * is two separate motions, because opening a real one is:
 *
 *   1. the board swings open on its own. The first leaf does not come with
 *      it -- H1 <= A bounds A from one side only, so A stays with the block
 *      the way an endpaper does;
 *   2. the half of the block that belongs on that board's side is lifted
 *      over the spine onto it. Holding the pseudo body carries its
 *      reference page along (enforceNoPassingRef keeps A <= P1), so the
 *      whole half comes across as one.
 *
 * After that there is a spread for a turn to cross, and the same key goes
 * back to turning pages.
 *
 * PageSimulation.openState decides which of these the book needs; this
 * only plays them. Each is a hold eased from wherever that part is to
 * where it belongs and then let go, the way dragCover lets go of a board,
 * so the book settles from there on its own physics instead of being left
 * pinned in a pose.
 */

// Long enough to read as a hand moving a board, not a snap.
const COVER_OPEN_DURATION = 0.8; // seconds
const SPREAD_FLIP_DURATION = 0.65; // seconds

function easeInOut(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - ((-2 * t + 2) ** 3) / 2;
}

export function createBookOpening({ getPages, dragCover, dragPageTurn }) {
  let motion = null;

  // A press that arrived mid-motion. One, not a queue: two quick taps
  // should open the board and then the spread, but a held key must not
  // bank a run of page turns behind the animation.
  let queued = null;

  /** Whether the pointer has hold of anything -- a board or a spread. */
  function pointerHolding() {
    return Boolean(dragCover.draggingCover || dragCover.draggingSpread);
  }

  function hold(m, angle) {
    if (m.kind === 'cover') m.pages.setHardcoverHold(m.part, angle);
    else m.pages.setSpreadHold(m.part, angle);
  }

  function start(pages, { side, needs }) {
    const board = side === 'front' ? 'H1' : 'H2';
    if (needs === 'cover') {
      // The "lying open on the desk" pose the book resets into -- see
      // COVER_START_NEAR/FAR, which are pi-relative on purpose.
      const rest = board === 'H1' ? COVER_START_NEAR : COVER_START_FAR;
      motion = {
        kind: 'cover', part: board, pages,
        from: pages.hardcoverAngles[board], to: () => rest,
        duration: COVER_OPEN_DURATION, elapsed: 0, finished: false,
      };
    } else {
      const { P1, P2 } = pages.panelAngles;
      motion = {
        kind: 'spread', part: side, pages,
        from: side === 'front' ? P1 : P2,
        // Read live: the board it lands on may still be settling.
        to: () => pages.hardcoverAngles[board],
        duration: SPREAD_FLIP_DURATION, elapsed: 0, finished: false,
      };
    }
  }

  /**
   * What an arrow key does. Opens the book a step if it needs opening,
   * otherwise plays the turn. Either key opens -- a shut book only has one
   * board that CAN open, so which arrow was pressed carries no choice.
   *
   * Returns true when the press was used.
   */
  function turn(panel) {
    if (motion) {
      queued = panel;
      return true;
    }
    const pages = getPages();
    if (!pages || pointerHolding()) return false; // whatever the pointer holds is the reader's
    const state = pages.openState;
    if (!state.needs) return dragPageTurn.playTurn(panel);
    start(pages, state);
    return true;
  }

  /** Call BEFORE pages.step(), so each frame's hold lands in that frame's step. */
  function update(dt) {
    if (!motion) return;

    // Rebuilt underneath (a new book's dimensions): the holds went with the
    // old simulation and there is nothing to finish.
    if (getPages() !== motion.pages) {
      motion = null;
      queued = null;
      return;
    }

    // Grabbed mid-motion: the reader takes over. This motion's hold is let
    // go UNLESS the pointer has hold of that very part, in which case the
    // hold is the pointer's now and releasing it would drop the grip. A
    // board pinned for the length of a drag on the other one (dragCover's
    // frozenCover) counts as the pointer's too -- releasing it would unpin
    // the board the reader expects to stay still. Any other part is let
    // go, or it would stay pinned with nothing driving it.
    if (pointerHolding()) {
      const pointerOwnsIt = motion.kind === 'cover'
        ? dragCover.draggingCover === motion.part || dragCover.frozenCover === motion.part
        : dragCover.draggingSpread === motion.part;
      if (!pointerOwnsIt) hold(motion, null);
      motion = null;
      queued = null;
      return;
    }

    // Let go one frame AFTER the final angle was set, so that angle is
    // actually applied by a step before gravity takes over.
    if (motion.finished) {
      hold(motion, null);
      motion = null;
      if (queued) {
        const panel = queued;
        queued = null;
        turn(panel);
      }
      return;
    }

    motion.elapsed += dt;
    const t = Math.min(motion.elapsed / motion.duration, 1);
    hold(motion, THREE.MathUtils.lerp(motion.from, motion.to(), easeInOut(t)));
    if (t >= 1) motion.finished = true;
  }

  return {
    turn,
    update,
    get opening() { return motion !== null; },
  };
}