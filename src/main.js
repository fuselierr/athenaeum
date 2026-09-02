import { createScene } from './scene.js';
import { PageSimulation } from './Book/pageSim/PageSimulation.js';
import { setPageDimensions, PANEL_REACH as INITIAL_PANEL_REACH } from './Book/pageSim/config.js';
import { updateLocalCorners } from './Book/pageSim/math.js';
import { initBookLoader } from './loader/bookLoader.js';
import { createPageTurn } from './loader/pageTurn.js';

// Fixed spine-to-edge reach that the camera, lighting and SPINE_GAP are
// tuned around; a loaded PDF's aspect ratio derives HINGE_LEN from this
// rather than rescaling the whole book.
const BASE_PANEL_REACH = INITIAL_PANEL_REACH;

const { scene, camera, renderer, controls } = await createScene();

let pages = await PageSimulation.create(scene);
const pageTurn = createPageTurn(() => pages);

// --- controls ---
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
  if (e.key === 'ArrowRight') pageTurn.next();
  if (e.key === 'ArrowLeft') pageTurn.prev();
});
refreshFlipLabel();

// --- book loading ---
// HINGE_LEN/PANEL_REACH are baked into physics bodies and geometry at
// construction, so a new page size means rebuilding the whole simulation.
async function applyPdfDimensions(pageWidthPts, pageHeightPts) {
  setPageDimensions(BASE_PANEL_REACH * (pageHeightPts / pageWidthPts), BASE_PANEL_REACH);
  updateLocalCorners();
  pages.dispose();
  pages = await PageSimulation.create(scene);
  refreshFlipLabel();
}

initBookLoader({
  onDimensions: applyPdfDimensions,
  onPagesReady: (canvases) => pageTurn.setCanvases(canvases),
});

// --- render loop ---
renderer.setAnimationLoop(() => {
  pages.step();
  controls.update();
  renderer.render(scene, camera);
});

if (import.meta.env.DEV) {
  // `pages` is reassigned by applyPdfDimensions, so expose it as a getter.
  window.__athenaeum = { scene, camera, controls, renderer, get pages() { return pages; } };
}
