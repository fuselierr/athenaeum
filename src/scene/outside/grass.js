import * as THREE from 'three';
import { sampleTerrain } from './terrain.js';
import { WIND, WIND_GLSL } from './wind.js';

/**
 * Grass: a field of tufts that goes where you go.
 *
 * Each instance is a modelled clump of blades cut out of an alpha mask
 * (scene/outside/grassClumps.js), stood on the ground, turned its own way and
 * leaned by the wind. It used to be one triangle a blade, built from nothing
 * in the vertex shader -- cheaper still, and fine at a distance, but a
 * triangle up close is unmistakably a triangle. It is shaded dark at the root
 * and full at the tip -- ambient occlusion, cheaply.
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
 * EVERY TUFT STANDS. There was a density scheme here once -- a share of the
 * tufts dropped with distance and another share dropped by the graphics
 * quality, decided both in the shader and again on the CPU. It is gone: what
 * a chunk holds, it draws. What thins the field now is the ground itself
 * (grassiness), the fade, and the level of detail a chunk's distance earns
 * it, which costs triangles rather than tufts and leaves no holes.
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
 * FLOWERS grow in the same field, riding the same chunks (as a child mesh of
 * each), standing on the same ground lookup, bending in the same wind and
 * parting round you the same way -- that shared GLSL is MEADOW_GLSL below.
 * Only one or two kinds grow -- GRASS.flowerKinds, picked from the catalogue
 * in GRASS.flowerSpecies, best a pair of a colour -- in bunches of one kind
 * or, some of them, both. The tile of bunches is shared, but which kind a
 * bunch is, whether it grows,
 * how full it is and how tall are hashed from the world cell it lands in, so
 * no two chunks match. Bunches crowd into drifts where a slow wave across
 * the land says so, and are scattered thinly everywhere else. Each flower is
 * a stem and a head: a face -- a small disc of rings, its petals cut out in
 * the fragment shader and their tips lifted into a cup, shaded as the cup
 * curves -- or a spike, a card of florets. A face looks its own way --
 * skyward, tipped over towards its own
 * random side, and nodding with the wind -- whichever way you look at it
 * from; only the round things, the stem and a spike, turn about their own
 * length to show you their breadth. Lit, their colour is pushed further
 * from grey than the light alone leaves it.
 *
 * LIGHT. Every blade is lit as the ground under it is -- its normal points
 * straight up, from both sides -- so it takes the sun, the sky light and the
 * shadows the terrain does. It receives shadows but does not cast them: the
 * sun's map is far too coarse for a blade.
 */

// How many patches of the field can be kept clear at once: the bench, the egg
// chair, and room for a couple more. Fixed, because the shader loops over
// them.
const CLEARINGS = 4;

const GRASS = {
  chunkSize: 10, // metres on a side
  // Tufts, not blades: each instance is a modelled clump of them, cut out of
  // an alpha mask (scene/outside/grassClumps.js). One covers about a third of
  // a metre, so a 10 m chunk wants nine hundred of them -- against the six
  // thousand single triangles this used to draw, for far more grass.
  bladesPerChunk: 900, // before the ground decides which of them grow
  height: [0.28, 0.62], // metres, shortest .. tallest

  // Below this share of the mask a pixel is a gap between blades rather than
  // a blade. Cut out, never blended: the outdoors is fogged by depth after
  // the frame is drawn (outdoorPost.js) and a blended surface writes none.
  bladeCutoff: 0.32,
  // How much of a tuft's own shape shows in its shading: 0 lit flat like the
  // ground under it, 1 fully its own. A little keeps the clumps from reading
  // as one green mass without carving dark holes in the field.
  clumpRelief: 0.15,
  // Where the chunks step down a level of detail, in metres from the camera.
  // The far one is past the fade, so the coarsest level is what thins away.
  clumpLod: [14, 28],
  baseShade: 0.35, // brightness at the root; the tip is 1
  rootColour: 0x2e5a1c,
  tipColour: 0x8fc22b,
  // A second tip, and the noise field says which of the two a patch of the
  // meadow wears -- FluffyGrass's trick, and most of why its field does not
  // read as one flat green. Large and slow: this is the meadow having
  // lighter and darker ground, not a pattern.
  tipColourShade: 0x508a1d,
  colourPatch: 550, // metres across one patch of colour
  groundInfluence: 0.05, // how much of the ground texture shows in a blade, 0..1
  windStrength: 0.6, // how far a tip leans, as a fraction of its height
  // The wind itself is the meadow's, not the grass's: the tree standing in
  // the field leans in the same gust (scene/outside/wind.js).
  windSpeed: WIND.speed,
  windDirection: WIND.direction,
  nearHeight: 0.5, // a blade's height right where you stand, as a fraction of its full height
  fullHeightAt: 25, // metres out, along the ground, where blades reach full height
  partRadius: 1.4, // metres round you the grass parts when you sit or lie down
  partBehind: 0.6, // how far behind your head the parted patch is centred -- your body
  fadeStart: 30, // metres from the camera where blades start to shrink
  fadeEnd: 45, // and where they are gone -- the grid is sized to reach this
  textureLod: 4, // mip of the ground texture a blade reads: one averaged colour
  // Flowers.
  bunchesPerChunk: 128, // before the patches and the ground decide which grow
  flowersPerBunch: [1, 8],
  bunchSpread: [0.25, 1.1], // metres, a bunch's radius
  flowerScatter: 0.2, // the chance a bunch grows outside a drift; inside one, every bunch does
  flowerKinds: ['cornflower', 'lavender'], // which of flowerSpecies grow: one or two, best of a colour
  mixedBunches: 0.4, // with two kinds, the share of bunches that hold both
  mixedShare: 0.35, // and in one of those, the share that is the other kind
  petalShading: 0.7, // how much a face is lit by its cup's own curve, 0 flat like the ground .. 1 fully
  flowerVibrance: 1.25, // saturation of a lit flower: 1 as the light leaves it, more for more colour
  flowerStemWidth: 0.01, // metres at the root, times the height scale
  flowerTilt: [0.2, 0.95], // radians a face tips over from looking straight up, least .. most
  flowerNod: 0.6, // how far the wind and you tip a face on top of that, as a share of the stem's lean
  // Sizes, on top of each kind's own range: a whole bunch bigger or smaller,
  // then each flower in it -- mostly the smaller end, the odd big one. Heads
  // take all of it; stems only some, so small flowers still reach the light.
  bunchScale: [0.7, 1.4],
  flowerScale: [0.5, 1.8],
  stemScaleShare: 0.5, // 0 stems ignore the flower's size .. 1 they grow with it as the head does
  // petal, heart: colours. petals: how many round the heart. cut: how deep
  // the gaps between them go, 0 a plain disc .. 1 separate petals.
  // heartSize: its radius, a fraction of the head's. head: metres across,
  // times the height scale. stem: a fraction of the tallest blade, so heads
  // sit among the tips. A spike is a column of florets up the stem instead
  // of a face, fading from the petal colour at its foot to the heart's at
  // its tip. cup: how far a face's petals lift towards their tips, as a
  // share of its radius -- 0 flat, 1 a deep cup, below 0 bent back. dome:
  // how far its heart bulges up in the middle.
  // Pairs of a colour: poppy and marigold, daisy and buttercup, cornflower
  // and lavender, cosmos and lavender.
  flowerSpecies: [
    { name: 'daisy', petal: 0xffffff, heart: 0xffc21a, petals: 14, cut: 0.8, heartSize: 0.28, cup: 0.25, dome: 0.25, head: [0.05, 0.08], stem: [0.55, 0.85] },
    { name: 'poppy', petal: 0xff2410, heart: 0x1a0a10, petals: 4, cut: 0.3, heartSize: 0.2, cup: 0.7, dome: 0.05, head: [0.07, 0.11], stem: [0.75, 1.05] },
    { name: 'buttercup', petal: 0xffd000, heart: 0xff8a00, petals: 5, cut: 0.45, heartSize: 0.3, cup: 1.0, dome: 0.1, head: [0.035, 0.05], stem: [0.45, 0.7] },
    { name: 'cornflower', petal: 0x2a63ff, heart: 0x1a1f8a, petals: 9, cut: 0.65, heartSize: 0.25, cup: 0.45, dome: 0.15, head: [0.045, 0.065], stem: [0.6, 0.9] },
    { name: 'cosmos', petal: 0xff3aa0, heart: 0xffe14d, petals: 8, cut: 0.5, heartSize: 0.22, cup: 0.2, dome: 0.1, head: [0.06, 0.09], stem: [0.7, 1.0] },
    { name: 'marigold', petal: 0xff7400, heart: 0xc23a00, petals: 11, cut: 0.25, heartSize: 0.3, cup: 0.4, dome: 0.3, head: [0.05, 0.075], stem: [0.5, 0.75] },
    { name: 'lavender', petal: 0x8a3dff, heart: 0xd8b0ff, spike: true, head: [0.03, 0.04], stem: [0.6, 0.9] },
  ],
};

/**
 * The GLSL grass blades and flowers share: the ground under a point, how
 * grassy it is there, how much a thing growing there keeps of its size, and
 * which way the wind and you push it. Declared here once so the two cannot
 * drift apart.
 */
const MEADOW_GLSL = /* glsl */`
  ${WIND_GLSL}
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
  // Patches kept clear, for things standing in the field: x, z and radius,
  // a radius of 0 marking a slot unused. A few, not one -- the bench and the
  // egg chair each need their own. See setClearing.
  uniform vec3 grassClearings[${CLEARINGS}];
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

  // Where the chunk puts a point at chunk-local x/z, standing on the ground:
  // the terrain grid's texel for that spot, filtered between its vertices.
  // Also how grassy the ground is there -- 0 on steep rock, in snow, or off
  // the edge of the terrain.
  vec3 meadowGround(vec2 localXZ, out float grassiness) {
    vec3 root = (modelMatrix * vec4(localXZ.x, 0.0, localXZ.y, 1.0)).xyz;
    vec2 grid = ((root.xz - grassTerrainOffset) / grassTerrainWidth + 0.5) * grassSegments;
    vec2 surface = textureLod(grassSurface, (clamp(grid, 0.0, grassSegments) + 0.5) / (grassSegments + 1.0), 0.0).rg;
    root.y = grassTerrainY + surface.r;
    vec2 onTerrain = step(vec2(0.0), grid) * step(grid, vec2(grassSegments));
    grassiness = (1.0 - smoothstep(terrainSnowLine, terrainSnowLine + terrainSnowFade, surface.r / terrainHeight))
      * smoothstep(terrainRockSteep, terrainRockFlat, surface.g)
      * onTerrain.x * onTerrain.y;
    return root;
  }

  // How much of its size something growing at root keeps: all of it near,
  // none past the fade -- and none in a clearing, kept for something standing
  // in the field (the bench, the egg chair).
  float meadowFade(vec3 root) {
    float fade = 1.0 - smoothstep(grassFadeStart, grassFadeEnd, distance(root, cameraPosition));
    for (int i = 0; i < ${CLEARINGS}; i++) {
      vec3 clearing = grassClearings[i];
      if (clearing.z > 0.0) {
        fade *= smoothstep(clearing.z * 0.6, clearing.z, distance(root.xz, clearing.xy));
      }
    }
    return fade;
  }

  // Short underfoot, growing to full height outward. Measured along the
  // ground, so standing on a slope or mid-jump does not change it.
  float meadowGrowth(float along) {
    return mix(grassNearHeight, 1.0, smoothstep(0.0, grassFullHeightAt, along));
  }

  // Where the top of something that tall is pushed, in the world: the wind
  // where it stands and a stir of its own, and -- when you sit or lie down --
  // away from you and flat, the nearest the most.
  vec2 meadowLean(vec3 root, float height) {
    // The wind where it stands, and nothing else. There was a per-tuft stir
    // here -- a second, much smaller and much faster lookup, meant to keep
    // neighbours from moving as one piece -- and it was the jitter: a
    // six-metre pattern crossing at six metres a second is not weather, it is
    // static. The field's own two scales do that job across the meadow, which
    // is how FluffyGrass does it too: the grass moves with the wind, full
    // stop.
    float gust = windGust(root.xz, grassTime, grassWindDirection, grassWindSpeed);
    vec2 lean = grassWindDirection * gust * grassWindStrength * height;
    vec2 fromYou = root.xz - grassPartCentre;
    float parted = grassPartStrength * (1.0 - smoothstep(0.0, grassPartRadius, length(fromYou)));
    return lean + normalize(fromYou + vec2(1e-4)) * parted * height * 1.4;
  }
`;

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
 *   chunkCount: number, drawnChunks: number, maxFadeEnd: number, showFlowers: boolean,
 *   update(dt: number): void, dispose(): void }}
 */
export function createGrass({
  terrain, terrainWidth, segments, camera, parting = () => 0, clumps, wind,
}) {
  const ground = terrain.material.userData.uniforms;
  const size = GRASS.chunkSize;
  const { lerp } = THREE.MathUtils;

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
  const data = new Float32Array(GRASS.bladesPerChunk * 3); // height, facing, phase
  for (let i = 0; i < GRASS.bladesPerChunk; i++) {
    local.set([(random() - 0.5) * size, random(), (random() - 0.5) * size], i * 3);
    data.set([
      lerp(GRASS.height[0], GRASS.height[1], random()),
      random() * Math.PI * 2,
      random() * Math.PI * 2,
    ], i * 3);
  }
  // One of each, referenced by every chunk's geometry: one upload in all.
  const bladeLocal = new THREE.InstancedBufferAttribute(local, 3);
  const bladeData = new THREE.InstancedBufferAttribute(data, 3);
  // The tuft itself, at each level of detail, standing 1 unit tall with its
  // root at the origin (scene/outside/grassClumps.js). Every chunk's geometry
  // borrows these attributes rather than owning a copy.
  const levels = clumps.levels;

  // --- one tile of flowers, shared ---------------------------------------------------
  // In bunches: each a centre, a reach and a number of flowers, crowding
  // towards the middle with the odd one wandered off. What each bunch is
  // beyond that is up to the shader, per world cell.
  const flowerRandom = seeded(7331);
  const flowerLocalData = [];
  const flowerInfo = [];
  for (let bunch = 0; bunch < GRASS.bunchesPerChunk; bunch++) {
    const bunchX = (flowerRandom() - 0.5) * size;
    const bunchZ = (flowerRandom() - 0.5) * size;
    const spread = lerp(GRASS.bunchSpread[0], GRASS.bunchSpread[1], flowerRandom());
    const count = Math.round(lerp(GRASS.flowersPerBunch[0], GRASS.flowersPerBunch[1], flowerRandom()));
    for (let i = 0; i < count; i++) {
      const angle = flowerRandom() * Math.PI * 2;
      const out = spread * flowerRandom() * (flowerRandom() < 0.15 ? 1.8 : 1);
      // x, its own random, z
      flowerLocalData.push(bunchX + Math.cos(angle) * out, flowerRandom(), bunchZ + Math.sin(angle) * out);
      // stem random, head random, facing, and the bunch's index -- the
      // fraction another random of its own, for whether it is a mixed bunch's other kind.
      flowerInfo.push(flowerRandom(), flowerRandom(), flowerRandom() * Math.PI * 2, bunch + flowerRandom() * 0.999);
    }
  }
  // In bunch order, so the quality's thinning drops whole bunches.
  const flowersPerChunk = flowerInfo.length / 4;
  const flowerLocal = new THREE.InstancedBufferAttribute(new Float32Array(flowerLocalData), 3);
  const flowerData = new THREE.InstancedBufferAttribute(new Float32Array(flowerInfo), 4);

  // A flower's shape, at unit size, in three parts (flowerPart):
  //   0  the stem, a sliver from the root (y 0) to the top (y 1) across x;
  //   1  a face, a disc of rings round a centre on the top, x and y across
  //      it -- rings, so the shader can lift the petals into a cup;
  //   2  a spike, a card centred on the top.
  // Every flower has both heads; the shader folds away whichever its kind
  // is not, to a point, which draws nothing.
  const FACE_SEGMENTS = 16;
  // The rim ring reaches past the unit circle, so the petal tips between
  // two of its corners are not clipped by the straight edge.
  const FACE_RINGS = [0.3, 0.65, 1 / Math.cos(Math.PI / FACE_SEGMENTS)];
  const shapeData = [-0.5, 0, 0, 0.5, 0, 0, 0, 1, 0];
  const uvData = [0, 0, 1, 0, 0.5, 1];
  const partData = [0, 0, 0];
  const indexData = [0, 1, 2];

  const faceCentre = shapeData.length / 3;
  shapeData.push(0, 0, 0);
  uvData.push(0.5, 0.5);
  partData.push(1);
  for (const radius of FACE_RINGS) {
    for (let k = 0; k < FACE_SEGMENTS; k++) {
      const angle = (k / FACE_SEGMENTS) * Math.PI * 2;
      const x = Math.cos(angle) * radius * 0.5;
      const y = Math.sin(angle) * radius * 0.5;
      shapeData.push(x, y, 0);
      uvData.push(0.5 + x, 0.5 + y);
      partData.push(1);
    }
  }
  const ringVertex = (ring, k) => faceCentre + 1 + ring * FACE_SEGMENTS + (k % FACE_SEGMENTS);
  for (let k = 0; k < FACE_SEGMENTS; k++) indexData.push(faceCentre, ringVertex(0, k), ringVertex(0, k + 1));
  for (let ring = 1; ring < FACE_RINGS.length; ring++) {
    for (let k = 0; k < FACE_SEGMENTS; k++) {
      const a = ringVertex(ring - 1, k);
      const b = ringVertex(ring - 1, k + 1);
      const c = ringVertex(ring, k);
      const d = ringVertex(ring, k + 1);
      indexData.push(a, c, d, a, d, b);
    }
  }

  const spikeCorner = shapeData.length / 3;
  shapeData.push(-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0);
  uvData.push(0, 0, 1, 0, 1, 1, 0, 1);
  partData.push(2, 2, 2, 2);
  indexData.push(spikeCorner, spikeCorner + 1, spikeCorner + 2, spikeCorner, spikeCorner + 2, spikeCorner + 3);

  const flowerShape = new THREE.BufferAttribute(new Float32Array(shapeData), 3);
  const flowerUvs = new THREE.BufferAttribute(new Float32Array(uvData), 2);
  const flowerPart = new THREE.BufferAttribute(new Float32Array(partData), 1);
  // Placeholders: the shader writes the real normals.
  const flowerNormals = new THREE.BufferAttribute(
    new Float32Array(Array.from({ length: partData.length }, () => [0, 1, 0]).flat()), 3,
  );
  const flowerIndex = new THREE.BufferAttribute(new Uint16Array(indexData), 1);

  // --- shade ----------------------------------------------------------------------
  const uniforms = {
    grassTime: { value: 0 },
    grassWindStrength: { value: GRASS.windStrength },
    grassWindSpeed: { value: GRASS.windSpeed },
    grassWindDirection: { value: new THREE.Vector2(...GRASS.windDirection).normalize() },
    grassFadeStart: { value: GRASS.fadeStart },
    grassFadeEnd: { value: GRASS.fadeEnd },
    grassClearings: { value: Array.from({ length: CLEARINGS }, () => new THREE.Vector3()) },
    grassHeightScale: { value: 3 },
    grassNearHeight: { value: GRASS.nearHeight },
    grassFullHeightAt: { value: GRASS.fullHeightAt },
    grassPartCentre: { value: new THREE.Vector2() },
    grassPartRadius: { value: GRASS.partRadius },
    grassPartStrength: { value: 0 },
    grassBaseShade: { value: GRASS.baseShade },
    grassClumpRelief: { value: GRASS.clumpRelief },
    grassBlades: { value: clumps.blades },
    grassTipShade: { value: new THREE.Color(GRASS.tipColourShade) },
    grassColourPatch: { value: GRASS.colourPatch },
    // The wind, shared with the tree (scene/outside/wind.js). Merged in
    // rather than kept apart so both this module's materials and the debug
    // panel reach it the same way as everything else here.
    ...wind,

    grassBladeCutoff: { value: GRASS.bladeCutoff },
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
        attribute vec3 bladeLocal; // x and z in the chunk; y, the tuft's own random 0..1
        attribute vec3 bladeData; // height, facing, wind phase
        uniform float grassBaseShade;
        uniform float grassClumpRelief;
        uniform float grassColourPatch;
        ${MEADOW_GLSL}
        varying vec2 vBladeUv;
        varying vec2 vClumpUv;
        varying float vBladeShade;
        varying float vBladeTip;
        varying float vGrassPatch;`)
      // Mostly up, like the ground under it, with a little of the tuft's own
      // shape mixed in -- turned the way the tuft is turned.
      .replace('#include <beginnormal_vertex>', `
        float clumpTurn = bladeData.y;
        float clumpCos = cos(clumpTurn);
        float clumpSin = sin(clumpTurn);
        vec3 clumpNormal = vec3(
          normal.x * clumpCos - normal.z * clumpSin,
          normal.y,
          normal.x * clumpSin + normal.z * clumpCos);
        vec3 objectNormal = normalize(mix(vec3(0.0, 1.0, 0.0), clumpNormal, grassClumpRelief));`)
      .replace('#include <begin_vertex>', `
        // Where the chunk has put this tuft, on the ground -- and whether it
        // grows there: only where the ground is grassy, and then only if its
        // own number comes up.
        float grassiness;
        vec3 root = meadowGround(bladeLocal.xz, grassiness);
        float grows = step(bladeLocal.y, grassiness);

        // How far out it is, for how tall it grows and how much of it is
        // left by the fade.
        float along = distance(root.xz, cameraPosition.xz);

        float fade = meadowFade(root) * grows;
        float clumpHeight = bladeData.x * grassHeightScale * meadowGrowth(along) * fade;

        // The tuft stands 1 unit tall in its own model, so its height IS its
        // scale. How far up it a vertex sits is its own y, for the same
        // reason -- which is what the wind leans and what the colour runs
        // along, root to tip.
        float up = clamp(position.y, 0.0, 1.0);
        vec3 spun = vec3(
          position.x * clumpCos - position.z * clumpSin,
          position.y,
          position.x * clumpSin + position.z * clumpCos) * clumpHeight;

        // Wind and parting in the world, then turned into the chunk's own frame.
        vec2 leanWorld = meadowLean(root, clumpHeight);
        vec3 lean = transpose(mat3(modelMatrix)) * vec3(leanWorld.x, 0.0, leanWorld.y);

        // In the chunk's own space: the ground height, less where the chunk
        // sits. The lean is weighted by how far up the tuft the vertex is, so
        // the roots stay planted and the tips travel.
        vec3 transformed = vec3(bladeLocal.x, root.y - modelMatrix[3].y, bladeLocal.z)
          + spun
          + vec3(lean.x, 0.0, lean.z) * up * up;

        // Where on the ground texture this tuft grows: the terrain's own UVs.
        vBladeUv = (root.xz - grassTerrainOffset) / terrainTile;
        // V flipped: the mask is authored the other way up from the card's
        // own UVs, so read straight through it plants the tufts on their
        // tips. FluffyGrass flips it in its vertex shader for the same
        // reason.
        vClumpUv = vec2(uv.x, 1.0 - uv.y);
        vBladeShade = mix(grassBaseShade, 1.0, up);
        vBladeTip = up;
        // Which way this patch of the meadow is coloured. Read here rather
        // than per pixel: it is one value over a whole tuft, and it changes
        // over tens of metres.
        vGrassPatch = textureLod(windNoise, root.xz / grassColourPatch, 0.0).r;`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D grassMap;
        uniform sampler2D grassBlades;
        uniform float grassBladeCutoff;
        uniform float grassTextureLod;
        uniform vec3 grassRootColour;
        uniform vec3 grassTipColour;
        uniform vec3 grassTipShade;
        uniform float grassGroundInfluence;
        varying vec2 vBladeUv;
        varying vec2 vClumpUv;
        varying float vBladeShade;
        varying float vBladeTip;
        varying float vGrassPatch;`)
      // The blades themselves, cut out of the card's mask before anything
      // else is worked out for a pixel that is a gap between them.
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
        if (texture2D(grassBlades, vClumpUv).r < grassBladeCutoff) discard;`)
      // One UV for the whole blade, so a fixed, blurred mip: the automatic
      // choice would see no change across the blade and pick the sharpest.
      // The ground's colour is doubled so a mid-grey texture leaves the green
      // as it is, and only its lighter and darker patches show.
      .replace('#include <map_fragment>', `
        vec3 groundColour = textureLod(grassMap, vBladeUv, grassTextureLod).rgb * 2.0;
        // The tip is one of two greens by where in the meadow it stands.
        vec3 tip = mix(grassTipColour, grassTipShade, vGrassPatch);
        vec3 bladeColour = mix(grassRootColour, tip, vBladeTip)
          * mix(vec3(1.0), groundColour, grassGroundInfluence);
        diffuseColor.rgb *= bladeColour * vBladeShade;`)
      // Lit from either side as the ground is: undo DoubleSide's normal flip.
      .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
        normal = normalize(vNormal);
        nonPerturbedNormal = normal;`);
  };

  // The kinds that grow, out of the catalogue.
  let species = GRASS.flowerKinds
    .map((name) => GRASS.flowerSpecies.find((kind) => kind.name === name))
    .filter(Boolean);
  if (species.length !== GRASS.flowerKinds.length) {
    console.warn(`Grass: unknown flower kinds in ${GRASS.flowerKinds.join(', ')}; growing only the ones found.`);
  }
  if (!species.length) species = [GRASS.flowerSpecies[0]];
  const flowerUniforms = {
    flowerPetal: { value: species.map((kind) => new THREE.Color(kind.petal)) },
    flowerHeart: { value: species.map((kind) => new THREE.Color(kind.heart)) },
    flowerForm: {
      value: species.map((kind) => new THREE.Vector4(kind.petals ?? 0, kind.cut ?? 0, kind.heartSize ?? 0, kind.spike ? 1 : 0)),
    },
    flowerSize: { value: species.map((kind) => new THREE.Vector4(kind.head[0], kind.head[1], kind.stem[0], kind.stem[1])) },
    flowerCup: { value: species.map((kind) => new THREE.Vector2(kind.cup ?? 0, kind.dome ?? 0)) },
    flowerMixed: { value: new THREE.Vector2(GRASS.mixedBunches, GRASS.mixedShare) },
    flowerPetalShading: { value: GRASS.petalShading },
    flowersPerChunk: { value: flowersPerChunk },
    flowerChunkSize: { value: size },
    flowerScatter: { value: GRASS.flowerScatter },
    flowerVibrance: { value: GRASS.flowerVibrance },
    flowerStemWidth: { value: GRASS.flowerStemWidth },
    flowerTilt: { value: new THREE.Vector2(...GRASS.flowerTilt) },
    flowerNod: { value: GRASS.flowerNod },
    flowerBunchScale: { value: new THREE.Vector2(...GRASS.bunchScale) },
    flowerOwnScale: { value: new THREE.Vector2(...GRASS.flowerScale) },
    flowerStemScaleShare: { value: GRASS.stemScaleShare },
    grassTallest: { value: GRASS.height[1] },
  };

  const flowerMaterial = new THREE.MeshStandardMaterial({
    roughness: 0.9,
    metalness: 0,
    side: THREE.DoubleSide,
  });
  flowerMaterial.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms, flowerUniforms);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float flowerPart; // 0 stem, 1 face, 2 spike
        attribute vec3 flowerLocal; // x and z in the chunk; y, its own random 0..1
        attribute vec4 flowerData; // stem random, head random, facing, bunch index + its own random
        uniform vec3 flowerPetal[${species.length}];
        uniform vec3 flowerHeart[${species.length}];
        uniform vec4 flowerForm[${species.length}]; // petals, cut, heart size, spike
        uniform vec4 flowerSize[${species.length}]; // head min, max; stem min, max
        uniform vec2 flowerCup[${species.length}]; // cup, dome
        uniform vec2 flowerMixed; // share of bunches with both kinds; in one, share of the other
        uniform float flowerPetalShading;
        uniform float flowersPerChunk;
        uniform float flowerChunkSize;
        uniform float flowerScatter;
        uniform float flowerStemWidth;
        uniform vec2 flowerTilt;
        uniform float flowerNod;
        uniform vec2 flowerBunchScale;
        uniform vec2 flowerOwnScale;
        uniform float flowerStemScaleShare;
        uniform float grassTallest;
        ${MEADOW_GLSL}
        varying vec2 vFlowerUv;
        varying float vFlowerHead;
        varying vec3 vFlowerPetal;
        varying vec3 vFlowerHeart;
        varying vec4 vFlowerForm;
        varying float vFlowerSpin;
        varying float vFlowerTint;

        // A well-mixed 32-bit hash, and one as 0..1.
        uint flowerHash(uint x) {
          x ^= x >> 16u;
          x *= 0x7feb352du;
          x ^= x >> 15u;
          x *= 0x846ca68bu;
          x ^= x >> 16u;
          return x;
        }
        float flowerUnit(uint x) { return float(x >> 8u) / 16777216.0; }`)
      .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = vec3(0.0, 1.0, 0.0);')
      .replace('#include <begin_vertex>', `
        float grassiness;
        vec3 root = meadowGround(flowerLocal.xz, grassiness);

        // The bunch's own numbers: from the world cell this chunk stands on
        // and which bunch of the tile it is, so the same every visit and
        // different from one cell to the next.
        ivec2 flowerCell = ivec2(floor(modelMatrix[3].xz / flowerChunkSize)) + 32768;
        uint bunchSeed = flowerHash(
          uint(flowerCell.x) * 73856093u ^ uint(flowerCell.y) * 19349663u ^ uint(flowerData.w) * 83492791u);
        float bunchChance = flowerUnit(bunchSeed);
        float bunchFull = mix(0.35, 1.0, flowerUnit(flowerHash(bunchSeed + 2u)));
        float bunchHead = mix(0.8, 1.25, flowerUnit(flowerHash(bunchSeed + 3u)));
        float bunchStem = mix(0.85, 1.15, flowerUnit(flowerHash(bunchSeed + 4u)));

        // How big: the bunch as a whole, then this one flower of it -- its
        // own number, from the bunch's and which flower of the tile it is,
        // squared so most are nearer the small end.
        float bunchScale = mix(flowerBunchScale.x, flowerBunchScale.y, flowerUnit(flowerHash(bunchSeed + 5u)));
        float ownDraw = flowerUnit(flowerHash(bunchSeed ^ (uint(gl_InstanceID) * 2654435761u + 6u)));
        float flowerScale = bunchScale * mix(flowerOwnScale.x, flowerOwnScale.y, ownDraw * ownDraw);
        float stemScale = pow(flowerScale, flowerStemScaleShare);

        // Its kind -- and in a mixed bunch, some of them the other kind.
        int kinds = ${species.length};
        int kind = int(flowerUnit(flowerHash(bunchSeed + 1u)) * float(kinds));
        float mixedBunch = step(flowerUnit(flowerHash(bunchSeed + 7u)), flowerMixed.x);
        if (mixedBunch * step(fract(flowerData.w), flowerMixed.y) > 0.5) kind += 1;
        kind = kind % kinds;
        vec4 kindForm = flowerForm[kind];
        vec4 kindSize = flowerSize[kind];
        vec2 kindCup = flowerCup[kind];

        // Every bunch grows inside a drift -- a slow wave across the land, a
        // hundred metres or so from one to the next -- and only some outside.
        // Then only on grassy ground, only as full as the bunch is, and only
        float patchField = sin(root.x * 0.043 + 1.7) * sin(root.z * 0.051 - 0.4) * 0.5 + 0.5;
        float inPatch = smoothstep(0.4, 0.75, patchField);
        float grows = step(bunchChance, mix(flowerScatter, 1.0, inPatch))
          * step(flowerLocal.y, min(grassiness, bunchFull));

        float along = distance(root.xz, cameraPosition.xz);
        float scale = meadowFade(root) * grows;
        float stemHeight = mix(kindSize.z, kindSize.w, flowerData.x) * bunchStem * stemScale
          * grassTallest * grassHeightScale * meadowGrowth(along) * scale;
        float headSize = mix(kindSize.x, kindSize.y, flowerData.y) * bunchHead * flowerScale
          * grassHeightScale * scale;

        // In the world, from the root: the top of the stem, pushed by the
        // wind and by you, and which ways are towards you and to your right.
        vec2 leanWorld = meadowLean(root, stemHeight);
        float rise = max(stemHeight - 0.5 * dot(leanWorld, leanWorld) / max(stemHeight, 1e-3), 0.0);
        vec3 top = vec3(leanWorld.x, rise, leanWorld.y);
        vec3 stemUp = normalize(top + vec3(0.0, 1e-4, 0.0));
        vec3 toYou = normalize(cameraPosition - root - top);
        vec3 yourRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);

        // The stem: a sliver from the root to the top, broadside on to you.
        vec3 stemSide = normalize(cross(stemUp, toYou) + vec3(1e-4, 0.0, 0.0));
        vec3 stem = top * position.y
          + stemSide * position.x * flowerStemWidth * stemScale * grassHeightScale * scale;

        // The head. A face looks its own way, fixed in the world: up, tipped
        // over towards its facing by its own amount, and nodding further
        // along the stem's lean. Its sides run across that, so it spins with
        // nothing but its own petals. A spike stands along its stem, turning
        // only about it, its foot just below the top.
        float facing = flowerData.z;
        float tilt = mix(flowerTilt.x, flowerTilt.y, fract(facing * 5.17));
        vec3 faceOut = vec3(cos(facing) * sin(tilt), cos(tilt), sin(facing) * sin(tilt));
        faceOut = normalize(faceOut + vec3(leanWorld.x, 0.0, leanWorld.y) / max(stemHeight, 1e-3) * flowerNod);
        vec3 faceAcross = vec3(-sin(facing), 0.0, cos(facing));
        vec3 faceRight = normalize(faceAcross - dot(faceAcross, faceOut) * faceOut);
        vec3 faceUp = cross(faceOut, faceRight);

        // Across the face, -1..1, and how far out. The petals lift towards
        // their tips -- the cup, each flower's a little deeper or shallower,
        // and uneven round the rim -- and the heart bulges in the middle.
        vec2 faceAt = position.xy * 2.0;
        float faceR2 = dot(faceAt, faceAt);
        float cup = kindCup.x * mix(0.75, 1.25, fract(facing * 2.93))
          * (1.0 + 0.3 * sin(atan(faceAt.y, faceAt.x + 1e-5) * 3.0 + facing * 7.0));
        float lift = cup * faceR2 + kindCup.y * (1.0 - smoothstep(0.0, 0.35, sqrt(faceR2)));
        vec3 face = top + (faceRight * faceAt.x + faceUp * faceAt.y + faceOut * lift) * 0.5 * headSize;
        // Which way the cup's surface faces there: out, less the slope of
        // the lift across it.
        vec3 cupNormal = normalize(faceOut - 2.0 * cup * (faceRight * faceAt.x + faceUp * faceAt.y));

        vec3 spikeRight = normalize(yourRight - dot(yourRight, stemUp) * stemUp);
        vec3 spikeCard = top + (spikeRight * position.x + stemUp * (position.y * 3.5 + 1.5)) * headSize;

        // Only the head its kind has: the other folds away to the top.
        float spike = kindForm.w;
        float isFace = step(0.5, flowerPart) * (1.0 - step(1.5, flowerPart));
        float isSpike = step(1.5, flowerPart);
        vec3 offset = stem * (1.0 - isFace - isSpike)
          + mix(face, top, spike) * isFace
          + mix(top, spikeCard, spike) * isSpike;

        // Into the chunk's own frame, standing on the ground.
        mat3 worldToChunk = transpose(mat3(modelMatrix));
        vec3 transformed = vec3(flowerLocal.x, root.y - modelMatrix[3].y, flowerLocal.z) + worldToChunk * offset;

        // Lit up like the ground, but a face partly by its own curve, so the
        // side of the cup towards the sun is the bright one.
        vec3 flowerNormal = normalize(mix(vec3(0.0, 1.0, 0.0), cupNormal, isFace * (1.0 - spike) * flowerPetalShading));
        transformedNormal = normalMatrix * (worldToChunk * flowerNormal);
        vNormal = normalize(transformedNormal);

        vFlowerUv = uv;
        vFlowerHead = min(flowerPart, 1.0);
        vFlowerPetal = flowerPetal[kind];
        vFlowerHeart = flowerHeart[kind];
        vFlowerForm = kindForm;
        vFlowerSpin = flowerData.z;
        vFlowerTint = mix(0.85, 1.0, fract(flowerData.z * 3.71));`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform vec3 grassRootColour;
        uniform float flowerVibrance;
        varying vec2 vFlowerUv;
        varying float vFlowerHead;
        varying vec3 vFlowerPetal;
        varying vec3 vFlowerHeart;
        varying vec4 vFlowerForm;
        varying float vFlowerSpin;
        varying float vFlowerTint;`)
      .replace('#include <map_fragment>', `
        vec3 flowerColour = grassRootColour * 1.3; // the stem
        if (vFlowerHead > 0.5) {
          if (vFlowerForm.w > 0.5) {
            // A spike: tiers of little rounded florets, swinging side to
            // side and narrowing to the tip, the colour lifting as it goes.
            float t = vFlowerUv.y;
            float tiers = 7.0;
            float taper = mix(1.0, 0.45, t);
            float swing = (mod(floor(t * tiers), 2.0) - 0.5) * 0.35 * taper;
            vec2 floret = vec2((vFlowerUv.x * 2.0 - 1.0 - swing) / (0.65 * taper), (fract(t * tiers) * 2.0 - 1.0) / taper);
            float d = length(floret);
            if (d > 1.0 || t > 0.97) discard;
            flowerColour = mix(vFlowerPetal * 0.75, vFlowerHeart, smoothstep(0.2, 1.1, t)) * (1.0 - 0.3 * d * d);
          } else {
            // A face: petals round a heart, turned by the flower's facing.
            vec2 q = vFlowerUv * 2.0 - 1.0;
            float c = cos(vFlowerSpin);
            float s = sin(vFlowerSpin);
            q = vec2(c * q.x - s * q.y, s * q.x + c * q.y);
            float r = length(q);
            // 1 down the middle of a petal, 0 in the gap between two.
            float wave = abs(cos(atan(q.y, q.x) * vFlowerForm.x * 0.5));
            float edge = 1.0 - vFlowerForm.y * (1.0 - sqrt(wave));
            if (r > edge) discard;
            float heart = vFlowerForm.z;
            // Deeper at the base of a petal, lighter to its tip, a crease
            // down each side; the heart speckled, darkening to its rim.
            float outward = clamp((r - heart) / max(edge - heart, 1e-3), 0.0, 1.0);
            vec3 petal = vFlowerPetal * mix(0.65, 1.0, outward) * mix(0.8, 1.0, wave);
            vec3 middle = vFlowerHeart * (0.85 + 0.15 * sin(q.x * 60.0) * sin(q.y * 60.0))
              * mix(1.0, 0.55, smoothstep(heart * 0.6, heart, r));
            flowerColour = r < heart ? middle : petal;
          }
          flowerColour *= vFlowerTint;
        }
        diffuseColor.rgb *= flowerColour;`)
      // Lit from either side as the ground is.
      .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
        normal = normalize(vNormal);
        nonPerturbedNormal = normal;`)
      // Lit, a head is pushed further from its own grey than the light
      // alone leaves it -- the sky light and the tone mapping both wash
      // colour out.
      .replace('#include <opaque_fragment>', `
        float flowerLuma = dot(outgoingLight, vec3(0.2126, 0.7152, 0.0722));
        outgoingLight = max(mix(vec3(flowerLuma), outgoingLight, mix(1.0, flowerVibrance, vFlowerHead)), 0.0);
        #include <opaque_fragment>`);
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

  /**
   * A chunk's geometry at one level of detail: that level's tuft, and the one
   * shared set of instances every chunk draws.
   *
   * A geometry apiece rather than one shared per level, because the
   * instanceCount is the chunk's own -- it is how the grass thins with
   * distance -- and that lives on the geometry. The ATTRIBUTES are shared, so
   * this costs an object, not an upload.
   */
  function levelGeometry(level) {
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setIndex(level.getIndex());
    geometry.setAttribute('position', level.getAttribute('position'));
    geometry.setAttribute('normal', level.getAttribute('normal'));
    geometry.setAttribute('uv', level.getAttribute('uv'));
    geometry.setAttribute('bladeLocal', bladeLocal);
    geometry.setAttribute('bladeData', bladeData);
    geometry.instanceCount = GRASS.bladesPerChunk;
    // Set by hand in place(): computed, it would be one tuft's.
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 0);
    return geometry;
  }

  const chunks = [];
  for (let i = 0; i < span * span; i++) {
    const detail = levels.map(levelGeometry);
    const geometry = detail[0];

    const mesh = new THREE.Mesh(geometry, material);
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    // Composed only when the chunk moves, not every frame.
    mesh.matrixAutoUpdate = false;
    // Nothing clicks on grass, and a raycast would test the base triangle.
    mesh.raycast = () => {};
    group.add(mesh);

    // The chunk's flowers: a child, so they ride its matrix and hide with it.
    const flowerGeometry = new THREE.InstancedBufferGeometry();
    flowerGeometry.setIndex(flowerIndex);
    flowerGeometry.setAttribute('position', flowerShape);
    flowerGeometry.setAttribute('normal', flowerNormals);
    flowerGeometry.setAttribute('uv', flowerUvs);
    flowerGeometry.setAttribute('flowerPart', flowerPart);
    flowerGeometry.setAttribute('flowerLocal', flowerLocal);
    flowerGeometry.setAttribute('flowerData', flowerData);
    flowerGeometry.instanceCount = flowersPerChunk;
    flowerGeometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 0);
    const flowers = new THREE.Mesh(flowerGeometry, flowerMaterial);
    flowers.receiveShadow = true;
    flowers.castShadow = false;
    flowers.matrixAutoUpdate = false; // the identity, under the chunk's own
    flowers.raycast = () => {};
    mesh.add(flowers);

    chunks.push({ mesh, flowers, detail, level: 0, cx: 0, cz: 0, radius: 0 });
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
    // Every level, not just the one being drawn: the chunk changes level as
    // you walk toward it, and a geometry still holding the radius it was born
    // with (nothing) would be culled the moment it was swapped in.
    for (const geometry of chunk.detail) geometry.boundingSphere.radius = chunk.radius;
    chunk.flowers.geometry.boundingSphere.radius = chunk.radius;
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

  console.info(
    `Grass: ${chunks.length} chunks of ${GRASS.bladesPerChunk.toLocaleString()} blades `
    + `and ${flowersPerChunk} flowers in ${GRASS.bunchesPerChunk} bunches, following the camera.`,
  );
  let showFlowers = true;

  return {
    group,
    uniforms,
    bladesPerChunk: GRASS.bladesPerChunk,

    /**
     * Keep the grass and flowers off a round patch of ground, centred on world
     * (x, z) -- under something standing in the field, like the bench. They
     * thin to nothing over the outer part of `radius`; 0 clears the slot.
     * `slot` is which of the few clearings this is (0 .. CLEARINGS - 1), so
     * each thing in the field keeps its own.
     */
    setClearing(x, z, radius, slot = 0) {
      const clearing = uniforms.grassClearings.value[slot];
      if (!clearing) return;
      clearing.set(x, z, Math.max(0, radius));
    },
    get chunkCount() { return chunks.length; },
    /** Whether the flowers are drawn, for the debug panel. */
    get showFlowers() { return showFlowers; },
    set showFlowers(on) {
      showFlowers = on;
      for (const { flowers } of chunks) flowers.visible = on;
    },
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
      // show; the rest draw every tuft they hold, at whatever level of detail
      // their distance earns.
      const fadeEnd = uniforms.grassFadeEnd.value;
      const half = size / 2;
      drawnChunks = 0;
      for (const chunk of chunks) {
        const { mesh } = chunk;
        // Along the ground to the nearest point of the chunk's square -- the
        // shader's own measure, so never further than any tuft in it.
        const dx = Math.max(0, Math.abs(_camera.x - mesh.position.x) - half);
        const dz = Math.max(0, Math.abs(_camera.z - mesh.position.z) - half);
        const nearest = Math.hypot(dx, dz);
        mesh.visible = nearest < fadeEnd;
        if (!mesh.visible) continue;
        drawnChunks += 1;

        // Which tuft this chunk draws: the finest one it is near enough for.
        // Per chunk, not per tuft -- nine hundred of them change level on one
        // assignment, which is the whole reason the LOD lives here.
        let level = 0;
        while (level < chunk.detail.length - 1 && nearest > GRASS.clumpLod[level]) level += 1;
        if (level !== chunk.level) {
          chunk.level = level;
          mesh.geometry = chunk.detail[level];
        }
      }
    },

    dispose() {
      for (const { detail, flowers } of chunks) {
        for (const geometry of detail) geometry.dispose();
        flowers.geometry.dispose();
      }
      material.dispose();
      flowerMaterial.dispose();
      surfaceTexture.dispose();
    },
  };
}