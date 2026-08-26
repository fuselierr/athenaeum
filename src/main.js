import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { BookGeometry } from './Book/bookGeometry.js';
import "./epub.js";

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera( 75, window.innerWidth / window.innerHeight, 0.1, 1000 );

const renderer = new THREE.WebGLRenderer();
renderer.setSize( window.innerWidth, window.innerHeight );
document.body.appendChild( renderer.domElement );

// Lights
const ambient = new THREE.AmbientLight('#ffffff', 0.6);
scene.add(ambient);

const dirLight = new THREE.DirectionalLight('#ffffff', 1.2);
dirLight.position.set(1, 2, 3);
scene.add(dirLight);

const book = new BookGeometry();

scene.add(book.root);
book.setOpenAmount(0);

camera.position.set(0.3, 0.2, 0.4);

// --- Drag-to-orbit controls ---
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0, 0);       // orbit around the book's origin
controls.enableDamping = true;       // adds inertia/smoothing to drags
controls.dampingFactor = 0.08;
controls.minDistance = 0.15;         // don't let zoom clip through the book
controls.maxDistance = 2;
controls.update();

function animate() {
  controls.update(); // required every frame when enableDamping is true
  renderer.render( scene, camera );
}
renderer.setAnimationLoop( animate );

// Keep aspect ratio correct on window resize
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});