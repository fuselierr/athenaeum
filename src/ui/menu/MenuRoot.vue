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
   in four files is how four files drift apart. */
.menu-scrim {
  position: fixed;
  inset: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(8, 10, 14, 0.55);
  backdrop-filter: blur(2px);
  font: 13px/1.5 system-ui, sans-serif;
  color: #cfd6e4;
}

.menu {
  display: flex;
  flex-direction: column;
  width: min(720px, 92vw);
  height: min(560px, 86vh);
  background: rgba(18, 21, 28, 0.96);
  border: 1px solid #2c3444;
  border-radius: 12px;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.5);
  overflow: hidden;
}

.menu-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 10px 0 14px;
  border-bottom: 1px solid #232b38;
}

.menu-tabs { display: flex; gap: 2px; flex: 1; }

.menu-tab {
  padding: 8px 14px;
  border: 0;
  border-bottom: 2px solid transparent;
  background: none;
  color: #8d97a9;
  font: inherit;
  cursor: pointer;
  border-radius: 6px 6px 0 0;
}
.menu-tab:hover { color: #cfd6e4; background: rgba(255, 255, 255, 0.03); }
.menu-tab.active { color: #fff; border-bottom-color: #6f8cff; }

.menu-close {
  align-self: start;
  width: 28px; height: 28px;
  border: 0; border-radius: 6px;
  background: none; color: #8d97a9;
  font-size: 20px; line-height: 1; cursor: pointer;
}
.menu-close:hover { background: rgba(255, 255, 255, 0.06); color: #fff; }

.menu-subtitle {
  margin: 10px 18px -4px;
  color: #7f89a0;
  font-size: 12px;
}

.menu-body { flex: 1; overflow-y: auto; padding: 16px 18px 22px; }

/* --- shared furniture for the tabs ------------------------------------ */
.menu-section { margin-bottom: 26px; }
.menu-section > h3 {
  margin: 0 0 10px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: #6f7a8e;
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
  color: #8d97a9;
  font-variant-numeric: tabular-nums;
}

.menu input[type='range'] { width: 220px; accent-color: #6f8cff; }
.menu input[type='number'] {
  width: 74px; padding: 5px 7px;
  background: #10141c; color: #e7ecf5;
  border: 1px solid #2c3444; border-radius: 6px;
  font: inherit;
}
.menu input[type='checkbox'] { width: 15px; height: 15px; accent-color: #6f8cff; }

.menu-button {
  padding: 6px 12px;
  background: #303a4e; color: #e7ecf5;
  border: 1px solid #3d4a63; border-radius: 6px;
  font: inherit; cursor: pointer;
}
.menu-button:hover:not(:disabled) { background: #3b4761; }
.menu-button:disabled { opacity: 0.45; cursor: default; }

.menu-hint { margin: 0; color: #6f7a8e; font-size: 12px; }
.menu-empty {
  display: grid;
  place-content: center;
  gap: 6px;
  height: 100%;
  text-align: center;
  color: #6f7a8e;
}

.menu-fade-enter-active, .menu-fade-leave-active { transition: opacity 0.14s ease; }
.menu-fade-enter-from, .menu-fade-leave-to { opacity: 0; }
</style>