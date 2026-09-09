import * as THREE from 'three';
import { createScene } from './scene/createScene.js';
import { loadDesk } from './scene/desk.js';
import { loadLamp } from './scene/lamp.js';
import { loadBookshelf } from './scene/bookshelf.js';
import { addFloor } from './scene/floor.js';
import { populateShelf } from './scene/shelfBooks.js';
import { PageSimulation } from './book/pageSim/PageSimulation.js';
import { createBookPlacement } from './book/placement/bookPlacement.js';
import {
  setPageDimensions, setSpineGap, spineGapForPageCount,
  setSpineRotation, SPINE_ROTATION, PANEL_REACH as INITIAL_PANEL_REACH,
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
import { initBookLoader } from './loader/bookLoader.js';
import { createAudioManager } from './audio/audioManager.js';

// Fixed spine-to-edge reach that the camera, lighting and SPINE_GAP are
// tuned around; a loaded PDF's aspect ratio derives HINGE_LEN from this
// rather than rescaling the whole book.
const BASE_PANEL_REACH = INITIAL_PANEL_REACH;

const { scene, camera, renderer, controls } = await createScene();
const audio = createAudioManager();

// Camera rig first, before anything else claims the canvas: the look
// modes have to see a pointerdown ahead of dragCover / dragPageTurn /
// bookManipulator to be able to swallow it, and capture-phase listeners
// on one element run in registration order.
const cameraPan = createCameraPan({ camera, controls });
const cameraModes = createCameraModes({
  camera, renderer, controls, cameraPan,
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

  // Union AFTER the move, so the floor covers where the shelf ended up. Its
  // min.y is the lowest foot in the room, which is what the floor sits at.
  const room = deskBox.clone().union(new THREE.Box3().setFromObject(bookshelf));
  const floor = addFloor(scene, room);
  // The floor IS the walkable area, margin included, so the first-person
  // mode takes its bounds from the mesh rather than recomputing them.
  cameraModes.setRoom(new THREE.Box3().setFromObject(floor));
}

// After the shelf has been turned and placed: the books measure it in its
// own frame, which needs its final transform to be settled.
// Assigned when the models finish loading; the render loop skips it until
// then rather than blocking the whole scene on scenery.
let shelfBooks = null;
populateShelf(bookshelf, { camera, renderer })
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
  if (e.code === 'Space' && anglePanel.visible) {
    simulationPaused = !simulationPaused;
    e.preventDefault();
    return;
  }
  if (e.key === 'r' || e.key === 'R') resetBook();
  if (e.key === 'f' || e.key === 'F') { pages.toggleFlip(); refreshFlipLabel(); }
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
  if (e.key === 'ArrowRight') dragPageTurn.playTurn(RIGHT_HAND_PANEL);
  if (e.key === 'ArrowLeft') dragPageTurn.playTurn(LEFT_HAND_PANEL);
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
  shelfBooks?.update(dt);
  bookManipulator.update();
  if (!simulationPaused) {
    content.update(dt);
    pages.step();
    // After pages.step(), so the cover colliders are posed from the H1/H2
    // this frame actually rendered rather than last frame's.
    placement.step(dt, bookManipulator.grabbed);
    dragPageTurn.update(dt);
  }
  // OrbitControls poses the camera on every update() -- enabled or not --
  // so the modes that steer it directly must not let it run.
  if (cameraModes.mode === CAMERA_MODE.ORBIT) controls.update();
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
