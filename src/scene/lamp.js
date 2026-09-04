import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// Height (in the ORIGINAL lamp.glb's own raw units) that the position/scale
// numbers below main.js/loadLamp's defaults were tuned against. That first
// model was already authored in real-world meters (~0.7m tall). The
// replacement model turned out to be authored in a totally different raw
// unit (its bounding box is ~44 units tall -- almost certainly centimeters
// or an arbitrary Sketchfab export scale), which would make it render ~60x
// too big at the old `scale` values. Rather than re-tune every call site's
// `scale`/`position` by hand whenever the .glb gets swapped again, loadLamp
// now measures whatever model it loads and normalizes it to this same
// reference height internally -- so `scale`/`position` keep meaning the same
// thing across model swaps.
const REFERENCE_HEIGHT = 0.6996188163757324;

export async function loadLamp(scene, options = {}) {
    const {
        position = new THREE.Vector3(0.9, 0.05, 1.5),
        rotationY = -Math.PI / 4,
        // Tilts the WHOLE lamp (base included) forward/back around its own
        // local X axis, applied AFTER rotationY. Leave at 0 if you only want
        // the shade to tilt (see shadeTiltX below) -- this rotates the base
        // too, which usually isn't what you want for a lamp sitting flush on
        // a desk.
        tiltX = 0,
        // Tilts just the shade + arm/holder, leaving the base sitting flat.
        // Since this lamp.glb is a single fused mesh (no separate base/arm/
        // shade nodes to rotate individually like a normal scene-graph
        // tilt), this bends the mesh's own vertices: everything at or above
        // shadePivotFraction up the model's height rotates around a
        // horizontal hinge line by shadeTiltX radians, everything below stays
        // put. It's a hard hinge, not a smooth curve -- fine for a lamp with
        // a real joint there, but if the model's arm is itself curved/smooth
        // through that height a crease may show; lower shadeTiltX or nudge
        // shadePivotFraction to land closer to an actual seam in the model.
        shadeTiltX = 0,
        // Height fraction (0 = base, 1 = top) above which vertices get bent
        // by shadeTiltX. 0.35 is a guess at roughly where this lamp's arm
        // starts above its base -- adjust to taste; if the light (see
        // bulbHeightFraction below) is above this line it tilts along with
        // the shade, which is what you want.
        shadePivotFraction = 0.35,
        scale = 1.75,
        // Multiplies whatever emissive intensity the model already carries
        // (either baked in via KHR_materials_emissive_strength, or three.js's
        // default of 1 for a material that just has an emissiveFactor/
        // emissiveTexture with no explicit strength -- this model's case).
        emissiveBoost = 3,
        // Only applied if you pass it explicitly -- otherwise whatever
        // emissive color the material/texture was authored with is left
        // alone (this model's "Lamp" material has its own emissive texture
        // masking just the bulb/shade area, so leave this null to respect it).
        glowColor = null,
        // Real light emitted into the scene, positioned near the bulb.
        lightColor = 0xffb347,
        lightIntensity = 18,
        lightDistance = 16,
        lightDecay = 2,
        // This model is a single fused mesh (no separate "bulb" node to
        // target by name like the previous lamp.glb had), so the point
        // light is placed by height fraction up the model's own bounding
        // box instead -- 0.78 sits roughly at the shade, fwhere the emissive
        // texture actually glows. Nudge this (0 = base, 1 = very top) if the
        // light looks off relative to where the shade actually is.
        bulbHeightFraction = 0.78,
    } = options;

    const gltf = await new GLTFLoader().loadAsync('/lamp.glb');
    const model = gltf.scene;

    // Measure the model in its own raw units, then recenter it (in X/Z) and
    // drop it so its base sits on Y = 0 -- makes it behave the same as the
    // previous model regardless of how its author placed the origin (this
    // one's bounding box isn't even centered in Z: -9.88..16.45).
    const box = new THREE.Box3().setFromObject(model);
    const center = box.getCenter(new THREE.Vector3());
    const rawHeight = box.max.y - box.min.y;
    const pivotY = box.min.y + rawHeight * shadePivotFraction;

    // Rotates a raw-space point (dy, dz) around the pivot hinge by
    // shadeTiltX -- same rotation direction three.js's own object.rotateX
    // uses, so shadeTiltX's sign behaves the same way tiltX's does.
    function bendPoint(x, y, z) {
        if (shadeTiltX === 0 || y < pivotY) return [x, y, z];
        const dy = y - pivotY;
        const dz = z - center.z;
        const cos = Math.cos(shadeTiltX);
        const sin = Math.sin(shadeTiltX);
        return [x, pivotY + (dy * cos - dz * sin), center.z + (dy * sin + dz * cos)];
    }

    if (shadeTiltX !== 0) {
        // NOTE: assumes each mesh's own local space matches the model's raw
        // (un-recentered) space -- true for this lamp.glb, which is one mesh
        // with no intermediate node transforms. If a future model swap adds
        // per-node offsets/rotations above the mesh, this would need to walk
        // through obj.matrix first.
        model.traverse((obj) => {
            if (!obj.isMesh) return;
            const posAttr = obj.geometry.attributes.position;
            for (let i = 0; i < posAttr.count; i++) {
                const [bx, by, bz] = bendPoint(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i));
                posAttr.setXYZ(i, bx, by, bz);
            }
            posAttr.needsUpdate = true;
            obj.geometry.computeVertexNormals();
            obj.geometry.computeBoundingBox();
            obj.geometry.computeBoundingSphere();
        });
    }

    model.position.set(-center.x, -box.min.y, -center.z);

    let hasGlow = false;
    model.traverse((obj) => {
        if (!obj.isMesh) return;
        obj.castShadow = true;
        obj.receiveShadow = true;

        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const mat of mats) {
            if (!mat || !('emissive' in mat)) continue;
            // Only touch materials that were actually authored with a glow
            // (nonzero emissive color, and/or an emissive texture) -- so a
            // plain body/base material on a multi-material mesh is left
            // untouched, whatever model this turns out to be.
            const authoredGlow = (mat.emissive && !mat.emissive.equals(new THREE.Color(0, 0, 0)))
                || !!mat.emissiveMap;
            if (!authoredGlow && glowColor === null) continue;

            if (glowColor !== null) mat.emissive = new THREE.Color(glowColor);
            mat.emissiveIntensity = (mat.emissiveIntensity || 1) * emissiveBoost;
            hasGlow = true;
            // The glowing part shouldn't cast its own shadow blob.
            obj.castShadow = false;
        }
    });

    // Normalize to REFERENCE_HEIGHT so `scale` means the same thing no
    // matter what raw units this particular .glb was exported in.
    const normalized = new THREE.Group();
    normalized.scale.setScalar(REFERENCE_HEIGHT / rawHeight);
    normalized.add(model);

    const lamp = new THREE.Group();
    lamp.add(normalized);
    lamp.position.copy(position);
    // Order matters: THREE.Euler applies in XYZ order by default, so setting
    // .y then .x below would apply the X tilt BEFORE the Y rotation instead
    // of after it. Using rotateY/rotateX (which post-multiply, each around
    // the object's own current local axes) instead guarantees rotationY
    // happens first and tiltX tilts relative to the already-yawed lamp, not
    // relative to world space.
    lamp.rotation.set(0, 0, 0);
    lamp.rotateY(rotationY);
    lamp.rotateX(tiltX);
    lamp.scale.setScalar(scale);
    scene.add(lamp);

    // Bulb light, placed at bulbHeightFraction up the (recentered,
    // normalized) model -- i.e. in `lamp`'s own local space, so it inherits
    // lamp's position/rotation/scale correctly.
    const bulbLight = new THREE.PointLight(lightColor, lightIntensity, lightDistance, lightDecay);
    bulbLight.castShadow = true;
    bulbLight.shadow.mapSize.set(1024, 1024);
    bulbLight.shadow.bias = 0.003;
    
    // Run the bulb's raw-space position through the same bend the mesh got,
    // so the light stays with the shade instead of floating away from it
    // when shadeTiltX is set.
    const [bx, by, bz] = bendPoint(center.x, box.min.y + rawHeight * bulbHeightFraction, center.z);
    const normScale = REFERENCE_HEIGHT / rawHeight;
    bulbLight.position.set((bx - center.x) * normScale, (by - box.min.y) * normScale, (bz - center.z) * normScale);
    lamp.add(bulbLight);

    // Fill light: a softer secondary point as if the lamp's inner cavity is
    // slightly reflective and is bouncing light around the shade instead of
    // letting the bulb behave like a single bare emitter. This is the
    // lightweight, scene-friendly version of a reflective bulb interior.
    const fillLight = new THREE.PointLight(lightColor, lightIntensity * 0.85, lightDistance * 1.5, lightDecay);
    fillLight.position.set(0, REFERENCE_HEIGHT * (bulbHeightFraction - 0.06), 0.1);
    lamp.add(fillLight);

    if (!hasGlow) {
        // Nothing on this model had an authored emissive color/texture --
        // pass glowColor explicitly (e.g. { glowColor: 0xffddaa }) to force
        // a glow on it.
        console.warn('[lamp] no emissive material found on lamp.glb -- pass `glowColor` to force one.');
    }

    return lamp;
}