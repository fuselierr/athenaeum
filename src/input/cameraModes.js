import * as THREE from 'three';

/**
 * The three ways of moving the camera, switched with the 1 / 2 / 3 keys.
 *
 *   1  ORBIT  the original rig -- OrbitControls with WASD panning. A table
 *             view: you circle the book rather than standing anywhere.
 *   2  WALK   first person. WASD walks across the floor at eye height,
 *             dragging looks around.
 *   3  LOOK   parked in the middle of the room. Dragging looks around, the
 *             wheel zooms in on whatever caught your eye.
 *
 * WHY THIS OWNS THE OTHER TWO. OrbitControls writes the camera's position
 * AND calls lookAt(target) on every update(), whether or not it is enabled
 * -- so a mode that steers the camera directly cannot simply disable it and
 * carry on ticking it. Same for the WASD pan, which moves camera and orbit
 * target together. Both are therefore driven from here: update() ticks the
 * pan only in ORBIT, and main.js ticks OrbitControls only while `mode` is
 * ORBIT.
 *
 * HANDING BACK TO ORBIT. The look modes keep controls.target a fixed
 * distance out along the view direction, so switching to 1 pivots around
 * what you were just looking at instead of whipping back to the desk.
 */

export const CAMERA_MODE = { ORBIT: 1, WALK: 2, LOOK: 3 };

// Metric world (scene/worldScale.js): these are real metres.
const EYE_HEIGHT = 2.0;
const WALK_SPEED = 1.9;
const RUN_MULTIPLIER = 2.1;
const WALK_ACCELERATION = 14;
const WALK_DAMPING = 11;
// How far in from the floor's edge you can walk. The floor is a finite slab
// (scene/floor.js), so without this you can step off it into the void.
const WALL_MARGIN = 0.15;

const LOOK_SENSITIVITY = 0.0024; // radians per pixel, at the base fov
const PITCH_LIMIT = Math.PI / 2 - 0.05; // short of straight up/down, which gimbals

const MIN_FOV = 12; // about 4x magnification against the default 50
const ZOOM_PER_NOTCH = 1.12;

// Where LOOK aims when you first arrive: the desk top is y = 0 and the book
// sits on the origin, so this is the thing worth looking at.
const FOCUS = new THREE.Vector3(0, 0, 0);

// Distance out along the view direction that the orbit target is parked at
// while a look mode has the camera. Arm's length rather than the wall, so
// going back to 1 orbits around the near thing you were facing.
const ORBIT_HANDOFF_DISTANCE = 1.5;

const WALK_KEYS = new Set(['w', 'a', 's', 'd']);

/**
 * @param {object} opts
 * @param {THREE.PerspectiveCamera} opts.camera
 * @param {THREE.WebGLRenderer} opts.renderer
 * @param {object} opts.controls  OrbitControls
 * @param {{update(dt: number): void}} opts.cameraPan  ticked in ORBIT only
 * @param {HTMLElement|null} [opts.indicator]  optional readout of the mode
 *
 * IMPORTANT: construct this BEFORE dragCover / dragPageTurn /
 * bookManipulator. All four listen for pointerdown on the same canvas, and
 * listeners on one element fire in registration order -- being first is what
 * lets a look-drag swallow the gesture so it does not also turn a page.
 */
export function createCameraModes({
  camera, renderer, controls, cameraPan,
  indicator = document.getElementById('camera-mode'),
}) {
  const dom = renderer.domElement;
  const baseFov = camera.fov;

  let mode = CAMERA_MODE.ORBIT;
  let yaw = 0;
  let pitch = 0;
  let room = null; // walkable bounds; set once the furniture has been placed

  const held = new Set();
  const velocity = new THREE.Vector3();
  const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
  const _forward = new THREE.Vector3();
  const _right = new THREE.Vector3();
  const _wish = new THREE.Vector3();
  const _centre = new THREE.Vector3();

  const floorY = () => (room ? room.min.y : 0);

  // --- looking -------------------------------------------------------------
  // Yaw/pitch are the authority in modes 2 and 3, but the camera arrives from
  // whatever OrbitControls left behind, so they are read back out of it on
  // every mode change rather than being remembered across modes.
  function readLookFromCamera() {
    _euler.setFromQuaternion(camera.quaternion, 'YXZ');
    yaw = _euler.y;
    pitch = THREE.MathUtils.clamp(_euler.x, -PITCH_LIMIT, PITCH_LIMIT);
  }

  function applyLook() {
    _euler.set(pitch, yaw, 0, 'YXZ');
    camera.quaternion.setFromEuler(_euler);
    camera.getWorldDirection(_forward);
    controls.target.copy(camera.position).addScaledVector(_forward, ORBIT_HANDOFF_DISTANCE);
  }

  function clampToFloor() {
    camera.position.y = floorY() + EYE_HEIGHT;
    if (!room) return;
    camera.position.x = THREE.MathUtils.clamp(
      camera.position.x, room.min.x + WALL_MARGIN, room.max.x - WALL_MARGIN,
    );
    camera.position.z = THREE.MathUtils.clamp(
      camera.position.z, room.min.z + WALL_MARGIN, room.max.z - WALL_MARGIN,
    );
  }

  // --- switching -----------------------------------------------------------
  const LABELS = {
    [CAMERA_MODE.ORBIT]: '[1] orbit -- drag to orbit, WASD to pan',
    [CAMERA_MODE.WALK]: '[2] walk -- WASD to move, shift to run, drag to look',
    [CAMERA_MODE.LOOK]: '[3] look -- drag to look, scroll to zoom',
  };

  function setMode(next) {
    if (next === mode) return;
    mode = next;
    // OrbitControls is the only mode that may touch the camera itself; the
    // other two would fight its update() for the transform.
    controls.enabled = mode === CAMERA_MODE.ORBIT;
    velocity.set(0, 0, 0);
    looking = null;

    // The zoom belongs to the two first-person modes; orbit uses its normal lens.
    if (mode === CAMERA_MODE.ORBIT && camera.fov !== baseFov) {
      camera.fov = baseFov;
      camera.updateProjectionMatrix();
    }

    if (mode === CAMERA_MODE.WALK) {
      // Stand up wherever you were floating, keeping the heading.
      readLookFromCamera();
      clampToFloor();
      applyLook();
    } else if (mode === CAMERA_MODE.LOOK) {
      if (room) room.getCenter(_centre);
      else _centre.set(0, 0, 0);
      camera.position.set(_centre.x, floorY() + EYE_HEIGHT, _centre.z);
      camera.lookAt(FOCUS);
      readLookFromCamera();
      applyLook();
    }

    if (indicator) indicator.textContent = `Camera ${LABELS[mode]}`;
  }

  // --- pointer -------------------------------------------------------------
  let looking = null; // pointerId of the drag currently steering the view
  let lastX = 0;
  let lastY = 0;

  dom.addEventListener('pointerdown', (e) => {
    if (mode === CAMERA_MODE.ORBIT) return;
    looking = e.pointerId;
    lastX = e.clientX;
    lastY = e.clientY;
    dom.setPointerCapture(e.pointerId);
    // stopImmediatePropagation, not stopPropagation: the book's own drag
    // handlers are on THIS element too, and only the immediate form stops
    // listeners that share a node.
    e.preventDefault();
    e.stopImmediatePropagation();
  }, { capture: true });

  // On window rather than the canvas so a drag that runs off the edge of the
  // viewport keeps steering until the button comes back up.
  window.addEventListener('pointermove', (e) => {
    if (looking !== e.pointerId) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    // Sensitivity tracks the fov, so zooming in makes the drag finer instead
    // of flinging the view across the room.
    const scale = LOOK_SENSITIVITY * (camera.fov / baseFov);
    const dragDirection = mode === CAMERA_MODE.LOOK ? 1 : -1;
    yaw += dragDirection * dx * scale;
    pitch = THREE.MathUtils.clamp(
      pitch + dragDirection * dy * scale,
      -PITCH_LIMIT,
      PITCH_LIMIT,
    );
    applyLook();
  });

  function endLook(e) {
    if (looking === null || (e && looking !== e.pointerId)) return;
    if (e && dom.hasPointerCapture(e.pointerId)) dom.releasePointerCapture(e.pointerId);
    looking = null;
  }
  window.addEventListener('pointerup', endLook);
  window.addEventListener('pointercancel', endLook);
  window.addEventListener('blur', () => { endLook(null); held.clear(); });

  dom.addEventListener('wheel', (e) => {
    if (mode === CAMERA_MODE.ORBIT) return;
    e.preventDefault();
    e.stopImmediatePropagation(); // bookManipulator wheels the book otherwise
    const fov = camera.fov * (e.deltaY > 0 ? ZOOM_PER_NOTCH : 1 / ZOOM_PER_NOTCH);
    // Never wider than the lens the scene was framed for -- zooming out past
    // it would just fisheye the room.
    camera.fov = THREE.MathUtils.clamp(fov, MIN_FOV, baseFov);
    camera.updateProjectionMatrix();
  }, { capture: true, passive: false });

  // --- keys ----------------------------------------------------------------
  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = e.target instanceof HTMLElement ? e.target.tagName : '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    if (e.key === '1') setMode(CAMERA_MODE.ORBIT);
    else if (e.key === '2') setMode(CAMERA_MODE.WALK);
    else if (e.key === '3') setMode(CAMERA_MODE.LOOK);
    else if (e.key === 'Shift') held.add('shift');
    else if (WALK_KEYS.has(e.key.toLowerCase())) held.add(e.key.toLowerCase());
  });
  window.addEventListener('keyup', (e) => {
    held.delete(e.key === 'Shift' ? 'shift' : e.key.toLowerCase());
  });

  if (indicator) indicator.textContent = `Camera ${LABELS[mode]}`;

  return {
    get mode() { return mode; },
    setMode,

    /**
     * The walkable slab. Pass the floor mesh's world bounds: its min.y is the
     * ground the camera stands on and its footprint is exactly how far you
     * can walk, so nothing here has to restate scene/floor.js's margin.
     */
    setRoom(bounds) {
      room = bounds;
      if (mode !== CAMERA_MODE.ORBIT) clampToFloor();
    },

    update(dt) {
      if (mode === CAMERA_MODE.ORBIT) {
        cameraPan.update(dt);
        return;
      }
      if (mode !== CAMERA_MODE.WALK) return;

      // Heading only -- looking down at the floor should not walk you into
      // it, so the pitch is dropped and the move stays in the ground plane.
      _forward.set(-Math.sin(yaw), 0, -Math.cos(yaw));
      _right.set(Math.cos(yaw), 0, -Math.sin(yaw));

      const forwardInput = (held.has('w') ? 1 : 0) - (held.has('s') ? 1 : 0);
      const strafeInput = (held.has('d') ? 1 : 0) - (held.has('a') ? 1 : 0);
      _wish.set(0, 0, 0)
        .addScaledVector(_forward, forwardInput)
        .addScaledVector(_right, strafeInput);
      // Normalised so walking a diagonal is not faster than walking straight.
      if (_wish.lengthSq() > 0) {
        _wish.normalize().multiplyScalar(WALK_SPEED * (held.has('shift') ? RUN_MULTIPLIER : 1));
      }

      const response = _wish.lengthSq() > 0 ? WALK_ACCELERATION : WALK_DAMPING;
      velocity.x = THREE.MathUtils.damp(velocity.x, _wish.x, response, dt);
      velocity.z = THREE.MathUtils.damp(velocity.z, _wish.z, response, dt);

      camera.position.addScaledVector(velocity, dt);
      clampToFloor();
      applyLook(); // the orbit handoff target travels with us
    },
  };
}