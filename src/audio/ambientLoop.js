/**
 * A long ambient recording, played for as long as it is wanted without ever
 * being heard to loop.
 *
 * WHY NOT audio.loop. An mp3 carries a little silence at each end, and a
 * looping audio element plays straight through it -- a tick or a gap at
 * every repeat, however seamless the file itself is. And a loop repeats: the
 * same gust every couple of minutes is soon recognised.
 *
 * SO TWO VOICES. Two audio elements on the same file take turns. Each plays
 * a stretch of the recording from somewhere random in it. A few seconds
 * before its stretch is up, the other is sent to a random place of its own,
 * and when the stretch ends the two crossfade. Neither end of the file is
 * ever reached, so the padding is never heard, and no two stretches line up,
 * so there is no pattern to catch.
 *
 * The crossfade is EQUAL-POWER (sine in, cosine out). Two unrelated noises
 * mixed with a straight-line fade lose loudness through the middle; this
 * holds it level.
 *
 * Both elements stream, as a single one did: nothing is decoded into memory
 * up front. Timed on a plain interval rather than animation frames, because
 * a VR session stops the page's animation frames and the sound should not
 * stop with them.
 */

// Seconds.
const FADE = 6; // one stretch into the next
const STRETCH = [70, 150]; // how long each stretch plays before the next takes over
const PREPARE = 4; // how long before a stretch ends the next voice is sent to its place
const START_GUARD = 0.5; // kept clear of the start of the file, where the padding is
const END_GUARD = 2; // and of the end, past the crossfade
const TICK_MS = 50;

const clamp01 = (value) => Math.max(0, Math.min(1, value));

/**
 * @param {string} url  the recording
 * @param {{ fade?: number, stretch?: [number, number] }} [options]  seconds
 */
export function createAmbientLoop(url, { fade = FADE, stretch = STRETCH } = {}) {
	const voices = [0, 1].map(() => {
		const audio = new Audio(url);
		audio.preload = 'auto';
		// until: where in the file this voice's stretch ends.
		// prepared: sent to its place, ready to sound.
		return { audio, mix: 0, until: Infinity, prepared: false, starting: false };
	});

	let current = 0; // the voice carrying the sound; the other waits, or is fading in
	let crossfade = null; // seconds into the crossfade, while one is running
	let running = false; // the current voice is actually playing
	let starting = null; // a start in progress, as its promise

	let volume = 1;
	let muted = false;
	// How much of it to hear, 0..1: what start() and stop() fade.
	let presence = 0;
	let presenceTarget = 0;
	let presenceSpeed = Infinity; // per second

	let timer = null;
	let lastTick = 0;

	function apply() {
		for (const voice of voices) {
			voice.audio.volume = clamp01(volume * presence * voice.mix);
			voice.audio.muted = muted;
		}
	}

	/** Resolves once the recording's length is known. */
	function metadata() {
		const { audio } = voices[0];
		if (audio.readyState >= 1 && Number.isFinite(audio.duration)) return Promise.resolve();
		return new Promise((resolve, reject) => {
			audio.addEventListener('loadedmetadata', () => resolve(), { once: true });
			audio.addEventListener('error', () => reject(audio.error), { once: true });
		});
	}

	/** The next stretch to play: a random place, clear of both ends. */
	function spot() {
		const duration = voices[0].audio.duration;
		const length = stretch[0] + Math.random() * (stretch[1] - stretch[0]);
		const tail = fade + END_GUARD;
		const room = (Number.isFinite(duration) ? duration : 0) - START_GUARD - length - tail;
		if (room <= 0) {
			// Too short a recording for stretches: as much of it as stays clear of the end.
			return { start: 0, until: Math.max(fade, (duration || 0) - tail) };
		}
		const start = START_GUARD + Math.random() * room;
		return { start, until: start + length };
	}

	/** Get the current voice playing, from a fresh place. Resolves whether it is. */
	function begin() {
		if (running) return Promise.resolve(true);
		if (starting) return starting;
		starting = (async () => {
			try {
				await metadata();
				const voice = voices[current];
				const other = voices[1 - current];
				const { start, until } = spot();
				voice.audio.currentTime = start;
				voice.until = until;
				voice.mix = 1;
				other.mix = 0;
				other.prepared = false;
				crossfade = null;
				apply();
				await voice.audio.play();
				running = true;
				return true;
			} catch {
				// Refused -- most often a browser that will not play sound until the
				// page has been interacted with. The next start() tries again.
				return false;
			} finally {
				starting = null;
			}
		})();
		return starting;
	}

	function halt() {
		for (const voice of voices) {
			voice.audio.pause();
			voice.mix = 0;
			voice.prepared = false;
			voice.starting = false;
		}
		crossfade = null;
		running = false;
	}

	/** Move the sound along: send the next voice to its place, and hand over. */
	function advance(dt) {
		const voice = voices[current];
		const next = voices[1 - current];

		if (crossfade !== null) {
			crossfade += dt;
			const t = Math.min(crossfade / fade, 1);
			next.mix = Math.sin((t * Math.PI) / 2);
			voice.mix = Math.cos((t * Math.PI) / 2);
			if (t >= 1) {
				voice.audio.pause();
				voice.mix = 0;
				voice.prepared = false;
				next.prepared = false;
				current = 1 - current;
				crossfade = null;
			}
			return;
		}

		// Ran out from under us -- a stall, a seek that never landed. Start
		// again somewhere fresh rather than go quiet.
		if (voice.audio.ended) {
			running = false;
			begin();
			return;
		}

		const at = voice.audio.currentTime;
		if (!next.prepared && at >= voice.until - PREPARE) {
			const { start, until } = spot();
			next.audio.currentTime = start;
			next.until = until;
			next.mix = 0;
			next.prepared = true;
		}
		if (next.prepared && !next.starting && at >= voice.until) {
			next.starting = true;
			next.audio.play().then(() => {
				next.starting = false;
				// Stopped, or already handed over, while it was getting going.
				if (!running || voices[1 - current] !== next) {
					next.audio.pause();
					return;
				}
				crossfade = 0;
			}).catch(() => {
				next.starting = false;
				next.prepared = false; // sent somewhere fresh and tried again
			});
		}
	}

	function tick() {
		const now = performance.now();
		const dt = Math.min((now - lastTick) / 1000, 0.5);
		lastTick = now;

		if (presence !== presenceTarget) {
			const step = presenceSpeed * dt;
			presence = presence < presenceTarget
				? Math.min(presenceTarget, presence + step)
				: Math.max(presenceTarget, presence - step);
		}
		// Faded all the way out: stop, and stop ticking.
		if (presence === 0 && presenceTarget === 0) {
			halt();
			apply();
			stopTimer();
			return;
		}
		if (running) advance(dt);
		apply();
	}

	function startTimer() {
		if (timer !== null) return;
		lastTick = performance.now();
		timer = setInterval(tick, TICK_MS);
	}

	function stopTimer() {
		if (timer === null) return;
		clearInterval(timer);
		timer = null;
	}

	return {
		/**
		 * Fade in over `seconds` and keep playing. Resolves whether sound could
		 * start: a browser may refuse until the page has been interacted with,
		 * and calling this again is how to try again.
		 */
		start(seconds = 0) {
			presenceTarget = 1;
			if (seconds > 0) {
				presenceSpeed = 1 / seconds;
			} else {
				presence = 1;
				apply();
			}
			startTimer();
			return begin();
		},

		/** Fade out over `seconds`, then stop. */
		stop(seconds = 0) {
			presenceTarget = 0;
			if (seconds > 0) {
				presenceSpeed = 1 / seconds;
				startTimer();
				return;
			}
			presence = 0;
			halt();
			apply();
			stopTimer();
		},

		/** 0..1, applied to what is playing now. */
		setVolume(value) {
			volume = clamp01(value);
			apply();
		},

		setMuted(value) {
			muted = Boolean(value);
			apply();
		},

		get playing() { return running; },

		dispose() {
			stopTimer();
			halt();
			for (const voice of voices) {
				voice.audio.removeAttribute('src');
				voice.audio.load();
			}
		},
	};
}
