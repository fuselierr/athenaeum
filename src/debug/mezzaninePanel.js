import { MEZZANINE } from '../scene/inside/mezzanine.js';

/**
 * Mezzanine controls, for the debug overlay (the ` key): the deck, the
 * flight, the rails, the balusters, the strings under them and the posts --
 * every value in scene/inside/mezzanine.js's MEZZANINE.
 *
 * Only indoors, and only while the rest of the debug overlay is showing. The
 * mezzanine is geometry built once, not uniforms, so a change builds it again:
 * `rebuild` on every step of a drag (it is a few hundred boxes -- cheap), and
 * `settle` once when the slider is let go, for what is too dear to redo on
 * every step (the foliage grown along the rails, the room's light).
 *
 * BUILT ON. The deck's height and thickness and how far the upper storey steps
 * out are what the room's walls, the shelves on and under the deck and the
 * books filed on them are made to -- nothing short of building the whole room
 * again would follow them. So those sliders only mark a change as pending,
 * and "Apply & reload" saves every value to this browser and loads the page
 * again, where they are read before anything is built (the top of this
 * module, which main.js imports before it builds the room). "Reset" forgets
 * what was saved.
 *
 * Built the first time it is needed and kept: the mezzanine outlives trips
 * outside, and so do these values.
 */

const STORAGE_KEY = 'athenaeum:debug:mezzanine';
// Values the room is built to: they take a reload.
const BUILT_ON = new Set([
  'deckThickness', 'headRoom', 'overShelf', 'overDoor', 'minRise', 'upperGrowX', 'upperGrowZ',
]);

// What the code says, before anything saved is laid over it.
const DEFAULTS = { ...MEZZANINE };

// Laid over now, at import -- before main.js builds the room with them.
let saved = null;
try {
  saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
} catch {
  saved = null;
}
if (saved && typeof saved === 'object') {
  for (const [key, value] of Object.entries(saved)) {
    if (key in MEZZANINE && typeof value === 'number' && Number.isFinite(value)) MEZZANINE[key] = value;
  }
} else {
  saved = null;
}

/**
 * @param {object} opts
 * @param {() => void} opts.rebuild  build the mezzanine again from MEZZANINE
 * @param {() => void} opts.settle  and whatever hangs off it, once a drag ends
 * @param {{ values: object, apply: () => void, settle: () => void }} [opts.daylight]
 *   the room's daylight (scene/inside/roomDaylight.js's ROOM_DAYLIGHT), tuned
 *   live in a section of its own: `apply` on every step, `settle` once let go
 */
export function createMezzaninePanel({ rebuild, settle, daylight = null }) {
  const daylightDefaults = daylight ? { ...daylight.values } : null;
  let el = null;

  function build() {
    el = document.createElement('div');
    Object.assign(el.style, {
      position: 'fixed',
      top: '96px',
      left: '12px',
      zIndex: '10000',
      width: '260px',
      maxHeight: 'calc(100vh - 150px)',
      overflowY: 'auto',
      font: '12px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      color: '#e8e8e8',
      background: 'rgba(12, 14, 20, 0.86)',
      padding: '8px 10px',
      borderRadius: '6px',
      border: '1px solid rgba(255, 255, 255, 0.14)',
      boxShadow: '0 2px 12px rgba(0, 0, 0, 0.5)',
      display: 'none',
    });
    document.body.appendChild(el);

    const refreshers = [];
    // Built-on values dragged but not yet applied.
    const pending = {};

    function button(label, onClick) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      Object.assign(b.style, {
        width: '100%', padding: '5px 8px', margin: '0 0 4px', font: 'inherit', cursor: 'pointer',
        color: '#ffd9a8', background: 'rgba(255, 170, 110, 0.12)',
        border: '1px solid rgba(255, 170, 110, 0.45)', borderRadius: '4px',
      });
      b.addEventListener('click', onClick);
      el.append(b);
      return b;
    }

    const applyButton = button('Apply & reload', () => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...MEZZANINE, ...pending }));
      } catch (err) {
        console.warn('Could not save the mezzanine values:', err);
        return;
      }
      window.location.reload();
    });
    const showPending = () => {
      const count = Object.keys(pending).length;
      applyButton.textContent = count
        ? `Apply & reload (${count} deck change${count === 1 ? '' : 's'})`
        : 'Apply & reload';
      applyButton.style.background = count ? 'rgba(255, 170, 110, 0.35)' : 'rgba(255, 170, 110, 0.12)';
    };

    button('Reset mezzanine', () => {
      try { localStorage.removeItem(STORAGE_KEY); } catch { /* nothing saved to forget */ }
      // A room built to other deck values has to be built again.
      if ([...BUILT_ON].some((key) => MEZZANINE[key] !== DEFAULTS[key])) {
        window.location.reload();
        return;
      }
      for (const key of Object.keys(pending)) delete pending[key];
      Object.assign(MEZZANINE, DEFAULTS);
      if (daylight) {
        Object.assign(daylight.values, daylightDefaults);
        daylight.apply();
      }
      for (const refresh of refreshers) refresh();
      showPending();
      rebuild();
      settle();
    });

    if (saved) {
      const note = document.createElement('div');
      note.textContent = 'Saved values in use.';
      note.style.color = '#9fd0ff';
      el.append(note);
    }

    let into = el;

    /** A heading that folds; everything declared after it goes inside it. */
    function section(title) {
      const folder = document.createElement('details');
      folder.style.margin = '6px 0 0';
      const head = document.createElement('summary');
      Object.assign(head.style, {
        margin: '4px 0', padding: '2px 0', cursor: 'pointer',
        fontWeight: 'bold', color: '#ffd9a8',
      });
      head.textContent = title;
      const body = document.createElement('div');
      body.style.padding = '2px 0 6px 6px';
      body.style.borderLeft = '1px solid rgba(255, 255, 255, 0.10)';
      body.style.marginLeft = '3px';
      folder.append(head, body);
      el.append(folder);
      into = body;
    }

    /**
     * A slider for one of MEZZANINE's values: live, or -- for a BUILT_ON
     * value -- pending until applied.
     */
    function slider(label, key, { min, max, step }) {
      const later = BUILT_ON.has(key);
      const row = document.createElement('label');
      Object.assign(row.style, {
        display: 'grid', gridTemplateColumns: '1fr auto', rowGap: '2px', margin: '4px 0',
      });
      const name = document.createElement('span');
      name.textContent = label;
      const value = document.createElement('span');
      value.style.color = '#9fd0ff';
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);
      input.style.gridColumn = '1 / span 2';
      input.style.width = '100%';
      const decimals = Math.max(0, -Math.floor(Math.log10(step)));
      const current = () => (key in pending ? pending[key] : MEZZANINE[key]);
      const show = () => {
        value.textContent = Number(current()).toFixed(decimals) + (key in pending ? ' *' : '');
      };
      const refresh = () => { input.value = String(current()); show(); };
      refresh();
      refreshers.push(refresh);
      input.addEventListener('input', () => {
        const v = Number(input.value);
        if (later) {
          if (v === MEZZANINE[key]) delete pending[key];
          else pending[key] = v;
          showPending();
        } else {
          MEZZANINE[key] = v;
          rebuild();
        }
        show();
      });
      if (!later) input.addEventListener('change', () => settle());
      row.append(name, value, input);
      into.append(row);
    }

    section('Deck: built on (apply & reload)');
    slider('Thickness (m)', 'deckThickness', { min: 0.08, max: 0.3, step: 0.005 });
    slider('Head room under ceiling (m)', 'headRoom', { min: 1.9, max: 3, step: 0.05 });
    slider('Above the bookshelf (m)', 'overShelf', { min: 0, max: 1.2, step: 0.05 });
    slider('Above the door (m)', 'overDoor', { min: 0, max: 0.6, step: 0.01 });
    slider('Lowest rise (m)', 'minRise', { min: 1.8, max: 3.5, step: 0.05 });
    slider('Upper storey out +X (m)', 'upperGrowX', { min: 0, max: 3, step: 0.05 });
    slider('Upper storey out +Z (m)', 'upperGrowZ', { min: 0, max: 3, step: 0.05 });

    section('Deck: arms and flight');
    slider('Long arm depth (m)', 'longArmDepth', { min: 1.2, max: 4, step: 0.05 });
    slider('Door arm depth (m)', 'doorArmDepth', { min: 0.8, max: 3, step: 0.05 });
    slider('Flight off shelf wall (m)', 'wallGap', { min: 0, max: 0.3, step: 0.01 });
    slider('Flight off back wall (m)', 'backGap', { min: 0, max: 0.5, step: 0.01 });
    slider('Clear floor at foot (m)', 'footClearance', { min: 0.4, max: 2.5, step: 0.05 });
    slider('Stair radius, least (m)', 'stairRadiusMin', { min: 1, max: 3.5, step: 0.05 });
    slider('Stair radius, most (m)', 'stairRadiusMax', { min: 1.5, max: 4.5, step: 0.05 });

    section('Stair');
    slider('Width (m)', 'stairWidth', { min: 0.7, max: 1.6, step: 0.01 });
    slider('Tread run (m)', 'treadRun', { min: 0.2, max: 0.45, step: 0.005 });
    slider('Step rise, aimed for (m)', 'stepRise', { min: 0.14, max: 0.24, step: 0.005 });
    slider('Tread thickness (m)', 'treadThickness', { min: 0.02, max: 0.16, step: 0.005 });

    section('Rails');
    slider('Height (m)', 'railHeight', { min: 0.7, max: 1.3, step: 0.01 });
    slider('Radius (m)', 'railRadius', { min: 0.015, max: 0.06, step: 0.001 });
    slider('Inset from edge (m)', 'railInset', { min: 0.02, max: 0.15, step: 0.005 });

    section('Balusters');
    slider('Width (m)', 'balusterWidth', { min: 0.02, max: 0.12, step: 0.002 });
    slider('Spacing (m)', 'balusterGap', { min: 0.08, max: 0.4, step: 0.005 });
    slider('Lowered by (m)', 'balusterDrop', { min: 0, max: 0.1, step: 0.005 });
    slider('Turning starts (share)', 'turnedFrom', { min: 0, max: 0.45, step: 0.01 });
    slider('Turning ends (share)', 'turnedTo', { min: 0.55, max: 1, step: 0.01 });

    section('Stair strings');
    slider('Depth (m)', 'stringDepth', { min: 0.06, max: 0.35, step: 0.005 });
    slider('Past the treads (m)', 'stringOverhang', { min: 0, max: 0.06, step: 0.001 });
    slider('Over the treads (m)', 'stringLip', { min: 0, max: 0.05, step: 0.001 });

    section('Posts');
    slider('Spacing (m)', 'postSpacing', { min: 0.8, max: 4, step: 0.05 });
    slider('Size (m)', 'postSize', { min: 0.06, max: 0.3, step: 0.005 });

    if (daylight) {
      section('Daylight');
      const { values } = daylight;
      liveSlider('Sun through the glass', values, 'sun', { min: 0, max: 8, step: 0.05 });
      liveSlider('Sky light per window row', values, 'sky', { min: 0, max: 5, step: 0.05 });
      colour('Sky, clear', values, 'skyColour');
      colour('Sky, overcast', values, 'overcastColour');
      // The beams and the dust are drawn over the room, not part of what
      // lights it: nothing to take again when these are let go.
      const drawnOver = { relight: false };
      liveSlider('Sunbeam strength', values, 'beamStrength', { min: 0, max: 0.03, step: 0.0005 }, drawnOver);
      liveSlider('Sunbeam glow toward sun', values, 'beamForward', { min: 0, max: 0.9, step: 0.01 }, drawnOver);
      liveSlider('Dust brightness', values, 'dustBrightness', { min: 0, max: 1, step: 0.01 }, drawnOver);
      liveSlider('Dust speck size (m)', values, 'dustSize', { min: 0.0005, max: 0.01, step: 0.0005 }, drawnOver);
    }

    /**
     * A slider for a daylight value: applied as it moves, no rebuild -- and,
     * unless `relight` is false, the room's light taken again once let go.
     */
    function liveSlider(label, target, key, { min, max, step }, { relight = true } = {}) {
      const row = document.createElement('label');
      Object.assign(row.style, {
        display: 'grid', gridTemplateColumns: '1fr auto', rowGap: '2px', margin: '4px 0',
      });
      const name = document.createElement('span');
      name.textContent = label;
      const value = document.createElement('span');
      value.style.color = '#9fd0ff';
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);
      input.style.gridColumn = '1 / span 2';
      input.style.width = '100%';
      const decimals = Math.max(0, -Math.floor(Math.log10(step)));
      const refresh = () => {
        input.value = String(target[key]);
        value.textContent = Number(target[key]).toFixed(decimals);
      };
      refresh();
      refreshers.push(refresh);
      input.addEventListener('input', () => {
        target[key] = Number(input.value);
        value.textContent = Number(input.value).toFixed(decimals);
        daylight.apply();
      });
      if (relight) input.addEventListener('change', () => daylight.settle());
      row.append(name, value, input);
      into.append(row);
    }

    /** A colour picker for a daylight colour, kept as a hex number. */
    function colour(label, target, key) {
      const row = document.createElement('label');
      Object.assign(row.style, {
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '4px 0',
      });
      const name = document.createElement('span');
      name.textContent = label;
      const input = document.createElement('input');
      input.type = 'color';
      Object.assign(input.style, {
        width: '44px', height: '20px', padding: '0', border: '0', background: 'none', cursor: 'pointer',
      });
      const refresh = () => { input.value = `#${target[key].toString(16).padStart(6, '0')}`; };
      refresh();
      refreshers.push(refresh);
      input.addEventListener('input', () => {
        target[key] = parseInt(input.value.slice(1), 16);
        daylight.apply();
      });
      input.addEventListener('change', () => daylight.settle());
      row.append(name, input);
      into.append(row);
    }
  }

  return {
    /** Call every frame with whether the room's debug overlay is up. */
    update(show) {
      if (show && !el) build();
      if (el) el.style.display = show ? 'block' : 'none';
    },
  };
}
