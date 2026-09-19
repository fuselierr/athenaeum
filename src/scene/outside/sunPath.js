/**
 * Where the sun is at a given time of day, outside.
 *
 * A real sun's path, not a dial: for a place at LATITUDE on a day when the
 * sun stands DECLINATION above the equator (late spring), the hour angle
 * gives its height and its bearing by the usual spherical astronomy. So it
 * rises low in the east, climbs steeply toward a noon that is not overhead,
 * and sets in the west -- and the long evening shadows point the right way
 * because the sun got there along the right arc.
 *
 * TURNED TO FIT THE SCENE. The scene was lit and tuned with the sun at 55
 * degrees up and 255 degrees round (outdoorLight.js). Rather than move the
 * whole meadow under a new compass, the path is turned so that DEFAULT_TIME
 * puts the sun exactly there: a morning or an evening then falls where it
 * naturally would either side of the light everything was tuned in.
 */

const LATITUDE = 45; // degrees north
const DECLINATION = 15; // degrees: late May, or mid July

/** Hours the setting may range over: just after sunrise to sunset. */
export const TIME_RANGE = [5.5, 19];

/** The time the scene was tuned at -- see TURNED TO FIT THE SCENE. */
export const DEFAULT_TIME = 13.4;

// Where the tuned light has the sun: outdoorLight.js's SUN_AZIMUTH.
const TUNED_AZIMUTH = 255;

const rad = Math.PI / 180;

/**
 * The sun's elevation and its bearing from north, clockwise, in degrees.
 * @param {number} hours  local solar time, 12 is noon
 */
function solar(hours) {
  const phi = LATITUDE * rad;
  const delta = DECLINATION * rad;
  const hourAngle = (hours - 12) * 15 * rad;
  const sinElevation = Math.sin(phi) * Math.sin(delta)
    + Math.cos(phi) * Math.cos(delta) * Math.cos(hourAngle);
  const elevation = Math.asin(Math.max(-1, Math.min(1, sinElevation)));
  const cosBearing = (Math.sin(delta) - Math.sin(elevation) * Math.sin(phi))
    / Math.max(Math.cos(elevation) * Math.cos(phi), 1e-6);
  const bearing = Math.acos(Math.max(-1, Math.min(1, cosBearing))) / rad;
  // East of south in the morning, west of it in the afternoon.
  return { elevation: elevation / rad, bearing: hourAngle < 0 ? bearing : 360 - bearing };
}

const TURN = TUNED_AZIMUTH - solar(DEFAULT_TIME).bearing;

/**
 * The sun at `hours`, in outdoorLight.js's terms: elevation above the
 * horizon, and azimuth clockwise from +Z seen from above, both in degrees.
 *
 * @param {number} hours
 * @returns {{ elevation: number, azimuth: number }}
 */
export function sunAt(hours) {
  const { elevation, bearing } = solar(hours);
  return { elevation, azimuth: (((bearing + TURN) % 360) + 360) % 360 };
}

/** "13:24" for 13.4. */
export function clockTime(hours) {
  const whole = Math.floor(hours);
  const minutes = Math.round((hours - whole) * 60);
  const h = minutes === 60 ? whole + 1 : whole;
  const m = minutes === 60 ? 0 : minutes;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
