import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { WIND, WIND_GLSL } from './wind.js';

/**
 * A tree, outside, standing over the bench (scene/outside/parkBench.js).
 *
 * Grown in EZ-Tree (dgreenheck/ez-tree, MIT) and exported as a GLB: one mesh
 * of branches and one of leaves, with their own bark and leaf textures.
 *
 * SIZE. Unlike the rest of the scene's models this one is NOT authored in
 * metres -- it comes out of the generator about 85 units tall, which is its
 * own working scale and means nothing here. So it is measured and scaled to a
 * height in metres rather than drawn at a fixed multiplier: swap tree.glb for
 * another and it is still a tree's height, whatever units that one was saved
 * in. That is also why it does not use the furniture scale -- a tree is not
 * furniture, and normalizing by the model's own box is the point.
 *
 * WHERE ITS MIDDLE IS. The generator grows a tree up the Y axis from the
 * origin with the foot of the trunk at y = 0, so the group's origin is the
 * trunk and the ground is where it stands -- no recentring needed beyond
 * dropping the model onto y = 0. The bench cannot do that (it centres on its
 * own footprint) because a bought model's origin is wherever its author left
 * it.
 *
 * LEAVES ARE CUT OUT, NOT BLENDED -- alphaMode MASK in the GLB, which three
 * loads as alphaTest. That matters more here than it usually would: the
 * outdoors is fogged by depth AFTER the frame is drawn
 * (scene/outside/outdoorPost.js), and a blended surface writes no depth, so
 * blended leaves would be fogged as though they were the sky behind them --
 * a tree with its own foliage hanging in front of it. Cut-out leaves write
 * depth like anything solid and fog at the distance they actually are. It is
 * also what makes their shadows come out leaf-shaped rather than as a slab:
 * three carries alphaTest and the colour map into the depth material the
 * shadow map draws with.
 *
 * OVER THE BENCH. place() is given where the bench stands and which way it
 * faces, and steps the trunk BACK from it -- behind the backrest, a little to
 * one side -- so the canopy is overhead and the view from the seat is not
 * through a trunk. The canopy is wide enough (about half the tree's height,
 * either side) that the bench sits well inside it.
 *
 * NO CLEARING. Grass grows right up to the trunk, which is what grass does;
 * the bench keeps the one clearing the field allows (grass.js's setClearing).
 *
 * ---------------------------------------------------------------------------
 * IT MOVES IN THE WIND -- the same wind as the grass (scene/outside/wind.js),
 * so a gust crosses the clearing and flattens the grass and stirs the canopy
 * as it passes, rather than the two blowing in separate weather.
 *
 * The GLB is a still model: EZ-Tree's own runtime animates a tree it is
 * holding, through its materials, and a baked export has none of that. So the
 * movement is put back in the vertex shader, in two parts that a real tree
 * has and a single wobble does not:
 *
 *   SWAY, the whole crown leaning downwind. By the height of the vertex above
 *   the foot, steepened (^1.6), so the trunk is planted, the boughs give a
 *   little and the top moves most -- a tree bends along its length, it does
 *   not pivot at the ground. Branches and leaves take exactly the same sway,
 *   so the foliage stays on the twigs it belongs to.
 *
 *   FLUTTER, each leaf turning on its own. This is the part you actually read
 *   as "wind in a tree", and it is why the leaves needed taking apart: the
 *   export is 11,200 four-cornered leaves, laid out as consecutive runs of
 *   four vertices, so every leaf is given the middle of its own quad as an
 *   anchor and a phase of its own, and turns about that anchor as a rigid
 *   card. Displacing leaf vertices independently -- by their position, say --
 *   would tear every leaf into four drifting corners.
 *
 * The turn is applied to the leaf's NORMAL as well as its corners, so a leaf
 * catches the sun as it comes round and the canopy glitters instead of just
 * shifting. Flutter is scaled by the gust, so the tree goes quiet between
 * gusts rather than fidgeting at a constant rate.
 *
 * ITS SHADOW DOES NOT MOVE. The sun's shadow map is drawn once and kept
 * (scene/outside/outdoorLight.js) -- nothing outdoors moved, before this --
 * and the depth pass it is drawn with is three's own, which knows nothing of
 * these shaders. So the tree's shadow is the still tree's. Under a canopy
 * that is hard to catch; making it follow would mean redrawing the whole
 * terrain's shadows every frame, for dappling on grass you are usually
 * standing above.
 */

const TREE_URL = '/tree.glb';

// World units -- metres, like everything else outdoors.
const TREE_HEIGHT = 12; // a grown broadleaf, tall enough to be a canopy and not a bush
const TRUNK_BEHIND = 2.4; // back from the middle of the bench, clear of its backrest
const TRUNK_ASIDE = 0.9; // and off to one side, so it does not stand dead centre
const SINK = 0.12; // the foot pressed into the ground, so no root floats on a slope

// --- how much it moves -------------------------------------------------------------
// How far the top of the tree leans downwind at the height of a gust, as a
// fraction of its own height: at 12 m, about 40 cm. Enough to see against the
// sky, short of a gale.
const SWAY = 0.034;
// How far a leaf turns on its own, in radians -- a third of a turn at the
// height of a gust, which is a leaf showing you its back.
const FLUTTER = 0.55;
// Flutter against sway: a leaf turns several times over while the crown makes
// one slow lean.
const FLUTTER_RATE = 3.1;
// What a leaf still does in the lull between gusts, as a share of its flutter.
const FLUTTER_IDLE = 0.35;

/**
 * Every leaf given the middle of its own quad, and a phase to flutter on.
 *
 * The export lays leaves out as runs of four vertices, one quad each --
 * checked here rather than trusted, because a model that is not built that
 * way would come apart at the corners. Returns whether it could be done.
 */
function anchorLeaves(geometry) {
  const position = geometry.getAttribute('position');
  const index = geometry.getIndex();
  const leaves = position.count / 4;
  // Four corners each, two triangles each, and the first quad wound the way
  // the rest are assumed to be.
  if (!Number.isInteger(leaves) || !index || index.count !== leaves * 6) return false;
  for (let corner = 0; corner < 6; corner += 1) {
    if (index.getX(corner) !== [0, 1, 2, 0, 2, 3][corner]) return false;
  }

  const anchor = new Float32Array(position.count * 4);
  for (let leaf = 0; leaf < leaves; leaf += 1) {
    const first = leaf * 4;
    let x = 0;
    let y = 0;
    let z = 0;
    for (let corner = 0; corner < 4; corner += 1) {
      x += position.getX(first + corner);
      y += position.getY(first + corner);
      z += position.getZ(first + corner);
    }
    x /= 4;
    y /= 4;
    z /= 4;
    // A phase from where it grew, so the same leaf flutters the same way
    // every visit and no two neighbours move together.
    const hash = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453;
    const phase = (hash - Math.floor(hash)) * Math.PI * 2;
    for (let corner = 0; corner < 4; corner += 1) {
      const at = (first + corner) * 4;
      anchor[at] = x;
      anchor[at + 1] = y;
      anchor[at + 2] = z;
      anchor[at + 3] = phase;
    }
  }
  geometry.setAttribute('leafAnchor', new THREE.BufferAttribute(anchor, 4));
  return true;
}

/**
 * Teach a material to lean in the wind, sharing the tree's uniforms.
 *
 * The sway is worked out in the tree's OWN frame, from a wind direction that
 * place() turns into it: the vertex shader has the model's untransformed
 * position to hand and nothing else, and turning one direction on the CPU
 * once is cheaper than putting every vertex into the world and back.
 * Everything is expressed as a fraction of the model's own height, so the
 * scale that makes the tree 12 m tall carries the movement with it.
 */
function leanInWind(material, uniforms, { leaf }) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader.replace('void main() {', /* glsl */`
      uniform float treeTime;
      uniform vec2 treeWindWorld;
      uniform vec2 treeWindLocal;
      uniform float treeWindSpeed;
      uniform float treeSway;
      uniform float treeFlutter;
      uniform float treeLocalHeight;
      ${leaf ? 'attribute vec4 leafAnchor;' : ''}
      ${WIND_GLSL}
      void main() {`);

    // Worked out where the NORMAL is first touched, so a leaf's turn reaches
    // its lighting as well as its corners -- both chunks are inlined into the
    // one main(), so what is declared here is still in hand below.
    shader.vertexShader = shader.vertexShader.replace('#include <beginnormal_vertex>', /* glsl */`
      #include <beginnormal_vertex>

      // Leaves ask the wind where their own middle is, so all four corners of
      // a leaf get one answer and the quad stays a quad.
      vec3 treeRoot = ${leaf ? 'leafAnchor.xyz' : 'position'};
      float treeGust = windGust(
        (modelMatrix * vec4(treeRoot, 1.0)).xz, treeTime, treeWindWorld, treeWindSpeed);
      // Planted at the foot, most at the top.
      float treeBend = pow(clamp(treeRoot.y / treeLocalHeight, 0.0, 1.0), 1.6);
      vec2 treeLean = treeWindLocal * treeGust * treeSway * treeBend * treeLocalHeight;
      ${leaf ? /* glsl */`
      float leafTurn = sin(treeTime * ${FLUTTER_RATE.toFixed(2)} * treeWindSpeed + leafAnchor.w)
        * treeFlutter * mix(${FLUTTER_IDLE.toFixed(2)}, 1.0, treeGust);
      float leafCos = cos(leafTurn);
      float leafSin = sin(leafTurn);
      mat3 leafSpin = mat3(leafCos, 0.0, leafSin, 0.0, 1.0, 0.0, -leafSin, 0.0, leafCos);
      objectNormal = leafSpin * objectNormal;
      ` : ''}`);

    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', /* glsl */`
      #include <begin_vertex>
      ${leaf ? 'transformed = leafAnchor.xyz + leafSpin * (transformed - leafAnchor.xyz);' : ''}
      transformed.xz += treeLean;`);
  };
  // Branches and leaves compile from the same three material, patched two
  // different ways: without this they would share one cached program and
  // whichever built first would draw both.
  material.customProgramCacheKey = () => (leaf ? 'treeLeaf' : 'treeBranch');
}

/**
 * @returns {Promise<{ object: THREE.Group, height: number, canopyRadius: number,
 *   place(opts: { x: number, z: number, facing: THREE.Vector3,
 *     heightAt(x: number, z: number): number }): void,
 *   update(dt: number): void, dispose(): void }>}
 */
export async function loadTree() {
  const gltf = await new GLTFLoader().loadAsync(TREE_URL);
  const model = gltf.scene;

  // Measured, then scaled to a tree's height and dropped onto the ground.
  model.updateMatrixWorld(true);
  const raw = new THREE.Box3().setFromObject(model);
  const rawSize = raw.getSize(new THREE.Vector3());
  const scale = rawSize.y > 1e-6 ? TREE_HEIGHT / rawSize.y : 1;
  model.scale.setScalar(scale);
  model.position.y = -raw.min.y * scale;

  const wind = new THREE.Vector2(...WIND.direction).normalize();
  const uniforms = {
    treeTime: { value: 0 },
    treeWindWorld: { value: wind.clone() },
    treeWindLocal: { value: wind.clone() }, // until place() turns it
    treeWindSpeed: { value: WIND.speed },
    treeSway: { value: SWAY },
    treeFlutter: { value: FLUTTER },
    treeLocalHeight: { value: rawSize.y },
  };

  model.traverse((child) => {
    if (!child.isMesh) return;
    child.castShadow = true;
    const leaf = child.material?.name === 'leaves';
    // Bark takes the shade of its own branches; leaves are lit from both
    // sides by the sky light and only muddy if they take shadow as well.
    child.receiveShadow = !leaf;
    // A leaf that could not be anchored still sways with the crown; it just
    // does not turn on its own.
    const flutters = leaf && anchorLeaves(child.geometry);
    if (leaf && !flutters) console.warn('The leaves are not quads; the tree will sway but not flutter.');
    leanInWind(child.material, uniforms, { leaf: flutters });
  });

  const object = new THREE.Group();
  object.name = 'tree';
  object.add(model);
  object.updateMatrixWorld(true);

  // How far the leaves reach from the trunk -- the wider of the two ways
  // across, halved. What the canopy covers.
  const canopyRadius = (Math.max(rawSize.x, rawSize.z) * scale) / 2;

  const _facing = new THREE.Vector3();
  const _side = new THREE.Vector3();
  const _local = new THREE.Vector3();
  const _turn = new THREE.Quaternion();

  const tree = {
    object,
    height: rawSize.y * scale,
    canopyRadius,

    /**
     * Stand it over a spot -- the bench's -- with the trunk stepped back
     * behind it, on the ground there.
     *
     * @param {object} opts
     * @param {number} opts.x  where the bench stands
     * @param {number} opts.z
     * @param {THREE.Vector3} opts.facing  the way the bench faces
     * @param {(x: number, z: number) => number} opts.heightAt  the ground
     */
    place({ x, z, facing, heightAt }) {
      _facing.set(facing.x, 0, facing.z);
      if (_facing.lengthSq() < 1e-8) _facing.set(0, 0, -1);
      _facing.normalize();
      _side.set(-_facing.z, 0, _facing.x);

      // Behind the bench, and off to one side of it.
      const tx = x - _facing.x * TRUNK_BEHIND + _side.x * TRUNK_ASIDE;
      const tz = z - _facing.z * TRUNK_BEHIND + _side.z * TRUNK_ASIDE;

      object.position.set(tx, heightAt(tx, tz) - SINK, tz);
      // Turned any which way: one tree, and every trip outside a different
      // side of it toward you.
      object.rotation.set(0, Math.random() * Math.PI * 2, 0);
      object.updateMatrixWorld(true);

      // Which way downwind is, once the tree has been turned -- so however it
      // stands, it leans the way the grass around it does.
      _turn.copy(object.quaternion).invert();
      _local.set(uniforms.treeWindWorld.value.x, 0, uniforms.treeWindWorld.value.y)
        .applyQuaternion(_turn);
      uniforms.treeWindLocal.value.set(_local.x, _local.z);
    },

    /** Call every frame: the gust rolls on. */
    update(dt) {
      uniforms.treeTime.value += dt;
    },

    dispose() {
      object.traverse((child) => {
        if (!child.isMesh) return;
        child.geometry.dispose();
        for (const material of [].concat(child.material)) {
          for (const value of Object.values(material)) if (value?.isTexture) value.dispose();
          material.dispose();
        }
      });
    },
  };
  return tree;
}
