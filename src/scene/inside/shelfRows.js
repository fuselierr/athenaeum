import * as THREE from 'three';
import { dressModel, thicknessForPages, SHELF_LAYOUT } from './shelfBooks.js';

/**
 * Books filed on the wall's shelves.
 *
 * The standing bookshelf holds the library you arrive with (shelfBooks.js); the
 * runs built into the walls (wallShelf.js) start empty, and this is what puts
 * books on them. Click a row while holding a book and the book goes THERE --
 * on that shelf, in that bay, standing with whatever is already filed on it.
 *
 * WHAT A FILED BOOK IS. A model, not a copy: the same jacketed model the
 * standing shelf's books are (bookModel.js), sized by the row it stands on and
 * the book's own page count. The physically simulated copy you were holding is
 * let go of by the caller -- a shelf of thirty books should not be thirty
 * physics worlds, and a book standing in a row has nothing left to simulate.
 *
 * HOW THEY STAND. Sorted and justified exactly as the standing shelf is, from
 * the same settings (state/settings.js's shelf, the Scene tab): the row is laid
 * out again whenever a book joins it or those settings change.
 *
 * AND THEY COME OUT UNDER THE CURSOR, the way the standing shelf's do -- same
 * reach, same rates (SHELF_LAYOUT), because a book on a wall is the same object
 * as a book on the shelf and should answer the cursor the same way. Each book's
 * shelved pose is its `rest`; the draw is an offset out of the shelf from
 * there, which is why arrange() writes rest and update() writes the position.
 */

// How near a row a click has to land to count as that row, in metres. Generous
// downward, because a shelf is clicked by aiming at the books on it or at the
// board they stand on.
const REACH_BELOW = 0.03;
const REACH_ABOVE = 0.06;
const REACH_ACROSS = 0.05;

/** The books in the order asked for: as they were filed, by title, or by author. */
function inOrder(books, sort) {
  const text = (value) => (value ?? '').toString().trim().toLowerCase();
  const byTitle = (a, b) => text(a.record?.title).localeCompare(text(b.record?.title));
  const sorted = [...books];
  if (sort === 'title') sorted.sort(byTitle);
  else if (sort === 'author') {
    sorted.sort((a, b) => text(a.record?.author).localeCompare(text(b.record?.author)) || byTitle(a, b));
  } else sorted.sort((a, b) => a.filed - b.filed);
  return sorted;
}

/**
 * @param {object} opts
 * @param {THREE.Scene} opts.scene
 * @param {THREE.PerspectiveCamera} opts.camera
 * @param {THREE.WebGLRenderer} opts.renderer
 * @param {Array<object>} opts.runs  what addWallShelf returned, each with its
 *   sections and their shelves
 */
export function createShelfRows({ scene, camera, renderer, runs = [] }) {
  const group = new THREE.Group();
  group.name = 'shelvedBooks';
  scene.add(group);

  // Every row of every run, flattened: the places a book can go.
  const rows = [];
  for (const run of runs) {
    if (!run?.sections) continue;
    for (const section of run.sections) {
      for (const shelf of section.shelves ?? []) {
        rows.push({ shelf, section, mesh: run.object, books: [] });
      }
    }
  }

  // A book stands with its length up, its thickness across the shelf and its
  // width into it -- which puts its spine (the book's own -Z, see bookModel.js)
  // out into the room. Built as a basis rather than Euler angles, and with the
  // thickness axis NEGATED rather than two axes swapped: swapping two would be
  // a reflection, and setFromRotationMatrix quietly returns nonsense for one.
  const upright = new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().makeBasis(
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(-1, 0, 0),
      new THREE.Vector3(0, 0, 1),
    ),
  );

  const _ray = new THREE.Raycaster();
  const _ndc = new THREE.Vector2();
  const _pose = new THREE.Vector3();
  const _slide = new THREE.Vector3();
  let filings = 0; // so books keep the order they were filed in

  // Out of the shelf is out of the wall it is built against: these runs stand
  // on the +Z wall, so the room -- and the reader -- is at -Z.
  const OUT = new THREE.Vector3(0, 0, -1);

  // Where the cursor is, and whether it is over the 3D view at all. On window
  // rather than the canvas: a pointer that leaves over one of the overlaid
  // panels never fires the canvas's own leave event, and the book it was over
  // would stay drawn out.
  const pointer = new THREE.Vector2();
  let pointerInside = false;
  const onPointerMove = (event) => {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    pointerInside = true;
  };
  const onPointerLeave = () => { pointerInside = false; };
  window.addEventListener('pointermove', onPointerMove);
  renderer.domElement.addEventListener('pointerleave', onPointerLeave);

  /**
   * The row under the pointer, or null. The shelving is one merged mesh, so the
   * row is worked out from WHERE on it the click landed rather than from what
   * it hit: which bay the point is across, and which shelf it is standing on.
   */
  function rowUnder(clientX, clientY) {
    const meshes = [...new Set(rows.map((row) => row.mesh))].filter((mesh) => mesh?.visible);
    if (!meshes.length) return null;
    const rect = renderer.domElement.getBoundingClientRect();
    _ndc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    _ray.setFromCamera(_ndc, camera);
    const hit = _ray.intersectObjects(meshes, true)[0];
    if (!hit) return null;

    let best = null;
    let nearest = Infinity;
    for (const row of rows) {
      if (row.mesh !== hit.object) continue;
      const { shelf } = row;
      if (hit.point.x < shelf.minX - REACH_ACROSS || hit.point.x > shelf.maxX + REACH_ACROSS) continue;
      const above = hit.point.y - shelf.y;
      if (above < -REACH_BELOW || above > shelf.height + REACH_ABOVE) continue;
      // Ties -- a click on the board itself, which two rows share -- go to
      // whichever row the point sits furthest inside.
      const middle = Math.abs(above - shelf.height / 2);
      if (middle < nearest) {
        nearest = middle;
        best = row;
      }
    }
    return best;
  }

  /**
   * The filed book under the cursor, or null. Tested against the books
   * themselves rather than the whole scene, so the shelving they stand in does
   * not occlude them -- but each model is a handful of meshes, hence the walk
   * back up to the group a hit belongs to.
   */
  function bookUnder() {
    _ray.setFromCamera(pointer, camera);
    const hits = _ray.intersectObjects(group.children, true);
    for (const hit of hits) {
      let node = hit.object;
      while (node && node.parent !== group) node = node.parent;
      if (!node?.visible) continue;
      for (const row of rows) {
        const found = row.books.find((book) => book.model.group === node);
        if (found) return found;
      }
    }
    return null;
  }

  /** How big a book of `pages` pages stands on this row. */
  function sizeFor(row, pages) {
    const length = row.shelf.height * SHELF_LAYOUT.heightFill;
    return {
      length,
      width: length * SHELF_LAYOUT.widthRatio,
      thickness: thicknessForPages(pages),
    };
  }

  /** Whether another book of this size would still fit on the row. */
  function roomOn(row, thickness) {
    const taken = row.books.reduce((sum, book) => sum + book.size.thickness, 0)
      + SHELF_LAYOUT.gap * row.books.length;
    return taken + thickness <= (row.shelf.maxX - row.shelf.minX);
  }

  return {
    rowUnder,

    /** How a book stands on these shelves, for posing the real book at a slot. */
    upright,

    /** The filed book under the pointer, without touching it. */
    filedUnder(clientX, clientY) {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.set(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1,
      );
      return bookUnder();
    },

    /**
     * Take a filed book off the shelf: its model goes, and what comes back is
     * where it stood, so the real book can be posed there and flown into the
     * hand. The row is laid out again by the caller once it knows what it is
     * doing -- taking a book leaves a gap until then, as it should.
     */
    remove(entry) {
      for (const row of rows) {
        const at = row.books.indexOf(entry);
        if (at < 0) continue;
        row.books.splice(at, 1);
        group.remove(entry.model.group);
        entry.model.dispose();
        return {
          row,
          record: entry.record,
          size: entry.size,
          position: entry.rest.clone(),
          quaternion: upright.clone(),
        };
      }
      return null;
    },

    /** Stand a book that was filed out of sight -- see file(). */
    reveal(entry) {
      entry.model.group.visible = true;
    },

    /** Every book filed on the wall's shelves. */
    get books() {
      return rows.flatMap((row) => row.books.map((book) => book.record));
    },

    /**
     * File a book on a row. Returns false when the row is full -- a shelf holds
     * what it holds, and a book that will not fit is not quietly stacked.
     *
     * @param {object} row  from rowUnder
     * @param {object} record  the library record: title, author, coverUrl, pages
     * @param {object|null} [design]  a shared cover (community/covers.js)
     */
    async file(row, record, design = null, { hidden = false } = {}) {
      const size = sizeFor(row, record?.pages);
      if (!roomOn(row, size.thickness)) return null;
      const model = await dressModel(record ?? {}, row.books.length, size, design);
      model.group.quaternion.copy(upright);
      // Filed out of sight, for a book that is still flying to the shelf: the
      // model is where it will stand, and shows when the book lands on it
      // (reveal). Otherwise there would be two of the book in the air at once.
      model.group.visible = !hidden;
      group.add(model.group);
      filings += 1;
      const entry = {
        record,
        model,
        size,
        filed: filings,
        rest: new THREE.Vector3(), // where it stands; arrange() sets it
        travel: size.width * SHELF_LAYOUT.pullFraction, // how far it draws out
        offset: 0, // how far out it is now
        target: 0, // and how far out it is going
      };
      row.books.push(entry);
      return entry;
    },

    /**
     * Stand every row up again: in `sort` order, pushed to one end of its bay,
     * centred, or pushed to the other (`justify`) -- the same settings the
     * standing shelf keeps itself by.
     */
    arrange({ sort = 'shelf', justify = 'left' } = {}) {
      for (const row of rows) {
        const order = inOrder(row.books, sort);
        const run = order.reduce((sum, book) => sum + book.size.thickness, 0)
          + SHELF_LAYOUT.gap * Math.max(0, order.length - 1);
        const slack = Math.max(0, (row.shelf.maxX - row.shelf.minX) - run);
        let lead = 0;
        if (justify === 'middle') lead = slack / 2;
        else if (justify === 'right') lead = slack;

        let at = row.shelf.minX + lead;
        for (const book of order) {
          // A book on its way to this shelf keeps its place in the row without
          // being drawn out under the cursor on the way.
          if (!book.model.group.visible) book.offset = 0;
          book.rest.set(
            at + book.size.thickness / 2,
            row.shelf.y + book.size.length / 2,
            row.shelf.z,
          );
          // Posed from rest by update(); set here as well so a book that has
          // just been filed is standing in place on the very next frame.
          book.model.group.position.copy(book.rest).addScaledVector(OUT, book.offset);
          at += book.size.thickness + SHELF_LAYOUT.gap;
        }
      }
    },

    /**
     * Draw the book under the cursor out of its shelf, and ease the rest back.
     * Call once a frame: the whole wall is stepped, not just the one under the
     * cursor, because a book that has just been left is the only thing that
     * still knows it was ever out.
     */
    update(dt) {
      const under = pointerInside ? bookUnder() : null;
      for (const row of rows) {
        for (const book of row.books) {
          book.target = book === under ? book.travel : 0;
          if (Math.abs(book.target - book.offset) < 1e-5) {
            book.offset = book.target;
          } else {
            const rate = book.target > book.offset
              ? SHELF_LAYOUT.pullRate
              : SHELF_LAYOUT.returnRate;
            book.offset += (book.target - book.offset) * Math.min(rate * dt, 1);
          }
          _pose.copy(book.rest).addScaledVector(_slide.copy(OUT), book.offset);
          book.model.group.position.copy(_pose);
        }
      }
    },

    dispose() {
      window.removeEventListener('pointermove', onPointerMove);
      renderer.domElement.removeEventListener('pointerleave', onPointerLeave);
      for (const row of rows) {
        for (const book of row.books) book.model.dispose();
        row.books.length = 0;
      }
      scene.remove(group);
    },
  };
}
