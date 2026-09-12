import * as THREE from 'three';

/**
 * Grass: a field of blades, each one a single triangle.
 *
 * The technique from "Making Grass with Triangles in GLSL using Three.js"
 * (Antaeus AR). A blade starts life as three vertices at the same point on
 * the ground; the vertex shader pulls two of them apart for its base and
 * lifts the third into its tip. It is shaded dark at the root and full at the
 * tip -- ambient occlusion, cheaply.
 *
 * ITS COLOUR is its own green, root to tip, with only a little of the ground
 * texture at the spot it grows from mixed in for variety. The article colours
 * a blade entirely from the ground texture, which works when that texture is
 * grass; this scene's grass layer is rocky ground, and blades coloured and
 * lit exactly like it vanish into it.
 *
 * INSTANCED, IN CHUNKS. One triangle, drawn once per blade: the per-blade
 * data (where it grows, how tall, how wide, which way it faces, its phase in
 * the wind) is an instanced attribute, so a field of blades is a few
 * megabytes, not half a million vertices. The field is cut into square
 * chunks, each its own instanced mesh with real bounds, so only the chunks
 * that can be seen are drawn: three.js skips the ones outside the view, and
 * update() hides the ones too far away for any of their blades to have grown
 * back from the fade. All chunks share one material and one base triangle.
 *
 * WHERE IT GROWS: sampled at random in a disc around the middle of where you
 * stand, and kept everywhere except steep rock and snow, by the same
 * thresholds the terrain material blends by (scene/terrainMaterial.js), so it
 * thins out toward them instead of stopping at a line. The heightmap is
 * steep for its size, so the slope limit is what decides most of it; how many
 * blades took is logged, and shown in the debug panel.
 *
 * WIND. The tip leans downwind by a gust that travels across the field, plus
 * a per-blade flutter. Blades shrink away between two distances from the
 * camera, which hides the edge of the field and the shimmer of far blades.
 *
 * LIGHT. Every blade is lit as the ground under it is -- its normal points
 * straight up, from both sides -- so it takes the sun, the sky light and the
 * shadows the terrain does. It receives shadows but does not cast them: the
 * sun's map is far too coarse for a blade.
 */

const GRASS = {
  blades: 160000,
  radius: 45, // metres around the centre
  height: [0.3, 0.75], // metres, shortest .. tallest
  width: [0.06, 0.12], // metres at the base
  baseShade: 0.35, // brightness at the root; the tip is 1
  rootColour: 0x2e5a1c,
  tipColour: 0x9cc24f,
  groundInfluence: 0.25, // how much of the ground texture shows in a blade, 0..1
  windStrength: 0.35, // how far a tip leans, as a fraction of its height
  windSpeed: 1.2,
  windDirection: [1, 0.3],
  fadeStart: 30, // metres from the camera where blades start to shrink
  fadeEnd: 45, // and where they are gone -- chunks past this are not drawn
  chunkSize: 10, // metres on a side
  textureLod: 4, // mip of the ground texture a blade reads: one averaged colour
};

/** Deterministic 0..1, so the field is the same every visit. */
function seeded(seed) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

/**
 * @param {object} opts
 * @param {THREE.Mesh} opts.terrain  scene/terrain.js's mesh, already placed
 * @param {THREE.Vector3} opts.centre  the middle of the field, world space
 * @param {number} opts.terrainWidth  metres on a side
 * @param {number} opts.segments  the terrain grid's segments on a side
 * @param {THREE.Camera} opts.camera  what chunks are culled by distance from
 * @returns {{ group: THREE.Group, uniforms: object, count: number, chunkCount: number,
 *   drawnChunks: number, update(dt: number): void, dispose(): void }}
 */
export function createGrass({ terrain, centre, terrainWidth, segments, camera }) {
  const ground = terrain.material.userData.uniforms;
  const positions = terrain.geometry.attributes.position;
  const normals = terrain.geometry.attributes.normal;
  const columns = segments + 1;
  const { smoothstep, lerp, clamp } = THREE.MathUtils;

  /** An attribute's component at a world x/z, bilinear across the grid. */
  function sample(attribute, component, x, z) {
    const gx = ((x - terrain.position.x) / terrainWidth + 0.5) * segments;
    const gz = ((z - terrain.position.z) / terrainWidth + 0.5) * segments;
    const c = clamp(Math.floor(gx), 0, segments - 1);
    const r = clamp(Math.floor(gz), 0, segments - 1);
    const tx = gx - c;
    const tz = gz - r;
    const at = (col, row) => attribute.getComponent(row * columns + col, component);
    const top = lerp(at(c, r), at(c + 1, r), tx);
    const bottom = lerp(at(c, r + 1), at(c + 1, r + 1), tx);
    return lerp(top, bottom, tz);
  }

  /** How likely a blade is to take here, 0..1: not on steep rock, not in snow. */
  function grassiness(localHeight, up) {
    const h = localHeight / ground.terrainHeight.value;
    const snowLine = ground.terrainSnowLine.value;
    return (1 - smoothstep(h, snowLine, snowLine + ground.terrainSnowFade.value))
      * smoothstep(up, ground.terrainRockSteep.value, ground.terrainRockFlat.value);
  }

  // --- plant ------------------------------------------------------------------
  // Straight into the chunk each blade falls in.
  const random = seeded(2024);
  const planted = new Map(); // "cx,cz" -> { cx, cz, roots: [], data: [], minY, maxY }
  let count = 0;
  for (let attempt = 0; attempt < GRASS.blades * 6 && count < GRASS.blades; attempt++) {
    // Uniform over the disc: the square root spreads blades evenly by area.
    const r = GRASS.radius * Math.sqrt(random());
    const theta = random() * Math.PI * 2;
    const x = centre.x + r * Math.cos(theta);
    const z = centre.z + r * Math.sin(theta);
    const localHeight = sample(positions, 1, x, z);
    const up = sample(normals, 1, x, z);
    if (random() > grassiness(localHeight, up)) continue;

    const y = terrain.position.y + localHeight;
    const cx = Math.floor((x - centre.x) / GRASS.chunkSize);
    const cz = Math.floor((z - centre.z) / GRASS.chunkSize);
    const key = `${cx},${cz}`;
    let chunk = planted.get(key);
    if (!chunk) {
      chunk = { cx, cz, roots: [], data: [], minY: Infinity, maxY: -Infinity };
      planted.set(key, chunk);
    }
    chunk.roots.push(x, y, z);
    chunk.data.push(
      lerp(GRASS.height[0], GRASS.height[1], random()),
      lerp(GRASS.width[0], GRASS.width[1], random()),
      random() * Math.PI * 2, // facing
      random() * Math.PI * 2, // wind phase
    );
    chunk.minY = Math.min(chunk.minY, y);
    chunk.maxY = Math.max(chunk.maxY, y);
    count += 1;
  }

  console.info(
    `Grass: ${count.toLocaleString()} of ${GRASS.blades.toLocaleString()} blades took root, `
    + `in ${planted.size} chunks.`,
  );

  // The one blade triangle every chunk draws. The corners' positions are
  // built in the shader; these only have to exist.
  const corners = new THREE.BufferAttribute(new Float32Array(9), 3);
  // Straight up. Needed as an attribute, not just in the shader: with no
  // normals on the geometry three.js silently switches a standard material to
  // flat shading, which has no vNormal for the shader to use.
  const upNormals = new THREE.BufferAttribute(new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]), 3);
  const cornerIndex = new THREE.BufferAttribute(new Float32Array([0, 1, 2]), 1);

  // --- shade ------------------------------------------------------------------
  const uniforms = {
    grassTime: { value: 0 },
    grassWindStrength: { value: GRASS.windStrength },
    grassWindSpeed: { value: GRASS.windSpeed },
    grassWindDirection: { value: new THREE.Vector2(...GRASS.windDirection).normalize() },
    grassFadeStart: { value: GRASS.fadeStart },
    grassFadeEnd: { value: GRASS.fadeEnd },
    grassHeightScale: { value: 1 },
    grassWidthScale: { value: 1 },
    grassBaseShade: { value: GRASS.baseShade },
    grassTextureLod: { value: GRASS.textureLod },
    grassRootColour: { value: new THREE.Color(GRASS.rootColour) },
    grassTipColour: { value: new THREE.Color(GRASS.tipColour) },
    grassGroundInfluence: { value: GRASS.groundInfluence },
    grassTerrainOffset: { value: new THREE.Vector2(terrain.position.x, terrain.position.z) },
    // The terrain's own uniform objects, shared: the blades read the same grass
    // texture and tiling the ground does, and follow them if they change.
    grassMap: ground.grassMap,
    terrainTile: ground.terrainTile,
  };

  const material = new THREE.MeshStandardMaterial({
    roughness: 0.9,
    metalness: 0,
    side: THREE.DoubleSide,
  });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float bladeCorner; // 0 base left, 1 base right, 2 tip
        attribute vec3 bladeRoot;
        attribute vec4 bladeData; // height, width, facing, wind phase
        uniform float grassTime;
        uniform float grassWindStrength;
        uniform float grassWindSpeed;
        uniform vec2 grassWindDirection;
        uniform float grassFadeStart;
        uniform float grassFadeEnd;
        uniform float grassHeightScale;
        uniform float grassWidthScale;
        uniform float grassBaseShade;
        uniform vec2 grassTerrainOffset;
        uniform float terrainTile;
        varying vec2 vBladeUv;
        varying float vBladeShade;
        varying float vBladeTip;`)
      // Up, like the ground under it.
      .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = vec3(0.0, 1.0, 0.0);')
      .replace('#include <begin_vertex>', `
        float left = 1.0 - step(0.5, bladeCorner);
        float right = step(0.5, bladeCorner) - step(1.5, bladeCorner);
        float tip = step(1.5, bladeCorner);

        float fade = 1.0 - smoothstep(grassFadeStart, grassFadeEnd, distance(bladeRoot, cameraPosition));
        float bladeHeight = bladeData.x * grassHeightScale * fade;
        float halfWidth = 0.5 * bladeData.y * grassWidthScale * fade;
        vec3 side = vec3(cos(bladeData.z), 0.0, sin(bladeData.z));

        // A gust rolling across the field, and each blade's own flutter.
        float gust = sin(dot(bladeRoot.xz, grassWindDirection) * 0.25 - grassTime * grassWindSpeed) * 0.5 + 0.5;
        float flutter = sin(grassTime * 2.7 * grassWindSpeed + bladeData.w) * 0.25;
        vec2 lean = grassWindDirection * (gust + flutter) * grassWindStrength * bladeHeight;
        // Leaning, the tip also drops, so the blade keeps roughly its length.
        float rise = max(bladeHeight - 0.5 * dot(lean, lean) / max(bladeHeight, 1e-3), 0.0);

        vec3 transformed = bladeRoot + side * halfWidth * (right - left)
          + tip * vec3(lean.x, rise, lean.y);

        // Where on the ground texture this blade grows: the terrain's own UVs.
        vBladeUv = (bladeRoot.xz - grassTerrainOffset) / terrainTile;
        vBladeShade = mix(grassBaseShade, 1.0, tip);
        vBladeTip = tip;`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D grassMap;
        uniform float grassTextureLod;
        uniform vec3 grassRootColour;
        uniform vec3 grassTipColour;
        uniform float grassGroundInfluence;
        varying vec2 vBladeUv;
        varying float vBladeShade;
        varying float vBladeTip;`)
      // One UV for the whole blade, so a fixed, blurred mip: the automatic
      // choice would see no change across the blade and pick the sharpest.
      // The ground's colour is doubled so a mid-grey texture leaves the green
      // as it is, and only its lighter and darker patches show.
      .replace('#include <map_fragment>', `
        vec3 groundColour = textureLod(grassMap, vBladeUv, grassTextureLod).rgb * 2.0;
        vec3 bladeColour = mix(grassRootColour, grassTipColour, vBladeTip)
          * mix(vec3(1.0), groundColour, grassGroundInfluence);
        diffuseColor.rgb *= bladeColour * vBladeShade;`)
      // Lit from either side as the ground is: undo DoubleSide's normal flip.
      .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
        normal = normalize(vNormal);
        nonPerturbedNormal = normal;`);
  };

  // --- chunks -----------------------------------------------------------------
  const group = new THREE.Group();
  group.name = 'grass';

  // How far a blade can reach past its chunk's square: the tallest blade at
  // the height slider's limit, leaning as far as the wind slider allows.
  const reach = GRASS.height[1] * 3 * 1.5;

  const chunks = [];
  for (const { cx, cz, roots, data, minY, maxY } of planted.values()) {
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute('position', corners);
    geometry.setAttribute('normal', upNormals);
    geometry.setAttribute('bladeCorner', cornerIndex);
    geometry.setAttribute('bladeRoot', new THREE.InstancedBufferAttribute(new Float32Array(roots), 3));
    geometry.setAttribute('bladeData', new THREE.InstancedBufferAttribute(new Float32Array(data), 4));
    geometry.instanceCount = roots.length / 3;

    // Real bounds, set by hand: computed, they would be the base triangle's,
    // which sits at the origin. These are what frustum culling tests.
    const x0 = centre.x + cx * GRASS.chunkSize;
    const z0 = centre.z + cz * GRASS.chunkSize;
    geometry.boundingBox = new THREE.Box3(
      new THREE.Vector3(x0 - reach, minY, z0 - reach),
      new THREE.Vector3(x0 + GRASS.chunkSize + reach, maxY + reach, z0 + GRASS.chunkSize + reach),
    );
    geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(new THREE.Sphere());

    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `grass ${cx},${cz}`;
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    // Nothing clicks on grass, and a raycast would test the base triangle.
    mesh.raycast = () => {};
    group.add(mesh);
    chunks.push({ mesh, bounds: geometry.boundingSphere });
  }

  const _cameraPosition = new THREE.Vector3();
  let drawnChunks = chunks.length;

  return {
    group,
    uniforms,
    get count() { return count; },
    get chunkCount() { return chunks.length; },
    /** Chunks near enough to draw, as of the last update (before view culling). */
    get drawnChunks() { return drawnChunks; },

    /** Call every frame, after the camera has moved. */
    update(dt) {
      uniforms.grassTime.value += dt;
      // A chunk whose nearest point is past the fade has nothing left to show.
      camera.getWorldPosition(_cameraPosition);
      const fadeEnd = uniforms.grassFadeEnd.value;
      drawnChunks = 0;
      for (const { mesh, bounds } of chunks) {
        mesh.visible = bounds.distanceToPoint(_cameraPosition) < fadeEnd;
        if (mesh.visible) drawnChunks += 1;
      }
    },

    dispose() {
      for (const { mesh } of chunks) mesh.geometry.dispose();
      material.dispose();
    },
  };
}