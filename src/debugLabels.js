import * as THREE from 'three';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { HINGE_LEN } from './Book/pageSim/config.js';
import { CURL_ROWS } from './Book/pageSim/curlGeometry.js';

/**
 * Floating orientation labels: TOP/BOTTOM at the two ends of the spine
 * (the hinge line every page swings from -- world X, per math.js's
 * "every page rotates about world X"), and A/B/C/D on each panel's own
 * top edge (the edge at the same end of the hinge as the TOP label).
 * Toggled on/off with the ` key -- purely a debugging aid for figuring
 * out how the book's local axes map onto what's actually on screen,
 * nothing here affects the book itself.
 *
 * Rendered via CSS2DRenderer rather than in-scene sprites: crisp text at
 * any zoom with zero texture/canvas bookkeeping, and it already handles
 * billboarding and screen-space placement for us.
 *
 * "Top" and "bottom" are an arbitrary but fixed convention -- +HINGE_LEN/2
 * along local X is TOP, -HINGE_LEN/2 is BOTTOM -- picked once here so the
 * labels are internally consistent; which one reads as "up" on screen is
 * exactly the question these labels exist to answer.
 */
export function createDebugLabels({ scene, camera, renderer, getPages }) {
  const cssRenderer = new CSS2DRenderer();
  cssRenderer.domElement.style.position = 'absolute';
  cssRenderer.domElement.style.top = '0px';
  cssRenderer.domElement.style.left = '0px';
  // Overlays the whole viewport, same as the WebGL canvas -- must never
  // intercept pointer events, or every click/drag this app already
  // handles on renderer.domElement (page-turn drag, book rotate, arcball)
  // would silently stop working the moment this is appended.
  cssRenderer.domElement.style.pointerEvents = 'none';
  cssRenderer.setSize(window.innerWidth, window.innerHeight);
  document.body.appendChild(cssRenderer.domElement);
  window.addEventListener('resize', () => {
    cssRenderer.setSize(window.innerWidth, window.innerHeight);
  });

  function makeLabel(text, color) {
    const el = document.createElement('div');
    el.textContent = text;
    Object.assign(el.style, {
      font: '700 12px/1 monospace',
      color: '#fff',
      background: color,
      padding: '3px 7px',
      borderRadius: '4px',
      whiteSpace: 'nowrap',
      boxShadow: '0 1px 4px rgba(0,0,0,0.6)',
      border: '1px solid rgba(255,255,255,0.4)',
    });
    return new CSS2DObject(el);
  }

  const labelGroup = new THREE.Group();
  labelGroup.visible = false; // off by default -- press ` to show
  scene.add(labelGroup);

  const SPINE_COLOR = '#8855ee';
  // Matches each panel's own cover/leaf tint from PageSimulation.js's
  // createSpread() calls (colorNear/colorFar), so a label reads as
  // belonging to its panel at a glance.
  const spineTop = makeLabel('TOP', SPINE_COLOR);
  const spineBottom = makeLabel('BOTTOM', SPINE_COLOR);
  const labelA = makeLabel('A', '#5b7fff');
  const labelB = makeLabel('B', '#ff6f6f');
  const labelC = makeLabel('C', '#4fd1c5');
  const labelD = makeLabel('D', '#ffa94d');
  labelGroup.add(spineTop, spineBottom, labelA, labelB, labelC, labelD);

  window.addEventListener('keydown', (e) => {
    if (e.key === '`') labelGroup.visible = !labelGroup.visible;
  });

  const _local = new THREE.Vector3();

  /**
   * A point on a FLAT panel's (A/D) top edge, in world space. Flat pages
   * are a plain PlaneGeometry rotated so local (HINGE_LEN/2, 0, 0) is the
   * midpoint of the +X edge running from the hinge to the tip -- see
   * math.js's LOCAL_PIVOT_R/LOCAL_TIP_R, which both sit at that same
   * x = +HINGE_LEN/2. mesh.matrixWorld carries the page's real current
   * hinge angle (see spread.js's syncMesh), so this tracks it live.
   */
  function flatTopEdgePoint(mesh, out) {
    return out.set(HINGE_LEN / 2, 0, 0).applyMatrix4(mesh.matrixWorld);
  }

  /**
   * Same idea for a CURLING panel (B/C): buildCurlStrip (curlGeometry.js)
   * always writes center.x - halfWidth to the "left" column (vertex index
   * i) and center.x + halfWidth to the "right" column (index CURL_ROWS +
   * i) of every row, with center.x itself always 0 -- so the right column
   * is exactly the +halfWidth edge, i.e. this panel's own top edge, for
   * its entire curved length. Taking the middle row keeps the label
   * roughly centred along the strip regardless of how curled it
   * currently is. Read directly from the live position buffer (updated
   * every frame by spread.js's updateCurlMesh) rather than recomputing
   * the curve ourselves, so this can never drift out of sync with what's
   * actually rendered.
   */
  function curlTopEdgePoint(mesh, out) {
    const pos = mesh.geometry.attributes.position.array;
    const row = Math.floor(CURL_ROWS / 2);
    const i = (CURL_ROWS + row) * 3;
    out.set(pos[i], pos[i + 1], pos[i + 2]);
    return out.applyMatrix4(mesh.matrixWorld);
  }

  function update() {
    if (!labelGroup.visible) {
      cssRenderer.render(scene, camera);
      return;
    }
    const pages = getPages();
    if (pages) {
      // Spine ends: the hinge axis (world X) at the shared B/C anchor
      // (spreadFront.anchorFar.z == spreadBack.anchorNear.z -- see
      // PageSimulation's reset()), y = 0, in pages.root's own local
      // space.
      const z = pages.spreadFront.anchorFar.z;
      _local.set(HINGE_LEN / 2, 0, z).applyMatrix4(pages.root.matrixWorld);
      spineTop.position.copy(_local);
      _local.set(-HINGE_LEN / 2, 0, z).applyMatrix4(pages.root.matrixWorld);
      spineBottom.position.copy(_local);

      const meshes = pages.pageMeshes;
      labelA.position.copy(flatTopEdgePoint(meshes.A, _local));
      labelB.position.copy(curlTopEdgePoint(meshes.B, _local));
      labelC.position.copy(curlTopEdgePoint(meshes.C, _local));
      labelD.position.copy(flatTopEdgePoint(meshes.D, _local));
    }
    cssRenderer.render(scene, camera);
  }

  return { update };
}