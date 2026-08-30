import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PageSimulation } from './Book/pageSim/PageSimulation.js';
import { initEpubViewer } from './epub.js';

// NOTE: BookGeometry (src/Book/bookGeometry.js) is the static spine/cover
// backbone and is not wired in here yet — the physics page simulation below
// currently models pages only, at its own (larger) scale. Reconciling the
// two is the next step.

// ---------- scene ----------
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

// ---------- controls ----------
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1.0, 0); // aimed at the flipped book, which sits above y = 0
controls.enableDamping = true;
controls.dampingFactor = 0.08;

// ---------- lights ----------
scene.add(new THREE.HemisphereLight(0xaabbff, 0x1a1a1a, 0.6));
const sun = new THREE.DirectionalLight(0xffffff, 2.0);
sun.position.set(3, 5, 2);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
scene.add(sun);

const grid = new THREE.GridHelper(20, 20, 0x2a3040, 0x1c202a);
grid.position.y = -1.6;
scene.add(grid);

// ---------- page simulation ----------
const pages = await PageSimulation.create(scene);

// ---------- epub page-capture viewer (adds its own floating page mesh) ----------
initEpubViewer(scene);

// ---------- input ----------
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
});
refreshFlipLabel();

// ---------- render loop ----------
renderer.setAnimationLoop(() => {
  pages.step();
  controls.update();
  renderer.render(scene, camera);
});

if (import.meta.env.DEV) {
  // Dev-only handle for poking at the scene from the console.
  window.__athenaeum = { scene, camera, controls, pages };
}

// ---------- resize ----------
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
