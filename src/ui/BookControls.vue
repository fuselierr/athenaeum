<script setup>
import { computed } from 'vue';
import { bookControls } from '../state/bookControls.js';
import { keys, label } from '../state/keybindings.js';

/**
 * What you can do to the book: the screen dimmed, and the controls listed in
 * the middle of it. A click anywhere -- or Escape, or the book button in the
 * corner again -- puts it away.
 *
 * THE KEYS ARE THE READER'S OWN. Turning pages is rebindable
 * (state/keybindings.js, the Settings tab), so the keys shown here are
 * whatever is actually bound -- a card that confidently said "left / right"
 * to somebody who had moved them would be worse than no card.
 */

const back = computed(() => label(keys['book.pageBack']));
const forward = computed(() => label(keys['book.pageForward']));
</script>

<template>
  <transition name="controls-fade">
    <div v-if="bookControls.showing" class="book-controls" role="dialog"
         aria-label="Book controls" @click="bookControls.showing = false">
      <dl>
        <div class="control">
          <dt><kbd>{{ back }}</kbd><kbd>{{ forward }}</kbd></dt>
          <dd>Turn the page</dd>
        </div>
        <div class="control">
          <dt>Drag</dt>
          <dd>Turn a page by hand</dd>
        </div>
        <div class="control">
          <dt>Scroll</dt>
          <dd>Bring it nearer, or push it away</dd>
        </div>
        <div class="control">
          <dt>Right-drag</dt>
          <dd>Turn the book over</dd>
        </div>
        <div class="control">
          <dt><kbd>Shift</kbd>+ drag</dt>
          <dd>Slide it across</dd>
        </div>
        <div class="control">
          <dt><kbd>Q</kbd></dt>
          <dd>Drop the book</dd>
        </div>
        <div class="control">
          <dt>Left-click</dt>
          <dd>Pick it up</dd>
        </div>
      </dl>
    </div>
  </transition>
</template>

<style scoped>
/* The whole screen, dimmed, under the corner's controls (11) so the book
   button that opened this can close it again -- like the menu's scrim. */
.book-controls {
  position: fixed;
  inset: 0;
  z-index: 10;
  display: grid;
  place-items: center;
  padding: 24px;
  color: var(--ath-text);
  font: var(--ath-font);
  background: rgba(8, 4, 10, 0.62);
  cursor: default;
}

/* Two columns meeting in the middle: what you do, right-aligned, and what it
   does, left-aligned. */
dl {
  display: grid;
  grid-template-columns: auto auto;
  gap: 14px 22px;
  margin: 0;
}

.control {
  display: grid;
  grid-column: 1 / -1;
  grid-template-columns: subgrid;
  align-items: baseline;
}

dt {
  display: flex;
  justify-content: flex-end;
  align-items: baseline;
  gap: 6px;
  color: var(--ath-text-dim);
  font: italic 300 14px/1.3 var(--ath-serif);
  white-space: nowrap;
}

dd {
  margin: 0;
  font: 300 16px/1.3 var(--ath-serif);
  letter-spacing: 0.03em;
}

/* A key is outlined, a gesture is not -- "press this" and "do this" told
   apart by the eye. */
kbd {
  min-width: 1.6em;
  padding: 1px 7px;
  color: var(--ath-text);
  font: 400 12px/1.4 var(--ath-serif);
  font-style: normal;
  text-align: center;
  border: 1px solid rgba(255, 255, 255, 0.35);
  border-radius: 4px;
}

.controls-fade-enter-active,
.controls-fade-leave-active { transition: opacity 0.3s ease; }
.controls-fade-enter-from,
.controls-fade-leave-to { opacity: 0; }

@media (prefers-reduced-motion: reduce) {
  .controls-fade-enter-active,
  .controls-fade-leave-active { transition: opacity 0.15s ease; }
}
</style>
