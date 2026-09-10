import * as THREE from 'three';
import { createScene } from './scene/createScene.js';
import { loadDesk } from './scene/desk.js';
import { loadLamp } from './scene/lamp.js';
import { loadBookshelf } from './scene/bookshelf.js';
import { addFloor } from './scene/floor.js';
import { addRoom, WINDOW_SILL_PROJECTION } from './scene/room.js';
import { populateShelf } from './scene/shelfBooks.js';
import { PageSimulation } from './book/pageSim/PageSimulation.js';
import { createBookPlacement } from './book/placement/bookPlacement.js';
import {
  setPageDimensions, setSpineGap, spineGapForPageCount,
  setSpineRotation, SPINE_ROTATION, PANEL_REACH as INITIAL_PANEL_REACH,
  HINGE_LEN,
} from './book/pageSim/config.js';
import { updateLocalCorners } from './book/pageSim/math.js';
import { BOOK_WORLD_SCALE } from './scene/worldScale.js';
import { createBookContent, RIGHT_HAND_PANEL, LEFT_HAND_PANEL } from './book/reader/bookContent.js';
import { createDragCover } from './book/reader/dragCover.js';
import { createDragPageTurn } from './book/reader/dragPageTurn.js';
import { createCameraPan } from './input/cameraPan.js';
import { createCameraModes, CAMERA_MODE } from './input/cameraModes.js';
import { createBookManipulator } from './input/bookManipulator.js';
import { createDebugLabels } from './debug/debugLabels.js';
import { createAnglePanel } from './debug/anglePanel.js';
import { initBookLoader, openLibraryBook } from './loader/bookLoader.js';
import { createAudioManager } from './audio/audioManager.js';
import { mountMenu } from './ui/mountMenu.js';
import { bindSettings } from './ui/bindSettings.js';
import { book as bookState } from './state/book.js';
import { matches } from './state/keybindings.js';

// Fixed spine-to-edge reach that the camera, lighting and SPINE_GAP are
// tuned around; a loaded PDF's aspect ratio derives HINGE_LEN from this
// rather than rescaling the whole book.
const BASE_PANEL_REACH = INITIAL_PANEL_REACH;

const { scene, camera, renderer, controls, environment } = await createScene();
const audio = createAudioManager();

// Camera rig first, before anything else claims the canvas: the look
// modes have to see a pointerdown ahead of dragCover / dragPageTurn /
// bookManipulator to be able to swallow it, and capture-phase listeners
// on one element run in registration order.
const cameraPan = createCameraPan({ camera, controls });
// Settings reach the room through exactly one file, and the backdrop is
// loaded here rather than inside createScene: it is a SETTING now, so the
// stored choice is what decides which one the first frame gets.
const scenery = bindSettings({
  audio, camera, renderer, scene, environment,
});
await scenery.setBackground(scenery.initialBackground);

const cameraModes = createCameraModes({
  camera,
  renderer,
  controls,
  cameraPan,
  // Clicks arrive through the rig rather than a listener of the shelf's
  // own: in the look modes it swallows pointerdown on the canvas, so a
  // second listener would never hear one. `shelfBooks` is still loading at
  // this point, hence reading it through the closure.
  onClick: (event) => {
    if (shelfBooks?.handleClick(event)) return;
    putBookDown(event); // a click past the shelf, holding a book
  },
});

// The book hangs under its own group rather than directly under `scene` so
// it can be rotated and slid as a whole (see input/bookManipulator.js)
// without touching PageSimulation.root's own render flip or any physics
// coordinates -- purely an outer, render-only transform.
const bookGroup = new THREE.Group();
// The book's page simulation is authored at its own working scale; this is
// what brings it down to the metric world the desk and lamp live in. See
// scene/worldScale.js for why it is a group scale and not smaller
// constants. Everything under here -- meshes, raycasts, the hinge points
// dragCover/dragPageTurn read through root.matrixWorld -- follows it for
// free; the one thing that does not is the placement physics, which is
// told the scale explicitly.
bookGroup.scale.setScalar(BOOK_WORLD_SCALE);
bookGroup.position.set(0, 0.02, 0); // 2 cm above the desk, so it settles rather than starting flush
scene.add(bookGroup);

// The desk and lamp go straight under `scene`: they are furniture the book
// rests on, so they stay put in world space when the book itself is moved.
// Loaded alongside the page simulation since none of the three waits on
// the others.
const [pagesInstance, desk, , bookshelf] = await Promise.all([
  PageSimulation.create(bookGroup),
  loadDesk(scene),
  // Lamp stays its authored size; only its position follows the desk's
  // 1.5, so it keeps the same spot on a bigger surface.
  loadLamp(scene, { position: new THREE.Vector3(0.33, 0, -0.63) }),
  loadBookshelf(scene),
]);

// --- arrange the room -----------------------------------------------------
// Done here rather than inside the loaders because it is a RELATIONSHIP
// between two models, and neither one can know the other's measurements at
// its own load time. Measured, not hardcoded, so swapping either .glb (or
// changing FURNITURE_SCALE) still lands them correctly.
const GAP_BEHIND_DESK = 3; // metres of clear floor between desk and shelf
// Clear floor past the furniture, on the two sides nothing backs onto.
// Wider than the bare 0.4 the floor used to take, because it is now the
// room you stand in as well as the ground the desk is on -- the walls land
// exactly on this edge.
//
// The other two sides get no margin at all: the shelf backs onto one and
// the desk onto the other, which is what puts them against a wall.
const ROOM_MARGIN = 1.1;
// How far a wall stops short of the furniture standing against it. Not a
// gap -- surfaces that are exactly coplanar z-fight, and a centimetre is
// under the threshold of anyone noticing while being well over the
// threshold of the depth buffer.
const FURNITURE_WALL_CLEARANCE = 0.01;
// How far the window's sill clears the desk top. The desk is against that
// wall, so a sill at the usual height would put the bottom of the opening
// behind it -- this is what keeps the whole window visible above the
// worktop, which is where you want it when you are sitting at it.
const SILL_ABOVE_DESK = 0.12;
// Above the tallest thing in the room. A ceiling that only just clears the
// bookshelf reads as an attic, hence the floor of 3 metres.
const CEILING_CLEARANCE = 0.7;
const MIN_CEILING_HEIGHT = 3;

{
  const deskBox = new THREE.Box3().setFromObject(desk.object);

  // BEHIND IS -X. desk.js rotates the desk by PI/2, so the desk's depth
  // runs along X rather than Z, and the far side from the viewer is its
  // -X edge.
  //
  // Turn the shelf to match before measuring it: at rotationY 0 its front
  // faces +Z (which is why its own default position put it at -Z), and
  // +PI/2 swings that round to +X -- out of the back wall, facing the desk.
  bookshelf.updateMatrixWorld(true);

  const shelfBox = new THREE.Box3().setFromObject(bookshelf);
  const shelfDepth = shelfBox.max.x - shelfBox.min.x;

  // loadBookshelf recentres the model horizontally on its own origin and
  // puts its feet at that origin, so: X places the FRONT face a set gap
  // past the desk's back edge, Y drops the feet to the floor -- NOT 0,
  // which is the desk's TOP surface -- and Z lines it up with the desk.
  bookshelf.position.set(
    deskBox.min.x - GAP_BEHIND_DESK - shelfDepth / 2,
    deskBox.min.y,
    (deskBox.min.z + deskBox.max.z) / 2,
  );
  bookshelf.updateMatrixWorld(true);

  // Measured AFTER the move: this is where the shelf actually ended up, and
  // the back wall is built onto it. The union's min.y is the lowest foot in
  // the room, which is what the floor sits at.
  const placedShelf = new THREE.Box3().setFromObject(bookshelf);
  const room = deskBox.clone().union(placedShelf);

  // The room's footprint. Worked out here rather than left to addFloor's
  // own margin because that margin is uniform and this one deliberately is
  // not -- and because the floor and the walls have to agree on it to the
  // millimetre, the walls being built on the floor's own box.
  const footprint = room.clone();
  footprint.min.z -= ROOM_MARGIN;
  footprint.max.z += ROOM_MARGIN;
  // Both long walls come to meet their furniture instead of standing off
  // it. The back wall goes onto the shelf's own back panel; the window wall
  // comes to the desk, less the depth of the sill -- which overhangs the
  // room, and would otherwise be sitting on the worktop. Taken from the
  // window's own measurements so the two cannot drift apart.
  footprint.min.x = placedShelf.min.x - FURNITURE_WALL_CLEARANCE;
  footprint.max.x = deskBox.max.x + FURNITURE_WALL_CLEARANCE + WINDOW_SILL_PROJECTION;

  const floor = addFloor(scene, footprint, { margin: 0 });
  // The floor IS the walkable area, so the first-person mode takes its
  // bounds from the mesh rather than recomputing them.
  cameraModes.setRoom(new THREE.Box3().setFromObject(floor));

  // Walls and ceiling on that same footprint. The window goes in the wall
  // opposite the bookshelf -- the shelf stands at -X (see above), so the
  // wall the desk is pushed up against is +X, and the window is then
  // directly in front of anyone sitting at it.
  addRoom(scene, floor, {
    height: Math.max(MIN_CEILING_HEIGHT, room.max.y - room.min.y + CEILING_CLEARANCE),
    focus: deskBox.getCenter(new THREE.Vector3()),
    windowSide: '+x',
    // Measured from the floor, which is not y = 0: the desk's TOP is the
    // origin here, and the furniture is scaled, so the drop to the floor is
    // whatever the model says it is rather than a number written down.
    sill: (deskBox.max.y - room.min.y) + SILL_ABOVE_DESK,
  });
}

// After the shelf has been turned and placed: the books measure it in its
// own frame, which needs its final transform to be settled.
// Assigned when the models finish loading; the render loop skips it until
// then rather than blocking the whole scene on scenery.
let shelfBooks = null;
populateShelf(bookshelf, {
  camera,
  renderer,
  // Taking a book off the shelf is what opens it. The conversion is fired
  // and forgotten: `openSequence` inside is what makes a book that was put
  // back mid-render simply never arrive.
  onTake: (record) => {
    if (record) openFromShelf(record);
    else openSequence += 1;
  },
})
  .then((result) => { shelfBooks = result; })
  .catch((err) => console.error('Shelf books failed to load:', err));

// Reassigned by applyPdfDimensions below, so everything downstream takes a
// `getPages` closure rather than capturing the instance.
let pages = pagesInstance;
const getPages = () => pages;

// The book as a whole is a rigid body now: it falls, lands on the desk and
// settles on whichever cover is underneath. bookGroup is its render side --
// driven by the body when the book is loose, and copied INTO the body while
// a gesture is holding it (see bookManipulator's `grabbed`).
const placement = await createBookPlacement({ bookGroup, getPages, desk });

const content = createBookContent(getPages);
// Constructed BEFORE dragPageTurn on purpose: both listen for pointerdown
// in the capture phase on the same canvas, and capture-phase listeners on
// one element fire in registration order. Covers therefore get first look
// and can swallow a gesture that landed on a board before a page turn
// starts on whatever lies behind it.
const dragCover = createDragCover({ getPages, camera, renderer, controls });
const dragPageTurn = createDragPageTurn({
  getPages, camera, renderer, controls, content,
  onPageTurnSound: () => { console.log('onPageTurnSound fired'); audio.playPageTurn(); },
});
const bookManipulator = createBookManipulator({ bookGroup, camera, renderer, getPages });
const debugLabels = createDebugLabels({ scene, camera, renderer, getPages });
const anglePanel = createAnglePanel({ getPages, getPageTurn: () => dragPageTurn });

// --- book loading ---
// HINGE_LEN/PANEL_REACH/SPINE_GAP are baked into physics bodies and
// geometry at construction, so new page dimensions mean rebuilding the
// whole simulation.
// The jacket arrives before the page dimensions do (bookLoader fires
// onJacket straight after conversion, onDimensions only once PDF.js has
// laid out page 1), and applyPdfDimensions throws the whole simulation
// away -- hardcover included -- to rebuild at the new size. So it is kept
// here and re-applied to whichever simulation is current.
let jacket = null;

function applyJacket() {
  if (jacket) pages.setJacket(jacket).catch((err) => console.error('Jacket failed to apply:', err));
}

async function applyPdfDimensions(pageWidthPts, pageHeightPts, pageCount) {
  setPageDimensions(BASE_PANEL_REACH * (pageHeightPts / pageWidthPts), BASE_PANEL_REACH);
  // Thickness comes from the page count -- a short book loads thin, a long
  // one fat. Set before the rebuild, since SPINE_GAP is baked into the
  // cover anchors when the spreads are constructed.
  setSpineGap(spineGapForPageCount(pageCount));
  updateLocalCorners();
  pages.dispose();
  pages = await PageSimulation.create(bookGroup);
  applyJacket();
  refreshFlipLabel();
}

initBookLoader({
  onJacket: (j) => { jacket = j; applyJacket(); },
  onDimensions: applyPdfDimensions,
  onPagesReady: (canvases) => content.setCanvases(canvases),
});

// --- taking a book off the shelf -----------------------------------------
// One book is readable at a time. The shelf hands over a library record, the
// loader converts and renders it, and the finished book takes the model's
// exact place in the hand -- so what you picked up and what you end up
// holding are the same object as far as the eye is concerned.
const bookStatus = document.getElementById('upload-status');
let openSequence = 0; // bumped by anything that abandons a book mid-load
let handHoldsBook = false; // is the real book the thing in the hand?

function setBookStatus(text) {
  if (bookStatus) bookStatus.textContent = text;
  bookState.status = text;
}

async function openFromShelf(record) {
  const token = (openSequence += 1);
  // Chapters come off the shelf with the book: the library listing already
  // carries them, so the Book tab is populated the moment you pick it up
  // rather than when the last page finishes rasterizing.
  bookState.id = record.id;
  bookState.title = record.title;
  bookState.author = record.author;
  bookState.chapters = Array.isArray(record.chapters) ? record.chapters : [];
  bookState.loading = true;
  try {
    await openLibraryBook(record.id, {
      onStatus: setBookStatus,
      onJacket: (j) => {
        if (token !== openSequence) return;
        jacket = j;
        applyJacket();
      },
      onChapters: (chapters) => {
        if (token !== openSequence) return;
        bookState.chapters = chapters;
      },
      onDimensions: async (widthPts, heightPts, pageCount) => {
        if (token !== openSequence) return;
        await applyPdfDimensions(widthPts, heightPts, pageCount);
      },
      onPagesReady: (canvases) => {
        if (token !== openSequence) return; // put back while it was rendering
        content.setCanvases(canvases);
        swapModelForBook();
      },
    });
  } catch (err) {
    console.error('Opening a shelf book failed:', err);
    setBookStatus(`Error: ${err.message}`);
  } finally {
    if (token === openSequence) bookState.loading = false;
  }
}

/**
 * Replace the model in hand with the real book, in the same place and at
 * the same size.
 *
 * SCALE. The book is scaled so its pages are exactly as tall as the model's
 * were. The shelf models are built to the same binding proportions as the
 * readable book (bookModel.js takes its ratios from hardcover.js), so
 * matching that one dimension is enough for the two to read as the same
 * object and for the swap to disappear. That scale then stays: it is a
 * render-only group scale, the page simulation runs in its own units
 * regardless, and the placement colliders are sized from the group -- so a
 * short fat book really is shorter and fatter on the desk afterwards.
 */
function swapModelForBook() {
  const size = shelfBooks?.heldSize;
  if (!size) return;
  pages.reset();
  bookGroup.scale.setScalar(size.length / HINGE_LEN);
  handHoldsBook = shelfBooks.substitute(bookGroup, stowBook);
}

/** The real book has ridden the model's animation back into the shelf. */
function stowBook() {
  handHoldsBook = false;
  // bookGroup was just posed inside the shelf, where the model has this
  // instant reappeared. Moving it here as well as in the body keeps the two
  // from sharing a slot for the one frame before placement drives it again.
  bookGroup.position.copy(RESET_POSITION);
  bookGroup.quaternion.copy(RESET_QUATERNION);
  placement.reset(RESET_POSITION, RESET_QUATERNION);
}

/**
 * Set the held book down where it was clicked, if that was the desk.
 * The model goes back to the shelf; the book stays, and drops the last
 * couple of centimetres under its own weight.
 */
const _placeRay = new THREE.Raycaster();
const _placeNdc = new THREE.Vector2();
const _placePosition = new THREE.Vector3();

function putBookDown(event) {
  if (!handHoldsBook) return;
  const rect = renderer.domElement.getBoundingClientRect();
  _placeNdc.set(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1,
  );
  _placeRay.setFromCamera(_placeNdc, camera);
  const hit = _placeRay.intersectObject(desk.object, true)[0];
  if (!hit) return; // only the desk will take a book

  shelfBooks.putDown();
  handHoldsBook = false;
  _placePosition.copy(hit.point).setY(hit.point.y + 0.02);
  bookGroup.position.copy(_placePosition);
  bookGroup.quaternion.copy(RESET_QUATERNION);
  placement.reset(_placePosition, RESET_QUATERNION);
}

// --- UI ---
const flipBtn = document.getElementById('flipBtn');
const resetBtn = document.getElementById('resetBtn');
const spineRotationInput = document.getElementById('spine-rotation');
const spineRotationValue = document.getElementById('spine-rotation-value');
const spineRotationPanel = document.getElementById('spine-rotation-panel');
let simulationPaused = false;

function refreshSpineRotationLabel() {
  if (spineRotationInput) spineRotationInput.value = String(SPINE_ROTATION);
  if (spineRotationValue) spineRotationValue.textContent = SPINE_ROTATION.toFixed(2);
}

// Touching the slider takes the spine off its own drive (the page block
// asking for a tilt -- PageSimulation.spineRotationTarget) and hands it to
// the pointer; otherwise the next step() would ease straight back to
// whatever the pages want and the slider would look dead. No rebuild: the
// tilt only moves hinge positions, which the next step() picks up.
spineRotationInput?.addEventListener('input', () => {
  pages.setSpineRotationDriven(false);
  setSpineRotation(Number(spineRotationInput.value));
  refreshSpineRotationLabel();
});
refreshSpineRotationLabel();

function refreshFlipLabel() {
  if (flipBtn) flipBtn.textContent = pages.flipped ? 'Flip book back' : 'Flip book over';
}

const RESET_POSITION = new THREE.Vector3(0, 0.02, 0);
const RESET_QUATERNION = new THREE.Quaternion();

function resetBook() {
  pages.reset();
  bookGroup.quaternion.copy(RESET_QUATERNION);
  bookGroup.position.copy(RESET_POSITION); // also undo any shift-drag repositioning
  // The body holds the real placement state -- putting bookGroup back
  // without this would be undone by the next step().
  placement.reset(RESET_POSITION, RESET_QUATERNION);
  bookManipulator.refreshPickupHold();
  refreshFlipLabel();
}

flipBtn?.addEventListener('click', () => { pages.toggleFlip(); refreshFlipLabel(); });
resetBtn?.addEventListener('click', resetBook);
refreshFlipLabel();

window.addEventListener('keydown', (e) => {
  if (matches('debug.pause', e) && anglePanel.visible) {
    simulationPaused = !simulationPaused;
    e.preventDefault();
    return;
  }
  if (matches('book.reset', e)) resetBook();
  if (matches('book.flip', e)) { pages.toggleFlip(); refreshFlipLabel(); }
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault();
    return;
  }
  // Arrow keys play the same physical turn a drag does rather than swapping
  // textures underneath you -- playTurn runs dragPageTurn's own animation
  // and commits through content.commitTurn at the end, so page content, the
  // leaf's two faces and the hinge position all move together exactly as
  // they do for a mouse turn. Forward is the right-hand page, same as
  // dragging it.
  if (matches('book.pageForward', e)) dragPageTurn.playTurn(RIGHT_HAND_PANEL);
  if (matches('book.pageBack', e)) dragPageTurn.playTurn(LEFT_HAND_PANEL);
});

// --- the menu -------------------------------------------------------------
// The tabs get a small set of verbs, not the scene. Everything else they
// need is in the stores (state/), which this file keeps up to date.
mountMenu({
  goToPage: (page) => content.goToPage(page),
  turnPage: (direction) => dragPageTurn.playTurn(
    direction > 0 ? RIGHT_HAND_PANEL : LEFT_HAND_PANEL,
  ),
  setBackground: (id) => scenery.setBackground(id),

  // Escape, innermost meaning first: a book in the hand goes back before
  // the menu will open. Returning true means the press was spent.
  escape: () => {
    if (!shelfBooks?.held) return false;
    shelfBooks.release();
    return true;
  },
});

// --- render loop ---
let lastFrameTime = performance.now();
renderer.setAnimationLoop(() => {
  const now = performance.now();
  const dt = Math.min((now - lastFrameTime) / 1000, 1 / 30);
  lastFrameTime = now;

  if (spineRotationPanel) spineRotationPanel.style.display = anglePanel.visible ? 'block' : 'none';
  // The pages drive the tilt, so the readout has to follow it rather than
  // only updating when the slider is dragged.
  if (pages.spineRotationDriven) refreshSpineRotationLabel();
  if (!anglePanel.visible) simulationPaused = false;

  cameraModes.update(dt);
  bookManipulator.update();

  // Mirror the reading position for the Book tab. Assigned only on a real
  // change: writing the same value every frame would wake every watcher
  // sixty times a second for nothing.
  if (bookState.page !== content.page) bookState.page = content.page;
  if (bookState.pageCount !== content.pageCount) bookState.pageCount = content.pageCount;
  if (!simulationPaused) {
    content.update(dt);
    pages.step();
    // After pages.step(), so the cover colliders are posed from the H1/H2
    // this frame actually rendered rather than last frame's.
    // A book in hand is carried: the placement body goes kinematic and
    // follows the pose the shelf is writing onto bookGroup, so setting it
    // down lands it on the desk like anything else.
    placement.step(dt, bookManipulator.grabbed || handHoldsBook);
    dragPageTurn.update(dt);
  }
  // OrbitControls poses the camera on every update() -- enabled or not --
  // so the modes that steer it directly must not let it run.
  if (cameraModes.mode === CAMERA_MODE.ORBIT) controls.update();
  // After the camera has finished moving for the frame: a book in hand is
  // posed from it, and stepping first would leave it a frame behind.
  shelfBooks?.update(dt);
  renderer.render(scene, camera);
  debugLabels.update();
  anglePanel.update();
});

if (import.meta.env.DEV) {
  // THREE is included so console debugging can build THREE.Box3 etc.
  // against these objects without a separate import.
  window.__athenaeum = {
    scene, camera, controls, cameraModes, renderer, bookGroup, content, dragPageTurn, dragCover, anglePanel, THREE,
    get pages() { return pages; },
  };
}