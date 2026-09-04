import * as THREE from 'three';

// Which visible panel is the RIGHT-hand page of the spread. All spread
// ordering -- which page number goes where, and which way a drag turns --
// follows from this one line.
//
// 'C', because every panel renders its page with the top toward
// x = +HINGE_LEN/2 (PageSimulation.PAGE_TOP_AT_PLUS_X). A reader whose
// "up the page" is +X and who is looking down at the book has their right
// hand at +Z, and C is the panel that extends to +Z from the spine while
// B extends to -Z. Turning then works out on its own: dragging C sweeps
// it from the +Z side over to B's shape on the -Z side, i.e. right to
// left across the spine, which is what turning FORWARD looks like.
//
// This is one half of a two-part decision -- flip PAGE_TOP_AT_PLUS_X and
// this constant TOGETHER to make the book read from the other side of the
// desk (or for a right-to-left book, flip only this one).
export const RIGHT_HAND_PANEL = 'C';
export const LEFT_HAND_PANEL = RIGHT_HAND_PANEL === 'B' ? 'C' : 'B';

// Eased rather than snapped, per frame, because the step per turn is
// 1/spreads of the whole travel: invisible in a 400-page book, but a
// quarter of the range in an 8-page one, which snaps hard enough to read
// as a glitch. Easing costs nothing and covers both.
const BC_EASE_RATE = 6; // 1/s

/**
 * The book's content model: which page each panel currently shows, where a
 * turn from a given panel would land, and how far through the book we are.
 *
 * Owns the page canvases and their lazily-built textures, the current
 * spread (`leafStart`), and the eased hinge position that makes the two
 * page stacks reflect reading position. Knows nothing about pointers,
 * cameras or the render loop -- callers drive it through showLeaf/turn*
 * and tick it with update(dt).
 *
 * @param {() => import('../pageSim/PageSimulation.js').PageSimulation} getPages
 *   a closure, not a captured reference: the simulation is disposed and
 *   rebuilt whenever a loaded book's page dimensions change.
 */
export function createBookContent(getPages) {
  let pageCanvases = [];
  const pageTextures = []; // one THREE.CanvasTexture per page index, built lazily, reused across turns
  let leafStart = 0;

  // The wedge either side of the shared B/C hinge IS the visible stack of
  // pages on that side, and its thickness is just the distance from the
  // hinge to that side's cover. So sliding the hinge along the spine is
  // the same thing as saying how much of the book has been read: at the
  // start the hinge sits against cover A, leaving almost nothing on B's
  // side and the whole block on C's; at the end it has travelled to cover
  // D and the stacks have swapped.
  //
  // PageSimulation.setProgress takes 0 = against cover A, 1 = against
  // cover D, which lines up with leafStart/maxLeafStart as-is -- no
  // inversion -- because RIGHT_HAND_PANEL is C, the panel on cover D's side.
  let readingProgress = 0;

  function textureForPage(index) {
    if (!pageCanvases[index]) return null;
    if (!pageTextures[index]) {
      pageTextures[index] = new THREE.CanvasTexture(pageCanvases[index]);
    }
    return pageTextures[index];
  }

  // Highest leafStart the book can be opened to -- the last spread. Also
  // the denominator for how far through the book we are.
  function maxLeafStart() {
    if (pageCanvases.length < 2) return 0;
    return pageCanvases.length - (pageCanvases.length % 2 === 0 ? 2 : 1);
  }

  function clampLeafStart(start) {
    if (pageCanvases.length === 0) return 0;
    return Math.max(0, Math.min(start, maxLeafStart()));
  }

  // Which page index a panel shows for a given spread: lower number on the
  // left, higher on the right -- the ordinary two-page-spread convention.
  function pageIndexForPanel(panel, start) {
    return panel === RIGHT_HAND_PANEL ? start + 1 : start;
  }

  function oppositePanel(panel) {
    return panel === RIGHT_HAND_PANEL ? LEFT_HAND_PANEL : RIGHT_HAND_PANEL;
  }

  // Where dragging `panel` would land -- dragging the right-hand page
  // turns FORWARD, the left-hand page BACKWARD, matching dragPageTurn.js's
  // own panel-decides-direction rule.
  function turnTargetLeafStart(panel) {
    return clampLeafStart(leafStart + (panel === RIGHT_HAND_PANEL ? 2 : -2));
  }

  function showLeaf(start) {
    if (pageCanvases.length === 0) return;
    leafStart = clampLeafStart(start);
    for (const panel of [LEFT_HAND_PANEL, RIGHT_HAND_PANEL]) {
      const tex = textureForPage(pageIndexForPanel(panel, leafStart));
      if (tex) getPages().setPageTexture(panel, tex);
    }
    const max = maxLeafStart();
    readingProgress = max > 0 ? leafStart / max : 0;
  }

  return {
    /** Adopt a freshly rendered book and open it at the first spread. */
    setCanvases(canvases) {
      pageCanvases = canvases;
      pageTextures.length = 0;
      leafStart = 0;
      showLeaf(0);
      // Snap, don't ease, on a fresh book: a rebuilt simulation starts
      // with its hinge centred, and easing from there would look like the
      // book settling from the middle every time one loads.
      getPages().setProgress(readingProgress);
    },

    showLeaf,

    /** Ease the hinge toward the spread we're actually on. */
    update(dt) {
      const pages = getPages();
      const current = pages.progress;
      if (Math.abs(current - readingProgress) < 1e-4) return;
      pages.setProgress(current + (readingProgress - current) * Math.min(BC_EASE_RATE * dt, 1));
    },

    // --- what a turn from `panel` involves -------------------------------
    // Shared by dragPageTurn's preview and its eventual commit so the two
    // always agree with each other and with showLeaf.

    canTurn(panel) {
      return turnTargetLeafStart(panel) !== leafStart;
    },

    // The two pages a turn needs beyond the one being grabbed, which are
    // NOT the same page -- conflating them is what put the page after next
    // on the back of the turning leaf.
    //
    // A leaf turned from one side of the spine lands on the OTHER side, so
    // the page on its far face is the one that ends up on the opposite
    // panel of the target spread. Meanwhile the panel you grabbed is left
    // showing its own slot of that same target spread. Turning forward
    // from [N, N+1] with N+1 grabbed: the leaf's far face is N+2 (the new
    // left-hand page) while N+3 is uncovered underneath on the right.
    landingTexture(panel) {
      return textureForPage(pageIndexForPanel(oppositePanel(panel), turnTargetLeafStart(panel)));
    },
    underneathTexture(panel) {
      return textureForPage(pageIndexForPanel(panel, turnTargetLeafStart(panel)));
    },
    commitTurn(panel) {
      showLeaf(turnTargetLeafStart(panel));
    },
  };
}
