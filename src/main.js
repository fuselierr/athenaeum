import * as THREE from 'three';
import { createScene } from './scene/createScene.js';
import { loadDesk } from './scene/desk.js';
import { loadLamp } from './scene/lamp.js';
import { PageSimulation } from './book/pageSim/PageSimulation.js';
import {
  setPageDimensions, setSpineGap, spineGapForPageCount,
  PANEL_REACH as INITIAL_PANEL_REACH,
} from './Book/pageSim/config.js';
import { updateLocalCorners } from './Book/pageSim/math.js';
import { createBookContent, RIGHT_HAND_PANEL, LEFT_HAND_PANEL } from './book/reader/bookContent.js';
import { createDragPageTurn } from './book/reader/dragPageTurn.js';
import { createCameraPan } from './input/cameraPan.js';
import { createBookManipulator } from './input/bookManipulator.js';
import { createDebugLabels } from './debug/debugLabels.js';
import { initBookLoader } from './loader/bookLoader.js';

// Fixed spine-to-edge reach that the camera, lighting and SPINE_GAP are
// tuned around; a loaded PDF's aspect ratio derives HINGE_LEN from this
// rather than rescaling the whole book.
const BASE_PANEL_REACH = INITIAL_PANEL_REACH;

const { scene, camera, renderer, controls } = await createScene();

// The book hangs under its own group rather than directly under `scene` so
// it can be rotated and slid as a whole (see input/bookManipulator.js)
// without touching PageSimulation.root's own render flip or any physics
// coordinates -- purely an outer, render-only transform.
const bookGroup = new THREE.Group();
scene.add(bookGroup);

// The desk and lamp go straight under `scene`: they are furniture the book
// rests on, so they stay put in world space when the book itself is moved.
// Loaded alongside the page simulation since none of the three waits on
// the others.
const [pagesInstance] = await Promise.all([
  PageSimulation.create(bookGroup),
  loadDesk(scene),
  loadLamp(scene, { position: new THREE.Vector3(1.2, 0, -2.6), scale: 4.75 }),
]);

// Reassigned by applyPdfDimensions below, so everything downstream takes a
// `getPages` closure rather than capturing the instance.
let pages = pagesInstance;
const getPages = () => pages;

const content = createBookContent(getPages);
const dragPageTurn = createDragPageTurn({ getPages, camera, renderer, controls, content });
const cameraPan = createCameraPan({ camera, controls });
const bookManipulator = createBookManipulator({ bookGroup, camera, renderer, getPages });
const debugLabels = createDebugLabels({ scene, camera, renderer, getPages });

// --- book loading ---
// HINGE_LEN/PANEL_REACH/SPINE_GAP are baked into physics bodies and
// geometry at construction, so new page dimensions mean rebuilding the
// whole simulation.
async function applyPdfDimensions(pageWidthPts, pageHeightPts, pageCount) {
  setPageDimensions(BASE_PANEL_REACH * (pageHeightPts / pageWidthPts), BASE_PANEL_REACH);
  // Thickness comes from the page count -- a short book loads thin, a long
  // one fat. Set before the rebuild, since SPINE_GAP is baked into the
  // cover anchors when the spreads are constructed.
  setSpineGap(spineGapForPageCount(pageCount));
  updateLocalCorners();
  pages.dispose();
  pages = await PageSimulation.create(bookGroup);
  refreshFlipLabel();
}

initBookLoader({
  onDimensions: applyPdfDimensions,
  onPagesReady: (canvases) => content.setCanvases(canvases),
});

// --- UI ---
const flipBtn = document.getElementById('flipBtn');
const resetBtn = document.getElementById('resetBtn');

function refreshFlipLabel() {
  if (flipBtn) flipBtn.textContent = pages.flipped ? 'Flip book back' : 'Flip book over';
}

function resetBook() {
  pages.reset();
  bookGroup.quaternion.identity();
  bookGroup.position.set(0, 0, 0); // also undo any shift-drag repositioning
  refreshFlipLabel();
}

flipBtn?.addEventListener('click', () => { pages.toggleFlip(); refreshFlipLabel(); });
resetBtn?.addEventListener('click', resetBook);
refreshFlipLabel();

window.addEventListener('keydown', (e) => {
  if (e.key === 'r' || e.key === 'R') resetBook();
  if (e.key === 'f' || e.key === 'F') { pages.toggleFlip(); refreshFlipLabel(); }
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

  cameraPan.update(dt);
  bookManipulator.update();
  content.update(dt);
  pages.step();
  dragPageTurn.update(dt);
  controls.update();
  renderer.render(scene, camera);
  debugLabels.update();
});

if (import.meta.env.DEV) {
  // THREE is included so console debugging can build THREE.Box3 etc.
  // against these objects without a separate import.
  window.__athenaeum = {
    scene, camera, controls, renderer, bookGroup, content, THREE, get pages() { return pages; },
  };
}
