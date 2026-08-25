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
    coverThickness = 0.004,
    spineWidth = 0.03,
    coverMaterial,
    spineMaterial,
    maxOpenAngleDeg = 178,
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

    this._buildSpine();
    this._buildCover(this.frontCoverPivot, +1, 'frontCover');
    this._buildCover(this.backCoverPivot, -1, 'backCover');

    this.root.add(this.spineMesh, this.frontCoverPivot, this.backCoverPivot);

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
      depth: this.coverThickness * 2 + 0.01, // spine slightly proud of cover thickness
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
  }

  dispose() {
    this.spineMesh.geometry.dispose();
    this.frontCoverPivot.children.forEach((m) => m.geometry.dispose());
    this.backCoverPivot.children.forEach((m) => m.geometry.dispose());
    // Materials are shared across covers by default — only dispose if
    // you're sure nothing else references coverMaterial/spineMaterial.
  }
}