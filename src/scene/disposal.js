/**
 * Free everything a loaded model holds on the GPU: every mesh's geometry and
 * material, and every texture those materials point to.
 *
 * TEXTURES ONCE EACH. A model often shares one texture between materials --
 * the tree's four canopies all wear the same leaves -- and freeing it once per
 * material that holds it is harmless but wasteful to reason about, so each is
 * freed the first time it is met. Pass a set in to share that memory across
 * several calls.
 *
 * Not for anything whose textures belong to someone else: a material holding
 * a texture it was HANDED (the wind's noise, the sky) should not be given to
 * this, or it will free what its owner is still using.
 *
 * @param {THREE.Object3D} root
 * @param {Set<THREE.Texture>} [freed]  textures already freed, to skip
 */
export function disposeObject(root, freed = new Set()) {
  root.traverse((child) => {
    if (!child.isMesh) return;
    child.geometry?.dispose();
    for (const material of [].concat(child.material ?? [])) {
      for (const value of Object.values(material)) {
        if (value?.isTexture && !freed.has(value)) {
          freed.add(value);
          value.dispose();
        }
      }
      material.dispose();
    }
  });
}
