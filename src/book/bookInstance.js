import * as THREE from 'three';
import { PageSimulation } from './pageSim/PageSimulation.js';
import { createBookPlacement } from './placement/bookPlacement.js';
import { createBookContent } from './reader/bookContent.js';
import { createBookConfig, use, useAsync } from './pageSim/bookContext.js';
import { setPageDimensions, setSpineGap, spineGapForPageCount } from './pageSim/config.js';
import { updateLocalCorners } from './pageSim/math.js';
import { BOOK_WORLD_SCALE } from '../scene/worldScale.js';

/**
 * ONE COPY OF A BOOK: everything that belongs to a single physical book, so the
 * room can hold several of them at once.
 *
 * WHAT IS ITS OWN. Its group in the scene, its page mechanism (which owns a
 * physics world of its own), its page textures, the body that makes it fall and
 * land on the desk, and -- through pageSim/bookContext.js -- its OWN SIZE: the
 * page dimensions and the thickness its page count earns it. Two books of
 * different lengths can lie on the same desk.
 *
 * WHAT IS NOT. Everything the reader does with their hands -- the drags, the
 * carry, the opening -- belongs to whichever book is in your hands rather than
 * to any one book, and lives in main.js pointed at the book in focus. You hold
 * one book at a time; the rest lie where they were left, still falling, still
 * settling, still turning their own pages if something asks them to.
 *
 * THE NUMBERS IN FORCE. The page mechanism reads its dimensions from module
 * bindings, so every piece of work done to a book has to happen with that book
 * installed (bookContext.js says why at length). Everything here does that for
 * you; the book in focus is also left installed between frames by main.js, so
 * the handlers that fire between frames land on the right book.
 */

// Where a book that has not been placed anywhere goes: on the desk top, a
// couple of centimetres up, so it settles rather than starting flush.
const RESTING = new THREE.Vector3(0, 0.02, 0);

/**
 * @param {object} opts
 * @param {THREE.Scene} opts.scene
 * @param {object} opts.desk  what loadDesk returned -- the surface it lands on
 * @param {THREE.Box3|null} [opts.room]  the walls it stays inside
 * @param {Array<object>} [opts.obstacles]  the rest of the furniture, as boxes
 * @param {() => object|null} [opts.getGround]  where the ground is, in the
 *   places that have one instead of a room -- outside (bookPlacement.js)
 * @param {THREE.Vector3|null} [opts.at]  where to stand it; the desk by default
 * @param {string|null} [opts.name]
 * @returns {Promise<object>} the instance
 */
export async function createBookInstance({
  scene, desk, room = null, obstacles = [], at = null, name = 'book',
  getGround = () => null,
}) {
  const config = createBookConfig();

  const group = new THREE.Group();
  group.name = name;
  // The page mechanism is authored at its own working scale; this is what
  // brings it down to the metric world the furniture lives in (worldScale.js).
  group.scale.setScalar(BOOK_WORLD_SCALE);
  group.position.copy(at ?? RESTING);
  scene.add(group);

  const book = {
    group,
    config,
    /** The page mechanism. Replaced whole when the book is resized. */
    pages: null,
    /** Its page textures (reader/bookContent.js). */
    content: null,
    /** The body that falls and lands (placement/bookPlacement.js). */
    placement: null,
    /** Which library book this copy is, once it is holding one. */
    libraryId: null,
  };

  const getPages = () => book.pages;

  await useAsync(config, async () => {
    book.pages = await PageSimulation.create(group);
    book.placement = await createBookPlacement({
      bookGroup: group, getPages, desk, room, obstacles, getGround,
    });
    book.content = createBookContent(getPages);
  });

  /**
   * Resize this copy to a loaded book's page shape and length, and build it
   * again: the dimensions are baked into bodies and geometry when the spreads
   * are constructed, so a new size means a new mechanism.
   *
   * @param {number} hingeLen  the spine's length -- a page's height
   * @param {number} panelReach  spine to fore-edge -- a page's width
   * @param {number} pageCount  what its thickness is worked out from
   */
  async function resize(hingeLen, panelReach, pageCount) {
    await useAsync(config, async () => {
      setPageDimensions(hingeLen, panelReach);
      // Before the rebuild: the thickness is baked into the cover anchors when
      // the spreads are built.
      setSpineGap(spineGapForPageCount(pageCount));
      updateLocalCorners();
      book.pages.dispose();
      book.pages = await PageSimulation.create(group);
    });
    return book.pages;
  }

  /**
   * A step for a book nobody is holding: its pages settle, its body falls and
   * lands, its page textures keep up. The book in focus is stepped by main.js
   * instead, which interleaves the reader's own drags and openings between
   * these same calls -- so there is one order of operations, not two.
   */
  function stepParked(dt) {
    use(config, () => {
      book.content.update(dt);
      book.pages.step();
      book.placement.step(dt, false);
    });
  }

  /** Do something to this book with its own numbers in force. */
  function within(work) {
    return use(config, work);
  }

  function dispose() {
    use(config, () => {
      book.content?.dispose?.();
      book.placement?.dispose?.();
      book.pages?.dispose?.();
    });
    scene.remove(group);
  }

  book.resize = resize;
  book.stepParked = stepParked;
  book.within = within;
  book.dispose = dispose;
  return book;
}
