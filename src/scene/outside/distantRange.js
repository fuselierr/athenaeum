import * as THREE from 'three';
import { sampleTerrain } from './terrain.js';
import { cloudShadowUniforms, CLOUD_SHADOW_GLSL } from './cloudShadows.js';

/**
 * The mountains you never reach: a ring of land around the walkable terrain,
 * from its edge out to thirty kilometres.
 *
 * WHY THIS EXISTS. The terrain you walk on is 400 m across with 132 m of
 * relief, so its tallest peak is at most 280 m away -- and subtends about 25
 * degrees, which is genuinely mountain-sized (the Eiger's north face from
 * Grindelwald is about 20). The silhouette was never the problem. What gave
 * it away was PARALLAX: walk twenty metres and a peak 280 m off swings four
 * degrees across the view, and the eye reads "hillside, across a field"
 * before any amount of haze gets a vote. At 5 km the same walk moves it a
 * fifth of a degree, which is what a mountain looks like.
 *
 * So this is the same angular size moved twenty times further away and made
 * twenty times bigger. Nothing here is walkable, nothing here is physics --
 * it is scenery whose whole job is to be far.
 *
 * AND A MIDDLE DISTANCE. Before this the ground simply stopped at 200 m and
 * the next thing was sky. Depth is read from a chain of overlapping cues, and
 * that chain had a hole in it where most of it should be -- so the ring
 * starts at the terrain's own edge and runs continuously outward, with
 * foothills at a few hundred metres, ridges at a few kilometres, and the big
 * peaks on the horizon.
 *
 * ---------------------------------------------------------------------------
 * HOW IT IS BUILT
 *
 * A grid in (bearing, distance) rather than a square heightmap: the thing is
 * a ring seen from the middle, so the resolution that matters is angular.
 * Rings are spaced exponentially -- close together near the terrain's edge,
 * hundreds of metres apart at the horizon -- which puts the vertices where
 * the detail is visible and makes 30 km cost about 100,000 of them. The
 * ANGULAR resolution is what limits how sharp a summit can look: a peak needs
 * several bearings to come to a point rather than a facet.
 *
 * ITS INNER RIM IS THE TERRAIN'S OWN EDGE, sampled. For every bearing, where
 * that ray leaves the 400 m square is found and the terrain's height there is
 * read off the mesh itself (terrain.js's sampleTerrain), so the ring begins
 * at exactly the height the ground it continues from ends at. No seam to
 * hide, no flat plain to fudge -- the land simply goes on.
 *
 * HEIGHTS are a ridged multifractal (see `ridged` below): octaves folded
 * about zero so their zero crossings become crests, sharpened into narrow
 * ridges, and each one scaled by how high the last stood -- so detail gathers
 * along the crest lines and the valleys stay smooth, the way a real range is
 * put together. Two things change with distance:
 *   - the peaks GROW, very nearly in proportion, so their angular height
 *     stays roughly constant out to the horizon -- which is what a real range
 *     does, and what stops the far ridges reading as a low wall;
 *   - the FINE octaves fade out, so near hills have texture and the far ones
 *     are smooth massifs. That is aerial perspective in geometry rather than
 *     in colour, and it is half of why distance reads as distance.
 *
 * ---------------------------------------------------------------------------
 * HOW IT IS DRAWN
 *
 * In a pass of its own, before the scene, with its own camera
 * (scene/outside/outdoorPost.js). The main camera's near plane is 1 cm --
 * because you hold a book at arm's length -- and a 1 cm near plane with a
 * 30 km far plane has no depth precision left at the far end whatsoever; the
 * ridges would z-fight through each other. So the range gets its own camera,
 * is drawn first, and the scene then clears depth and draws over it.
 * Everything in the scene is nearer than everything here, by construction --
 * the ring starts exactly where the terrain ends -- so the ordering is always
 * right. (That construction is also why that camera's near plane has to be
 * CLOSE; see it below.)
 *
 * ITS HAZE IS ITS OWN, for the same reason: the height fog is a screen-space
 * pass over the scene's depth buffer, and this is not in that depth buffer.
 * The colour it fades toward is not a guess either -- it is the sky itself,
 * sampled from the cubemap the fog uses (outdoorLight.js's skyTexture) in the
 * direction of the fragment, so a ridge on the horizon dissolves into exactly
 * the sky behind it and follows the sun as it moves.
 *
 * THE ONE NUMBER TO WATCH is HAZE_DENSITY. Where the ring meets the terrain
 * at 200 m, two different fogs are drawing next to each other -- this one and
 * the post-processing pass's -- and if they disagree there is a visible step
 * at the join. They are matched by eye at that distance; change the height
 * fog's density much and this wants nudging to match.
 *
 * NOT IN VR. The XR path renders without the composer (outdoorPost.js's
 * renderXR), so it has no second pass to put this in. The headset sees the
 * scene as it was before.
 */

// --- the shape of the ring ---------------------------------------------------------
const OUTER_RADIUS = 30000; // metres -- past this, haze has taken everything anyway
// Divisions round the compass. This is what a peak's sharpness is limited by:
// a summit needs several of them to come to a point rather than a facet, and
// at 320 each was over a degree wide -- wider than the moon, which is why
// every crest read as a blunt wedge. 900 puts them at 0.4 degrees.
const BEARINGS = 900;
// Divisions outward. These are the SPARSE direction -- exponential spacing
// puts the outermost rings a kilometre apart -- so this, not BEARINGS, is what
// decides how much crest detail can survive at range (see `resolvable`).
const RINGS = 160;
const RING_BIAS = 4.2; // higher = more of the rings crowded near the terrain

// --- how big the mountains are ------------------------------------------------------
// Peak height at REFERENCE_AT, growing with distance by GROWTH. At 1 (exact
// proportion) every ridge subtends the same angle however far off it is; a
// little under keeps the horizon from becoming a wall.
const REFERENCE_AT = 1000; // metres
const RELIEF_AT_REFERENCE = 330; // metres of crest-to-valley there
const GROWTH = 0.86;
// The valley floors rise as the range does, so the land climbs away from you
// rather than every ridge standing on the same plain.
const BASE_RISE = 0.34; // as a share of the local relief

// How wide the ridges are, in metres. Big: these are massifs seen from far
// off, not the ground underfoot.
const RIDGE_SCALE = 2600;
const OCTAVES = 8;
// How sharp a crest is: the fold is raised to this before it is summed, and
// the higher it goes the narrower the ridge and the broader the valley either
// side. Around 3 is an eroded alpine ridge; 1 is a rolling dune.
const RIDGE_SHARPNESS = 3.1;
// Each octave is scaled by how strong the one before it was, so detail
// gathers ON the ridges and leaves the valleys smooth -- which is what makes
// a crest line read as continuous instead of as noise that happens to be
// high. Musgrave's ridged multifractal, and the reason these look like
// mountains rather than crumpled paper.
const RIDGE_GAIN = 2.1;
// Fine octaves are thinned past this, over this distance -- an artistic fade
// on top of the hard limit below, so far ridges read as massifs rather than as
// busy ground. It is deliberately generous: what fine octaves buy at range is
// the SILHOUETTE, the notches and subsidiary summits along a crest, and a far
// range without them is a smooth wave.
const DETAIL_FADE_FROM = 9000;
const DETAIL_FADE_OVER = 16000;

// Which range: every whole number is a different one, the same every visit.
// It moves where in the (endless, unrepeating) noise the ring is read from --
// far enough per step that neighbouring seeds share nothing -- so the
// character set above stays and only the particular peaks change.
const SEED = 25;
const SEED_STRIDE = [173.31, 91.73]; // noise units per step, in x and z

// --- and the limit that is not a matter of taste -------------------------------
// An octave whose features are finer than the mesh's own spacing CANNOT be
// drawn -- it is sampled once every few wavelengths, so each vertex gets an
// essentially random value from it, and where one happens to land near a
// crest's maximum the result is a single vertex flung into the air. Those are
// the thin needles that appear along a far skyline, and no amount of tuning
// the noise removes them, because they are aliasing rather than shape.
//
// So every octave is weighed against the distance between vertices where it
// is being sampled, and fades out as its wavelength approaches it. Nyquist
// says a wavelength must be at least twice the spacing to be represented at
// all; these are the band either side of that.
const RESOLVE_AT = 1.3; // wavelengths per cell where an octave is fully gone
const RESOLVE_BY = 3.2; // and where it is fully present

// How far the terrain's own edge blends into the mountains, as a share of the
// way out. Short: the hills should start almost at once.
const ROOTED_FOR = 0.035;

// --- how far away it looks ----------------------------------------------------------
// Aerial perspective: the share of the sky's colour a surface has taken on by
// distance d is 1 - exp(-d * HAZE_DENSITY). At 3 km that is about a third, at
// 30 km essentially all of it. See the note above about matching the height
// fog at the join.
const HAZE_DENSITY = 0.000135;
// Contrast goes before colour does: a distant ridge flattens toward one value
// well before it has gone sky-coloured, which is most of what makes it read
// as far rather than merely pale.
const FLATTEN_DENSITY = 0.00028;

// --- the rock's own surface ----------------------------------------------------------
// Geometry can only say so much: past a few kilometres a vertex covers more
// ground than the eye can resolve, and adding more of them is spent on
// silhouette rather than on the faces. What makes a far mountainside read as
// ROCK is what happens across its face -- ribs, gullies, snow caught in the
// hollows -- and that is shading.
//
// A small tiling noise texture, generated here rather than downloaded, does
// it in two texture reads: three channels of independent noise taken as a
// random direction to tilt the surface by. Coarse for the ribs, fine for the
// grain.
const DETAIL_SIZE = 256; // the texture, a side
const DETAIL_PERIOD = 8; // lattice cells across it -- it tiles every one
const RIB_SCALE = 260; // metres a coarse tile covers
const RIB_STRENGTH = 0.55;
const GRAIN_SCALE = 42; // metres a fine tile covers
const GRAIN_STRENGTH = 0.3;
// Detail that never resolves is detail that shimmers, so both fade out with
// distance -- the fine one long before the coarse one.
const GRAIN_FADE = 3000;
const RIB_FADE = 16000;

// How much a ridge is lightened and a hollow darkened, from the shape of the
// land itself (the `exposure` attribute below). This is what gives a range
// its mass: without it a lit face is one flat value however folded it is.
const RELIEF_SHADING = 0.42;

// --- what it is made of -------------------------------------------------------------
const ROCK_LOW = new THREE.Color(0x4a4f45); // wooded slopes, seen from far off
const ROCK_HIGH = new THREE.Color(0x8a8781); // bare rock above them
const SNOW = new THREE.Color(0xffffff);
const SNOW_LINE = 370; // metres above the terrain's edge
const SNOW_FADE = 450; // wide, so the line is a zone the noise can break up
// How far the snow line wanders with the rock -- snow lies in the gullies and
// leaves the ribs bare well below it, and the straight horizontal band you get
// without this is the single most artificial thing about a drawn mountain.
const SNOW_SCATTER = 0.55;
const TREE_LINE = 200;
const TREE_FADE = 150;
// Lit by the same sun, but this is scenery: one lambert term and a sky
// ambient, not the scene's full lighting.
const AMBIENT = 0.42;

// --- noise ---------------------------------------------------------------------------
// Value noise with a hashed lattice: no tables to ship, and the same shape
// every visit from the same seed. Good enough by a distance for something
// that is never nearer than 200 m.
function hash2(x, y) {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
  return n - Math.floor(n);
}

const fade = (t) => t * t * (3 - 2 * t);

function valueNoise(x, y) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = fade(xf);
  const v = fade(yf);
  const a = hash2(xi, yi);
  const b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1);
  const d = hash2(xi + 1, yi + 1);
  return (a + (b - a) * u) + ((c - a) + (d - c) * u - (b - a) * u) * v;
}

/**
 * Ridged multifractal noise, 0..1, with the fine octaves weighted by `detail`.
 *
 * Each octave is folded about zero -- 1 - |2n - 1| -- so what were the noise's
 * zero crossings become crests, and raising the fold to RIDGE_SHARPNESS
 * narrows them into ridges with broad valleys between.
 *
 * WHAT MAKES IT A RANGE rather than rough ground is the carried weight: every
 * octave is multiplied by how high the one before it stood, so detail can only
 * appear where there is already a ridge. Spurs and notches gather along the
 * crest lines and the valleys stay smooth, which is how real mountains are put
 * together -- and why the skyline reads as connected peaks instead of noise
 * that happens to be high in places.
 */
function ridged(x, y, detail, cell, shape) {
  let sum = 0;
  let total = 0;
  let amplitude = 1;
  let frequency = 1;
  let carried = 1; // how much the last octave earned the next one
  for (let octave = 0; octave < OCTAVES; octave += 1) {
    // What this octave's features measure, on the ground.
    const wavelength = shape.ridgeScale / frequency;
    // Gone entirely once the mesh cannot sample it -- see RESOLVE_AT. This is
    // a fact about the grid, not a preference, and it is what keeps a far
    // skyline free of needles.
    const resolvable = THREE.MathUtils.smoothstep(wavelength, cell * RESOLVE_AT, cell * RESOLVE_BY);
    // The first three octaves are the massif and are always wanted; the rest
    // are its detail, and thin out with distance as well.
    const weight = (octave < 3 ? 1 : detail) * resolvable;

    // The carried weight is taken from the octave's OWN strength, before the
    // fades -- so thinning the detail changes how much of it there is, not
    // where on the mountain it is allowed to gather.
    const folded = 1 - Math.abs(2 * valueNoise(x * frequency, y * frequency) - 1);
    const signal = folded ** shape.sharpness * carried;
    carried = Math.min(1, Math.max(0, signal * shape.gain));

    sum += signal * weight * amplitude;
    total += amplitude * weight;
    amplitude *= 0.5;
    frequency *= 2.07; // off a whole number, so octaves do not line up
  }
  return total > 0 ? Math.min(1, sum / total) : 0;
}

/**
 * A small tiling noise texture: three channels of independent value noise,
 * two octaves each, seamless at its edges so it can be repeated over a
 * mountainside without a visible grid.
 *
 * Generated rather than loaded -- it is 256 square and costs a couple of
 * milliseconds, against a download, a decode and another file to ship.
 */
function detailTexture() {
  const size = DETAIL_SIZE;
  const data = new Uint8Array(size * size * 4);

  // One octave of value noise that wraps: the lattice is read modulo its
  // period, so the right edge interpolates back into the left.
  const octave = (period, seed, x, y) => {
    const fx = (x / size) * period;
    const fy = (y / size) * period;
    const x0 = Math.floor(fx) % period;
    const y0 = Math.floor(fy) % period;
    const x1 = (x0 + 1) % period;
    const y1 = (y0 + 1) % period;
    const u = fade(fx - Math.floor(fx));
    const v = fade(fy - Math.floor(fy));
    const at = (cx, cy) => hash2(cx + seed * 131.5, cy + seed * 57.3);
    const top = at(x0, y0) + (at(x1, y0) - at(x0, y0)) * u;
    const bottom = at(x0, y1) + (at(x1, y1) - at(x0, y1)) * u;
    return top + (bottom - top) * v;
  };

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const at = (y * size + x) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        const value = octave(DETAIL_PERIOD, channel + 1, x, y) * 0.65
          + octave(DETAIL_PERIOD * 3, channel + 11, x, y) * 0.35;
        data[at + channel] = Math.round(THREE.MathUtils.clamp(value, 0, 1) * 255);
      }
      data[at + 3] = 255;
    }
  }

  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Build the ring.
 *
 * @param {object} opts
 * @param {THREE.Mesh} opts.terrain  the walkable terrain, already placed --
 *   its edge is this ring's inner rim
 * @param {{ width: number, segments: number }} opts.terrainOpts  as it was made
 * @param {THREE.CubeTexture} opts.skyTexture  what the haze fades toward
 * @param {THREE.Vector3} opts.sunDirection  updated in place by outdoorLight
 * @returns {{ object: THREE.Mesh, camera: THREE.PerspectiveCamera,
 *   update(camera: THREE.Camera): void, dispose(): void }}
 */
export function createDistantRange({ terrain, terrainOpts, skyTexture, sunDirection }) {
  const halfWidth = terrainOpts.width / 2;
  const centre = terrain.position;

  // --- the inner rim: where each bearing leaves the terrain, and how high ----
  const rimRadius = new Float32Array(BEARINGS);
  const rimHeight = new Float32Array(BEARINGS);
  for (let b = 0; b < BEARINGS; b += 1) {
    const angle = (b / BEARINGS) * Math.PI * 2;
    const dx = Math.cos(angle);
    const dz = Math.sin(angle);
    // Where the ray from the middle crosses the square's edge: whichever of
    // the two sides it reaches first. Pulled in a whisker so the sample is
    // inside the grid rather than exactly on its last vertex.
    const toX = Math.abs(dx) > 1e-6 ? halfWidth / Math.abs(dx) : Infinity;
    const toZ = Math.abs(dz) > 1e-6 ? halfWidth / Math.abs(dz) : Infinity;
    const radius = Math.min(toX, toZ) * 0.999;
    rimRadius[b] = radius;
    rimHeight[b] = centre.y + sampleTerrain(
      terrain, 'position', 1, centre.x + dx * radius, centre.z + dz * radius, terrainOpts,
    );
  }

  // --- what the shape is made of, as values rather than constants -----------
  // The module's constants are its defaults; these are the live copy, so the
  // debug panel (debug/outdoorPanel.js) can move them. Everything here is
  // baked into the mesh, so changing one means rebuild() -- unlike the
  // uniforms further down, which take effect on the next frame.
  const shape = {
    relief: RELIEF_AT_REFERENCE,
    growth: GROWTH,
    baseRise: BASE_RISE,
    ridgeScale: RIDGE_SCALE,
    sharpness: RIDGE_SHARPNESS,
    gain: RIDGE_GAIN,
    detailFrom: DETAIL_FADE_FROM,
    detailOver: DETAIL_FADE_OVER,
    seed: SEED,
  };

  // --- the grid -------------------------------------------------------------
  const columns = BEARINGS + 1; // the seam is repeated, so its UVs and normals close
  const rows = RINGS + 1;
  const vertices = columns * rows;
  const positions = new Float32Array(vertices * 3);
  const normals = new Float32Array(vertices * 3);
  // How much each vertex stands proud of the land around it: +1 on a crest,
  // -1 in a hollow. Worked out from the finished heights below and handed to
  // the shader, which lightens ridges and darkens gullies by it. A normal
  // says which way a face points; this says where it sits, and it is the
  // difference between a folded surface and a lit flat one.
  const exposure = new Float32Array(vertices);

  // t 0..1 out from the rim, biased so the rings crowd near the terrain.
  const spanAt = (t) => (Math.exp(RING_BIAS * t) - 1) / (Math.exp(RING_BIAS) - 1);

  /**
   * How far apart the vertices are, in metres, at a given distance out --
   * the finest shape the mesh can carry there.
   *
   * Two spacings, and the coarser one is the limit: ROUND the ring, which is
   * simply the circumference over BEARINGS, and OUTWARD, which grows fast
   * because the rings are spaced exponentially. Past a kilometre or so the
   * outward one dominates by a long way.
   */
  function cellSizeAt(radius, rim) {
    const span = Math.max(OUTER_RADIUS - rim, 1);
    const along = THREE.MathUtils.clamp((radius - rim) / span, 0, 1);
    const growth = Math.exp(RING_BIAS) - 1;
    // d(radius)/dt for the exponential spacing above, over the ring count.
    const outward = (span * RING_BIAS * (along * growth + 1)) / (growth * RINGS);
    const round = (2 * Math.PI * radius) / BEARINGS;
    return Math.max(outward, round);
  }

  /** The land at a bearing and a distance: its height in world units. */
  function heightAt(b, radius, rootedFrom, rootedHeight, blend, rim) {
    const relief = shape.relief * (radius / REFERENCE_AT) ** shape.growth;
    const detail = 1 - THREE.MathUtils.smoothstep(
      radius, shape.detailFrom, shape.detailFrom + shape.detailOver,
    );
    const angle = (b / BEARINGS) * Math.PI * 2;
    const x = centre.x + Math.cos(angle) * radius;
    const z = centre.z + Math.sin(angle) * radius;
    const crest = ridged(
      x / shape.ridgeScale + shape.seed * SEED_STRIDE[0],
      z / shape.ridgeScale + shape.seed * SEED_STRIDE[1],
      detail, cellSizeAt(radius, rim), shape,
    );
    const mountains = rootedFrom + relief * (shape.baseRise + crest);
    // Rooted in the terrain's own edge for the first sliver of the way out,
    // so the join is continuous by construction.
    return THREE.MathUtils.lerp(rootedHeight, mountains, blend);
  }

  /**
   * Lay the land out: every vertex's place, then how proud each one stands.
   *
   * Run again by rebuild() whenever one of `shape`'s numbers moves. The
   * buffers are written in place -- the grid's size never changes, only its
   * heights -- so this costs the arithmetic and one upload, not a new mesh.
   */
  function layOut() {
    for (let r = 0; r < rows; r += 1) {
      const t = r / RINGS;
      const along = spanAt(t);
      const blend = THREE.MathUtils.smoothstep(t, 0, ROOTED_FOR);
      for (let c = 0; c < columns; c += 1) {
        const b = c % BEARINGS;
        const angle = (b / BEARINGS) * Math.PI * 2;
        const rim = rimRadius[b];
        const radius = rim + (OUTER_RADIUS - rim) * along;
        const height = heightAt(b, radius, rimHeight[b], rimHeight[b], blend, rim);
        const at = (r * columns + c) * 3;
        positions[at] = centre.x + Math.cos(angle) * radius;
        positions[at + 1] = height;
        positions[at + 2] = centre.z + Math.sin(angle) * radius;
      }
    }

    // How proud each vertex stands: its height against the average of its four
    // neighbours, scaled by how much the land varies at that distance (relief
    // grows with radius, and a raw difference would make everything far off
    // look violently crumpled).
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < columns; c += 1) {
        const here = r * columns + c;
        const inward = Math.max(r - 1, 0) * columns + c;
        const outward = Math.min(r + 1, rows - 1) * columns + c;
        // Round the compass, so the seam has neighbours on both sides.
        const before = r * columns + ((c - 1 + BEARINGS) % BEARINGS);
        const after = r * columns + ((c + 1) % BEARINGS);
        const mean = (positions[inward * 3 + 1] + positions[outward * 3 + 1]
          + positions[before * 3 + 1] + positions[after * 3 + 1]) / 4;
        const radius = Math.hypot(positions[here * 3] - centre.x, positions[here * 3 + 2] - centre.z);
        const relief = shape.relief * (radius / REFERENCE_AT) ** shape.growth;
        exposure[here] = THREE.MathUtils.clamp(
          (positions[here * 3 + 1] - mean) / (relief * 0.18), -1, 1,
        );
      }
    }
  }

  layOut();

  const indices = [];
  for (let r = 0; r < RINGS; r += 1) {
    for (let c = 0; c < BEARINGS; c += 1) {
      const a = r * columns + c;
      const b = a + 1; // the next bearing round
      const d = a + columns; // the next ring out
      const e = d + 1;
      // Wound so the faces point UP. Round the other way every normal comes
      // out downward, which culls the slopes facing you and leaves you looking
      // at the inside of the far ones -- a flat silhouette with no lit face,
      // because dot(normal, sun) is negative everywhere and clamps to nothing.
      indices.push(a, b, d, b, e, d);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('exposure', new THREE.BufferAttribute(exposure, 1));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();

  // --- the material ---------------------------------------------------------
  const detail = detailTexture();

  const uniforms = {
    sunDirection: { value: sunDirection },
    skyTexture: { value: skyTexture },
    detailMap: { value: detail },
    rockLow: { value: ROCK_LOW.clone() },
    rockHigh: { value: ROCK_HIGH.clone() },
    snowColour: { value: SNOW.clone() },
    snowLine: { value: rimHeight[0] + SNOW_LINE },
    snowFade: { value: SNOW_FADE },
    snowScatter: { value: SNOW_SCATTER },
    treeLine: { value: rimHeight[0] + TREE_LINE },
    treeFade: { value: TREE_FADE },
    ambient: { value: AMBIENT },
    hazeDensity: { value: HAZE_DENSITY },
    flattenDensity: { value: FLATTEN_DENSITY },
    reliefShading: { value: RELIEF_SHADING },
    ribScale: { value: RIB_SCALE },
    ribStrength: { value: RIB_STRENGTH },
    ribFade: { value: RIB_FADE },
    grainScale: { value: GRAIN_SCALE },
    grainStrength: { value: GRAIN_STRENGTH },
    grainFade: { value: GRAIN_FADE },
    // The clouds' shadows, drifting over the range (cloudShadows.js).
    ...cloudShadowUniforms,
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */`
      attribute float exposure;
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying float vExposure;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        vNormal = normalize(mat3(modelMatrix) * normal);
        vExposure = exposure;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */`
      uniform vec3 sunDirection;
      uniform samplerCube skyTexture;
      uniform sampler2D detailMap;
      uniform vec3 rockLow;
      uniform vec3 rockHigh;
      uniform vec3 snowColour;
      uniform float snowLine;
      uniform float snowFade;
      uniform float snowScatter;
      uniform float treeLine;
      uniform float treeFade;
      uniform float ambient;
      uniform float hazeDensity;
      uniform float flattenDensity;
      uniform float reliefShading;
      uniform float ribScale;
      uniform float ribStrength;
      uniform float ribFade;
      uniform float grainScale;
      uniform float grainStrength;
      uniform float grainFade;
      ${CLOUD_SHADOW_GLSL}

      varying vec3 vWorld;
      varying vec3 vNormal;
      varying float vExposure;

      // The detail texture read over a surface of any orientation, without
      // UVs: the three world planes sampled and blended by how much the face
      // points along each axis. A mountainside is mostly vertical, so a flat
      // top-down projection would smear it into streaks.
      vec3 triplanar(vec3 position, vec3 weights, float scale) {
        vec3 p = position / scale;
        return texture2D(detailMap, p.yz).rgb * weights.x
          + texture2D(detailMap, p.xz).rgb * weights.y
          + texture2D(detailMap, p.xy).rgb * weights.z;
      }

      void main() {
        vec3 normal = normalize(vNormal);
        vec3 toEye = vWorld - cameraPosition;
        float distance = length(toEye);

        // --- the rock's surface ---------------------------------------------
        // Two scales of it, each fading out at the distance it stops being
        // resolvable: detail that cannot be seen only shimmers.
        vec3 weights = abs(normal);
        weights /= max(weights.x + weights.y + weights.z, 1e-4);

        float ribHere = ribStrength * (1.0 - smoothstep(ribFade * 0.35, ribFade, distance));
        float grainHere = grainStrength * (1.0 - smoothstep(grainFade * 0.35, grainFade, distance));

        vec3 ribs = triplanar(vWorld, weights, ribScale) * 2.0 - 1.0;
        vec3 grain = triplanar(vWorld, weights, grainScale) * 2.0 - 1.0;
        // Taken as a direction to tilt the face by -- bump mapping with no
        // tangents to derive and no normal map to author.
        normal = normalize(normal + ribs * ribHere + grain * grainHere);

        // --- what grows and lies on it ---------------------------------------
        // Wooded low ground, bare rock above it, snow on the tops. Bands of
        // altitude, which is exactly how a reader judges how high something
        // is -- a snow line is a number you can see.
        float rough = ribs.x * 0.5 + 0.5;
        vec3 ground = mix(rockLow, rockHigh,
          smoothstep(treeLine, treeLine + treeFade, vWorld.y + rough * treeFade * 0.6));
        // Ribs of bare rock breaking through: the darker, more exposed the
        // stone, the less of it is covered.
        ground *= 0.82 + 0.36 * rough;

        // Snow gathers where it can lie and where the wind does not scour it:
        // by height, by how flat the ground is, and with the line itself
        // wandering with the rock so it is a zone rather than a ruled edge.
        float lying = smoothstep(0.30, 0.78, normal.y);
        float line = snowLine + (rough - 0.5) * snowFade * snowScatter * 2.0;
        // And it lies deeper in the hollows than on the ribs.
        float sheltered = clamp(0.5 - vExposure * 0.5, 0.0, 1.0);
        float snow = smoothstep(line, line + snowFade, vWorld.y) * lying * (0.45 + 0.55 * sheltered);
        vec3 colour = mix(ground, snowColour, clamp(snow, 0.0, 1.0));

        // --- light ------------------------------------------------------------
        // Less where a cloud is between the slope and the sun.
        float sun = max(dot(normal, normalize(sunDirection)), 0.0) * cloudShadowAt(vWorld);
        // The sky lights what faces up, which is what separates a shadowed
        // face from the ground in front of it.
        float skyward = 0.5 + 0.5 * normal.y;
        colour *= ambient * (0.55 + 0.45 * skyward) + (1.0 - ambient) * sun;
        // Ridges catch the light, hollows keep it -- the shape of the land
        // read straight off the land, and most of what gives a range its mass.
        colour *= 1.0 + vExposure * reliefShading;

        // --- aerial perspective ---------------------------------------------
        // The sky in the direction of this very point, so a ridge on the
        // horizon dissolves into what is behind it rather than into a colour
        // somebody picked.
        vec3 sky = textureCube(skyTexture, normalize(toEye)).rgb;

        // Contrast goes first: the whole surface collapses toward its own
        // mean before it has taken on much of the sky.
        float flatten = 1.0 - exp(-distance * flattenDensity);
        float mean = dot(colour, vec3(0.3333));
        colour = mix(colour, vec3(mean), flatten * 0.75);

        float haze = 1.0 - exp(-distance * hazeDensity);
        colour = mix(colour, sky, haze);

        gl_FragColor = vec4(max(colour, 0.0), 1.0);
      }
    `,
  });

  const object = new THREE.Mesh(geometry, material);
  object.name = 'distantRange';
  object.frustumCulled = false; // it surrounds the camera; its bounds always do
  // Nothing here casts or takes a shadow: the sun's map covers 400 m of
  // walkable ground, and a mountain 20 km away has no business in it.
  object.castShadow = false;
  object.receiveShadow = false;

  // --- its own camera -------------------------------------------------------
  //
  // THE NEAR PLANE HAS TO BE CLOSE. The ring begins at the terrain's edge, and
  // you can walk to within ten metres of that edge (outside.js's
  // GROUND_EDGE_MARGIN) -- so its inner rim can be ten metres in front of your
  // face. A near plane any further out clips the rim away and leaves a band of
  // bare sky between the ground you are standing on and the mountains.
  //
  // Two metres against forty-eight kilometres is a ratio of 24,000, which is
  // ordinary -- and still two hundred times more depth precision than the
  // scene's 1 cm near plane, which is the whole reason this camera exists.
  const camera = new THREE.PerspectiveCamera(50, 1, 2, OUTER_RADIUS * 1.6);

  return {
    object,
    camera,
    /** The shading, live -- moving one of these shows on the next frame. */
    uniforms,
    /** The shaping, baked -- move one of these and call rebuild(). */
    shape,

    /**
     * Lay the land out again after `shape` has been changed. About a fifth of
     * a second for the whole ring; called when a debug slider is let go, not
     * while it is being dragged.
     */
    rebuild() {
      layOut();
      geometry.attributes.position.needsUpdate = true;
      geometry.attributes.exposure.needsUpdate = true;
      geometry.computeVertexNormals();
      geometry.attributes.normal.needsUpdate = true;
      geometry.computeBoundingSphere();
    },

    /** Point it wherever the scene's camera is looking. Call before drawing. */
    update(from) {
      camera.position.copy(from.position);
      camera.quaternion.copy(from.quaternion);
      if (from.isPerspectiveCamera) {
        camera.fov = from.fov;
        camera.aspect = from.aspect;
      }
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld();
    },

    dispose() {
      geometry.dispose();
      detail.dispose();
      material.dispose();
    },
  };
}
