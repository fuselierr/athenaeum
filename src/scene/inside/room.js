import * as THREE from 'three';

/**
 * The room the desk is standing in: four walls, a ceiling, and its windows.
 *
 * BUILT ON THE FLOOR, literally. scene/inside/floor.js already sizes a slab from
 * whatever has to stand on it, and cameraModes walks you around inside that
 * same slab -- so the walls take their footprint from the floor mesh rather
 * than recomputing it. One margin, one footprint, and the walls land
 * exactly on the edge you are already stopped at.
 *
 * SINGLE-SIDED, FACING IN. Every surface here is a plane whose front faces
 * the middle of the room, so from outside the room they are simply not
 * drawn. That is what keeps the orbit camera usable: pull back past a wall
 * and it vanishes rather than filling the screen, without anything having
 * to detect where the camera is.
 *
 * ABOUT THE LIGHT. The EXR environment map lights every surface regardless
 * of what is between it and the sky -- image-based lighting has no notion
 * of occlusion -- so closing the room in does NOT plunge it into darkness.
 * What the walls do change is the backdrop: the sky is now only visible
 * through the window, which is where a scene chosen in the menu shows up.
 * The window's own directional light is the one thing here that is a look
 * decision rather than geometry; see WINDOW_LIGHT_INTENSITY.
 */

const WALL_COLOR = 0x5b5249;
const CEILING_COLOR = 0x6a6159;
const FRAME_COLOR = 0xcfc7b8; // painted, so the sky behind it reads as bright
const GLASS_COLOR = 0xdfeaf5;
const DOOR_COLOR = 0x5a3d28;
const KNOB_COLOR = 0xb8955a;

// The door, in metres.
const DOOR_WIDTH = 0.9;
const DOOR_HEIGHT = 2.05;
const DOOR_THICKNESS = 0.045;
const DOOR_CASING_DEPTH = 0.03; // how far its casing stands proud of the wall

// Window proportions, in metres. The opening is centred on whatever the
// caller passes as `focus` -- the desk -- so it lines up with it rather
// than sitting somewhere arbitrary in the same wall.
const SILL_HEIGHT = 0.85; // above the floor, when the caller has no opinion
const HEAD_CLEARANCE = 0.5; // ceiling down to the top of the opening
const WINDOW_WIDTH_FRACTION = 0.55; // of the wall it is cut into
const MAX_WINDOW_WIDTH = 3.4;

const FRAME_DEPTH = 0.11; // how far the casing stands proud of the wall
const FRAME_WIDTH = 0.075;
const MULLION_WIDTH = 0.045;

/**
 * How far the sill stands out into the room. The deepest thing on the
 * window wall, and therefore the clearance anything standing against that
 * wall needs -- exported because the footprint is the caller's decision
 * and a desk pushed right up to the plaster would have the sill over it.
 */
export const WINDOW_SILL_PROJECTION = FRAME_DEPTH * 1.9;
const PANE_COLUMNS = 3;
const PANE_ROWS = 2;

// A window with no light through it reads as a picture of a window. This
// is a soft, warm key aimed in from outside; set it to 0 for geometry only.
const WINDOW_LIGHT_INTENSITY = 1.1;
const WINDOW_LIGHT_COLOR = 0xfff1d8;

/**
 * @param {THREE.Object3D} scene
 * @param {THREE.Mesh} floor  what addFloor returned. Its world box is the
 *   room's footprint and its top face is where the walls start.
 * @param {object} [opts]
 * @param {number} [opts.height]  floor to ceiling, metres
 * @param {THREE.Vector3} [opts.focus]  what the window is beside, and what
 *   its light aims at. The desk.
 * @param {number} [opts.sill]  height of the window's bottom edge above the
 *   floor. Worth setting whenever something stands in front of it: a desk
 *   pushed up against the wall will otherwise cover the bottom of the
 *   opening, and you end up looking at the sky between its legs.
 * @param {string} [opts.windowSide]  which wall it is cut into: '+x', '-x',
 *   '+z' or '-z'. The scene puts it at '+x': the bookshelf stands at -X, so
 *   that is the wall opposite it, and the one the desk is pushed against.
 * @param {Array<{ side: string, sill?: number, focus?: THREE.Vector3,
 *   width?: number, maxWidth?: number, columns?: number, rows?: number,
 *   light?: number, shadows?: boolean }>|null} [opts.windows]  more than one
 *   window: one entry a wall, the first being the one `window` in the result
 *   refers to. `width` is the fraction of its wall the opening takes, `light`
 *   the brightness of the daylight through it (0 for none), and `shadows`
 *   whether that daylight casts -- worth turning off on a second one, which
 *   would double the shadow map otherwise. Without this, the single window
 *   that `windowSide` and `sill` describe.
 * @param {THREE.Material|null} [opts.ceilingMaterial]  what the ceiling is made
 *   of -- the pine (scene/inside/surfaces.js). Its UVs are in metres too, so
 *   the same material tiles across it at the size it does everywhere else.
 * @param {THREE.Material|null} [opts.wallMaterial]  what the walls are made of
 *   -- the plywood (scene/inside/surfaces.js). Wall UVs are in metres, so its
 *   textures should tile by the metre. Without one, a plain painted colour.
 * @param {{ side: string, along: number }|null} [opts.door]  a door, cut into
 *   wall `side` and centred on the WORLD coordinate `along` that wall (x for
 *   the ±z walls, z for the ±x ones), kept clear of the corners. Not in the
 *   window's wall: the two are not checked against each other.
 * @returns {{ group: THREE.Group, window: object, door: THREE.Group|null,
 *   light: THREE.DirectionalLight|null }}
 */
export function addRoom(scene, floor, {
  height = 3,
  focus = new THREE.Vector3(),
  windowSide = '+z',
  sill = SILL_HEIGHT,
  windows = null,
  door = null,
  wallMaterial: suppliedWallMaterial = null,
  ceilingMaterial: suppliedCeilingMaterial = null,
} = {}) {
  floor.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(floor);
  const size = box.getSize(new THREE.Vector3());
  const middle = box.getCenter(new THREE.Vector3());
  const floorY = box.min.y;

  const group = new THREE.Group();
  group.name = 'room';
  scene.add(group);

  const wallMaterial = suppliedWallMaterial ?? new THREE.MeshStandardMaterial({
    color: WALL_COLOR, roughness: 0.94, metalness: 0, side: THREE.FrontSide,
  });
  const ceilingMaterial = suppliedCeilingMaterial ?? new THREE.MeshStandardMaterial({
    color: CEILING_COLOR, roughness: 0.96, metalness: 0, side: THREE.FrontSide,
  });

  // Each wall is authored in its own XY plane -- x along the wall, y up
  // from the floor, front face +Z -- and then turned to face the middle.
  // `axis` and `sign` record how that local x came out in world terms,
  // which is what lets the window be centred on something in the room.
  const plans = {
    '+x': { at: [box.max.x, middle.z], inward: [-1, 0], span: size.z, axis: 'z', sign: 1 },
    '-x': { at: [box.min.x, middle.z], inward: [1, 0], span: size.z, axis: 'z', sign: -1 },
    '+z': { at: [middle.x, box.max.z], inward: [0, -1], span: size.x, axis: 'x', sign: -1 },
    '-z': { at: [middle.x, box.min.z], inward: [0, 1], span: size.x, axis: 'x', sign: 1 },
  };

  // --- the windows, each in its own wall's coordinates -------------------
  // One unless the caller asked for more; `windows` is the same thing spelled
  // out, and a wall takes at most one of them.
  const asked = windows?.length ? windows : [{ side: windowSide, sill, focus }];
  const openings = {}; // by wall, for cutting the hole in it
  const built = [];
  for (const want of asked) {
    const id = plans[want.side] ? want.side : '+z';
    if (openings[id]) continue;
    const plan = plans[id];
    const width = Math.min(
      want.maxWidth ?? MAX_WINDOW_WIDTH,
      plan.span * (want.width ?? WINDOW_WIDTH_FRACTION),
    );
    const bottom = want.sill ?? sill;
    const head = Math.max(bottom + 0.6, height - HEAD_CLEARANCE);
    const towards = want.focus ?? focus;

    // Centred on what it is beside, but kept clear of the corners -- a window
    // that runs into the return of a wall looks like a mistake, not a window.
    const wallCentre = plan.axis === 'x' ? middle.x : middle.z;
    const limit = Math.max(0, plan.span / 2 - width / 2 - FRAME_WIDTH - 0.25);
    const offset = THREE.MathUtils.clamp(
      plan.sign * (towards[plan.axis] - wallCentre), -limit, limit,
    );
    const opening = { left: offset - width / 2, right: offset + width / 2, sill: bottom, head };

    // The middle of the glass, in WORLD space, for anything outside this file
    // that wants to look out of it. `opening` is in the wall's own
    // coordinates; undoing the offset's sign gives back the world position
    // along the wall, and the plan's `at` supplies the wall's other one.
    const along = wallCentre + plan.sign * offset;
    const centre = new THREE.Vector3(
      plan.axis === 'x' ? along : plan.at[0],
      floorY + (bottom + head) / 2,
      plan.axis === 'z' ? along : plan.at[1],
    );

    openings[id] = opening;
    built.push({
      id,
      plan,
      opening,
      focus: towards,
      columns: want.columns ?? PANE_COLUMNS,
      rows: want.rows ?? PANE_ROWS,
      intensity: want.light ?? WINDOW_LIGHT_INTENSITY,
      shadows: want.shadows ?? true,
      described: { side: id, ...opening, width, centre },
    });
  }

  // --- the door's opening, the same way ---------------------------------
  const doorSide = door && plans[door.side] ? door.side : null;
  let doorOpening = null;
  if (doorSide) {
    const plan = plans[doorSide];
    const centre = plan.axis === 'x' ? middle.x : middle.z;
    const reach = Math.max(0, plan.span / 2 - DOOR_WIDTH / 2 - FRAME_WIDTH - 0.1);
    const at = THREE.MathUtils.clamp(plan.sign * (door.along - centre), -reach, reach);
    doorOpening = {
      left: at - DOOR_WIDTH / 2,
      right: at + DOOR_WIDTH / 2,
      head: Math.min(DOOR_HEIGHT, height - FRAME_WIDTH - 0.1),
    };
  }

  // --- the walls ---------------------------------------------------------
  const walls = {};
  for (const [id, plan] of Object.entries(plans)) {
    const mesh = new THREE.Mesh(
      wallGeometry(
        plan.span,
        height,
        openings[id] ?? null,
        id === doorSide ? doorOpening : null,
      ),
      wallMaterial,
    );
    mesh.name = `wall${id}`;
    mesh.receiveShadow = true;
    mesh.castShadow = false; // it IS the edge of the world; nothing is behind it
    mesh.position.set(plan.at[0], floorY, plan.at[1]);
    // The geometry faces +Z, so aiming that at a point one metre inward
    // turns the wall to face the room -- and because the target is at the
    // same height, the wall stays plumb.
    mesh.lookAt(plan.at[0] + plan.inward[0], floorY, plan.at[1] + plan.inward[1]);
    group.add(mesh);
    walls[id] = mesh;
  }

  // --- the ceiling -------------------------------------------------------
  // Its UVs in metres, like the floor's and the walls', so a tiling material
  // covers it at the same real size rather than being stretched over the room.
  const ceilingGeometry = new THREE.PlaneGeometry(size.x, size.z);
  const ceilingUv = ceilingGeometry.attributes.uv;
  for (let i = 0; i < ceilingUv.count; i++) {
    ceilingUv.setXY(i, ceilingUv.getX(i) * size.x, ceilingUv.getY(i) * size.z);
  }
  const ceiling = new THREE.Mesh(ceilingGeometry, ceilingMaterial);
  ceiling.name = 'ceiling';
  // PlaneGeometry faces +Z; +90 degrees about X turns that to face DOWN,
  // which is the only way a single-sided ceiling is visible from below.
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.set(middle.x, floorY + height, middle.z);
  ceiling.receiveShadow = true;
  ceiling.castShadow = false;
  group.add(ceiling);

  // --- the window ---------------------------------------------------------
  // Built as children of its own wall, so all of it is placed in the wall's
  // local frame -- x along the wall, y up, +z into the room -- and none of
  // it has to know which way that wall ended up facing.
  for (const pane of built) {
    walls[pane.id].add(buildWindowFrame(pane.opening, pane.columns, pane.rows));
  }

  // The door, likewise a child of its wall -- so it goes with the wall when
  // the walls are hidden.
  const doorGroup = doorSide ? buildDoor(doorOpening) : null;
  if (doorGroup) walls[doorSide].add(doorGroup);

  // Before anything asks a wall where it is in the world: three.js only
  // composes matrices during render, so until this runs every wall still
  // reports itself as sitting at the origin, unrotated -- and the window's
  // light would be aimed from there.
  group.updateMatrixWorld(true);

  // Daylight through each of them: the room is lit by what it can see out of.
  const lights = built
    .map((pane) => (pane.intensity > 0
      ? addWindowLight(
        scene, group, walls[pane.id], pane.opening, pane.plan,
        pane.focus, pane.intensity, pane.shadows,
      )
      : null))
    .filter(Boolean);

  return {
    group,
    walls,
    ceiling,
    light: lights[0] ?? null,
    lights,
    window: built[0].described,
    windows: built.map((pane) => pane.described),
    door: doorGroup,

    /**
     * Show or hide the walls and ceiling -- and the window, which is built
     * into its wall and goes with it. The floor is not part of this and
     * stays.
     *
     * Mesh by mesh rather than hiding `group`: the window's daylight lives in
     * the same group, and hiding a light's parent switches the light off, so
     * the room would go dark at exactly the moment it was opened up.
     *
     * Only what is DRAWN changes. The book's physics still stops at the
     * walls (book/placement/bookPlacement.js), and so does walking.
     */
    setWallsVisible(visible) {
      for (const wall of Object.values(walls)) wall.visible = visible;
      ceiling.visible = visible;
    },
  };
}

/**
 * A wall as a flat shape, with the window cut out of it as a hole rather
 * than assembled from four pieces around a gap -- one surface means one
 * plane, and no seam to catch the light along the head of the opening.
 *
 * A door is not a hole: it reaches the floor, and a hole touching the
 * outline does not triangulate. It is a notch in the outline instead.
 */
function wallGeometry(span, height, opening, door = null) {
  const half = span / 2;
  const shape = new THREE.Shape();
  shape.moveTo(-half, 0);
  if (door) {
    shape.lineTo(door.left, 0);
    shape.lineTo(door.left, door.head);
    shape.lineTo(door.right, door.head);
    shape.lineTo(door.right, 0);
  }
  shape.lineTo(half, 0);
  shape.lineTo(half, height);
  shape.lineTo(-half, height);
  shape.closePath();

  if (opening) {
    const hole = new THREE.Path();
    hole.moveTo(opening.left, opening.sill);
    hole.lineTo(opening.left, opening.head);
    hole.lineTo(opening.right, opening.head);
    hole.lineTo(opening.right, opening.sill);
    hole.closePath();
    shape.holes.push(hole);
  }

  return new THREE.ShapeGeometry(shape);
}

/** Casing, sill, glazing bars and a pane of glass, in wall-local space. */
function buildWindowFrame(opening, columns = PANE_COLUMNS, rows = PANE_ROWS) {
  const group = new THREE.Group();
  group.name = 'window';

  const width = opening.right - opening.left;
  const height = opening.head - opening.sill;
  const centreX = (opening.left + opening.right) / 2;
  const centreY = (opening.sill + opening.head) / 2;

  const painted = new THREE.MeshStandardMaterial({
    color: FRAME_COLOR, roughness: 0.55, metalness: 0.02,
  });

  function piece(w, h, d, x, y, z, name) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), painted);
    mesh.name = name;
    mesh.position.set(x, y, z);
    // The casing is the one thing in the room that should cast: bars
    // throwing their shadow across the desk is the whole point of a window.
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  }

  const outerHalf = width / 2 + FRAME_WIDTH / 2;
  piece(width + FRAME_WIDTH * 2, FRAME_WIDTH, FRAME_DEPTH,
    centreX, opening.head + FRAME_WIDTH / 2, FRAME_DEPTH / 2, 'head');
  piece(FRAME_WIDTH, height + FRAME_WIDTH * 2, FRAME_DEPTH,
    centreX - outerHalf, centreY, FRAME_DEPTH / 2, 'jambLeft');
  piece(FRAME_WIDTH, height + FRAME_WIDTH * 2, FRAME_DEPTH,
    centreX + outerHalf, centreY, FRAME_DEPTH / 2, 'jambRight');
  // The sill is deeper than the rest of the casing, the way a real one is.
  piece(width + FRAME_WIDTH * 2, FRAME_WIDTH, WINDOW_SILL_PROJECTION,
    centreX, opening.sill - FRAME_WIDTH / 2, WINDOW_SILL_PROJECTION / 2, 'sill');

  for (let i = 1; i < columns; i++) {
    piece(MULLION_WIDTH, height, MULLION_WIDTH,
      opening.left + (width * i) / columns, centreY, MULLION_WIDTH / 2, `mullion${i}`);
  }
  for (let j = 1; j < rows; j++) {
    piece(width, MULLION_WIDTH, MULLION_WIDTH,
      centreX, opening.sill + (height * j) / rows, MULLION_WIDTH / 2, `transom${j}`);
  }

  // Glass, as a suggestion rather than a simulation: barely opaque, smooth
  // enough to catch the environment. Transmission would be truer and costs
  // a render target per frame for something you look straight through.
  const glass = new THREE.Mesh(
    new THREE.PlaneGeometry(width, height),
    new THREE.MeshStandardMaterial({
      color: GLASS_COLOR,
      roughness: 0.06,
      metalness: 0,
      transparent: true,
      opacity: 0.07,
      side: THREE.DoubleSide,
      depthWrite: false, // or it would occlude the sky it is supposed to show
    }),
  );
  glass.name = 'glass';
  glass.position.set(centreX, centreY, 0.004);
  glass.castShadow = false;
  glass.receiveShadow = false;
  group.add(glass);

  return group;
}

/** A plain door, its casing and a knob, in wall-local space. */
function buildDoor(opening) {
  const group = new THREE.Group();
  group.name = 'door';

  const width = opening.right - opening.left;
  const centreX = (opening.left + opening.right) / 2;

  const casing = new THREE.MeshStandardMaterial({
    color: FRAME_COLOR, roughness: 0.55, metalness: 0.02,
  });
  function piece(w, h, d, x, y, z, material, name) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    mesh.name = name;
    mesh.position.set(x, y, z);
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  }

  // Sitting in the opening, face flush-ish with the wall.
  piece(width, opening.head, DOOR_THICKNESS, centreX, opening.head / 2, -DOOR_THICKNESS / 2 + 0.01,
    new THREE.MeshStandardMaterial({ color: DOOR_COLOR, roughness: 0.7, metalness: 0 }), 'slab');

  const outerHalf = width / 2 + FRAME_WIDTH / 2;
  piece(width + FRAME_WIDTH * 2, FRAME_WIDTH, DOOR_CASING_DEPTH,
    centreX, opening.head + FRAME_WIDTH / 2, DOOR_CASING_DEPTH / 2, casing, 'head');
  piece(FRAME_WIDTH, opening.head, DOOR_CASING_DEPTH,
    centreX - outerHalf, opening.head / 2, DOOR_CASING_DEPTH / 2, casing, 'jambLeft');
  piece(FRAME_WIDTH, opening.head, DOOR_CASING_DEPTH,
    centreX + outerHalf, opening.head / 2, DOOR_CASING_DEPTH / 2, casing, 'jambRight');

  const knob = new THREE.Mesh(
    new THREE.SphereGeometry(0.03, 16, 12),
    new THREE.MeshStandardMaterial({ color: KNOB_COLOR, roughness: 0.3, metalness: 0.8 }),
  );
  knob.name = 'knob';
  knob.position.set(opening.right - 0.08, 1.0, 0.04);
  group.add(knob);

  return group;
}

/**
 * Daylight coming in through the opening.
 *
 * A directional light standing outside the window and aimed at the desk --
 * the sun is far away, so its rays are parallel and one light does the whole
 * room. Its shadow camera is sized to the room rather than left at the
 * default, which would spend its whole depth range on empty air.
 */
function addWindowLight(
  scene, group, wall, opening, plan, focus,
  intensity = WINDOW_LIGHT_INTENSITY, shadows = true,
) {
  const light = new THREE.DirectionalLight(WINDOW_LIGHT_COLOR, intensity);
  light.name = 'daylight';

  const centre = wall.localToWorld(new THREE.Vector3(
    (opening.left + opening.right) / 2, (opening.sill + opening.head) / 2, 0,
  ));
  // Back out through the window, and up: light rakes in and across the room
  // rather than glaring straight at the opposite wall.
  light.position.set(
    centre.x - plan.inward[0] * 3.5,
    centre.y + 2.2,
    centre.z - plan.inward[1] * 3.5,
  );
  light.target.position.copy(focus);
  scene.add(light.target);

  light.castShadow = shadows;
  light.shadow.mapSize.set(2048, 2048);
  const reach = 5;
  light.shadow.camera.left = -reach;
  light.shadow.camera.right = reach;
  light.shadow.camera.top = reach;
  light.shadow.camera.bottom = -reach;
  light.shadow.camera.near = 0.5;
  light.shadow.camera.far = 16;
  // normalBias rather than a flat bias: it scales the offset by how
  // glancing the surface is, which is what stops acne on the walls without
  // lifting the book's shadow off the desk.
  light.shadow.normalBias = 0.02;

  group.add(light);
  return light;
}