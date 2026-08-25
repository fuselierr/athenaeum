import * as THREE from 'three';
import { BookGeometry } from './Book/bookGeometry.js';

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera( 75, window.innerWidth / window.innerHeight, 0.1, 1000 );

const renderer = new THREE.WebGLRenderer();
renderer.setSize( window.innerWidth, window.innerHeight );
document.body.appendChild( renderer.domElement );

const book = new BookGeometry({
  width: 0.15,
  height: 0.22,
  coverMaterial: '#4a2e1a',
});

const ambient = new THREE.AmbientLight('#ffffff', 0.6);
scene.add(ambient);

const dirLight = new THREE.DirectionalLight('#ffffff', 1.2);
dirLight.position.set(1, 2, 3);
scene.add(dirLight);

scene.add(book.root);
book.setOpenAmount(2); // half-open, for testing

camera.position.z = 0.5;

function animate( time ) {
  renderer.render( scene, camera );
}
renderer.setAnimationLoop( animate );