import * as THREE from 'three';
import { watch } from 'vue';
import { keys, label } from '../../state/keybindings.js';

/**
 * A framed card of instructions, standing on the desk's back-right corner.
 *
 * The desk is pushed against the window wall, which is +X, so someone at it
 * faces +X: the back edge is the desk's +X edge, against the wall, and their
 * right is +Z. That corner is clear -- the lamp stands at the back LEFT and
 * the book in the middle.
 *
 * WHAT IS ON IT. How to use the room with the keyboard and mouse, and where
 * the Escape menu is. Deliberately NOT everything: flipping the book over (F)
 * and the debug keys (the backquote hinge labels, P to pause the physics)
 * are development tools, not things a reader needs to be told about.
 *
 * THE KEYS ARE THE READER'S. Every key can be rebound (Esc -> Settings ->
 * Controls), so the card is lettered from the live bindings rather than the
 * defaults, and relettered whenever one changes. Mouse gestures are fixed,
 * so those are written out as they are.
 *
 * The lettering is drawn onto a canvas that becomes the paper's texture --
 * the same approach as the jacket art and the page numbers, and the same
 * serif, so the card reads as belonging to the same room.
 *
 * PICKING IT UP. Small print on a desk across the room is not readable, so a
 * click brings the card up in front of the camera, where it follows you as
 * you move and look; a second click, or Escape, puts it back. It works the
 * way a book taken off the shelf does (scene/inside/shelfBooks.js): a `hold` that
 * eases between 0 and 1, and a pose blended between where the card rests and
 * where it is held. While it is up it is drawn over everything else, so
 * walking up to a wall or standing behind the lamp never cuts into it.
 */

// --- the frame, in metres ---------------------------------------------------
const PAPER_WIDTH = 0.21; // A4-ish, and 3:4 to match the canvas below
const PAPER_HEIGHT = 0.28;
const FRAME_BORDER = 0.018;
const FRAME_DEPTH = 0.014;
const BACK_INSET = 0.05; // from the desk's back edge to the stand's foot
const SIDE_INSET = 0.07; // from its right edge
const LEAN = 0.2; // radians the frame leans back on its stand
const TURN = 0.3; // radians it is turned in toward the middle of the desk
const STAND_REACH = 0.12; // how far behind the frame the stand's foot lands

// --- held up to read ------------------------------------------------------------
// How much of the view's height the card fills when held. The distance is
// worked out from the field of view each frame, so the card is the same size
// on screen when zoomed in from the middle of the room as it is walking.
const HOLD_FILL = 0.88;
const TAKE_RATE = 7; // 1/s -- wbrisk coming up
const RETURN_RATE = 6; // and a little slower going back
// Held up, the paper glows faintly from its own lettering, so it stays
// readable in whatever corner of the room you happen to be standing in.
const HELD_GLOW = 0.35;

const FRAME_COLOR = 0x4a3222; // walnut
const BACKING_COLOR = 0x2a1d15;

// --- the lettering ------------------------------------------------------------
const CANVAS_WIDTH = 1200;
const CANVAS_HEIGHT = 1600;
const MARGIN = 96;
const KEY_COLUMN = 390; // canvas px for the keys / gesture column

const SERIF = "Georgia, 'Times New Roman', serif";
const SANS = 'system-ui, sans-serif';
const PAPER = '#f3ebdd';
const INK = '#2e2520';
const INK_SOFT = '#6d5c52';
const ACCENT = '#a4522a'; // the room's warm orange, darkened to read as ink on paper
const RULE = 'rgba(120, 90, 60, 0.35)';
const KEYCAP = '#fbf6ee';
const KEYCAP_EDGE = '#c9b8a2';
const KEYCAP_SHADOW = '#b9a58c';

const FOOTER = 'Every key can be changed: Esc → Settings → Controls.';

/** The card's contents, lettered with whatever the keys are bound to right now. */
function sections() {
  const k = (id) => label(keys[id]);
  return [
    {
      title: 'General',
      rows: [
        { keys: [k('menu.toggle')], text: 'Open the menu: chapters, scenes, sound and controls. Also puts back a book you are holding.' },
        { keys: [k('audio.mute')], text: 'Mute' },
        { keys: [k('room.walls')], text: 'Hide or show the walls and ceiling' },
      ],
    },
    {
      title: 'Moving around',
      rows: [
        { keys: [k('camera.orbit'), k('camera.walk'), k('camera.look')], text: 'Orbit the desk · walk · look from the middle' },
        { keys: [k('move.forward'), k('move.left'), k('move.back'), k('move.right')], text: `Walk, hold ${k('move.run')} to run, ${k('move.jump')} to jump, ${k('move.lieDown')} to sit, lie down or stand, outside` },
        { gesture: 'Drag', text: 'Look around' },
        { gesture: 'Scroll', text: 'Zoom in, from the middle of the room' },
      ],
    },
    {
      title: 'The book',
      rows: [
        { gesture: 'Click a shelf book', text: 'Take it down and open it' },
        { gesture: 'Click the book', text: `Bring it up to read. ${k('menu.toggle')} puts it back.` },
        { gesture: 'Click the desk', text: 'Set down the book in your hand' },
        { keys: [k('book.pageBack'), k('book.pageForward')], text: 'Turn the page. A closed book opens first.' },
        { gesture: 'Drag a page', text: 'Turn it by hand' },
        { gesture: 'Drag a cover', text: 'Open or close the book' },
        { gesture: 'Shift + drag', text: 'Slide the book' },
        { gesture: 'Right-drag', text: 'Turn the book in your hands' },
        { gesture: 'Scroll', text: 'Bring the book in your hand closer, or push it away' },
        { keys: [k('book.reset')], text: 'Put it back on the desk. In your hand, square it up again.' },
      ],
    },
  ];
}

// --- canvas helpers -------------------------------------------------------------

function roundedRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Greedy word wrap against the current font. */
function wrap(ctx, text, maxWidth) {
  const lines = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(next).width > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Tracked-out capitals, where the browser supports letterSpacing. */
function spaced(ctx, text, x, y, spacing) {
  const supported = 'letterSpacing' in ctx;
  if (supported) ctx.letterSpacing = `${spacing}px`;
  ctx.fillText(text, x, y);
  if (supported) ctx.letterSpacing = '0px';
}

/** A row's left column: keycaps for keys, an outlined pill for a mouse gesture. */
function drawKeys(ctx, row, x, top, s) {
  const capHeight = 46 * s;
  if (row.gesture) {
    ctx.font = `italic 400 ${27 * s}px ${SERIF}`;
    const width = ctx.measureText(row.gesture).width + 30 * s;
    roundedRect(ctx, x, top, width, capHeight, capHeight / 2);
    ctx.lineWidth = 2 * s;
    ctx.strokeStyle = ACCENT;
    ctx.stroke();
    ctx.fillStyle = ACCENT;
    ctx.textAlign = 'center';
    ctx.fillText(row.gesture, x + width / 2, top + capHeight * 0.68);
    ctx.textAlign = 'left';
    return;
  }

  let cursor = x;
  ctx.font = `600 ${26 * s}px ${SANS}`;
  for (const key of row.keys) {
    const width = Math.max(48 * s, ctx.measureText(key).width + 26 * s);
    // A darker cap offset underneath gives the key its depth.
    roundedRect(ctx, cursor, top + 4 * s, width, capHeight, 8 * s);
    ctx.fillStyle = KEYCAP_SHADOW;
    ctx.fill();
    roundedRect(ctx, cursor, top, width, capHeight, 8 * s);
    ctx.fillStyle = KEYCAP;
    ctx.fill();
    ctx.lineWidth = 2 * s;
    ctx.strokeStyle = KEYCAP_EDGE;
    ctx.stroke();
    ctx.fillStyle = INK;
    ctx.textAlign = 'center';
    ctx.fillText(key, cursor + width / 2, top + capHeight * 0.66);
    ctx.textAlign = 'left';
    cursor += width + 10 * s;
  }
}

/**
 * Letter the whole card at scale `s`. Returns how far down the page it got,
 * so the caller can try a smaller scale if it ran off the bottom -- a longer
 * key name after a rebind must not push the footer off the paper.
 */
function draw(ctx, s) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  ctx.strokeStyle = RULE;
  ctx.lineWidth = 3;
  ctx.strokeRect(40, 40, CANVAS_WIDTH - 80, CANVAS_HEIGHT - 80);

  const textLeft = MARGIN + KEY_COLUMN * s;
  const textWidth = CANVAS_WIDTH - MARGIN - textLeft;
  let y = MARGIN + 40 * s;

  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'center';
  ctx.fillStyle = INK;
  ctx.font = `400 ${76 * s}px ${SERIF}`;
  ctx.fillText('Athenaeum', CANVAS_WIDTH / 2, y + 56 * s);
  y += 104 * s;
  ctx.fillStyle = INK_SOFT;
  ctx.font = `italic 400 ${32 * s}px ${SERIF}`;
  ctx.fillText('How to use the reading room', CANVAS_WIDTH / 2, y);
  y += 40 * s;
  ctx.strokeStyle = RULE;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(MARGIN, y);
  ctx.lineTo(CANVAS_WIDTH - MARGIN, y);
  ctx.stroke();
  y += 64 * s;

  ctx.textAlign = 'left';
  for (const section of sections()) {
    ctx.fillStyle = ACCENT;
    ctx.font = `600 ${27 * s}px ${SERIF}`;
    spaced(ctx, section.title.toUpperCase(), MARGIN, y, 3 * s);
    y += 18 * s;

    for (const row of section.rows) {
      ctx.font = `400 ${31 * s}px ${SERIF}`;
      const lines = wrap(ctx, row.text, textWidth);
      const top = y + 12 * s;
      drawKeys(ctx, row, MARGIN, top, s);
      ctx.font = `400 ${31 * s}px ${SERIF}`;
      ctx.fillStyle = INK;
      lines.forEach((line, i) => ctx.fillText(line, textLeft, top + 33 * s + i * 40 * s));
      y += Math.max(62 * s, lines.length * 40 * s + 22 * s);
    }
    y += 34 * s;
  }

  ctx.textAlign = 'center';
  ctx.fillStyle = INK_SOFT;
  ctx.font = `italic 400 ${27 * s}px ${SERIF}`;
  ctx.fillText(FOOTER, CANVAS_WIDTH / 2, y + 10 * s);
  return y + 10 * s;
}

/** Letter the card at the largest scale that fits it on the paper. */
function letter(ctx) {
  for (let s = 1; s > 0.6; s -= 0.04) {
    if (draw(ctx, s) <= CANVAS_HEIGHT - MARGIN) return;
  }
  draw(ctx, 0.6);
}

// --- the object -------------------------------------------------------------------

/**
 * @param {THREE.Scene} scene
 * @param {{ deskBox: THREE.Box3, renderer: THREE.WebGLRenderer,
 *   camera: THREE.PerspectiveCamera }} opts
 *   deskBox is the desk's world bounds, whose top is the surface the frame
 *   stands on; camera is what the card is held up in front of.
 * @returns {{ group: THREE.Group, held: boolean, handleClick(event: PointerEvent): boolean,
 *   release(): void, update(dt: number): void, dispose(): void }}
 */
export function addInstructionCard(scene, { deskBox, renderer, camera }) {
  const canvas = document.createElement('canvas');
  canvas.width = CANVAS_WIDTH;
  canvas.height = CANVAS_HEIGHT;
  const ctx = canvas.getContext('2d');
  letter(ctx);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  // Read at a slant from across the room: without anisotropic filtering the
  // small print smears into grey long before it gets too small to read.
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();

  const stopWatching = watch(keys, () => {
    letter(ctx);
    texture.needsUpdate = true;
  }, { deep: true });

  // Built with its origin at the middle of the frame's bottom edge, facing
  // +Z, so that leaning it back and standing it on the desk are one rotation
  // and one position.
  const group = new THREE.Group();
  group.name = 'instructionCard';

  const outerWidth = PAPER_WIDTH + FRAME_BORDER * 2;
  const outerHeight = PAPER_HEIGHT + FRAME_BORDER * 2;
  const halfDepth = FRAME_DEPTH / 2;

  const frameMaterial = new THREE.MeshStandardMaterial({ color: FRAME_COLOR, roughness: 0.55, metalness: 0 });
  const backingMaterial = new THREE.MeshStandardMaterial({ color: BACKING_COLOR, roughness: 0.9, metalness: 0 });
  const paperMaterial = new THREE.MeshStandardMaterial({
    map: texture,
    roughness: 0.92,
    metalness: 0,
    // Lit by its own lettering, but not until it is held up: the intensity is
    // 0 at rest and rises with `hold` (see update). Set here rather than when
    // first held so the material is compiled once, not rebuilt mid-motion.
    emissive: 0xffffff,
    emissiveMap: texture,
    emissiveIntensity: 0,
  });

  const meshes = [];
  const add = (geometry, material, x, y, z) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    meshes.push(mesh);
    return mesh;
  };

  // The four sides of the frame.
  add(new THREE.BoxGeometry(outerWidth, FRAME_BORDER, FRAME_DEPTH), frameMaterial, 0, FRAME_BORDER / 2, 0);
  add(new THREE.BoxGeometry(outerWidth, FRAME_BORDER, FRAME_DEPTH), frameMaterial, 0, outerHeight - FRAME_BORDER / 2, 0);
  add(new THREE.BoxGeometry(FRAME_BORDER, PAPER_HEIGHT, FRAME_DEPTH), frameMaterial, -(PAPER_WIDTH + FRAME_BORDER) / 2, outerHeight / 2, 0);
  add(new THREE.BoxGeometry(FRAME_BORDER, PAPER_HEIGHT, FRAME_DEPTH), frameMaterial, (PAPER_WIDTH + FRAME_BORDER) / 2, outerHeight / 2, 0);

  // Backing board at the back of the frame, and the paper a millimetre in
  // front of it -- recessed inside the frame, as a card sits under its rebate.
  const backingThickness = 0.004;
  add(new THREE.BoxGeometry(PAPER_WIDTH, PAPER_HEIGHT, backingThickness), backingMaterial, 0, outerHeight / 2, -halfDepth + backingThickness / 2);
  add(new THREE.PlaneGeometry(PAPER_WIDTH, PAPER_HEIGHT), paperMaterial, 0, outerHeight / 2, -halfDepth + backingThickness + 0.001);

  // The stand. Hinged on the back of the frame and reaching down to the desk
  // behind it. Its foot is placed where the desk actually is once the frame
  // has leaned back by LEAN -- the desk plane, seen from the frame's own
  // leaned coordinates, is the point STAND_REACH behind the frame's foot
  // rotated back by LEAN -- so the stand lands on the desk rather than
  // floating above it or sinking into it.
  const hinge = new THREE.Vector3(0, outerHeight * 0.55, -halfDepth);
  const foot = new THREE.Vector3(0, STAND_REACH * Math.sin(LEAN), -STAND_REACH * Math.cos(LEAN));
  const strut = foot.clone().sub(hinge);
  const stand = add(
    new THREE.BoxGeometry(0.03, strut.length(), 0.005),
    frameMaterial,
    0, (hinge.y + foot.y) / 2, (hinge.z + foot.z) / 2,
  );
  // The box's length runs along its own Y; turn that onto the strut.
  stand.rotation.x = Math.atan2(strut.z, strut.y);

  // Draw order within the card, for when it is held up and drawn without a
  // depth test (see setOnTop): stand first, then the backing, the paper, and
  // the frame last, so each part covers only what really is behind it.
  for (const mesh of meshes) {
    if (mesh.material === backingMaterial) mesh.renderOrder = 10;
    else if (mesh.material === paperMaterial) mesh.renderOrder = 12;
    else mesh.renderOrder = 13;
  }
  stand.renderOrder = 9;

  // Lean back, then face the room: local +Z (the paper's face) turned to -X,
  // toward whoever is at the desk, and a little in toward its middle -- which,
  // from the right-hand corner, is -Z.
  // 'YXZ' so the lean happens in the frame's own frame before it is turned.
  group.rotation.set(-LEAN, -Math.PI / 2 - TURN, 0, 'YXZ');
  group.position.set(
    // Placed by the stand's foot, not the frame's front edge: the stand is
    // the part furthest back, and measuring from the frame would leave it
    // hanging off the back of the desk. Its reach along X is shortened by
    // the turn toward the middle.
    deskBox.max.x - BACK_INSET - STAND_REACH * Math.cos(TURN),
    // Leaning back tips the frame's back bottom edge down by this much;
    // lifted by exactly that, it rests on the desk instead of in it.
    deskBox.max.y + halfDepth * Math.sin(LEAN),
    deskBox.max.z - SIDE_INSET - outerWidth / 2,
  );
  scene.add(group);

  // --- held up to read ----------------------------------------------------------
  // Where it rests on the desk, recorded once it has been placed there.
  const restPosition = group.position.clone();
  const restQuaternion = group.quaternion.clone();

  let held = false;
  let hold = 0; // 0 on the desk, 1 in front of the camera, in between on the way
  let onTop = false;

  const _handPosition = new THREE.Vector3();
  const _handQuaternion = new THREE.Quaternion();
  const _raycaster = new THREE.Raycaster();
  const _ndc = new THREE.Vector2();

  /** Where the card is held: centred in front of the camera, facing it. */
  function readHandPose() {
    // Matrices are composed at render; the camera has moved since.
    camera.updateMatrixWorld();
    const distance = outerHeight / (HOLD_FILL * 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    // The card's origin is the middle of its bottom edge, so it is dropped by
    // half its height to sit centred in the view.
    _handPosition.set(0, -outerHeight / 2, -distance).applyMatrix4(camera.matrixWorld);
    // Facing the camera is the camera's own orientation: the paper faces the
    // card's +Z, and the camera looks down its -Z.
    camera.getWorldQuaternion(_handQuaternion);
  }

  /** Drawn over everything while it is up, and like anything else at rest. */
  function setOnTop(on) {
    if (on === onTop) return;
    onTop = on;
    for (const material of [frameMaterial, backingMaterial, paperMaterial]) material.depthTest = !on;
  }

  /** Is an object actually on screen -- itself and every parent visible? */
  function shown(object) {
    for (let o = object; o; o = o.parent) if (!o.visible) return false;
    return true;
  }

  return {
    group,

    get held() { return held; },

    /**
     * A click in the room. Returns true if it was the card's.
     *
     * While the card is up, EVERY click is its: clicking again is how it goes
     * back, and a click that was meant for that must not also take a book off
     * the shelf or set one down on the desk behind it.
     *
     * At rest it only takes a click that lands on it -- and it has to be the
     * nearest visible thing under the cursor, so clicking a book or the lamp
     * in front of the card does not pick the card up through it.
     */
    handleClick(event) {
      if (held) {
        held = false;
        return true;
      }
      const rect = renderer.domElement.getBoundingClientRect();
      _ndc.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      _raycaster.setFromCamera(_ndc, camera);
      // Raycasting ignores `visible`, so hidden things (the walls, when they
      // are switched off) are skipped here rather than allowed to block.
      const nearest = _raycaster.intersectObject(scene, true).find((hit) => shown(hit.object));
      if (!nearest || !meshes.includes(nearest.object)) return false;
      held = true;
      return true;
    },

    /** Put it back on the desk -- what Escape does. */
    release() {
      held = false;
    },

    /** Call every frame, after the camera has moved. */
    update(dt) {
      if (!held && hold === 0) return; // resting on the desk
      const target = held ? 1 : 0;
      hold = THREE.MathUtils.damp(hold, target, held ? TAKE_RATE : RETURN_RATE, dt);
      if (Math.abs(hold - target) < 0.002) hold = target;

      const eased = hold * hold * (3 - 2 * hold); // smoothstep: lifts, travels, settles
      readHandPose();
      group.position.lerpVectors(restPosition, _handPosition, eased);
      group.quaternion.slerpQuaternions(restQuaternion, _handQuaternion, eased);
      paperMaterial.emissiveIntensity = HELD_GLOW * eased;
      // On top for the whole trip, not just once it arrives: on its way it
      // passes through the desk, the lamp, whatever is between.
      setOnTop(hold > 0);
    },

    dispose() {
      stopWatching();
      scene.remove(group);
      for (const mesh of meshes) mesh.geometry.dispose();
      frameMaterial.dispose();
      backingMaterial.dispose();
      paperMaterial.dispose();
      texture.dispose();
    },
  };
}