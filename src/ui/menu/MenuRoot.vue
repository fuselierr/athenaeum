<script setup>
import { computed } from 'vue';
import { ui } from '../../state/ui.js';
import BookTab from './BookTab.vue';
import SceneTab from './SceneTab.vue';
import SettingsTab from './SettingsTab.vue';
import CommunityTab from './CommunityTab.vue';
import { book } from '../../state/book.js';

/**
 * The menu.
 *
 * TAB ORDER is the order you reach for them: Book is what you are doing,
 * Scene is where you are doing it, Settings is how, and Community is who
 * with -- reading-first, configuration second.
 *
 * The panel is a plain overlay, so the canvas underneath keeps rendering
 * and the room stays live behind it. Nothing here reaches into the scene;
 * everything goes through the stores and the bridge (see ui/mountMenu.js).
 */

const props = defineProps({
  bridge: { type: Object, required: true },
});

const TABS = [
  { id: 'book', label: 'Book' },
  { id: 'scene', label: 'Scene' },
  { id: 'settings', label: 'Settings' },
  { id: 'community', label: 'Community' },
];

const view = computed(() => ({
  book: BookTab, scene: SceneTab, settings: SettingsTab, community: CommunityTab,
}[ui.tab] ?? BookTab));

const subtitle = computed(() => {
  if (ui.tab !== 'book') return '';
  return book.title ? `${book.title}${book.author ? ` — ${book.author}` : ''}` : 'Nothing open';
});
</script>

<template>
  <transition name="menu-fade">
    <div v-if="ui.menuOpen" class="menu-scrim" @pointerdown.self="ui.menuOpen = false">
      <section class="menu" role="dialog" aria-label="Athenaeum menu">
        <header class="menu-head">
          <nav class="menu-tabs">
            <button
              v-for="tab in TABS"
              :key="tab.id"
              class="menu-tab"
              :class="{ active: ui.tab === tab.id }"
              type="button"
              @click="ui.tab = tab.id"
            >{{ tab.label }}</button>
          </nav>
          <button class="menu-close" type="button" title="Close (Esc)" @click="ui.menuOpen = false">
            ×
          </button>
        </header>

        <p v-if="subtitle" class="menu-subtitle">{{ subtitle }}</p>

        <div class="menu-body">
          <component :is="view" :bridge="props.bridge" />
        </div>
      </section>
    </div>
  </transition>
</template>

<style>
/* Not scoped: the tabs share these, and duplicating a form control's look
   in four files is how four files drift apart. Colours come from the theme
   variables in src/ui/theme.css. */
.menu-scrim {
  position: fixed;
  inset: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: center;
  /* Light, and unblurred: the panel is the glass, and the room around it
     should still read rather than disappear under a curtain. */
  background: var(--ath-scrim);
  font: var(--ath-font);
  color: var(--ath-text);
}

.menu {
  display: flex;
  flex-direction: column;
  width: min(720px, 92vw);
  height: min(560px, 86vh);
  /* A warm sheen over the glass -- orange from the top left, purple toward
     the bottom right -- faint enough to stay a tint. */
  background:
    linear-gradient(155deg, rgba(255, 155, 80, 0.10), rgba(166, 107, 255, 0.08) 65%, transparent),
    var(--ath-glass-strong);
  backdrop-filter: var(--ath-glass-blur);
  -webkit-backdrop-filter: var(--ath-glass-blur);
  border: 1px solid var(--ath-line);
  border-radius: var(--ath-radius);
  box-shadow: var(--ath-shadow), inset 0 1px 0 rgba(255, 236, 222, 0.07);
  overflow: hidden;
  transition: transform 0.18s ease;
}

.menu-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 10px 0 14px;
  border-bottom: 1px solid var(--ath-line);
}

.menu-tabs { display: flex; gap: 2px; flex: 1; }

.menu-tab {
  position: relative;
  padding: 9px 14px;
  border: 0;
  background: none;
  color: var(--ath-text-dim);
  font: inherit;
  cursor: pointer;
  border-radius: var(--ath-radius-sm) var(--ath-radius-sm) 0 0;
}
.menu-tab:hover { color: var(--ath-text); background: var(--ath-control); }
.menu-tab.active { color: var(--ath-text); }
/* The one place the full orange-to-purple runs in the menu: under the tab
   you are on. */
.menu-tab.active::after {
  content: '';
  position: absolute;
  left: 10px;
  right: 10px;
  bottom: -1px;
  height: 2px;
  border-radius: 2px;
  background: var(--ath-accent-gradient);
}

.menu-close {
  align-self: start;
  width: 28px; height: 28px;
  border: 0; border-radius: var(--ath-radius-sm);
  background: none; color: var(--ath-text-dim);
  font-size: 20px; line-height: 1; cursor: pointer;
}
.menu-close:hover { background: var(--ath-control-hover); color: var(--ath-text); }

.menu-subtitle {
  margin: 10px 18px -4px;
  color: var(--ath-text-dim);
  font-family: var(--ath-serif);
  font-style: italic;
  font-size: 13px;
}

.menu-body {
  flex: 1;
  overflow-y: auto;
  padding: 16px 18px 22px;
  scrollbar-color: rgba(255, 170, 110, 0.35) transparent;
}

/* --- shared furniture for the tabs ------------------------------------ */
.menu-section { margin-bottom: 26px; }
.menu-section > h3 {
  margin: 0 0 10px;
  font-family: var(--ath-serif);
  font-size: 12px;
  font-weight: 400;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--ath-orange-soft);
}

.menu-row {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 34px;
  padding: 3px 0;
}
.menu-row > .label { flex: 1; }
.menu-row .value {
  min-width: 46px;
  text-align: right;
  color: var(--ath-text-dim);
  font-variant-numeric: tabular-nums;
}

.menu input[type='range'] { width: 220px; accent-color: var(--ath-orange); }
.menu input[type='number'] {
  width: 74px; padding: 5px 7px;
  background: var(--ath-field); color: var(--ath-text);
  border: 1px solid var(--ath-line); border-radius: var(--ath-radius-sm);
  font: inherit;
}
.menu input[type='number']:focus { border-color: var(--ath-orange); }
.menu input[type='checkbox'] { width: 15px; height: 15px; accent-color: var(--ath-orange); }

.menu-button {
  padding: 6px 12px;
  background: var(--ath-control); color: var(--ath-text);
  border: 1px solid var(--ath-line-strong); border-radius: var(--ath-radius-sm);
  font: inherit; cursor: pointer;
  transition: background 0.12s ease, border-color 0.12s ease;
}
.menu-button:hover:not(:disabled) { background: var(--ath-control-hover); border-color: var(--ath-orange); }
.menu-button:disabled { opacity: 0.45; cursor: default; }

/* Keyboard focus anywhere in the menu: a warm ring, not the browser's blue
   one -- which would be the one cold thing left on screen. */
.menu :focus-visible { outline: none; box-shadow: var(--ath-focus); }

.menu-hint { margin: 0; color: var(--ath-text-dim); font-size: 12px; }
.menu-empty {
  display: grid;
  place-content: center;
  gap: 6px;
  height: 100%;
  text-align: center;
  color: var(--ath-text-dim);
}
.menu-empty strong {
  color: var(--ath-text);
  font-family: var(--ath-serif);
  font-size: 16px;
  font-weight: 400;
}

.menu-fade-enter-active, .menu-fade-leave-active { transition: opacity 0.16s ease; }
.menu-fade-enter-from, .menu-fade-leave-to { opacity: 0; }
/* The panel rises a little into place as it fades in. */
.menu-fade-enter-from .menu, .menu-fade-leave-to .menu { transform: translateY(8px) scale(0.99); }
</style>