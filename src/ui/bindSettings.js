import { watch } from 'vue';
import { settings } from '../state/settings.js';
import { backgroundUrl, DEFAULT_BACKGROUND, findBackground } from '../scene/backgrounds.js';

/**
 * The one place a setting becomes an effect.
 *
 * state/settings.js holds values and nothing else; the menu writes to it
 * and never touches the scene. This is the other half: a watcher per
 * setting, applying it to whatever actually owns that behaviour. Keeping
 * the crossing in one file means there is a single answer to "what does
 * this slider do", and the menu stays testable without a renderer.
 *
 * Every watcher runs once immediately, so a value restored from storage is
 * applied on load rather than only when it next changes.
 *
 * @param {object} parts  the pieces of the room a setting can reach:
 *   audio, camera, renderer, scene, environment.
 * @returns {{ setBackground(id: string): Promise<void> }}  the one setting
 *   that cannot be fire-and-forget: the Scene tab needs to know when a
 *   background has actually finished loading.
 */
export function bindSettings({ audio, camera, renderer, scene, environment }) {
  // --- audio --------------------------------------------------------------
  watch(() => ({ ...settings.audio }), (a) => {
    audio.setMuted(a.muted);
    audio.setVolumes({ master: a.master, ambient: a.ambient, sfx: a.sfx });
  }, { immediate: true });

  // --- camera -------------------------------------------------------------
  watch(() => settings.camera.fov, (fov) => {
    camera.fov = fov;
    camera.updateProjectionMatrix();
  }, { immediate: true });

  // --- graphics -----------------------------------------------------------
  watch(() => settings.graphics.shadows, (on) => {
    renderer.shadowMap.enabled = on;
    // Shadow support is compiled INTO each material, so a material built
    // while shadows were off keeps its shadow-free program until it is
    // told to rebuild. A full traverse is fine for something toggled by
    // hand once in a while.
    scene.traverse((object) => {
      if (!object.isMesh) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) if (material) material.needsUpdate = true;
    });
  }, { immediate: true });

  // --- the backdrop -------------------------------------------------------
  // Awaited rather than watched-and-forgotten: these are 4K EXRs, the tab
  // shows which one is loading, and two overlapping loads would race to set
  // scene.environment.
  async function setBackground(id) {
    const background = findBackground(id);
    await environment.set(backgroundUrl(background));
    settings.scene.background = background.id;
  }

  return { setBackground, initialBackground: settings.scene.background ?? DEFAULT_BACKGROUND };
}