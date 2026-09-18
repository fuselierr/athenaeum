import * as THREE from 'three';
import { WIND } from './wind.js';

/**
 * Leaves falling from the tree (scene/outside/tree.js).
 *
 * A hundred or so, each one simulated on its own, drawn as one instanced mesh
 * -- one draw call for the lot. Each leaf goes round the same loop:
 *
 *   OUT OF THE CROWN. Born somewhere in the lower half of the canopy's own
 *   extent, so it appears from among the leaves rather than from the air.
 *
 *   FALLING, the way a leaf falls and a stone does not. Slowly -- a leaf
 *   reaches its terminal speed almost at once, well under a metre a second --
 *   drifting downwind, and SWINGING: side to side like a pendulum, rising a
 *   little at each end of the swing and rocking with it, which is the motion
 *   the eye knows as a falling leaf. Some tumble over and over instead.
 *
 *   ON THE GROUND, lying flat where it landed on the terrain for a few
 *   seconds, then shrinking away and starting again from the crown.
 *
 * STARTED PART WAY. At the start each leaf is put somewhere along its own fall,
 * or already lying on the ground, so you arrive to a tree that has been
 * dropping leaves for a while rather than one that lets go of all of them at
 * once.
 *
 * WHAT THEY DO NOT DO. They drift with the wind's DIRECTION, not its gusts --
 * the gusts live in a noise texture that only the shaders read
 * (scene/outside/wind.js), and a leaf moved on the CPU cannot see it. They
 * pass through the bench and the egg chair rather than landing on them. And
 * they cast no shadow: the sun's shadow map is drawn once and kept
 * (outdoorLight.js), and a shadow that stayed where a leaf used to be would be
 * worse than none. They do RECEIVE the tree's shadow, so a leaf falling under
 * the crown is dim until it drifts out into the sun.
 */

// --- how many and how big -----------------------------------------------------------
const LEAVES = 96;
const SIZE = [0.1, 0.16]; // metres, tip to stem

// --- how they fall ------------------------------------------------------------------
const FALL = [0.45, 0.9]; // metres a second, straight down
const DRIFT = 0.35; // metres a second downwind, at most
const SWING = [0.12, 0.34]; // metres either side at the widest of the swing
const SWING_RATE = [1.6, 2.9]; // radians a second: how quick each swing is
const ROCK = 0.85; // radians a leaf tips at the end of a swing
const TUMBLERS = 0.3; // the share that tumble over and over instead of swinging
const TUMBLE_RATE = [2.5, 6]; // radians a second

// --- on the ground --------------------------------------------------------------------
const REST = [3, 8]; // seconds lying where it landed
const FADE = 0.8; // seconds shrinking away
const LIFT = 0.012; // metres above the ground it lies, so it does not flicker into it

// --- where they come from ----------------------------------------------------------------
// Of the crown's box: the share of its height, from the bottom, they are born in.
const BIRTH_HEIGHT = [0.12, 0.55];
// And how far out across it, as a share of its half-width -- inside the rounded
// crown, not in the empty corners of the box around it.
const BIRTH_REACH = 0.8;

// Greens toward yellow: older leaves than the ones still on the tree, which is
// why they are coming down.
const COLOURS = [0x7bd12e, 0x9bd534, 0xb9c83a, 0x86c32a, 0xd4b43c, 0x6fb82a];

const between = (range) => THREE.MathUtils.lerp(range[0], range[1], Math.random());

/**
 * One leaf's shape, drawn: a pointed oval with a stem and a midrib, white on
 * clear. The colour comes from each leaf's own instance colour; the drawing
 * only says where the leaf is and shades its midrib a touch.
 */
function leafTexture() {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  const middle = size / 2;

  context.fillStyle = '#fff';
  context.beginPath();
  context.moveTo(middle, 4); // the tip
  context.bezierCurveTo(size - 8, 18, size - 12, 42, middle, size - 12);
  context.bezierCurveTo(12, 42, 8, 18, middle, 4);
  context.fill();

  // The midrib and the stem.
  context.strokeStyle = 'rgba(200, 205, 190, 1)';
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(middle, 8);
  context.lineTo(middle, size - 2);
  context.stroke();

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  return texture;
}

/**
 * @param {object} opts
 * @param {object} opts.tree  the tree, already placed -- they fall from its crown
 * @param {(x: number, z: number) => number} opts.heightAt  the ground they land on
 * @returns {{ object: THREE.InstancedMesh, settings: object,
 *   update(dt: number): void, dispose(): void }}
 */
export function createFallingLeaves({ tree, heightAt }) {
  const crown = tree.canopyBox();
  const crownMiddle = crown.getCenter(new THREE.Vector3());
  const crownSize = crown.getSize(new THREE.Vector3());
  const downwind = new THREE.Vector3(WIND.direction[0], 0, WIND.direction[1]).normalize();

  // Live, for the debug panel: multipliers on the numbers above.
  const settings = { fall: 1, drift: 1, swing: 1 };

  const texture = leafTexture();
  const geometry = new THREE.PlaneGeometry(1, 1);
  const material = new THREE.MeshLambertMaterial({
    map: texture,
    alphaTest: 0.5,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.InstancedMesh(geometry, material, LEAVES);
  mesh.name = 'fallingLeaves';
  mesh.castShadow = false; // see the note at the top
  mesh.receiveShadow = true;
  // They are everywhere under the crown and never still; bounds computed from
  // one unit quad at the origin would cull them all.
  mesh.frustumCulled = false;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

  const colour = new THREE.Color();
  const X = new THREE.Vector3(1, 0, 0);
  const Y = new THREE.Vector3(0, 1, 0);
  const flat = new THREE.Quaternion().setFromAxisAngle(X, -Math.PI / 2); // the quad lying face up

  /** A new leaf's life, from the crown. */
  function spawn(leaf) {
    const around = Math.random() * Math.PI * 2;
    const out = Math.sqrt(Math.random()) * BIRTH_REACH;
    leaf.base.set(
      crownMiddle.x + Math.cos(around) * out * crownSize.x / 2,
      crown.min.y + crownSize.y * between(BIRTH_HEIGHT),
      crownMiddle.z + Math.sin(around) * out * crownSize.z / 2,
    );
    leaf.state = 'falling';
    leaf.time = 0;
    leaf.size = between(SIZE);
    leaf.fall = between(FALL);
    leaf.drift = 0.5 + Math.random() * 0.5;
    leaf.swing = between(SWING);
    leaf.swingRate = between(SWING_RATE);
    leaf.phase = Math.random() * Math.PI * 2;
    const swingAngle = Math.random() * Math.PI * 2;
    leaf.swingAxis.set(Math.cos(swingAngle), 0, Math.sin(swingAngle));
    // It rocks about the horizontal at right angles to its swing.
    leaf.rockAxis.set(-leaf.swingAxis.z, 0, leaf.swingAxis.x);
    leaf.spin = Math.random() * Math.PI * 2;
    leaf.spinRate = (Math.random() - 0.5) * 1.2;
    leaf.tumbles = Math.random() < TUMBLERS;
    leaf.tumbleRate = between(TUMBLE_RATE);
    leaf.tumbleAxis.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
  }

  const leaves = [];
  for (let i = 0; i < LEAVES; i += 1) {
    const leaf = {
      base: new THREE.Vector3(),
      at: new THREE.Vector3(),
      turn: new THREE.Quaternion(),
      swingAxis: new THREE.Vector3(),
      rockAxis: new THREE.Vector3(),
      tumbleAxis: new THREE.Vector3(),
    };
    spawn(leaf);
    // Started part way: most somewhere down their fall, a few already down.
    if (Math.random() < 0.2) {
      leaf.state = 'resting';
      leaf.rest = Math.random() * REST[1];
      leaf.at.set(leaf.base.x, heightAt(leaf.base.x, leaf.base.z) + LIFT, leaf.base.z);
      leaf.turn.setFromAxisAngle(Y, leaf.spin).multiply(flat);
    } else {
      const ground = heightAt(leaf.base.x, leaf.base.z);
      leaf.base.y = THREE.MathUtils.lerp(leaf.base.y, ground + 0.3, Math.random());
      leaf.time = Math.random() * 10;
    }
    mesh.setColorAt(i, colour.setHex(COLOURS[i % COLOURS.length]));
    leaves.push(leaf);
  }
  mesh.instanceColor.needsUpdate = true;

  const _rock = new THREE.Quaternion();
  const _spin = new THREE.Quaternion();
  const _tumble = new THREE.Quaternion();
  const _scale = new THREE.Vector3();
  const _matrix = new THREE.Matrix4();

  return {
    object: mesh,
    settings,

    /** Call every frame. */
    update(dt) {
      for (let i = 0; i < leaves.length; i += 1) {
        const leaf = leaves[i];
        let scale = leaf.size;

        if (leaf.state === 'falling') {
          leaf.time += dt;
          // Down at its own speed, and downwind -- a little more and a little
          // less as it goes, so neighbours do not drift as one.
          leaf.base.y -= leaf.fall * settings.fall * dt;
          const gusting = 0.7 + 0.3 * Math.sin(leaf.time * 0.6 + leaf.phase);
          leaf.base.addScaledVector(downwind, DRIFT * settings.drift * leaf.drift * gusting * dt);

          const phase = leaf.phase + leaf.time * leaf.swingRate;
          const swing = leaf.swing * settings.swing;
          leaf.at.copy(leaf.base).addScaledVector(leaf.swingAxis, Math.sin(phase) * swing);
          // Rising a little at each end of the swing, as a real one does.
          leaf.at.y += swing * 0.35 * (1 - Math.cos(2 * phase)) * 0.5;

          leaf.spin += leaf.spinRate * dt;
          _spin.setFromAxisAngle(Y, leaf.spin);
          if (leaf.tumbles) {
            // Over and over, with only a little of the swing's rock.
            _tumble.setFromAxisAngle(leaf.tumbleAxis, leaf.time * leaf.tumbleRate);
            _rock.setFromAxisAngle(leaf.rockAxis, Math.cos(phase) * ROCK * 0.3);
            leaf.turn.copy(_rock).multiply(_tumble).multiply(_spin).multiply(flat);
          } else {
            // Face up, tipping toward the end of each swing.
            _rock.setFromAxisAngle(leaf.rockAxis, Math.cos(phase) * ROCK);
            leaf.turn.copy(_rock).multiply(_spin).multiply(flat);
          }

          const ground = heightAt(leaf.at.x, leaf.at.z);
          if (leaf.at.y <= ground + LIFT) {
            // Down: lying flat where it landed, turned however it came.
            leaf.state = 'resting';
            leaf.rest = between(REST);
            leaf.at.y = ground + LIFT;
            leaf.turn.setFromAxisAngle(Y, leaf.spin).multiply(flat);
          }
        } else if (leaf.state === 'resting') {
          leaf.rest -= dt;
          if (leaf.rest <= 0) {
            leaf.state = 'fading';
            leaf.rest = FADE;
          }
        } else {
          leaf.rest -= dt;
          scale = leaf.size * Math.max(leaf.rest / FADE, 0);
          if (leaf.rest <= 0) spawn(leaf);
        }

        _scale.setScalar(scale);
        _matrix.compose(leaf.at, leaf.turn, _scale);
        mesh.setMatrixAt(i, _matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
    },

    dispose() {
      geometry.dispose();
      material.dispose();
      texture.dispose();
      mesh.dispose();
    },
  };
}
