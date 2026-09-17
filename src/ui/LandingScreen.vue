<script setup>
import { computed, ref } from 'vue';
import { landing } from '../state/landing.js';
import { book } from '../state/book.js';

/**
 * The welcome page: what someone who is not signed in sees when they arrive.
 *
 * Bring a book and start reading. Choosing an EPUB here converts it and
 * takes you straight outside with it in your hand -- no account, nothing
 * kept. main.js decides when this is up (it is the first thing a signed-out
 * visitor sees, before the loading screen lifts) and does the opening; this
 * only asks for the file, through the bridge, the way the menu does.
 *
 * THE CORNER STAYS ABOVE THIS on purpose. Signing in is how a returning
 * reader gets their own shelf back, and the control that does it is already
 * in the top right (ui/AccountButton.vue) -- so this page sits UNDER it
 * rather than covering it and reinventing the same two buttons.
 */

const props = defineProps({ bridge: { type: Object, required: true } });
const input = ref(null);

// While a book is opening, the loader's own progress is the status line.
const busy = computed(() => book.loading);

function choose() {
  if (busy.value) return;
  input.value?.click();
}

function picked(event) {
  const file = event.target.files?.[0];
  // Cleared straight away, so picking the same file again still fires a
  // change -- after a failure, that is exactly what someone will try.
  event.target.value = '';
  if (file) props.bridge.startWithBook(file);
}
</script>

<template>
  <div v-if="landing.showing" class="landing">
    <div class="card">
      <img class="icon" src="/appicon.png" alt="">
      <h1>Welcome to Athenaeum</h1>
      <p class="blurb">
        A reading room you can walk around in. Bring an EPUB and it opens in your
        hands, out on the hillside.
      </p>

      <button class="start" type="button" :disabled="busy" @click="choose">
        {{ busy ? 'Opening…' : 'Upload EPUB' }}
      </button>
      <input
        ref="input"
        type="file"
        accept=".epub,application/epub+zip"
        hidden
        @change="picked"
      >

      <p v-if="busy && book.status" class="status" role="status" aria-live="polite">
        {{ book.status }}
      </p>
      <p v-else-if="landing.error" class="error" role="alert">{{ landing.error }}</p>
      <p v-else class="hint">Signed in, your own shelf is waiting instead.</p>
    </div>
  </div>
</template>

<style scoped>
/* Over the room and the small labels (2), under the menu's scrim (10) and
   the corner (11) -- so the account control stays reachable above it. */
.landing {
  position: fixed;
  inset: 0;
  z-index: 9;
  display: grid;
  place-items: center;
  padding: 24px;
  background:
    radial-gradient(120% 90% at 25% 15%, rgba(255, 155, 80, 0.10), transparent 60%),
    radial-gradient(110% 90% at 85% 95%, rgba(166, 107, 255, 0.14), transparent 60%),
    rgba(26, 9, 28, 0.72);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  color: var(--ath-text);
  font: var(--ath-font);
}

.card {
  display: grid;
  justify-items: center;
  gap: 16px;
  width: min(420px, 100%);
  padding: 32px 28px;
  text-align: center;
  background: var(--ath-glass-strong);
  backdrop-filter: var(--ath-glass-blur);
  -webkit-backdrop-filter: var(--ath-glass-blur);
  border: 1px solid var(--ath-line);
  border-radius: var(--ath-radius);
  box-shadow: var(--ath-shadow);
}

.icon {
  width: 64px;
  height: 64px;
  border-radius: 16px;
  box-shadow: 0 12px 40px rgba(20, 4, 18, 0.5);
}

h1 {
  margin: 0;
  font: 400 26px/1.3 var(--ath-serif);
  letter-spacing: 0.04em;
}

.blurb {
  margin: 0;
  max-width: 32ch;
  color: var(--ath-text-dim);
  font-size: 13px;
}

/* The one thing to do here, so it wears the full accent rather than the
   quiet control grey the menu's buttons use. */
.start {
  margin-top: 4px;
  padding: 11px 26px;
  color: #2a0f22;
  font: 500 14px/1 var(--ath-serif);
  letter-spacing: 0.02em;
  background: var(--ath-accent-gradient);
  border: 0;
  border-radius: 999px;
  cursor: pointer;
  transition: transform 0.15s ease, filter 0.15s ease;
}

.start:hover:not(:disabled) { filter: brightness(1.08); transform: translateY(-1px); }
.start:focus-visible { outline: none; box-shadow: var(--ath-focus); }
.start:disabled { cursor: default; filter: saturate(0.5) brightness(0.85); }

.status, .hint, .error {
  margin: 0;
  min-height: 1.5em;
  font-size: 12px;
}

.status { color: var(--ath-text-soft); }
.hint { color: var(--ath-text-faint); }
.error { color: var(--ath-danger); }

@media (prefers-reduced-motion: reduce) {
  .start { transition: none; }
  .start:hover:not(:disabled) { transform: none; }
}
</style>
