import * as THREE from 'three';
import { watch, nextTick } from 'vue';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import { HTMLMesh } from 'three/addons/interactive/HTMLMesh.js';
import { InteractiveGroup } from 'three/addons/interactive/InteractiveGroup.js';
import { FURNITURE_SCALE } from '../scene/worldScale.js';
import { settings } from '../state/settings.js';
import { ui } from '../state/ui.js';

/**
 * VR: the room through a headset, with a controller in each hand.
 *
 *   left stick     walk, the way your head faces
 *   right stick    turn, in snaps (comfortable for most people)
 *   grip           take hold: the book, off the desk or out of the other
 *                  hand; a book off the shelf; or -- with the book in your
 *                  other hand -- a page to turn it, or a board to swing it
 *   let go         the book drops, and lands wherever it falls -- or, let go
 *                  of close to its slot, a shelf book goes back in
 *   Y (left)       the menu, on a panel in front of you
 *   trigger        press what the pointer is on, on that panel; the stick
 *                  of the hand pointing at it scrolls
 *
 * THE RIG. WebXR poses the camera itself, relative to its parent, every
 * frame -- so moving through the room cannot be done by moving the camera.
 * The camera and both controllers ride on a rig instead, and walking and
 * turning move the rig. Outside VR the rig sits at the origin, unscaled,
 * and the desktop camera modes (cameraModes.js) work on the camera exactly
 * as they always have. Going in, the rig is put where the desktop camera was
 * standing, facing the same way; coming out, the camera is put where your
 * head was, and the desktop modes take up from there.
 *
 * SCALE. The rig is scaled with the furniture (scene/worldScale.js's
 * FURNITURE_SCALE), so a desk is at a desk's height and a book is a book's
 * size in your hand whatever that is set to -- at 1, everything is true size.
 *
 * HOLDING. A held book rides the hand it is in, exactly where it was when
 * you closed your grip -- no flying up to a reading pose, as a click does on
 * the desktop -- through the same carry the desktop uses (bookCarry.js), so
 * its pages still feel down as though it lay flat, and letting go hands it
 * to the book's physics, which carries on with however the hand was moving.
 * A shelf model is held the same way (shelfBooks.js), and the real book
 * that replaces it once its pages are ready stays in that same hand.
 *
 * TURNING PAGES. The pages and boards take the hand's swing about the spine
 * (dragPageTurn.js, dragCover.js): close your grip on the right-hand page
 * and carry your hand over to the left, and the leaf goes with it. Let go
 * past half-way and it lands; short of that it falls back.
 *
 * THE MENU is the desktop's own (ui/menu), drawn onto a panel with three's
 * HTMLMesh and pressed through InteractiveGroup -- so every tab works the
 * same, and nothing about the menu has to know about VR. Text fields cannot
 * be typed into without a keyboard.
 *
 * OUTSIDE, the post-processing is left out while in VR (see
 * scene/outside/outside.js's render): the chain renders into targets of its
 * own, which a headset cannot be shown.
 */

// The player is scaled with the world. See SCALE above.
const VR_SCALE = FURNITURE_SCALE;

// Walking, in world units a second -- the desktop's own pace (cameraModes.js).
const WALK_SPEED = 1.4;
const STICK_DEADZONE = 0.15;

// Snap turning: how far each turn goes, how far the stick has to be pushed
// to make one, and how far back it has to come before it will make another.
const SNAP_TURN = Math.PI / 6;
const SNAP_PUSH = 0.7;
const SNAP_REARM = 0.3;

// Reaches, in metres as you feel them in the headset (scaled by the rig).
const BOOK_GRAB_MARGIN = 0.06; // how far outside the book a hand can be and still take it
const PART_REACH = 0.07; // how far off a page or board a hand can take hold of it
const SHELF_REACH = 0.07; // how near a shelf book a hand has to be to take it
const SHELF_RETURN_REACH = 0.35; // let go of a shelf book this near its slot and it goes back in

// The menu panel: how far in front of you it opens, and how far below eye level.
const MENU_DISTANCE = 0.75;
const MENU_DROP = 0.15;
const MENU_SCROLL_SPEED = 900; // CSS pixels a second, at full stick
const MENU_REDRAW_INTERVAL = 0.05; // seconds between redraws while scrolling
const LASER_LENGTH = 1.5; // metres, when the pointer is on nothing

// The xr-standard gamepad layout.
const BUTTON = { TRIGGER: 0, SQUEEZE: 1, STICK: 3, X_A: 4, Y_B: 5 };

const UP = new THREE.Vector3(0, 1, 0);
const NO_STICK = Object.freeze({ x: 0, y: 0 });

/**
 * @param {object} opts
 * @param {THREE.WebGLRenderer} opts.renderer
 * @param {THREE.Scene} opts.scene
 * @param {THREE.PerspectiveCamera} opts.camera  put on the rig here
 * @param {object} opts.cameraModes  input/cameraModes.js: the ground, and the
 *   desktop view to hand back to
 * @param {THREE.Group} opts.bookGroup
 * @param {() => object} opts.getPages
 * @param {object} opts.bookCarry  input/bookCarry.js
 * @param {object} opts.dragCover  book/reader/dragCover.js
 * @param {object} opts.dragPageTurn  book/reader/dragPageTurn.js
 * @param {() => object|null} opts.getShelfBooks  scene/inside/shelfBooks.js, once loaded
 * @param {() => object|null} opts.getOutside  scene/outside/outside.js
 */
export function createVRControls({
  renderer, scene, camera, cameraModes, bookGroup, getPages,
  bookCarry, dragCover, dragPageTurn, getShelfBooks, getOutside,
}) {
  const xr = renderer.xr;
  xr.enabled = true;
  xr.setReferenceSpaceType('local-floor');

  const rig = new THREE.Group();
  rig.name = 'xrRig';
  rig.add(camera);
  scene.add(rig);

  const listeners = new Set();
  const notify = (presenting) => { for (const listener of listeners) listener(presenting); };

  const _head = new THREE.Vector3();
  const _hand = new THREE.Vector3();
  const _forward = new THREE.Vector3();
  const _right = new THREE.Vector3();
  const _step = new THREE.Vector3();
  const _offset = new THREE.Vector3();
  const _clamped = new THREE.Vector3();
  const _centre = new THREE.Vector3();
  const _normal = new THREE.Vector3();
  const _origin = new THREE.Vector3();
  const _quaternion = new THREE.Quaternion();
  const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
  const _ray = new THREE.Raycaster();

  /** A length in metres as the player feels it, in world units. */
  const reach = (metres) => metres * rig.scale.x;

  // --- the menu panel ------------------------------------------------------------
  const menuGroup = new InteractiveGroup();
  menuGroup.name = 'vrMenu';
  scene.add(menuGroup);
  let panel = null; // { mesh, backing, element } while the menu is open in VR
  let redrawPending = false;
  let redrawWait = 0;

  // --- the hands -----------------------------------------------------------------
  const modelFactory = new XRControllerModelFactory();
  const hands = [0, 1].map((index) => {
    // Pointing (the target ray) and holding (the grip) are two different
    // poses: a ray comes out of the front of the controller, and a grip is
    // where the hand closes round it.
    const controller = xr.getController(index);
    const grip = xr.getControllerGrip(index);
    grip.add(modelFactory.createControllerModel(grip));

    const laser = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]),
      new THREE.LineBasicMaterial({ color: 0xffb070, transparent: true, opacity: 0.85 }),
    );
    laser.visible = false;
    controller.add(laser);
    rig.add(controller, grip);

    const hand = {
      controller,
      grip,
      laser,
      source: null, // the XRInputSource, while connected
      previous: [], // each button's pressed state last frame
      action: null, // 'hold' | 'page' | 'cover' while the grip is closed on something
      snapArmed: true,
      pointingAtMenu: false,
    };
    controller.addEventListener('connected', (event) => {
      hand.source = event.data;
      hand.previous = [];
    });
    controller.addEventListener('disconnected', () => {
      letGo(hand);
      hand.source = null;
    });
    // The trigger's select events, turned into clicks on the menu panel.
    menuGroup.listenToXRControllerEvents(controller);
    return hand;
  });

  const handed = (side) => hands.find((hand) => hand.source?.handedness === side) ?? null;

  /** What a hand holds with: its grip, or -- untracked -- its pointer. */
  const holder = (hand) => (hand.grip.visible ? hand.grip : hand.controller);
  const isHolder = (hand, object) => Boolean(object) && (object === hand.grip || object === hand.controller);
  const holdsBook = (hand) => isHolder(hand, bookCarry.hand);

  function handPosition(hand, out) {
    return holder(hand).getWorldPosition(out);
  }

  function stick(hand) {
    const axes = hand?.source?.gamepad?.axes;
    if (!axes) return NO_STICK;
    // xr-standard puts the thumbstick on axes 2 and 3; a pad with only two
    // axes has it on the first pair.
    const x = (axes.length >= 4 ? axes[2] : axes[0]) ?? 0;
    const y = (axes.length >= 4 ? axes[3] : axes[1]) ?? 0;
    return {
      x: Math.abs(x) > STICK_DEADZONE ? x : 0,
      y: Math.abs(y) > STICK_DEADZONE ? y : 0,
    };
  }

  /** 'down' or 'up' on the frame a button changes, otherwise null. Once a frame per button. */
  function edge(hand, button) {
    const now = Boolean(hand.source?.gamepad?.buttons?.[button]?.pressed);
    const was = Boolean(hand.previous[button]);
    hand.previous[button] = now;
    if (now === was) return null;
    return now ? 'down' : 'up';
  }

  function pulse(hand, intensity = 0.5, milliseconds = 40) {
    try {
      hand.source?.gamepad?.hapticActuators?.[0]?.pulse?.(intensity, milliseconds)?.catch?.(() => {});
    } catch {
      // No haptics; nothing to feel.
    }
  }

  function shown(object) {
    for (let o = object; o; o = o.parent) if (!o.visible) return false;
    return true;
  }

  // --- walking and turning -------------------------------------------------------
  function readHead() {
    return camera.getWorldPosition(_head);
  }

  /** Swing the rig about your head, so turning does not also move you. */
  function turnAboutHead(angle) {
    _offset.copy(rig.position).sub(_head).applyAxisAngle(UP, angle);
    rig.position.copy(_head).add(_offset);
    rig.rotateY(angle);
  }

  function locomote(dt) {
    const left = handed('left');
    const right = handed('right');
    rig.updateMatrixWorld(true);
    readHead();

    // A stick pointed at the menu scrolls it instead (pointAtMenu).
    const move = left && !left.pointingAtMenu ? stick(left) : NO_STICK;
    if (move.x || move.y) {
      // Along the ground, the way the head faces.
      camera.getWorldDirection(_forward);
      _forward.y = 0;
      if (_forward.lengthSq() < 1e-6) _forward.set(0, 0, -1).applyQuaternion(rig.quaternion).setY(0);
      _forward.normalize();
      _right.crossVectors(_forward, UP);
      _step.set(0, 0, 0).addScaledVector(_forward, -move.y).addScaledVector(_right, move.x);
      if (_step.lengthSq() > 1) _step.normalize();
      rig.position.addScaledVector(_step, WALK_SPEED * dt);
    }

    if (right) {
      const turn = right.pointingAtMenu ? 0 : stick(right).x;
      if (Math.abs(turn) > SNAP_PUSH && right.snapArmed) {
        rig.updateMatrixWorld(true);
        readHead();
        turnAboutHead(-Math.sign(turn) * SNAP_TURN);
        right.snapArmed = false;
      } else if (Math.abs(turn) < SNAP_REARM) {
        right.snapArmed = true;
      }
    }

    // Your head kept over ground you may walk on -- the room's floor, or the
    // terrain outside -- and the rig's floor put under it. Every frame, not
    // only while the stick is held: stepping out of bounds in your real room
    // is walking out of bounds too.
    rig.updateMatrixWorld(true);
    readHead();
    _clamped.copy(_head);
    cameraModes.clampToWalkable(_clamped);
    rig.position.x += _clamped.x - _head.x;
    rig.position.z += _clamped.z - _head.z;
    rig.position.y = cameraModes.groundHeightAt(_clamped.x, _clamped.z);
    rig.updateMatrixWorld(true);
  }

  // --- taking hold ---------------------------------------------------------------
  /** Is the book near enough this point to take? */
  function bookWithinReach(pages, point) {
    if (!pages || !shown(bookGroup)) return false;
    const frame = pages.readingFrame(_centre);
    bookGroup.updateWorldMatrix(true, false);
    bookGroup.localToWorld(_centre);
    const radius = 0.6 * Math.max(frame.width, frame.height) * bookGroup.scale.x + reach(BOOK_GRAB_MARGIN);
    return _centre.distanceTo(point) <= radius;
  }

  /**
   * Which part of the book a hand is on, if any: 'H1' / 'H2' for a board,
   * 'A' to 'D' for a page. Tested along the pages' own normal through the
   * hand -- a hand resting on or just above a page -- and along where the
   * controller points.
   */
  function partUnder(pages, point, hand) {
    const hardcover = pages.hardcover;
    const slots = new Map([
      [hardcover?.H1, 'H1'], [hardcover?.H2, 'H2'],
      [pages.pageMeshes.A, 'A'], [pages.pageMeshes.D, 'D'],
      [pages.pageMeshes.B, 'B'], [pages.pageMeshes.C, 'C'],
    ]);
    const targets = [...slots.keys()].filter((mesh) => mesh?.visible);
    if (!targets.length) return null;
    const far = reach(PART_REACH);

    let best = null;
    _normal.set(0, 1, 0).transformDirection(pages.root.matrixWorld);
    _origin.copy(point).addScaledVector(_normal, -far);
    _ray.set(_origin, _normal);
    _ray.near = 0;
    _ray.far = far * 2;
    for (const hit of _ray.intersectObjects(targets, false)) {
      const off = Math.abs(hit.distance - far);
      if (!best || off < best.off) best = { off, object: hit.object };
    }

    _ray.setFromXRController(hand.controller);
    _ray.near = 0;
    _ray.far = far * 2;
    const pointed = _ray.intersectObjects(targets, false)[0];
    if (pointed && (!best || pointed.distance < best.off)) best = { off: pointed.distance, object: pointed.object };

    return best ? slots.get(best.object) ?? null : null;
  }

  /** Close a hand on a page or a board of the book in the other hand. */
  function takeHoldOfPart(hand, pages, point) {
    const part = partUnder(pages, point, hand);
    if (!part) return false;
    if (part === 'H1' || part === 'H2') {
      if (!dragCover.grabBoard(part, point)) return false;
      hand.action = 'cover';
    } else if (pages.openState.needs === 'spread') {
      // A board open, and its half of the pages still over on the other
      // side: any page lifts that half across, as a click-drag does.
      if (!dragCover.grabSpread(point)) return false;
      hand.action = 'cover';
    } else if (part === 'B' || part === 'C') {
      if (!dragPageTurn.grabPage(part, point)) return false;
      hand.action = 'page';
    } else {
      return false;
    }
    pulse(hand, 0.3, 30);
    return true;
  }

  function onGripDown(hand) {
    const pages = getPages();
    const shelf = getShelfBooks();
    const outside = getOutside();
    handPosition(hand, _hand);

    // The book in your other hand: this one turns its pages and swings its boards.
    if (bookCarry.hand && !holdsBook(hand) && pages && takeHoldOfPart(hand, pages, _hand)) return;

    // The book itself: off the desk, or across from the other hand.
    if (!holdsBook(hand) && bookWithinReach(pages, _hand)) {
      if (bookCarry.hand) bookCarry.holdIn(holder(hand));
      else if (!bookCarry.grabWith(holder(hand))) return;
      hand.action = 'hold';
      pulse(hand);
      return;
    }

    // A book off the shelf.
    if (!outside?.outside && shelf?.grabNear(_hand, holder(hand), reach(SHELF_REACH))) {
      hand.action = 'hold';
      pulse(hand);
    }
  }

  function whileGripped(hand) {
    if (hand.action === 'page') dragPageTurn.movePageGrab(handPosition(hand, _hand));
    else if (hand.action === 'cover') dragCover.moveHand(handPosition(hand, _hand));
  }

  /** Open a hand: let go of whatever it had. */
  function letGo(hand) {
    const action = hand.action;
    hand.action = null;
    if (action === 'page') dragPageTurn.releasePage();
    else if (action === 'cover') dragCover.release();

    const shelf = getShelfBooks();
    // A model still waiting for its pages goes back to its slot.
    if (shelf && isHolder(hand, shelf.heldHand)) shelf.release();

    if (holdsBook(hand)) {
      handPosition(hand, _hand);
      // A shelf book let go of by its own slot goes back in; anything else falls.
      if (bookCarry.homeIsShelf && _hand.distanceTo(bookCarry.home) <= reach(SHELF_RETURN_REACH)) {
        bookCarry.putBack();
      } else {
        bookCarry.letGo();
      }
    }
  }

  // --- the menu ------------------------------------------------------------------
  function openPanel() {
    closePanel();
    const element = document.querySelector('#menu .menu');
    if (!element) return;

    const mesh = new HTMLMesh(element);
    mesh.name = 'vrMenuPanel';
    // The menu's glass is see-through by design, which over a whole room
    // reads as nothing at all -- so a dark card behind it.
    const { width, height } = mesh.geometry.parameters;
    const backing = new THREE.Mesh(
      new THREE.PlaneGeometry(width, height),
      new THREE.MeshBasicMaterial({ color: 0x1a0f1d, transparent: true, opacity: 0.94, toneMapped: false }),
    );
    backing.position.z = -0.002;
    mesh.add(backing);

    // In front of you, a little below your eyes, upright and facing you.
    rig.updateMatrixWorld(true);
    readHead();
    camera.getWorldDirection(_forward);
    _forward.y = 0;
    if (_forward.lengthSq() < 1e-6) _forward.set(0, 0, -1);
    _forward.normalize();
    const scale = rig.scale.x;
    mesh.scale.setScalar(scale);
    mesh.position.copy(_head).addScaledVector(_forward, MENU_DISTANCE * scale);
    mesh.position.y -= MENU_DROP * scale;
    mesh.lookAt(_head.x, mesh.position.y, _head.z);

    menuGroup.add(mesh);
    panel = { mesh, backing, element };
  }

  function closePanel() {
    if (!panel) return;
    menuGroup.remove(panel.mesh);
    panel.mesh.dispose();
    panel.backing.geometry.dispose();
    panel.backing.material.dispose();
    panel = null;
    for (const hand of hands) {
      hand.laser.visible = false;
      hand.pointingAtMenu = false;
    }
  }

  // The menu opens and closes by its own flag, whoever flips it -- Y, or the
  // panel's own close button pressed with a trigger.
  watch(() => ui.menuOpen, (open) => {
    if (!xr.isPresenting) return;
    if (open) nextTick(openPanel);
    else closePanel();
  });

  /** The lasers, and scrolling with the stick of a hand pointing at the menu. */
  function pointAtMenu(dt) {
    for (const hand of hands) {
      hand.pointingAtMenu = false;
      hand.laser.visible = Boolean(panel && hand.source);
      if (!hand.laser.visible) continue;
      _ray.setFromXRController(hand.controller);
      _ray.near = 0;
      _ray.far = Infinity;
      const hit = _ray.intersectObject(panel.mesh, false)[0];
      hand.pointingAtMenu = Boolean(hit);
      // The laser lives in the controller's space, which the rig scales.
      hand.laser.scale.z = (hit ? hit.distance : reach(LASER_LENGTH)) / rig.scale.x;
      const scroll = hit ? stick(hand).y : 0;
      const body = scroll ? panel.element.querySelector('.menu-body') : null;
      if (body) {
        body.scrollTop += scroll * MENU_SCROLL_SPEED * dt;
        redrawPending = true;
      }
    }
    // Scrolling changes nothing the panel's own observer watches, so it is
    // redrawn by hand -- a few times a second, not every frame.
    redrawWait -= dt;
    if (panel && redrawPending && redrawWait <= 0) {
      panel.mesh.material.map.update();
      redrawPending = false;
      redrawWait = MENU_REDRAW_INTERVAL;
    }
  }

  // --- going in and coming out ---------------------------------------------------
  xr.addEventListener('sessionstart', () => {
    // Standing where the desktop camera was, facing the same way.
    camera.updateMatrixWorld();
    camera.getWorldPosition(_head);
    _euler.setFromQuaternion(camera.getWorldQuaternion(_quaternion), 'YXZ');
    rig.position.set(_head.x, cameraModes.groundHeightAt(_head.x, _head.z), _head.z);
    rig.rotation.set(0, _euler.y, 0);
    rig.scale.setScalar(VR_SCALE);
    // From here the headset poses the camera, on the rig.
    camera.position.set(0, 0, 0);
    camera.quaternion.identity();
    rig.updateMatrixWorld(true);
    for (const hand of hands) {
      hand.previous = [];
      hand.action = null;
      hand.snapArmed = true;
    }
    if (ui.menuOpen) nextTick(openPanel);
    notify(true);
  });

  xr.addEventListener('sessionend', () => {
    for (const hand of hands) letGo(hand);
    closePanel();
    // The cursor draws books out again, not wherever the hands last were.
    getShelfBooks()?.setProbes(null);
    // Where your head was, and which way it faced, for the desktop to take up.
    rig.updateMatrixWorld(true);
    camera.getWorldPosition(_head);
    _euler.setFromQuaternion(camera.getWorldQuaternion(_quaternion), 'YXZ');
    const heading = _euler.y;
    rig.position.set(0, 0, 0);
    rig.rotation.set(0, 0, 0);
    rig.scale.setScalar(1);
    camera.position.copy(_head);
    camera.quaternion.setFromEuler(_euler.set(0, heading, 0, 'YXZ'));
    // The headset replaced the lens; put the window's back.
    camera.fov = settings.camera.fov;
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    rig.updateMatrixWorld(true);
    cameraModes.resume();
    notify(false);
  });

  return {
    rig,

    /** Whether a headset is showing the room right now. */
    get presenting() { return xr.isPresenting; },

    /** Start a VR session. Must be called from a click. */
    async enter() {
      if (xr.isPresenting) return;
      if (!navigator.xr) throw new Error('This browser has no WebXR.');
      const session = await navigator.xr.requestSession('immersive-vr', {
        optionalFeatures: ['local-floor', 'bounded-floor', 'layers'],
      });
      await xr.setSession(session);
    },

    /** End the VR session, if there is one. */
    exit() {
      xr.getSession()?.end();
    },

    /** Be told when VR starts (true) and ends (false). Returns an unsubscribe. */
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /**
     * Call every frame while presenting, first thing: it moves the rig, so
     * everything posed from the hands or the head afterwards sees where they
     * are this frame -- and it sets the holds on boards and pages before
     * the book steps.
     */
    update(dt) {
      if (!xr.isPresenting) return;

      const left = handed('left');
      if (left && edge(left, BUTTON.Y_B) === 'down') ui.menuOpen = !ui.menuOpen;

      pointAtMenu(dt);
      locomote(dt);

      for (const hand of hands) {
        const grip = edge(hand, BUTTON.SQUEEZE);
        if (grip === 'down') onGripDown(hand);
        else if (grip === 'up') letGo(hand);
        else if (hand.action) whileGripped(hand);
      }

      // A free hand near the shelf draws out the book it would take, as the
      // cursor does.
      const shelf = getShelfBooks();
      if (shelf) {
        const probes = getOutside()?.outside
          ? []
          : hands.filter((hand) => hand.source && !hand.action).map((hand) => handPosition(hand, new THREE.Vector3()));
        shelf.setProbes(probes, reach(SHELF_REACH) * 2);
      }
    },
  };
}
