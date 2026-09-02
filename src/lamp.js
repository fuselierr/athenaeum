import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export async function loadLamp(scene, options = {}) {
    const {
        position = new THREE.Vector3(0.9, 0.05, 1.5),
        rotationY = -Math.PI / 2,
        scale = 1.75,
        // Node inside lamp.glb whose mesh is the glowing part. In this
        // model it's the node literally named "lamp" (mesh "Cylinder.009"),
        // which carries two materials -- "Electronic Plastic" for the base
        // and "emmision lamp" for the actual glow, the latter already
        // authored with an emissive color ([1, 0.35, 0], warm orange) and a
        // KHR_materials_emissive_strength of 35, which GLTFLoader bakes into
        // material.emissiveIntensity on load. So by default we boost that
        // rather than overwrite it -- pass glowColor/emissiveIntensity
        // explicitly to override the authored look instead.
        bulbMeshName = 'lamp',
        // Multiplies whatever emissiveIntensity GLTFLoader already set from
        // the authored KHR_materials_emissive_strength (1 = leave as authored).
        emissiveBoost = 1,
        // Only applied if you pass it explicitly -- otherwise the material's
        // own authored emissive color (warm orange) is left alone.
        glowColor = null,
        // Real light emitted into the scene, positioned at the bulb.
        lightColor = 0xffb347,
        lightIntensity = 8,
        lightDistance = 6,
        lightDecay = 2,
    } = options;

    const gltf = await new GLTFLoader().loadAsync('/lamp.glb');
    const lamp = gltf.scene;

    let bulbWorldPos = null;

    lamp.traverse((obj) => {
        if (obj.isMesh) {
            obj.castShadow = true;
            obj.receiveShadow = true;

            if (obj.name.toLowerCase().includes(bulbMeshName.toLowerCase())) {
                // obj.material may be an array here (this node's mesh has
                // two materials: base plastic + the emissive glow one) --
                // handle both shapes.
                const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
                for (const mat of mats) {
                    if (!mat || !('emissive' in mat)) continue;
                    // Skip materials with no authored glow (e.g. the plain
                    // "Electronic Plastic" base) so only the actual emissive
                    // one gets boosted/overridden.
                    const hasAuthoredGlow = mat.emissive && !mat.emissive.equals(new THREE.Color(0, 0, 0));
                    if (!hasAuthoredGlow && glowColor === null) continue;

                    if (glowColor !== null) mat.emissive = new THREE.Color(glowColor);
                    mat.emissiveIntensity = (mat.emissiveIntensity || 1) * emissiveBoost;
                }
                // Bulbs shouldn't cast a shadow blob from their own glow.
                obj.castShadow = false;
                obj.getWorldPosition(bulbWorldPos = new THREE.Vector3());
            }
        }
    });

    lamp.position.copy(position);
    lamp.rotation.y = rotationY;
    lamp.scale.setScalar(scale);
    scene.add(lamp);

    // Add an actual light source so the lamp illuminates the room, not just
    // itself. Positioned at the bulb's local offset within the lamp so it
    // moves correctly with position/rotation/scale.
    const bulbLight = new THREE.PointLight(lightColor, lightIntensity, lightDistance, lightDecay);
    bulbLight.castShadow = true;
    bulbLight.shadow.mapSize.set(512, 512);
    if (bulbWorldPos) {
        // bulbWorldPos was computed before lamp.position/rotation/scale were
        // set (lamp was still at the origin), so it's already the correct
        // local-space offset to nest under `lamp`.
        bulbLight.position.copy(bulbWorldPos);
    } else {
        // Fallback: no mesh matched bulbMeshName -- place the light near the
        // lamp's local top. Tweak to taste, or pass an explicit position via
        // options if you know the bulb's local coordinates.
        bulbLight.position.set(0, 0.9, 0);
    }
    lamp.add(bulbLight);

    return lamp;
}