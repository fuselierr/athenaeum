import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import {
  SPINE_GAP, GRAVITY_MAG, OPEN_LIMIT,
  BC_MEET_ANGLE, BC_START_GAP, COVER_START_NEAR, COVER_START_FAR, BC_FIXED_ANGLE,
  PSEUDO_REPEL_RATE, PSEUDO_COLLISION_RESTITUTION,
} from './config.js';
import { pageAngle, pageTransform } from './math.js';
import { createSpread } from './spread.js';
import { createHardcover } from '../cover/hardcover.js';

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

    // While a cover is being dragged its angle is dictated, not simulated.
    // null = that cover is back under gravity's control.
    this._coverHold = { A: null, D: null };

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

    // Rides the two outer cover pages; built here so it shares the
    // simulation's lifetime and the dimensions baked in above.
    this.hardcover = createHardcover({
      parent: this.root,
      coverPages: { front: this.spreadFront.flatMesh, back: this.spreadBack.flatMesh },
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

  // --- how a page texture is oriented on a panel ---------------------
  //
  // Two SEPARATE things decide this. Keeping them apart is what keeps the
  // reading direction adjustable without re-deriving the mirror bug.
  //
  // 1. HANDEDNESS CORRECTION (fixed by the geometry, never a choice).
  //    Every one of the four panels carries the SAME uv layout in its own
  //    frame -- measured, not assumed: u = 0 at x = -HINGE_LEN/2 and u = 1
  //    at x = +HINGE_LEN/2, v = 1 at the spine-side hinge and v = 0 at the
  //    outer edge (flat pages get this from PlaneGeometry's default uvs,
  //    the curl strips from writeCurlUV in curlGeometry.js). What differs
  //    is which way each panel extends from its hinge: A and B reach
  //    toward -Z, C and D toward +Z. So on A/B the frame (u across +X, v
  //    toward the spine) has the opposite HANDEDNESS, seen from the camera
  //    side, to the one C/D have -- u cross v points away from the viewer
  //    on A/B, toward it on C/D. A texture mapped through frames of
  //    opposite handedness comes out MIRRORED on one of them, and no
  //    amount of rotation fixes a mirror (that was the original bug: 'B'
  //    got texture.rotation = PI, which left its text still mirrored AND
  //    pointing the opposite way up from C's). Undoing a handedness flip
  //    takes a handedness flip -- exactly one mirrored axis on A/B, none
  //    on C/D.
  //
  // 2. READING ORIENTATION (a choice -- PAGE_TOP_AT_PLUS_X below).
  //    A page's top-to-bottom axis necessarily runs along the spine, i.e.
  //    world X, so the only question is which END of the spine the page
  //    tops point at. Flipping that choice is a 180-degree turn of the
  //    content in its own plane: it mirrors BOTH axes on every panel,
  //    which leaves each panel's handedness correction intact (two flips
  //    cancel) while swapping which spine end reads as "up" -- and with
  //    it, which side of the spine is the reader's right.
  //
  // true: page tops point at x = +HINGE_LEN/2, so a camera parked on the
  // -X side is looking from the pages' BOTTOM edge toward their top --
  // the normal way you sit at a book. That also puts the reader's right
  // at +Z, which is why main.js's RIGHT_HAND_PANEL is 'C' (C and D are
  // the +Z panels). Flip this to false and RIGHT_HAND_PANEL to 'B'
  // together -- they are two halves of one decision.
  static PAGE_TOP_AT_PLUS_X = true;

  // Which panels extend toward -Z from their hinge (A and B) rather than
  // +Z (C and D). TWO things follow from this single geometric fact, and
  // both matter:
  //
  //   * handedness -- these are the panels needing the mirrored axis
  //     described in (1) above.
  //   * facing -- a panel's own geometric front face points along
  //     u cross v, so on the -Z panels it points DOWN, away from a camera
  //     above the book. What you actually see of A or B is its BACK face
  //     (they render at all only because the page materials are
  //     DoubleSide). dragPageTurn.js keys off this to decide which side of
  //     its two-sided turning leaf carries which page.
  static SLOT_ON_MINUS_Z = { A: true, B: true, C: false, D: false };

  /**
   * True when `slot`'s own geometric front face points up, toward a
   * camera above the book -- i.e. when the surface you see is its front
   * rather than its back. See SLOT_ON_MINUS_Z.
   */
  static slotFrontFacesUp(slot) {
    return !PageSimulation.SLOT_ON_MINUS_Z[slot];
  }

  /**
   * Orient `texture` the way `slot` would show it -- colour space and uv
   * transform -- WITHOUT assigning it to that slot's mesh. For code that
   * needs a page oriented as some panel will show it while actually
   * drawing it somewhere else (dragPageTurn's turning leaf, whose two
   * faces belong to two different panels). setPageTexture is just this
   * plus the assignment.
   */
  orientPageTexture(slot, texture) {
    texture.colorSpace = THREE.SRGBColorSpace;

    // Start from the handedness correction (one mirrored axis, or none),
    // then apply the reading-orientation choice on top as a 180-degree
    // turn -- both axes -- if page tops belong at +X.
    let mirrorU = false;
    let mirrorV = PageSimulation.SLOT_ON_MINUS_Z[slot];
    if (PageSimulation.PAGE_TOP_AT_PLUS_X) {
      mirrorU = !mirrorU;
      mirrorV = !mirrorV;
    }

    texture.center.set(0.5, 0.5);
    texture.rotation = 0;
    texture.offset.set(0, 0);
    // A mirrored axis is repeat -1 about the centre, i.e. u -> 1 - u (or
    // v -> 1 - v); the result stays inside [0, 1] either way, so the
    // default ClampToEdge wrapping is fine and no wrap mode is touched.
    texture.repeat.set(mirrorU ? -1 : 1, mirrorV ? -1 : 1);
    return texture;
  }

  /**
   * Put a rendered page texture (e.g. a THREE.CanvasTexture from PDF.js)
   * onto one of the four visible surfaces ('A' | 'B' | 'C' | 'D', see
   * pageMeshes). Sets the placeholder material color to PAGE_TINT so the
   * texture reads as warm paper instead of being multiplied by pure white.
   *
   * Assumes the incoming canvas is oriented the way bookLoader.js renders
   * it -- pdf.js viewport rotation 270, which puts the page's top edge
   * along the canvas's left edge and the page's right edge along the
   * canvas's top. Every transform field is written on every call, never
   * just the ones that differ from the default: main.js's textureForPage
   * caches one CanvasTexture per page index and reuses it across slots as
   * the book is paged through, so a texture arriving here may still carry
   * the previous slot's transform.
   */
  setPageTexture(slot, texture) {
    const mesh = this.pageMeshes[slot];
    if (!mesh) return;
    this.orientPageTexture(slot, texture);

    mesh.material.map = texture;
    mesh.material.color.set(PageSimulation.PAGE_TINT);
    mesh.material.needsUpdate = true;
  }

  /**
   * The two cover slots as physics: A is the front spread's near page, D
   * the back spread's far one. Both hinge on the same axis with the same
   * angle convention as every other panel.
   */
  _coverRef(slot) {
    return slot === 'A'
      ? { body: this.spreadFront.bodyNear, anchor: this.spreadFront.anchorNear }
      : { body: this.spreadBack.bodyFar, anchor: this.spreadBack.anchorFar };
  }

  /** Where a cover's hinge sits along the spine. */
  coverHingeZ(slot) {
    return this._coverRef(slot).anchor.z;
  }

  /** Current swing angle of each cover, 0 = shut, OPEN_LIMIT = laid flat. */
  get coverAngles() {
    return {
      A: pageAngle(this.spreadFront.bodyNear),
      D: pageAngle(this.spreadBack.bodyFar),
    };
  }

  /**
   * Hold a cover open at `angle`, or pass null to let go and hand it back
   * to gravity. Applied inside step()'s correction pipeline rather than
   * from outside it, so the hold lands in the right order relative to
   * every other correction -- in particular BEFORE enforceNoPassingRef,
   * which is what still stops a dragged cover being shoved through the
   * page block.
   */
  setCoverHold(slot, angle) {
    this._coverHold[slot] = angle == null
      ? null
      : Math.max(0, Math.min(OPEN_LIMIT, angle));
  }

  _applyCoverHold() {
    for (const slot of ['A', 'D']) {
      const angle = this._coverHold[slot];
      if (angle == null) continue;
      const { body, anchor } = this._coverRef(slot);
      const t = pageTransform(anchor, angle);
      body.setTranslation(t.pos, true);
      body.setRotation(t.rot, true);
      body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
  }

  /**
   * Dress the hardcover -- front cover art, plus a synthesized spine and
   * back. See hardcover.setJacket. Returns a promise; the cover image is
   * fetched.
   */
  setJacket(jacket) {
    return this.hardcover.setJacket(jacket);
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
    // Correction pipeline, in order: (1) P1 cannot cross P2
    // (_enforceNoCrossingPseudo, touches only the pseudo bodies); (2) a
    // tiny constant push apart on top of THAT result (_applyPseudoRepulsion
    // -- deliberately AFTER, see its own comment for why); then (3) A
    // cannot cross P1 and D cannot cross P2 (enforceNoPassingRef, touches
    // only the real cover bodies). Steps 1 and 3 only ever move bodies the
    // OTHER treats as fixed, so neither can undo the other regardless of
    // order -- see spread.js's enforceNoPassingRef comment for why that
    // split matters.
    this._enforceNoCrossingPseudo();
    this._applyPseudoRepulsion(this.world.timestep); // capped, same effective dt world.step() just used
    this._applyCoverHold();
    this.spreadFront.enforceNoPassingRef();
    this.spreadBack.enforceNoPassingRef();

    this.spreadFront.sync();
    this.spreadBack.sync();
    this.hardcover.update(); // rides the cover meshes, so strictly after their sync
  }

  // B's and C's own hinge-tangent angle is a fixed constant (BC_FIXED_ANGLE)
  // for the entire lifetime of the book. Gravity itself never gets a
  // chance to touch it in the first place -- spread.js's drop() creates
  // both bodyB (spreadFront.bodyFar) and bodyC (spreadBack.bodyNear) with
  // gravityScale 0, so Rapier's own gravity force is simply never applied
  // to them, not even for one physics substep. What DOES still respond to
  // gravity is each spread's invisible pseudo body -- hinged at the same
  // anchor as its real reference/cover (A or D), same physics, gravityScale
  // 1, but never rendered and not A/D themselves (see spread.js's drop())
  // -- that's what drives the curl's SHAPE further out (buildCurlStrip's
  // refAngle, the straight run past the arc, ending at the tip), via
  // straightAngle() in spread.js. Only the tangent right at the shared
  // hinge is fixed; the bend is not.
  //
  // This still runs every frame regardless, re-asserting the exact fixed
  // angle and zeroing angular velocity -- not to fight gravity (there's
  // none to fight, per the above), but because bodyB/bodyC are still real
  // dynamic bodies on real revolute joints, and per-spread's own
  // enforceNoCrossing() (spread.js) can still nudge a curl body's angle
  // during stepPhysics() to keep it from visually crossing its spread's
  // cover -- this always runs after that, so it's the final word on where
  // B/C's hinge angle actually ends up.
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

  /**
   * A tiny constant angular push on the two pseudo bodies, always apart
   * from each other -- P1 (spreadFront's) toward a smaller angle, P2
   * (spreadBack's) toward a larger one -- independent of whatever gravity
   * itself is doing to them. See PSEUDO_REPEL_RATE's own comment in
   * config.js for why: without this, flipping the book over (setFlipped)
   * can leave gravity pulling P1 and P2 toward the exact same resting
   * angle, an unstable tie that would otherwise show up as the book
   * reading as collapsed shut (right at BC_FIXED_ANGLE) instead of open to
   * wherever it was last reading. PSEUDO_REPEL_RATE is small enough that
   * under ordinary gravity it's lost in everything else already moving
   * these bodies -- it only actually decides anything once real gravity
   * has nothing left to decide it instead.
   *
   * MUST run AFTER _enforceNoCrossingPseudo, not before -- that used to be
   * a real bug ("1 and 2 still combine and lock together" during
   * persistent contact): _enforceNoCrossingPseudo's collision response is
   * momentum-conserving between EXACTLY these two bodies, so a velocity
   * bias added right before it doesn't survive -- the same blend that
   * conserves momentum also (correctly, for a real collision) transfers
   * whichever body was pushed faster back to the other one, net
   * cancelling the push on any frame the two are still in contact. Applied
   * after instead, the push survives untouched into whatever the NEXT
   * frame's world.step() integrates positions from.
   */
  _applyPseudoRepulsion(dt) {
    const p1 = this.spreadFront.pseudoBody;
    const p2 = this.spreadBack.pseudoBody;
    const delta = PSEUDO_REPEL_RATE * dt;
    const av1 = p1.angvel().x;
    const av2 = p2.angvel().x;
    p1.setAngvel({ x: av1 - delta, y: 0, z: 0 }, true);
    p2.setAngvel({ x: av2 + delta, y: 0, z: 0 }, true);
  }

  /**
   * Keeps the two invisible pseudo bodies (spreadFront's, mirroring A;
   * spreadBack's, mirroring D -- see spread.js's drop()) from swinging past
   * being PARALLEL to each other. Both read their angle through the exact
   * same pageAngle/pageTransform formula, so "parallel" is simply
   * angleFront === angleBack -- past that point they'd have swapped which
   * one reads as "more open", which since curl shape is driven entirely by
   * these two angles (see straightAngle() in spread.js) would show up as
   * B's and C's curls suddenly swapping which one bends further.
   *
   * Only the pseudo bodies are touched here -- the real A/D covers keep
   * swinging completely freely, same as always. When crossed, both pseudo
   * angles are pulled back to meet exactly at their midpoint (position
   * still needs a hard, unconditional correction -- that's what actually
   * stops them visually crossing) and their angular velocity is resolved
   * as a proper 1D collision instead of just being zeroed: p1 and p2 are
   * equal mass/inertia (identical colliders -- see makePage), so momentum
   * conservation is a simple symmetric blend of their pre-collision
   * velocities, weighted by PSEUDO_COLLISION_RESTITUTION (0 = they end up
   * moving together at their shared momentum-conserving velocity, 1 = they
   * fully swap velocities -- see that constant's own comment in
   * config.js). Zeroing both, like this used to, silently threw away
   * whatever momentum they arrived with instead of conserving it.
   */
  _enforceNoCrossingPseudo() {
    const p1 = this.spreadFront.pseudoBody;
    const p2 = this.spreadBack.pseudoBody;
    const a1 = pageAngle(p1);
    const a2 = pageAngle(p2);
    if (a1 <= a2) return;

    const mid = (a1 + a2) / 2;
    const t1 = pageTransform(this.spreadFront.refAnchor, mid);
    p1.setTranslation(t1.pos, true);
    p1.setRotation(t1.rot, true);

    const t2 = pageTransform(this.spreadBack.refAnchor, mid);
    p2.setTranslation(t2.pos, true);
    p2.setRotation(t2.rot, true);

    const av1 = p1.angvel().x;
    const av2 = p2.angvel().x;
    const e = PSEUDO_COLLISION_RESTITUTION;
    const newAv1 = ((1 - e) * av1 + (1 + e) * av2) / 2;
    const newAv2 = ((1 + e) * av1 + (1 - e) * av2) / 2;
    p1.setAngvel({ x: newAv1, y: 0, z: 0 }, true);
    p2.setAngvel({ x: newAv2, y: 0, z: 0 }, true);
  }

  dispose() {
    this.hardcover.dispose();
    this.spreadFront.dispose();
    this.spreadBack.dispose();
    this.world.free();
    this.root.parent?.remove(this.root);
  }
}