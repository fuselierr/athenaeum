import * as THREE from 'three';
import { CLOUD_SHADOWS } from '../scene/outside/cloudShadows.js';

/**
 * Outdoor lighting controls, for the debug overlay (the ` key).
 *
 * Only there outside, and only while the rest of the debug overlay is
 * showing: a checkbox to switch each effect on and off, and sliders for the
 * settings behind it -- the grass, the terrain's tiling tricks, the clouds, the sky atmosphere, the
 * sun, the sky light, height fog, exposure, color grading and tone mapping. Everything changes live except the sky
 * light, which is a capture of the sky: it is taken again when a slider that
 * changes the sky is let go, not on every step of the drag. A button at the
 * top puts every control back to what it was when the panel was built --
 * the values the outdoor scene starts with.
 *
 * EVERY SECTION FOLDS. There are well over a hundred controls here and the
 * panel is taller than the window; each heading is a <details> that opens on
 * a click, so the list of headings fits on screen and you open the one you
 * are working on. They all start shut, and which are open is not remembered:
 * the panel is rebuilt from scratch on every trip outside.
 *
 * Built the first time it is needed on each trip outside, from whatever
 * scene/outside/outdoorLight.js and scene/outside/outdoorPost.js hand back. The outdoors is
 * unloaded when you go in and rebuilt when you come out, so a panel from an
 * earlier trip would be steering objects that no longer exist: it is thrown
 * away and built again for the new ones.
 * Unlike the angle readout it takes the pointer -- it is for dragging -- and
 * the key bindings already ignore keys typed into its inputs.
 */

/**
 * @param {object} opts
 * @param {() => ({ outside: boolean, daylight: object, post: object }|null)} opts.getOutside
 * @param {THREE.WebGLRenderer} opts.renderer
 * @param {THREE.Scene} opts.scene
 */
export function createOutdoorPanel({ getOutside, renderer, scene }) {
  let el = null;
  let builtFor = null; // the post chain the current panel controls

  function build(daylight, post, terrain, grass, range, tree, leaves) {
    el = document.createElement('div');
    Object.assign(el.style, {
      position: 'fixed',
      top: '96px',
      left: '12px',
      zIndex: '10000',
      width: '280px',
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

    // Each control records how to put itself back. Sliders first and switches
    // after, so a switch turned back on picks up its setting already restored
    // (the sky light's level, say).
    const sliderResets = [];
    const toggleResets = [];

    const resetButton = document.createElement('button');
    resetButton.type = 'button';
    resetButton.textContent = 'Reset to defaults';
    Object.assign(resetButton.style, {
      width: '100%', padding: '5px 8px', font: 'inherit', cursor: 'pointer',
      color: '#ffd9a8', background: 'rgba(255, 170, 110, 0.12)',
      border: '1px solid rgba(255, 170, 110, 0.45)', borderRadius: '4px',
    });
    resetButton.addEventListener('click', () => {
      for (const reset of sliderResets) reset();
      for (const reset of toggleResets) reset();
      // Once, at the end, rather than per slider: the sky may have changed.
      daylight.captureSkyLight();
    });
    el.append(resetButton);

    // Where the controls being declared right now go: the panel itself until
    // the first section opens a folder, and that folder's body after.
    let into = el;

    /**
     * A heading that folds, with an on/off checkbox when `toggle` is given.
     * Everything declared after it goes inside it, until the next one.
     */
    function section(title, toggle) {
      const folder = document.createElement('details');
      folder.style.margin = '6px 0 0';

      const head = document.createElement('summary');
      Object.assign(head.style, {
        display: 'flex', alignItems: 'center', gap: '6px',
        margin: '4px 0', padding: '2px 0', cursor: 'pointer',
        fontWeight: 'bold', color: '#ffd9a8', listStyle: 'revert',
      });

      if (toggle) {
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = toggle.get();
        // The box is inside the summary, so a click on it would fold the
        // section as well as switching the thing off.
        box.addEventListener('click', (e) => e.stopPropagation());
        box.addEventListener('change', () => toggle.set(box.checked));
        head.append(box);
        const initial = box.checked;
        toggleResets.push(() => {
          toggle.set(initial);
          box.checked = initial;
        });
      }
      head.append(title);

      const body = document.createElement('div');
      body.style.padding = '2px 0 6px 6px';
      body.style.borderLeft = '1px solid rgba(255, 255, 255, 0.10)';
      body.style.marginLeft = '3px';

      folder.append(head, body);
      el.append(folder);
      into = body;
    }

    /**
     * A slider. `set` runs on every step of the drag; `settle`, if given,
     * once when it is let go.
     */
    function slider(label, { min, max, step, get, set, settle }) {
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
      input.value = String(get());
      input.style.gridColumn = '1 / span 2';
      input.style.width = '100%';
      const decimals = Math.max(0, -Math.floor(Math.log10(step)));
      const show = () => { value.textContent = Number(input.value).toFixed(decimals); };
      show();
      input.addEventListener('input', () => { set(Number(input.value)); show(); });
      if (settle) input.addEventListener('change', () => settle());
      const initial = get();
      sliderResets.push(() => {
        set(initial);
        input.value = String(initial);
        show();
      });
      row.append(name, value, input);
      into.append(row);
    }

    /** A colour picker for a THREE.Color -- the original's GUI has these. */
    function colour(label, { get }) {
      const row = document.createElement('label');
      Object.assign(row.style, {
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '4px 0',
      });
      const name = document.createElement('span');
      name.textContent = label;
      const input = document.createElement('input');
      input.type = 'color';
      input.value = `#${get().getHexString()}`;
      Object.assign(input.style, {
        width: '44px', height: '20px', padding: '0', border: '0', background: 'none', cursor: 'pointer',
      });
      input.addEventListener('input', () => get().set(input.value));
      const initial = get().getHex();
      sliderResets.push(() => {
        get().setHex(initial);
        input.value = `#${get().getHexString()}`;
      });
      row.append(name, input);
      into.append(row);
    }

    // --- grass --------------------------------------------------------------------
    const blades = grass.uniforms;
    section(`Grass (${grass.chunkCount} chunks of ${grass.bladesPerChunk.toLocaleString()})`, {
      get: () => grass.group.visible,
      set: (on) => { grass.group.visible = on; },
    });
    slider('Shine (specular kept)', {
      min: 0, max: 1, step: 0.01,
      get: () => blades.grassSheen.value,
      set: (v) => { blades.grassSheen.value = v; },
    });
    // --- the wind -----------------------------------------------------------------
    // The noise field the meadow AND the tree lean in (scene/outside/wind.js):
    // one set of uniforms between them, so every slider here moves both.
    section('Wind (grass and tree)');
    slider('Strength', {
      min: 0, max: 1.5, step: 0.01,
      get: () => blades.grassWindStrength.value,
      set: (v) => { blades.grassWindStrength.value = v; },
    });
    slider('Speed', {
      min: 0, max: 5, step: 0.05,
      get: () => blades.grassWindSpeed.value,
      set: (v) => { blades.grassWindSpeed.value = v; },
    });
    slider('Gust size (m)', {
      min: 10, max: 500, step: 5,
      get: () => blades.windGustScale.value,
      set: (v) => { blades.windGustScale.value = v; },
    });
    slider('Gust speed (m/s)', {
      min: 0, max: 12, step: 0.05,
      get: () => blades.windGustSpeed.value,
      set: (v) => { blades.windGustSpeed.value = v; },
    });
    slider('Ripple size (m)', {
      min: 5, max: 200, step: 1,
      get: () => blades.windRippleScale.value,
      set: (v) => { blades.windRippleScale.value = v; },
    });
    slider('Ripple speed (m/s)', {
      min: 0, max: 20, step: 0.1,
      get: () => blades.windRippleSpeed.value,
      set: (v) => { blades.windRippleSpeed.value = v; },
    });
    slider('Ripple share', {
      min: 0, max: 1, step: 0.01,
      get: () => blades.windRippleShare.value,
      set: (v) => { blades.windRippleShare.value = v; },
    });
    slider('Colour patch (m)', {
      min: 5, max: 300, step: 1,
      get: () => blades.grassColourPatch.value,
      set: (v) => { blades.grassColourPatch.value = v; },
    });

    section('Flowers', {
      get: () => grass.showFlowers,
      set: (on) => { grass.showFlowers = on; },
    });
    slider('Ground texture influence', {
      min: 0, max: 1, step: 0.01,
      get: () => blades.grassGroundInfluence.value,
      set: (v) => { blades.grassGroundInfluence.value = v; },
    });
    slider('Root shade (AO)', {
      min: 0, max: 1, step: 0.01,
      get: () => blades.grassBaseShade.value,
      set: (v) => { blades.grassBaseShade.value = v; },
    });
    slider('Fade start (m)', {
      min: 0, max: 100, step: 1,
      get: () => blades.grassFadeStart.value,
      set: (v) => { blades.grassFadeStart.value = v; },
    });
    slider('Fade end (m)', {
      // No further than the grid of chunks reaches, or its edge would show.
      min: 1, max: Math.floor(grass.maxFadeEnd), step: 1,
      get: () => blades.grassFadeEnd.value,
      set: (v) => { blades.grassFadeEnd.value = v; },
    });

    // --- terrain: distance tiling and macro variation -----------------------------
    const ground = terrain.material.userData.uniforms;
    section('Distance tiling', {
      get: () => ground.terrainDistanceTiling.value > 0,
      set: (on) => { ground.terrainDistanceTiling.value = on ? 1 : 0; },
    });
    slider('Near tile (m)', {
      min: 1, max: 30, step: 0.5,
      get: () => ground.terrainTile.value,
      set: (v) => { ground.terrainTile.value = v; },
    });
    slider('Far tile (m)', {
      min: 5, max: 200, step: 1,
      get: () => ground.terrainFarTile.value,
      set: (v) => { ground.terrainFarTile.value = v; },
    });
    slider('Crossfade start (m)', {
      min: 0, max: 300, step: 1,
      get: () => ground.terrainFarBlendStart.value,
      set: (v) => { ground.terrainFarBlendStart.value = v; },
    });
    slider('Crossfade end (m)', {
      min: 1, max: 600, step: 1,
      get: () => ground.terrainFarBlendEnd.value,
      set: (v) => { ground.terrainFarBlendEnd.value = v; },
    });

    let macroStrength = ground.terrainMacroStrength.value;
    section('Macro variation', {
      get: () => ground.terrainMacroStrength.value > 0,
      set: (on) => { ground.terrainMacroStrength.value = on ? macroStrength : 0; },
    });
    slider('Strength', {
      min: 0, max: 1, step: 0.01,
      get: () => macroStrength,
      set: (v) => {
        macroStrength = v;
        if (ground.terrainMacroStrength.value > 0 || v > 0) ground.terrainMacroStrength.value = v;
      },
    });
    ['x', 'y', 'z'].forEach((axis, i) => {
      slider(`Scale ${i + 1} (m)`, {
        min: 2, max: 1000, step: 1,
        get: () => ground.terrainMacroScales.value[axis],
        set: (v) => { ground.terrainMacroScales.value[axis] = v; },
      });
    });

    const fog = post.fog.material.uniforms;
    const apply = post.exposure.applyMaterial.uniforms;
    const adapt = post.exposure.adaptMaterial.uniforms;
    const skyUniforms = daylight.sky.material.uniforms;
    const recapture = () => daylight.captureSkyLight();

    // --- sky atmosphere ------------------------------------------------------
    section('Sky atmosphere', {
      get: () => daylight.sky.visible,
      set: (on) => { daylight.sky.visible = on; },
    });
    slider('Sun elevation (deg)', {
      min: -5, max: 90, step: 0.5,
      get: () => daylight.sunAngles.elevation,
      set: (v) => daylight.setSunAngles(v, daylight.sunAngles.azimuth),
      settle: recapture,
    });
    slider('Sun azimuth (deg)', {
      min: 0, max: 360, step: 1,
      get: () => daylight.sunAngles.azimuth,
      set: (v) => daylight.setSunAngles(daylight.sunAngles.elevation, v),
      settle: recapture,
    });
    slider('Turbidity', {
      min: 0, max: 20, step: 0.1,
      get: () => skyUniforms.turbidity.value,
      set: (v) => { skyUniforms.turbidity.value = v; },
      settle: recapture,
    });
    slider('Rayleigh', {
      min: 0, max: 4, step: 0.01,
      get: () => skyUniforms.rayleigh.value,
      set: (v) => { skyUniforms.rayleigh.value = v; },
      settle: recapture,
    });
    slider('Mie coefficient', {
      min: 0, max: 0.1, step: 0.001,
      get: () => skyUniforms.mieCoefficient.value,
      set: (v) => { skyUniforms.mieCoefficient.value = v; },
      settle: recapture,
    });
    slider('Mie directional G', {
      min: 0, max: 0.999, step: 0.001,
      get: () => skyUniforms.mieDirectionalG.value,
      set: (v) => { skyUniforms.mieDirectionalG.value = v; },
      settle: recapture,
    });

    // --- directional light -----------------------------------------------------
    section('Directional light (sun)', {
      get: () => daylight.sun.visible,
      set: (on) => { daylight.sun.visible = on; },
    });
    slider('Intensity', {
      min: 0, max: 10, step: 0.05,
      get: () => daylight.sunIntensity,
      set: (v) => { daylight.sunIntensity = v; },
    });
    section('Sun shadows', {
      get: () => daylight.sun.castShadow,
      set: (on) => {
        daylight.sun.castShadow = on;
        daylight.requestShadowUpdate(); // the map only redraws when asked
      },
    });
    slider('Shadow normal bias', {
      min: 0, max: 1, step: 0.01,
      get: () => daylight.sun.shadow.normalBias,
      set: (v) => { daylight.sun.shadow.normalBias = v; },
    });

    // --- sky light ---------------------------------------------------------------
    let skyLightLevel = scene.environmentIntensity;
    section('Sky light', {
      get: () => scene.environmentIntensity > 0,
      set: (on) => { scene.environmentIntensity = on ? skyLightLevel : 0; },
    });
    slider('Intensity', {
      min: 0, max: 4, step: 0.05,
      get: () => skyLightLevel,
      set: (v) => {
        skyLightLevel = v;
        if (scene.environmentIntensity > 0 || v > 0) scene.environmentIntensity = v;
      },
    });

    // --- exponential height fog ------------------------------------------------
    // --- volumetric clouds -------------------------------------------------------
    const cloud = post.clouds.material.uniforms;
    section('Volumetric clouds', {
      get: () => post.clouds.enabled,
      set: (on) => { post.clouds.enabled = on; },
    });
    for (const [label, name, min, max, step] of [
      ['Coverage', 'coverage', 0, 1, 0.01],
      ['Density (per m)', 'density', 0, 0.1, 0.0005],
      ['Bottom (m)', 'bottom', 100, 6000, 10],
      ['Top (m)', 'top', 200, 9000, 10],
      ['Shape scale (m)', 'shapeScale', 500, 20000, 50],
      ['Detail scale (m)', 'detailScale', 50, 5000, 10],
      ['Detail erosion', 'detailStrength', 0, 1, 0.01],
      ['Weather scale (m)', 'weatherScale', 5000, 150000, 500],
      ['Weather contrast', 'weatherContrast', 0, 2, 0.01],
      ['Pattern warp', 'warp', 0, 1.5, 0.01],
      ['Sun light', 'sunLight', 0, 5, 0.01],
      ['Sky light', 'ambient', 0, 4, 0.01],
      ['Absorption', 'absorption', 0, 4, 0.01],
      ['Powder (dark edges)', 'powder', 0, 1, 0.01],
      ['Silver lining (g)', 'forwardScattering', 0, 0.99, 0.01],
      ['Steps', 'stepCount', 8, 64, 1],
      ['Max distance (m)', 'maxDistance', 2000, 150000, 500],
      // The haze's density is the mountains' own, on their Haze slider.
      ['Haze height (m)', 'hazeHeight', 100, 8000, 50],
    ]) {
      slider(label, {
        min, max, step,
        get: () => cloud[name].value,
        set: (v) => { cloud[name].value = v; },
      });
    }
    slider('Wind x (m/s)', {
      min: -60, max: 60, step: 0.5,
      get: () => cloud.wind.value.x,
      set: (v) => { cloud.wind.value.x = v; },
    });
    slider('Wind z (m/s)', {
      min: -60, max: 60, step: 0.5,
      get: () => cloud.wind.value.y,
      set: (v) => { cloud.wind.value.y = v; },
    });

    // --- high clouds: cirrus --------------------------------------------------------
    section('High clouds', {
      get: () => cloud.highOn.value > 0.5,
      set: (on) => { cloud.highOn.value = on ? 1 : 0; },
    });
    for (const [label, name, min, max, step] of [
      ['Cirrus height (m)', 'cirrusHeight', 6000, 14000, 50],
      ['Cirrus coverage', 'cirrusCoverage', 0, 1, 0.01],
      ['Cirrus opacity', 'cirrusOpacity', 0, 1, 0.01],
      ['Cirrus scale (m)', 'cirrusScale', 2000, 80000, 500],
      ['Brightness', 'highLight', 0, 3, 0.01],
      ['Fade distance (m)', 'highFade', 20000, 400000, 1000],
    ]) {
      slider(label, {
        min, max, step,
        get: () => cloud[name].value,
        set: (v) => { cloud[name].value = v; },
      });
    }
    slider('Wind aloft x (m/s)', {
      min: -80, max: 80, step: 0.5,
      get: () => cloud.windAloft.value.x,
      set: (v) => { cloud.windAloft.value.x = v; },
    });
    slider('Wind aloft z (m/s)', {
      min: -80, max: 80, step: 0.5,
      get: () => cloud.windAloft.value.y,
      set: (v) => { cloud.windAloft.value.y = v; },
    });

    // --- cloud shadows ----------------------------------------------------------
    const shadows = post.cloudShadows;
    section('Cloud shadows', {
      get: () => shadows.enabled,
      set: (on) => { shadows.enabled = on; },
    });
    slider('Strength', {
      min: 0, max: 1, step: 0.01,
      get: () => shadows.strength,
      set: (v) => { shadows.strength = v; },
    });
    slider('Map span (m)', {
      min: 8000, max: 120000, step: 1000,
      get: () => CLOUD_SHADOWS.span,
      set: (v) => { CLOUD_SHADOWS.span = v; },
    });
    slider('Redraws a second', {
      min: 1, max: 60, step: 1,
      get: () => CLOUD_SHADOWS.rate,
      set: (v) => { CLOUD_SHADOWS.rate = v; },
    });

    section('Exponential height fog', {
      get: () => post.fog.fogEnabled,
      set: (on) => { post.fog.fogEnabled = on; },
    });
    slider('Density', {
      min: 0, max: 0.05, step: 0.0005,
      get: () => fog.fogDensity.value,
      set: (v) => { fog.fogDensity.value = v; },
    });
    slider('Height falloff', {
      min: 0.001, max: 0.5, step: 0.001,
      get: () => fog.fogFalloff.value,
      set: (v) => { fog.fogFalloff.value = v; },
    });
    slider('Base height (m)', {
      min: -50, max: 100, step: 0.5,
      get: () => fog.fogHeight.value,
      set: (v) => { fog.fogHeight.value = v; },
    });
    slider('Start distance (m)', {
      min: 0, max: 200, step: 1,
      get: () => fog.fogStart.value,
      set: (v) => { fog.fogStart.value = v; },
    });
    slider('Max opacity', {
      min: 0, max: 1, step: 0.01,
      get: () => fog.fogMaxOpacity.value,
      set: (v) => { fog.fogMaxOpacity.value = v; },
    });
    slider('Fog brightness (x sky)', {
      min: 0, max: 3, step: 0.01,
      get: () => post.fog.brightness,
      set: (v) => post.fog.setBrightness(v),
    });
    slider('Fog sky blur (mip)', {
      min: 0, max: 6, step: 0.1,
      get: () => fog.skyBlur.value,
      set: (v) => { fog.skyBlur.value = v; },
    });
    slider('Inscattering brightness', {
      min: 0, max: 5, step: 0.01,
      get: () => post.fog.inscatteringBrightness,
      set: (v) => post.fog.setInscatteringBrightness(v),
    });
    slider('Inscattering exponent', {
      min: 1, max: 64, step: 1,
      get: () => fog.inscatterExponent.value,
      set: (v) => { fog.inscatterExponent.value = v; },
    });

    // --- post process volume: exposure ---------------------------------------------
    section('Auto exposure', {
      get: () => post.exposure.enabled,
      set: (on) => { post.exposure.enabled = on; },
    });
    slider('Key (target grey)', {
      min: 0.01, max: 1, step: 0.01,
      get: () => apply.key.value,
      set: (v) => { apply.key.value = v; },
    });
    slider('Compensation', {
      min: 0, max: 4, step: 0.01,
      get: () => apply.compensation.value,
      set: (v) => { apply.compensation.value = v; },
    });
    slider('Min exposure', {
      min: 0.01, max: 2, step: 0.01,
      get: () => apply.minExposure.value,
      set: (v) => { apply.minExposure.value = v; },
    });
    slider('Max exposure', {
      min: 0.1, max: 16, step: 0.1,
      get: () => apply.maxExposure.value,
      set: (v) => { apply.maxExposure.value = v; },
    });
    slider('Speed brighter (1/s)', {
      min: 0.1, max: 10, step: 0.1,
      get: () => adapt.speedBrighter.value,
      set: (v) => { adapt.speedBrighter.value = v; },
    });
    slider('Speed darker (1/s)', {
      min: 0.1, max: 10, step: 0.1,
      get: () => adapt.speedDarker.value,
      set: (v) => { adapt.speedDarker.value = v; },
    });

    // --- tone mapping --------------------------------------------------------------
    section('ACES tone mapping', {
      get: () => renderer.toneMapping === THREE.ACESFilmicToneMapping,
      set: (on) => { renderer.toneMapping = on ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping; },
    });
    slider('Manual exposure', {
      min: 0, max: 4, step: 0.01,
      get: () => renderer.toneMappingExposure,
      set: (v) => { renderer.toneMappingExposure = v; },
    });

    // --- post process volume: color grading ----------------------------------------
    const grading = post.grading;
    const graded = (apply) => (v) => { apply(v); grading.update(); };
    section('Color grading', {
      get: () => grading.enabled,
      set: (on) => { grading.enabled = on; },
    });
    slider('White balance temp (K)', {
      min: 1500, max: 15000, step: 50,
      get: () => grading.settings.temperature,
      set: graded((v) => { grading.settings.temperature = v; }),
    });
    slider('White balance tint', {
      min: -1, max: 1, step: 0.01,
      get: () => grading.settings.tint,
      set: graded((v) => { grading.settings.tint = v; }),
    });
    for (const channel of ['r', 'g', 'b']) {
      slider(`Colour gain ${channel.toUpperCase()}`, {
        min: 0, max: 2, step: 0.01,
        get: () => grading.settings.colour[channel],
        set: graded((v) => { grading.settings.colour[channel] = v; }),
      });
    }

    const RANGE_SLIDERS = [
      ['Saturation', 'saturation', 0, 2, 0.01],
      ['Contrast', 'contrast', 0.2, 2, 0.01],
      ['Gamma', 'gamma', 0.2, 3, 0.01],
      ['Gain', 'gain', 0, 3, 0.01],
      ['Offset', 'offset', -0.2, 0.2, 0.001],
    ];
    for (const [title, name] of [
      ['Global', 'global'], ['Shadows', 'shadows'], ['Midtones', 'midtones'], ['Highlights', 'highlights'],
    ]) {
      section(title);
      if (name === 'shadows') {
        slider('Shadows max (luminance)', {
          min: 0, max: 1, step: 0.01,
          get: () => grading.settings.shadowsMax,
          set: graded((v) => { grading.settings.shadowsMax = v; }),
        });
      }
      if (name === 'highlights') {
        slider('Highlights min (luminance)', {
          min: 0, max: 1.5, step: 0.01,
          get: () => grading.settings.highlightsMin,
          set: graded((v) => { grading.settings.highlightsMin = v; }),
        });
      }
      for (const [label, key, min, max, step] of RANGE_SLIDERS) {
        slider(label, {
          min, max, step,
          get: () => grading.settings[name][key],
          set: graded((v) => { grading.settings[name][key] = v; }),
        });
      }
    }

    // --- the mountains ------------------------------------------------------------
    // Last, and only when there are any: the range is scenery the trip may
    // have gone without (scene/outside/distantRange.js).
    if (range) rangeControls({ section, slider, range });
    if (tree) treeControls({ section, slider, colour, tree });
    if (leaves) {
      section('Falling leaves', {
        get: () => leaves.object.visible,
        set: (on) => { leaves.object.visible = on; },
      });
      slider('Fall speed (x)', {
        min: 0.1, max: 3, step: 0.05,
        get: () => leaves.settings.fall, set: (v) => { leaves.settings.fall = v; },
      });
      slider('Drift (x)', {
        min: 0, max: 4, step: 0.05,
        get: () => leaves.settings.drift, set: (v) => { leaves.settings.drift = v; },
      });
      slider('Swing (x)', {
        min: 0, max: 3, step: 0.05,
        get: () => leaves.settings.swing, set: (v) => { leaves.settings.swing = v; },
      });
    }
  }

  /**
   * The distant range (scene/outside/distantRange.js).
   *
   * Two kinds of control, and the difference matters. The SHADING is uniforms
   * and shows on the next frame, so those sliders steer as you drag them. The
   * SHAPE is baked into the mesh, so those lay the whole ring out again -- a
   * fifth of a second -- and do it on `settle`, when the slider is let go,
   * rather than sixty times through a drag.
   */
  function rangeControls({ section, slider, range }) {
    const u = range.uniforms;
    const shape = range.shape;
    const relay = () => range.rebuild();

    section('Mountains: shape (rebuilds)', {
      get: () => range.object.visible,
      set: (on) => { range.object.visible = on; },
    });
    slider('Seed', {
      min: 0, max: 100, step: 1,
      get: () => shape.seed, set: (v) => { shape.seed = v; }, settle: relay,
    });
    slider('Relief at 1 km (m)', {
      min: 40, max: 900, step: 5,
      get: () => shape.relief, set: (v) => { shape.relief = v; }, settle: relay,
    });
    slider('Growth with distance', {
      min: 0.5, max: 1.2, step: 0.01,
      get: () => shape.growth, set: (v) => { shape.growth = v; }, settle: relay,
    });
    slider('Valley floors rise', {
      min: 0, max: 1, step: 0.01,
      get: () => shape.baseRise, set: (v) => { shape.baseRise = v; }, settle: relay,
    });
    slider('Ridge spacing (m)', {
      min: 600, max: 8000, step: 50,
      get: () => shape.ridgeScale, set: (v) => { shape.ridgeScale = v; }, settle: relay,
    });
    slider('Crest sharpness', {
      min: 1, max: 5, step: 0.05,
      get: () => shape.sharpness, set: (v) => { shape.sharpness = v; }, settle: relay,
    });
    slider('Detail gathers on ridges', {
      min: 0.5, max: 3, step: 0.05,
      get: () => shape.gain, set: (v) => { shape.gain = v; }, settle: relay,
    });
    slider('Detail thins from (m)', {
      min: 500, max: 20000, step: 100,
      get: () => shape.detailFrom, set: (v) => { shape.detailFrom = v; }, settle: relay,
    });
    slider('...over (m)', {
      min: 500, max: 25000, step: 100,
      get: () => shape.detailOver, set: (v) => { shape.detailOver = v; }, settle: relay,
    });

    section('Mountains: surface');
    slider('Ridge / hollow shading', {
      min: 0, max: 1.5, step: 0.01,
      get: () => u.reliefShading.value, set: (v) => { u.reliefShading.value = v; },
    });
    slider('Rib strength', {
      min: 0, max: 2, step: 0.01,
      get: () => u.ribStrength.value, set: (v) => { u.ribStrength.value = v; },
    });
    slider('Rib size (m)', {
      min: 20, max: 1200, step: 10,
      get: () => u.ribScale.value, set: (v) => { u.ribScale.value = v; },
    });
    slider('Grain strength', {
      min: 0, max: 2, step: 0.01,
      get: () => u.grainStrength.value, set: (v) => { u.grainStrength.value = v; },
    });
    slider('Grain size (m)', {
      min: 5, max: 300, step: 1,
      get: () => u.grainScale.value, set: (v) => { u.grainScale.value = v; },
    });
    slider('Ambient', {
      min: 0, max: 1, step: 0.01,
      get: () => u.ambient.value, set: (v) => { u.ambient.value = v; },
    });

    section('Mountains: snow and tree line');
    slider('Snow line (m)', {
      min: 0, max: 4000, step: 10,
      get: () => u.snowLine.value, set: (v) => { u.snowLine.value = v; },
    });
    slider('Snow fade (m)', {
      min: 10, max: 2000, step: 10,
      get: () => u.snowFade.value, set: (v) => { u.snowFade.value = v; },
    });
    slider('Snow line wander', {
      min: 0, max: 2, step: 0.01,
      get: () => u.snowScatter.value, set: (v) => { u.snowScatter.value = v; },
    });
    slider('Tree line (m)', {
      min: 0, max: 3000, step: 10,
      get: () => u.treeLine.value, set: (v) => { u.treeLine.value = v; },
    });
    slider('Tree line fade (m)', {
      min: 10, max: 1500, step: 10,
      get: () => u.treeFade.value, set: (v) => { u.treeFade.value = v; },
    });

    section('Mountains: distance');
    slider('Haze density', {
      min: 0, max: 0.001, step: 0.000005,
      get: () => u.hazeDensity.value, set: (v) => { u.hazeDensity.value = v; },
    });
    slider('Contrast loss', {
      min: 0, max: 0.002, step: 0.00001,
      get: () => u.flattenDensity.value, set: (v) => { u.flattenDensity.value = v; },
    });
  }

  /**
   * The fluffy tree (scene/outside/tree.js), with the controls its original
   * has: the gradient, its three colours, the shadow darkness and the wobble.
   * All uniforms, so all live.
   */
  function treeControls({ section, slider, colour, tree }) {
    const u = tree.uniforms;
    section('Tree: leaves', {
      get: () => tree.object.visible,
      set: (on) => { tree.object.visible = on; },
    });
    slider('Gradient start', {
      min: -1, max: 5, step: 0.01,
      get: () => u.uGradientStart.value, set: (v) => { u.uGradientStart.value = v; },
    });
    slider('Gradient end', {
      min: -1, max: 5, step: 0.01,
      get: () => u.uGradientEnd.value, set: (v) => { u.uGradientEnd.value = v; },
    });
    colour('Shadow colour', { get: () => u.uShadowColor.value });
    colour('Lit colour', { get: () => u.uLitColor.value });
    slider('Highlight start', {
      min: -1, max: 5, step: 0.01,
      get: () => u.uHighlightStart.value, set: (v) => { u.uHighlightStart.value = v; },
    });
    slider('Highlight end', {
      min: -1, max: 5, step: 0.01,
      get: () => u.uHighlightEnd.value, set: (v) => { u.uHighlightEnd.value = v; },
    });
    colour('Highlight colour', { get: () => u.uHighlightColor.value });
    slider('Leaf shadow darkness', {
      min: 0, max: 1, step: 0.01,
      get: () => u.uLeafShadowDarkness.value, set: (v) => { u.uLeafShadowDarkness.value = v; },
    });
    slider('Trunk shadow darkness', {
      min: 0, max: 1, step: 0.01,
      get: () => tree.trunkShadow.value, set: (v) => { tree.trunkShadow.value = v; },
    });

    section('Tree: wind');
    slider('Strength', {
      min: 0, max: 1, step: 0.01,
      get: () => u.uWindStrength.value, set: (v) => { u.uWindStrength.value = v; },
    });
    slider('Frequency', {
      min: 0, max: 5, step: 0.01,
      get: () => u.uWindFrequency.value, set: (v) => { u.uWindFrequency.value = v; },
    });
    slider('Speed', {
      min: 0, max: 5, step: 0.1,
      get: () => u.uWindSpeed.value, set: (v) => { u.uWindSpeed.value = v; },
    });
  }

  return {
    /** Call every frame with whether the debug overlay is up. */
    update(debugVisible) {
      const outside = getOutside();
      const show = Boolean(debugVisible && outside?.outside && outside.daylight && outside.post);
      // A new trip outside means new objects: drop the old panel.
      if (el && (!outside?.post || outside.post !== builtFor)) {
        el.remove();
        el = null;
        builtFor = null;
      }
      if (show && !el) {
        build(outside.daylight, outside.post, outside.terrain, outside.grass, outside.range, outside.tree, outside.leaves);
        builtFor = outside.post;
      }
      if (el) el.style.display = show ? 'block' : 'none';
    },
  };
}