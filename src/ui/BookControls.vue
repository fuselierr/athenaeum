<script setup>
import { computed } from 'vue';
import { bookControls } from '../state/bookControls.js';
import { keys, label } from '../state/keybindings.js';

/**
 * What you can do to the book, held over the book itself.
 *
 * OVER IT, NOT IN A CORNER. These are gestures you make ON the book -- drag
 * a page, turn it, push it away -- so the card follows the book around the
 * screen rather than sitting in a panel somewhere you have to look away to
 * read. It hangs just ABOVE the book, because a card covering the pages
 * would hide the very thing it is describing. ui/bookAnchor.js writes the
 * place as CSS custom properties every frame; positioning from them means
 * this component is laid out by the browser and never re-rendered as the
 * book moves.
 *
 * THE KEYS ARE THE READER'S OWN. Turning pages is rebindable
 * (state/keybindings.js, the Settings tab), so the arrows shown here are
 * whatever is actually bound -- a card that confidently said "left / right"
 * to somebody who had moved them would be worse than no card.
 */

const back = computed(() => label(keys['book.pageBack']));
const forward = computed(() => label(keys['book.pageForward']));
</script>

<template>
  <div v-if="bookControls.showing && bookControls.onScreen" class="book-controls" role="note">
    <button class="close" type="button" aria-label="Hide the book controls"
            @click="bookControls.showing = false">
      <svg viewBox="0 0 20 20" width="12" height="12" aria-hidden="true">
        <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
      </svg>
    </button>

    <h2>The book</h2>
    <dl>
      <div class="control">
        <dt><kbd>{{ back }}</kbd> <kbd>{{ forward }}</kbd></dt>
        <dd>Turn the page</dd>
      </div>
      <div class="control">
        <dt><span class="gesture">Drag</span></dt>
        <dd>Turn a page by hand</dd>
      </div>
      <div class="control">
        <dt><span class="gesture">Scroll</span></dt>
        <dd>Bring it nearer, or push it away</dd>
      </div>
      <div class="control">
        <dt><span class="gesture">Right-drag</span></dt>
        <dd>Turn the book over</dd>
      </div>
      <div class="control">
        <dt><kbd>Shift</kbd> <span class="gesture">+ drag</span></dt>
        <dd>Slide it across</dd>
      </div>
    </dl>
  </div>
</template>

<style scoped>
/* Centred on the book and lifted clear of it -- the anchor is the book's own
   place on screen (ui/bookAnchor.js), and the card hangs above it so the
   pages stay visible. Above the room's small labels (2), below the menu's
   scrim (10): opening the menu should cover this like everything else. */
.book-controls {
  position: fixed;
  left: var(--ath-book-x, 50%);
  top: var(--ath-book-y, 50%);
  transform: translate(-50%, -100%) translateY(-24px);
  z-index: 3;
  width: max-content;
  max-width: min(320px, 90vw);
  padding: 12px 14px;
  color: var(--ath-text);
  font: var(--ath-font);
  background: var(--ath-glass-strong);
  backdrop-filter: var(--ath-glass-blur);
  -webkit-backdrop-filter: var(--ath-glass-blur);
  border: 1px solid var(--ath-line);
  border-radius: var(--ath-radius-sm);
  box-shadow: var(--ath-shadow);
  /* It describes the book; it should never be in the way of touching it.
     The close button takes its own pointer events back. */
  pointer-events: none;
}

h2 {
  margin: 0 0 8px;
  color: var(--ath-text-faint);
  font: 500 10px/1 var(--ath-serif);
  letter-spacing: 0.18em;
  text-transform: uppercase;
}

dl {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 6px 12px;
  margin: 0;
}

/* Each row is its own grid item spanning both columns, so the term and its
   description line up in a table without a table's markup. */
.control {
  display: grid;
  grid-column: 1 / -1;
  grid-template-columns: subgrid;
  align-items: baseline;
}

dt {
  display: flex;
  gap: 4px;
  white-space: nowrap;
}

dd {
  margin: 0;
  color: var(--ath-text-dim);
  font-size: 12px;
}

kbd, .gesture {
  display: inline-block;
  padding: 2px 6px;
  color: var(--ath-text-soft);
  font: 11px/1.3 var(--ath-serif);
  white-space: nowrap;
  background: var(--ath-field);
  border: 1px solid var(--ath-line);
  border-radius: 4px;
}

/* The gestures are not keys, so they are not keycaps -- same size, no border,
   so the eye can tell "press this" from "do this". */
.gesture {
  background: none;
  border-color: transparent;
  color: var(--ath-text-faint);
  font-style: italic;
  padding-left: 0;
}

.close {
  position: absolute;
  top: 6px;
  right: 6px;
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  padding: 0;
  color: var(--ath-text-faint);
  background: none;
  border: 0;
  border-radius: 4px;
  cursor: pointer;
  pointer-events: auto;
}

.close:hover { color: var(--ath-text); background: var(--ath-control-hover); }
.close:focus-visible { outline: none; box-shadow: var(--ath-focus); }
</style>
