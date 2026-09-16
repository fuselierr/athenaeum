import * as THREE from 'three';

/**
 * The carpentry the room is built from: boxes, with their UVs laid out in
 * METRES rather than nought-to-one a face.
 *
 * WHY THAT MATTERS. A box's UVs run 0..1 across each side whatever size the
 * side is, so one wood texture on a deck and on a baluster would come out with
 * grain a metre wide on one and a centimetre wide on the other. Measuring the
 * UVs in metres instead makes the grain the same real size on every piece --
 * and it is what the room's own surfaces already do (scene/inside/floor.js,
 * and the walls through ShapeGeometry), so one material tiles correctly across
 * the floor, the walls, the balcony and the shelves alike
 * (scene/inside/surfaces.js).
 */

/** A box with its middle at a point, ready to be merged into a bigger piece. */
export function box(width, height, depth, x, y, z) {
  const geometry = new THREE.BoxGeometry(width, height, depth);
  const uv = geometry.attributes.uv;
  // BoxGeometry lays its sides out in a fixed order -- +X, -X, +Y, -Y, +Z, -Z,
  // four vertices each -- and each side's UVs run across it in its own two
  // dimensions. These are what those two are, per side, in metres.
  const sides = [
    [depth, height], [depth, height],
    [width, depth], [width, depth],
    [width, height], [width, height],
  ];
  for (let side = 0; side < sides.length; side++) {
    const [across, down] = sides[side];
    for (let i = side * 4; i < side * 4 + 4; i++) {
      uv.setXY(i, uv.getX(i) * across, uv.getY(i) * down);
    }
  }
  geometry.translate(x, y, z);
  return geometry;
}

/** A flat rectangle lying in the XZ plane, its UVs in metres as well. */
export function slab(minX, maxX, minZ, maxZ, y) {
  const width = maxX - minX;
  const depth = maxZ - minZ;
  const geometry = new THREE.PlaneGeometry(width, depth);
  geometry.rotateX(-Math.PI / 2);
  const uv = geometry.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * width, uv.getY(i) * depth);
  geometry.translate((minX + maxX) / 2, y, (minZ + maxZ) / 2);
  return geometry;
}
