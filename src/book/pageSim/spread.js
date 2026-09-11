import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import {
  HINGE_LEN, PANEL_REACH, COLLIDER_THICK, PIVOT_TO_NEAR_EDGE,
  NO_SELF_COLLIDE, AIR_CUSHION_RANGE, AIR_CUSHION_MAX_RATE, bcFixedAngle,
  spineBeta,
} from './config.js';
import {
  clampNum, pageAngle, pageTransform, spineHinge,
  LOCAL_PIVOT_L, LOCAL_PIVOT_R, LOCAL_TIP_L, LOCAL_TIP_R,
} from './math.js';
import {
  CURL_ROWS, CURL_INDEX, createCurlUV, writeCurlUV, buildCurlStrip, curlTipPoint, closestDistanceToPage,
} from './curlGeometry.js';
import { WEDGE_ROWS, WEDGE_INDEX, fillWedgeSide } from './wedgeGeometry.js';
import { twoSidedShadows } from '../../scene/twoSidedShadows.js';

/**
 * One "spread" is the original 2-page + wedge mechanism: two
 * independently-hinged flat pages (near = reaches toward +Z when open, far =
 * toward -Z) sharing a mutual "never swing past parallel" rule and a curved
 * wedge filling the gap between them. `anchorNearZ` / `anchorFarZ` are the
 * two hinges' positions along the spine; either one can be moved at runtime
 * via `moveAnchor` (PageSimulation slides the shared inner hinge to
 * simulate flipping through the book).
 *
 * @param {RAPIER.World} world
 * @param {THREE.Object3D} parent  meshes are added here (already carries the
 *                                 render-only book flip)
 * @param {Object} opts
 */
export function createSpread(world, parent, opts) {
  const {
    anchorNearZ, anchorFarZ, openLimit, hardcoverAngle,
    colorNear, colorFar, wedgeColor, dampingNear, dampingFar, curlPage,
  } = opts;

  const anchorNear = { y: 0, z: anchorNearZ };
  const anchorFar = { y: 0, z: anchorFarZ };
  // Anchor bodies sit wherever SPINE_ROTATION has put their hinge (math.js's
  // spineHinge) -- at rest that is (0, y, z), exactly where they used to be.
  // placeAnchor() below is what keeps them there; these two just need a
  // position to be born at.
  const nearMid = spineHinge(anchorNear.z).mid;
  const farMid = spineHinge(anchorFar.z).mid;
  const anchorBodyNear = world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed().setTranslation(0, nearMid.y + anchorNear.y, nearMid.z),
  );
  const anchorBodyFar = world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed().setTranslation(0, farMid.y + anchorFar.y, farMid.z),
  );

  // The same two hinge points as Vector3s, for the curl/wedge geometry.
  // Kept in step with the bodies above by placeAnchor().
  const anchorNearVec = new THREE.Vector3(0, nearMid.y + anchorNear.y, nearMid.z);
  const anchorFarVec = new THREE.Vector3(0, farMid.y + anchorFar.y, farMid.z);
  const halfWidth = HINGE_LEN / 2;
  const curlAnchorVec = curlPage === 'near' ? anchorNearVec : anchorFarVec;
  // Ref side = whichever of near/far ISN'T the curl page -- both the real
  // reference/cover body (A or D) and the pseudo body below (see drop())
  // are hinged at this same anchor.
  const refIsNear = curlPage !== 'near';
  const refAnchor = refIsNear ? anchorNear : anchorFar;
  const refAnchorBody = refIsNear ? anchorBodyNear : anchorBodyFar;

  // Live spacing between this spread's two hinges. It used to be the
  // constant SPINE_GAP; now the inner leaf's anchor slides along the spine
  // (see moveAnchor), so the curl radius and the no-crossing threshold both
  // read the current separation instead. Floored so a leaf parked right
  // against its cover doesn't collapse the curl/wedge to zero width.
  const pairGap = () => Math.max(Math.abs(anchorFar.z - anchorNear.z), 1e-3);

  // The OTHER spread's pairGap(), wired in by PageSimulation once both
  // spreads exist (setOtherPairGap). Needed by curlRadius() below.
  let _otherPairGap = null;
  function setOtherPairGap(fn) { _otherPairGap = fn; }

  // Radius buildCurlStrip should trace this spread's curl at.
  //
  // Normally this spread's own hinge separation (pairGap). But once the
  // curl's target tangent -- the pseudo body's angle -- has crossed the
  // meeting plane (bcFixedAngle(), i.e. square to the spine), the leaf is bending
  // OVER onto the other half of the book, and the arc that spans that
  // reach is set by the OTHER spread's hinge separation, not this one's.
  // refIsNear picks the sense: spreadFront (curlPage 'far', B) has curled
  // over when its ref angle is ABOVE the plane; spreadBack (curlPage
  // 'near', C) when its ref angle is BELOW it.
  function curlRadius() {
    const refAngle = _refAngleOverride ?? pageAngle(pseudoBody);
    const plane = bcFixedAngle();
    const curledOver = refIsNear ? refAngle > plane : refAngle < plane;
    return (curledOver && _otherPairGap) ? _otherPairGap() : pairGap();
  }

  function makePage(anchor, startAngle, damping, gravityScale) {
    const t = pageTransform(anchor, startAngle);
    // canSleep(false): a page resting at the end of its range would
    // otherwise be put to sleep by Rapier, and a sleeping body ignores a
    // later gravity flip until something wakes it — which looked like the
    // book "collapsing" when a correction finally teleported both pages to
    // a now-very-different meet angle in one jump. Keeping pages awake
    // means gravity changes and corrections are always felt immediately.
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(t.pos.x, t.pos.y, t.pos.z)
        .setRotation(t.rot)
        .setLinearDamping(0.15)
        .setCanSleep(false)
        .setGravityScale(gravityScale),
    );
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(HINGE_LEN / 2, COLLIDER_THICK / 2, PANEL_REACH / 2).setCollisionGroups(NO_SELF_COLLIDE),
      body,
    );
    body.setAngularDamping(damping);
    return body;
  }

  // Every page on every spread hinges about world X. Tilting the spine
  // rotates ABOUT that same axis, which cannot move itself, so this stays a
  // constant -- joints never need rebuilding when SPINE_ROTATION changes,
  // and a live tilt is just the anchor bodies sliding along (placeAnchor).
  const hingeAxis = { x: 1, y: 0, z: 0 };
  const anchorLocalOrigin = { x: 0, y: 0, z: 0 };
  const pageLocalAnchor = { x: 0, y: 0, z: -PIVOT_TO_NEAR_EDGE };
  // DELIBERATELY UNLIMITED. The obvious thing is j.setLimits(0, openLimit),
  // and that is what this used to do -- but Rapier measures a revolute
  // joint's angle with a shortest-arc extraction, which lives in [-pi, pi].
  // OPEN_LIMIT now runs PAST flat (see config.js), and a cover at 1.2*pi
  // reads back as roughly -0.8*pi through that measure: not merely over the
  // maximum but wildly under the minimum, so the solver would slam the
  // cover shut the moment it passed flat. The range is enforced by
  // enforceOpenRange() below instead, which reads pageAngle() -- a plain
  // 2*atan2 that stays single-valued and correct out to +-2*pi -- and so
  // does not wrap anywhere near where the book actually goes.
  function makeJoint(anchorBody, pageBody) {
    return world.createImpulseJoint(
      RAPIER.JointData.revolute(anchorLocalOrigin, pageLocalAnchor, hingeAxis),
      anchorBody, pageBody, true,
    );
  }

  // meshes — the reference page (cover) is a plain flat plane; the curling
  // page gets a dynamic bent-strip geometry rebuilt from both angles each
  // frame.
  const panelGeo = new THREE.PlaneGeometry(HINGE_LEN, PANEL_REACH);
  panelGeo.rotateX(-Math.PI / 2);
  // Four rounds of flipping polygonOffset sign/magnitude produced results
  // that don't fit a simple signed-offset model (flicker -> both gone ->
  // swap flips which pair is gone -> unifying the sign made BOTH pairs
  // gone) -- polygonOffset isn't a mechanism we can reliably reason about
  // blind here, whether that's driver-specific behavior or something else
  // going on. Switching to a mechanism that doesn't depend on offset
  // sign/magnitude at all: renderOrder. With the default depth function
  // (LessEqualDepth), a fragment at an EQUAL depth to what's already in
  // the depth buffer still passes and overwrites it -- so for genuinely
  // coincident/near-coincident geometry, whichever mesh is drawn SECOND
  // deterministically wins ties, regardless of any offset. Pages (this
  // mesh and the curl mesh) get a higher renderOrder than the wedge, so
  // they always draw after it and always win at the seam.
  const pageMat = new THREE.MeshStandardMaterial({
    roughness: 0.5, metalness: 0.05, side: THREE.DoubleSide,
  });
  // Seen from either side, so shadow lookups have to come from the side in
  // view -- or A and B, seen from their geometric back, sit in their own
  // shadow (scene/twoSidedShadows.js). Per clone: clone() drops it.
  const matNear = twoSidedShadows(pageMat.clone());
  matNear.color.set(colorNear);
  const matFar = twoSidedShadows(pageMat.clone());
  matFar.color.set(colorFar);
  const curlMat = curlPage === 'near' ? matNear : matFar;
  const flatMat = curlPage === 'near' ? matFar : matNear;

  const flatMesh = new THREE.Mesh(panelGeo, flatMat);
  flatMesh.castShadow = true;
  flatMesh.receiveShadow = true;
  flatMesh.renderOrder = 1;

  const curlPositions = new Float32Array(2 * CURL_ROWS * 3);
  const curlUV = createCurlUV(); // filled per-frame in updateCurlMesh, from the same curlRowFrac the wedge loft uses
  const curlGeo = new THREE.BufferGeometry();
  curlGeo.setAttribute('position', new THREE.BufferAttribute(curlPositions, 3));
  curlGeo.setAttribute('uv', new THREE.BufferAttribute(curlUV, 2));
  curlGeo.setIndex(CURL_INDEX);
  const curlMesh = new THREE.Mesh(curlGeo, curlMat);
  curlMesh.castShadow = true;
  curlMesh.receiveShadow = true;
  curlMesh.renderOrder = 1;

  parent.add(flatMesh, curlMesh);

  // wedge -- renderOrder 0 (the default, spelled out for clarity): drawn
  // BEFORE the pages, so it always loses ties at the seam to whichever
  // page it's touching.
  const wedgeMat = twoSidedShadows(new THREE.MeshStandardMaterial({
    color: wedgeColor, roughness: 0.6, metalness: 0.05, side: THREE.DoubleSide,
  }));
  const wedgeGeo = new THREE.BufferGeometry();
  const wedgePositions = new Float32Array(WEDGE_ROWS * 4 * 3);
  wedgeGeo.setAttribute('position', new THREE.BufferAttribute(wedgePositions, 3));
  wedgeGeo.setIndex(WEDGE_INDEX);
  const wedgeMesh = new THREE.Mesh(wedgeGeo, wedgeMat);
  wedgeMesh.castShadow = true;
  wedgeMesh.receiveShadow = true;
  wedgeMesh.renderOrder = 0;
  parent.add(wedgeMesh);

  // Flat-side corners are read off the flat plane's LOCAL matrix (relative
  // to `parent`), not matrixWorld — wedgeMesh is parent's direct child too,
  // so its vertex buffer is interpreted in parent-local space. The curl
  // side needs no adjustment; updateWedge reads its points straight out of
  // curlPositions, already in parent-local coordinates.
  const _wp = {
    flatPivotL: new THREE.Vector3(), flatPivotR: new THREE.Vector3(),
    flatTipL: new THREE.Vector3(), flatTipR: new THREE.Vector3(),
  };
  const curlRowFrac = new Float32Array(CURL_ROWS);

  function syncMesh(mesh, body) {
    const t = body.translation();
    const r = body.rotation();
    mesh.position.set(t.x, t.y, t.z);
    mesh.quaternion.set(r.x, r.y, r.z, r.w);
    mesh.updateMatrixWorld(true);
  }

  // Ref-angle override for the CURL SHAPE only (buildCurlStrip's target
  // tangent), separate from the reference body's own real physics angle.
  // Set every frame by PageSimulation._enforceNoCrossingTips before sync()
  // runs, so B's/C's curl never sweeps out past where the other one's curl
  // currently ends — without ever touching A's/D's or B's/C's actual rigid
  // bodies. null means "use the reference body's real angle", i.e. no clamp
  // in effect.
  let _refAngleOverride = null;
  function setRefAngleClamp(angle) { _refAngleOverride = angle; }

  function updateCurlMesh() {
    const curlBody = curlPage === 'near' ? bodyNear : bodyFar;
    // pseudoBody, not the real reference body -- see the comment above drop().
    const refAngle = _refAngleOverride ?? pageAngle(pseudoBody);
    buildCurlStrip(
      curlPositions, curlAnchorVec, pageAngle(curlBody), refAngle,
      curlRadius(), PANEL_REACH, halfWidth,
    );
    curlGeo.attributes.position.needsUpdate = true;
    curlGeo.computeVertexNormals();

    // Cumulative chord length along the curl's left column gives each row's
    // fraction of the way along the shared PANEL_REACH length; the wedge
    // places its flat-side points at the matching fraction so the loft
    // stays in step along the whole length, not just at the two ends.
    let cum = 0;
    curlRowFrac[0] = 0;
    for (let i = 1; i < CURL_ROWS; i++) {
      const ax = curlPositions[(i - 1) * 3], ay = curlPositions[(i - 1) * 3 + 1], az = curlPositions[(i - 1) * 3 + 2];
      const bx = curlPositions[i * 3], by = curlPositions[i * 3 + 1], bz = curlPositions[i * 3 + 2];
      cum += Math.hypot(bx - ax, by - ay, bz - az);
      curlRowFrac[i] = cum;
    }
    const total = curlRowFrac[CURL_ROWS - 1] || 1;
    for (let i = 0; i < CURL_ROWS; i++) curlRowFrac[i] /= total;

    // Texture v follows the same real arc-length fraction as the wedge
    // loft above, not raw row index -- see the comment on writeCurlUV in
    // curlGeometry.js for why (row-index v badly over-magnified the arc
    // and left the straight run looking blank).
    //
    writeCurlUV(curlUV, curlRowFrac);
    curlGeo.attributes.uv.needsUpdate = true;
  }

  function updateWedge() {
    _wp.flatPivotL.copy(LOCAL_PIVOT_L).applyMatrix4(flatMesh.matrix);
    _wp.flatPivotR.copy(LOCAL_PIVOT_R).applyMatrix4(flatMesh.matrix);
    _wp.flatTipL.copy(LOCAL_TIP_L).applyMatrix4(flatMesh.matrix);
    _wp.flatTipR.copy(LOCAL_TIP_R).applyMatrix4(flatMesh.matrix);

    const n = WEDGE_ROWS;
    fillWedgeSide(_wp.flatPivotL, _wp.flatTipL, curlPositions, 0, curlRowFrac, wedgePositions, 0, n);
    fillWedgeSide(_wp.flatPivotR, _wp.flatTipR, curlPositions, CURL_ROWS, curlRowFrac, wedgePositions, 2 * n, 3 * n);

    wedgeGeo.attributes.position.needsUpdate = true;
    wedgeGeo.computeVertexNormals();
  }

  let bodyNear, bodyFar, pseudoBody;

  // The curl page's own body (B for the front spread, C for the back one)
  // gets gravityScale 0 -- see PageSimulation._enforceNoCrossingBC for why:
  // its hinge-tangent angle is a fixed constant for the book's entire
  // lifetime, never something gravity (or anything else) is allowed to
  // move even briefly, so gravity is excluded from acting on that body at
  // all rather than being applied and then papered over every frame. The
  // reference/cover body (the other one) keeps normal gravity (scale 1) --
  // gravity swinging IT is exactly what drives the curl's own SHAPE further
  // out (buildCurlStrip's refAngle, i.e. the straight run past the arc,
  // ultimately the tip), via straightAngle()/refAngle in updateCurlMesh.
  //
  // `pseudoBody` is a second, invisible body hinged at that SAME anchor
  // point (same joint, same length, same damping, gravityScale 1 -- an
  // exact clone of the real reference body's own physics, not rendered or
  // referenced by anything else). The curl's shape now reads THIS body's
  // angle instead of the real reference body's -- both for the arc's
  // default target tangent (updateCurlMesh) and for the no-crossing
  // distance check (enforceNoCrossing) -- so the curl is only ever coupled
  // to the pseudo body, never directly to A/D themselves. Since the pseudo
  // body currently has identical physics to the real one, it tracks it
  // exactly and nothing LOOKS different yet; the point is this seam now
  // exists for the pseudo body to later diverge (its own easing/damping/
  // response) without ever touching A's/D's real, rendered behavior.
  function drop(startAngleNear, startAngleFar) {
    if (bodyNear) world.removeRigidBody(bodyNear);
    if (bodyFar) world.removeRigidBody(bodyFar);
    if (pseudoBody) world.removeRigidBody(pseudoBody);
    const curlIsNear = curlPage === 'near';
    bodyNear = makePage(anchorNear, startAngleNear, dampingNear, curlIsNear ? 0 : 1);
    bodyFar = makePage(anchorFar, startAngleFar, dampingFar, curlIsNear ? 1 : 0);
    makeJoint(anchorBodyNear, bodyNear);
    makeJoint(anchorBodyFar, bodyFar);

    const refStartAngle = refIsNear ? startAngleNear : startAngleFar;
    const refDamping = refIsNear ? dampingNear : dampingFar;
    pseudoBody = makePage(refAnchor, refStartAngle, refDamping, 1);
    makeJoint(refAnchorBody, pseudoBody);
  }

  // Slide one of this spread's two hinges to a new position along the spine
  // (Z). The anchor's fixed body, its cached vector, and — so there's no
  // one-frame lag while the joint solver catches up — the hinged page
  // itself are all moved together; the page keeps its current swing angle
  // and angular velocity. `pairGap()` picks up the new separation on the
  // next curl/wedge rebuild.
  function moveAnchor(which, z) {
    const anchor = which === 'near' ? anchorNear : anchorFar;
    anchor.z = z;
    placeAnchor(which);
  }

  // Put one hinge where the spine currently says it belongs -- called both
  // when the hinge slides along the spine (moveAnchor) and when the spine
  // itself tilts underneath it (refreshHinges).
  //
  // Every body hinged there is moved with it, rather than waiting for the
  // joint solver to drag them across over the next few frames: each keeps
  // its own swing angle (pageTransform never touches `angle`) and its
  // angular velocity, and simply arrives at the new hinge already there.
  function placeAnchor(which) {
    const isNear = which === 'near';
    const anchor = isNear ? anchorNear : anchorFar;
    const vec = isNear ? anchorNearVec : anchorFarVec;
    const anchorBody = isNear ? anchorBodyNear : anchorBodyFar;
    const body = isNear ? bodyNear : bodyFar;

    const mid = spineHinge(anchor.z).mid;
    const y = mid.y + anchor.y;
    anchorBody.setTranslation({ x: 0, y, z: mid.z }, true);
    vec.set(0, y, mid.z);

    if (body) {
      const t = pageTransform(anchor, pageAngle(body));
      body.setTranslation(t.pos, true);
    }
    // The pseudo body hangs off whichever of the two anchors is the
    // reference one, so it rides along with exactly that one.
    if (pseudoBody && isNear === refIsNear) {
      const t = pageTransform(refAnchor, pageAngle(pseudoBody));
      pseudoBody.setTranslation(t.pos, true);
    }
  }

  // Pick up a SPINE_ROTATION changed since the last frame. Cheap to call
  // every step: does nothing at all unless the tilt actually moved.
  let _hingeBeta = spineBeta();
  function refreshHinges() {
    const beta = spineBeta();
    if (beta === _hingeBeta) return;
    _hingeBeta = beta;
    placeAnchor('near');
    placeAnchor('far');
  }

  // Cushions the REAL reference/cover body (A or D) against its own pseudo
  // double (see drop()'s comment) as the two approach each other -- not,
  // as this used to, the cover against the curl page (whose own hinge
  // angle is fixed elsewhere and whose angular velocity is zeroed every
  // frame regardless, which made that pairing mostly moot now that curl
  // shape is driven by the pseudo bodies instead). refBody and pseudoBody
  // normally track each other exactly (identical physics), so ordinarily
  // there's nothing to cushion -- this only actually does anything once
  // something has made them diverge, e.g. _enforceNoCrossingPseudo pulling
  // a pseudo body back from its natural angle. Signed throughout (unlike
  // the old near/far version, which could assume a fixed ordering) since
  // either body can end up ahead of the other.
  function applyAirCushion() {
    const refBody = refIsNear ? bodyNear : bodyFar;
    const angleRef = pageAngle(refBody);
    const anglePseudo = pageAngle(pseudoBody);
    const d = anglePseudo - angleRef;
    const gap = Math.abs(d);
    if (gap <= 0 || gap >= AIR_CUSHION_RANGE) return;

    const avRef = refBody.angvel().x;
    const avPseudo = pseudoBody.angvel().x;
    const sign = Math.sign(d);
    const closingRate = sign * (avRef - avPseudo); // positive when the gap is shrinking, whichever body is ahead
    const maxClosingRate = AIR_CUSHION_MAX_RATE * (gap / AIR_CUSHION_RANGE);
    if (closingRate <= maxClosingRate) return;

    const removed = closingRate - maxClosingRate;
    refBody.setAngvel({ x: avRef - sign * (removed / 2), y: 0, z: 0 }, true);
    pseudoBody.setAngvel({ x: avPseudo + sign * (removed / 2), y: 0, z: 0 }, true);
  }

  // Hard stop: the real reference/cover body (A or D) must stay between its
  // independent hardcover angle and its pseudo reference (P1 or P2).
  //
  // "Past" flips with which side this spread's reference sits on: A (this
  // spread's refBody when refIsNear, i.e. spreadFront) must not fall BELOW
  // H1, but D (refIsNear false, spreadBack) sits on the OTHER side of the
  // shared B/C hinge and must not EXCEED H2.
  function enforceNoPassingRef() {
    const refBody = refIsNear ? bodyNear : bodyFar;
    const angleRef = pageAngle(refBody);
    const angleHardcover = hardcoverAngle ? hardcoverAngle() : pageAngle(pseudoBody);
    const anglePseudo = pageAngle(pseudoBody);
    const violatesHardcover = refIsNear ? angleRef < angleHardcover : angleRef > angleHardcover;
    const violatesPseudo = refIsNear ? angleRef > anglePseudo : angleRef < anglePseudo;
    const violated = violatesHardcover || violatesPseudo;
    if (!violated) return;

    const target = violatesHardcover ? angleHardcover : anglePseudo;
    const t = pageTransform(refAnchor, target);
    refBody.setTranslation(t.pos, true);
    refBody.setRotation(t.rot, true);

    // Kill only the velocity still driving it further past.
    const av = refBody.angvel().x;
    const stillDriving = refIsNear
      ? (violatesHardcover ? av < 0 : av > 0)
      : (violatesHardcover ? av > 0 : av < 0);
    if (stillDriving) refBody.setAngvel({ x: 0, y: 0, z: 0 }, true);

    // Carrying the pseudo body along with a hardcover correction is only
    // ever a REPAIR, never the point. This function keeps the reference
    // body sandwiched -- H1 <= A <= P1 on the front spread, P2 <= D <= H2
    // on the back -- and clamping A up off H1 can shove it past P1,
    // breaking the other half of that sandwich. Dragging P1 up to meet it
    // is what puts the ordering back.
    //
    // So if the pseudo is already clear of where the reference just
    // landed, the sandwich still holds and the pseudo is free: leave it
    // completely alone. Snapping it regardless is what was destroying its
    // independent swing every time A merely touched its board.
    //
    // The comparison MUST be against `target`, not the `angleRef` captured
    // at the top of this function -- by here the reference body has already
    // been moved to `target`, and angleRef is the pre-clamp position it
    // just left (still on the far side of the hardcover). Testing against
    // that stale value leaves a band, angleRef < pseudo < target, where the
    // pseudo really does need to move but is skipped -- and then next
    // frame violatesPseudo drags the reference back down onto it, the two
    // corrections fight, and the pair jitters.
    const pseudoLeftBehind = refIsNear
      ? anglePseudo < target // front: need P1 >= A, and A is now at target
      : anglePseudo > target; // back: need P2 <= D, and D is now at target

    if (violatesHardcover && pseudoLeftBehind) {
      const pseudoTransform = pageTransform(refAnchor, target);
      pseudoBody.setTranslation(pseudoTransform.pos, true);
      pseudoBody.setRotation(pseudoTransform.rot, true);
      // Read AFTER the zeroing above: the two are in contact and moving as
      // one, so the pseudo inherits whatever the reference is left with.
      const refVelocity = refBody.angvel().x;
      pseudoBody.setAngvel({ x: refVelocity, y: 0, z: 0 }, true);
    }

  }

  // Geometric no-crossing: measure how close the curling page's tip has
  // actually gotten to the flat reference page's surface (closest point on
  // its finite rectangle), and require that distance stay at least the
  // current hinge separation. Only the curling page is ever moved here —
  // the reference page is read, never touched.
  const _noCrossTip = new THREE.Vector3();
  function enforceNoCrossing() {
    const curlIsNear = curlPage === 'near';
    const curlBody = curlIsNear ? bodyNear : bodyFar;
    const curlAnchorV = curlIsNear ? anchorNearVec : anchorFarVec;
    const refAnchorV = curlIsNear ? anchorFarVec : anchorNearVec;

    const curlAngle = pageAngle(curlBody);
    // pseudoBody, not the real reference body -- see the comment above drop().
    const refAngle = pageAngle(pseudoBody);
    const gap = pairGap();

    curlTipPoint(curlAnchorV, curlAngle, refAngle, gap, PANEL_REACH, _noCrossTip);
    const d = closestDistanceToPage(_noCrossTip, refAnchorV, refAngle, HINGE_LEN, PANEL_REACH, COLLIDER_THICK);
    if (d >= gap) return;

    // "Away from the reference page" is fixed by this spread's layout, not
    // re-derived from the current angle order (which may already have
    // flipped at a violation). Bisect for the nearest clearing angle.
    const pushUp = !curlIsNear;
    let lo = curlAngle;
    let hi = pushUp ? openLimit : 0;
    for (let iter = 0; iter < 24; iter++) {
      const mid = (lo + hi) / 2;
      curlTipPoint(curlAnchorV, mid, refAngle, gap, PANEL_REACH, _noCrossTip);
      const dm = closestDistanceToPage(_noCrossTip, refAnchorV, refAngle, HINGE_LEN, PANEL_REACH, COLLIDER_THICK);
      if (dm < gap) lo = mid; else hi = mid;
    }

    const t = pageTransform(curlIsNear ? anchorNear : anchorFar, hi);
    curlBody.setTranslation(t.pos, true);
    curlBody.setRotation(t.rot, true);

    // Kill only the velocity still driving it deeper into the violation.
    const av = curlBody.angvel().x;
    if (pushUp ? av < 0 : av > 0) {
      curlBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
  }

  // Where this spread's curling page's far end actually is right now, for
  // the cross-spread B/C tip check in PageSimulation -- comparing actual
  // endpoint positions instead of just the hinge-tangent angle, since two
  // spreads with very different anchor separations (once the B/C hinge is
  // off-center) can have very differently-shaped curls that reach past
  // each other even while their base angles never technically cross.
  const _tipOut = new THREE.Vector3();
  function curlTipAt(candidateAngle, out = _tipOut) {
    // pseudoBody, not the real reference body -- see the comment above drop().
    return curlTipPoint(curlAnchorVec, candidateAngle, pageAngle(pseudoBody), pairGap(), PANEL_REACH, out);
  }
  function curlTip(out = _tipOut) {
    const curlBody = curlPage === 'near' ? bodyNear : bodyFar;
    return curlTipAt(pageAngle(curlBody), out);
  }

  // Same idea as curlTipAt, but varies the REFERENCE angle instead of the
  // curling page's own angle -- used by PageSimulation._enforceNoCrossingTips
  // to find where this curl's tip would land for some candidate ref angle
  // (e.g. scaled back from the pseudo body's real angle) without touching
  // any body.
  function curlTipAtRef(candidateRefAngle, out = _tipOut) {
    const curlBody = curlPage === 'near' ? bodyNear : bodyFar;
    return curlTipPoint(curlAnchorVec, pageAngle(curlBody), candidateRefAngle, pairGap(), PANEL_REACH, out);
  }

  // The angle of this spread's curling page's STRAIGHT part, i.e. dirEnd in
  // buildCurlStrip -- always exactly the pseudo body's own current angle
  // (see the comment above drop()), since that's the whole point of the
  // arc: it bends until its tangent matches dirEnd, then continues straight
  // in that exact direction. Distinct from the curling page's own
  // base/hinge angle, which is what pageAngle(curlBody) reads. This is the
  // pseudo body's REAL angle, unaffected by any setRefAngleClamp override
  // in effect.
  function straightAngle() {
    return pageAngle(pseudoBody);
  }

  // Split so the cross-spread inner-page correction can run after BOTH
  // spreads' own physics corrections but before EITHER syncs its meshes.
  // The [0, openLimit] range the joints used to enforce -- see makeJoint.
  // Applied to every body hinged on this spread; B/C are separately locked
  // to bcFixedAngle() by PageSimulation._enforceNoCrossingBC, so for them
  // this only ever matters as a backstop.
  function enforceOpenRange() {
    for (const entry of [
      [bodyNear, anchorNear],
      [bodyFar, anchorFar],
      [pseudoBody, refAnchor],
    ]) {
      const [body, anchor] = entry;
      if (!body) continue;
      const angle = pageAngle(body);
      const clamped = clampNum(angle, 0, openLimit);
      if (clamped === angle) continue;

      const t = pageTransform(anchor, clamped);
      body.setTranslation(t.pos, true);
      body.setRotation(t.rot, true);
      // Kill only the velocity still driving it further out of range, the
      // same way every other correction here does -- zeroing outright would
      // also cancel a legitimate swing back toward the middle.
      const av = body.angvel().x;
      const drivingOut = clamped === 0 ? av < 0 : av > 0;
      if (drivingOut) body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
  }

  function stepPhysics() {
    refreshHinges();
    enforceOpenRange();
    applyAirCushion();
    enforceNoCrossing();
  }
  function sync() {
    syncMesh(flatMesh, curlPage === 'near' ? bodyFar : bodyNear);
    updateCurlMesh();
    updateWedge();
  }

  function dispose() {
    for (const mesh of [flatMesh, curlMesh, wedgeMesh]) {
      parent.remove(mesh);
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
    if (bodyNear) world.removeRigidBody(bodyNear);
    if (bodyFar) world.removeRigidBody(bodyFar);
    if (pseudoBody) world.removeRigidBody(pseudoBody);
    world.removeRigidBody(anchorBodyNear);
    world.removeRigidBody(anchorBodyFar);
  }

  return {
    drop, moveAnchor, refreshHinges, stepPhysics, sync, dispose, enforceNoPassingRef,
    curlTip, curlTipAt, curlTipAtRef, straightAngle, setRefAngleClamp,
    pairGap, curlRadius, setOtherPairGap,
    get bodyNear() { return bodyNear; },
    get bodyFar() { return bodyFar; },
    // pseudoBody: the invisible physics double hinged at refAnchor (see the
    // comment above drop()) -- exposed so PageSimulation can keep the front
    // and back spreads' pseudo bodies from swinging past parallel with each
    // other (_enforceNoCrossingPseudo). refAnchor is the same {y,z} anchor
    // object both it and the real reference/cover body (A or D) share.
    get pseudoBody() { return pseudoBody; },
    refAnchor,
    anchorNear, anchorFar,
    // Exposed so page textures can be assigned from outside (see
    // PageSimulation.setPageTexture). flatMesh is the reference/cover page
    // for this spread; curlMesh is the page that bends.
    flatMesh, curlMesh,
    // wedgeMesh: not used outside this module normally -- exposed only so
    // it can be inspected/recolored from the dev console (see main.js's
    // window.__athenaeum) while tracking down the "black band" render bug.
    wedgeMesh,
  };
}