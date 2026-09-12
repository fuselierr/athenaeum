import * as THREE from 'three';
import { sampleTerrain } from './terrain.js';

/**
 * Grass: a field of blades, each one a single triangle, that goes where you go.
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
 * FOLLOWING YOU, FOR ALMOST NOTHING. The field is a square grid of chunks
 * centred on the camera, just big enough to reach the fade distance. When you
 * cross into a new chunk-sized cell, the chunks that fell off the back of the
 * grid wrap round to the front -- the ones furthest away move to where you
 * are going -- and nothing else changes. Moving a chunk costs one matrix:
 *
 *   - Every chunk draws the SAME blades: one tile's worth of positions, sizes
 *     and wind phases, uploaded once and shared by all their geometries.
 *   - The GROUND is a texture the vertex shader reads (the terrain's heights
 *     and slopes, from its own grid), so a blade finds its root height where
 *     the chunk has been put, with nothing recomputed on the CPU.
 *   - Whether a blade GROWS is decided there too: each has a random number,
 *     and it stands only where that is under how grassy the ground is --
 *     no steep rock, no snow, by the terrain material's own thresholds
 *     (scene/outside/terrainMaterial.js), so it thins out toward them.
 *   - A chunk is turned a quarter, a half or three quarters by a hash of its
 *     world cell, so the one tile does not read as a repeating pattern -- and
 *     the same cell always gets the same turn, so a chunk arriving there shows
 *     the same grass the last one did.
 *
 * DENSEST AROUND YOU. A tile holds more blades than distant grass needs, in
 * random order, and at any spot only the first so many of them stand: all of
 * them within a few metres of you, thinning smoothly to a fraction by the
 * fade. The shader decides that blade by blade, so there is no step in
 * density at a chunk's edge; update() hands each chunk only as many blades
 * as the densest spot in it needs, by the same curve, so the ones cut on the
 * CPU are always ones the shader would have dropped anyway.
 *
 * Three.js skips chunks out of view by their bounds, and update() hides the
 * ones past the fade.
 *
 * PARTING. Sit or lie down (input/cameraModes.js) and the blades around you
 * are pushed flat and outward, the nearest furthest -- partly for sitting,
 * fully for lying -- in a patch centred a little behind your head, where
 * your body would be, so you are down in a hollow in the grass rather than
 * with blades through your face.
 *
 * WIND. The tip leans downwind by a gust that travels across the field, plus
 * a per-blade flutter -- in world space, whichever way a chunk is turned.
 * HEIGHT WITH DISTANCE. Right where you stand the grass is short, so it never
 * walls off the view at your feet, and it grows to full height over the
 * first several metres out. Far off, blades shrink away again between two
 * distances from the camera, which hides the edge of the field and the
 * shimmer of far blades.
 *
 * LIGHT. Every blade is lit as the ground under it is -- its normal points
 * straight up, from both sides -- so it takes the sun, the sky light and the
 * shadows the terrain does. It receives shadows but does not cast them: the
 * sun's map is far too coarse for a blade.
 */

const GRASS = {
  chunkSize: 10, // metres on a side
  bladesPerChunk: 6000, // at full density, before the ground decides which of them grow
  height: [0.3, 0.75], // metres, shortest .. tallest
  width: [0.06, 0.12], // metres at the base
  baseShade: 0.35, // brightness at the root; the tip is 1
  rootColour: 0x2e5a1c,
  tipColour: 0x9cc24f,
  groundInfluence: 0.25, // how much of the ground texture shows in a blade, 0..1
  windStrength: 0.6, // how far a tip leans, as a fraction of its height
  windSpeed: 0.7,
  windDirection: [1, 0.3],
  nearHeight: 0.5, // a blade's height right where you stand, as a fraction of its full height
  fullHeightAt: 25, // metres out, along the ground, where blades reach full height
  partRadius: 1.4, // metres round you the grass parts when you sit or lie down
  partBehind: 0.6, // how far behind your head the parted patch is centred -- your body
  fadeStart: 30, // metres from the camera where blades start to shrink
  fadeEnd: 45, // and where they are gone -- the grid is sized to reach this
  denseRadius: 6, // metres along the ground where full density starts to thin
  farDensity: 0.12, // the fraction of blades still standing by fadeEnd
  textureLod: 4, // mip of the ground texture a blade reads: one averaged colour
};

/** Deterministic 0..1, so the pattern is the same every visit. */
function seeded(seed) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

/** Which quarter-turn a world cell's chunk takes: 0..3, always the same for a cell. */
function cellTurn(cx, cz) {
  let h = Math.imul(cx, 374761393) + Math.imul(cz, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) % 4;
}

/**
 * @param {object} opts
 * @param {THREE.Mesh} opts.terrain  scene/outside/terrain.js's mesh, already placed
 * @param {number} opts.terrainWidth  metres on a side
 * @param {number} opts.segments  the terrain grid's segments on a side
 * @param {THREE.Camera} opts.camera  what the field follows
 * @param {() => number} [opts.parting]  how far you are lying down, 0..1 --
 *   how much the grass parts round you
 * @returns {{ group: THREE.Group, uniforms: object, bladesPerChunk: number,
 *   chunkCount: number, drawnChunks: number, maxFadeEnd: number,
 *   update(dt: number): void, dispose(): void }}
 */
export function createGrass({ terrain, terrainWidth, segments, camera, parting = () => 0 }) {
  const ground = terrain.material.userData.uniforms;
  const size = GRASS.chunkSize;
  const { lerp, smoothstep } = THREE.MathUtils;

  // --- the ground, as a texture --------------------------------------------------
  // The terrain grid's heights (its own, before its placement) and how much
  // each point faces up, one texel per vertex. Half float: filterable
  // everywhere WebGL2 runs, where full float is not, and a few centimetres of
  // precision is plenty for where a blade's root goes.
  const columns = segments + 1;
  const heights = terrain.geometry.attributes.position;
  const normals = terrain.geometry.attributes.normal;
  const surface = new Uint16Array(columns * columns * 2);
  for (let i = 0; i < columns * columns; i++) {
    surface[i * 2] = THREE.DataUtils.toHalfFloat(heights.getY(i));
    surface[i * 2 + 1] = THREE.DataUtils.toHalfFloat(normals.getY(i));
  }
  const surfaceTexture = new THREE.DataTexture(surface, columns, columns, THREE.RGFormat, THREE.HalfFloatType);
  surfaceTexture.magFilter = THREE.LinearFilter;
  surfaceTexture.minFilter = THREE.LinearFilter;
  surfaceTexture.needsUpdate = true;

  // --- one tile of blades, shared -------------------------------------------------
  const random = seeded(2024);
  const local = new Float32Array(GRASS.bladesPerChunk * 3); // x, its own random, z
  const data = new Float32Array(GRASS.bladesPerChunk * 4); // height, width, facing, phase
  for (let i = 0; i < GRASS.bladesPerChunk; i++) {
    local.set([(random() - 0.5) * size, random(), (random() - 0.5) * size], i * 3);
    data.set([
      lerp(GRASS.height[0], GRASS.height[1], random()),
      lerp(GRASS.width[0], GRASS.width[1], random()),
      random() * Math.PI * 2,
      random() * Math.PI * 2,
    ], i * 4);
  }
  // One of each, referenced by every chunk's geometry: one upload in all.
  const bladeLocal = new THREE.InstancedBufferAttribute(local, 3);
  const bladeData = new THREE.InstancedBufferAttribute(data, 4);
  // The blade triangle. Its corners are built in the shader; these only have
  // to exist.
  const corners = new THREE.BufferAttribute(new Float32Array(9), 3);
  // Straight up. Needed as an attribute, not just in the shader: with no
  // normals on the geometry three.js silently switches a standard material to
  // flat shading, which has no vNormal for the shader to use.
  const upNormals = new THREE.BufferAttribute(new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]), 3);
  const cornerIndex = new THREE.BufferAttribute(new Float32Array([0, 1, 2]), 1);

  // --- shade ----------------------------------------------------------------------
  const uniforms = {
    grassTime: { value: 0 },
    grassWindStrength: { value: GRASS.windStrength },
    grassWindSpeed: { value: GRASS.windSpeed },
    grassWindDirection: { value: new THREE.Vector2(...GRASS.windDirection).normalize() },
    grassFadeStart: { value: GRASS.fadeStart },
    grassFadeEnd: { value: GRASS.fadeEnd },
    grassHeightScale: { value: 3 },
    grassNearHeight: { value: GRASS.nearHeight },
    grassFullHeightAt: { value: GRASS.fullHeightAt },
    grassPartCentre: { value: new THREE.Vector2() },
    grassPartRadius: { value: GRASS.partRadius },
    grassPartStrength: { value: 0 },
    grassDenseRadius: { value: GRASS.denseRadius },
    grassFarDensity: { value: GRASS.farDensity },
    grassBladesPerChunk: { value: GRASS.bladesPerChunk },
    grassWidthScale: { value: 1 },
    grassBaseShade: { value: GRASS.baseShade },
    grassTextureLod: { value: GRASS.textureLod },
    grassRootColour: { value: new THREE.Color(GRASS.rootColour) },
    grassTipColour: { value: new THREE.Color(GRASS.tipColour) },
    grassGroundInfluence: { value: GRASS.groundInfluence },
    grassSurface: { value: surfaceTexture },
    grassTerrainOffset: { value: new THREE.Vector2(terrain.position.x, terrain.position.z) },
    grassTerrainY: { value: terrain.position.y },
    grassTerrainWidth: { value: terrainWidth },
    grassSegments: { value: segments },
    // The terrain's own uniform objects, shared: the blades read the same
    // texture, tiling and growing thresholds the ground does, and follow them
    // if they change.
    grassMap: ground.grassMap,
    terrainTile: ground.terrainTile,
    terrainHeight: ground.terrainHeight,
    terrainSnowLine: ground.terrainSnowLine,
    terrainSnowFade: ground.terrainSnowFade,
    terrainRockSteep: ground.terrainRockSteep,
    terrainRockFlat: ground.terrainRockFlat,
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
        attribute vec3 bladeLocal; // x and z in the chunk; y, the blade's own random 0..1
        attribute vec4 bladeData; // height, width, facing, wind phase
        uniform float grassTime;
        uniform float grassWindStrength;
        uniform float grassWindSpeed;
        uniform vec2 grassWindDirection;
        uniform float grassFadeStart;
        uniform float grassFadeEnd;
        uniform float grassHeightScale;
        uniform float grassNearHeight;
        uniform float grassFullHeightAt;
        uniform vec2 grassPartCentre;
        uniform float grassPartRadius;
        uniform float grassPartStrength;
        uniform float grassDenseRadius;
        uniform float grassFarDensity;
        uniform float grassBladesPerChunk;
        uniform float grassWidthScale;
        uniform float grassBaseShade;
        uniform sampler2D grassSurface;
        uniform vec2 grassTerrainOffset;
        uniform float grassTerrainY;
        uniform float grassTerrainWidth;
        uniform float grassSegments;
        uniform float terrainTile;
        uniform float terrainHeight;
        uniform float terrainSnowLine;
        uniform float terrainSnowFade;
        uniform float terrainRockSteep;
        uniform float terrainRockFlat;
        varying vec2 vBladeUv;
        varying float vBladeShade;
        varying float vBladeTip;`)
      // Up, like the ground under it.
      .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = vec3(0.0, 1.0, 0.0);')
      .replace('#include <begin_vertex>', `
        // Where the chunk has put this blade, and the ground there: the
        // terrain grid's texel for this spot, filtered between its vertices.
        vec3 root = (modelMatrix * vec4(bladeLocal.x, 0.0, bladeLocal.z, 1.0)).xyz;
        vec2 grid = ((root.xz - grassTerrainOffset) / grassTerrainWidth + 0.5) * grassSegments;
        vec2 surface = textureLod(grassSurface, (clamp(grid, 0.0, grassSegments) + 0.5) / (grassSegments + 1.0), 0.0).rg;
        root.y = grassTerrainY + surface.r;

        // Whether it grows here: not on steep rock, not in snow, not off the
        // edge of the terrain -- and then only if its own number comes up.
        float grassiness = (1.0 - smoothstep(terrainSnowLine, terrainSnowLine + terrainSnowFade, surface.r / terrainHeight))
          * smoothstep(terrainRockSteep, terrainRockFlat, surface.g);
        vec2 onTerrain = step(vec2(0.0), grid) * step(grid, vec2(grassSegments));
        float grows = step(bladeLocal.y, grassiness) * onTerrain.x * onTerrain.y;

        // Densest around you. The tile's blades are in random order, so
        // keeping only the first so many of them is an even thinning; how
        // many falls with distance along the ground.
        float along = distance(root.xz, cameraPosition.xz);
        float density = mix(1.0, grassFarDensity, smoothstep(grassDenseRadius, grassFadeEnd, along));
        grows *= step(float(gl_InstanceID) + 0.5, density * grassBladesPerChunk);

        float left = 1.0 - step(0.5, bladeCorner);
        float right = step(0.5, bladeCorner) - step(1.5, bladeCorner);
        float tip = step(1.5, bladeCorner);

        float fade = (1.0 - smoothstep(grassFadeStart, grassFadeEnd, distance(root, cameraPosition))) * grows;
        // Short underfoot, growing to full height outward. Measured along the
        // ground, so standing on a slope or mid-jump does not change it.
        float growth = mix(grassNearHeight, 1.0, smoothstep(0.0, grassFullHeightAt, along));
        float bladeHeight = bladeData.x * grassHeightScale * growth * fade;
        float halfWidth = 0.5 * bladeData.y * grassWidthScale * fade;
        vec3 side = vec3(cos(bladeData.z), 0.0, sin(bladeData.z));

        // A gust rolling across the field, and each blade's own flutter -- in
        // the world, then turned into the chunk's own frame.
        float gust = sin(dot(root.xz, grassWindDirection) * 0.25 - grassTime * grassWindSpeed) * 0.5 + 0.5;
        float flutter = sin(grassTime * 2.7 * grassWindSpeed + bladeData.w) * 0.25;
        vec2 leanWorld = grassWindDirection * (gust + flutter) * grassWindStrength * bladeHeight;
        // Parted round you when you lie down: pushed away from you and flat,
        // the nearest the most.
        vec2 fromYou = root.xz - grassPartCentre;
        float parted = grassPartStrength * (1.0 - smoothstep(0.0, grassPartRadius, length(fromYou)));
        leanWorld += normalize(fromYou + vec2(1e-4)) * parted * bladeHeight * 1.4;
        vec3 lean = transpose(mat3(modelMatrix)) * vec3(leanWorld.x, 0.0, leanWorld.y);
        // Leaning, the tip also drops, so the blade keeps roughly its length.
        float rise = max(bladeHeight - 0.5 * dot(leanWorld, leanWorld) / max(bladeHeight, 1e-3), 0.0);

        // In the chunk's own space: the ground height, less where the chunk sits.
        vec3 transformed = vec3(bladeLocal.x, root.y - modelMatrix[3].y, bladeLocal.z)
          + side * halfWidth * (right - left)
          + tip * vec3(lean.x, rise, lean.z);

        // Where on the ground texture this blade grows: the terrain's own UVs.
        vBladeUv = (root.xz - grassTerrainOffset) / terrainTile;
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

  // --- the grid of chunks -----------------------------------------------------------
  const group = new THREE.Group();
  group.name = 'grass';

  // Chunks each side of the camera's own: enough for the fade to end inside.
  const reachCells = Math.ceil(GRASS.fadeEnd / size) + 1;
  const span = reachCells * 2 + 1;
  // How far a blade can reach past its chunk's square: the tallest blade at
  // the height slider's limit, leaning as far as the wind slider allows.
  const reach = GRASS.height[1] * 3 * 1.5;
  const grid = { width: terrainWidth, segments };

  const chunks = [];
  for (let i = 0; i < span * span; i++) {
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute('position', corners);
    geometry.setAttribute('normal', upNormals);
    geometry.setAttribute('bladeCorner', cornerIndex);
    geometry.setAttribute('bladeLocal', bladeLocal);
    geometry.setAttribute('bladeData', bladeData);
    geometry.instanceCount = GRASS.bladesPerChunk;
    // Set by hand in place(): computed, it would be the base triangle's.
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 0);

    const mesh = new THREE.Mesh(geometry, material);
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    // Composed only when the chunk moves, not every frame.
    mesh.matrixAutoUpdate = false;
    // Nothing clicks on grass, and a raycast would test the base triangle.
    mesh.raycast = () => {};
    group.add(mesh);
    chunks.push({ mesh, cx: 0, cz: 0, radius: 0 });
  }

  const _probes = [[-0.5, -0.5], [0, -0.5], [0.5, -0.5], [-0.5, 0], [0, 0], [0.5, 0], [-0.5, 0.5], [0, 0.5], [0.5, 0.5]];

  /** Put a chunk on world cell (cx, cz): its position, turn and bounds. */
  function place(chunk, cx, cz) {
    chunk.cx = cx;
    chunk.cz = cz;
    const x = (cx + 0.5) * size;
    const z = (cz + 0.5) * size;

    // The ground's rise and fall across the cell, for the bounds: sampled at
    // nine points, with a margin for a bump between them.
    let low = Infinity;
    let high = -Infinity;
    for (const [px, pz] of _probes) {
      const y = sampleTerrain(terrain, 'position', 1, x + px * size, z + pz * size, grid);
      low = Math.min(low, y);
      high = Math.max(high, y);
    }
    const middle = terrain.position.y + (low + high) / 2;
    const halfRise = (high - low) / 2 + 2;

    const { mesh } = chunk;
    mesh.position.set(x, middle, z);
    mesh.rotation.set(0, cellTurn(cx, cz) * (Math.PI / 2), 0);
    mesh.updateMatrix();
    const across = size / 2 + reach;
    chunk.radius = Math.sqrt(2 * across * across + (halfRise + reach) ** 2);
    mesh.geometry.boundingSphere.radius = chunk.radius;
  }

  const _camera = new THREE.Vector3();
  const _facing = new THREE.Vector3();
  let centreX = null; // the camera's cell, as of the last update
  let centreZ = null;
  let drawnChunks = 0;

  /** Lay the grid out around the camera's cell, or wrap it along after it. */
  function follow() {
    const cx = Math.floor(_camera.x / size);
    const cz = Math.floor(_camera.z / size);
    if (cx === centreX && cz === centreZ) return;
    const minX = cx - reachCells;
    const minZ = cz - reachCells;
    if (centreX === null) {
      chunks.forEach((chunk, i) => place(chunk, minX + (i % span), minZ + Math.floor(i / span)));
    } else {
      // A chunk that fell off one side of the grid comes back on the other:
      // the furthest behind move to the front, and the rest stay where they are.
      for (const chunk of chunks) {
        const wrappedX = minX + (((chunk.cx - minX) % span) + span) % span;
        const wrappedZ = minZ + (((chunk.cz - minZ) % span) + span) % span;
        if (wrappedX !== chunk.cx || wrappedZ !== chunk.cz) place(chunk, wrappedX, wrappedZ);
      }
    }
    centreX = cx;
    centreZ = cz;
  }

  console.info(`Grass: ${chunks.length} chunks of ${GRASS.bladesPerChunk.toLocaleString()} blades, following the camera.`);

  return {
    group,
    uniforms,
    bladesPerChunk: GRASS.bladesPerChunk,
    get chunkCount() { return chunks.length; },
    /** Chunks near enough to draw, as of the last update (before view culling). */
    get drawnChunks() { return drawnChunks; },
    /** The furthest the fade can end and still be inside the grid. */
    maxFadeEnd: reachCells * size - size / 2,

    /** Call every frame, after the camera has moved. */
    update(dt) {
      uniforms.grassTime.value += dt;
      camera.getWorldPosition(_camera);
      follow();

      // Lying down, the grass parts round where your body is: a little
      // behind the eye, along the way you face.
      const lying = parting();
      uniforms.grassPartStrength.value = lying;
      if (lying > 0) {
        camera.getWorldDirection(_facing);
        _facing.y = 0;
        if (_facing.lengthSq() > 1e-6) _facing.normalize();
        uniforms.grassPartCentre.value.set(
          _camera.x - _facing.x * GRASS.partBehind,
          _camera.z - _facing.z * GRASS.partBehind,
        );
      }

      // A chunk whose nearest point is past the fade has nothing left to
      // show. The rest are handed only as many of their blades as the densest
      // spot in them needs; the shader thins those further, blade by blade,
      // by the same curve.
      const fadeEnd = uniforms.grassFadeEnd.value;
      const denseRadius = uniforms.grassDenseRadius.value;
      const farDensity = uniforms.grassFarDensity.value;
      const half = size / 2;
      drawnChunks = 0;
      for (const { mesh } of chunks) {
        // Along the ground to the nearest point of the chunk's square -- the
        // shader's own measure, so never further than any blade in it.
        const dx = Math.max(0, Math.abs(_camera.x - mesh.position.x) - half);
        const dz = Math.max(0, Math.abs(_camera.z - mesh.position.z) - half);
        const nearest = Math.hypot(dx, dz);
        mesh.visible = nearest < fadeEnd;
        if (!mesh.visible) continue;
        drawnChunks += 1;
        const density = lerp(1, farDensity, smoothstep(nearest, denseRadius, fadeEnd));
        mesh.geometry.instanceCount = Math.max(1, Math.ceil(GRASS.bladesPerChunk * density));
      }
    },

    dispose() {
      for (const { mesh } of chunks) mesh.geometry.dispose();
      material.dispose();
      surfaceTexture.dispose();
    },
  };
}