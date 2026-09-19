import { settings } from './settings.js';

/**
 * Graphics quality presets: the settings that cost the most, turned down
 * together for machines that cannot afford them.
 *
 * Values only, like settings.js. Each is applied by whatever owns it, and
 * all of them live -- a change reaches what is on screen now, except where
 * noted:
 *
 *   pixelRatio        render pixels per CSS pixel, from the display's own
 *                     (ui/bindSettings.js)
 *   sunShadow ..      shadow map sizes: the sun outside, the window's
 *   lampShadow        daylight and the lamp inside (ui/bindSettings.js)
 *   msaa              anti-aliasing samples outside (outdoorPost.js; the
 *                     room's canvas keeps its own, which cannot change once
 *                     made)
 *   cloudResolution   the clouds' render size, as a fraction of the screen
 *   cloudSteps        how finely each cloud ray is marched (outdoorPost.js)
 *   cloudShadowSize   texels a side of the cloud shadow map, and how many
 *   cloudShadowRate   times a second it is redrawn (cloudShadows.js)
 *   grassLod          metres from the camera where the grass steps down to
 *                     its simpler tufts, near and far (grass.js) -- never
 *                     how MUCH grass there is, which is the same everywhere
 *   pageScale         pixels per PDF point a book's pages are drawn at
 *                     (loader/bookLoader.js) -- for the NEXT book opened; one
 *                     already drawn keeps its pages
 *   foliageDensity    the share of the room's leaves drawn
 *                     (scene/inside/foliage.js) -- thinned evenly, never a
 *                     corner stripped bare
 *   pageAnisotropy    how sharp a page stays seen at a slant
 *                     (book/reader/bookContent.js) -- for pages as they are
 *                     next put on the book
 *
 * 'high' is what everything was before the presets existed.
 */

export const QUALITY_LEVELS = ['lowest', 'low', 'medium', 'high', 'highest'];

export const QUALITY = {
  lowest: {
    label: 'Lowest',
    note: 'For the weakest machines: rendered at well under full resolution, with small shadow maps, no anti-aliasing, coarse clouds and cloud shadows, the simplest grass past a few metres, and lower-resolution pages.',
    pixelRatio: (dpr) => Math.min(dpr, 1) * 0.6,
    sunShadow: 1024,
    windowShadow: 512,
    lampShadow: 256,
    msaa: 0,
    cloudResolution: 0.25,
    cloudSteps: 16,
    cloudShadowSize: 128,
    cloudShadowRate: 4,
    grassLod: [6, 14],
    pageScale: 1,
    pageAnisotropy: 1,
    foliageDensity: 0.4,
  },
  low: {
    label: 'Low',
    note: 'Below full resolution, no anti-aliasing, lighter clouds and cloud shadows, simpler grass, and slightly softer pages.',
    pixelRatio: (dpr) => Math.min(dpr, 1) * 0.8,
    sunShadow: 1024,
    windowShadow: 1024,
    lampShadow: 512,
    msaa: 0,
    cloudResolution: 0.35,
    cloudSteps: 24,
    cloudShadowSize: 256,
    cloudShadowRate: 6,
    grassLod: [9, 20],
    pageScale: 1.25,
    pageAnisotropy: 2,
    foliageDensity: 0.6,
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
    cloudShadowSize: 384,
    cloudShadowRate: 8,
    grassLod: [12, 24],
    pageScale: 1.5,
    pageAnisotropy: 4,
    foliageDensity: 0.8,
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
    cloudShadowSize: 512,
    cloudShadowRate: 10,
    grassLod: [14, 28],
    pageScale: 1.5,
    pageAnisotropy: 8,
    foliageDensity: 1,
  },
  highest: {
    label: 'Highest',
    note: 'Everything at its most detailed -- the largest shadow maps, the most anti-aliasing, the finest clouds, and the sharpest pages. For fast machines.',
    pixelRatio: (dpr) => Math.min(dpr, 3),
    sunShadow: 4096,
    windowShadow: 4096,
    lampShadow: 2048,
    msaa: 8,
    cloudResolution: 0.75,
    cloudSteps: 64,
    cloudShadowSize: 768,
    cloudShadowRate: 15,
    grassLod: [22, 36],
    pageScale: 2,
    pageAnisotropy: 16,
    foliageDensity: 1,
  },
};

/** The preset settings.graphics.quality names, or 'high' if it names none. */
export function qualityPreset() {
  return QUALITY[settings.graphics.quality] ?? QUALITY.high;
}