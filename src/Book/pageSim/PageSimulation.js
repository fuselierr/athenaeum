import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import {
  SPINE_GAP, GRAVITY_MAG, OPEN_LIMIT,
  BC_MEET_ANGLE, BC_START_GAP, COVER_START_NEAR, COVER_START_FAR,
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
 
    // Placeholder gravity — setFlipped(false) in reset() picks the sign
    // that actually renders as "down" once the render-only flip above is
    // factored in.
    this.world = new RAPIER.World({ x: 0, y: GRAVITY_MAG, z: 0 });
 
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
 
  /**
   * Put a rendered page texture (e.g. a THREE.CanvasTexture from PDF.js)
   * onto one of the four visible surfaces ('A' | 'B' | 'C' | 'D', see
   * pageMeshes). Clears the placeholder tint color so the texture shows
   * at its own colors instead of being multiplied by it.
   */
  setPageTexture(slot, texture) {
    const mesh = this.pageMeshes[slot];
    if (!mesh) return;
    texture.colorSpace = THREE.SRGBColorSpace;
    mesh.material.map = texture;
    mesh.material.color.set(0xffffff);
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
   * Turn the whole book over. Every anchor sits at y = 0 and the hinge axis
   * is world X, so rotating the book 180° about the spine leaves every
   * position and the hinge axis unchanged — the only real change is which
   * way gravity pulls relative to the book, so a flip is exactly inverting
   * gravity's Y. `this.root` already renders everything rotated 180° about
   * the spine (which negates Y on the way to the screen), so physical
   * gravity points +Y for pages to visibly fall down in the default state.
   */
  setFlipped(v) {
    this.flipped = v;
    this.world.gravity = { x: 0, y: v ? -GRAVITY_MAG : GRAVITY_MAG, z: 0 };
  }
 
  toggleFlip() {
    this.setFlipped(!this.flipped);
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
 
  /**
   * B (front's far page) and C (back's near page) hinge from the same point
   * in space. Unlike the intra-spread correction there's no air cushion —
   * they aren't sealed together the way a spread's own two pages are — so
   * this is a pure hard "cannot pass through": snap both to the angle where
   * they meet and match angular velocities so they don't immediately
   * re-cross.
   */
  _enforceNoCrossingBC() {
    const bodyB = this.spreadFront.bodyFar;
    const bodyC = this.spreadBack.bodyNear;
    const angleB = pageAngle(bodyB);
    const angleC = pageAngle(bodyC);
    if (angleB <= angleC) return;
 
    const meet = (angleB + angleC) / 2;
    const sharedAngVel = (bodyB.angvel().x + bodyC.angvel().x) / 2;
    const pairs = [
      [bodyB, this.spreadFront.anchorFar],
      [bodyC, this.spreadBack.anchorNear],
    ];
    for (const [body, anchor] of pairs) {
      const t = pageTransform(anchor, meet);
      body.setTranslation(t.pos, true);
      body.setRotation(t.rot, true);
      body.setAngvel({ x: sharedAngVel, y: 0, z: 0 }, true);
    }
  }
 
  dispose() {
    this.spreadFront.dispose();
    this.spreadBack.dispose();
    this.world.free();
    this.root.parent?.remove(this.root);
  }
}