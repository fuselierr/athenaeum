import * as THREE from 'three';
import { watch, nextTick } from 'vue';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import { HTMLMesh } from 'three/addons/interactive/HTMLMesh.js';
import { InteractiveGroup } from 'three/addons/interactive/InteractiveGroup.js';
import { FURNITURE_SCALE } from '../scene/worldScale.js';
import { isShown } from '../scene/picking.js';
import { settings } from '../state/settings.js';
import { ui } from '../state/ui.js';

/**
 * VR: the room through a headset, with a controller in each hand.
 *
 *   left stick     walk, the way your head faces
 *   right stick    turn, in snaps (comfortable for most people)
 *   grip           take hold: the menu panel, where you are pointing at it,
 *                  to carry it somewhere else; the book, off the desk or out
 *                  of the other hand; a book off the shelf; or -- with the
 *                  book in your other hand -- a page to turn it, or a board
 *                  to swing it
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
 * be typed into without a keyboard. A panel is a PICTURE of the menu, so it
 * has to be drawn again whenever the menu changes: after every press, and
 * from scratch whenever the menu is a different size than the picture was
 * taken at (see openPanel and pointAtMenu). Grip it to carry it somewhere
 * else.
 *
 * OUTSIDE, the post-processing chain cannot run in VR -- it renders into
 * targets of its own, which a headset cannot be shown -- so the clouds and the
 * exposure are done another way there (scene/outside/outdoorPost.js's
 * renderXR). The height fog and the colour grading are left out.
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
// After a press, the panel is redrawn again at each of these, seconds later:
// what a press changes arrives over several frames -- Vue renders on the next
// tick, the menu's own fade takes a moment, a search comes back later still.
const MENU_PRESS_REDRAWS = [0.05, 0.2, 0.5];
const MENU_SIZE_CHECK = 0.1; // seconds between checking the menu is the size it was drawn at
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
      action: null, // 'hold' | 'page' | 'cover' | 'menu' while the grip is closed on something
      menuHold: null, // where the menu panel sits in this hand, while it carries it
      scrolling: null, // the part of the menu this hand's stick is scrolling
      scrollLeftOver: 0, // the fraction of a pixel it could not scroll yet (scrollMenu)
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
    // And the panel redrawn after each one: a press changes the page it is
    // drawn from, which the panel cannot see happen.
    controller.addEventListener('select', askRedraw);
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
    if (!pages || !isShown(bookGroup)) return false;
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

  /**
   * Close a hand on the menu panel: it is carried wherever that hand goes
   * until the grip opens, turning to face you as it travels. The hold is where
   * the panel sits in the hand's own frame, so it keeps its distance and its
   * place off to the side rather than snapping into the hand.
   */
  function takeHoldOfMenu(hand) {
    hand.menuHold = hand.controller.worldToLocal(panel.mesh.position.clone());
    hand.action = 'menu';
    pulse(hand, 0.3, 30);
  }

  function moveMenu(hand) {
    if (!panel || !hand.menuHold) return;
    hand.controller.localToWorld(panel.mesh.position.copy(hand.menuHold));
    readHead();
    panel.mesh.lookAt(_head);
  }

  function onGripDown(hand) {
    const pages = getPages();
    const shelf = getShelfBooks();
    const outside = getOutside();
    handPosition(hand, _hand);

    // The menu, where the hand is pointing at it: take hold and carry it.
    if (panel && hand.pointingAtMenu) {
      takeHoldOfMenu(hand);
      return;
    }

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
    else if (hand.action === 'menu') moveMenu(hand);
  }

  /** Open a hand: let go of whatever it had. */
  function letGo(hand) {
    const action = hand.action;
    hand.action = null;
    // The menu stays where it was let go of; nothing else to put down.
    if (action === 'menu') {
      hand.menuHold = null;
      return;
    }
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
  /**
   * Draw the menu onto a panel. With `pose`, it is put back exactly where the
   * last one was -- which is how a panel is replaced without it appearing to
   * move (see the size check in pointAtMenu).
   */
  function openPanel(pose = null) {
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

    const scale = rig.scale.x;
    mesh.scale.setScalar(scale);
    if (pose) {
      mesh.position.copy(pose.position);
      mesh.quaternion.copy(pose.quaternion);
    } else {
      // In front of you, a little below your eyes, upright and facing you.
      rig.updateMatrixWorld(true);
      readHead();
      camera.getWorldDirection(_forward);
      _forward.y = 0;
      if (_forward.lengthSq() < 1e-6) _forward.set(0, 0, -1);
      _forward.normalize();
      mesh.position.copy(_head).addScaledVector(_forward, MENU_DISTANCE * scale);
      mesh.position.y -= MENU_DROP * scale;
      mesh.lookAt(_head.x, mesh.position.y, _head.z);
    }

    menuGroup.add(mesh);
    // The size the menu was when it was drawn. Its texture is that size for
    // good -- a texture cannot grow in place -- so a menu that is a different
    // size now needs a new panel rather than a redraw. Rounded down, as a
    // canvas's own width is.
    const drawn = mesh.material.map.image;
    panel = {
      mesh,
      backing,
      element,
      width: drawn.width,
      height: drawn.height,
      sizeWait: MENU_SIZE_CHECK,
      redraws: [],
    };
  }

  /** Draw the menu again shortly, and again after that: something was pressed. */
  function askRedraw() {
    if (panel) panel.redraws = MENU_PRESS_REDRAWS.slice();
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

  /**
   * The part of the menu under a point on the panel that can be scrolled. The
   * panel is a picture of a page that is still laid out on screen, so the page
   * itself is asked what is at that point -- which finds a tab's own list as
   * readily as the menu's body, the body being the fallback.
   */
  function scrollerUnder(uv) {
    const rect = panel.element.getBoundingClientRect();
    const x = rect.left + uv.x * rect.width;
    const y = rect.top + (1 - uv.y) * rect.height;
    for (let node = document.elementFromPoint(x, y);
      node && panel.element.contains(node);
      node = node.parentElement) {
      const style = getComputedStyle(node);
      if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1) return node;
    }
    return panel.element.querySelector('.menu-body');
  }

  /**
   * Scroll the menu under a hand by `by` pixels, and say whether it moved.
   *
   * A browser keeps scrollTop in WHOLE pixels, so whatever is left over is
   * carried to the next frame: without that, a gentle push -- less than a
   * pixel in a frame -- rounds away to nothing every frame and the menu never
   * moves at all. Kept per hand, and dropped when the pointer moves to another
   * list, so a leftover from one cannot jump another.
   */
  function scrollMenu(hand, uv, by) {
    const scroller = scrollerUnder(uv);
    if (!scroller) return false;
    if (hand.scrolling !== scroller) {
      hand.scrolling = scroller;
      hand.scrollLeftOver = 0;
    }
    const limit = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const before = scroller.scrollTop;
    const wanted = THREE.MathUtils.clamp(before + by + hand.scrollLeftOver, 0, limit);
    scroller.scrollTop = wanted;
    // What the rounding swallowed, for the next frame. Never more than a
    // pixel: at the top or the bottom there is nowhere for it to go.
    hand.scrollLeftOver = THREE.MathUtils.clamp(wanted - scroller.scrollTop, -1, 1);
    return scroller.scrollTop !== before;
  }

  /**
   * The menu panel each frame: kept the size the menu is, redrawn after a
   * press, the lasers, and scrolling with the stick of a hand pointing at it.
   */
  function pointAtMenu(dt) {
    if (panel) {
      // The menu rises into place as it opens, and can change size with the
      // window; the panel is made again at whatever size it is now, in the
      // same place. Without this, every later redraw is silently dropped --
      // which is why the menu had to be closed and reopened to show a press.
      panel.sizeWait -= dt;
      if (panel.sizeWait <= 0) {
        panel.sizeWait = MENU_SIZE_CHECK;
        const element = document.querySelector('#menu .menu');
        const rect = element?.getBoundingClientRect();
        if (element && (element !== panel.element
          || Math.floor(rect.width) !== panel.width
          || Math.floor(rect.height) !== panel.height)) {
          openPanel({ position: panel.mesh.position.clone(), quaternion: panel.mesh.quaternion.clone() });
        }
      }
    }
    if (panel) {
      for (let i = panel.redraws.length - 1; i >= 0; i--) {
        panel.redraws[i] -= dt;
        if (panel.redraws[i] > 0) continue;
        panel.redraws.splice(i, 1);
        redrawPending = true;
        redrawWait = 0;
      }
    }

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
      if (!hit) hand.scrolling = null;
      const scroll = hit ? stick(hand).y : 0;
      // Scrolling changes nothing the panel's own observer watches, so a
      // scroll that moved asks for the redraw itself (below).
      if (scroll && scrollMenu(hand, hit.uv, scroll * MENU_SCROLL_SPEED * dt)) redrawPending = true;
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

    /**
     * What VR puts in front of your face rather than in the room: the
     * controllers, and the menu panel. Outside meters its exposure off the
     * room, not off these (scene/outside/outdoorPost.js's renderXR).
     */
    get overlay() { return [rig, menuGroup]; },

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
