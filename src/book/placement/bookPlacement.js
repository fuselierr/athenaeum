import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { GRAVITY_MAG, spineWeight } from '../pageSim/config.js';

/**
 * The book's PLACEMENT physics: where the book as a whole sits, and what
 * happens when you let go of it.
 *
 * WHY THIS IS A SECOND RAPIER WORLD. PageSimulation's world runs in the
 * book's own local frame, with gravity rotated into it every frame
 * (setGravityDirection) so the leaves sag toward true down however the
 * book is turned. That trick is exactly what makes it unable to host the
 * book itself: a body in that world has no idea which way is really down,
 * because "down" there is a moving target. So placement gets its own
 * world, in WORLD space, with plain constant gravity -- and the two are
 * coupled in one direction only:
 *
 *     placement world  ->  bookGroup transform  ->  pages' gravity vector
 *
 * The page mechanism is untouched by any of this. It still hinges off a
 * fixed spine at its own origin; that origin is just no longer nailed to
 * the desk.
 *
 * THE COLLISION SHAPE IS THE COVERS. Nothing else in the book is rigid --
 * the leaves are a constraint mechanism, not colliders -- and on a real
 * book the boards are what meets the table anyway. The two board colliders
 * are re-posed from H1/H2 every frame (syncBoards), so a book dropped
 * while open lands on whichever board is underneath and rocks onto the
 * other, and a closed book lands flat.
 */

// Linear/angular damping on the book body. Higher than a free-falling
// object would have: a book is not bouncy, and this is what stops it
// sliding for ages after it lands.
const LINEAR_DAMPING = 0.4;
const ANGULAR_DAMPING = 0.6;

// Boards are card, not rubber.
const RESTITUTION = 0.05;
const FRICTION = 0.9;

// How deep the room's floor, wall and ceiling slabs are. Far deeper than any
// real wall needs to be, on purpose: the book is two thin boards, and a slab
// only a few centimetres deep is exactly what a fast one can skip clean
// through between two steps, CCD or not.
const ROOM_SLAB_THICKNESS = 0.5;

// --- where the paper is ------------------------------------------------
//
// The boards are the only colliders the book has, so they are also the
// only thing Rapier can work its mass out of -- and two identical boards
// make a symmetric object, which a book that is open is not. Almost all of
// a book's weight is the text block, and while it is open almost all of
// THAT is on one side: twenty leaves under your left thumb and the other
// three hundred stacked on the right.
//
// So each half of the block gets a collider of its own that carries
// weight and nothing else: a page-sized slab that touches nothing, posed
// every frame wherever that half of the pages actually lies, with a
// density set by how many pages are in it. Rapier then derives the mass,
// the centre of mass AND the rotational inertia from those slabs and the
// boards together, all three staying true as anything moves -- which is
// exactly what a second, hand-maintained mass frame would get wrong the
// moment the book was flipped.
//
// NOT ON THE BOARDS. It used to be: each board's own density, split by
// reading position. But a board and the half of the block on its side
// are not the same thing, and they part company exactly when it matters.
// Open a shut book's cover and the leaves stay lying on the other board
// until they are lifted over (see PageSimulation.openState); lift a cover
// mid-read and its pages do not come with it. Weight welded to the board
// swung away with it, leaving the book balanced about paper that was no
// longer there. So a board weighs a board, and the paper weighs where the
// paper is.
//
// The numbers are relative, not physical. Nothing here reads an absolute
// mass -- gravity does not care and the damping is per-velocity -- so what
// matters is only how much heavier the block is than a board, and where
// each half of it is.
const BOARD_DENSITY = 1;

// The text block, in board-densities, for the thinnest and thickest book
// the spine will stretch to. A pamphlet is mostly its covers; an 800-page
// novel is mostly paper.
const PAGE_BLOCK_LIGHTEST = 1.6;
const PAGE_BLOCK_HEAVIEST = 7.5;

// Reading moves the paper across by a leaf at a time. Re-deriving the mass
// properties for a change smaller than this is work nothing could feel.
const SHARE_EPSILON = 0.004;

// A grabbed book is moved by hand, so its velocity has to be measured
// rather than simulated -- this is what lets you throw it. Capped so a
// single stuttered frame cannot fling it across the room.
// Metres/second, so this one scales with the world; the spin cap is in
// radians and does not.
const MAX_RELEASE_SPEED = 2.5;
const MAX_RELEASE_SPIN = 12; // rad/s

// `room` is the room's inside as a world-space THREE.Box3 -- floor to ceiling,
// wall to wall. Optional: without it the desk is the only thing to land on.
export async function createBookPlacement({ bookGroup, getPages, desk, room = null }) {
  await RAPIER.init();

  const world = new RAPIER.World({ x: 0, y: -GRAVITY_MAG, z: 0 });

  // --- the desk ---------------------------------------------------------
  const deskBody = world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed().setTranslation(
      desk.collision.center.x, desk.collision.center.y, desk.collision.center.z,
    ),
  );
  world.createCollider(
    RAPIER.ColliderDesc
      .cuboid(desk.collision.halfExtents.x, desk.collision.halfExtents.y, desk.collision.halfExtents.z)
      .setFriction(FRICTION)
      .setRestitution(RESTITUTION),
    deskBody,
  );

  // --- the room -----------------------------------------------------------
  // Floor, four walls and a ceiling, so a book knocked off the desk lands on
  // the floor and a thrown one stops at a wall, instead of falling out of
  // the world. Each is a slab sitting just OUTSIDE the room, so its inner
  // face is exactly the room's; the slabs run past each other at the
  // corners, leaving no seam for a board to slip through. The window is
  // solid here too -- it is glass.
  if (room) {
    const t = ROOM_SLAB_THICKNESS;
    const size = room.getSize(new THREE.Vector3());
    const centre = room.getCenter(new THREE.Vector3());
    const slabs = [
      // centre x, y, z                              half-extents x, y, z
      [centre.x, room.min.y - t / 2, centre.z, size.x / 2 + t, t / 2, size.z / 2 + t], // floor
      [centre.x, room.max.y + t / 2, centre.z, size.x / 2 + t, t / 2, size.z / 2 + t], // ceiling
      [room.min.x - t / 2, centre.y, centre.z, t / 2, size.y / 2 + t, size.z / 2 + t], // -X wall
      [room.max.x + t / 2, centre.y, centre.z, t / 2, size.y / 2 + t, size.z / 2 + t], // +X wall
      [centre.x, centre.y, room.min.z - t / 2, size.x / 2 + t, size.y / 2 + t, t / 2], // -Z wall
      [centre.x, centre.y, room.max.z + t / 2, size.x / 2 + t, size.y / 2 + t, t / 2], // +Z wall
    ];
    const roomBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    for (const [x, y, z, hx, hy, hz] of slabs) {
      world.createCollider(
        RAPIER.ColliderDesc
          .cuboid(hx, hy, hz)
          .setTranslation(x, y, z)
          .setFriction(FRICTION)
          .setRestitution(RESTITUTION),
        roomBody,
      );
    }
  }

  // --- the book ---------------------------------------------------------
  const bookBody = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(bookGroup.position.x, bookGroup.position.y, bookGroup.position.z)
      .setRotation(bookGroup.quaternion)
      .setLinearDamping(LINEAR_DAMPING)
      .setAngularDamping(ANGULAR_DAMPING)
      .setCcdEnabled(true), // a thin board dropped from a height must not tunnel
  );

  // One collider per board and one weight-only slab per half of the text
  // block, all rebuilt only when the book itself is re-sized (a loaded PDF
  // changes HINGE_LEN/PANEL_REACH, which changes the boards).
  let boardColliders = null;
  let pageColliders = null; // [front half, back half]
  let boardSignature = null;
  // How much of the text block is in the front half, 0..1, as last
  // applied. Null when it needs applying whatever it says.
  let pageShare = null;

  // pages.root's own transform -- the permanent rotation.x = PI. Board
  // matrices are expressed in root's space, colliders in the body's, and
  // the body's frame is bookGroup's, so this is the step between them.
  const _rootMatrix = new THREE.Matrix4();
  const _boardMatrix = new THREE.Matrix4();
  const _offsetMatrix = new THREE.Matrix4();
  const _pos = new THREE.Vector3();
  const _quat = new THREE.Quaternion();
  const _scale = new THREE.Vector3();
  const _pagePos = new THREE.Vector3();
  const _pageQuat = new THREE.Quaternion();
  const _unitScale = new THREE.Vector3(1, 1, 1);

  function rebuildBoards(shape) {
    if (boardColliders) {
      for (const c of [...boardColliders, ...pageColliders]) world.removeCollider(c, false);
    }
    // Into world units. The board's dimensions come from the page
    // simulation, which is authored at its own scale and only reaches the
    // world through bookGroup's scale -- but a Rapier body has no scale, so
    // the collider has to be sized in metres itself or the book would
    // collide with the desk as if it were a metre and a half across.
    // Read off the group rather than the world-scale constant: a book
    // taken from the shelf adopts that model's size, and colliders sized
    // from a constant would then no longer be the shape of the book.
    const s = bookGroup.scale.x;
    const halfExtents = {
      x: shape.halfExtents.x * s,
      y: shape.halfExtents.y * s,
      z: shape.halfExtents.z * s,
    };
    const make = () => world.createCollider(
      RAPIER.ColliderDesc
        .cuboid(halfExtents.x, halfExtents.y, halfExtents.z)
        .setDensity(BOARD_DENSITY)
        .setFriction(FRICTION)
        .setRestitution(RESTITUTION),
      bookBody,
    );
    boardColliders = [make(), make()];

    // Weight without a surface. Collision and solver groups of 0 match
    // nothing, so these never generate a contact -- the book still lands
    // on its boards -- but a collider's density counts towards its body's
    // mass whatever it touches. Board-sized, so a density here compares
    // directly with BOARD_DENSITY as a ratio of masses.
    const makeHalf = () => world.createCollider(
      RAPIER.ColliderDesc
        .cuboid(halfExtents.x, halfExtents.y, halfExtents.z)
        .setDensity(0)
        .setCollisionGroups(0)
        .setSolverGroups(0),
      bookBody,
    );
    pageColliders = [makeHalf(), makeHalf()];
    pageShare = null; // new slabs carry no weight until weighPages runs
  }

  /**
   * Split the text block's weight between its two halves.
   *
   * `progress` is 0 with the leaves' shared hinge against the front cover
   * -- page one, nothing read, the whole block in the back half -- and 1
   * against the back cover. So it IS the front half's share of the paper,
   * and the back half's is the rest. This says only HOW MUCH each half
   * weighs; where each half is comes from syncBoards, every frame.
   */
  function weighPages(pages) {
    const share = pages.progress;
    if (pageShare !== null && Math.abs(share - pageShare) < SHARE_EPSILON) return;
    pageShare = share;

    // spineWeight() is 0 for the thinnest book and 1 for the thickest, off
    // the same spine gap the page count already sets -- so a long book is
    // heavier than a short one for the same reason it is fatter.
    const block = PAGE_BLOCK_LIGHTEST
      + (PAGE_BLOCK_HEAVIEST - PAGE_BLOCK_LIGHTEST) * spineWeight();
    pageColliders[0].setDensity(block * share);
    pageColliders[1].setDensity(block * (1 - share));
  }

  /**
   * Re-pose both board colliders from the hardcover's current H1/H2, and
   * both halves of the text block from where the pages are. The boards
   * move every frame under their own scalar dynamics, and a collider that
   * did not follow them would leave the book resting on a cover that is no
   * longer there; the halves move with the pages, and weight that did not
   * follow them would balance the book about paper that has gone.
   */
  function syncBoards(pages) {
    const hardcover = pages && pages.hardcover;
    if (!hardcover) return;

    const shape = hardcover.boardShape;
    // The scale is part of the signature: changing it changes the
    // colliders just as surely as re-sizing the boards does.
    const sig = `${shape.halfExtents.x},${shape.halfExtents.y},${shape.halfExtents.z},${bookGroup.scale.x}`;
    if (sig !== boardSignature) {
      boardSignature = sig;
      rebuildBoards(shape);
    }
    weighPages(pages);

    // Refreshed rather than read as-is: three.js only recomposes an
    // object's local matrix during render, so on the very first frame --
    // before anything has been drawn -- root.matrix is still identity and
    // the boards would be posed without the book's 180 degree flip.
    pages.root.updateMatrix();
    _rootMatrix.copy(pages.root.matrix);
    const boards = [
      { mesh: hardcover.H1, offset: shape.centerOffset.H1 },
      { mesh: hardcover.H2, offset: shape.centerOffset.H2 },
    ];
    for (let i = 0; i < boards.length; i++) {
      const { mesh, offset } = boards[i];
      _offsetMatrix.makeTranslation(offset.x, offset.y, offset.z);
      _boardMatrix.multiplyMatrices(_rootMatrix, mesh.matrix).multiply(_offsetMatrix);
      _boardMatrix.decompose(_pos, _quat, _scale);
      // Same conversion as the half-extents above: the matrix chain is all
      // in the page simulation's own units, the body's frame is metres.
      _pos.multiplyScalar(bookGroup.scale.x);
      boardColliders[i].setTranslationWrtParent({ x: _pos.x, y: _pos.y, z: _pos.z });
      boardColliders[i].setRotationWrtParent({ x: _quat.x, y: _quat.y, z: _quat.z, w: _quat.w });
    }

    // Each half of the block lies wherever its spread's pseudo body is --
    // the same "where this half of the pages is" that the curls are built
    // from and openState reads. A page body sits at the middle of its page
    // (spread.js's makePage centres the collider on it), so its pose, in
    // the page simulation's own frame, IS the slab's centre; the root
    // matrix takes it into the body's frame exactly as it does a board.
    const halves = [pages.spreadFront.pseudoBody, pages.spreadBack.pseudoBody];
    for (let i = 0; i < halves.length; i++) {
      const t = halves[i].translation();
      const r = halves[i].rotation();
      _pagePos.set(t.x, t.y, t.z);
      _pageQuat.set(r.x, r.y, r.z, r.w);
      _boardMatrix.compose(_pagePos, _pageQuat, _unitScale).premultiply(_rootMatrix);
      _boardMatrix.decompose(_pos, _quat, _scale);
      _pos.multiplyScalar(bookGroup.scale.x);
      pageColliders[i].setTranslationWrtParent({ x: _pos.x, y: _pos.y, z: _pos.z });
      pageColliders[i].setRotationWrtParent({ x: _quat.x, y: _quat.y, z: _quat.z, w: _quat.w });
    }

    // Every frame, not just when the split changes: the weight moves
    // whenever the pages do, and moving a collider is not guaranteed to
    // re-derive its body's mass on its own. Four cuboids; cheap.
    bookBody.recomputeMassPropertiesFromColliders();
  }

  // --- keeping a held book inside the room -------------------------------
  // The slabs above stop a book that is FALLING. They cannot stop one being
  // held -- moved with shift-drag, turned with right-drag, carried in the
  // hand. A held book is kinematic: it is put where the hand puts it, not
  // pushed back by whatever it overlaps. So while it is held, the room is
  // enforced by limiting where it may be put.
  //
  // Measured by EVERYTHING the book draws, not by its colliders: covers,
  // spine, the page block, and a leaf standing up mid-turn can all reach past
  // the two boards Rapier knows about. Their world bounds are taken after the
  // hand's latest move or turn, and the book is shifted back by exactly as far
  // as those bounds cross a wall, the floor or the ceiling. Moving the book
  // does not change the size of its bounds, so that one shift is exact -- and
  // turning the book against a wall just eases it away from the wall.
  const _bookBounds = new THREE.Box3();

  function keepInsideRoom() {
    if (!room) return;
    // three.js recomposes matrices at render, and the hand has moved or
    // turned the book since then.
    bookGroup.updateMatrixWorld(true);
    // `precise`: measured from the vertices, not each geometry's cached
    // bounding box. The curl strips are rewritten every frame, and a cached
    // box is whatever shape that page had when it was last computed.
    _bookBounds.setFromObject(bookGroup, true);
    if (_bookBounds.isEmpty()) return;

    for (let axis = 0; axis < 3; axis++) {
      const under = room.min.getComponent(axis) - _bookBounds.min.getComponent(axis);
      const over = _bookBounds.max.getComponent(axis) - room.max.getComponent(axis);
      if (under > 0 && over > 0) continue; // bigger than the room this way -- nowhere to put it
      const shift = under > 0 ? under : (over > 0 ? -over : 0);
      if (shift !== 0) {
        bookGroup.position.setComponent(axis, bookGroup.position.getComponent(axis) + shift);
      }
    }
  }

  // --- grab / release ---------------------------------------------------
  let grabbed = false;
  const _lastGrabPos = new THREE.Vector3().copy(bookGroup.position);
  const _lastGrabQuat = new THREE.Quaternion().copy(bookGroup.quaternion);
  const _releaseLin = new THREE.Vector3();
  const _releaseSpin = new THREE.Quaternion();
  const _releaseAxis = new THREE.Vector3();

  /**
   * Velocity the book should carry away from a grab, measured from how the
   * hand actually moved it over the last frame. Rapier derives this for a
   * kinematic body internally but does not hand it over on a body-type
   * change, so it is reconstructed here -- otherwise the book would drop
   * dead from wherever you released it, however hard you flung it.
   */
  function applyReleaseVelocity(dt) {
    if (dt <= 0) return;

    _releaseLin.copy(bookGroup.position).sub(_lastGrabPos).divideScalar(dt);
    if (_releaseLin.length() > MAX_RELEASE_SPEED) _releaseLin.setLength(MAX_RELEASE_SPEED);
    bookBody.setLinvel({ x: _releaseLin.x, y: _releaseLin.y, z: _releaseLin.z }, true);

    // Angular velocity from the delta quaternion: axis * (angle / dt).
    _releaseSpin.copy(_lastGrabQuat).invert().premultiply(bookGroup.quaternion).normalize();
    const w = THREE.MathUtils.clamp(_releaseSpin.w, -1, 1);
    const sinHalf = Math.sqrt(Math.max(0, 1 - w * w));
    if (sinHalf > 1e-6) {
      const angle = 2 * Math.atan2(sinHalf, w); // 0..PI, always the short way
      const spin = THREE.MathUtils.clamp(angle / dt, -MAX_RELEASE_SPIN, MAX_RELEASE_SPIN);
      _releaseAxis
        .set(_releaseSpin.x, _releaseSpin.y, _releaseSpin.z)
        .divideScalar(sinHalf)
        .multiplyScalar(spin);
      bookBody.setAngvel({ x: _releaseAxis.x, y: _releaseAxis.y, z: _releaseAxis.z }, true);
    } else {
      bookBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
  }

  function setGrabbed(v, dt) {
    if (v === grabbed) return;
    grabbed = v;
    if (grabbed) {
      bookBody.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
    } else {
      bookBody.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
      applyReleaseVelocity(dt);
    }
  }

  return {
    body: bookBody,
    world,

    get grabbed() { return grabbed; },

    /**
     * Advance placement and write the result onto bookGroup.
     *
     * Call AFTER pages.step(), so the board colliders are posed from this
     * frame's H1/H2 rather than last frame's.
     *
     * @param {number} dt  seconds
     * @param {boolean} isGrabbed  is a pointer gesture currently driving
     *   bookGroup by hand (drag, arcball, carried)? While true the body
     *   is kinematic and COPIES bookGroup; while false it is dynamic and
     *   DRIVES it.
     */
    step(dt, isGrabbed) {
      const step = Math.min(Math.max(dt, 1e-4), 1 / 30);
      setGrabbed(isGrabbed, step);

      const pages = getPages();
      syncBoards(pages);

      if (grabbed) {
        // The hand is authoritative -- within the room -- and the body just
        // tracks it, so whatever it is pushed into still generates contacts.
        keepInsideRoom();
        bookBody.setNextKinematicTranslation({
          x: bookGroup.position.x, y: bookGroup.position.y, z: bookGroup.position.z,
        });
        bookBody.setNextKinematicRotation({
          x: bookGroup.quaternion.x,
          y: bookGroup.quaternion.y,
          z: bookGroup.quaternion.z,
          w: bookGroup.quaternion.w,
        });
      }

      world.timestep = step;
      world.step();

      if (grabbed) {
        // Recorded AFTER the step so the next release measures against the
        // pose the hand actually last held.
        _lastGrabPos.copy(bookGroup.position);
        _lastGrabQuat.copy(bookGroup.quaternion);
      } else {
        const t = bookBody.translation();
        const r = bookBody.rotation();
        bookGroup.position.set(t.x, t.y, t.z);
        bookGroup.quaternion.set(r.x, r.y, r.z, r.w);
      }
    },

    /** Put the book back where it started, at rest. */
    reset(position, quaternion) {
      bookBody.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
      grabbed = false;
      bookBody.setTranslation({ x: position.x, y: position.y, z: position.z }, true);
      bookBody.setRotation(
        { x: quaternion.x, y: quaternion.y, z: quaternion.z, w: quaternion.w }, true,
      );
      bookBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
      bookBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
      _lastGrabPos.copy(position);
      _lastGrabQuat.copy(quaternion);
    },
  };
}