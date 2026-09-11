import * as THREE from 'three';

/**
 * Taking the book up off the desk to read it.
 *
 * Clicking the book brings it up in front of you, the way clicking a shelf
 * book does (scene/shelfBooks.js) -- and turned the way a book is read: head
 * up, the open spread (or, shut, the front board) toward you, the right-hand
 * page on the right. However it was lying, even upside down after a tumble,
 * it arrives square. Press Escape and it goes back to where it lay; click
 * the desk and it is set down there, square, instead (main.js's
 * putBookDown). Clicking the book itself while it is up does nothing: that
 * is reading it, not asking for it to go.
 *
 * The same mechanism as the shelf: a `hold` easing between 0 and 1, and a
 * pose blended by it from where the book lay to where the hand is. The hand
 * pose is read from the camera every frame, so the book follows you.
 *
 * WHAT IT IS CENTRED ON. The book's own origin is the spine of a book lying
 * open, which is the middle of nothing once it is shut. So the hand holds
 * what the reader is looking at -- the gutter of an open spread, the middle
 * of a shut book (PageSimulation.readingFrame) -- far enough away to fit it
 * in view. Opening the book in the hand changes both, so they are eased
 * rather than snapped: the book settles into its new framing instead of
 * jumping.
 *
 * GRAVITY is not handled here, but it matters: held up facing you, real
 * gravity would run across the pages and swing them about. While it is
 * carried, the book is read as if it were lying on a desk -- see
 * bookManipulator's update({ carried }).
 */

// How much of the view the book fills, across whichever of its width or
// height is the tighter fit.
const HOLD_FILL = 0.88;
// The head tipped a little away, the way a book is held to read rather than
// presented square to a camera.
const READ_TILT = -0.6; // radians about the view's right axis
// Ease rates, 1/s -- the same feel as the shelf: brisk up, slower back.
const TAKE_RATE = 7;
const RETURN_RATE = 5;
// How quickly the framing follows the book opening or shutting in the hand.
const REFRAME_RATE = 5;

// The held orientation, in the camera's own space. The book's reading axes
// (X = head, Y = out of the page, Z = the reader's right) onto the camera's
// (+Y up, +Z back toward the eye, +X right). A proper rotation, built as a
// basis and tilted by rotating -- never by negating a column.
const HOLD_ROTATION = new THREE.Quaternion()
  .setFromRotationMatrix(new THREE.Matrix4().makeBasis(
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(0, 0, 1),
    new THREE.Vector3(1, 0, 0),
  ))
  .premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), READ_TILT));

/** Smoothstep, so the trip starts and ends still. */
function ease(t) {
  return t * t * (3 - 2 * t);
}

/**
 * @param {object} opts
 * @param {THREE.Scene} opts.scene  raycast for what is nearest under a click
 * @param {THREE.Group} opts.bookGroup
 * @param {THREE.PerspectiveCamera} opts.camera
 * @param {THREE.WebGLRenderer} opts.renderer
 * @param {() => import('../book/pageSim/PageSimulation.js').PageSimulation} opts.getPages
 * @param {{ reset(position: THREE.Vector3, quaternion: THREE.Quaternion): void }} opts.placement
 * @param {() => boolean} [opts.canTake]  whether the book is free to be taken
 *   -- not while a shelf book has the hand
 * @param {() => boolean} [opts.inHand]  whether the book is already in the
 *   hand some other way (a shelf book that became this book), so a click on
 *   it is swallowed rather than handed on to send it back
 */
export function createBookCarry({
  scene, bookGroup, camera, renderer, getPages, placement,
  canTake = () => true, inHand = () => false,
}) {
  let held = false;
  let hold = 0; // 0 where it lay, 1 in the hand, in between on the way

  // Where it lay when it was taken, and so where it goes back to.
  const restPosition = new THREE.Vector3();
  const restQuaternion = new THREE.Quaternion();

  // The framing actually in use, eased toward what the book asks for.
  const centre = new THREE.Vector3();
  let distance = 0;
  let framed = false; // seeded since the last take?

  const _raycaster = new THREE.Raycaster();
  const _ndc = new THREE.Vector2();
  const _targetCentre = new THREE.Vector3();
  const _handPosition = new THREE.Vector3();
  const _handQuaternion = new THREE.Quaternion();
  const _offset = new THREE.Vector3();

  /** Is an object actually on screen -- itself and every parent visible? */
  function shown(object) {
    for (let o = object; o; o = o.parent) if (!o.visible) return false;
    return true;
  }

  function partOfBook(object) {
    for (let o = object; o; o = o.parent) if (o === bookGroup) return true;
    return false;
  }

  /**
   * Is the book the nearest visible thing under this click? Nearest, so a
   * lamp or the instruction card in front of it keeps the click; visible,
   * because raycasting ignores `visible` and hidden walls would otherwise
   * be in the way.
   */
  function bookUnder(event) {
    const rect = renderer.domElement.getBoundingClientRect();
    _ndc.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    _raycaster.setFromCamera(_ndc, camera);
    const nearest = _raycaster.intersectObject(scene, true).find((hit) => shown(hit.object));
    return Boolean(nearest) && partOfBook(nearest.object);
  }

  /** The pose the hand wants this frame, into _handPosition/_handQuaternion. */
  function readHandPose(dt) {
    const frame = getPages().readingFrame(_targetCentre);
    const scale = bookGroup.scale.x;
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    const targetDistance = Math.max(
      (frame.height * scale) / (HOLD_FILL * 2 * tanHalf),
      (frame.width * scale) / (HOLD_FILL * 2 * tanHalf * camera.aspect),
    );
    if (!framed) {
      centre.copy(_targetCentre);
      distance = targetDistance;
      framed = true;
    } else {
      const k = 1 - Math.exp(-REFRAME_RATE * dt);
      centre.lerp(_targetCentre, k);
      distance += (targetDistance - distance) * k;
    }

    // Matrices are composed at render; the camera has moved since.
    camera.updateMatrixWorld();
    camera.getWorldQuaternion(_handQuaternion).multiply(HOLD_ROTATION);
    // Straight ahead at `distance`, then back by wherever the framed middle
    // sits inside the book, so that middle is what lands in front of you.
    _handPosition.set(0, 0, -distance).applyMatrix4(camera.matrixWorld)
      .sub(_offset.copy(centre).multiplyScalar(scale).applyQuaternion(_handQuaternion));
  }

  return {
    /** In the hand, or on its way there. */
    get held() { return held; },

    /** Anywhere off the desk: held, or still travelling either way. */
    get carrying() { return held || hold > 0; },

    /**
     * A click in the room. Returns true if it was the book's: a click on the
     * book takes it up. A click on it while it is already in the hand is
     * still the book's, and does nothing -- claimed, so the shelf does not
     * take it as a click on the book behind it (the shelf tests only its own
     * books, whatever is in front) or send a shelf book back.
     */
    handleClick(event) {
      if (!bookUnder(event)) return false;
      if (held || inHand()) return true;
      if (!canTake()) return false;
      // Caught on its way back, it keeps the place it was going back to.
      if (hold === 0) {
        restPosition.copy(bookGroup.position);
        restQuaternion.copy(bookGroup.quaternion);
        framed = false;
      }
      held = true;
      return true;
    },

    /** Send it back to where it lay -- what Escape does. */
    putBack() {
      held = false;
    },

    /**
     * Drop it out of the hand on the spot, for a caller that is placing the
     * book itself (setting it down on the desk, resetting it).
     */
    letGo() {
      held = false;
      hold = 0;
    },

    /** Call every frame, after the camera has moved. */
    update(dt) {
      if (!held && hold === 0) return;
      const target = held ? 1 : 0;
      if (Math.abs(target - hold) < 1e-4) {
        hold = target;
      } else {
        hold += (target - hold) * Math.min((held ? TAKE_RATE : RETURN_RATE) * dt, 1);
      }

      readHandPose(dt);
      const t = ease(hold);
      bookGroup.position.lerpVectors(restPosition, _handPosition, t);
      bookGroup.quaternion.slerpQuaternions(restQuaternion, _handQuaternion, t);

      // Home. Handed back to physics at rest, rather than carrying away
      // whatever speed the last frame of the trip happened to measure.
      if (hold === 0) placement.reset(restPosition, restQuaternion);
    },
  };
}