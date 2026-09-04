import * as THREE from 'three';

// >1 = a given drag arc turns the book further than it visually swept.
const ROTATE_SENSITIVITY = 1.4;

const WORLD_DOWN = new THREE.Vector3(0, -1, 0);

/**
 * Pointer gestures that move the book as a whole, plus the gravity
 * correction those gestures make necessary.
 *
 *   right-drag          arcball-rotate the book
 *   shift + left-drag   slide the book in the plane of the screen
 *
 * Both act on `bookGroup` -- the render-only wrapper the book hangs under
 * -- and never touch physics coordinates or PageSimulation.root's own
 * transform.
 *
 * Returns `{ update() }`; tick it each frame so gravity keeps pointing at
 * true world-down.
 */
export function createBookManipulator({ bookGroup, camera, renderer, getPages }) {
  const dom = renderer.domElement;
  dom.addEventListener('contextmenu', (e) => e.preventDefault());

  installArcballRotate({ bookGroup, camera, dom });
  installScreenPlaneSlide({ bookGroup, camera, dom });

  // Rapier's gravity vector lives in PageSimulation's own physics space,
  // which knows nothing about bookGroup's transform -- so without this,
  // rotating the book would silently rotate gravity with it and the pages
  // would stay put relative to the covers instead of sagging toward the
  // floor. Recomputed every frame (one quaternion-vector rotation) rather
  // than only on pointermove, so it stays correct however bookGroup moves.
  const _localDown = new THREE.Vector3();
  const _invBookQuat = new THREE.Quaternion();

  return {
    update() {
      _invBookQuat.copy(bookGroup.quaternion).invert();
      _localDown.copy(WORLD_DOWN).applyQuaternion(_invBookQuat);
      getPages().setGravityDirection(_localDown);
    },
  };
}

// --- right-drag: true arcball/trackball rotation ------------------------
// Rotating around the camera up axis for dx and its right axis for dy
// independently gives yaw and pitch but never ROLL, because a straight
// horizontal or vertical drag cannot produce rotation around the camera's
// own view axis. Shoemake's arcball maps the cursor onto an imaginary
// sphere in front of the camera instead: near its centre that is mostly
// yaw/pitch, but out past its silhouette (pointerToSphere's z = 0 case)
// the mapped point slides around the sphere's RIM, so a drag curving out
// there sweeps an arc around the view axis -- which reads as rolling the
// book. Axis and angle come from the arc between the previous and current
// sphere points, so a diagonal or curved drag is one combined rotation
// rather than two independent ones.
function installArcballRotate({ bookGroup, camera, dom }) {
  let rotating = false;
  const _last = new THREE.Vector3();
  const _cur = new THREE.Vector3();
  const _axis = new THREE.Vector3();
  const _delta = new THREE.Quaternion();

  /**
   * Maps a client-space pointer position onto the unit sphere, in
   * CAMERA-LOCAL coordinates (+X right, +Y up, +Z toward the viewer --
   * matches camera.matrix's own column basis, so the result feeds
   * transformDirection below with no extra remapping). Inside the sphere's
   * silhouette this is a point on its front face; beyond it the point is
   * clamped onto the rim (z = 0) rather than left undefined -- that rim is
   * exactly where dragging starts producing roll instead of yaw/pitch.
   */
  function pointerToSphere(clientX, clientY, out) {
    const rect = dom.getBoundingClientRect();
    const radius = Math.min(rect.width, rect.height) / 2;
    const x = (clientX - rect.left - rect.width / 2) / radius;
    const y = (rect.height / 2 - (clientY - rect.top)) / radius; // screen Y grows down, sphere Y up
    const lenSq = x * x + y * y;
    if (lenSq <= 1) {
      out.set(x, y, Math.sqrt(1 - lenSq));
    } else {
      const len = Math.sqrt(lenSq);
      out.set(x / len, y / len, 0);
    }
    return out;
  }

  dom.addEventListener('pointerdown', (e) => {
    if (e.button !== 2) return;
    rotating = true;
    pointerToSphere(e.clientX, e.clientY, _last);
  });

  window.addEventListener('pointermove', (e) => {
    if (!rotating) return;
    pointerToSphere(e.clientX, e.clientY, _cur);

    _axis.crossVectors(_last, _cur);
    const axisLenSq = _axis.lengthSq();
    if (axisLenSq > 1e-12) {
      const dot = THREE.MathUtils.clamp(_last.dot(_cur), -1, 1);
      const angle = Math.acos(dot) * ROTATE_SENSITIVITY;
      _axis.multiplyScalar(1 / Math.sqrt(axisLenSq)); // normalize without a second sqrt
      // The axis is camera-local (see pointerToSphere); transformDirection
      // rotates it into world space by the camera's CURRENT orientation, so
      // the gesture stays camera-relative however the book is oriented.
      _axis.transformDirection(camera.matrix);
      _delta.setFromAxisAngle(_axis, angle);
      bookGroup.quaternion.premultiply(_delta);
      bookGroup.quaternion.normalize(); // stop float drift accumulating over a long drag
    }

    _last.copy(_cur);
  });

  window.addEventListener('pointerup', (e) => {
    if (e.button === 2) rotating = false;
  });
}

// --- shift + left-drag: slide the book in view --------------------------
// Camera-relative by construction rather than by mapping drag pixels onto
// camera axes with a tuned sensitivity: the cursor is cast onto a plane
// through the book, and the book moves by the difference between where
// that ray landed at pointerdown and where it lands now. The book stays
// exactly under the cursor however the camera is orbited or zoomed, with
// no constant to retune when the framing changes.
//
// The plane FACES THE CAMERA, so the book always travels in the plane of
// the screen. Using the horizontal (XZ) plane instead lets the book only
// slide along the desk, and degenerates as the camera nears desk level,
// where a nearly-parallel ray turns a few pixels into an enormous jump.
//
// Captured once at pointerdown: the camera cannot orbit mid-drag anyway
// (this suppresses OrbitControls), and a fixed plane keeps the grab point
// exact for the whole gesture.
//
// The pointerdown listener is on WINDOW in the CAPTURE phase, the only
// place that reliably wins this event: dragPageTurn claims plain
// left-drags that hit a page via its own capture listener on the canvas,
// and OrbitControls claims what is left in the bubble phase. Capture
// descends window -> document -> canvas, so this runs before both.
function installScreenPlaneSlide({ bookGroup, camera, dom }) {
  const _plane = new THREE.Plane();
  const _ray = new THREE.Raycaster();
  const _ndc = new THREE.Vector2();
  const _hit = new THREE.Vector3();
  const _normal = new THREE.Vector3(); // view direction at pointerdown
  const _grab = new THREE.Vector3(); // where on the plane the drag started
  const _origin = new THREE.Vector3(); // bookGroup.position at that moment
  let sliding = false;

  function pointerToPlane(clientX, clientY, out) {
    const rect = dom.getBoundingClientRect();
    _ndc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    _ray.setFromCamera(_ndc, camera);
    return _ray.ray.intersectPlane(_plane, out);
  }

  window.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !e.shiftKey || sliding) return;
    // Ignore shift-clicks on the overlaid UI panels -- only the 3D view
    // slides the book.
    if (e.target !== dom) return;

    camera.getWorldDirection(_normal);
    _plane.setFromNormalAndCoplanarPoint(_normal, bookGroup.position);
    if (!pointerToPlane(e.clientX, e.clientY, _grab)) return; // grazing view -- leave the event alone

    _origin.copy(bookGroup.position);
    sliding = true;
    dom.style.cursor = 'grabbing';
    e.stopPropagation();
    e.preventDefault();
  }, { capture: true });

  window.addEventListener('pointermove', (e) => {
    if (!sliding) return;
    // Deliberately not re-checking shiftKey: releasing shift mid-drag
    // should not drop the book somewhere unintended -- the gesture ends on
    // pointerup, like every other drag here.
    if (!pointerToPlane(e.clientX, e.clientY, _hit)) return;
    // The plane is screen-facing, so this is exactly the cursor's own
    // movement carried into world space.
    bookGroup.position.copy(_origin).add(_hit).sub(_grab);
  });

  window.addEventListener('pointerup', (e) => {
    if (e.button !== 0 || !sliding) return;
    sliding = false;
    dom.style.cursor = e.shiftKey ? 'move' : '';
  });

  // Shift on its own advertises the control before you commit to a drag.
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Shift' && !sliding) dom.style.cursor = 'move';
  });
  window.addEventListener('keyup', (e) => {
    if (e.key === 'Shift' && !sliding) dom.style.cursor = '';
  });
  window.addEventListener('blur', () => {
    if (!sliding) dom.style.cursor = '';
  });
}
