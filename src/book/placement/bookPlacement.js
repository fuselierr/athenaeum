import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { GRAVITY_MAG } from '../pageSim/config.js';

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

// A grabbed book is moved by hand, so its velocity has to be measured
// rather than simulated -- this is what lets you throw it. Capped so a
// single stuttered frame cannot fling it across the room.
const MAX_RELEASE_SPEED = 12; // world units/s
const MAX_RELEASE_SPIN = 12; // rad/s

export async function createBookPlacement({ bookGroup, getPages, desk }) {
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

  // --- the book ---------------------------------------------------------
  const bookBody = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(bookGroup.position.x, bookGroup.position.y, bookGroup.position.z)
      .setRotation(bookGroup.quaternion)
      .setLinearDamping(LINEAR_DAMPING)
      .setAngularDamping(ANGULAR_DAMPING)
      .setCcdEnabled(true), // a thin board dropped from a height must not tunnel
  );

  // One collider per board, rebuilt only when the book itself is re-sized
  // (a loaded PDF changes HINGE_LEN/PANEL_REACH, which changes the boards).
  let boardColliders = null;
  let boardSignature = null;

  // pages.root's own transform -- the permanent rotation.x = PI. Board
  // matrices are expressed in root's space, colliders in the body's, and
  // the body's frame is bookGroup's, so this is the step between them.
  const _rootMatrix = new THREE.Matrix4();
  const _boardMatrix = new THREE.Matrix4();
  const _offsetMatrix = new THREE.Matrix4();
  const _pos = new THREE.Vector3();
  const _quat = new THREE.Quaternion();
  const _scale = new THREE.Vector3();

  function rebuildBoards(shape) {
    if (boardColliders) {
      for (const c of boardColliders) world.removeCollider(c, false);
    }
    const { halfExtents } = shape;
    const make = () => world.createCollider(
      RAPIER.ColliderDesc
        .cuboid(halfExtents.x, halfExtents.y, halfExtents.z)
        .setFriction(FRICTION)
        .setRestitution(RESTITUTION),
      bookBody,
    );
    boardColliders = [make(), make()];
  }

  /**
   * Re-pose both board colliders from the hardcover's current H1/H2. The
   * boards move every frame under their own scalar dynamics, and a
   * collider that did not follow them would leave the book resting on a
   * cover that is no longer there.
   */
  function syncBoards(pages) {
    const hardcover = pages && pages.hardcover;
    if (!hardcover) return;

    const shape = hardcover.boardShape;
    const sig = `${shape.halfExtents.x},${shape.halfExtents.y},${shape.halfExtents.z}`;
    if (sig !== boardSignature) {
      boardSignature = sig;
      rebuildBoards(shape);
    }

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
      boardColliders[i].setTranslationWrtParent({ x: _pos.x, y: _pos.y, z: _pos.z });
      boardColliders[i].setRotationWrtParent({ x: _quat.x, y: _quat.y, z: _quat.z, w: _quat.w });
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
     *   bookGroup by hand (drag, arcball, pickup mode)? While true the body
     *   is kinematic and COPIES bookGroup; while false it is dynamic and
     *   DRIVES it.
     */
    step(dt, isGrabbed) {
      const step = Math.min(Math.max(dt, 1e-4), 1 / 30);
      setGrabbed(isGrabbed, step);

      const pages = getPages();
      syncBoards(pages);

      if (grabbed) {
        // The hand is authoritative; the body just tracks it, so whatever
        // it is pushed into still generates contacts.
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
