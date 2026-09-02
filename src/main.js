import * as THREE from 'three';
import { createScene } from './scene.js';
import { PageSimulation } from './Book/pageSim/PageSimulation.js';
import { setPageDimensions, PANEL_REACH as INITIAL_PANEL_REACH } from './Book/pageSim/config.js';
import { updateLocalCorners } from './Book/pageSim/math.js';
import { createDragPageTurn } from './Book/pageSim/dragPageTurn.js';
import { loadDesk } from './desk.js';
import { initBookLoader } from './loader/bookLoader.js';

// Fixed spine-to-edge reach that the camera, lighting and SPINE_GAP are
// tuned around; a loaded PDF's aspect ratio derives HINGE_LEN from this
// rather than rescaling the whole book.
const BASE_PANEL_REACH = INITIAL_PANEL_REACH;

const {
  scene, camera, renderer, controls,
} = await createScene();

// The book lives under its own group (rather than directly under `scene`)
// so right-drag can rotate the book as a whole (see the pointer handlers
// below) without touching PageSimulation.root's own permanent render flip
// or any physics coordinates -- purely an outer, render-only transform,
// same spirit as PageSimulation.root itself.
const bookGroup = new THREE.Group();
scene.add(bookGroup);

// Desk goes straight under `scene`, not `bookGroup` -- it's furniture the
// book rests on, so it should stay put in world space even when the book
// itself is right-drag-rotated (bookGroup's own transform, see the
// pointer handlers below). Loaded alongside the page simulation rather
// than after it, since the two are independent and neither needs to wait
// on the other.
const [pagesInstance] = await Promise.all([
  PageSimulation.create(bookGroup),
  loadDesk(scene, { yRotation: Math.PI / 2, scale: 1.2 }),
]);
let pages = pagesInstance;

// --- drag-to-turn-a-page ---
// Click-and-drag on the currently-showing B or C panel bends a temporary
// double-sided copy of it, following the exact same radial-curl shape
// B/C themselves are built from, until it settles into the OTHER panel's
// shape (a completed turn) or eases back to where it started (a
// cancelled one). The temp page's front face shows the panel's current
// content, its back face shows the content the panel will hold once the
// turn actually commits (see getTurnBackTexture below) -- so flipping it
// over reads as turning to a real next/previous page, not just bending a
// blank shape. The real B/C mesh underneath is switched to that same
// "next" texture the moment the drag starts (still hidden behind the
// temp page at that point, since they're coincident) rather than staying
// on its old content, so as the temp page peels away mid-drag the
// correct upcoming page is already there instead of a blank/stale one.
// Committing a turn (release past the halfway point) advances the real
// book via commitTurnPanel -> showLeaf, same as the arrow keys; releasing
// short of halfway reverts the previewed panel back to what it showed
// before the drag started. `getPages` is a closure, not a direct capture,
// since `pages` itself is reassigned by applyPdfDimensions below; the
// texture/leaf callbacks are function declarations further down, safe to
// reference here since they're only ever invoked later, once
// pageCanvases/leafStart are populated.
const dragPageTurn = createDragPageTurn({
  getPages: () => pages,
  camera,
  renderer,
  controls,
  canTurn: canTurnPanel,
  getBackTexture: getTurnBackTexture,
  commitTurn: commitTurnPanel,
});

// --- controls: flip / reset buttons ---
const flipBtn = document.getElementById('flipBtn');
const resetBtn = document.getElementById('resetBtn');

function refreshFlipLabel() {
  if (flipBtn) flipBtn.textContent = pages.flipped ? 'Flip book back' : 'Flip book over';
}

flipBtn?.addEventListener('click', () => { pages.toggleFlip(); refreshFlipLabel(); });
resetBtn?.addEventListener('click', () => { pages.reset(); refreshFlipLabel(); });
refreshFlipLabel();

// --- page turning: arrow keys swap B/C's textures directly (no turn
// animation for now -- see the pageTurn.js module in src/loader if that
// needs to come back). ---
let pageCanvases = [];
const pageTextures = []; // one THREE.CanvasTexture per page index, built lazily, reused across turns
let leafStart = 0;

function textureForPage(index) {
  if (!pageCanvases[index]) return null;
  if (!pageTextures[index]) {
    pageTextures[index] = new THREE.CanvasTexture(pageCanvases[index]);
  }
  return pageTextures[index];
}

function clampLeafStart(start) {
  if (pageCanvases.length === 0) return 0;
  const maxStart = pageCanvases.length >= 2
    ? (pageCanvases.length - (pageCanvases.length % 2 === 0 ? 2 : 1))
    : 0;
  return Math.max(0, Math.min(start, maxStart));
}

function showLeaf(start) {
  if (pageCanvases.length === 0) return;
  leafStart = clampLeafStart(start);
  // B/C swapped from the naive leafStart/leafStart+1 assignment to match
  // what actually renders -- determined empirically, still matches what's
  // shown.
  const b = textureForPage(leafStart + 1);
  const c = textureForPage(leafStart);
  if (b) pages.setPageTexture('B', b);
  if (c) pages.setPageTexture('C', c);
}

// Where dragging `panel` (forward for B, backward for C -- see
// dragPageTurn.js) would land, and what it would show there. Shared by
// createDragPageTurn's canTurn/getBackTexture/commitTurn callbacks so a
// drag's preview and its eventual commit always agree with each other and
// with showLeaf/the arrow keys.
function turnTargetLeafStart(panel) {
  return clampLeafStart(leafStart + (panel === 'B' ? 2 : -2));
}
function canTurnPanel(panel) {
  return turnTargetLeafStart(panel) !== leafStart;
}
function getTurnBackTexture(panel) {
  const target = turnTargetLeafStart(panel);
  return panel === 'B' ? textureForPage(target + 1) : textureForPage(target);
}
function commitTurnPanel(panel) {
  showLeaf(turnTargetLeafStart(panel));
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'r' || e.key === 'R') { pages.reset(); bookGroup.quaternion.identity(); refreshFlipLabel(); }
  if (e.key === 'f' || e.key === 'F') { pages.toggleFlip(); refreshFlipLabel(); }
  if (e.key === '[') pages.setProgress(pages.progress - 0.05);
  if (e.key === ']') pages.setProgress(pages.progress + 0.05);
  if (e.key === 'ArrowRight') showLeaf(leafStart + 2);
  if (e.key === 'ArrowLeft') showLeaf(leafStart - 2);
});

// --- book loading ---
// HINGE_LEN/PANEL_REACH are baked into physics bodies and geometry at
// construction, so a new page size means rebuilding the whole simulation.
async function applyPdfDimensions(pageWidthPts, pageHeightPts) {
  setPageDimensions(BASE_PANEL_REACH * (pageHeightPts / pageWidthPts), BASE_PANEL_REACH);
  updateLocalCorners();
  pages.dispose();
  pages = await PageSimulation.create(bookGroup);
  refreshFlipLabel();
}

initBookLoader({
  onDimensions: applyPdfDimensions,
  onPagesReady: (canvases) => {
    pageCanvases = canvases;
    pageTextures.length = 0;
    showLeaf(0);
  },
});

// --- camera pan (WASD) ---
// Takes over the job right-drag used to do on OrbitControls (see
// controls.mouseButtons.RIGHT = null in scene.js) -- moves camera.position
// and controls.target together along the camera's own local right/up axes,
// same math OrbitControls' internal pan uses, just driven by held keys
// instead of a drag delta.
const PAN_SPEED = 1.4; // world units/sec at ~4 units from target; scales with distance below
const panKeys = new Set();
window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (k === 'w' || k === 'a' || k === 's' || k === 'd') panKeys.add(k);
});
window.addEventListener('keyup', (e) => {
  panKeys.delete(e.key.toLowerCase());
});

const _panRight = new THREE.Vector3();
const _panUp = new THREE.Vector3();
const _panOffset = new THREE.Vector3();
function applyPan(dt) {
  if (panKeys.size === 0) return;
  const distance = camera.position.distanceTo(controls.target);
  const speed = PAN_SPEED * (distance / 4) * dt;

  _panRight.setFromMatrixColumn(camera.matrix, 0);
  _panUp.setFromMatrixColumn(camera.matrix, 1);
  _panOffset.set(0, 0, 0);
  if (panKeys.has('d')) _panOffset.addScaledVector(_panRight, speed);
  if (panKeys.has('a')) _panOffset.addScaledVector(_panRight, -speed);
  if (panKeys.has('w')) _panOffset.addScaledVector(_panUp, speed);
  if (panKeys.has('s')) _panOffset.addScaledVector(_panUp, -speed);

  camera.position.add(_panOffset);
  controls.target.add(_panOffset);
}

// --- book rotation (right-drag, true arcball/trackball) ---
// The previous version rotated around the camera's up axis for dx and its
// right axis for dy, independently -- that gives you yaw and pitch, but
// never ROLL, because a straight horizontal or vertical drag can never
// produce a rotation around the camera's OWN forward/view axis, and a
// diagonal or curved drag just gets treated as yaw-then-pitch rather than
// a single rotation around whatever axis the drag actually swept through.
// A real trackball/arcball maps the cursor onto an imaginary sphere sitting
// in front of the camera (Shoemake's classic ARCBALL construction): near
// the sphere's center that's mostly yaw/pitch, same as before, but out
// past its silhouette edge (pointerToSphere's z=0 case below) the mapped
// point slides around the RIM of the sphere, so a drag that curves around
// out there sweeps an arc around the view axis itself -- which is what
// reads as "rolling" the book. The rotation axis/angle come from the arc
// between the previous and current sphere points (cross product for axis,
// angle between them for magnitude), not from dx/dy separately, so a
// diagonal or curved drag produces one combined rotation instead of two
// independent ones.
const ROTATE_SENSITIVITY = 1.4; // >1 = a given drag arc turns the book further than it visually swept

const dom = renderer.domElement;
dom.addEventListener('contextmenu', (e) => e.preventDefault());

let rotatingBook = false;
const _lastSpherePoint = new THREE.Vector3();
const _curSpherePoint = new THREE.Vector3();
const _rotAxis = new THREE.Vector3();
const _deltaQuat = new THREE.Quaternion();

/**
 * Maps a client-space pointer position onto the unit hemisphere/sphere
 * Shoemake's arcball uses, in CAMERA-LOCAL coordinates (+X right, +Y up,
 * +Z toward the viewer/out of the screen -- matches camera.matrix's own
 * column basis, so the result can go straight into transformDirection
 * below with no extra axis remapping). Inside the sphere's silhouette
 * (screen-space radius <= 1) this is a point ON the front of the sphere,
 * z = sqrt(1 - x^2 - y^2); beyond it, the point is clamped onto the
 * sphere's rim (z = 0) instead of left undefined -- that rim is exactly
 * where dragging starts producing roll instead of yaw/pitch.
 */
function pointerToSphere(clientX, clientY, out) {
  const rect = dom.getBoundingClientRect();
  const radius = Math.min(rect.width, rect.height) / 2;
  const x = (clientX - rect.left - rect.width / 2) / radius;
  const y = (rect.height / 2 - (clientY - rect.top)) / radius; // flipped: screen Y grows downward, sphere Y should grow upward
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
  rotatingBook = true;
  pointerToSphere(e.clientX, e.clientY, _lastSpherePoint);
});
window.addEventListener('pointermove', (e) => {
  if (!rotatingBook) return;
  pointerToSphere(e.clientX, e.clientY, _curSpherePoint);

  _rotAxis.crossVectors(_lastSpherePoint, _curSpherePoint);
  const axisLenSq = _rotAxis.lengthSq();
  if (axisLenSq > 1e-12) {
    const dot = THREE.MathUtils.clamp(_lastSpherePoint.dot(_curSpherePoint), -1, 1);
    const angle = Math.acos(dot) * ROTATE_SENSITIVITY;
    _rotAxis.multiplyScalar(1 / Math.sqrt(axisLenSq)); // normalize without a second sqrt of the same value
    // The axis above is in camera-local space (see pointerToSphere) --
    // transformDirection rotates it into world space using the camera's
    // CURRENT orientation (ignores translation, which is correct for a
    // direction), so the rotation always reads as camera-relative no
    // matter how the book itself is already oriented.
    _rotAxis.transformDirection(camera.matrix);
    _deltaQuat.setFromAxisAngle(_rotAxis, angle);
    bookGroup.quaternion.premultiply(_deltaQuat);
    bookGroup.quaternion.normalize(); // keeps floating-point drift from accumulating over a long drag
  }

  _lastSpherePoint.copy(_curSpherePoint);
});
window.addEventListener('pointerup', (e) => {
  if (e.button === 2) rotatingBook = false;
});

// --- gravity: stays pointed at true world-down regardless of bookGroup's
// current rotation. Rapier's gravity vector lives in PageSimulation's own
// local/physics space, which knows nothing about bookGroup's transform, so
// without this, spinning the book via right-drag would silently spin the
// physics right along with it -- pages would stay put relative to the
// book's covers instead of actually sagging toward the floor as you turn
// it, which is what made rotating the book look like it was "flipping
// gravity". Recomputed every frame (cheap: one quaternion-vector rotation)
// rather than only on pointermove, so it stays correct even if bookGroup is
// ever rotated some other way later. ---
const WORLD_DOWN = new THREE.Vector3(0, -1, 0);
const _localDown = new THREE.Vector3();
const _invBookQuat = new THREE.Quaternion();
function applyWorldGravity() {
  _invBookQuat.copy(bookGroup.quaternion).invert();
  _localDown.copy(WORLD_DOWN).applyQuaternion(_invBookQuat);
  pages.setGravityDirection(_localDown);
}

// --- render loop ---
let lastFrameTime = performance.now();
renderer.setAnimationLoop(() => {
  const now = performance.now();
  const dt = Math.min((now - lastFrameTime) / 1000, 1 / 30);
  lastFrameTime = now;

  applyPan(dt);
  applyWorldGravity();
  pages.step();
  dragPageTurn.update(dt);
  controls.update();
  renderer.render(scene, camera);
});

if (import.meta.env.DEV) {
  // `pages` is reassigned by applyPdfDimensions, so expose it as a getter.
  // THREE is included so console debugging can build THREE.Box3 etc.
  // against these objects without a separate import (e.g. checking the
  // desk/book bounding boxes against each other -- see desk.js).
  window.__athenaeum = {
    scene, camera, controls, renderer, bookGroup, THREE, get pages() { return pages; },
  };
}