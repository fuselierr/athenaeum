import * as THREE from 'three';

/**
 * Shadows for surfaces seen from either side.
 *
 * To stop shadow acne, three.js looks a surface up in the shadow map from a
 * point pushed a little way off it along its normal (a light's
 * shadow.normalBias -- the window's daylight uses 2 cm, scene/inside/room.js). But
 * it pushes along the GEOMETRIC normal, the one the triangles were wound
 * with, and on a DoubleSide material that is only the side you are looking
 * at half the time. On the other half the point is pushed through to the
 * far side instead -- into the book, on a page -- where whatever is behind
 * it (the rest of the block) is in the way, so the surface reads as
 * shadowed even in full light.
 *
 * That is why B and C lit differently: A and B reach toward -Z from their
 * hinge, so what you see of them is their geometric BACK
 * (PageSimulation.SLOT_ON_MINUS_Z), and their lookups went down into the
 * page block while C's and D's came up out of it.
 *
 * The fix pushes toward the viewer instead: the side you see is, by
 * definition, the one facing the camera. The side facing away from the
 * camera is never drawn, so nothing is lost by getting it wrong. Only the
 * shadow LOOKUP moves -- the shading normal, and what the surface casts,
 * are untouched.
 */

// three's own shadow chunk, reading the flipped normal instead of the raw
// one. If a future three.js reworded that line the replace finds nothing,
// and the materials are left as they were rather than broken.
const FACING_SHADOW_VERTEX = THREE.ShaderChunk.shadowmap_vertex.replace(
  'transformNormalByInverseViewMatrix( transformedNormal, viewMatrix )',
  'transformNormalByInverseViewMatrix( shadowFacingNormal, viewMatrix )',
);
const PATCHABLE = FACING_SHADOW_VERTEX !== THREE.ShaderChunk.shadowmap_vertex;

// One shared function, not one per material: three keys its program cache
// on onBeforeCompile's source text, so every material given this shares a
// program with every other that matches it otherwise.
function faceShadowLookupTowardViewer(shader) {
  shader.vertexShader = shader.vertexShader.replace('#include <shadowmap_vertex>', `
    #ifdef HAS_NORMAL
      // View space: the camera is at the origin, looking down -Z.
      vec3 shadowFacingNormal = transformedNormal;
      vec3 toViewer = isOrthographic ? vec3( 0.0, 0.0, 1.0 ) : - mvPosition.xyz;
      if ( dot( shadowFacingNormal, toViewer ) < 0.0 ) shadowFacingNormal = - shadowFacingNormal;
    #endif
    ${FACING_SHADOW_VERTEX}
  `);
}

/**
 * Give a DoubleSide material shadow lookups from the side being looked at.
 * Returns the material. Not carried over by material.clone() -- apply it to
 * each clone.
 */
export function twoSidedShadows(material) {
  if (PATCHABLE) material.onBeforeCompile = faceShadowLookupTowardViewer;
  return material;
}