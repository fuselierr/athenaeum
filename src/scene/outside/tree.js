import * as THREE from 'three';
import { loadGLTF } from '../models.js';
import { disposeObject } from '../disposal.js';
import { flatDirection, sideways } from '../direction.js';

/**
 * A fluffy tree, outside, standing over the bench (scene/outside/parkBench.js).
 *
 * Leonardo Soares Gonçalves's "Fluffy Tree" (MIT, 2025): his model and his
 * canopy shader, ported. The model is public/fluffy-tree.glb: his tree, cut
 * out of the scene he ships it in (public/landscape-glb.glb -- a hill of his
 * own, grass, and the tree on top). The cutting was done once, ahead of time,
 * and changed nothing of the tree -- every vertex and the leaf texture are
 * byte for byte his. What it saved: the hill and its grass were ten of the
 * file's twelve megabytes, downloaded and then parsed into geometry on every
 * trip outside only to be thrown away.
 *
 * ---------------------------------------------------------------------------
 * THE MODEL. Four canopy objects ("NOVA COPA Esfera", new canopy sphere) and
 * a trunk ("Tronco da Árvore"). Each canopy is a ball of separate leaf quads
 * -- about nine thousand of them across the four, each small -- cut out of a
 * leaf texture. That density is most of the look: no single card can be
 * picked out, so what you see is a texture of leaves with more leaves behind
 * every gap.
 *
 * THE SHADER, all from the original:
 *
 *   EACH CANOPY IS ITS OWN LIT BALL. Every fragment is coloured by how far
 *   round ITS OWN canopy it is toward the sun -- shadow colour on the far
 *   side, lit on the near, a highlight on top -- so the crown reads as four
 *   soft masses, each lit on one side.
 *
 *   EVERY LEAF FACES UP. Its own normal is replaced with world-up, so a card
 *   seen edge-on is lit the same as one seen face-on, and the gradient does
 *   all of the shaping.
 *
 *   ITS OWN SHADOW DARKNESS. Where the sun's shadow falls on a leaf or the
 *   trunk, the colour is pushed down toward a fraction of itself -- deep, but
 *   still coloured -- rather than left to the light alone.
 *
 *   A PERLIN WOBBLE over each leaf's own position and time, the higher the
 *   more, so the crown shimmers rather than swaying as a block.
 *
 * ---------------------------------------------------------------------------
 * WHERE THIS DIFFERS FROM THE ORIGINAL, and why each one had to:
 *
 *   getShadow() takes SIX arguments in this three -- a shadow intensity was
 *   added after the original was written -- and its shadow map can be a
 *   comparison sampler. The original's five-argument call would not compile.
 *
 *   The world position varying is vLeafWorld, not vWorldPosition. This three
 *   gives Lambert materials the scene's environment (the sky light), and for
 *   Lambert with an environment it declares a varying of that name itself;
 *   the original's name is then a redefinition, the canopy's shader fails,
 *   and the tree stands there bare. The original's three gave Lambert no
 *   environment, so it never met the clash.
 *
 *   Each canopy's centre is a uniform in its OWN space, carried into the
 *   world by the vertex shader, rather than worked out once in world space at
 *   load as the original does. This tree is scaled, moved onto the terrain and
 *   turned after it is loaded; a world-space centre taken at load would point
 *   at wherever the tree used to be.
 *
 *   The leaves are cut out by the texture's own ALPHA (as `map`), where the
 *   original passes the texture as an alphaMap -- which three reads from its
 *   GREEN channel. That works on this texture only because its transparent
 *   pixels happen to be dark; the alpha is what actually marks the leaves,
 *   and cutting on it holds whatever the texture's colour does. The gradient
 *   replaces the texture's colour either way.
 */

const TREE_URL = '/fluffy-tree.glb';

// --- where it stands ----------------------------------------------------------------
// How tall, in metres, foot to the top of the crown. The model's own tree is
// about six -- a small tree -- and this one shades a bench.
const TREE_HEIGHT = 10;
const TRUNK_BEHIND = 2.4; // back from the middle of the bench, clear of its backrest
const TRUNK_ASIDE = 0.9; // and off to one side, so it does not stand dead centre
const SINK = 0.12; // the foot pressed into the ground, so no root floats on a slope

// The objects in the file, by the start of their names. Compared with every
// non-letter stripped, because three's GLTFLoader rewrites names on the way in
// -- spaces to underscores, dots dropped -- and "NOVA COPA Esfera.004"
// arrives as "NOVA_COPA_Esfera004".
const CANOPY_PREFIX = 'NOVACOPA';
const TRUNK_PREFIX = 'TRONCO';
const key = (name) => String(name ?? '').replace(/[^a-z0-9]/gi, '').toUpperCase();

// --- the look: the original's own values ---------------------------------------------
const LOOK = {
  gradientStart: -1.0,
  gradientEnd: 2.7,
  litColour: 0x21ff08,
  shadowColour: 0x001d33,
  highlightColour: 0x8cff00,
  highlightStart: 0.5,
  highlightEnd: 1.8,
  leafShadowDarkness: 0.2,
  trunkShadowDarkness: 0.2,
};

// --- and its wind ------------------------------------------------------------------------
const WOBBLE = { strength: 0.05, frequency: 5.0, speed: 0.4 };

// The original's Perlin noise, verbatim (Stefan Gustavson's classic cnoise),
// with its helpers renamed so they cannot collide with anything of three's.
const PERLIN_GLSL = /* glsl */`
  vec4 treePermute(vec4 x) { return mod(((x * 34.0) + 1.0) * x, 289.0); }
  vec4 treeTaylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
  vec3 treeFade(vec3 t) { return t * t * t * (t * (t * 6.0 - 15.0) + 10.0); }
  float treeNoise(vec3 P) {
    vec3 Pi0 = floor(P); vec3 Pi1 = Pi0 + vec3(1.0); Pi0 = mod(Pi0, 289.0); Pi1 = mod(Pi1, 289.0);
    vec3 Pf0 = fract(P); vec3 Pf1 = Pf0 - vec3(1.0);
    vec4 ix = vec4(Pi0.x, Pi1.x, Pi0.x, Pi1.x); vec4 iy = vec4(Pi0.yy, Pi1.yy);
    vec4 iz0 = Pi0.zzzz; vec4 iz1 = Pi1.zzzz;
    vec4 ixy = treePermute(treePermute(ix) + iy);
    vec4 ixy0 = treePermute(ixy + iz0); vec4 ixy1 = treePermute(ixy + iz1);
    vec4 gx0 = ixy0 / 7.0; vec4 gy0 = fract(floor(gx0) / 7.0) - 0.5; gx0 = fract(gx0);
    vec4 gz0 = vec4(0.5) - abs(gx0) - abs(gy0); vec4 sz0 = step(gz0, vec4(0.0));
    gx0 -= sz0 * (step(0.0, gx0) - 0.5); gy0 -= sz0 * (step(0.0, gy0) - 0.5);
    vec4 gx1 = ixy1 / 7.0; vec4 gy1 = fract(floor(gx1) / 7.0) - 0.5; gx1 = fract(gx1);
    vec4 gz1 = vec4(0.5) - abs(gx1) - abs(gy1); vec4 sz1 = step(gz1, vec4(0.0));
    gx1 -= sz1 * (step(0.0, gx1) - 0.5); gy1 -= sz1 * (step(0.0, gy1) - 0.5);
    vec3 g000 = vec3(gx0.x, gy0.x, gz0.x); vec3 g100 = vec3(gx0.y, gy0.y, gz0.y);
    vec3 g010 = vec3(gx0.z, gy0.z, gz0.z); vec3 g110 = vec3(gx0.w, gy0.w, gz0.w);
    vec3 g001 = vec3(gx1.x, gy1.x, gz1.x); vec3 g101 = vec3(gx1.y, gy1.y, gz1.y);
    vec3 g011 = vec3(gx1.z, gy1.z, gz1.z); vec3 g111 = vec3(gx1.w, gy1.w, gz1.w);
    vec4 norm0 = treeTaylorInvSqrt(vec4(dot(g000, g000), dot(g010, g010), dot(g100, g100), dot(g110, g110)));
    g000 *= norm0.x; g010 *= norm0.y; g100 *= norm0.z; g110 *= norm0.w;
    vec4 norm1 = treeTaylorInvSqrt(vec4(dot(g001, g001), dot(g011, g011), dot(g101, g101), dot(g111, g111)));
    g001 *= norm1.x; g011 *= norm1.y; g101 *= norm1.z; g111 *= norm1.w;
    float n000 = dot(g000, Pf0); float n100 = dot(g100, vec3(Pf1.x, Pf0.yz));
    float n010 = dot(g010, vec3(Pf0.x, Pf1.y, Pf0.z)); float n110 = dot(g110, vec3(Pf1.xy, Pf0.z));
    float n001 = dot(g001, vec3(Pf0.xy, Pf1.z)); float n101 = dot(g101, vec3(Pf1.x, Pf0.y, Pf1.z));
    float n011 = dot(g011, vec3(Pf0.x, Pf1.yz)); float n111 = dot(g111, Pf1);
    vec3 fade_xyz = treeFade(Pf0);
    vec4 n_z = mix(vec4(n000, n100, n010, n110), vec4(n001, n101, n011, n111), fade_xyz.z);
    vec2 n_yz = mix(n_z.xy, n_z.zw, fade_xyz.y);
    float n_xyz = mix(n_yz.x, n_yz.y, fade_xyz.x);
    return 2.2 * n_xyz;
  }
`;

// The sun's shadow on this fragment, 1 lit .. 0 fully shadowed: the original's
// call, with the shadow-intensity argument this three's getShadow() takes.
const SHADOW_GLSL = /* glsl */`
  float shadow = 1.0;
  #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
    shadow = getShadow(
      directionalShadowMap[ 0 ],
      directionalLightShadows[ 0 ].shadowMapSize,
      directionalLightShadows[ 0 ].shadowIntensity,
      directionalLightShadows[ 0 ].shadowBias,
      directionalLightShadows[ 0 ].shadowRadius,
      vDirectionalShadowCoord[ 0 ]
    );
  #endif
`;

/**
 * Teach a material the original's shadow darkness: where the sun's shadow
 * falls, the finished colour is taken down toward a fraction of itself. For
 * the trunk.
 */
function darkenShadows(material, darkness) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.treeShadowDarkness = darkness;
    shader.fragmentShader = `uniform float treeShadowDarkness;\n${shader.fragmentShader}`
      .replace('#include <tonemapping_fragment>', /* glsl */`
        ${SHADOW_GLSL}
        gl_FragColor.rgb = mix(gl_FragColor.rgb * treeShadowDarkness, gl_FragColor.rgb, shadow);
        #include <tonemapping_fragment>`);
  };
  material.customProgramCacheKey = () => 'fluffyTreeTrunk';
}

/**
 * The original's canopy material, for one canopy object.
 *
 * @param {THREE.Texture} leaves  the leaf texture -- its alpha cuts the cards out
 * @param {THREE.Vector3} centre  this canopy's middle, in its own space
 * @param {object} shared  the uniforms every canopy shares, for the panel
 */
function canopyMaterial(leaves, centre, shared) {
  const material = new THREE.MeshLambertMaterial({
    map: leaves,
    alphaTest: 0.5,
    side: THREE.DoubleSide,
  });
  const own = { uClumpCentre: { value: centre } };

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, shared, own);

    shader.vertexShader = /* glsl */`
      uniform vec3 uClumpCentre;
      varying vec3 vLeafWorld;
      varying vec3 vClumpCentre;
      uniform float uTime;
      uniform float uWindStrength;
      uniform float uWindFrequency;
      uniform float uWindSpeed;
      ${PERLIN_GLSL}
      ${shader.vertexShader}
    `.replace('#include <begin_vertex>', /* glsl */`#include <begin_vertex>
      float time = uTime * uWindSpeed;
      // Perlin noise over the leaf's own position and time: an organic,
      // gusting wobble rather than a sway.
      float noise = treeNoise(vec3(position.x * uWindFrequency, position.y * uWindFrequency, time));
      vec3 windDirection = vec3(1.0, 0.0, 1.0);
      // The higher up the leaf, the more it moves.
      float displacement = noise * uWindStrength * (position.y / 8.0);
      transformed.xyz += normalize(windDirection) * displacement;
      vLeafWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
      // The canopy's middle, carried into the world with the tree.
      vClumpCentre = (modelMatrix * vec4(uClumpCentre, 1.0)).xyz;`);

    shader.fragmentShader = /* glsl */`
      varying vec3 vLeafWorld;
      varying vec3 vClumpCentre;
      uniform vec3 uLightDirection;
      uniform float uGradientStart; uniform float uGradientEnd;
      uniform vec3 uLitColor; uniform vec3 uShadowColor;
      uniform vec3 uHighlightColor; uniform float uHighlightStart; uniform float uHighlightEnd;
      uniform float uLeafShadowDarkness;
      ${shader.fragmentShader}
    `.replace('#include <color_fragment>', /* glsl */`#include <color_fragment>
      ${SHADOW_GLSL}
      // How far round its own canopy this leaf is toward the sun: -1 facing
      // away, +1 facing it.
      vec3 fromCenterToSurface = normalize(vLeafWorld - vClumpCentre);
      float lightAlignment = dot(fromCenterToSurface, normalize(uLightDirection));
      float baseGradientFactor = smoothstep(uGradientStart, uGradientEnd, lightAlignment);
      vec3 baseColor = mix(uShadowColor, uLitColor, baseGradientFactor);
      float highlightFactor = smoothstep(uHighlightStart, uHighlightEnd, lightAlignment);
      vec3 gradientColor = mix(baseColor, uHighlightColor, highlightFactor);
      // The sun's shadow takes it down toward a fraction of itself. Only the
      // colour: the alpha is still the texture's, and still cuts the leaf out.
      diffuseColor.rgb = mix(gradientColor * uLeafShadowDarkness, gradientColor, shadow);`)
      // Every leaf faces the sky, so every card takes the same light.
      .replace('#include <normal_fragment_begin>', /* glsl */`#include <normal_fragment_begin>
      normal = normalize(mat3(viewMatrix) * vec3(0.0, 1.0, 0.0));
      nonPerturbedNormal = normal;`);
  };
  // All four canopies compile to the same program; their centres are
  // uniforms, so only the values differ.
  material.customProgramCacheKey = () => 'fluffyTreeCanopy';
  return material;
}

/**
 * Load the tree out of the original's scene.
 *
 * @returns {Promise<{ object: THREE.Group, uniforms: object,
 *   trunkShadow: { value: number },
 *   place(opts: { x: number, z: number, facing: THREE.Vector3,
 *     heightAt(x: number, z: number): number }): void,
 *   setSunDirection(direction: THREE.Vector3): void,
 *   update(dt: number): void, dispose(): void }>}
 */
export async function loadTree() {
  const gltf = await loadGLTF(TREE_URL);

  // --- the tree out of its scene ------------------------------------------------
  const canopies = [];
  let trunk = null;
  const unused = [];
  gltf.scene.traverse((child) => {
    if (!child.isMesh) return;
    const name = key(child.name);
    if (name.startsWith(CANOPY_PREFIX)) canopies.push(child);
    else if (name.startsWith(TRUNK_PREFIX)) trunk = child;
    else unused.push(child);
  });
  if (!trunk || canopies.length === 0) {
    throw new Error(`${TREE_URL}: expected a trunk and canopies, found ${canopies.length} canopies${trunk ? '' : ' and no trunk'}`);
  }
  // Anything else in the file. There is nothing else in fluffy-tree.glb -- the
  // original's hill and grass were cut out of it -- but a model swapped in
  // later might carry more, and it is never drawn, so it is let go.
  for (const mesh of unused) disposeObject(mesh);

  // --- measured, and brought to its feet ------------------------------------------
  // The model stands on a hill of its own, its foot about four metres up.
  // Where the trunk meets the ground is the average of its lowest vertices.
  gltf.scene.updateMatrixWorld(true);
  const footAt = new THREE.Vector3();
  {
    const position = trunk.geometry.getAttribute('position');
    const point = new THREE.Vector3();
    let lowest = Infinity;
    for (let i = 0; i < position.count; i += 1) {
      point.fromBufferAttribute(position, i).applyMatrix4(trunk.matrixWorld);
      lowest = Math.min(lowest, point.y);
    }
    let count = 0;
    for (let i = 0; i < position.count; i += 1) {
      point.fromBufferAttribute(position, i).applyMatrix4(trunk.matrixWorld);
      if (point.y < lowest + 0.3) {
        footAt.add(point);
        count += 1;
      }
    }
    footAt.divideScalar(count);
    footAt.y = lowest;
  }
  const bounds = new THREE.Box3();
  for (const mesh of [trunk, ...canopies]) bounds.expandByObject(mesh);
  const scale = TREE_HEIGHT / Math.max(bounds.max.y - footAt.y, 1e-3);

  // --- the shared look, and each canopy's own middle ------------------------------
  const uniforms = {
    uLightDirection: { value: new THREE.Vector3(0.4, 0.8, 0.3).normalize() },
    uGradientStart: { value: LOOK.gradientStart },
    uGradientEnd: { value: LOOK.gradientEnd },
    uLitColor: { value: new THREE.Color(LOOK.litColour) },
    uShadowColor: { value: new THREE.Color(LOOK.shadowColour) },
    uHighlightColor: { value: new THREE.Color(LOOK.highlightColour) },
    uHighlightStart: { value: LOOK.highlightStart },
    uHighlightEnd: { value: LOOK.highlightEnd },
    uLeafShadowDarkness: { value: LOOK.leafShadowDarkness },
    uTime: { value: 0 },
    uWindStrength: { value: WOBBLE.strength },
    uWindFrequency: { value: WOBBLE.frequency },
    uWindSpeed: { value: WOBBLE.speed },
  };
  const trunkShadow = { value: LOOK.trunkShadowDarkness };

  const leafTexture = canopies[0].material.map;
  if (!leafTexture) throw new Error(`${TREE_URL}: the canopy has no leaf texture`);
  for (const canopy of canopies) {
    // The canopy's middle, in its own space -- the vertex shader takes it
    // into the world with the rest of the mesh (see the note at the top).
    canopy.geometry.computeBoundingBox();
    const centre = canopy.geometry.boundingBox.getCenter(new THREE.Vector3());
    const original = canopy.material;
    canopy.material = canopyMaterial(leafTexture, centre, uniforms);
    // The texture carries on in the new material; only the old one goes.
    original.dispose();
    canopy.castShadow = true;
    // The crown shading its own underside is half of why it reads as a mass.
    canopy.receiveShadow = true;
  }

  darkenShadows(trunk.material, trunkShadow);
  // The export makes it double-sided; a closed trunk has no inside to show.
  trunk.material.side = THREE.FrontSide;
  trunk.castShadow = true;
  trunk.receiveShadow = true;

  // Out of the original's scene and into the tree's own: scaled to height,
  // foot on the origin.
  const model = new THREE.Group();
  for (const mesh of [trunk, ...canopies]) {
    mesh.applyMatrix4(mesh.parent.matrixWorld); // keep where it was in the file
    model.add(mesh);
  }
  model.scale.setScalar(scale);
  model.position.copy(footAt).multiplyScalar(-scale);

  const object = new THREE.Group();
  object.name = 'tree';
  object.add(model);

  const _facing = new THREE.Vector3();
  const _side = new THREE.Vector3();

  return {
    object,
    /** The look and the wobble, live -- for the debug panel. */
    uniforms,
    /** The trunk's shadow darkness, live. */
    trunkShadow,

    /**
     * Stand it over a spot -- the bench's -- with the trunk stepped back
     * behind it, on the ground there.
     */
    place({ x, z, facing, heightAt }) {
      flatDirection(facing, _facing);
      sideways(_facing, _side);

      const tx = x - _facing.x * TRUNK_BEHIND + _side.x * TRUNK_ASIDE;
      const tz = z - _facing.z * TRUNK_BEHIND + _side.z * TRUNK_ASIDE;

      object.position.set(tx, heightAt(tx, tz) - SINK, tz);
      // Turned any which way: one tree, and every trip a different side of it.
      object.rotation.set(0, Math.random() * Math.PI * 2, 0);
      object.updateMatrixWorld(true);
    },

    /**
     * Which way the sun is -- the light's own vector, updated in place
     * (outdoorLight.js), so each canopy's bright side follows the sun if it
     * moves. The original reads the light's position every frame for this.
     */
    setSunDirection(direction) {
      uniforms.uLightDirection.value = direction;
    },

    /**
     * A point on a limb to hang something from -- the egg chair
     * (scene/outside/eggChair.js) -- or null if no limb will do.
     *
     * Found on the trunk mesh itself, which carries the limbs, so whatever
     * hangs here hangs from wood rather than from a spot in the air. The limb
     * nearest the bearing asked for wins; then, at that spot, the LOWEST
     * vertex close by is taken -- the underside of the limb, where a rope
     * would go round it, rather than a vertex on top that the rope would have
     * to pass through.
     *
     * Call after place(): it reads the tree where it stands.
     *
     * @param {object} opts
     * @param {THREE.Vector3} opts.toward  which way from the trunk, in the world
     * @param {[number, number]} opts.reach  metres out from the trunk, least .. most
     * @param {[number, number]} opts.height  metres above the tree's foot, least .. most
     * @param {(point: THREE.Vector3) => boolean} [opts.accept]  any other test
     * @returns {THREE.Vector3|null}  in the world
     */
    findBranch({ toward, reach, height, accept = () => true }) {
      object.updateMatrixWorld(true);
      const foot = object.position;
      const position = trunk.geometry.getAttribute('position');
      const wanted = Math.atan2(toward.z, toward.x);
      const middle = (reach[0] + reach[1]) / 2;
      const point = new THREE.Vector3();
      let best = null;
      let bestScore = Infinity;
      for (let i = 0; i < position.count; i += 1) {
        point.fromBufferAttribute(position, i).applyMatrix4(trunk.matrixWorld);
        const dx = point.x - foot.x;
        const dz = point.z - foot.z;
        const out = Math.hypot(dx, dz);
        const up = point.y - foot.y;
        if (out < reach[0] || out > reach[1] || up < height[0] || up > height[1]) continue;
        if (!accept(point)) continue;
        // How far round from the bearing asked for, the short way...
        let turn = Math.abs(Math.atan2(dz, dx) - wanted);
        if (turn > Math.PI) turn = 2 * Math.PI - turn;
        // ...with a little preference for the middle of the reach.
        const score = turn + (0.25 * Math.abs(out - middle)) / reach[1];
        if (score < bestScore) {
          bestScore = score;
          best = point.clone();
        }
      }
      if (!best) return null;

      // The underside of the limb there.
      let under = best;
      for (let i = 0; i < position.count; i += 1) {
        point.fromBufferAttribute(position, i).applyMatrix4(trunk.matrixWorld);
        if (Math.hypot(point.x - best.x, point.z - best.z) < 0.22
          && point.y < under.y && point.y > best.y - 0.6) under = point.clone();
      }
      return under;
    },

    /**
     * The crown's extent in the world, as a box -- for things that come out
     * of it, like the falling leaves (scene/outside/fallingLeaves.js). Call
     * after place().
     */
    canopyBox() {
      object.updateMatrixWorld(true);
      const box = new THREE.Box3();
      for (const canopy of canopies) box.expandByObject(canopy);
      return box;
    },

    /** Call every frame: the wobble moves on. */
    update(dt) {
      uniforms.uTime.value += dt;
    },

    dispose() {
      // Once each: the four canopies share one leaf texture.
      disposeObject(object);
    },
  };
}
