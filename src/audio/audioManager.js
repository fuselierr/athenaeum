import { matches } from '../state/keybindings.js';

const WIND_URL = '/audio/music/wind.mp3';
const PAGE_TURN_URL = '/audio/sfx/pageturn.mp3';

/**
 * Two channels -- ambient (the wind loop) and effects (page turns) -- each
 * scaled by a master. Volume is applied as a NUMBER rather than by muting,
 * so a slider at 30% is audibly 30% and not just "on"; `muted` stays as a
 * separate hard off, because that is what the mute key means.
 */
export function createAudioManager() {
	const wind = new Audio(WIND_URL);
	wind.loop = true;
	wind.preload = 'auto';

	let started = false;
	let muted = true;
	wind.muted = muted;
	const activeSfx = new Set();
	const volumes = { master: 0.8, ambient: 0.5, sfx: 0.9 };

	const clamp = (v, fallback) => (
		Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : fallback
	);

	const ambientVolume = () => volumes.master * volumes.ambient;
	const sfxVolume = () => volumes.master * volumes.sfx;

	/**
	 * Channel levels, 0..1, any subset at a time. Applied to what is
	 * already playing as well as to what comes next -- the wind is a single
	 * long loop, so a slider that only affected the next sound would look
	 * broken.
	 */
	function setVolumes(next = {}) {
		volumes.master = clamp(next.master, volumes.master);
		volumes.ambient = clamp(next.ambient, volumes.ambient);
		volumes.sfx = clamp(next.sfx, volumes.sfx);
		wind.volume = ambientVolume();
		activeSfx.forEach((sound) => { sound.volume = sfxVolume(); });
	}
	wind.volume = ambientVolume();

	function startWind() {
		if (started) return;
		wind.play().then(() => {
			started = true;
		}).catch(() => {
			// Browsers may block autoplay until the first user interaction.
		});
	}

	function setMuted(value) {
		muted = Boolean(value);
		wind.muted = muted;
		activeSfx.forEach((sound) => { sound.muted = muted; });
	}

	function toggleMute() {
		setMuted(!muted);
		return muted;
	}

	const unlockEvents = ['pointerdown', 'keydown', 'touchstart'];
	unlockEvents.forEach((eventName) => {
		window.addEventListener(eventName, startWind, { once: true, passive: true });
	});
	window.addEventListener('keydown', (event) => {
		if (matches('audio.mute', event) && !event.repeat) toggleMute();
	});
	startWind();

	return {
		startWind,
		setVolumes,
		get volumes() { return { ...volumes }; },
		playPageTurn() {
            console.log('playPageTurn');
            const pageTurn = new Audio(PAGE_TURN_URL);
			pageTurn.muted = muted;
			pageTurn.volume = sfxVolume();
            pageTurn.preload = 'auto';
            pageTurn.addEventListener('error', () => {
                console.warn('page turn sfx failed to load:', pageTurn.error);
                activeSfx.delete(pageTurn);
            });
            activeSfx.add(pageTurn);
            pageTurn.addEventListener('ended', () => activeSfx.delete(pageTurn), { once: true });
            pageTurn.play().catch((err) => {
                console.warn('page turn sfx blocked:', err);
                activeSfx.delete(pageTurn);
            });
        },
		setMuted,
		toggleMute,
		get muted() { return muted; },
		stopWind() {
			wind.pause();
			wind.currentTime = 0;
			started = false;
		},
		dispose() {
			wind.pause();
			wind.src = '';
			activeSfx.clear();
		},
	};
}