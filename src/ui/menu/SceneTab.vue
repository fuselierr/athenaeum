<script setup>
import { ref } from 'vue';
import { settings } from '../../state/settings.js';
import { BACKGROUNDS, DEFAULT_BACKGROUND } from '../../scene/backgrounds.js';

/**
 * Where the reading happens. Backgrounds for now -- furniture, time of day
 * and the rest of a real scene picker can hang off the same list later.
 *
 * Loading is shown per card rather than as a global spinner: these are 4K
 * EXRs and the big ones take a moment, and the useful thing to know is
 * which one you are waiting for.
 */

const props = defineProps({ bridge: { type: Object, required: true } });

const loading = ref(null);
const failed = ref(null);

async function choose(background) {
  if (loading.value) return;
  loading.value = background.id;
  failed.value = null;
  try {
    await props.bridge.setBackground(background.id);
  } catch (err) {
    console.error('Background failed to load:', err);
    failed.value = background.id;
  } finally {
    loading.value = null;
  }
}

function current(id) {
  return (settings.scene.background ?? DEFAULT_BACKGROUND) === id;
}
</script>

<template>
  <section class="menu-section">
    <h3>Background</h3>
    <p class="menu-hint" style="margin-bottom: 12px;">
      The backdrop is also the room's light — every one of these relights
      the desk as well as changing the view.
    </p>

    <ul class="scenes">
      <li v-for="background in BACKGROUNDS" :key="background.id">
        <button
          type="button"
          class="scene"
          :class="{ current: current(background.id), busy: loading === background.id }"
          :disabled="Boolean(loading)"
          @click="choose(background)"
        >
          <span class="scene-name">{{ background.name }}</span>
          <span class="scene-note">{{ background.note }}</span>
          <span class="scene-meta">
            <template v-if="loading === background.id">loading…</template>
            <template v-else-if="failed === background.id">failed</template>
            <template v-else-if="current(background.id)">in use</template>
            <template v-else>{{ background.megabytes }} MB</template>
          </span>
        </button>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.scenes {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.scene {
  display: grid;
  gap: 3px;
  width: 100%;
  padding: 12px 14px;
  border: 1px solid var(--ath-line);
  border-radius: 10px;
  background: var(--ath-control);
  color: var(--ath-text-soft);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background 0.12s ease, border-color 0.12s ease;
}
.scene:hover:not(:disabled) { border-color: var(--ath-line-strong); background: var(--ath-control-hover); }
.scene.current {
  border-color: var(--ath-orange);
  background: linear-gradient(135deg, rgba(255, 155, 80, 0.20), rgba(166, 107, 255, 0.16));
}
.scene:disabled { cursor: default; }
.scene.busy { opacity: 0.8; }

.scene-name { color: var(--ath-text); font-family: var(--ath-serif); font-size: 14px; }
.scene-note { color: var(--ath-text-dim); font-size: 12px; }
.scene-meta { color: var(--ath-text-faint); font-size: 11px; letter-spacing: 0.04em; }
</style>