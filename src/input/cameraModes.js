import * as THREE from 'three';
import { isBound, matches } from '../state/keybindings.js';
import { settings } from '../state/settings.js';

/**
 * The three ways of moving the camera, switched with the 1 / 2 / 3 keys.
 *
 *   1  ORBIT  the original rig -- OrbitControls with WASD panning. A table
 *             view: you circle the book rather than standing anywhere.
 *   2  WALK   first person, and the mode the app starts in. WASD walks
 *             across the floor at eye height, dragging looks around.
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
 * THE BOOK COMES FIRST. In walk and look modes a drag looks around -- but
 * only a drag the book did not want. Pressing a cover, a page, or the pile
 * of pages waiting to be lifted still does what it does in orbit mode, and
 * only a press that lands on nothing of the book's turns into looking.
 * See the pointerdown listeners below.
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

// The movement actions, held as ids rather than key codes so a rebind
// takes effect immediately and nothing has to be re-registered.
const MOVE_ACTIONS = ['move.forward', 'move.back', 'move.left', 'move.right', 'move.run'];

// How far a press may travel and still count as a click rather than a drag.
// Exported so a drag that has to tell the two apart itself (dragPageTurn)
// draws the line in the same place.
export const CLICK_SLOP = 4; // px

/**
 * @param {object} opts
 * @param {THREE.PerspectiveCamera} opts.camera
 * @param {THREE.WebGLRenderer} opts.renderer
 * @param {object} opts.controls  OrbitControls
 * @param {{update(dt: number): void}} opts.cameraPan  ticked in ORBIT only
 * @param {HTMLElement|null} [opts.indicator]  optional readout of the mode
 * @param {((event: PointerEvent) => void)|null} [opts.onClick]  a press that
 *   did not travel. Reported from here because the look modes swallow
 *   pointerdown on the canvas outright -- nothing downstream would ever see
 *   the click -- and because the rig is the one thing that already knows
 *   whether a gesture turned into a drag. Presses the book claimed count
 *   too: a press on a page or a cover that never moved was a click on the
 *   book, and the handler decides what was nearest.
 *
 * IMPORTANT: construct this BEFORE dragCover / dragPageTurn /
 * bookManipulator. All four listen for pointerdown on the same canvas, and
 * listeners on one element fire in registration order -- being first is what
 * lets a look-drag swallow the gesture so it does not also turn a page.
 */
export function createCameraModes({
  camera, renderer, controls, cameraPan,
  indicator = document.getElementById('camera-mode'),
  onClick = null,
}) {
  const dom = renderer.domElement;
  // The fov the scene is framed at, which the look modes zoom in FROM and
  // never back past -- a setting now, so read rather than captured.
  const baseFov = () => settings.camera.fov;

  // Constructed in orbit even though walk is the default: walking needs the
  // room's floor, which does not exist yet. main.js switches to WALK as soon
  // as setRoom() has been given it.
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
    if (mode === CAMERA_MODE.ORBIT && camera.fov !== baseFov()) {
      camera.fov = baseFov();
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

  // The press being watched to see whether it becomes a click or a drag.
  // Tracked in EVERY mode, including ORBIT, where the gesture itself
  // belongs to OrbitControls and only the verdict is ours.
  let pressId = null;
  let pressX = 0;
  let pressY = 0;
  let pressMoved = false;

  // Registered before anything else on the canvas (see main.js), and it
  // claims nothing. It makes sure OrbitControls is OFF outside orbit mode
  // before any press is handled: the book's drag handlers switch
  // OrbitControls off while they hold a press and back ON when they let go,
  // which is right in orbit mode and wrong in these -- left on, the next
  // press would orbit the camera out from under the look rig.
  //
  // And it is where every press starts being watched for a click. It has to
  // be here, first in the capture phase: the book's handlers stop the press
  // they take (dragCover with stopImmediatePropagation, dragPageTurn with
  // stopPropagation), and stopping it during capture at the canvas also
  // cancels the canvas's own bubble listeners -- so the one below never
  // hears a press on a page or a cover at all. A press the book took and
  // then never moved is a click ON the book, which is how the book is taken
  // up to read (input/bookCarry.js), so it has to be reported like any
  // other. onClick asks what is nearest under the cursor, so a click on a
  // page cannot fall through to the desk behind it.
  dom.addEventListener('pointerdown', (e) => {
    if (mode !== CAMERA_MODE.ORBIT) controls.enabled = false;
    pressId = e.pointerId;
    pressX = e.clientX;
    pressY = e.clientY;
    pressMoved = false;
  }, { capture: true });

  // THE BOOK GOES FIRST. A press is only this rig's if nothing on the book
  // wanted it, so this listens in the BUBBLE phase, after every capture
  // listener on the canvas has had its turn, instead of grabbing the press
  // up front. The book's handlers mark a press as theirs with
  // preventDefault(): dragCover (a board, or a spread waiting to be lifted)
  // and dragPageTurn (a page) both do, and bookManipulator's shift-drag
  // slide stops the press before it ever reaches the canvas.
  dom.addEventListener('pointerdown', (e) => {
    if (e.defaultPrevented) return; // the book's to drag, not ours to look with

    // The primary button only: right-drag is bookManipulator's turn-the-
    // book gesture, and should not also swing the view round.
    if (mode === CAMERA_MODE.ORBIT || e.button !== 0) return;
    looking = e.pointerId;
    lastX = e.clientX;
    lastY = e.clientY;
    // Captured, so a look that runs off the canvas keeps steering.
    dom.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  // On window rather than the canvas so a drag that runs off the edge of the
  // viewport keeps steering until the button comes back up.
  window.addEventListener('pointermove', (e) => {
    if (pressId === e.pointerId && !pressMoved
      && Math.hypot(e.clientX - pressX, e.clientY - pressY) > CLICK_SLOP) {
      pressMoved = true;
    }
    if (looking !== e.pointerId) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    // Sensitivity tracks the fov, so zooming in makes the drag finer instead
    // of flinging the view across the room.
    // The user's own multiplier rides on top of the fov term.
    const scale = LOOK_SENSITIVITY * settings.camera.lookSensitivity * (camera.fov / baseFov());
    const dragDirection = mode === CAMERA_MODE.LOOK ? 1 : -1;
    const vertical = settings.camera.invertY ? -dy : dy;
    yaw += dragDirection * dx * scale;
    pitch = THREE.MathUtils.clamp(
      pitch + dragDirection * vertical * scale,
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
  window.addEventListener('pointerup', (e) => {
    if (pressId === e.pointerId) {
      if (!pressMoved && e.button === 0 && onClick) onClick(e);
      pressId = null;
    }
    endLook(e);
  });
  window.addEventListener('pointercancel', (e) => {
    if (pressId === e.pointerId) pressId = null;
    endLook(e);
  });
  window.addEventListener('blur', () => { endLook(null); held.clear(); });

  dom.addEventListener('wheel', (e) => {
    if (mode === CAMERA_MODE.ORBIT) return;
    e.preventDefault();
    e.stopImmediatePropagation(); // bookManipulator wheels the book otherwise
    const fov = camera.fov * (e.deltaY > 0 ? ZOOM_PER_NOTCH : 1 / ZOOM_PER_NOTCH);
    // Never wider than the lens the scene was framed for -- zooming out past
    // it would just fisheye the room.
    camera.fov = THREE.MathUtils.clamp(fov, MIN_FOV, baseFov());
    camera.updateProjectionMatrix();
  }, { capture: true, passive: false });

  // --- keys ----------------------------------------------------------------
  window.addEventListener('keydown', (e) => {
    if (matches('camera.orbit', e)) setMode(CAMERA_MODE.ORBIT);
    else if (matches('camera.walk', e)) setMode(CAMERA_MODE.WALK);
    else if (matches('camera.look', e)) setMode(CAMERA_MODE.LOOK);
    for (const action of MOVE_ACTIONS) if (matches(action, e)) held.add(action);
  });
  // Release is matched on the raw code, without the guards `matches`
  // applies: a key let go after the menu opened, or after focus moved into
  // a field, still has to stop the walking it started.
  window.addEventListener('keyup', (e) => {
    for (const action of MOVE_ACTIONS) if (isBound(action, e.code)) held.delete(action);
  });

  if (indicator) indicator.textContent = `Camera ${LABELS[mode]}`;

  return {
    get mode() { return mode; },
    setMode,

    /**
     * Turn to face a world point without moving. Only in the two first-
     * person modes, where yaw and pitch own the view; in orbit the view is
     * wherever OrbitControls' target is, so this leaves it alone.
     */
    lookAt(point) {
      if (mode === CAMERA_MODE.ORBIT) return;
      camera.lookAt(point);
      readLookFromCamera();
      applyLook();
    },

    /**
     * Stand on a spot on the floor, at eye height, still facing the same
     * way. Walk mode only: look mode has its one fixed spot in the middle of
     * the room, and orbit does not stand anywhere.
     */
    standAt(x, z) {
      if (mode !== CAMERA_MODE.WALK) return;
      camera.position.x = x;
      camera.position.z = z;
      velocity.set(0, 0, 0);
      clampToFloor();
      applyLook();
    },

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
      // Every frame as well as on each press: a book drag that ends
      // re-enables OrbitControls, and the wheel and keys reach it without
      // any press at all. Outside orbit mode it stays off, whatever a drag
      // handler last did to it.
      controls.enabled = false;
      if (mode !== CAMERA_MODE.WALK) return;

      // Heading only -- looking down at the floor should not walk you into
      // it, so the pitch is dropped and the move stays in the ground plane.
      _forward.set(-Math.sin(yaw), 0, -Math.cos(yaw));
      _right.set(Math.cos(yaw), 0, -Math.sin(yaw));

      const forwardInput = (held.has('move.forward') ? 1 : 0) - (held.has('move.back') ? 1 : 0);
      const strafeInput = (held.has('move.right') ? 1 : 0) - (held.has('move.left') ? 1 : 0);
      _wish.set(0, 0, 0)
        .addScaledVector(_forward, forwardInput)
        .addScaledVector(_right, strafeInput);
      // Normalised so walking a diagonal is not faster than walking straight.
      if (_wish.lengthSq() > 0) {
        _wish.normalize().multiplyScalar(
          WALK_SPEED * (held.has('move.run') ? RUN_MULTIPLIER : 1),
        );
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