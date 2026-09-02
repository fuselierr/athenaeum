import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import {
  HINGE_LEN, PANEL_REACH, COLLIDER_THICK, PIVOT_TO_NEAR_EDGE,
  NO_SELF_COLLIDE, AIR_CUSHION_RANGE, AIR_CUSHION_MAX_RATE,
} from './config.js';
import {
  pageAngle, pageTransform,
  LOCAL_PIVOT_L, LOCAL_PIVOT_R, LOCAL_TIP_L, LOCAL_TIP_R,
} from './math.js';
import {
  CURL_ROWS, CURL_INDEX, createCurlUV, writeCurlUV, buildCurlStrip, curlTipPoint, closestDistanceToPage,
} from './curlGeometry.js';
import { WEDGE_ROWS, WEDGE_INDEX, fillWedgeSide } from './wedgeGeometry.js';

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
    anchorNearZ, anchorFarZ, openLimit,
    colorNear, colorFar, wedgeColor, dampingNear, dampingFar, curlPage,
  } = opts;

  const anchorNear = { y: 0, z: anchorNearZ };
  const anchorFar = { y: 0, z: anchorFarZ };
  const anchorBodyNear = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, anchorNear.y, anchorNear.z));
  const anchorBodyFar = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, anchorFar.y, anchorFar.z));

  const anchorNearVec = new THREE.Vector3(0, anchorNear.y, anchorNear.z);
  const anchorFarVec = new THREE.Vector3(0, anchorFar.y, anchorFar.z);
  const halfWidth = HINGE_LEN / 2;
  const curlAnchorVec = curlPage === 'near' ? anchorNearVec : anchorFarVec;

  // Live spacing between this spread's two hinges. It used to be the
  // constant SPINE_GAP; now the inner leaf's anchor slides along the spine
  // (see moveAnchor), so the curl radius and the no-crossing threshold both
  // read the current separation instead. Floored so a leaf parked right
  // against its cover doesn't collapse the curl/wedge to zero width.
  const pairGap = () => Math.max(Math.abs(anchorFar.z - anchorNear.z), 1e-3);

  function makePage(anchor, startAngle, damping, gravityScale) {
    const t = pageTransform(anchor, startAngle);
    // canSleep(false): a page resting against its joint limit would
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

  const hingeAxis = { x: 1, y: 0, z: 0 };
  const anchorLocalOrigin = { x: 0, y: 0, z: 0 };
  const pageLocalAnchor = { x: 0, y: 0, z: -PIVOT_TO_NEAR_EDGE };
  function makeJoint(anchorBody, pageBody) {
    const j = world.createImpulseJoint(
      RAPIER.JointData.revolute(anchorLocalOrigin, pageLocalAnchor, hingeAxis),
      anchorBody, pageBody, true,
    );
    j.setLimits(0, openLimit);
    return j;
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
  const matNear = pageMat.clone();
  matNear.color.set(colorNear);
  const matFar = pageMat.clone();
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
  const wedgeMat = new THREE.MeshStandardMaterial({
    color: wedgeColor, roughness: 0.6, metalness: 0.05, side: THREE.DoubleSide,
  });
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
    const refBody = curlPage === 'near' ? bodyFar : bodyNear;
    const refAngle = _refAngleOverride ?? pageAngle(refBody);
    buildCurlStrip(
      curlPositions, curlAnchorVec, pageAngle(curlBody), refAngle,
      pairGap(), PANEL_REACH, halfWidth,
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

  let bodyNear, bodyFar;

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
  function drop(startAngleNear, startAngleFar) {
    if (bodyNear) world.removeRigidBody(bodyNear);
    if (bodyFar) world.removeRigidBody(bodyFar);
    const curlIsNear = curlPage === 'near';
    bodyNear = makePage(anchorNear, startAngleNear, dampingNear, curlIsNear ? 0 : 1);
    bodyFar = makePage(anchorFar, startAngleFar, dampingFar, curlIsNear ? 1 : 0);
    makeJoint(anchorBodyNear, bodyNear);
    makeJoint(anchorBodyFar, bodyFar);
  }

  // Slide one of this spread's two hinges to a new position along the spine
  // (Z). The anchor's fixed body, its cached vector, and — so there's no
  // one-frame lag while the joint solver catches up — the hinged page
  // itself are all moved together; the page keeps its current swing angle
  // and angular velocity. `pairGap()` picks up the new separation on the
  // next curl/wedge rebuild.
  function moveAnchor(which, z) {
    const isNear = which === 'near';
    const anchor = isNear ? anchorNear : anchorFar;
    const vec = isNear ? anchorNearVec : anchorFarVec;
    const anchorBody = isNear ? anchorBodyNear : anchorBodyFar;
    const body = isNear ? bodyNear : bodyFar;

    anchor.z = z;
    vec.z = z;
    anchorBody.setTranslation({ x: 0, y: anchor.y, z }, true);
    if (body) {
      const t = pageTransform(anchor, pageAngle(body));
      body.setTranslation(t.pos, true);
    }
  }

  function applyAirCushion() {
    const angleNear = pageAngle(bodyNear);
    const angleFar = pageAngle(bodyFar);
    const gap = angleFar - angleNear;
    if (gap <= 0 || gap >= AIR_CUSHION_RANGE) return;

    const avN = bodyNear.angvel().x;
    const avF = bodyFar.angvel().x;
    const closingRate = avN - avF;
    const maxClosingRate = AIR_CUSHION_MAX_RATE * (gap / AIR_CUSHION_RANGE);
    if (closingRate <= maxClosingRate) return;

    const removed = closingRate - maxClosingRate;
    bodyNear.setAngvel({ x: avN - removed / 2, y: 0, z: 0 }, true);
    bodyFar.setAngvel({ x: avF + removed / 2, y: 0, z: 0 }, true);
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
    const refBody = curlIsNear ? bodyFar : bodyNear;
    const curlAnchorV = curlIsNear ? anchorNearVec : anchorFarVec;
    const refAnchorV = curlIsNear ? anchorFarVec : anchorNearVec;

    const curlAngle = pageAngle(curlBody);
    const refAngle = pageAngle(refBody);
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
    const refBody = curlPage === 'near' ? bodyFar : bodyNear;
    return curlTipPoint(curlAnchorVec, candidateAngle, pageAngle(refBody), pairGap(), PANEL_REACH, out);
  }
  function curlTip(out = _tipOut) {
    const curlBody = curlPage === 'near' ? bodyNear : bodyFar;
    return curlTipAt(pageAngle(curlBody), out);
  }

  // Same idea as curlTipAt, but varies the REFERENCE angle instead of the
  // curling page's own angle -- used by PageSimulation._enforceNoCrossingTips
  // to find where this curl's tip would land for some candidate ref angle
  // (e.g. scaled back from A's/D's real angle) without touching any body.
  function curlTipAtRef(candidateRefAngle, out = _tipOut) {
    const curlBody = curlPage === 'near' ? bodyNear : bodyFar;
    return curlTipPoint(curlAnchorVec, pageAngle(curlBody), candidateRefAngle, pairGap(), PANEL_REACH, out);
  }

  // The angle of this spread's curling page's STRAIGHT part, i.e. dirEnd in
  // buildCurlStrip -- always exactly the reference (flat/cover) page's own
  // current angle, since that's the whole point of the arc: it bends until
  // its tangent matches dirEnd, then continues straight in that exact
  // direction. Distinct from the curling page's own base/hinge angle,
  // which is what pageAngle(curlBody) reads. This is the reference body's
  // REAL angle, unaffected by any setRefAngleClamp override in effect.
  function straightAngle() {
    const refBody = curlPage === 'near' ? bodyFar : bodyNear;
    return pageAngle(refBody);
  }

  // Split so the cross-spread inner-page correction can run after BOTH
  // spreads' own physics corrections but before EITHER syncs its meshes.
  function stepPhysics() {
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
    world.removeRigidBody(anchorBodyNear);
    world.removeRigidBody(anchorBodyFar);
  }

  return {
    drop, moveAnchor, stepPhysics, sync, dispose,
    curlTip, curlTipAt, curlTipAtRef, straightAngle, setRefAngleClamp,
    get bodyNear() { return bodyNear; },
    get bodyFar() { return bodyFar; },
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