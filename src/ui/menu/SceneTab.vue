<script setup>
import { ref } from 'vue';
import { settings } from '../../state/settings.js';
import { ui } from '../../state/ui.js';
import { world } from '../../state/world.js';
import { BACKGROUNDS, DEFAULT_BACKGROUND } from '../../scene/backgrounds.js';

/**
 * Where the reading happens: in the room or outside, and the room's
 * backdrop.
 *
 * Going somewhere closes the menu -- the point is to look at where you went.
 * The backdrops are only offered in the room: each one is the room's light as
 * well as its view, and outside the sky is both.
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

function go(place) {
  if (world.place === place || world.place === 'loading') return;
  ui.menuOpen = false;
  if (place === 'outside') props.bridge.goOutside();
  else props.bridge.goInside();
}
</script>

<template>
  <section class="menu-section">
    <h3>Where</h3>
    <ul class="scenes">
      <li>
        <button
          type="button"
          class="scene"
          :class="{ current: world.place === 'room' }"
          :disabled="world.place !== 'outside'"
          @click="go('room')"
        >
          <span class="scene-name">The room</span>
          <span class="scene-note">The desk, the lamp and the shelf of books.</span>
          <span class="scene-meta">{{ world.place === 'room' ? 'you are here' : 'go back inside' }}</span>
        </button>
      </li>
      <li>
        <button
          type="button"
          class="scene"
          :class="{ current: world.place === 'outside', busy: world.place === 'loading' }"
          :disabled="world.place !== 'room'"
          @click="go('outside')"
        >
          <span class="scene-name">Outside</span>
          <span class="scene-note">Through the door: mountains, grass and open sky.</span>
          <span class="scene-meta">
            <template v-if="world.place === 'loading'">loading…</template>
            <template v-else-if="world.place === 'outside'">you are here</template>
            <template v-else>go outside</template>
          </span>
        </button>
      </li>
    </ul>
  </section>

  <section class="menu-section">
    <h3>Background</h3>
    <p class="menu-hint" style="margin-bottom: 12px;">
      <template v-if="world.place === 'room'">
        The backdrop is also the room's light — every one of these relights
        the desk as well as changing the view.
      </template>
      <template v-else>
        Backdrops light the room. Outside, the sky does that — go back inside
        to change them.
      </template>
    </p>

    <ul class="scenes">
      <li v-for="background in BACKGROUNDS" :key="background.id">
        <button
          type="button"
          class="scene"
          :class="{ current: current(background.id), busy: loading === background.id }"
          :disabled="Boolean(loading) || world.place !== 'room'"
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