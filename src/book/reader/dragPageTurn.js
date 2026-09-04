import * as THREE from 'three';
import { HINGE_LEN, PANEL_REACH, BC_FIXED_ANGLE } from '../pageSim/config.js';
import { pageAngle } from '../pageSim/math.js';
import { PageSimulation } from '../pageSim/PageSimulation.js';
import {
  CURL_ROWS, CURL_INDEX, createCurlUV, writeCurlUV, buildCurlStrip,
} from '../pageSim/curlGeometry.js';

/**
 * Drag-to-turn-a-page, and keyboard-driven turns.
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
 * CONCURRENCY. Any number of keyboard turns can be in flight at once, so
 * hammering the arrow keys throws leaf after leaf across the spine
 * instead of dropping every press that arrives while one is still
 * animating. Each leaf owns its whole state — its own strip geometry,
 * its own two faces, its own progress — and lives in `turns` until it
 * lands. What makes the stack chain correctly is WHEN the book's page
 * state advances: a keyboard turn advances `content` the moment it
 * STARTS, not when it finishes, so the next turn already reads the next
 * spread and every leaf in the stack carries a different pair of pages.
 *
 * Advancing is deliberately split from REPAINTING, though. Only the panel
 * being peeled off is repainted up front (to what the leaf uncovers); the
 * panel the leaf is flying toward keeps its old page until that leaf
 * actually lands on it, because repainting it up front makes the page on
 * the far side of the book visibly jump the instant a key is pressed,
 * with nothing covering it. See content.advanceTurn and finishTurn.
 *
 * A pointer drag cannot work that way — it can be cancelled half-way, so
 * it has to defer its commit until release, and it keeps the grabbed
 * panel's original texture to put back. Only one drag runs at a time
 * (there is one cursor), and a drag will not start while other turns are
 * still in flight, which keeps that deferred commit from racing the
 * immediate ones.
 *
 * The temp strip is a real two-sided leaf, and THREE different pages are
 * in play during one turn — mixing any two of them up is what made this
 * show the wrong page on the wrong face:
 *
 *   1. the page on the grabbed panel now — the face you take hold of;
 *   2. the page this leaf LANDS as, on the opposite panel, once the turn
 *      completes (`content.landingTexture`) — the leaf's other face, and
 *      the one that swings into view as it flips;
 *   3. the page revealed UNDERNEATH on the grabbed panel itself
 *      (`content.underneathTexture`) — a different page again.
 *
 * Turning forward from a spread showing [N, N+1] with N+1 grabbed: the
 * leaf's faces are N+1 and N+2, and N+3 is revealed underneath it.
 */
export function createDragPageTurn({
  getPages, camera, renderer, controls, content, onPageTurnSound,
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

  // The temp strip and the real panel underneath it both hinge from the
  // exact same anchor point with the exact same tangent (BC_FIXED_ANGLE)
  // -- so right near that anchor, before the two curves have had any room
  // to diverge toward their different refAngle/radius targets, they're
  // nearly coincident. Two coincident curved surfaces z-fight
  // (flicker/clip into each other) however renderOrder is set, since
  // renderOrder only breaks ties for whichever fragment the depth test
  // already considers equal -- it can't fix genuinely overlapping-in-depth
  // geometry that crosses back and forth as it curves. Lifting the whole
  // temp strip a hair off the real page's plane keeps them from ever being
  // coincident in the first place, which is a cheap, purely cosmetic fix
  // for what's already a cosmetic layer.
  //
  // Each leaf in a stack gets its own multiple of this, so leaves that
  // start in the same frame do not land on each other either.
  const TEMP_TURN_LIFT = -0.002;

  /** Every leaf currently animating. */
  const turns = [];
  /** The one the pointer is driving, if any -- there is only one cursor. */
  let dragTurn = null;

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

  function makeTempMesh(turn, baseMaterial, side, mapOverride) {
    const geo = new THREE.BufferGeometry();
    // Position attribute wraps the SAME typed array on both the front and
    // back geometries -- one rebuild updates both, no need to keep two
    // copies in sync by hand. Each geometry still needs its own
    // BufferAttribute *object* (not shared) so each can carry its own
    // needsUpdate flag and its own GPU buffer.
    geo.setAttribute('position', new THREE.BufferAttribute(turn.positions, 3));
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

  function updateRowFracAndUV(turn) {
    const { positions, rowFrac } = turn;
    let cum = 0;
    rowFrac[0] = 0;
    for (let i = 1; i < CURL_ROWS; i++) {
      const ax = positions[(i - 1) * 3];
      const ay = positions[(i - 1) * 3 + 1];
      const az = positions[(i - 1) * 3 + 2];
      const bx = positions[i * 3];
      const by = positions[i * 3 + 1];
      const bz = positions[i * 3 + 2];
      cum += Math.hypot(bx - ax, by - ay, bz - az);
      rowFrac[i] = cum;
    }
    const total = rowFrac[CURL_ROWS - 1] || 1;
    for (let i = 0; i < CURL_ROWS; i++) rowFrac[i] /= total;

    // BOTH faces get the plain, unflipped uv layout -- the same one the
    // real B/C strips use. An earlier version flipped u on the back face,
    // reasoning that a surface seen from behind reads mirrored. It does
    // not: which uv lands on which vertex is fixed by the vertex data, so
    // a given texel sits at the same WORLD position no matter which side
    // of the surface you view it from. What actually differs between the
    // two panels is the handedness of their uv frames, and that is already
    // corrected per panel by PageSimulation.orientPageTexture -- so
    // flipping u here just double-corrected it.
    writeCurlUV(turn.meshFront.geometry.attributes.uv.array, rowFrac, false);
    writeCurlUV(turn.meshBack.geometry.attributes.uv.array, rowFrac, false);
    turn.meshFront.geometry.attributes.uv.needsUpdate = true;
    turn.meshBack.geometry.attributes.uv.needsUpdate = true;
  }

  /**
   * The curl parameters of the panel this leaf leaves and the one it
   * lands on, as they are RIGHT NOW. `gap` mirrors spread.js's own
   * pairGap(), including its floor -- that keeps a leaf parked hard
   * against a cover from collapsing the curl to zero width.
   */
  function shapeTargets(turn, pages) {
    const refFront = pageAngle(pages.spreadFront.pseudoBody);
    const refBack = pageAngle(pages.spreadBack.pseudoBody);
    const gapFront = Math.max(Math.abs(pages.spreadFront.anchorFar.z - pages.spreadFront.anchorNear.z), 1e-3);
    const gapBack = Math.max(Math.abs(pages.spreadBack.anchorFar.z - pages.spreadBack.anchorNear.z), 1e-3);
    return turn.panel === 'B'
      ? { startRef: refFront, endRef: refBack, startGap: gapFront, endGap: gapBack }
      : { startRef: refBack, endRef: refFront, startGap: gapBack, endGap: gapFront };
  }

  function rebuildLeaf(turn, pages) {
    // y = turn.lift, not 0 -- see TEMP_TURN_LIFT above. buildCurlStrip
    // adds this anchor point into every row it writes, so this rigidly
    // lifts the whole strip by a constant offset without distorting it.
    _anchorLocal.set(0, turn.lift, pages.spreadFront.anchorFar.z); // z == spreadBack.anchorNear.z, the shared B/C hinge
    // Read the two shapes this leaf morphs between LIVE, every frame, not
    // from a snapshot taken when the turn began. The real B/C strips are
    // themselves rebuilt every frame from these same two values, and both
    // keep moving for the whole length of a turn: the pseudo bodies are
    // still simulating, and the shared hinge is still easing toward the
    // new reading position, which changes pairGap() on BOTH spreads. A
    // leaf interpolating between stale endpoints is therefore congruent
    // with neither panel by the time it gets there -- worst when the
    // stacks are uneven, since that is when the hinge has furthest to
    // travel mid-turn, and it shows up as the leaf cutting into the book.
    const { startRef, endRef, startGap, endGap } = shapeTargets(turn, pages);
    const refAngle = THREE.MathUtils.lerp(startRef, endRef, turn.progress);
    const gap = THREE.MathUtils.lerp(startGap, endGap, turn.progress);
    // HINGE_LEN is read live (not cached) -- it's a mutable `let` export
    // that changes when a PDF loads and the book gets resized
    // (setPageDimensions, see main.js's applyPdfDimensions). This module is
    // only ever created once and never recreated on resize, so caching
    // this at module scope left it frozen at whatever HINGE_LEN was at
    // startup -- which showed up as the temp page being a different size
    // than B/C and clipping into the cover beside it.
    const halfWidth = HINGE_LEN / 2;
    buildCurlStrip(turn.positions, _anchorLocal, BC_FIXED_ANGLE, refAngle, gap, PANEL_REACH, halfWidth);
    turn.meshFront.geometry.attributes.position.needsUpdate = true;
    turn.meshBack.geometry.attributes.position.needsUpdate = true;
    turn.meshFront.geometry.computeVertexNormals();
    turn.meshBack.geometry.computeVertexNormals();
    updateRowFracAndUV(turn);
  }

  /**
   * Builds a leaf for `panel`: the shape it morphs between, its two faces,
   * and whatever the panel underneath should show.
   *
   * `commitNow` is the difference between the two kinds of turn. A
   * keyboard turn passes true and advances the book's page state up front,
   * which is what lets several of them stack and each carry a different
   * spread; committing also repaints both real panels, so it supplies the
   * "underneath" reveal for free. A drag passes false, previews the
   * underneath by hand, and keeps the original texture so a cancelled
   * drag can put it back.
   */
  function createTurn(panel, pages, { commitNow }) {
    const grabbedMesh = pages.pageMeshes[panel];
    const turn = {
      panel,
      grabbedMesh,
      originalTexture: grabbedMesh.material.map,
      turnSign: panel === 'B' ? 1 : -1,
      committed: commitNow,
      progress: 0,
      mode: commitNow ? 'auto' : 'dragging',
      autoElapsed: 0,
      settleTarget: 0,
      soundPlayed: false,
      angle0: 0,
      pivotScreen: new THREE.Vector2(),
      // Stagger stacked leaves so two that start in the same frame are
      // never coplanar with each other.
      // Capped: the stagger only has to separate leaves from each other,
      // and an uncapped multiple would have the tail of a long cascade
      // visibly floating off the page block.
      lift: TEMP_TURN_LIFT * (1 + 0.5 * Math.min(turns.length, 4)),
      positions: new Float32Array(2 * CURL_ROWS * 3),
      rowFrac: new Float32Array(CURL_ROWS),
    };

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
    // the turn. That IS the leaf flipping over.
    const landingPanel = panel === 'B' ? 'C' : 'B';
    const grabbedSide = PageSimulation.slotFrontFacesUp(panel) ? THREE.FrontSide : THREE.BackSide;
    const landingSide = grabbedSide === THREE.FrontSide ? THREE.BackSide : THREE.FrontSide;

    // Built from the panel's current material/texture, BEFORE anything
    // below repaints the real mesh -- the clone captures the map as it is
    // right now, which is the page you are taking hold of.
    const grabbedFace = makeTempMesh(turn, grabbedMesh.material, grabbedSide);

    // Read while `content` is still on the spread this turn starts from.
    // The keyboard path advances the book here too, in the same step, so a
    // stacked turn behind this one already sees the next spread -- but it
    // deliberately does NOT repaint the panels; see advanceTurn.
    let landingTexture;
    let underneathTexture;
    if (commitNow) {
      const advanced = content.advanceTurn(panel);
      landingTexture = advanced.landing;
      underneathTexture = advanced.underneath;
      turn.landingPanel = advanced.landingPanel;
      turn.pendingLanding = advanced.landing;
    } else {
      landingTexture = content.landingTexture(panel);
      underneathTexture = content.underneathTexture(panel);
    }
    turn.hasTurnTextures = !!landingTexture;

    let landingFace;
    if (landingTexture) {
      // Cloned, then oriented for the LANDING panel. The clone shares its
      // Source with the original, so this costs no extra gpu upload -- it
      // just keeps this leaf's uv transform off the cached texture, which
      // is handed out per page index and may already be on a panel under
      // a different slot's orientation.
      const landingTex = landingTexture.clone();
      landingTex.needsUpdate = true;
      pages.orientPageTexture(landingPanel, landingTex);
      landingFace = makeTempMesh(turn, grabbedMesh.material, landingSide, landingTex);
    } else {
      // Nothing to land as (start/end of book) -- reuse the grabbed face's
      // content rather than showing a blank back.
      landingFace = makeTempMesh(turn, grabbedFace.material, landingSide);
    }

    // Reveal what is under the leaf on the panel it is peeling off. Both
    // paths do this; only the OPPOSITE panel differs between them, and
    // that one is not touched until the leaf lands (finishTurn).
    if (underneathTexture) pages.setPageTexture(panel, underneathTexture);

    turn.meshFront = grabbedSide === THREE.FrontSide ? grabbedFace : landingFace;
    turn.meshBack = grabbedSide === THREE.FrontSide ? landingFace : grabbedFace;

    turn.group = new THREE.Group();
    turn.group.add(turn.meshFront, turn.meshBack);
    pages.root.add(turn.group);

    rebuildLeaf(turn, pages);
    turns.push(turn);
    return turn;
  }

  function disposeLeaf(turn) {
    turn.group?.parent?.remove(turn.group);
    for (const mesh of [turn.meshFront, turn.meshBack]) {
      mesh?.geometry.dispose();
      mesh?.material.dispose();
    }
    turn.group = null;
    turn.meshFront = null;
    turn.meshBack = null;
  }

  function finishTurn(turn, pages, committed) {
    // A keyboard turn advanced the book's page state up front but left the
    // opposite panel alone, so the leaf could fly over a panel still
    // showing the old page. Now that it has arrived and is covering that
    // panel, swap the panel to the leaf's far face and let the leaf go --
    // the two are congruent at this point, so the handover is invisible.
    if (turn.committed) {
      if (pages && turn.pendingLanding) {
        pages.setPageTexture(turn.landingPanel, turn.pendingLanding);
      }
    } else {
      if (committed && turn.hasTurnTextures) {
        content.commitTurn(turn.panel);
      } else if (pages && turn.originalTexture) {
        // Cancelled (or nothing was available to turn to) -- put the real
        // panel back exactly how it looked before the drag.
        pages.setPageTexture(turn.panel, turn.originalTexture);
      }
    }
    disposeLeaf(turn);

    const i = turns.indexOf(turn);
    if (i !== -1) turns.splice(i, 1);
    if (dragTurn === turn) {
      dragTurn = null;
      controls.enabled = true; // only the drag ever took them
    }
  }

  /**
   * Play a whole turn on `panel` with no pointer involved -- what the
   * arrow keys call, so a keyboard turn is the same physical page flip a
   * drag produces rather than a texture swap.
   *
   * Unlimited: every call starts another leaf, however many are already
   * in flight, so held or hammered arrow keys throw a whole cascade of
   * pages instead of dropping presses. The book's own ends are the only
   * bound -- content.canTurn goes false at the front and back cover, and
   * because each turn commits up front that check already accounts for
   * every turn currently animating.
   *
   * Returns false when the turn can't happen (nothing loaded, at that end
   * of the book, or a drag is in progress), so the caller can decide
   * whether to fall back to anything.
   */
  function playTurn(panel) {
    if (dragTurn) return false; // don't stack turns onto a page being held
    const pages = getPages();
    if (!pages || !content.canTurn(panel)) return false;

    createTurn(panel, pages, { commitNow: true });
    onPageTurnSound?.();
    return true;
  }

  dom.addEventListener('pointerdown', (e) => {
    // One drag at a time, and not while a cascade of keyboard turns is
    // still landing -- a drag defers its commit, which would otherwise
    // race the immediate ones.
    if (e.button !== 0 || turns.length > 0) return;
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
    if (!content.canTurn(panel)) return; // already at the front/back cover on that side

    const turn = createTurn(panel, pages, { commitNow: false });

    // Screen-space pivot the drag's angular sweep is measured around --
    // the shared hinge, projected. Pointer-only: a turn that plays itself
    // has no cursor to measure against.
    _anchorLocal.set(0, 0, pages.spreadFront.anchorFar.z);
    _anchorWorld.copy(_anchorLocal).applyMatrix4(pages.root.matrixWorld);
    screenPointFor(_anchorWorld, turn.pivotScreen);
    turn.angle0 = Math.atan2(e.clientY - turn.pivotScreen.y, e.clientX - turn.pivotScreen.x);

    dragTurn = turn;
    controls.enabled = false;

    // Stop OrbitControls (bound in the bubble phase on this same element)
    // from ever seeing this pointerdown -- capture:true below runs us
    // first, and without this it would still start its own left-drag
    // rotate on the exact same gesture.
    e.stopPropagation();
    e.preventDefault();
  }, { capture: true });

  window.addEventListener('pointermove', (e) => {
    if (!dragTurn || dragTurn.mode !== 'dragging') return;
    const angle = Math.atan2(e.clientY - dragTurn.pivotScreen.y, e.clientX - dragTurn.pivotScreen.x);
    let delta = angle - dragTurn.angle0;
    delta = Math.atan2(Math.sin(delta), Math.cos(delta)); // shortest signed angular difference
    dragTurn.progress = THREE.MathUtils.clamp((dragTurn.turnSign * delta) / TURN_ANGLE_RANGE, 0, 1);
    if (!dragTurn.soundPlayed && dragTurn.progress >= 0.5) {
      dragTurn.soundPlayed = true;
      onPageTurnSound?.();
    }
    const pages = getPages();
    if (pages) rebuildLeaf(dragTurn, pages);
  });

  window.addEventListener('pointerup', (e) => {
    if (e.button !== 0) return;
    if (dragTurn && dragTurn.mode === 'dragging') {
      dragTurn.settleTarget = dragTurn.progress >= 0.5 ? 1 : 0;
      dragTurn.mode = 'settling';
    }
  });

  function update(dt) {
    if (turns.length === 0) return;
    const pages = getPages();
    if (!pages) {
      // The simulation was disposed out from under us (a resize rebuild).
      // Every leaf lives under pages.root and went with it, so just let go.
      for (const turn of turns.slice()) finishTurn(turn, null, false);
      return;
    }

    // Snapshot: finishTurn splices out of `turns` as leaves land.
    for (const turn of turns.slice()) {
      if (turn.mode === 'dragging') continue; // driven by pointermove, not the clock

      if (turn.mode === 'auto') {
        turn.autoElapsed += dt;
        const t = Math.min(turn.autoElapsed / AUTO_TURN_DURATION, 1);
        turn.progress = easeInOut(t);
        rebuildLeaf(turn, pages);
        if (t >= 1) finishTurn(turn, pages, true);
        continue;
      }

      // settling
      turn.progress += (turn.settleTarget - turn.progress) * Math.min(SETTLE_RATE * dt, 1);
      if (Math.abs(turn.progress - turn.settleTarget) < 0.01) {
        turn.progress = turn.settleTarget;
        rebuildLeaf(turn, pages);
        finishTurn(turn, pages, turn.settleTarget === 1);
        continue;
      }
      rebuildLeaf(turn, pages);
    }
  }

  return { update, playTurn, get activeTurnCount() { return turns.length; } };
}
