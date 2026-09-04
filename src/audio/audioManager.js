const WIND_URL = '/audio/music/wind.mp3';
const PAGE_TURN_URL = '/audio/sfx/pageturn.mp3';

export function createAudioManager() {
	const wind = new Audio(WIND_URL);
	wind.loop = true;
	wind.preload = 'auto';

	let started = false;
	let muted = false;
	const activeSfx = new Set();

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
		if (event.key.toLowerCase() === 'm' && !event.repeat) toggleMute();
	});
	startWind();

	return {
		startWind,
		playPageTurn() {
            console.log('playPageTurn');
            const pageTurn = new Audio(PAGE_TURN_URL);
			pageTurn.muted = muted;
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
