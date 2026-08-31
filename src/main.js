import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
import { PageSimulation } from './Book/pageSim/PageSimulation.js';
import { setPageDimensions, PANEL_REACH as INITIAL_PANEL_REACH } from './Book/pageSim/config.js';
import { updateLocalCorners } from './Book/pageSim/math.js';
import { initBookLoader } from './bookLoader.js';

// Baseline width scale (spine-to-edge reach) everything else -- camera
// distance, SPINE_GAP, fog, the default 1.4 PANEL_REACH -- was already
// tuned around. A loaded PDF's aspect ratio is applied by keeping this
// fixed and deriving HINGE_LEN (the spine-length/page-height dimension)
// from it, rather than changing overall scale, so the book doesn't also
// shrink/balloon relative to the camera and lighting just because a page
// happens to be tall or short.
const BASE_PANEL_REACH = INITIAL_PANEL_REACH;

// NOTE: BookGeometry (src/Book/bookGeometry.js) is the static spine/cover
// backbone and is not wired in here yet — the physics page simulation below
// currently models pages only, at its own (larger) scale. Reconciling the
// two is the next step.

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x11141a); // shown until the EXR below finishes loading
scene.fog = new THREE.Fog(0x11141a, 8, 20);

const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.05, 100);
camera.position.set(3.2, 2.4, 3.6);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
document.body.appendChild(renderer.domElement);

// EXR background AND lighting. Just setting scene.background to the raw EXR
// only shows it -- it does not light anything, because a background texture
// is never sampled by the lighting pipeline. Actually lighting/reflecting
// the scene FROM it needs PMREMGenerator: it prefilters the equirect EXR
// into a mipmapped GGX-convolved radiance map (the same format an HDRI-based
// env map normally is), so rougher materials sample blurrier mips of it --
// that result goes on scene.environment, which every MeshStandardMaterial
// (all the page/wedge materials are one) automatically picks up as ambient
// image-based lighting, no per-material wiring needed. Needs `renderer` to
// exist first (it runs the prefilter as an actual render pass), so this has
// to come after the renderer above, and PageSimulation's materials just need
// to already be MeshStandardMaterial (they are) -- nothing else to change
// there.
const exrLoader = new EXRLoader();
const pmrem = new THREE.PMREMGenerator(renderer);
const rawEnvTexture = await exrLoader.loadAsync('./public/background.exr');
rawEnvTexture.mapping = THREE.EquirectangularReflectionMapping;
const envRT = pmrem.fromEquirectangular(rawEnvTexture);
scene.environment = envRT.texture; // lights/reflects everything
scene.background = rawEnvTexture; // crisper backdrop than the blurred env RT
pmrem.dispose();

// Deliberately NOT calling rawEnvTexture.dispose() here: it's still in use
// as scene.background above (only the intermediate PMREMGenerator resources
// -- `pmrem` itself -- are safe to free once fromEquirectangular returns).
// If you'd rather show the blurred env map as the backdrop too (one texture
// to manage instead of two), use `scene.background = envRT.texture;` instead
// of the line above, and it IS then safe to dispose rawEnvTexture right
// after fromEquirectangular() consumes it.

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1.0, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.08;

// With the EXR now driving ambient/reflected lighting via scene.environment,
// the old flat HemisphereLight fill is redundant -- lower it (or drop it
// entirely) rather than stacking both. `sun` stays: MeshStandardMaterial
// picks up scene.environment for ambient/reflections automatically, but
// environment maps never cast shadows in three.js -- a real light is still
// required for that, so keep `sun` as a dedicated shadow-caster and turn its
// intensity down since it's now a fill/shadow light on top of the EXR's own
// ambient contribution, not the scene's main light source.
scene.add(new THREE.HemisphereLight(0xaabbff, 0x1a1a1a, 0.15));
const sun = new THREE.DirectionalLight(0xffffff, 0.8);
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

let pages = await PageSimulation.create(scene);

/**
 * Resize the book to match a loaded PDF's actual page proportions, and
 * apply it. HINGE_LEN/PANEL_REACH are baked into physics bodies, collider
 * half-extents, and panelGeo at PageSimulation construction time (see
 * spread.js's createSpread) -- so picking up a new size means disposing
 * the whole simulation and building a fresh one with the new config
 * values already in effect, not mutating the running one in place.
 *
 * pageWidthPts/pageHeightPts are the PDF's raw (unscaled) page size, in
 * reading-normal orientation -- width is the page's short/reading-
 * horizontal axis, height the long/top-to-bottom axis. Physically, that
 * maps to HINGE_LEN (X, spine length) ~ page height and PANEL_REACH (Z,
 * spine-to-edge) ~ page width (see the UV-orientation comment in
 * bookLoader.js's renderPdfToCanvases for the same mapping).
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

// Page-turn state: B always shows pageCanvases[leafStart], C always shows
// pageCanvases[leafStart + 1] -- "page 1 on B, page 2 on C" at leafStart=0,
// "page 3 on B, page 4 on C" after one ArrowRight (leafStart=2), etc. A/D
// aren't wired into this yet (their z-fight/occlusion issues are still
// being sorted out separately) -- this only drives B/C.
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

  // Swapped from the naive B=leafStart/C=leafStart+1 assignment: page 1 was
  // showing up on the panel identified as C, page 2 on B -- the reverse of
  // what was wired. This is about which PDF page NUMBER feeds which mesh's
  // texture slot, unrelated to PageSimulation.root's world transform (which
  // no longer has a permanent flip anyway, see the PageSimulation
  // constructor) -- so this swap stays regardless of that. Determined
  // empirically rather than derived, and still matches what was observed.
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
    console.log(`Book ready: ${canvases.length} page canvases rendered.`, canvases);
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

const bcCrossWarning = document.getElementById('bc-cross-warning');
const bcDebug = document.getElementById('bc-debug');

renderer.setAnimationLoop(() => {
  pages.step();
  if (bcCrossWarning) bcCrossWarning.hidden = !pages.isCrossingBC;
  if (bcDebug) {
    const d = pages.debugBC;
    bcDebug.textContent =
      `angleB = ${d.angleB.toFixed(3)}\n`
      + `angleC = ${d.angleC.toFixed(3)}\n`
      + `angleB > angleC : ${d.angleCrossing}\n`
      + `tipB.z = ${d.tipBz.toFixed(3)}\n`
      + `tipC.z = ${d.tipCz.toFixed(3)}\n`
      + `tipB.z < tipC.z : ${d.tipCrossing}`;
  }
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