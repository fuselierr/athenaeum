import * as THREE from 'three';
import { HINGE_LEN, PANEL_REACH, BC_FIXED_ANGLE } from '../pageSim/config.js';
import { pageAngle } from '../pageSim/math.js';
import { PageSimulation } from '../pageSim/PageSimulation.js';
import {
  CURL_ROWS, CURL_INDEX, createCurlUV, writeCurlUV, buildCurlStrip,
} from '../pageSim/curlGeometry.js';

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
 * The temp strip is a real two-sided leaf, and THREE different pages are
 * in play during one turn — mixing any two of them up is what made this
 * show the wrong page on the wrong face:
 *
 *   1. the page on the grabbed panel now — the face you take hold of;
 *   2. the page this leaf LANDS as, on the opposite panel, once the turn
 *      completes (`content.landingTexture`) — the leaf's other face, and the
 *      one that swings into view as it flips;
 *   3. the page revealed UNDERNEATH on the grabbed panel itself
 *      (`content.underneathTexture`) — a different page again, painted onto
 *      the real mesh the moment the drag starts (through
 *      PageSimulation.setPageTexture, so it picks up the same tint and
 *      orientation as any other slot assignment) so nothing sits blank
 *      behind the leaf as it peels away.
 *
 * Turning forward from a spread showing [N, N+1] with N+1 grabbed: the
 * leaf's faces are N+1 and N+2, and N+3 is revealed underneath it.
 *
 * A cancelled drag (released before the halfway point) reverts the real
 * panel back to what it showed before the drag started; a completed one
 * (released past halfway) calls `content.commitTurn`, which drives the actual
 * page content forward/backward (bookContent's showLeaf) to match.
 */
export function createDragPageTurn({
  getPages, camera, renderer, controls, content,
}) {
  const dom = renderer.domElement;
  const raycaster = new THREE.Raycaster();
  const pointerNdc = new THREE.Vector2();

  // Degrees of angular sweep (around the shared hinge, in SCREEN space)
  // that maps to a full 0->1 turn. Tuned by feel, not derived from
  // anything physical.
  const TURN_ANGLE_RANGE = Math.PI * 0.6;
  const SETTLE_RATE = 8; // 1/s, exponential ease toward whichever end the drag committed to

  // A turn that plays itself (playTurn) runs on a fixed duration and an
  // ease-in-out instead of SETTLE_RATE's exponential decay. Decay is right
  // for finishing a drag -- it starts from wherever you let go and never
  // has to look like it began -- but driving a whole 0 -> 1 turn with it
  // would start at full speed and crawl into the finish. Ease-in-out has
  // the leaf lift, sweep and settle the way a hand would move it.
  const AUTO_TURN_DURATION = 0.55; // seconds

  // Standard cubic ease-in-out.
  function easeInOut(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - ((-2 * t + 2) ** 3) / 2;
  }

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
  const TEMP_TURN_LIFT = -0.002;

  let state = 'idle'; // 'idle' | 'dragging' | 'settling' | 'auto'
  // Whether the turn in flight came from a pointer. A self-playing turn
  // (playTurn) must not touch OrbitControls -- disabling and re-enabling
  // them around a keyboard turn would stomp on whatever state they were
  // actually in.
  let pointerDriven = false;
  let autoElapsed = 0; // seconds into a self-playing turn
  let grabbedPanel = null; // 'B' | 'C'
  let grabbedMesh = null;
  let originalTexture = null; // grabbed panel's texture before the drag started, for a cancelled turn
  let hasTurnTextures = false; // false near either end of the book -- nothing to turn to
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

    // BOTH faces get the plain, unflipped uv layout -- the same one the
    // real B/C strips use. An earlier version flipped u on the back face,
    // reasoning that a surface seen from behind reads mirrored. It does
    // not: which uv lands on which vertex is fixed by the vertex data, so
    // a given texel sits at the same WORLD position no matter which side
    // of the surface you view it from. What actually differs between the
    // two panels is the handedness of their uv frames, and that is already
    // corrected per panel by PageSimulation.orientPageTexture -- so
    // flipping u here just double-corrected it.
    writeCurlUV(tempMeshFront.geometry.attributes.uv.array, curlRowFrac, false);
    writeCurlUV(tempMeshBack.geometry.attributes.uv.array, curlRowFrac, false);
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

  function makeTempMesh(baseMaterial, side, mapOverride) {
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
    if (mapOverride) mat.map = mapOverride;
    mat.needsUpdate = true;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.renderOrder = 2; // above B/C/the wedge so it never loses a coincident-depth tie mid-turn
    return mesh;
  }

  /**
   * Everything a turn needs regardless of what started it: the shape it
   * morphs between, the two-sided leaf, and the page revealed underneath.
   * Leaves `progress` at 0 and does NOT pick a state -- the caller decides
   * whether the turn is driven by a pointer or plays itself out.
   */
  function beginTurn(panel, pages) {
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

    // The turning leaf's two faces belong to two DIFFERENT panels, and
    // that is the whole trick here:
    //
    //   * the face you grab shows the page that is on `panel` right now,
    //     oriented the way `panel` orients it;
    //   * the other face shows the page this leaf LANDS as once the turn
    //     completes -- which ends up on the opposite panel, so it must be
    //     oriented the way THAT panel orients it.
    //
    // Getting the second one from `panel` (as this used to) is what put
    // the wrong page on the back of the leaf and stood it on its head:
    // wrong page because it read the grabbed panel's slot of the target
    // spread rather than the landing panel's, wrong way up because B and
    // C mirror opposite axes.
    //
    // Which of THREE.FrontSide / BackSide is the grabbed face is not
    // fixed either: a panel's geometric front points along u cross v,
    // which faces up on C/D but down on A/B (see
    // PageSimulation.SLOT_ON_MINUS_Z). At progress 0 the strip is
    // congruent with `panel`, so the side facing the camera is whichever
    // one `panel` itself shows; at progress 1 it is congruent with the
    // landing panel, on the far side of the spine, which always has the
    // opposite handedness -- so the visible face swaps exactly once over
    // the turn. That IS the leaf flipping over. Hardcoding grabbed =
    // FrontSide happened to be right for C and exactly backwards for B,
    // which is why turning back a page showed its two faces swapped.
    const landingPanel = panel === 'B' ? 'C' : 'B';
    const grabbedSide = PageSimulation.slotFrontFacesUp(panel) ? THREE.FrontSide : THREE.BackSide;
    const landingSide = grabbedSide === THREE.FrontSide ? THREE.BackSide : THREE.FrontSide;

    // Built from the panel's current material/texture, before the
    // underneath preview below touches the real mesh at all.
    tempPositions = new Float32Array(2 * CURL_ROWS * 3);
    const grabbedFace = makeTempMesh(grabbedMesh.material, grabbedSide);

    const landingTexture = content.landingTexture(panel);
    hasTurnTextures = !!landingTexture;
    let landingFace;
    if (landingTexture) {
      // Cloned, then oriented for the LANDING panel. The clone shares its
      // Source with the original, so this costs no extra gpu upload -- it
      // just keeps this leaf's uv transform off the cached texture, which
      // main.js hands out per page index and may already have on a panel
      // under a different slot's orientation.
      const landingTex = landingTexture.clone();
      landingTex.needsUpdate = true;
      pages.orientPageTexture(landingPanel, landingTex);
      landingFace = makeTempMesh(grabbedMesh.material, landingSide, landingTex);
    } else {
      // Nothing to land as (start/end of book) -- reuse the grabbed face's
      // content rather than showing a blank back.
      landingFace = makeTempMesh(grabbedFace.material, landingSide);
    }

    // Preview on the real panel underneath what that panel will be
    // showing once the turn commits -- a DIFFERENT page from the leaf's
    // landing face: the leaf lands on the opposite panel, so what gets
    // revealed here is this panel's own slot of the target spread. Set
    // through setPageTexture so it picks up the same tint/orientation
    // every other slot assignment does.
    const underneathTexture = content.underneathTexture(panel);
    if (underneathTexture) pages.setPageTexture(panel, underneathTexture);

    tempMeshFront = grabbedSide === THREE.FrontSide ? grabbedFace : landingFace;
    tempMeshBack = grabbedSide === THREE.FrontSide ? landingFace : grabbedFace;

    tempGroup = new THREE.Group();
    tempGroup.add(tempMeshFront, tempMeshBack);
    pages.root.add(tempGroup);

    rebuildTempMesh(pages);
  }

  /** Start a turn the pointer will drive, frame by frame, from `event`. */
  function beginDrag(panel, pages, event) {
    beginTurn(panel, pages);

    // Screen-space pivot the drag's angular sweep is measured around --
    // the shared hinge, projected. Pointer-only: a turn that plays itself
    // has no cursor to measure against.
    _anchorLocal.set(0, 0, pages.spreadFront.anchorFar.z);
    _anchorWorld.copy(_anchorLocal).applyMatrix4(pages.root.matrixWorld);
    screenPointFor(_anchorWorld, pivotScreen);
    angle0 = Math.atan2(event.clientY - pivotScreen.y, event.clientX - pivotScreen.x);

    pointerDriven = true;
    controls.enabled = false;
    state = 'dragging';
  }

  /**
   * Play a whole turn on `panel` with no pointer involved -- what the
   * arrow keys call, so a keyboard turn is the same physical page flip a
   * drag produces rather than a texture swap. Returns false when the turn
   * can't happen (nothing loaded, already at that end of the book, or a
   * turn is already in flight), so the caller can decide whether to fall
   * back to anything.
   *
   * Held arrow keys work out on their own: key-repeat fires far faster
   * than a turn takes, every repeat during one lands on the `state`
   * check below and is dropped, and the first repeat after a turn
   * finishes starts the next -- which reads as steadily turning pages.
   */
  function playTurn(panel) {
    if (state !== 'idle') return false;
    const pages = getPages();
    if (!pages || !content.canTurn(panel)) return false;

    beginTurn(panel, pages);
    pointerDriven = false;
    autoElapsed = 0;
    state = 'auto';
    return true;
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
    if (committed && hasTurnTextures) {
      content.commitTurn(grabbedPanel);
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
    // Only give the controls back if this turn was the one that took them.
    if (pointerDriven) controls.enabled = true;
    pointerDriven = false;
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
    if (!content.canTurn(panel)) return; // already at the front/back cover on that side -- nothing to turn to

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
    if (state !== 'settling' && state !== 'auto') return;
    const pages = getPages();
    if (!pages || !tempGroup) {
      state = 'idle';
      if (pointerDriven) controls.enabled = true;
      return;
    }

    if (state === 'auto') {
      autoElapsed += dt;
      const t = Math.min(autoElapsed / AUTO_TURN_DURATION, 1);
      progress = easeInOut(t);
      rebuildTempMesh(pages);
      if (t >= 1) endTurn(pages, true);
      return;
    }

    progress += (settleTarget - progress) * Math.min(SETTLE_RATE * dt, 1);
    if (Math.abs(progress - settleTarget) < 0.01) {
      progress = settleTarget;
      rebuildTempMesh(pages);
      endTurn(pages, settleTarget === 1);
      return;
    }
    rebuildTempMesh(pages);
  }

  return { update, playTurn };
}