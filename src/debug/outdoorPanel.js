import * as THREE from 'three';

/**
 * Outdoor lighting controls, for the debug overlay (the ` key).
 *
 * Only there outside, and only while the rest of the debug overlay is
 * showing: a checkbox to switch each effect on and off, and sliders for the
 * settings behind it -- the grass, the terrain's tiling tricks, the sky atmosphere, the
 * sun, the sky light, height fog, exposure, color grading and tone mapping. Everything changes live except the sky
 * light, which is a capture of the sky: it is taken again when a slider that
 * changes the sky is let go, not on every step of the drag. A button at the
 * top puts every control back to what it was when the panel was built --
 * the values the outdoor scene starts with.
 *
 * Built the first time it is needed, from whatever scene/outdoorLight.js and
 * scene/outdoorPost.js hand back; nothing here is remembered between visits.
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

  function build(daylight, post, terrain, grass) {
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

    /** A heading, with an on/off checkbox when `toggle` is given. */
    function section(title, toggle) {
      const head = document.createElement('label');
      Object.assign(head.style, {
        display: 'flex', alignItems: 'center', gap: '6px',
        margin: '10px 0 4px', fontWeight: 'bold', color: '#ffd9a8',
      });
      if (toggle) {
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = toggle.get();
        box.addEventListener('change', () => toggle.set(box.checked));
        head.append(box);
        const initial = box.checked;
        toggleResets.push(() => {
          toggle.set(initial);
          box.checked = initial;
        });
      }
      head.append(title);
      el.append(head);
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
      el.append(row);
    }

    // --- grass --------------------------------------------------------------------
    const blades = grass.uniforms;
    section(`Grass (${grass.count.toLocaleString()} blades, ${grass.chunkCount} chunks)`, {
      get: () => grass.group.visible,
      set: (on) => { grass.group.visible = on; },
    });
    slider('Wind strength', {
      min: 0, max: 1.5, step: 0.01,
      get: () => blades.grassWindStrength.value,
      set: (v) => { blades.grassWindStrength.value = v; },
    });
    slider('Wind speed', {
      min: 0, max: 5, step: 0.05,
      get: () => blades.grassWindSpeed.value,
      set: (v) => { blades.grassWindSpeed.value = v; },
    });
    slider('Height scale', {
      min: 0, max: 3, step: 0.01,
      get: () => blades.grassHeightScale.value,
      set: (v) => { blades.grassHeightScale.value = v; },
    });
    slider('Width scale', {
      min: 0, max: 4, step: 0.01,
      get: () => blades.grassWidthScale.value,
      set: (v) => { blades.grassWidthScale.value = v; },
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
      min: 1, max: 100, step: 1,
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
      get: () => daylight.sun.intensity,
      set: (v) => { daylight.sun.intensity = v; },
    });
    section('Sun shadows', {
      get: () => daylight.sun.castShadow,
      set: (on) => { daylight.sun.castShadow = on; },
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
    section('Exponential height fog', {
      get: () => post.fog.enabled,
      set: (on) => { post.fog.enabled = on; },
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
  }

  return {
    /** Call every frame with whether the debug overlay is up. */
    update(debugVisible) {
      const outside = getOutside();
      const show = Boolean(debugVisible && outside?.outside && outside.daylight && outside.post);
      if (show && !el) build(outside.daylight, outside.post, outside.terrain, outside.grass);
      if (el) el.style.display = show ? 'block' : 'none';
    },
  };
}