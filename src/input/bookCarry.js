import * as THREE from 'three';

/**
 * Taking the book up off the desk to read it.
 *
 * Clicking the book brings it up in front of you, the way clicking a shelf
 * book does (scene/inside/shelfBooks.js) -- and turned the way a book is read: head
 * up, the open spread (or, shut, the front board) toward you, the right-hand
 * page on the right. However it was lying, even upside down after a tumble,
 * it arrives square. Press Escape and it goes back to where it lay; click
 * the desk and it is set down there, square, instead (main.js's
 * putBookDown). Clicking the book itself while it is up does nothing: that
 * is reading it, not asking for it to go.
 *
 * A BOOK FROM THE SHELF is carried the same way. Once its pages are ready,
 * main.js hands it over with takeFrom(): it starts from where the shelf
 * model was in the hand, and its HOME is the model's slot on the shelf
 * rather than wherever it lay -- so Escape flies it back into the shelf, and
 * `onReturn` lets the shelf show its model again.
 *
 * Every trip -- up to the hand, or home -- is a `travel` easing from 0 to 1,
 * blending from where the book was when the trip began to where it is
 * going. Re-based at each start, so a trip can begin anywhere: from a desk,
 * from a shelf model's pose, or from half-way back when the book is caught
 * again. The hand end is read from the camera every frame, so the book
 * follows you.
 *
 * WHAT IT IS CENTRED ON. The book's own origin is the spine of a book lying
 * open, which is the middle of nothing once it is shut. So the hand holds
 * what the reader is looking at -- the gutter of an open spread, the middle
 * of a shut book (PageSimulation.readingFrame) -- far enough away to fit it
 * in view. Opening the book in the hand changes both, so they are eased
 * rather than snapped: the book settles into its new framing instead of
 * jumping.
 *
 * ADJUSTING IT. The book in the hand can still be slid (shift-drag), turned
 * (right-drag) and brought nearer or pushed away (scroll) -- the same
 * gestures as on the desk, routed here by bookManipulator.js. They are kept
 * as offsets on top of the hand pose, in the camera's own space, so the
 * book keeps wherever you put it as you walk and look around, and the
 * framing still follows it opening and shutting. Each take starts square
 * again, and straighten() (the reset key) eases the book back to that
 * without putting it down.
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
// How far scrolling can take the book, as a multiple of the distance that
// fits it in view, and as a hard floor and ceiling in metres -- the floor
// keeps it outside the camera's near plane, the ceiling within reach.
const REACH_SCALE_MIN = 0.25;
const REACH_SCALE_MAX = 4;
const REACH_MIN = 0.08;
const REACH_MAX = 2.5;
// How quickly straighten() eases the slide, turn and push back out, 1/s.
const STRAIGHTEN_RATE = 8;

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
 *   -- not while a shelf model has the hand
 */
export function createBookCarry({
  scene, bookGroup, camera, renderer, getPages, placement,
  canTake = () => true,
}) {
  let held = false; // in the hand, or on the way there
  let returning = false; // on the way home
  let travel = 1; // 0..1 through the current trip

  // Where the current trip began, and where the book goes when put back.
  const fromPosition = new THREE.Vector3();
  const fromQuaternion = new THREE.Quaternion();
  const homePosition = new THREE.Vector3();
  const homeQuaternion = new THREE.Quaternion();
  // Told when the book stops being carried: (true) once it has arrived home,
  // (false) when it was let go of anywhere else. Only a shelf book has one.
  let onReturn = null;

  // The framing actually in use, eased toward what the book asks for.
  const centre = new THREE.Vector3();
  let distance = 0;
  let framed = false; // seeded since the last take?

  // What the reader has done to it since taking it, in camera space: slid
  // right/up (metres), turned, and pushed (a multiple of `distance`).
  const nudge = new THREE.Vector2();
  const twist = new THREE.Quaternion();
  let reach = 1;
  let straightening = false; // easing all three back to none

  const _raycaster = new THREE.Raycaster();
  const _ndc = new THREE.Vector2();
  const _targetCentre = new THREE.Vector3();
  const _handPosition = new THREE.Vector3();
  const _handQuaternion = new THREE.Quaternion();
  const _offset = new THREE.Vector3();
  const _cameraInverse = new THREE.Quaternion();
  const _identity = new THREE.Quaternion();
  const _slide = new THREE.Vector3();

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

  /** A new trip starts from wherever the book is now. */
  function startTrip() {
    fromPosition.copy(bookGroup.position);
    fromQuaternion.copy(bookGroup.quaternion);
    travel = 0;
  }

  /** Square again: no slide, turn or push, framing re-seeded. */
  function resetAdjustments() {
    framed = false;
    nudge.set(0, 0);
    twist.identity();
    reach = 1;
    straightening = false;
  }

  /** No longer carried, for whatever reason. */
  function endCarry(arrived) {
    held = false;
    returning = false;
    travel = 1;
    const callback = onReturn;
    onReturn = null;
    callback?.(arrived);
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
    // The twist sits between the camera and the reading pose, so a turn is
    // made in view space -- the way the drag that made it was.
    camera.getWorldQuaternion(_handQuaternion).multiply(twist).multiply(HOLD_ROTATION);
    // Ahead at the pushed distance and off by the slide, then back by
    // wherever the framed middle sits inside the book, so that middle is
    // what lands there -- and is what the book turns about.
    const away = THREE.MathUtils.clamp(distance * reach, REACH_MIN, REACH_MAX);
    _handPosition.set(nudge.x, nudge.y, -away).applyMatrix4(camera.matrixWorld)
      .sub(_offset.copy(centre).multiplyScalar(scale).applyQuaternion(_handQuaternion));
  }

  return {
    /** In the hand, or on its way there. */
    get held() { return held; },

    /** Anywhere off its resting place: held, or on its way home. */
    get carrying() { return held || returning; },

    /**
     * A click in the room. Returns true if it was the book's: a click on the
     * book takes it up. A click on it while it is already in the hand is
     * still the book's, and does nothing -- claimed, so the shelf does not
     * take it as a click on the shelf book behind it (the shelf tests only
     * its own books, whatever is in front).
     */
    handleClick(event) {
      if (!bookUnder(event)) return false;
      if (held) return true;
      if (!canTake()) return false;
      // Lying where it lies, that is its home. Caught on its way back, it
      // keeps the home it was going to, and the way it was being held.
      if (!returning) {
        homePosition.copy(bookGroup.position);
        homeQuaternion.copy(bookGroup.quaternion);
        onReturn = null;
        resetAdjustments();
      }
      returning = false;
      held = true;
      startTrip();
      return true;
    },

    /**
     * Take the book into the hand from wherever it has just been put -- a
     * shelf model's pose, for a book off the shelf -- with its own home to
     * go back to.
     *
     * @param {{ position: THREE.Vector3, quaternion: THREE.Quaternion }} home
     * @param {(arrived: boolean) => void} [onReturnHome]  see `onReturn`
     */
    takeFrom(home, onReturnHome = null) {
      // Anything still carried gives way first, and is told so.
      if (held || returning) endCarry(false);
      homePosition.copy(home.position);
      homeQuaternion.copy(home.quaternion);
      onReturn = onReturnHome;
      resetAdjustments();
      held = true;
      startTrip();
    },

    /** Slide it by a WORLD-space movement; kept as a slide in view space. */
    slideBy(worldDelta) {
      camera.getWorldQuaternion(_cameraInverse).invert();
      _slide.copy(worldDelta).applyQuaternion(_cameraInverse);
      // Across the view only: nearer and further is the scroll's.
      nudge.x += _slide.x;
      nudge.y += _slide.y;
      straightening = false; // the reader's hand wins over the reset's
    },

    /** Turn it by a rotation given in the CAMERA's own space. */
    turnBy(viewDelta) {
      twist.premultiply(viewDelta).normalize();
      straightening = false;
    },

    /** Scale how far away it is held: > 1 pushes it away, < 1 brings it in. */
    pushBy(factor) {
      reach = THREE.MathUtils.clamp(reach * factor, REACH_SCALE_MIN, REACH_SCALE_MAX);
      straightening = false;
    },

    /**
     * Back to how the book was first held -- centred, square, at the distance
     * that fits it in view -- eased there rather than snapped. Keeps it in
     * the hand. A slide, turn or push made on the way cancels it.
     */
    straighten() {
      if (held) straightening = true;
    },

    /** Send it home -- where it lay, or its shelf slot. What Escape does. */
    putBack() {
      if (!held) return;
      held = false;
      returning = true;
      startTrip();
    },

    /**
     * Stop carrying it on the spot, for a caller that is placing the book
     * itself (setting it down on the desk, resetting it).
     */
    letGo() {
      if (held || returning) endCarry(false);
    },

    /** Call every frame, after the camera has moved. */
    update(dt) {
      if (!held && !returning) return;
      if (travel < 1) {
        travel += (1 - travel) * Math.min((held ? TAKE_RATE : RETURN_RATE) * dt, 1);
        if (1 - travel < 1e-4) travel = 1;
      }

      if (straightening) {
        const k = 1 - Math.exp(-STRAIGHTEN_RATE * dt);
        nudge.multiplyScalar(1 - k);
        twist.slerp(_identity, k);
        reach += (1 - reach) * k;
        if (nudge.lengthSq() < 1e-8 && Math.abs(1 - reach) < 1e-4 && twist.angleTo(_identity) < 1e-4) {
          nudge.set(0, 0);
          twist.identity();
          reach = 1;
          straightening = false;
        }
      }

      const t = ease(travel);
      if (held) {
        readHandPose(dt);
        bookGroup.position.lerpVectors(fromPosition, _handPosition, t);
        bookGroup.quaternion.slerpQuaternions(fromQuaternion, _handQuaternion, t);
        return;
      }

      bookGroup.position.lerpVectors(fromPosition, homePosition, t);
      bookGroup.quaternion.slerpQuaternions(fromQuaternion, homeQuaternion, t);
      if (travel === 1) {
        // Home. Handed back to physics at rest, rather than carrying away
        // whatever speed the last frame of the trip happened to measure --
        // and then to whoever the home belongs to.
        placement.reset(homePosition, homeQuaternion);
        endCarry(true);
      }
    },
  };
}