import { settings } from './settings.js';

/**
 * Graphics quality presets: the settings that cost the most, turned down
 * together for machines that cannot afford them.
 *
 * Values only, like settings.js. Each is applied by whatever owns it:
 * ui/bindSettings.js (resolution, the room's shadow maps, and the sun's when
 * it exists), scene/outside/outdoorPost.js (anti-aliasing, clouds) and
 * scene/outside/grass.js (grass).
 *
 *   pixelRatio        render pixels per CSS pixel, from the display's own
 *   sunShadow ..      shadow map sizes: the sun outside, the window's
 *   lampShadow        daylight and the lamp inside
 *   msaa              anti-aliasing samples outside (the room's canvas keeps
 *                     its own, which cannot change once made)
 *   cloudResolution   the clouds' render size, as a fraction of the screen
 *   cloudSteps        how finely each cloud ray is marched
 *   grassDensity      the fraction of grass blades that stand
 *
 * 'high' is what everything was before the presets existed.
 */

export const QUALITY_LEVELS = ['lowest', 'low', 'medium', 'high', 'highest'];

export const QUALITY = {
  lowest: {
    label: 'Lowest',
    note: 'For the weakest machines: rendered at well under full resolution, with small shadow maps, no anti-aliasing, coarse clouds and sparse grass.',
    pixelRatio: (dpr) => Math.min(dpr, 1) * 0.6,
    sunShadow: 1024,
    windowShadow: 512,
    lampShadow: 256,
    msaa: 0,
    cloudResolution: 0.25,
    cloudSteps: 16,
    grassDensity: 0.1,
  },
  low: {
    label: 'Low',
    note: 'Below full resolution, no anti-aliasing, lighter clouds and thin grass.',
    pixelRatio: (dpr) => Math.min(dpr, 1) * 0.8,
    sunShadow: 1024,
    windowShadow: 1024,
    lampShadow: 512,
    msaa: 0,
    cloudResolution: 0.35,
    cloudSteps: 24,
    grassDensity: 0.3,
  },
  medium: {
    label: 'Medium',
    note: 'Full resolution without high-DPI sharpness, light anti-aliasing, and a little less of everything.',
    pixelRatio: () => 1,
    sunShadow: 2048,
    windowShadow: 1024,
    lampShadow: 512,
    msaa: 2,
    cloudResolution: 0.5,
    cloudSteps: 32,
    grassDensity: 0.6,
  },
  high: {
    label: 'High',
    note: 'Sharp on high-DPI screens, full shadows, anti-aliasing, clouds and grass.',
    pixelRatio: (dpr) => Math.min(dpr, 2),
    sunShadow: 4096,
    windowShadow: 2048,
    lampShadow: 1024,
    msaa: 4,
    cloudResolution: 0.5,
    cloudSteps: 48,
    grassDensity: 1,
  },
  highest: {
    label: 'Highest',
    note: 'Everything at its most detailed -- the largest shadow maps, the most anti-aliasing and the finest clouds. For fast machines.',
    pixelRatio: (dpr) => Math.min(dpr, 3),
    sunShadow: 4096,
    windowShadow: 4096,
    lampShadow: 2048,
    msaa: 8,
    cloudResolution: 0.75,
    cloudSteps: 64,
    grassDensity: 1,
  },
};

/** The preset settings.graphics.quality names, or 'high' if it names none. */
export function qualityPreset() {
  return QUALITY[settings.graphics.quality] ?? QUALITY.high;
}