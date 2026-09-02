import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import {
  SPINE_GAP, GRAVITY_MAG, OPEN_LIMIT,
  BC_MEET_ANGLE, BC_START_GAP, COVER_START_NEAR, COVER_START_FAR, BC_FIXED_ANGLE,
} from './config.js';
import { pageAngle, pageTransform } from './math.js';
import { createSpread } from './spread.js';

/**
 * PageSimulation
 * --------------
 * The physics-driven page mechanism ported from the standalone prototype:
 * two independent page-spreads (front: blue/red, back: teal/orange) chained
 * along the spine, each hinging and filling its own gap with its own
 * air-cushion easing, plus a hard "cannot pass through" stop between the two
 * inner pages. This simulates PAGES only — no spine/cover board yet.
 *
 * Usage:
 *   const pages = await PageSimulation.create(scene);
 *   // per frame:
 *   pages.step();           // or pages.step(dtSeconds) with your own clock
 *   // controls:
 *   pages.reset();          // re-drop
 *   pages.setFlipped(true); // turn the book over (inverts gravity)
 */
export class PageSimulation {
  /**
   * @param {THREE.Object3D} parent  scene (or any group) to attach the book to
   */
  static async create(parent) {
    await RAPIER.init();
    return new PageSimulation(parent);
  }

  constructor(parent) {
    // Everything is parented under this group so the whole book can be
    // turned over visually (rotation.x = PI) without touching the physics —
    // rigid bodies, anchors and the gravity-based flip all stay in their
    // own untouched world coordinates; this is a render-only transform.
    this.root = new THREE.Group();
    this.root.name = 'PageSimulation';
    this.root.rotation.x = Math.PI;
    parent.add(this.root);

    // Scratch vectors reused every frame by isCrossingBC (diagnostic only).
    this._tipB = new THREE.Vector3();
    this._tipC = new THREE.Vector3();

    // Placeholder gravity — reset() below calls _applyGravity(), which picks
    // the real vector once _gravityDir/flipped are set up.
    this.world = new RAPIER.World({ x: 0, y: GRAVITY_MAG, z: 0 });

    // Which way "down" points, in THIS GROUP'S PARENT's space (i.e.
    // whatever main.js's bookGroup wrapper — or plain `parent`, if there is
    // no such wrapper — considers world-down to be). Defaults to -Y, the
    // ordinary world-down assumption, so a caller that never calls
    // setGravityDirection() gets exactly the old fixed-gravity behavior.
    // See setGravityDirection()/​_applyGravity() for how this and `flipped`
    // combine into the actual physics vector.
    this._gravityDir = new THREE.Vector3(0, -1, 0);

    this.flipped = false;
    this._lastStep = 0; // timestamp of the previous step(), ms; 0 = not yet stepped

    // Z of the shared inner-leaf (B/C) hinge along the spine. 0 = centred
    // between the covers (the flush layout the prototype had); slide it
    // toward a cover to simulate flipping through the book — see
    // setBCPosition / setProgress.
    this._bcZ = 0;

    // Covers stay put: A pinned at +SPINE_GAP (front of the block), D at
    // -SPINE_GAP (back). Only the inner leaves' shared hinge (B's far
    // anchor, C's near anchor) moves, between the two.
    this.spreadFront = createSpread(this.world, this.root, {
      anchorNearZ: SPINE_GAP, anchorFarZ: this._bcZ, openLimit: OPEN_LIMIT,
      colorNear: 0x5b7fff, colorFar: 0xff6f6f, wedgeColor: 0xf2d98a,
      dampingNear: 0.32, dampingFar: 0.5,
      curlPage: 'far', // B molds itself to curve from its hinge to match A
    });
    this.spreadBack = createSpread(this.world, this.root, {
      anchorNearZ: this._bcZ, anchorFarZ: -SPINE_GAP, openLimit: OPEN_LIMIT,
      colorNear: 0x4fd1c5, colorFar: 0xffa94d, wedgeColor: 0xd9c48a,
      dampingNear: 0.5, dampingFar: 0.32,
      curlPage: 'near', // C molds itself to curve from its hinge to match D
    });

    this.reset();
  }

  // How far the shared B/C hinge may travel from centre before the curl and
  // wedge on the tighter side would collapse. +BC_RANGE = against cover A,
  // -BC_RANGE = against cover D.
  static get BC_RANGE() {
    return SPINE_GAP * 0.92;
  }

  get bcZ() {
    return this._bcZ;
  }

  /**
   * True whenever B and C's actual curled surfaces have visually crossed --
   * their tip positions along the spine are in the wrong order -- NOT just
   * whenever their hinge angles cross. Once the B/C hinge is off-center the
   * two spreads curl at different radii, so the base angle check
   * (angleB > angleC, what _enforceNoCrossingBC itself uses) can miss real
   * crossings the curved surfaces further out.
   *
   * Purely diagnostic: reading this never corrects or moves anything.
   */
  get isCrossingBC() {
    const tipB = this.spreadFront.curlTip(this._tipB);
    const tipC = this.spreadBack.curlTip(this._tipC);
    return tipB.z < tipC.z;
  }

  /**
   * Raw numbers behind isCrossingBC / _enforceNoCrossingBC, for a
   * permanent on-screen debug readout. Purely diagnostic.
   */
  get debugBC() {
    const angleB = pageAngle(this.spreadFront.bodyFar);
    const angleC = pageAngle(this.spreadBack.bodyNear);
    const tipB = this.spreadFront.curlTip(this._tipB);
    const tipC = this.spreadBack.curlTip(this._tipC);
    return {
      angleB, angleC, angleCrossing: angleB > angleC,
      tipBz: tipB.z, tipCz: tipC.z, tipCrossing: tipB.z < tipC.z,
    };
  }

  /**
   * The four page-shaped surfaces currently in the scene, front-to-back
   * along the spine: A (front cover, flat), B (front spread's curling
   * inner leaf), C (back spread's curling inner leaf), D (back cover,
   * flat). Meshes, not bodies -- for assigning page textures.
   */
  get pageMeshes() {
    return {
      A: this.spreadFront.flatMesh,
      B: this.spreadFront.curlMesh,
      C: this.spreadBack.curlMesh,
      D: this.spreadBack.flatMesh,
    };
  }

  // Multiplies every loaded page texture -- pure white (0xffffff) let the
  // PDF canvas's own white page background show through completely flat,
  // which read as harsh/off against the wedge's warm tan (0xf2d98a front /
  // 0xd9c48a back). A shade lighter than the wedge tans, blended toward
  // white, gives loaded pages a warmer "paper" tint instead of stark white
  // without meaningfully darkening the rendered text.
  static PAGE_TINT = 0xf5ecd2;

  /**
   * Put a rendered page texture (e.g. a THREE.CanvasTexture from PDF.js)
   * onto one of the four visible surfaces ('A' | 'B' | 'C' | 'D', see
   * pageMeshes). Sets the placeholder material color to PAGE_TINT so the
   * texture reads as warm paper instead of being multiplied by pure white.
   */
  setPageTexture(slot, texture) {
    const mesh = this.pageMeshes[slot];
    if (!mesh) return;
    texture.colorSpace = THREE.SRGBColorSpace;

    // B needs a 180° rotation to read right side up. TRIED AND REVERTED:
    // doing this by flipping raw per-vertex UV values on B's curl mesh (see
    // curlGeometry.js's writeCurlUV) -- it moved the right pixels to the
    // right place, but visibly distorted the text, since flipping the UV
    // traversal direction on a curved, non-square mesh isn't a clean
    // rotation the way it would be on a flat quad. This does the rotation
    // on the TEXTURE instead, via THREE.Texture's own rotation/center
    // (rotates about the texture's own centre, in UV space, independent of
    // the mesh) -- the mesh's UV data itself stays a single, simple,
    // un-hacked convention shared by every slot. Reset explicitly for every
    // other slot too, since a cached CanvasTexture (see main.js's
    // textureForPage) could in principle be reused across slots.
    texture.center.set(0.5, 0.5);
    texture.rotation = slot === 'B' ? Math.PI : 0;

    mesh.material.map = texture;
    mesh.material.color.set(PageSimulation.PAGE_TINT);
    mesh.material.needsUpdate = true;
  }

  /**
   * Slide the shared B/C hinge along the spine, clamped to
   * [-BC_RANGE, +BC_RANGE]. Covers A and D don't move. Cheap enough to call
   * every frame — drive it from an easing curve to animate a page flip.
   */
  setBCPosition(z) {
    const lim = PageSimulation.BC_RANGE;
    z = Math.max(-lim, Math.min(lim, z));
    if (z === this._bcZ) return;
    this._bcZ = z;
    this.spreadFront.moveAnchor('far', z);
    this.spreadBack.moveAnchor('near', z);
  }

  /** Normalized flip-through position: 0 = at cover A, 1 = at cover D. */
  setProgress(t) {
    t = Math.max(0, Math.min(1, t));
    this.setBCPosition(PageSimulation.BC_RANGE * (1 - 2 * t));
  }

  get progress() {
    return (1 - this._bcZ / PageSimulation.BC_RANGE) / 2;
  }

  /**
   * Re-drop both spreads. Covers (A, D) start splayed a few degrees inside
   * their [0, OPEN_LIMIT] range; the inner pages (B, C) start near
   * BC_MEET_ANGLE, a small gap apart — splaying them toward their open
   * extreme would send them through each other at t = 0.
   */
  reset() {
    this._bcZ = 0;
    this.spreadFront.moveAnchor('far', 0);
    this.spreadBack.moveAnchor('near', 0);
    this.spreadFront.drop(COVER_START_NEAR, BC_MEET_ANGLE - BC_START_GAP / 2);
    this.spreadBack.drop(BC_MEET_ANGLE + BC_START_GAP / 2, COVER_START_FAR);
    this.setFlipped(false);
    this._lastStep = 0; // next step() re-bases its delta instead of jumping
  }

  /**
   * Turn the whole book over, independent of whatever direction gravity is
   * currently coming from (see setGravityDirection) — a deliberate "look at
   * the other side" action, not a physical rotation. Implemented as an
   * extra sign flip in _applyGravity() rather than touching this.root's
   * transform, so it composes with a live gravity direction instead of
   * fighting it.
   */
  setFlipped(v) {
    this.flipped = v;
    this._applyGravity();
  }

  toggleFlip() {
    this.setFlipped(!this.flipped);
  }

  /**
   * Point gravity in a fixed real-world direction regardless of how this
   * simulation's own root (or an outer wrapper group, e.g. main.js's
   * bookGroup, which the caller is responsible for accounting for) is
   * currently rotated — so spinning the book via a trackball-style drag
   * makes pages actually sag toward true "down" instead of the physics
   * silently rotating along with the render transform (which is what
   * happens if you never call this: Rapier's gravity vector lives in this
   * group's own local/physics space and has no idea an outer transform
   * exists).
   *
   * @param {THREE.Vector3} dir  "down", expressed in THIS GROUP'S PARENT's
   *   local space (i.e. undo any outer wrapper's rotation yourself before
   *   calling this, the same way main.js does each frame with its
   *   bookGroup: `worldDown.clone().applyQuaternion(bookGroup.quaternion.clone().invert())`).
   *   Does NOT need this.root's own permanent 180° flip undone —
   *   _applyGravity() accounts for that itself, same as it always has.
   *   Magnitude is ignored; only direction matters.
   */
  setGravityDirection(dir) {
    this._gravityDir.copy(dir).normalize();
    this._applyGravity();
  }

  /**
   * Converts _gravityDir (this.root's PARENT's space) into this.root's own
   * local space — the same space the Rapier world's bodies/gravity actually
   * live in — by undoing this.root's fixed rotation.x = PI. That rotation
   * is a full 180°, which is its own inverse, so "undo" is just negating Y
   * and Z (the standard rotate-180-about-X formula with the y/z terms'
   * signs flipped) rather than needing a real matrix inverse. `flipped`
   * layers on top as one more sign flip, same role it always had.
   */
  _applyGravity() {
    const d = this._gravityDir;
    const sign = this.flipped ? -1 : 1;
    this.world.gravity = {
      x: d.x * GRAVITY_MAG * sign,
      y: -d.y * GRAVITY_MAG * sign,
      z: -d.z * GRAVITY_MAG * sign,
    };
  }

  /**
   * Advance the simulation. Pass an explicit delta (seconds), or omit it to
   * use wall-clock time since the previous step (capped at 1/30 s so a
   * stall or a background tab can't launch pages across the room).
   */
  step(dt) {
    if (dt === undefined) {
      const now = performance.now();
      dt = this._lastStep ? (now - this._lastStep) / 1000 : 1 / 60;
      this._lastStep = now;
    }
    this.world.timestep = Math.min(dt, 1 / 30);
    this.world.step();

    // Both spreads' own corrections, then the cross-spread inner-page stop,
    // all before either spread syncs its meshes — otherwise whichever
    // synced first would render a frame stale after the cross-correction.
    this.spreadFront.stepPhysics();
    this.spreadBack.stepPhysics();
    this._enforceNoCrossingBC();

    this.spreadFront.sync();
    this.spreadBack.sync();
  }

  _enforceNoCrossingBC() {
    const bodyB = this.spreadFront.bodyFar;
    const bodyC = this.spreadBack.bodyNear;
    const pairs = [
      [bodyB, this.spreadFront.anchorFar],
      [bodyC, this.spreadBack.anchorNear],
    ];
    for (const [body, anchor] of pairs) {
      const t = pageTransform(anchor, BC_FIXED_ANGLE);
      body.setTranslation(t.pos, true);
      body.setRotation(t.rot, true);
      body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
  }

  dispose() {
    this.spreadFront.dispose();
    this.spreadBack.dispose();
    this.world.free();
    this.root.parent?.remove(this.root);
  }
}