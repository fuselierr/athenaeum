import { watch } from 'vue';
import { matches } from '../state/keybindings.js';
import { world } from '../state/world.js';
import { createAmbientLoop } from './ambientLoop.js';

// The ambience of each place: wind in the room, grass outside. Five-minute
// cuts of hour-long recordings -- the originals are in audio-source/, kept
// out of git and out of the build -- played on and on without a seam by
// ambientLoop.js.
const AMBIENCE_URLS = {
	room: '/audio/music/wind.mp3',
	outside: '/audio/music/grass.mp3',
};
const PAGE_TURN_URL = '/audio/sfx/pageturn.mp3';

// Seconds.
const FIRST_FADE = 1.5; // the ambience coming up the first time sound starts
const PLACE_FADE = 3; // one place's ambience into the other's, going out or coming in

/**
 * Two channels -- ambient (the room's wind, or the grass outside) and effects
 * (page turns) -- each scaled by a master. Volume is applied as a NUMBER
 * rather than by muting, so a slider at 30% is audibly 30% and not just
 * "on"; `muted` stays as a separate hard off, because that is what the mute
 * key means.
 *
 * The ambience follows where you are (state/world.js): going outside, the
 * wind fades out as the grass fades in, and back again coming in. Loading
 * the outdoors still counts as the room.
 */
export function createAudioManager() {
	const ambiences = {
		room: createAmbientLoop(AMBIENCE_URLS.room),
		outside: createAmbientLoop(AMBIENCE_URLS.outside),
	};
	const ambienceFor = (place) => (place === 'outside' ? 'outside' : 'room');
	const eachAmbience = (fn) => Object.values(ambiences).forEach(fn);

	let started = false;
	let muted = true;
	const activeSfx = new Set();
	const volumes = { master: 0.8, ambient: 0.5, sfx: 0.9 };

	const clamp = (v, fallback) => (
		Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : fallback
	);

	const ambientVolume = () => volumes.master * volumes.ambient;
	const sfxVolume = () => volumes.master * volumes.sfx;

	/**
	 * Channel levels, 0..1, any subset at a time. Applied to what is
	 * already playing as well as to what comes next -- the ambience never
	 * ends, so a slider that only affected the next sound would look broken.
	 */
	function setVolumes(next = {}) {
		volumes.master = clamp(next.master, volumes.master);
		volumes.ambient = clamp(next.ambient, volumes.ambient);
		volumes.sfx = clamp(next.sfx, volumes.sfx);
		eachAmbience((loop) => loop.setVolume(ambientVolume()));
		activeSfx.forEach((sound) => { sound.volume = sfxVolume(); });
	}
	eachAmbience((loop) => {
		loop.setVolume(ambientVolume());
		loop.setMuted(muted);
	});

	function startWind() {
		if (started) return;
		const place = ambienceFor(world.place);
		ambiences[place].start(FIRST_FADE).then((ok) => {
			// Browsers may block sound until the first user interaction; the
			// unlock listeners below call this again.
			if (!ok) return;
			started = true;
			// Went out or came in while it was getting going.
			const now = ambienceFor(world.place);
			if (now !== place) {
				ambiences[place].stop(PLACE_FADE);
				ambiences[now].start(PLACE_FADE);
			}
		});
	}

	// Going out or coming in: one ambience fades into the other.
	watch(() => ambienceFor(world.place), (place, previous) => {
		if (!started) return;
		ambiences[previous].stop(PLACE_FADE);
		ambiences[place].start(PLACE_FADE);
	});

	function setMuted(value) {
		muted = Boolean(value);
		eachAmbience((loop) => loop.setMuted(muted));
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
			eachAmbience((loop) => loop.stop());
			started = false;
		},
		dispose() {
			eachAmbience((loop) => loop.dispose());
			activeSfx.clear();
		},
	};
}
