import * as THREE from 'three';
import { HINGE_LEN, PANEL_REACH, BC_FIXED_ANGLE } from './config.js';
import { pageAngle } from './math.js';
import {
  CURL_ROWS, CURL_INDEX, createCurlUV, writeCurlUV, buildCurlStrip,
} from './curlGeometry.js';

/**
 * Drag-to-turn-a-page.
 *
 * B and C are both just buildCurlStrip() calls sharing the exact same
 * anchor point (the shared inner-leaf hinge) and the exact same hinge-
 * tangent angle (BC_FIXED_ANGLE, hard-locked by
 * PageSimulation._enforceNoCrossingBC) — they differ only in `refAngle`
 * (B targets spreadFront's pseudoBody, mirroring A; C targets
 * spreadBack's pseudoBody, mirroring D) and `radius` (each spread's own
 * current anchor separation, spread.js's pairGap()). So "B turning into
 * C's shape" (or vice versa) is nothing more than lerping those two
 * parameters and re-running buildCurlStrip every frame — no new physics,
 * no new geometry scheme, just the one this book already uses for B/C
 * themselves, aimed at a temporary strip.
 *
 * Grabbing B always turns forward (B's shape -> C's shape); grabbing C
 * always turns backward (C's shape -> B's shape) — the panel decides
 * direction, not the drag direction.
 *
 * The temp page is double-sided with two different textures: its front
 * face is whatever the grabbed panel is currently showing, its back face
 * is whatever that panel will show once the turn actually commits (the
 * "next"/"previous" page, from `getBackTexture`). The real panel mesh
 * underneath is switched to that same back texture the moment the drag
 * starts — via PageSimulation.setPageTexture, so it picks up the exact
 * same tint/rotation convention every other slot assignment does — so it
 * no longer sits blank behind the temp page; it already shows the
 * upcoming content, and is revealed as the temp page peels away. A
 * cancelled drag (released before the halfway point) reverts the real
 * panel back to what it showed before the drag started; a completed one
 * (released past halfway) calls `commitTurn`, which drives the actual
 * page content forward/backward (main.js's showLeaf) to match.
 */
export function createDragPageTurn({
  getPages, camera, renderer, controls, canTurn, getBackTexture, commitTurn,
}) {
  const dom = renderer.domElement;
  const raycaster = new THREE.Raycaster();
  const pointerNdc = new THREE.Vector2();

  // Degrees of angular sweep (around the shared hinge, in SCREEN space)
  // that maps to a full 0->1 turn. Tuned by feel, not derived from
  // anything physical.
  const TURN_ANGLE_RANGE = Math.PI * 0.6;
  const SETTLE_RATE = 8; // 1/s, exponential ease toward whichever end the drag committed to

  // The temp strip and the real panel underneath it (see beginDrag/
  // rebuildTempMesh) both hinge from the exact same anchor point with the
  // exact same tangent (BC_FIXED_ANGLE) -- so right near that anchor,
  // before the two curves have had any room to diverge toward their
  // different refAngle/radius targets, they're nearly coincident. Two
  // coincident curved surfaces z-fight (flicker/clip into each other)
  // however renderOrder is set, since renderOrder only breaks ties for
  // whichever fragment the depth test already considers equal -- it can't
  // fix genuinely overlapping-in-depth geometry that crosses back and
  // forth as it curves. Lifting the whole temp strip a hair off the real
  // page's plane keeps them from ever being coincident in the first
  // place, which is a cheap, purely cosmetic fix for what's already a
  // cosmetic layer.
  const TEMP_TURN_LIFT = -0.015;

  let state = 'idle'; // 'idle' | 'dragging' | 'settling'
  let grabbedPanel = null; // 'B' | 'C'
  let grabbedMesh = null;
  let originalTexture = null; // grabbed panel's texture before the drag started, for a cancelled turn
  let hasBackTexture = false; // false near either end of the book -- nothing to turn to
  let turnSign = 1; // +1 for B (forward), -1 for C (backward)
  const pivotScreen = new THREE.Vector2();
  let angle0 = 0;
  let startRef = 0;
  let endRef = 0;
  let startGap = 0;
  let endGap = 0;
  let progress = 0;
  let settleTarget = 0;

  let tempGroup = null;
  let tempMeshFront = null;
  let tempMeshBack = null;
  let tempPositions = null;
  const curlRowFrac = new Float32Array(CURL_ROWS);
  const _anchorLocal = new THREE.Vector3();
  const _anchorWorld = new THREE.Vector3();

  function screenPointFor(worldPoint, out) {
    const ndc = worldPoint.clone().project(camera);
    const rect = dom.getBoundingClientRect();
    out.set(
      rect.left + (ndc.x * 0.5 + 0.5) * rect.width,
      rect.top + (1 - (ndc.y * 0.5 + 0.5)) * rect.height,
    );
    return out;
  }

  function updateRowFracAndUV() {
    let cum = 0;
    curlRowFrac[0] = 0;
    for (let i = 1; i < CURL_ROWS; i++) {
      const ax = tempPositions[(i - 1) * 3];
      const ay = tempPositions[(i - 1) * 3 + 1];
      const az = tempPositions[(i - 1) * 3 + 2];
      const bx = tempPositions[i * 3];
      const by = tempPositions[i * 3 + 1];
      const bz = tempPositions[i * 3 + 2];
      cum += Math.hypot(bx - ax, by - ay, bz - az);
      curlRowFrac[i] = cum;
    }
    const total = curlRowFrac[CURL_ROWS - 1] || 1;
    for (let i = 0; i < CURL_ROWS; i++) curlRowFrac[i] /= total;

    // Front and back get OPPOSITE flipU: the back face is the exact same
    // vertices/UVs seen from the opposite vantage point, which reads as
    // mirrored to the viewer (see the flipU comment in curlGeometry.js --
    // this book already hit exactly this problem once, with B's text
    // showing up backwards on a DoubleSide single-material mesh). Since
    // the back face is a real, different page meant to be read normally
    // once it's facing the camera, its UV needs the opposite flip so it
    // doesn't come out mirrored.
    writeCurlUV(tempMeshFront.geometry.attributes.uv.array, curlRowFrac, false);
    writeCurlUV(tempMeshBack.geometry.attributes.uv.array, curlRowFrac, true);
    tempMeshFront.geometry.attributes.uv.needsUpdate = true;
    tempMeshBack.geometry.attributes.uv.needsUpdate = true;
  }

  function rebuildTempMesh(pages) {
    // y = TEMP_TURN_LIFT, not 0 -- see the comment on that constant above.
    // buildCurlStrip adds this anchor point into every row it writes (the
    // arc rows via `.add(anchorPoint)`, the tip via `.add(curveEnd)` which
    // already carries it), so this rigidly lifts the whole strip by a
    // constant offset without distorting its shape at all.
    _anchorLocal.set(0, TEMP_TURN_LIFT, pages.spreadFront.anchorFar.z); // z == spreadBack.anchorNear.z, the shared B/C hinge
    const refAngle = THREE.MathUtils.lerp(startRef, endRef, progress);
    const gap = THREE.MathUtils.lerp(startGap, endGap, progress);
    // HINGE_LEN is read live (not cached) -- it's a mutable `let` export
    // that changes when a PDF loads and the book gets resized
    // (setPageDimensions, see main.js's applyPdfDimensions). spread.js
    // recomputes its own halfWidth fresh every createSpread() call, which
    // reruns on every resize; this module is only ever created once by
    // main.js and never recreated on resize, so caching this at module
    // scope the way an earlier version did left it frozen at whatever
    // HINGE_LEN was at startup -- silently out of sync with B/C's real
    // current width the moment a differently-sized PDF loaded, which is
    // exactly what showed up as the temp page being a different size
    // than B/C and clipping into the cover beside it.
    const halfWidth = HINGE_LEN / 2;
    buildCurlStrip(tempPositions, _anchorLocal, BC_FIXED_ANGLE, refAngle, gap, PANEL_REACH, halfWidth);
    tempMeshFront.geometry.attributes.position.needsUpdate = true;
    tempMeshBack.geometry.attributes.position.needsUpdate = true;
    tempMeshFront.geometry.computeVertexNormals();
    tempMeshBack.geometry.computeVertexNormals();
    updateRowFracAndUV();
  }

  function makeTempMesh(baseMaterial, side) {
    const geo = new THREE.BufferGeometry();
    // Position attribute wraps the SAME typed array on both the front and
    // back geometries -- one rebuild in rebuildTempMesh updates both, no
    // need to keep two copies in sync by hand. Each geometry still needs
    // its own BufferAttribute *object* (not shared) so each can carry its
    // own needsUpdate flag and its own GPU buffer.
    geo.setAttribute('position', new THREE.BufferAttribute(tempPositions, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(createCurlUV(), 2));
    geo.setIndex(CURL_INDEX);
    const mat = baseMaterial.clone();
    mat.side = side;
    mat.needsUpdate = true;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.renderOrder = 2; // above B/C/the wedge so it never loses a coincident-depth tie mid-turn
    return mesh;
  }

  function beginDrag(panel, pages, event) {
    grabbedPanel = panel;
    grabbedMesh = pages.pageMeshes[panel];
    originalTexture = grabbedMesh.material.map;
    turnSign = panel === 'B' ? 1 : -1;

    const refFront = pageAngle(pages.spreadFront.pseudoBody);
    const refBack = pageAngle(pages.spreadBack.pseudoBody);
    // Same floor spread.js's own pairGap() applies -- keeps a leaf parked
    // right against its cover from collapsing the curl to zero width.
    const gapFront = Math.max(Math.abs(pages.spreadFront.anchorFar.z - pages.spreadFront.anchorNear.z), 1e-3);
    const gapBack = Math.max(Math.abs(pages.spreadBack.anchorFar.z - pages.spreadBack.anchorNear.z), 1e-3);
    if (panel === 'B') {
      startRef = refFront; endRef = refBack;
      startGap = gapFront; endGap = gapBack;
    } else {
      startRef = refBack; endRef = refFront;
      startGap = gapBack; endGap = gapFront;
    }
    progress = 0;

    _anchorLocal.set(0, 0, pages.spreadFront.anchorFar.z);
    _anchorWorld.copy(_anchorLocal).applyMatrix4(pages.root.matrixWorld);
    screenPointFor(_anchorWorld, pivotScreen);
    angle0 = Math.atan2(event.clientY - pivotScreen.y, event.clientX - pivotScreen.x);

    // Build the temp mesh's FRONT material from the panel's current
    // material/texture before touching the real mesh at all.
    tempPositions = new Float32Array(2 * CURL_ROWS * 3);
    tempMeshFront = makeTempMesh(grabbedMesh.material, THREE.FrontSide);

    // Preview the upcoming content on the real panel underneath -- through
    // setPageTexture, so it gets the same tint/rotation every other slot
    // assignment does -- then clone ITS material for the temp mesh's back
    // face, so front and back both end up with exactly the material
    // conventions PageSimulation itself uses.
    const backTexture = getBackTexture(panel);
    hasBackTexture = !!backTexture;
    if (backTexture) {
      pages.setPageTexture(panel, backTexture);
      tempMeshBack = makeTempMesh(grabbedMesh.material, THREE.BackSide);
    } else {
      // Nothing to turn to (start/end of book) -- fall back to mirroring
      // the front content rather than showing nothing on the back face.
      tempMeshBack = makeTempMesh(tempMeshFront.material, THREE.BackSide);
    }

    tempGroup = new THREE.Group();
    tempGroup.add(tempMeshFront, tempMeshBack);
    pages.root.add(tempGroup);

    rebuildTempMesh(pages);

    controls.enabled = false;
    state = 'dragging';
  }

  function disposeTempGroup() {
    if (!tempGroup) return;
    tempGroup.parent?.remove(tempGroup);
    for (const mesh of [tempMeshFront, tempMeshBack]) {
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
    tempGroup = null;
    tempMeshFront = null;
    tempMeshBack = null;
  }

  function endTurn(pages, committed) {
    if (committed && hasBackTexture) {
      commitTurn(grabbedPanel);
    } else if (pages && originalTexture) {
      // Cancelled (or nothing was actually available to turn to) -- put
      // the real panel back exactly how it looked before the drag.
      pages.setPageTexture(grabbedPanel, originalTexture);
    }
    disposeTempGroup();
    grabbedMesh = null;
    grabbedPanel = null;
    originalTexture = null;
    state = 'idle';
    controls.enabled = true;
  }

  dom.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || state !== 'idle') return;
    const pages = getPages();
    if (!pages) return;

    const rect = dom.getBoundingClientRect();
    pointerNdc.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(pointerNdc, camera);
    const candidates = [pages.pageMeshes.B, pages.pageMeshes.C].filter((m) => m.visible);
    const hits = raycaster.intersectObjects(candidates, false);
    if (hits.length === 0) return; // let it fall through to OrbitControls' own rotate

    const hitMesh = hits[0].object;
    const panel = hitMesh === pages.pageMeshes.B ? 'B' : 'C';
    if (!canTurn(panel)) return; // already at the front/back cover on that side -- nothing to turn to

    beginDrag(panel, pages, e);
    // Stop OrbitControls (bound in the bubble phase on this same element)
    // from ever seeing this pointerdown -- capture:true below runs us
    // first, and without this it would still start its own left-drag
    // rotate on the exact same gesture.
    e.stopPropagation();
    e.preventDefault();
  }, { capture: true });

  window.addEventListener('pointermove', (e) => {
    if (state !== 'dragging') return;
    const angle = Math.atan2(e.clientY - pivotScreen.y, e.clientX - pivotScreen.x);
    let delta = angle - angle0;
    delta = Math.atan2(Math.sin(delta), Math.cos(delta)); // shortest signed angular difference
    progress = THREE.MathUtils.clamp((turnSign * delta) / TURN_ANGLE_RANGE, 0, 1);
    const pages = getPages();
    if (pages) rebuildTempMesh(pages);
  });

  window.addEventListener('pointerup', (e) => {
    if (e.button !== 0) return;
    if (state === 'dragging') {
      settleTarget = progress >= 0.5 ? 1 : 0;
      state = 'settling';
    }
  });

  function update(dt) {
    if (state !== 'settling') return;
    const pages = getPages();
    if (!pages || !tempGroup) { state = 'idle'; controls.enabled = true; return; }

    progress += (settleTarget - progress) * Math.min(SETTLE_RATE * dt, 1);
    if (Math.abs(progress - settleTarget) < 0.01) {
      progress = settleTarget;
      rebuildTempMesh(pages);
      endTurn(pages, settleTarget === 1);
      return;
    }
    rebuildTempMesh(pages);
  }

  return { update };
}