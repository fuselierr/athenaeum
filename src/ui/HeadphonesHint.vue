<script setup>
import { onBeforeUnmount, ref, watch } from 'vue';
import { ui } from '../state/ui.js';

/**
 * "Headphones are recommended" -- the screen dimmed and the one line said,
 * for a few seconds as someone arrives in a scene, and then gone.
 *
 * WHEN is main.js's to decide (recommendHeadphones): every arrival for a
 * visitor who is not signed in, once ever for a reader who is. This only
 * shows it while ui.headphonesHint says so, and takes it down again itself.
 *
 * It waits for the loading screen to have faded, so it lands on the scene
 * rather than on the cover lifting off it, and goes by itself. A click
 * anywhere takes it down early.
 */

// Milliseconds: how long after being asked for it appears -- the loading
// screen's fade -- and how long it then stays.
const APPEAR_AFTER = 700;
const SHOW_FOR = 3500;

const visible = ref(false);
let appearTimer = null;
let hideTimer = null;

function clearTimers() {
  clearTimeout(appearTimer);
  clearTimeout(hideTimer);
}

function dismiss() {
  clearTimers();
  visible.value = false;
  ui.headphonesHint = false;
}

watch(() => ui.headphonesHint, (wanted) => {
  clearTimers();
  if (!wanted) {
    visible.value = false;
    return;
  }
  appearTimer = setTimeout(() => {
    visible.value = true;
    hideTimer = setTimeout(dismiss, SHOW_FOR);
  }, APPEAR_AFTER);
}, { immediate: true });

onBeforeUnmount(clearTimers);
</script>

<template>
  <transition name="hint-fade">
    <div v-if="visible" class="headphones-hint" role="status" aria-live="polite" @click="dismiss">
      <svg class="hint-icon" viewBox="0 0 24 24" width="36" height="36" aria-hidden="true"
           fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
        <path d="M4 15v-3a8 8 0 0 1 16 0v3" />
        <path d="M4 15.5A1.5 1.5 0 0 1 5.5 14H7v6H5.5A1.5 1.5 0 0 1 4 18.5Z" />
        <path d="M20 15.5a1.5 1.5 0 0 0-1.5-1.5H17v6h1.5a1.5 1.5 0 0 0 1.5-1.5Z" />
      </svg>
      <p>Headphones are recommended</p>
    </div>
  </transition>
</template>

<style scoped>
/* The whole screen, dimmed, and the line in the middle of it. Under the
   corner's controls (11), like the menu's scrim. */
.headphones-hint {
  position: fixed;
  inset: 0;
  z-index: 10;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  padding: 24px;
  color: var(--ath-text);
  background: rgba(8, 4, 10, 0.62);
  cursor: default;
}

.hint-icon { opacity: 0.85; }

p {
  margin: 0;
  font: 300 20px/1.3 var(--ath-serif);
  letter-spacing: 0.08em;
  text-align: center;
}

.hint-fade-enter-active,
.hint-fade-leave-active { transition: opacity 0.6s ease; }
.hint-fade-enter-from,
.hint-fade-leave-to { opacity: 0; }

@media (prefers-reduced-motion: reduce) {
  .hint-fade-enter-active,
  .hint-fade-leave-active { transition: opacity 0.2s ease; }
}
</style>
