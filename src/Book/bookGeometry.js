import * as THREE from 'three';

/**
 * BookGeometry
 * ------------
 * The static "backbone" of a book: front cover, back cover, and a spine
 * connecting them. This does NOT include pages — that's PageMesh /
 * page-stack blocks, built separately and attached as children of
 * this group later.
 *
 * Coordinate convention (important — page-turn math depends on this):
 *   - Origin sits at the spine's center, at the hinge line.
 *   - +X = to the right when the book is closed and facing you
 *   - +Y = up
 *   - +Z = toward the viewer (out of the pages)
 *   - The spine runs along Y, centered on X=0.
 *   - Covers pivot around the spine (X=0 edge), which is what lets you
 *     later animate "opening" the book by rotating each cover group
 *     around its own local Y-axis at X=0, instead of around its center.
 */

export class BookGeometry {
  /**
   * @param {Object} options
   * @param {number} options.width      - cover width (X), meters. Default 0.15 (~ a small hardback)
   * @param {number} options.height     - cover height (Y), meters. Default 0.22
   * @param {number} options.coverThickness - thickness of each cover board, meters. Default 0.004
   * @param {number} options.spineWidth - spine thickness (X depth of the spine cylinder/box), meters. Default 0.03
   * @param {string|THREE.Material} options.coverMaterial - material for covers (front/back)
   * @param {string|THREE.Material} options.spineMaterial - material for the spine
   */
  constructor({
    width = 0.15,
    height = 0.22,
    coverThickness = 0.005,
    spineWidth = 0.03,
    coverMaterial,
    spineMaterial,
    maxOpenAngleDeg = 90,
    pageStackThickness = 0.02,
    pageColor = '#f2ead9',
    pageInset = 0.006,
    pageSplit = 0.5,
  } = {}) {
    this.width = width;
    this.height = height;
    this.coverThickness = coverThickness;
    this.spineWidth = spineWidth;

    // How far each cover swings, in degrees, at openAmount = 1.
    // 180 = perfectly flat (cover folds all the way back opposite its
    // closed position). Kept just under 180 by default to avoid
    // z-fighting/clipping with the spine geometry at the exact flat pose —
    // push it to 180 yourself if your spine geometry doesn't overlap there.
    this.maxOpenAngleDeg = maxOpenAngleDeg;

    // Page stack config — see _buildPageStacks(). Pages are trimmed
    // slightly smaller than the covers (pageInset) on width and height,
    // which is what real books look like and also hides any z-fighting
    // at the outer edge.
    this.pageStackThickness = pageStackThickness;
    this.pageInset = pageInset;
    this.pageSplit = THREE.MathUtils.clamp(pageSplit, 0, 1);

    this.pageMaterial =
      pageColor instanceof THREE.Material
        ? pageColor
        : new THREE.MeshStandardMaterial({
            color: pageColor,
            roughness: 0.9,
          });

    this.coverMaterial =
      coverMaterial instanceof THREE.Material
        ? coverMaterial
        : new THREE.MeshStandardMaterial({
            color: coverMaterial ?? '#3a2a1a',
            roughness: 0.7,
          });

    this.spineMaterial =
      spineMaterial instanceof THREE.Material
        ? spineMaterial
        : new THREE.MeshStandardMaterial({
            color: spineMaterial ?? '#2a1c10',
            roughness: 0.8,
          });

    // Root group — this is what you add to the scene / grab with GrabSystem.
    // Everything else (pages, page-stack blocks) attaches under this later.
    this.root = new THREE.Group();
    this.root.name = 'BookGeometry';

    // Pivot groups let each cover rotate around the spine edge (X=0)
    // instead of its own geometric center. This is the piece that makes
    // "opening the book" a simple rotation instead of a rotation + reposition.
    this.frontCoverPivot = new THREE.Group();
    this.frontCoverPivot.name = 'frontCoverPivot';

    this.backCoverPivot = new THREE.Group();
    this.backCoverPivot.name = 'backCoverPivot';

    // Page stack pivots — same hinge-at-spine trick as the covers, but
    // these hold the "already read" (left) and "not yet read" (right)
    // paper blocks instead of a rigid cover board.
    this.leftPagePivot = new THREE.Group();
    this.leftPagePivot.name = 'leftPagePivot';

    this.rightPagePivot = new THREE.Group();
    this.rightPagePivot.name = 'rightPagePivot';

    this._buildSpine();
    this._buildCover(this.frontCoverPivot, +1, 'frontCover');
    this._buildCover(this.backCoverPivot, -1, 'backCover');
    this._buildPageStacks();

    this.root.add(
      this.spineMesh,
      this.frontCoverPivot,
      this.backCoverPivot,
      this.leftPagePivot,
      this.rightPagePivot
    );

    // Start closed: both covers flat against the spine, facing +Z / -Z.
    // openAmount below drives this — 0 = fully closed, 1 = fully open flat.
    this.openAmount = 0;
    this._applyOpenAmount();
  }

  /**
   * Build the spine as a slightly rounded box so it doesn't read as a
   * flat slab. A rounded shape here matters more than you'd think —
   * a plain BoxGeometry spine looks obviously fake even at a glance.
   */
  _buildSpine() {
    const shape = new THREE.Shape();
    const w = this.spineWidth;
    const h = this.height;
    const r = w * 0.4; // corner rounding radius

    shape.moveTo(-w / 2 + r, -h / 2);
    shape.lineTo(w / 2 - r, -h / 2);
    shape.quadraticCurveTo(w / 2, -h / 2, w / 2, -h / 2 + r);
    shape.lineTo(w / 2, h / 2 - r);
    shape.quadraticCurveTo(w / 2, h / 2, w / 2 - r, h / 2);
    shape.lineTo(-w / 2 + r, h / 2);
    shape.quadraticCurveTo(-w / 2, h / 2, -w / 2, h / 2 - r);
    shape.lineTo(-w / 2, -h / 2 + r);
    shape.quadraticCurveTo(-w / 2, -h / 2, -w / 2 + r, -h / 2);

    const extrudeSettings = {
      depth: this.coverThickness * 1.1,
      bevelEnabled: false,
      curveSegments: 8,
    };

    const geometry = new THREE.ExtrudeGeometry(shape, extrudeSettings);
    geometry.center(); // center on X=0 so it lines up with the pivot origin
    geometry.rotateY(Math.PI / 2); // extrude depth becomes local X (spine thickness)

    this.spineMesh = new THREE.Mesh(geometry, this.spineMaterial);
    this.spineMesh.name = 'spine';
    this.spineMesh.castShadow = true;
    this.spineMesh.receiveShadow = true;
  }

  /**
   * Build one cover (front or back) as a thin box, parented to a pivot
   * group positioned at the spine edge (X=0), so rotating the pivot
   * opens/closes that cover correctly.
   *
   * @param {THREE.Group} pivot
   * @param {1|-1} side - +1 for front cover (+Z side), -1 for back cover (-Z side)
   * @param {string} name
   */
  _buildCover(pivot, side, name) {
    const geometry = new THREE.BoxGeometry(
      this.width,
      this.height,
      this.coverThickness
    );

    // Shift geometry so its hinge edge (X=0 in pivot space) is the origin,
    // rather than the box's own center. This is what makes rotating the
    // pivot swing the cover open like a real hinge instead of orbiting
    // around the cover's middle.
    geometry.translate(this.width / 2, 0, 0);

    const mesh = new THREE.Mesh(geometry, this.coverMaterial);
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    // Position the pivot itself at the spine edge, offset slightly in Z
    // so the cover sits just outside the spine's extruded thickness.
    const spineHalfDepth = this.coverThickness + 0.005;
    pivot.position.set(0, 0, side * spineHalfDepth);

    pivot.add(mesh);
  }

  /**
   * Build (or rebuild) the two page-stack blocks: leftStack (pages already
   * turned) and rightStack (pages not yet turned). Together their combined
   * thickness always equals pageStackThickness — only the split changes.
   *
   * This is the "many pages for free" trick: instead of geometry per page,
   * it's two boxes whose thickness ratio shifts as pageSplit changes. Only
   * the single page currently mid-turn (built elsewhere, e.g. PageMesh)
   * needs to be real deformable geometry.
   */
  _buildPageStacks() {
    // Dispose any previous stack geometry before rebuilding (safe to call
    // from setPageSplit() too, not just the constructor).
    this._disposePageStacks();

    const pageWidth = this.width - this.pageInset;
    const pageHeight = this.height - this.pageInset;

    const leftThickness = Math.max(
      this.pageStackThickness * this.pageSplit,
      0.0005 // avoid zero-thickness geometry when split hits an extreme
    );
    const rightThickness = Math.max(
      this.pageStackThickness * (1 - this.pageSplit),
      0.0005
    );

    this.leftPageMesh = this._buildPageBoard(
      this.leftPagePivot,
      +1,
      'leftPageStack',
      pageWidth,
      pageHeight,
      leftThickness
    );

    this.rightPageMesh = this._buildPageBoard(
      this.rightPagePivot,
      -1,
      'rightPageStack',
      pageWidth,
      pageHeight,
      rightThickness
    );
  }

  /**
   * Shared builder for a flat rectangular "board" hinged at the spine —
   * used for both page stacks here. (Covers use their own near-identical
   * _buildCover since their thickness never changes at runtime; pages
   * rebuild constantly as pageSplit shifts, so keeping this separate
   * avoids adding rebuild logic to the cover path.)
   *
   * Critical detail: the box is translated so its INNER face (the one
   * touching the spine) sits at local Z=0, not its center. The pivot's
   * own position is then a small FIXED gap from the spine center —
   * independent of boardThickness. This is what keeps the stack anchored
   * to the spine as pageSplit changes; anchoring at the box's center
   * instead (the earlier version of this method) made the whole block
   * drift outward every time thickness changed, since the center moves
   * but the spine attachment point shouldn't.
   */
  _buildPageBoard(pivot, side, name, boardWidth, boardHeight, boardThickness) {
    const geometry = new THREE.BoxGeometry(boardWidth, boardHeight, boardThickness);
    // X: hinge edge at X=0, same as covers.
    // Z: shift so the inner (spine-facing) face sits at local Z=0 — the
    // box now extends from 0 to side*boardThickness instead of being
    // centered on its own origin.
    geometry.translate(boardWidth / 2, 0, (side * boardThickness) / 2);

    const mesh = new THREE.Mesh(geometry, this.pageMaterial);
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    // Fixed gap from spine center — does NOT depend on boardThickness,
    // so the hinge point never moves as pages shift between stacks.
    const spineGap = 0.001;
    pivot.position.set(0, 0, side * spineGap);

    pivot.add(mesh);
    return mesh;
  }

  _disposePageStacks() {
    if (this.leftPageMesh) {
      this.leftPagePivot.remove(this.leftPageMesh);
      this.leftPageMesh.geometry.dispose();
      this.leftPageMesh = null;
    }
    if (this.rightPageMesh) {
      this.rightPagePivot.remove(this.rightPageMesh);
      this.rightPageMesh.geometry.dispose();
      this.rightPageMesh = null;
    }
  }

  /**
   * Update how the page stack is split between "already read" (left)
   * and "not yet read" (right), e.g. as the user turns pages.
   * @param {number} ratio - 0 = all pages still on the right (start of book),
   *                         1 = all pages moved to the left (end of book)
   */
  setPageSplit(ratio) {
    this.pageSplit = THREE.MathUtils.clamp(ratio, 0, 1);
    this._buildPageStacks();
  }

  /**
   * Set how open the book is.
   * @param {number} amount - 0 = fully closed (covers flat together),
   *                          1 = fully open (covers flat outward, ~180°
   *                          combined spread, standard "lying open" pose)
   */
  setOpenAmount(amount) {
    this.openAmount = THREE.MathUtils.clamp(amount, 0, 1);
    this._applyOpenAmount();
  }

  _applyOpenAmount() {
    // Closed: both covers rotated flat against the spine (facing each other).
    // Open: covers rotated outward to lie flat, each swinging up to
    // maxOpenAngleDeg (default 178°, i.e. essentially fully flat).
    const maxSwing = THREE.MathUtils.degToRad(this.maxOpenAngleDeg);
    const angle = this.openAmount * maxSwing;

    this.frontCoverPivot.rotation.y = -angle;
    this.backCoverPivot.rotation.y = angle;

    // Page stacks swing slightly less than the covers (90% of the angle)
    // so they sit visually nested inside the covers rather than poking
    // past their edges at the open pose — real page blocks don't swing
    // quite as wide as the stiffer cover boards.
    const pageAngle = angle * 0.9;
    this.leftPagePivot.rotation.y = -pageAngle;
    this.rightPagePivot.rotation.y = pageAngle;
  }

  dispose() {
    this.spineMesh.geometry.dispose();
    this.frontCoverPivot.children.forEach((m) => m.geometry.dispose());
    this.backCoverPivot.children.forEach((m) => m.geometry.dispose());
    this._disposePageStacks();
    // Materials are shared across covers/pages by default — only dispose
    // if you're sure nothing else references coverMaterial/spineMaterial/
    // pageMaterial.
  }
}