const WIND_URL = '/audio/music/wind.mp3';

export function createAudioManager() {
	const wind = new Audio(WIND_URL);
	wind.loop = true;
	wind.preload = 'auto';

	let started = false;

	function startWind() {
		if (started) return;
		wind.play().then(() => {
			started = true;
		}).catch(() => {
			// Browsers may block autoplay until the first user interaction.
		});
	}

	const unlockEvents = ['pointerdown', 'keydown', 'touchstart'];
	unlockEvents.forEach((eventName) => {
		window.addEventListener(eventName, startWind, { once: true, passive: true });
	});
	startWind();

	return {
		startWind,
		stopWind() {
			wind.pause();
			wind.currentTime = 0;
			started = false;
		},
		dispose() {
			wind.pause();
			wind.src = '';
		},
	};
}
