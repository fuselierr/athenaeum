import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FURNITURE_SCALE } from '../worldScale.js';

// Metres. A real bookshelf is about 1.9 m; this was 4.2 back when the
// world was scaled to the book's own units rather than the other way
// round, which is why it towered over the room -- see scene/worldScale.js.
const REAL_HEIGHT_M = 1.9;
const TARGET_HEIGHT = REAL_HEIGHT_M * FURNITURE_SCALE;

// Behind the desk, against the back wall. Also metres now, not the 4.1 it
// was under the old scale.
const DEFAULT_POSITION = new THREE.Vector3(0, 0, -1.9);
const WOOD_COLOR = 0x6b3f27;

/**
 * Loads the bookshelf model, normalizes its authored units, and places its
 * feet on the same y = 0 surface as the desk.
 */
export async function loadBookshelf(scene, options = {}) {
	const {
		position = DEFAULT_POSITION,
		rotationY = 0,
		scale = 1,
		targetHeight = TARGET_HEIGHT,
	} = options;

	const gltf = await new GLTFLoader().loadAsync('/bookshelf.glb');
	const bookshelf = gltf.scene;
	const rawBox = new THREE.Box3().setFromObject(bookshelf);
	const rawSize = rawBox.getSize(new THREE.Vector3());

	if (rawSize.y <= 0) {
		throw new Error('bookshelf.glb has no measurable height');
	}

	const rawCenter = rawBox.getCenter(new THREE.Vector3());
	const normalized = new THREE.Group();
	normalized.scale.setScalar((targetHeight / rawSize.y) * scale);
	normalized.add(bookshelf);
	bookshelf.position.set(-rawCenter.x, -rawBox.min.y, -rawCenter.z);

	normalized.rotation.y = rotationY;
	normalized.position.copy(position);
	scene.add(normalized);

	normalized.traverse((object) => {
		if (!object.isMesh) return;
		object.castShadow = true;
		object.receiveShadow = true;

		const materials = Array.isArray(object.material) ? object.material : [object.material];
		for (const material of materials) {
			if (!material || !('color' in material) || material.map) continue;
			material.color.setHex(WOOD_COLOR);
			if ('roughness' in material) material.roughness = 0.72;
		}
	});

	return normalized;
}
