<script setup>
import { ref } from 'vue';
import { book } from '../../state/book.js';

/**
 * Open an EPUB from your own computer.
 *
 * This used to be a panel pinned to the corner of the room. It lives in the
 * Book tab now, beside everything else about what you are reading. The file
 * goes out through the bridge -- the menu never touches the loader or the
 * scene itself (see ui/mountMenu.js).
 */

const props = defineProps({ bridge: { type: Object, required: true } });
const input = ref(null);

function choose() {
  input.value?.click();
}

function picked(event) {
  const file = event.target.files?.[0];
  // Cleared straight away, so picking the same file a second time still
  // fires a change.
  event.target.value = '';
  if (file) props.bridge.uploadBook(file);
}
</script>

<template>
  <section class="menu-section">
    <h3>Open a file</h3>
    <div class="menu-row">
      <span class="label">Convert an EPUB from your computer and open it on the desk.</span>
      <button class="menu-button" type="button" :disabled="book.loading" @click="choose">
        Choose EPUB…
      </button>
      <input
        ref="input"
        type="file"
        accept=".epub,application/epub+zip"
        hidden
        @change="picked"
      >
    </div>
    <p v-if="book.status" class="menu-hint">{{ book.status }}</p>
  </section>
</template>