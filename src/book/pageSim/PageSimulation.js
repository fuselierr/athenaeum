import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import {
  SPINE_GAP, PANEL_REACH, HINGE_LEN, GRAVITY_MAG, OPEN_LIMIT,
  HARDCOVER_AIR_CUSHION_RANGE, AIR_CUSHION_MAX_RATE,
  BC_START_GAP, COVER_START_NEAR, COVER_START_FAR, bcFixedAngle,
  PSEUDO_REPEL_RATE, PSEUDO_COLLISION_RESTITUTION,
  SPINE_ROTATION, setSpineRotation, weighSpineTarget, spineEaseRate,
} from './config.js';
import { clampNum, pageAngle, pageTransform, spineHinge } from './math.js';
import { createSpread } from './spread.js';
import { createHardcover } from '../cover/hardcover.js';

// How close the two boards have to be for the book to count as shut, in
// radians of cover angle. Not zero: the air cushion eases the last few
// degrees of a closing board, and a book that has visibly come to rest
// shut should not read as open because a sliver of gap is still settling.
const CLOSED_GAP = 0.2;

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
    // SPINE_ROTATION is deliberately NOT part of it: the tilt moves the
    // hinges themselves (math.js's spineHinge), which is a deformation of
    // the book, not a rotation of it.
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

    // Whether the page block drives the spine's tilt (see
    // spineRotationTarget). On by default; a debug slider that wants to
    // pose the spine by hand turns it off via setSpineRotationDriven.
    this._spineDriven = true;

    // Z of the shared inner-leaf (B/C) hinge along the spine. 0 = centred
    // between the covers (the flush layout the prototype had); slide it
    // toward a cover to simulate flipping through the book — see
    // setBCPosition / setProgress.
    this._bcZ = 0;

    // H1/H2 are independent scalar cover dynamics. They have no Rapier
    // bodies and never read A, D, P1, or P2.
    this._hardcoverHold = { H1: null, H2: null };
    this._hardcoverAngles = { H1: COVER_START_NEAR, H2: COVER_START_FAR };
    this._hardcoverAngularVelocity = { H1: 0, H2: 0 };

    // The spreads' equivalent of _hardcoverHold: an angle to pin each
    // spread's pseudo body at, or null to leave it to gravity. What lifts a
    // half of the page block back over the spine when a closed book is
    // opened -- see setSpreadHold and reader/bookOpening.js.
    this._spreadHold = { front: null, back: null };

    // Covers stay put: A pinned at +SPINE_GAP (front of the block), D at
    // -SPINE_GAP (back). Only the inner leaves' shared hinge (B's far
    // anchor, C's near anchor) moves, between the two.
    this.spreadFront = createSpread(this.world, this.root, {
      anchorNearZ: SPINE_GAP, anchorFarZ: this._bcZ, openLimit: OPEN_LIMIT,
      hardcoverAngle: () => this._hardcoverAngles.H1,
      colorNear: 0x5b7fff, colorFar: 0xff6f6f, wedgeColor: 0xf2d98a,
      dampingNear: 0.32, dampingFar: 0.5,
      curlPage: 'far', // B molds itself to curve from its hinge to match A
    });
    this.spreadBack = createSpread(this.world, this.root, {
      anchorNearZ: this._bcZ, anchorFarZ: -SPINE_GAP, openLimit: OPEN_LIMIT,
      hardcoverAngle: () => this._hardcoverAngles.H2,
      colorNear: 0x4fd1c5, colorFar: 0xffa94d, wedgeColor: 0xd9c48a,
      dampingNear: 0.5, dampingFar: 0.32,
      curlPage: 'near', // C molds itself to curve from its hinge to match D
    });

    // Cross-wire each spread to the other's live hinge separation, so a
    // curl that bends OVER onto the far half of the book traces its arc
    // with the correct radius (spread.js's curlRadius()).
    this.spreadFront.setOtherPairGap(this.spreadBack.pairGap);
    this.spreadBack.setOtherPairGap(this.spreadFront.pairGap);

    // Render-only boards have independent angles and do not ride any page
    // or pseudo body.
    this.hardcover = createHardcover({
      parent: this.root,
      hardcoverAngles: {
        H1: () => this._hardcoverAngles.H1,
        H2: () => this._hardcoverAngles.H2,
      },
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

  /** Y/Z coordinates of each spine hinge and its tilted endpoints. */
  get spineHingePositions() {
    const read = (z) => {
      const hinge = spineHinge(z);
      return {
        midY: hinge.mid.y, midZ: hinge.mid.z,
        s1Y: hinge.s1.y, s1Z: hinge.s1.z,
        s2Y: hinge.s2.y, s2Z: hinge.s2.z,
      };
    };
    return {
      H1: read(SPINE_GAP),
      BC: read(this._bcZ),
      H2: read(-SPINE_GAP),
    };
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
   * The two cover hinges remain fixed in the page layout. The render-only
   * boards use their own angles and do not use these physics bodies.
   */
  _hardcoverRef(slot) {
    const spread = slot === 'H1' ? this.spreadFront : this.spreadBack;
    return { anchor: spread.refAnchor };
  }

  /** Where a cover's hinge sits along the spine. */
  hardcoverHingeZ(slot) {
    return this._hardcoverRef(slot).anchor.z;
  }

  /**
   * Hinge angles for the debug readout: A and D are the real cover PAGES
  * (freely-swinging bodies), P1 and P2 the two spreads' pseudo bodies.
  * A/D clamp against the independent H1/H2 hardcover angles: A >= H1
  * and D <= H2.
   */
  get panelAngles() {
    return {
      A: pageAngle(this.spreadFront.bodyNear),
      D: pageAngle(this.spreadBack.bodyFar),
      P1: pageAngle(this.spreadFront.pseudoBody),
      P2: pageAngle(this.spreadBack.pseudoBody),
    };
  }

  /** Current independent swing angle of each hardcover board. */
  get hardcoverAngles() {
    return { H1: this._hardcoverAngles.H1, H2: this._hardcoverAngles.H2 };
  }

  /**
   * Whether the book is shut, and what it needs before a page turn can be
   * seen.
   *
   * Read off the covers and the pseudo bodies, not off SPINE_ROTATION. The
   * spine does go to -1 or +1 in a shut book, but only as a consequence of
   * these same angles -- eased, lagging them by a fraction of a second,
   * and deliberately held back by weighSpineTarget's deadzone on a thick
   * book. The angles are the thing itself.
   *
   * A turn is visible only when the spine has a half of the block either
   * side of it: dragPageTurn sweeps its leaf from P1's angle to P2's, and
   * if both lie past the spine on the same side the sweep goes from there
   * to there. So, with pi/2 as "standing straight up off the spine":
   *
   *   closed   the two boards together (CLOSED_GAP). `side` is which way
   *            the book is folded -- 'front' when everything has swung
   *            over onto H2's side, i.e. the front board H1 is the one
   *            that swung and the one that has to swing back.
   *   needs    'cover'  the board on `side` is past the spine -- open it
   *            'spread' the board is open but that half of the block is
   *                     still lying on the other side -- lift it over
   *            null     readable; turn pages
   *
   * P1 <= P2 always (_enforceNoCrossingPseudo), so at most one half of the
   * block can be on the wrong side at once.
   */
  get openState() {
    const HALF_PI = Math.PI / 2;
    const { H1, H2 } = this._hardcoverAngles;
    const closed = H2 - H1 < CLOSED_GAP;
    if (closed) {
      return { closed, side: (H1 + H2) / 2 > HALF_PI ? 'front' : 'back', needs: 'cover' };
    }
    if (pageAngle(this.spreadFront.pseudoBody) > HALF_PI) {
      return { closed, side: 'front', needs: H1 > HALF_PI ? 'cover' : 'spread' };
    }
    if (pageAngle(this.spreadBack.pseudoBody) < HALF_PI) {
      return { closed, side: 'back', needs: H2 < HALF_PI ? 'cover' : 'spread' };
    }
    return { closed, side: null, needs: null };
  }

  /**
   * Pin a spread's pseudo body at `angle` ('front' = P1, 'back' = P2), or
   * pass null to hand it back to gravity. Applied inside step(), after the
   * covers settle and BEFORE the pseudo/reference ordering corrections, so
   * a held spread is still stopped by its board, and the reference page
   * sandwiched against it (A <= P1, P2 <= D -- spread.js's
   * enforceNoPassingRef) is carried along with it rather than left behind.
   */
  setSpreadHold(side, angle) {
    this._spreadHold[side] = angle == null ? null : Math.max(0, Math.min(OPEN_LIMIT, angle));
  }

  _applySpreadHold() {
    for (const [side, spread] of [['front', this.spreadFront], ['back', this.spreadBack]]) {
      const angle = this._spreadHold[side];
      if (angle == null) continue;
      const t = pageTransform(spread.refAnchor, angle);
      spread.pseudoBody.setTranslation(t.pos, true);
      spread.pseudoBody.setRotation(t.rot, true);
      spread.pseudoBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
  }

  /**
   * Hold a cover open at `angle`, or pass null to let go and hand it back
   * to gravity. Applied inside step()'s correction pipeline rather than
   * from outside it, so the hold lands in the right order relative to
   * every other correction -- in particular BEFORE enforceNoPassingRef,
   * which is what still stops a dragged cover being shoved through the
   * page block.
   */
  setHardcoverHold(slot, angle) {
    if (angle == null) {
      this._hardcoverHold[slot] = null;
      return;
    }
    let clamped = Math.max(0, Math.min(OPEN_LIMIT, angle));
    if (slot === 'H1') clamped = Math.min(clamped, this._hardcoverAngles.H2);
    if (slot === 'H2') clamped = Math.max(clamped, this._hardcoverAngles.H1);
    this._hardcoverHold[slot] = clamped;
  }

  _applyHardcoverHold() {
    for (const slot of ['H1', 'H2']) {
      const angle = this._hardcoverHold[slot];
      if (angle == null) continue;
      this._hardcoverAngles[slot] = angle;
      this._hardcoverAngularVelocity[slot] = 0;
    }
  }

  /** Keep the two independent hardcover angles in their physical order. */
  _enforceHardcoverOrder() {
    const h1 = this._hardcoverAngles.H1;
    const h2 = this._hardcoverAngles.H2;
    if (h1 <= h2) return;

    const mid = (h1 + h2) / 2;
    this._hardcoverAngles.H1 = mid;
    this._hardcoverAngles.H2 = mid;

    const v1 = this._hardcoverAngularVelocity.H1;
    const v2 = this._hardcoverAngularVelocity.H2;
    const restitution = PSEUDO_COLLISION_RESTITUTION;
    this._hardcoverAngularVelocity.H1 = ((1 - restitution) * v1 + (1 + restitution) * v2) / 2;
    this._hardcoverAngularVelocity.H2 = ((1 + restitution) * v1 + (1 - restitution) * v2) / 2;
  }

  /** Ease H1/H2's closing speed before their hard ordering stop. */
  _applyHardcoverAirCushion() {
    const gap = this._hardcoverAngles.H2 - this._hardcoverAngles.H1;
    if (gap <= 0 || gap >= HARDCOVER_AIR_CUSHION_RANGE) return;

    const v1 = this._hardcoverAngularVelocity.H1;
    const v2 = this._hardcoverAngularVelocity.H2;
    const closingRate = v1 - v2;
    const maxClosingRate = AIR_CUSHION_MAX_RATE * (gap / HARDCOVER_AIR_CUSHION_RANGE);
    if (closingRate <= maxClosingRate) return;

    const removed = closingRate - maxClosingRate;
    this._hardcoverAngularVelocity.H1 = v1 - removed / 2;
    this._hardcoverAngularVelocity.H2 = v2 + removed / 2;
  }

  /** Advance the independent hardcover angles under the simulation gravity. */
  _stepHardcoverGravity(dt) {
    const gravity = this.world.gravity;
    const gravityScale = 1.5 / PANEL_REACH;
    const damping = Math.exp(-0.8 * dt);

    for (const slot of ['H1', 'H2']) {
      const angle = this._hardcoverAngles[slot];
      // The board's hinge-to-edge direction is (0, -sin(angle), cos(angle)).
      // Its gravity torque about +X is r_y*g_z - r_z*g_y.
      const angularAcceleration = gravityScale
        * (-Math.sin(angle) * gravity.z - Math.cos(angle) * gravity.y);
      const velocity = (this._hardcoverAngularVelocity[slot] + angularAcceleration * dt) * damping;
      const next = angle + velocity * dt;
      const clamped = Math.max(0, Math.min(OPEN_LIMIT, next));
      this._hardcoverAngles[slot] = clamped;
      this._hardcoverAngularVelocity[slot] = clamped === next ? velocity : 0;
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
   * the meeting plane, a small gap apart — splaying them toward their open
   * extreme would send them through each other at t = 0.
   */
  reset() {
    this._bcZ = 0;
    this._hardcoverAngles.H1 = COVER_START_NEAR;
    this._hardcoverAngles.H2 = COVER_START_FAR;
    this._hardcoverAngularVelocity.H1 = 0;
    this._hardcoverAngularVelocity.H2 = 0;
    this.spreadFront.moveAnchor('far', 0);
    this.spreadBack.moveAnchor('near', 0);
    // Straddling the CURRENT meeting plane, which tilts with the spine --
    // dropping onto a flat pi/2 while the spine is tilted would just make
    // _enforceNoCrossingBC snap both leaves square on the first frame.
    const meet = bcFixedAngle();
    this.spreadFront.drop(COVER_START_NEAR, meet - BC_START_GAP / 2);
    this.spreadBack.drop(meet + BC_START_GAP / 2, COVER_START_FAR);
    this.setFlipped(false);
    this._lastStep = 0; // next step() re-bases its delta instead of jumping
  }

  /**
   * Shut the book, all at once: both boards together, the whole page block
   * between them, the spine tilted all the way over under it -- the book as
   * it comes off a shelf.
   *
   * `side` is which board ends up on top, the same sense openState uses:
   *
   *   'front'  shut normally. Everything has swung over onto H2's side (every
   *            angle pi), the front board faces up, and SPINE_ROTATION is +1
   *            -- which is what the page block asks for there anyway
   *            (spineRotationTarget), so the spine stays put.
   *   'back'   shut the other way (every angle 0), back board up,
   *            SPINE_ROTATION -1.
   *
   * The reading position (the B/C hinge) is left where it is, so a book
   * shut on its first page still opens on it.
   *
   * Nothing holds it shut afterwards. Lying flat it stays that way under its
   * own weight, and so it does in the hand, where the pages feel down as if
   * it were lying flat (input/bookManipulator.js).
   *
   * Returns where the shut book is, in the parent's space and before any
   * scale the parent carries: `centre` is the middle of the page block, and
   * `quaternion` turns X = head, Y = out through the FRONT board, Z = spine
   * to fore-edge into that space. The same frame a shelf model is built in
   * (cover/bookModel.js), so one can be put exactly where the other is.
   *
   * @param {'front'|'back'} [side='front']
   * @returns {{ angle: number, centre: THREE.Vector3, quaternion: THREE.Quaternion }}
   */
  close(side = 'front') {
    const angle = side === 'front' ? Math.PI : 0;
    setSpineRotation(side === 'front' ? 1 : -1);

    this._hardcoverAngles.H1 = angle;
    this._hardcoverAngles.H2 = angle;
    this._hardcoverAngularVelocity.H1 = 0;
    this._hardcoverAngularVelocity.H2 = 0;

    // Square to the spine is `angle` itself once it is tilted right over, so
    // B and C lie flat in the block with everything else.
    const meet = bcFixedAngle();
    this.spreadFront.drop(angle, meet);
    this.spreadBack.drop(meet, angle);
    // The anchor bodies are still where the old tilt put them; the pages
    // were just born at the new one. Bring the anchors across now rather
    // than on the next step, so nothing is drawn against the old spine.
    this.spreadFront.refreshHinges();
    this.spreadBack.refreshHinges();
    this.setFlipped(false);
    this._lastStep = 0;

    // Posed immediately, not on the next step, so a frame drawn before that
    // step already shows the book shut.
    this.spreadFront.sync();
    this.spreadBack.sync();
    this.hardcover.update();

    const centre = this._shutCentre(angle, new THREE.Vector3());
    const outward = new THREE.Vector3(0, -Math.sin(angle), Math.cos(angle)); // hinge to fore-edge, physics space

    // X along the spine, Z hinge to fore-edge, and Y = Z x X -- which comes
    // out of H1's outer face (hardcover.js puts H1 on its page's +Y).
    const axisX = new THREE.Vector3(1, 0, 0);
    const frame = new THREE.Matrix4().makeBasis(axisX, outward.clone().cross(axisX), outward);
    const quaternion = new THREE.Quaternion()
      .setFromRotationMatrix(frame)
      .premultiply(this.root.quaternion);

    return { angle, centre, quaternion };
  }

  /**
   * The middle of a shut page block whose boards lie at `angle`, into `out`,
   * in the parent's space before its scale. Measured in physics space --
   * halfway between the covers' hinges, and half a page out from them --
   * then carried through the root's own half-turn.
   */
  _shutCentre(angle, out) {
    const hingeA = spineHinge(SPINE_GAP).mid;
    const hingeD = spineHinge(-SPINE_GAP).mid;
    const reach = PANEL_REACH / 2;
    out.set(
      0,
      (hingeA.y + hingeD.y) / 2 - Math.sin(angle) * reach,
      (hingeA.z + hingeD.z) / 2 + Math.cos(angle) * reach,
    );
    this.root.updateMatrix();
    return out.applyMatrix4(this.root.matrix);
  }

  /**
   * What someone holding the book up to read it is looking at: its middle,
   * into `out`, and its size -- all in the parent's space, before any scale
   * the parent carries. For input/bookCarry.js, which frames the book by it.
   *
   * No orientation: the book's reading axes (X = head, Y = out of the page,
   * Z = the reader's right) are the parent's own axes whether it is open or
   * shut from the front (see close()).
   *
   * Shut, the middle is the middle of the block and the size one board.
   * Otherwise it is the gutter -- the B/C hinge, where the two visible pages
   * meet -- and the size the whole spread.
   *
   * @param {THREE.Vector3} [out]
   * @returns {{ centre: THREE.Vector3, width: number, height: number }}
   */
  readingFrame(out = new THREE.Vector3()) {
    const { H1, H2 } = this._hardcoverAngles;
    if (H2 - H1 < CLOSED_GAP) {
      return { centre: this._shutCentre((H1 + H2) / 2, out), width: PANEL_REACH, height: HINGE_LEN };
    }
    const gutter = spineHinge(this._bcZ).mid;
    this.root.updateMatrix();
    out.set(0, gutter.y, gutter.z).applyMatrix4(this.root.matrix);
    return { centre: out, width: 2 * (PANEL_REACH + SPINE_GAP), height: HINGE_LEN };
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
   * The tilt the page block is currently asking the spine for, in
   * SPINE_ROTATION units (-1 .. 1).
   *
   * Each pseudo body wants the spine PERPENDICULAR to itself. A page at
   * angle `a` is square to a spine tilted by beta when a = beta + pi/2
   * (the same identity bcFixedAngle() is built on), so each one's "vote"
   * is simply its own angle measured from pi/2 -- zero when it is already
   * square to a flat spine, +1 when it has swung a full quarter turn past,
   * -1 a quarter turn back.
   *
   * The two votes are blended by SPREAD SIZE, which is what makes this
   * behave like a weight rather than an average: a spread's hinge
   * separation stands in for how thick that half of the book is, and a
   * thick half pushes the spine around far more than a thin one can. So
   * reading toward the back -- CD grown large, AB collapsed -- hands the
   * decision almost entirely to P2, and with the book open (P2 near pi)
   * that drives the tilt to +1. Symmetrically, a book open flat and
   * centred has P1 near 0 and P2 near pi voting exactly opposite each
   * other at equal weight, which cancels to 0: flat, as it should be.
   *
   * WEIGHT. What comes out of that blend is the demand; what goes back is
   * what a book this thick will actually give. A heavy page block absorbs
   * the first part of any demand outright (see weighSpineTarget), so a
   * long book sits flat under the same nudge that would tip a slim one
   * over. Applied here rather than in the step so that this number is the
   * tilt the spine is really chasing, not one it will never reach.
   *
   * Read-only and side-effect free -- _stepSpineRotation is what acts on
   * it, and a caller is free to just watch this number.
   */
  get spineRotationTarget() {
    const HALF_PI = Math.PI / 2;
    const voteFront = (pageAngle(this.spreadFront.pseudoBody) - HALF_PI) / HALF_PI;
    const voteBack = (pageAngle(this.spreadBack.pseudoBody) - HALF_PI) / HALF_PI;
    const wFront = this.spreadFront.pairGap();
    const wBack = this.spreadBack.pairGap();
    const total = wFront + wBack;
    if (!(total > 0)) return 0;
    const demand = clampNum((wFront * voteFront + wBack * voteBack) / total, -1, 1);
    return weighSpineTarget(demand);
  }

  /** See SPINE_ROTATION_EASE_RATE and spineEaseRate. No-op while hand-posed. */
  _stepSpineRotation(dt) {
    if (!this._spineDriven) return;
    const target = this.spineRotationTarget;
    // Not a fixed rate: the heavier the block, the faster it falls back to
    // flat and the slower it can be levered off it.
    const k = Math.min(spineEaseRate(target, SPINE_ROTATION) * dt, 1);
    setSpineRotation(SPINE_ROTATION + (target - SPINE_ROTATION) * k);
  }

  /**
   * Hand the spine's tilt back and forth between the page block and a
   * caller posing it directly (the debug slider). Turning the drive off
   * leaves SPINE_ROTATION wherever it currently sits rather than resetting
   * it, so a slider picks up from the pose the book had settled into.
   */
  setSpineRotationDriven(v) {
    this._spineDriven = v;
  }

  get spineRotationDriven() {
    return this._spineDriven;
  }

  /**
   * Converts _gravityDir (this.root's PARENT's space) into this.root's own
   * local space — the same space the Rapier world's bodies/gravity actually
   * live in — by undoing this.root's fixed rotation.x = PI. That rotation
   * is a full 180°, which is its own inverse, so "undo" is just negating Y
   * and Z (the standard rotate-180-about-X formula with the y/z terms'
   * signs flipped) rather than needing a real matrix inverse. `flipped`
   * layers on top as one more sign flip, same role it always had.
   *
   * SPINE_ROTATION never enters this. Tilting the spine moves hinge
   * POSITIONS and nothing else — no body is re-oriented and no frame is
   * rotated — so which way down points is simply unaffected, and a tilt
   * change does not have to touch gravity at all.
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

    // Before the step, so the spreads' refreshHinges() (inside
    // stepPhysics below) moves the anchors to the new tilt in this same
    // frame. Run it after, and bcFixedAngle() would already be reading the
    // new beta while the hinges still sat at the old one -- one frame of
    // curl built against a spine that isn't there.
    this._stepSpineRotation(this.world.timestep);

    this.world.step();
    this._stepHardcoverGravity(this.world.timestep);

    // Both spreads' own corrections, then the cross-spread inner-page stop,
    // all before either spread syncs its meshes — otherwise whichever
    // synced first would render a frame stale after the cross-correction.
    this.spreadFront.stepPhysics();
    this.spreadBack.stepPhysics();
    this._enforceNoCrossingBC();
    // Establish the ordered pseudo interval first, then clamp A/D inside it
    // and against H1/H2. A hardcover correction also notifies its matching
    // pseudo body.
    this._applyHardcoverHold();
    this._applyHardcoverAirCushion();
    this._enforceHardcoverOrder();
    this._applySpreadHold();
    this._enforceNoCrossingPseudo();
    this.spreadFront.enforceNoPassingRef();
    this.spreadBack.enforceNoPassingRef();
    this._applyPseudoRepulsion(this.world.timestep); // capped, same effective dt world.step() just used

    this.spreadFront.sync();
    this.spreadBack.sync();
    this.hardcover.update(); // boards use independent angles, after page corrections
  }

  // B's and C's own hinge-tangent angle is fixed relative to the spine (bcFixedAngle())
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
      const t = pageTransform(anchor, bcFixedAngle());
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
   * reading as collapsed shut (right at bcFixedAngle()) instead of open to
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
    const h1 = this._hardcoverAngles.H1;
    const h2 = this._hardcoverAngles.H2;
    const raw1 = pageAngle(p1);
    const raw2 = pageAngle(p2);
    const a1 = Math.max(raw1, h1);
    const a2 = Math.min(raw2, h2);

    if (a1 < raw1) {
      const t = pageTransform(this.spreadFront.refAnchor, a1);
      p1.setTranslation(t.pos, true);
      p1.setRotation(t.rot, true);
      p1.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
    if (a2 > raw2) {
      const t = pageTransform(this.spreadBack.refAnchor, a2);
      p2.setTranslation(t.pos, true);
      p2.setRotation(t.rot, true);
      p2.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }

    if (a1 <= a2) {
      return;
    }

    const mid = Math.max(h1, Math.min(h2, (a1 + a2) / 2));
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