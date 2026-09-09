import * as THREE from 'three';
import { createBookModel } from '../book/cover/bookModel.js';

/**
 * Fills a slot in the bookshelf with static book models.
 *
 * HOW THE SLOT IS ADDRESSED. bookshelf.glb is a single fused mesh with no
 * named shelves, so there is nothing to look a compartment up by. Instead
 * the slot is given as FRACTIONS of the model's own bounding box, which
 * survive the shelf being re-scaled or a different .glb being dropped in.
 *
 * The fractions were read off the geometry, and getting them right needs
 * one thing said out loud: the .glb is authored Z-UP. Its Z is the shelf's
 * height and its Y is the shelf's width, and the loader turns that upright
 * on the way in -- so what arrives as local Y (height) is the file's Z.
 * Clustering the file's own Y and calling it height puts every fraction on
 * the wrong axis and buries the books inside the base, which is exactly
 * what happened the first time.
 *
 * Read correctly, boards sit at 8%, 23%, 38%, 53%, 68%, 85% and 100% of
 * the height. The unit is three columns -- narrow open shelving either
 * side of a wide centre -- with CABINET DOORS across the bottom of all
 * three. That last part is invisible to any amount of vertex analysis: a
 * door and a back panel cluster identically, and the cabinet cavity behind
 * them is hollow, so a search for dividers in there finds nothing and
 * reads as open space. The first attempt put the books at 10% of the
 * height, which is inside that cabinet, behind a closed door.
 *
 * The slot below is the lowest OPEN bay of the centre column, sitting
 * directly on top of the doors.
 *
 * All the fractions are in ONE block at the top -- if the books land in
 * the wrong compartment, they are the only things to move.
 *
 * TAKING ONE. Clicking a book lifts it out of the row and into the hand:
 * it holds a fixed pose in CAMERA space, so it rides along wherever the
 * player looks or walks (see input/cameraModes.js). Escape, or clicking a
 * different book, sends it back to the exact gap it came out of. There is
 * no separate held state to keep in sync -- every book carries a 0..1
 * `hold`, and its pose is the shelf pose and the hand pose blended by it,
 * so taking, swapping and putting back are all the same animation run in
 * one direction or the other.
 *
 * WHY THE BOOKS ARE PARENTED TO THE SHELF. They go inside an anchor that
 * cancels the shelf group's own scale, so their sizes stay in metres while
 * their placement still rides the shelf's rotation and position. That way
 * nothing here has to know which way the shelf was turned.
 */

// --- the slot, as fractions of the bookshelf's own bounding box ----------
// Boards, measured off the geometry, as fractions of the unit's height:
//
//   0.080  0.226   <- the cabinet. Its doors reach to about 0.355, so BOTH
//                     of these are behind them; 0.226 looks like a shelf
//                     and is not one you can see into.
//   0.381  0.526  0.684  0.845  0.998   <- the open bays
//
// The lowest OPEN bay is therefore 0.381 to 0.526. SLOT_FLOOR is only a
// STARTING HINT -- the real surface is found by raycast below, so this
// only has to name the right bay, not the exact board face.
const SLOT_FLOOR = 0.395;
const SLOT_CEILING = 0.526;
const SLOT_START = 0.28; // across the width: inside the centre column's left upright
const SLOT_END = 0.70; // and its right one
const SLOT_DEPTH = 0.62; // front-to-back centre; > 0.5 sits them forward

// Which of the shelf's own local axes runs across its width. Confirmed
// against the loaded model: local X measures 0.92 m and local Z 3.74 m, so
// Z is the width and X the depth. Flip if a replacement .glb is authored
// the other way round.
const WIDTH_AXIS = 'z';

// Which way along the depth axis the spines face. Flip if they end up
// looking into the back panel.
const SPINE_FACING = -1;

// Which end of the shelf counts as the left, i.e. the end the row starts
// from. Flip if they fill from the wrong side.
const FILL_FROM_LOW_END = false;

// --- what the books look like --------------------------------------------
// Thickness now comes from each book's own page count, on the same
// square-root curve config.js uses for the readable book's spine:
// thickness really is linear in sheet count, but across the range books
// actually span a linear map spends its whole output on the extremes.
// REFERENCE_PAGES is the length that lands mid-range; MIN/MAX are the
// clamp either side of it.
const REFERENCE_PAGES = 300;
const REFERENCE_THICKNESS = 0.055;
const MIN_THICKNESS = 0.028;
const MAX_THICKNESS = 0.10;
const FALLBACK_PAGES = 300; // only for a book whose count could not be read
const HEIGHT_FILL = 0.90; // of the slot's clear height
const HEIGHT_VARIATION = 0.16; // how much shorter the shortest book is
const WIDTH_RATIO = 0.66; // fore-edge reach, as a fraction of the height
const GAP = 0.004; // metres of air between neighbours

// --- hover ----------------------------------------------------------------
// How far a hovered book slides out, as a fraction of its own fore-edge
// reach -- so a deep book comes out further than a slim one and they all
// look like they are being drawn by the same hand.
const PULL_FRACTION = 0.78;
// Exponential ease, 1/s. Out is quicker than back: a book answers the
// cursor promptly and settles more slowly, which reads as weight.
const PULL_RATE = 8;
const RETURN_RATE = 7;

// --- in hand ---------------------------------------------------------------
// Where a taken book sits, in CAMERA space -- forward is -Z, so this is a
// little right of centre, below the eye line and about 40 cm out: roughly
// where you would hold a book you were deciding whether to read.
const HOLD_OFFSET = new THREE.Vector3(0.1, -0.07, -0.42);
// A hand does not present a book square on. Small angles, but enough to
// let the lamp rake across the boards instead of flattening them.
const HOLD_TILT = new THREE.Euler(-0.12, 0.3, 0.06);
// Ease rates, 1/s. Coming to hand is brisk; going back is slower, which
// reads as being replaced rather than thrown.
const TAKE_RATE = 7;
const SHELVE_RATE = 5;

// The held pose, as a matrix in the camera's own space.
//
// Book local axes are X = length, Y = thickness (+Y is the front board),
// Z = spine to fore-edge. In the hand we want the front board facing the
// player (+Y -> camera +Z, which points back at the eye), the length
// upright (+X -> camera +Y) and therefore the fore-edge to the right and
// the spine to the left (+Z -> camera +X). As on the shelf, the basis is
// built proper and the tilt applied as a rotation, never by negating a
// column -- a reflection comes back out of setFromRotationMatrix as some
// unrelated orientation.
const HOLD_MATRIX = new THREE.Matrix4().compose(
  HOLD_OFFSET,
  new THREE.Quaternion()
    .setFromRotationMatrix(new THREE.Matrix4().makeBasis(
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(0, 0, 1),
      new THREE.Vector3(1, 0, 0),
    ))
    .premultiply(new THREE.Quaternion().setFromEuler(HOLD_TILT)),
  new THREE.Vector3(1, 1, 1),
);

/** Smoothstep, so the trip to the hand starts and ends still. */
function ease(t) {
  return t * t * (3 - 2 * t);
}


// Only reached by a book with no cover art to sample a colour from.
const BINDINGS = [
  0x4a2f24, 0x2f4536, 0x1f3348, 0x5c2b2b, 0x3c3a52,
  0x6b4a1f, 0x2b4a4a, 0x4d3a5a, 0x7a4b2a, 0x33403a,
];

/** Spine thickness for a book of `pages` pages. See REFERENCE_PAGES. */
function thicknessForPages(pages) {
  const count = Number.isFinite(pages) && pages > 0 ? pages : FALLBACK_PAGES;
  const scaled = REFERENCE_THICKNESS * Math.sqrt(count / REFERENCE_PAGES);
  return Math.max(MIN_THICKNESS, Math.min(MAX_THICKNESS, scaled));
}

/**
 * The converted books the server is holding.
 *
 * Returns an empty list rather than throwing when there is no server: the
 * shelf is scenery, and running the front end on its own should give an
 * empty shelf, not a broken scene.
 */
async function fetchLibrary() {
  try {
    const response = await fetch('/api/library');
    if (!response.ok) return [];
    const books = await response.json();
    return Array.isArray(books) ? books : [];
  } catch {
    return [];
  }
}

/**
 * Deterministic 0..1 from an integer. Books should look varied but must
 * not reshuffle every reload -- a shelf that rearranges itself when you
 * refresh reads as a bug, not as variety.
 */
function jitter(i, salt) {
  const x = Math.sin((i + 1) * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * @param {THREE.Object3D} bookshelf  the group loadBookshelf returned,
 *   already positioned and rotated
 * @param {number} [limit=Infinity]  cap on how many library books to show
 * @param {THREE.Camera} [camera]    both needed for the hover pull-out;
 * @param {THREE.WebGLRenderer} [renderer]  omit either and it is skipped
 */
export async function populateShelf(bookshelf, { limit = Infinity, camera, renderer } = {}) {
  const library = await fetchLibrary();
  const scale = bookshelf.scale.x || 1;
  bookshelf.updateMatrixWorld(true);

  // The shelf's bounds in ITS OWN frame. Box3.setFromObject only works in
  // world space, and the shelf is turned 90 degrees, so that would report
  // its width and depth swapped -- and every fraction below would address
  // the wrong axis. Each mesh's own bounding box is brought back through
  // the shelf's inverse world matrix instead.
  const toLocal = new THREE.Matrix4().copy(bookshelf.matrixWorld).invert();
  const meshToLocal = new THREE.Matrix4();
  const meshBox = new THREE.Box3();
  const localBox = new THREE.Box3();
  bookshelf.traverse((object) => {
    if (!object.isMesh) return;
    if (!object.geometry.boundingBox) object.geometry.computeBoundingBox();
    meshToLocal.multiplyMatrices(toLocal, object.matrixWorld);
    meshBox.copy(object.geometry.boundingBox).applyMatrix4(meshToLocal);
    localBox.union(meshBox);
  });
  // Into metres, which is what the anchor below works in.
  localBox.min.multiplyScalar(scale);
  localBox.max.multiplyScalar(scale);

  const size = localBox.getSize(new THREE.Vector3());
  const alongWidth = WIDTH_AXIS === 'z';
  const acrossSize = alongWidth ? size.z : size.x;
  const acrossMin = alongWidth ? localBox.min.z : localBox.min.x;
  const depthSize = alongWidth ? size.x : size.z;
  const depthMin = alongWidth ? localBox.min.x : localBox.min.z;

  const ceilingY = localBox.min.y + SLOT_CEILING * size.y;
  const startAcross = acrossMin + SLOT_START * acrossSize;
  const endAcross = acrossMin + SLOT_END * acrossSize;
  const depthOffset = depthMin + SLOT_DEPTH * depthSize;

  // An anchor that undoes the shelf's scale: inside it one unit is one
  // metre, so book sizes stay in real units, but placement still rides the
  // shelf's rotation and position and nothing here needs to know which way
  // it was turned.
  const anchor = new THREE.Group();
  anchor.name = 'shelfBooks';
  anchor.scale.setScalar(1 / scale);
  bookshelf.add(anchor);
  anchor.updateMatrixWorld(true);

  // SEAT THE ROW ON THE ACTUAL BOARD. SLOT_FLOOR is only a hint: a board's
  // top surface never lands exactly on a round fraction, and being one
  // percent out on a unit this tall is a three-centimetre gap under every
  // book. So a ray is dropped down the middle of the bay and the row sits
  // on whatever it hits. Falls back to the fraction if the bay turns out
  // to be open underneath.
  const midAcross = (startAcross + endAcross) / 2;
  const probeOrigin = anchor.localToWorld(new THREE.Vector3(
    alongWidth ? depthOffset : midAcross,
    ceilingY - 0.01 * size.y, // just under the shelf above, not touching it
    alongWidth ? midAcross : depthOffset,
  ));
  const probe = new THREE.Raycaster(probeOrigin, new THREE.Vector3(0, -1, 0));
  const surface = probe.intersectObject(bookshelf, true)[0];

  let floorY = localBox.min.y + SLOT_FLOOR * size.y;
  if (surface) floorY = anchor.worldToLocal(surface.point.clone()).y;
  const clearHeight = Math.max(0, ceilingY - floorY);

  // Book local axes are X = length, Y = thickness, Z = width (see
  // bookModel.js). Shelved, those have to become: length up, thickness
  // across the shelf, width into it. Built as an explicit basis rather
  // than Euler angles -- three axes all changing at once is exactly where
  // an Euler order gets silently wrong.
  // Built at SPINE_FACING +1 and then turned, NOT by negating an axis.
  // Negating one basis vector makes the matrix a reflection rather than a
  // rotation -- determinant -1 -- and setFromRotationMatrix assumes a
  // proper rotation, so it silently returns a quaternion for some
  // unrelated orientation. Half a turn about the up axis reverses the
  // spine honestly; the thickness axis reverses with it, which costs
  // nothing because a book is symmetric that way.
  const upright = new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().makeBasis(
      new THREE.Vector3(0, 1, 0), // book X (length) -> up
      alongWidth // book Y (thickness) -> across the shelf
        ? new THREE.Vector3(0, 0, 1)
        : new THREE.Vector3(1, 0, 0),
      alongWidth // book Z (width) -> into the shelf
        ? new THREE.Vector3(1, 0, 0)
        : new THREE.Vector3(0, 0, 1),
    ),
  );
  if (SPINE_FACING < 0) {
    upright.premultiply(
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI),
    );
  }

  const models = [];
  const hovering = [];
  const step = FILL_FROM_LOW_END ? 1 : -1;
  let cursor = FILL_FROM_LOW_END ? startAcross : endAcross;

  for (let i = 0; i < Math.min(library.length, limit); i++) {
    const book = library[i];
    // Thickness is the book's real length; height and reach still get a
    // little jitter, because real books vary in trim size and a row of
    // identically tall spines reads as wallpaper.
    const thickness = thicknessForPages(book.pages);
    const length = clearHeight * HEIGHT_FILL * (1 - jitter(i, 2) * HEIGHT_VARIATION);
    const width = length * WIDTH_RATIO;

    // Out of shelf: stop rather than overflow past the upright.
    if (step > 0 ? cursor + thickness > endAcross : cursor - thickness < startAcross) break;

    // eslint-disable-next-line no-await-in-loop -- deliberately sequential:
    // each model may fetch a cover, and a shelf's worth at once is a burst
    // of parallel decodes for scenery nobody is waiting on.
    const model = await createBookModel({
      length,
      width,
      thickness,
      title: book.title,
      author: book.author,
      blurb: book.description,
      coverImage: book.coverUrl,
      // Left null when there IS cover art, so the binding is sampled from
      // it and the spine and back match the jacket rather than a palette.
      bindingColor: book.coverUrl ? null : BINDINGS[i % BINDINGS.length],
    });

    model.group.quaternion.copy(upright);
    // Out of the shelf is the book's own -Z, the side its spine is on (see
    // bookModel.js), carried through the same orientation it was just
    // given -- rather than re-deriving a sign from SPINE_FACING, which is
    // the kind of thing that quietly ends up backwards.
    const out = new THREE.Vector3(0, 0, -1).applyQuaternion(upright);
    // The model is centred on itself, so it is raised by half its length to
    // stand on the shelf, and advanced by half its thickness to sit against
    // whatever came before it.
    const alongAxis = cursor + step * (thickness / 2);
    model.group.position.set(
      alongWidth ? depthOffset : alongAxis,
      floorY + length / 2,
      alongWidth ? alongAxis : depthOffset,
    );
    anchor.add(model.group);
    models.push(model);
    hovering.push({
      group: model.group,
      rest: model.group.position.clone(),
      out,
      travel: width * PULL_FRACTION,
      offset: 0,
      target: 0,
      hold: 0, // 0 shelved, 1 in hand, in between mid-flight
    });

    cursor += step * (thickness + GAP);
  }

  // --- hover pull-out ----------------------------------------------------
  const pointer = new THREE.Vector2();
  const raycaster = new THREE.Raycaster();
  const _slide = new THREE.Vector3();
  let pointerInside = false;
  let onPointerMove = null;
  let onPointerLeave = null;
  let onKeyDown = null;

  const interactive = Boolean(camera && renderer);
  if (interactive) {
    const dom = renderer.domElement;
    onPointerMove = (event) => {
      const rect = dom.getBoundingClientRect();
      pointer.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      pointerInside = true;
    };
    onPointerLeave = () => { pointerInside = false; };
    // On window, not the canvas: a pointer that leaves over one of the
    // overlaid UI panels never fires the canvas's own leave event, and the
    // book it was over would stay stuck out.
    window.addEventListener('pointermove', onPointerMove);
    dom.addEventListener('pointerleave', onPointerLeave);
    // Escape is handled here rather than by the caller so that the shelf
    // owns every way a book leaves the hand.
    onKeyDown = (event) => { if (event.key === 'Escape') held = null; };
    window.addEventListener('keydown', onKeyDown);
  }

  /**
   * The book under a normalised device coordinate, or null.
   *
   * Tested against the book groups rather than the whole scene, so the
   * shelf carcass does not occlude anything -- but each group is a handful
   * of meshes, hence the walk back up to the group a hit belongs to.
   */
  function bookUnder(ndc) {
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(anchor.children, true);
    if (hits.length === 0) return null;
    let node = hits[0].object;
    while (node && node.parent !== anchor) node = node.parent;
    return hovering.find((entry) => entry.group === node) ?? null;
  }

  function hovered() {
    if (!interactive || !pointerInside) return null;
    return bookUnder(pointer);
  }

  // --- in hand -------------------------------------------------------------
  let held = null; // the entry the player is holding, or null

  const _pickPointer = new THREE.Vector2();
  const _handMatrix = new THREE.Matrix4();
  const _anchorInverse = new THREE.Matrix4();
  const _handPosition = new THREE.Vector3();
  const _handQuaternion = new THREE.Quaternion();
  const _handScale = new THREE.Vector3();
  const _shelfPosition = new THREE.Vector3();

  /**
   * The hand pose, expressed in the anchor's space -- which is where the
   * books' own transforms already live, so holding one needs no reparenting
   * and the row keeps its single owner. Read fresh every frame: the camera
   * has usually not had its world matrix rebuilt yet at this point (the
   * renderer does that), and a frame of lag on something held at arm's
   * length shows up as shimmer.
   */
  function readHandPose() {
    camera.updateMatrixWorld();
    _anchorInverse.copy(anchor.matrixWorld).invert();
    _handMatrix.multiplyMatrices(camera.matrixWorld, HOLD_MATRIX).premultiply(_anchorInverse);
    _handMatrix.decompose(_handPosition, _handQuaternion, _handScale);
  }

  return {
    anchor,
    models,

    /** The group of the book in hand, or null. */
    get held() { return held?.group ?? null; },

    /**
     * Route a click here. Returns whether it landed on a book, so a caller
     * can tell an interaction from a click on empty room.
     *
     * Clicking the held book puts it back, which makes the gesture a
     * toggle; clicking a different one swaps, since the outgoing book only
     * has to stop being held for it to fly home on its own.
     */
    handleClick(event) {
      if (!interactive) return false;
      const rect = renderer.domElement.getBoundingClientRect();
      _pickPointer.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      const picked = bookUnder(_pickPointer);
      if (!picked) return false; // a click on the room leaves the hand alone
      held = picked === held ? null : picked;
      return true;
    },

    /** Put the held book back, if there is one. What Escape does. */
    release() { held = null; },

    /**
     * Ease each book toward its target pose. Call once a frame.
     *
     * The whole row is stepped every frame, not just the one under the
     * cursor: a book that has just been left has to travel back, and it is
     * the only thing that still knows it was ever out.
     */
    update(dt) {
      const under = hovered();
      let handRead = false;

      for (const book of hovering) {
        const inHand = book === held;

        // Hover slide. Suppressed for whatever is in hand: it is not in the
        // row to be drawn out of.
        book.target = !inHand && book === under ? book.travel : 0;
        if (Math.abs(book.target - book.offset) < 1e-5) {
          book.offset = book.target;
        } else {
          const rate = book.target > book.offset ? PULL_RATE : RETURN_RATE;
          book.offset += (book.target - book.offset) * Math.min(rate * dt, 1);
        }

        const holdTarget = inHand ? 1 : 0;
        if (Math.abs(holdTarget - book.hold) < 1e-4) {
          book.hold = holdTarget;
        } else {
          const rate = holdTarget > book.hold ? TAKE_RATE : SHELVE_RATE;
          book.hold += (holdTarget - book.hold) * Math.min(rate * dt, 1);
        }

        _shelfPosition.copy(book.rest).addScaledVector(_slide.copy(book.out), book.offset);
        if (book.hold <= 0) {
          book.group.position.copy(_shelfPosition);
          book.group.quaternion.copy(upright);
          continue;
        }

        // One book can be arriving while another is still on its way back,
        // but they share a hand, so the pose is read at most once a frame.
        if (!handRead) {
          readHandPose();
          handRead = true;
        }
        const t = ease(book.hold);
        book.group.position.lerpVectors(_shelfPosition, _handPosition, t);
        book.group.quaternion.copy(upright).slerp(_handQuaternion, t);
      }
    },

    dispose() {
      if (onPointerMove) window.removeEventListener('pointermove', onPointerMove);
      if (onPointerLeave) renderer.domElement.removeEventListener('pointerleave', onPointerLeave);
      if (onKeyDown) window.removeEventListener('keydown', onKeyDown);
      for (const model of models) model.dispose();
      bookshelf.remove(anchor);
    },
  };
}