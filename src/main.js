import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PageSimulation } from './Book/pageSim/PageSimulation.js';
import { setPageDimensions, PANEL_REACH as INITIAL_PANEL_REACH } from './Book/pageSim/config.js';
import { updateLocalCorners } from './Book/pageSim/math.js';
import { initBookLoader } from './bookLoader.js';

// Fixed spine-to-edge reach that camera, lighting, fog and SPINE_GAP are
// tuned around. A loaded PDF's aspect ratio is applied by deriving HINGE_LEN
// from this rather than rescaling the whole book.
const BASE_PANEL_REACH = INITIAL_PANEL_REACH;

// BookGeometry (src/Book/bookGeometry.js), the static spine/cover backbone,
// is not wired in yet — this models pages only, at its own scale.

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x11141a);
scene.fog = new THREE.Fog(0x11141a, 8, 20);

const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.05, 100);
camera.position.set(3.2, 2.4, 3.6);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
document.body.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1.0, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.08;

scene.add(new THREE.HemisphereLight(0xaabbff, 0x1a1a1a, 0.6));
const sun = new THREE.DirectionalLight(0xffffff, 2.0);
sun.position.set(3, 17, 7);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.camera.left = -3;
sun.shadow.camera.right = 3;
sun.shadow.camera.top = 3;
sun.shadow.camera.bottom = -3;
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 12;
sun.shadow.camera.updateProjectionMatrix();
sun.shadow.bias = -0.0015;
sun.shadow.normalBias = 0.02;
scene.add(sun);

const grid = new THREE.GridHelper(20, 20, 0x2a3040, 0x1c202a);
grid.position.y = -1.6;
scene.add(grid);

let pages = await PageSimulation.create(scene);

/**
 * Rebuild the simulation sized to a loaded PDF's page proportions.
 * HINGE_LEN/PANEL_REACH are baked in at construction time, so this disposes
 * the running simulation and builds a fresh one. pageWidthPts/pageHeightPts
 * are the PDF's raw page size; width maps to PANEL_REACH (spine-to-edge),
 * height to HINGE_LEN (spine length).
 */
async function applyPdfDimensions(pageWidthPts, pageHeightPts) {
  const panelReach = BASE_PANEL_REACH;
  const hingeLen = panelReach * (pageHeightPts / pageWidthPts);

  setPageDimensions(hingeLen, panelReach);
  updateLocalCorners();

  pages.dispose();
  pages = await PageSimulation.create(scene);
  refreshFlipLabel();
}

// Page-turn state: B/C show pageCanvases[leafStart] and [leafStart + 1],
// advancing two at a time on ArrowLeft/Right. A/D aren't wired in yet.
let pageCanvases = [];
const pageTextures = []; // built lazily, one CanvasTexture per page, reused across flips
let leafStart = 0;

function textureForPage(index) {
  if (!pageCanvases[index]) return null;
  if (!pageTextures[index]) {
    pageTextures[index] = new THREE.CanvasTexture(pageCanvases[index]);
  }
  return pageTextures[index];
}

function showLeaf(start) {
  if (pageCanvases.length === 0) return;
  // Clamp to an even index so B always lands on an odd-numbered page
  // (0-indexed even) and C on the following even one, and so the last
  // full leaf is shown rather than running past the end of the book.
  const maxStart = pageCanvases.length >= 2
    ? (pageCanvases.length - (pageCanvases.length % 2 === 0 ? 2 : 1))
    : 0;
  leafStart = Math.max(0, Math.min(start, maxStart));

  // B/C are swapped from the naive leafStart/leafStart+1 assignment to match
  // what actually renders (PageSimulation.root's 180° flip inverts Z).
  const b = textureForPage(leafStart + 1);
  const c = textureForPage(leafStart);
  if (b) pages.setPageTexture('B', b);
  if (c) pages.setPageTexture('C', c);
}

// Uploads an epub, converts it server-side (Playwright), and rasterizes the
// resulting PDF's pages to canvas via PDF.js.
initBookLoader({
  onDimensions: async (pageWidthPts, pageHeightPts) => {
    await applyPdfDimensions(pageWidthPts, pageHeightPts);
  },
  onPagesReady: (canvases) => {
    pageCanvases = canvases;
    pageTextures.length = 0;
    showLeaf(0);
  },
});

const flipBtn = document.getElementById('flipBtn');
const resetBtn = document.getElementById('resetBtn');

function refreshFlipLabel() {
  if (flipBtn) flipBtn.textContent = pages.flipped ? 'Flip book back' : 'Flip book over';
}

flipBtn?.addEventListener('click', () => { pages.toggleFlip(); refreshFlipLabel(); });
resetBtn?.addEventListener('click', () => { pages.reset(); refreshFlipLabel(); });
window.addEventListener('keydown', (e) => {
  if (e.key === 'r' || e.key === 'R') { pages.reset(); refreshFlipLabel(); }
  if (e.key === 'f' || e.key === 'F') { pages.toggleFlip(); refreshFlipLabel(); }
  if (e.key === '[') pages.setProgress(pages.progress - 0.05);
  if (e.key === ']') pages.setProgress(pages.progress + 0.05);
  if (e.key === 'ArrowRight') showLeaf(leafStart + 2);
  if (e.key === 'ArrowLeft') showLeaf(leafStart - 2);
});
refreshFlipLabel();

renderer.setAnimationLoop(() => {
  pages.step();
  controls.update();
  renderer.render(scene, camera);
});

if (import.meta.env.DEV) {
  // `pages` is reassigned on a resize (applyPdfDimensions), so expose it as
  // a getter instead of a snapshot -- otherwise this object would keep
  // pointing at a disposed PageSimulation after the first PDF loads.
  window.__athenaeum = {
    scene, camera, controls, renderer,
    get pages() { return pages; },
  };
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});