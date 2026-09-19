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

// How many pages around the open spread keep their GPU uploads: from this
// many before its left-hand page to this many from it onward -- the spread
// itself and two spreads either side, so a page turn or two in any direction
// finds its pages already there. A page texture is ~3 MB on the GPU, and
// without this every page ever turned to stays uploaded until the tab closes.
// A page further off is freed and simply uploaded again if it comes back.
const KEEP_BEHIND = 4;
const KEEP_AHEAD = 5;

/**
 * The book's content model: which page each panel currently shows, where a
 * turn from a given panel would land, and how far through the book we are.
 *
 * Owns the book's pages (a PageSource from loader/bookLoader.js) and their
 * lazily-built textures, the current spread (`leafStart`), and the eased
 * hinge position that makes the two page stacks reflect reading position.
 *
 * PAGES ARRIVE WHILE YOU READ. The source hands over every page at once as a
 * blank canvas and renders into those same canvases in the background, so a
 * page's texture is made from its canvas whenever it is first needed --
 * blank paper or finished, it does not matter -- and told to upload again
 * the moment that page is done. Where the reader is goes back to the source
 * (focus) so the pages around the open spread are the ones rendered next.
 *
 * Knows nothing about pointers, cameras or the render loop -- callers drive
 * it through showLeaf/turn* and tick it with update(dt).
 *
 * @param {() => import('../pageSim/PageSimulation.js').PageSimulation} getPages
 *   a closure, not a captured reference: the simulation is disposed and
 *   rebuilt whenever a loaded book's page dimensions change.
 */
export function createBookContent(getPages) {
  let source = null; // the book's pages -- see loader/bookLoader.js's openPdfPages
  let stopListening = null;
  const pageTextures = []; // one THREE.CanvasTexture per page index, built lazily, reused across turns
  // Page indices whose textures have been handed out since they were last
  // freed -- the ones that may be holding GPU memory.
  const liveTextures = new Set();
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

  // A and D are the outer cover PAGES: permanently the book's first and
  // last leaves. They never turn, so they are painted once per loaded book
  // rather than per spread.
  //
  // They get their OWN texture instances rather than the shared per-page
  // ones above, because setPageTexture bakes a slot's uv orientation into
  // the texture object itself (PageSimulation.orientPageTexture, driven by
  // SLOT_ON_MINUS_Z) and A and D sit on opposite sides of the block. Any
  // book whose first and last page are the same one -- a single-page pdf --
  // would otherwise hand both slots the same object and have them fight
  // over its repeat values, leaving one cover mirrored.
  const coverTextures = { A: null, D: null };

  const pageCount = () => source?.count ?? 0;
  const canvasFor = (index) => source?.canvasFor(index) ?? null;

  function paintCovers() {
    const pages = getPages();
    const covers = { A: canvasFor(0), D: canvasFor(pageCount() - 1) };
    for (const slot of ['A', 'D']) {
      coverTextures[slot]?.dispose();
      coverTextures[slot] = null;
      const canvas = covers[slot];
      if (!canvas) continue;
      coverTextures[slot] = new THREE.CanvasTexture(canvas);
      pages.setPageTexture(slot, coverTextures[slot]);
    }
  }

  function textureForPage(index) {
    const canvas = canvasFor(index);
    if (!canvas) return null;
    if (!pageTextures[index]) {
      pageTextures[index] = new THREE.CanvasTexture(canvas);
    }
    liveTextures.add(index);
    return pageTextures[index];
  }

  /**
   * Free the GPU uploads of pages well away from the open spread (see
   * KEEP_BEHIND). The texture objects stay: one still on a panel, or on a
   * leaf still in flight, is just uploaded again the next time it is drawn.
   */
  function releaseDistantTextures() {
    const first = leafStart - KEEP_BEHIND;
    const last = leafStart + KEEP_AHEAD;
    for (const index of liveTextures) {
      if (index >= first && index <= last) continue;
      pageTextures[index]?.dispose();
      liveTextures.delete(index);
    }
  }

  // Highest leafStart the book can be opened to -- the last spread. Also
  // the denominator for how far through the book we are.
  function maxLeafStart() {
    const count = pageCount();
    if (count < 2) return 0;
    return count - (count % 2 === 0 ? 2 : 1);
  }

  function clampLeafStart(start) {
    if (pageCount() === 0) return 0;
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

  function refreshReadingProgress() {
    const max = maxLeafStart();
    readingProgress = max > 0 ? leafStart / max : 0;
  }

  /**
   * A page has finished rendering onto its canvas: whatever texture was made
   * of it uploads again. One that came out a different size from its blank
   * is freed first -- an upload is allocated at the size it was made.
   */
  function pageRendered(index, resized) {
    const last = pageCount() - 1;
    const textures = [pageTextures[index]];
    if (index === 0) textures.push(coverTextures.A);
    if (index === last) textures.push(coverTextures.D);
    for (const texture of textures) {
      if (!texture) continue;
      if (resized) texture.dispose();
      texture.needsUpdate = true;
    }
  }

  /** Let go of the book's pages: stop their rendering, free their uploads. */
  function dropPages() {
    stopListening?.();
    stopListening = null;
    source?.cancel();
    source = null;
    // The last book's pages, off the GPU. Emptying the list alone drops the
    // textures but not their uploads, which would stay until the tab closed.
    for (const texture of pageTextures) texture?.dispose();
    pageTextures.length = 0;
    liveTextures.clear();
  }

  function showLeaf(start) {
    if (pageCount() === 0) return;
    leafStart = clampLeafStart(start);
    source.focus(leafStart);
    for (const panel of [LEFT_HAND_PANEL, RIGHT_HAND_PANEL]) {
      const tex = textureForPage(pageIndexForPanel(panel, leafStart));
      if (tex) getPages().setPageTexture(panel, tex);
    }
    refreshReadingProgress();
    releaseDistantTextures();
  }

  return {
    /**
     * Adopt a book's pages -- rendered or not yet, see PAGES ARRIVE WHILE YOU
     * READ -- and open it at the first spread. The last book's stop rendering.
     */
    setPages(pages) {
      if (pages !== source) dropPages();
      source = pages;
      stopListening = source?.onRendered(pageRendered) ?? null;
      leafStart = 0;
      showLeaf(0);
      paintCovers();
      // Snap, don't ease, on a fresh book: a rebuilt simulation starts
      // with its hinge centred, and easing from there would look like the
      // book settling from the middle every time one loads.
      getPages().setProgress(readingProgress);
    },

    showLeaf,

    // --- where the reader is, for the menu -------------------------------
    /** 1-based, the left-hand page of the open spread. */
    get page() { return leafStart + 1; },
    get pageCount() { return pageCount(); },
    /** How many of them are drawn so far -- they fill in after the book arrives. */
    get pagesRendered() { return source?.rendered ?? 0; },

    /**
     * Open the spread containing `page` (1-based). Spreads start on even
     * leaf indices, so an odd page and its facing page land on the same
     * spread -- asking for either shows both, which is what a reader means
     * by going to a page.
     */
    goToPage(page) {
      if (pageCount() === 0) return;
      const index = Math.max(0, Math.round(page) - 1);
      showLeaf(index - (index % 2));
    },

    /**
     * Re-apply the first/last page to covers A and D. Only needed after
     * the simulation has been rebuilt underneath us (new page dimensions
     * throw away the old meshes and their materials) -- the normal load
     * path goes through setPages, which already does this.
     */
    paintCovers,

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

    /**
     * Move to the next spread WITHOUT repainting the panels, handing back
     * the two textures the caller now owns responsibility for showing.
     *
     * This is what lets several keyboard turns stack. The book's page
     * state has to advance the moment a turn starts, or the next turn
     * would compute the same target and every leaf in the cascade would
     * carry the same pair of pages. But repainting both panels then --
     * which is what commitTurn does -- makes the page OPPOSITE the one you
     * grabbed jump to its new content while the leaf is still in mid-air,
     * before anything has covered it up.
     *
     * So the split: `underneath` goes onto the grabbed panel immediately
     * (it is what the leaf peeling away reveals), while `landing` is the
     * leaf's far face and belongs to the opposite panel only once the leaf
     * has actually landed on it -- see dragPageTurn's finishTurn.
     */
    advanceTurn(panel) {
      const target = turnTargetLeafStart(panel);
      const landing = textureForPage(pageIndexForPanel(oppositePanel(panel), target));
      const underneath = textureForPage(pageIndexForPanel(panel, target));
      leafStart = target;
      source?.focus(leafStart);
      refreshReadingProgress();
      releaseDistantTextures();
      return { landing, underneath, landingPanel: oppositePanel(panel) };
    },

    /** For a copy of the book being thrown away: its pages stop rendering, and go. */
    dispose() {
      dropPages();
      for (const slot of ['A', 'D']) {
        coverTextures[slot]?.dispose();
        coverTextures[slot] = null;
      }
    },
  };
}