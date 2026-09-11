<script setup>
import { computed, onBeforeUnmount, ref } from 'vue';
import { settings } from '../../state/settings.js';
import { ACTIONS, bind, keys, label, resetBindings } from '../../state/keybindings.js';
import { ui } from '../../state/ui.js';

/**
 * Audio, controls, and the handful of view settings worth exposing.
 *
 * REBINDING. Clicking a key cap arms a one-shot capture: the very next
 * keydown becomes the binding. Nothing in the room can act on that press,
 * because keybindings.matches refuses everything while the menu is open --
 * which is also why the capture listener can be as blunt as it is.
 */

const groups = computed(() => {
  const byGroup = new Map();
  for (const action of ACTIONS) {
    if (!byGroup.has(action.group)) byGroup.set(action.group, []);
    byGroup.get(action.group).push(action);
  }
  return [...byGroup].map(([name, actions]) => ({ name, actions }));
});

const capturing = ref(null);
let release = null;

function capture(action) {
  stopCapture();
  capturing.value = action.id;
  ui.capturingKey = true; // holds Escape here rather than closing the menu

  release = (event) => {
    event.preventDefault();
    event.stopPropagation();
    // Escape backs out of the capture rather than becoming the binding --
    // it is how you close the menu, and losing that would be a trap.
    if (event.code !== 'Escape') bind(action.id, event.code);
    stopCapture();
  };
  window.addEventListener('keydown', release, { capture: true });
}

function stopCapture() {
  if (release) window.removeEventListener('keydown', release, { capture: true });
  release = null;
  capturing.value = null;
  ui.capturingKey = false;
}

onBeforeUnmount(stopCapture);

const percent = (v) => `${Math.round(v * 100)}%`;
</script>

<template>
  <section class="menu-section">
    <h3>Audio</h3>

    <div class="menu-row">
      <span class="label">Mute everything</span>
      <input type="checkbox" v-model="settings.audio.muted">
    </div>
    <div class="menu-row" :class="{ dimmed: settings.audio.muted }">
      <span class="label">Master</span>
      <input type="range" min="0" max="1" step="0.01" v-model.number="settings.audio.master">
      <span class="value">{{ percent(settings.audio.master) }}</span>
    </div>
    <div class="menu-row" :class="{ dimmed: settings.audio.muted }">
      <span class="label">Ambient</span>
      <input type="range" min="0" max="1" step="0.01" v-model.number="settings.audio.ambient">
      <span class="value">{{ percent(settings.audio.ambient) }}</span>
    </div>
    <div class="menu-row" :class="{ dimmed: settings.audio.muted }">
      <span class="label">Effects</span>
      <input type="range" min="0" max="1" step="0.01" v-model.number="settings.audio.sfx">
      <span class="value">{{ percent(settings.audio.sfx) }}</span>
    </div>
  </section>

  <section class="menu-section">
    <h3>View</h3>

    <div class="menu-row">
      <span class="label">Look sensitivity</span>
      <input type="range" min="0.25" max="3" step="0.05"
             v-model.number="settings.camera.lookSensitivity">
      <span class="value">{{ settings.camera.lookSensitivity.toFixed(2) }}×</span>
    </div>
    <div class="menu-row">
      <span class="label">Invert vertical look</span>
      <input type="checkbox" v-model="settings.camera.invertY">
    </div>
    <div class="menu-row">
      <span class="label">Field of view</span>
      <input type="range" min="35" max="90" step="1" v-model.number="settings.camera.fov">
      <span class="value">{{ settings.camera.fov }}°</span>
    </div>
    <div class="menu-row">
      <span class="label">Shadows</span>
      <input type="checkbox" v-model="settings.graphics.shadows">
    </div>
  </section>

  <section class="menu-section">
    <h3>Controls</h3>

    <div v-for="group in groups" :key="group.name" class="binding-group">
      <h4>{{ group.name }}</h4>
      <div v-for="action in group.actions" :key="action.id" class="menu-row">
        <span class="label">{{ action.label }}</span>
        <button
          type="button"
          class="keycap"
          :class="{ listening: capturing === action.id }"
          @click="capturing === action.id ? stopCapture() : capture(action)"
        >{{ capturing === action.id ? 'press a key…' : label(keys[action.id]) }}</button>
      </div>
    </div>

    <div class="menu-row">
      <span class="label"></span>
      <button class="menu-button" type="button" @click="resetBindings">Reset to defaults</button>
    </div>
    <p class="menu-hint">
      Bindings are physical keys, so they stay where they are on any layout.
      Taking a key that is already in use swaps the two.
    </p>
  </section>
</template>

<style scoped>
.dimmed { opacity: 0.4; }

.binding-group { margin-bottom: 14px; }
.binding-group > h4 {
  margin: 12px 0 2px;
  color: var(--ath-text-dim);
  font-size: 12px;
  font-weight: 500;
}

.keycap {
  min-width: 96px;
  padding: 5px 10px;
  border: 1px solid var(--ath-line-strong);
  border-bottom-width: 2px;
  border-radius: var(--ath-radius-sm);
  background: var(--ath-field);
  color: var(--ath-text);
  font: inherit;
  cursor: pointer;
}
.keycap:hover { background: var(--ath-control-hover); }
/* Listening for a key: purple, the theme's colour for something that is
   still waiting to happen. */
.keycap.listening {
  border-color: var(--ath-purple);
  background: var(--ath-control-active);
  color: #eadcff;
}
</style>