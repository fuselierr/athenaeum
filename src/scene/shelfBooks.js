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
const MIN_THICKNESS = 0.028;
const MAX_THICKNESS = 0.10;
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

const TITLES = [
  ['The Salt Almanac', 'E. Vandermeer'],
  ['Northing', 'H. Calloway'],
  ['On Quiet Machines', 'R. Iyer'],
  ['The Lamplighters', 'M. Osgood'],
  ['Field Notes', 'T. Brennan'],
  ['A Theory of Tides', 'S. Okonkwo'],
  ['The Paper Wing', 'L. Marchetti'],
  ['Winterlight', 'A. Sorensen'],
  ['The Glass Orchard', 'J. Ferreira'],
  ['Endpapers', 'C. Whitlock'],
];

const BINDINGS = [
  0x4a2f24, 0x2f4536, 0x1f3348, 0x5c2b2b, 0x3c3a52,
  0x6b4a1f, 0x2b4a4a, 0x4d3a5a, 0x7a4b2a, 0x33403a,
];

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
 * @param {number} [count=10]
 * @param {THREE.Camera} [camera]    both needed for the hover pull-out;
 * @param {THREE.WebGLRenderer} [renderer]  omit either and it is skipped
 */
export async function populateShelf(bookshelf, { count = 10, camera, renderer } = {}) {
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

  for (let i = 0; i < count; i++) {
    const [title, author] = TITLES[i % TITLES.length];
    const thickness = MIN_THICKNESS + jitter(i, 1) * (MAX_THICKNESS - MIN_THICKNESS);
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
      title,
      author,
      bindingColor: BINDINGS[i % BINDINGS.length],
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
  }

  /**
   * Which book the cursor is over, or null.
   *
   * Tested against the book groups rather than the whole scene, so the
   * shelf carcass does not occlude anything -- but each group is a handful
   * of meshes, hence the walk back up to the group a hit belongs to.
   */
  function hovered() {
    if (!interactive || !pointerInside) return null;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(anchor.children, true);
    if (hits.length === 0) return null;
    let node = hits[0].object;
    while (node && node.parent !== anchor) node = node.parent;
    return node;
  }

  return {
    anchor,
    models,

    /**
     * Ease each book toward its target offset. Call once a frame.
     *
     * The whole row is stepped every frame, not just the one under the
     * cursor: a book that has just been left has to travel back, and it is
     * the only thing that still knows it was ever out.
     */
    update(dt) {
      const under = hovered();
      for (const book of hovering) {
        book.target = book.group === under ? book.travel : 0;
        if (Math.abs(book.target - book.offset) < 1e-5) {
          book.offset = book.target;
          continue;
        }
        const rate = book.target > book.offset ? PULL_RATE : RETURN_RATE;
        book.offset += (book.target - book.offset) * Math.min(rate * dt, 1);
        book.group.position.copy(book.rest)
          .addScaledVector(_slide.copy(book.out), book.offset);
      }
    },

    dispose() {
      if (onPointerMove) window.removeEventListener('pointermove', onPointerMove);
      if (onPointerLeave) renderer.domElement.removeEventListener('pointerleave', onPointerLeave);
      for (const model of models) model.dispose();
      bookshelf.remove(anchor);
    },
  };
}
