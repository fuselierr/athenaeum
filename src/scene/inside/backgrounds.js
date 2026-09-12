/**
 * The environments the Scene tab offers.
 *
 * A written list rather than a glob. These live in public/, which Vite
 * serves verbatim and deliberately does not enumerate for the bundle, and
 * their filenames carry asset-library uuids nobody should have to read.
 * Adding one means dropping the .exr into public/backgrounds and adding a
 * line here.
 *
 * The EXR is doing two jobs at once (see scene/createScene.js): it is the
 * backdrop AND, prefiltered, every bit of ambient light in the room. So
 * switching one of these does not just change the view out of the window,
 * it relights the desk -- which is the point.
 */

export const BACKGROUNDS = [
  {
    id: 'dusk',
    name: 'Dusk',
    file: 'background.exr',
    note: 'The light the room was built around',
    megabytes: 9,
  },
  {
    id: 'cloudy',
    name: 'Cloudy sky',
    file: 'cloudy-sky_4K_3d88b169-fcfd-468a-b510-37244c9eb3c2.exr',
    note: 'Flat, even, overcast',
    megabytes: 38,
  },
  {
    id: 'colorful',
    name: 'Colourful clouds',
    file: 'colorful-cloudy-sky_4K_f8f13210-e5b7-42e4-9a3c-734378bae3e7.exr',
    note: 'Warm cloud, strong colour',
    megabytes: 11,
  },
  {
    id: 'sunrise',
    name: 'Soft sunrise',
    file: 'soft-sunrise-field_4K_a856e250-eadd-4e90-81a2-15e2b2ea760c.exr',
    note: 'Low sun across a field',
    megabytes: 10,
  },
  {
    id: 'forest-lake',
    name: 'Forest lake',
    file: 'clouds-green-forest-green-lake_4K_1959a628-5a42-4932-8030-434a47cad034.exr',
    note: 'Verdant water and wooded haze',
    megabytes: 27,
  },
  {
    id: 'beech-lane',
    name: 'Beech lane',
    file: 'dutch-forest-lane-with-beech-trees_4K_adc60d47-dfb5-4740-8e1d-5dcf3e867500.exr',
    note: 'A quiet woodland path',
    megabytes: 26,
  },
];

export const DEFAULT_BACKGROUND = BACKGROUNDS[0].id;

/** Served straight out of public/, so the path is the path. */
export function backgroundUrl(background) {
  return `/backgrounds/${background.file}`;
}

export function findBackground(id) {
  return BACKGROUNDS.find((b) => b.id === id) ?? BACKGROUNDS[0];
}