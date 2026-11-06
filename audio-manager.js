/* ═══════════════════════════════════════════════════════════════
   AUDIO MANAGER
   Facade for seamless fallback between FMOD and Web Audio Synth.
   ═══════════════════════════════════════════════════════════════ */

window.AudioManager = (function() {
    class AudioManager {
        constructor() {
            this.engine = null; // Will point to either FMODWrapper or EngineAudio
            this.mode = 'PENDING'; // PENDING, FMOD, SYNTH
            this._startRequested = false;
            this._pendingRPM = 800;
            this._pendingLoad = 0;
            this._pendingVolume = 0.3;
            this.samples = null; // SampleEngine (real dyno loops), if it loads
        }

        /**
         * Initializes the audio system.
         * Attempts FMOD first. If it fails, falls back to Web Audio Synth.
         */
        async init() {
            console.log('[AUDIO] Initializing Audio Manager...');
            
            try {
                // Try FMOD
                if (window.FMODWrapper) {
                    const fmod = new window.FMODWrapper();
                    await fmod.init();
                    this.engine = fmod;
                    this.mode = 'FMOD';
                    console.log('[AUDIO] FMOD Engine active.');
                } else {
                    throw new Error("FMODWrapper class not found.");
                }
            } catch (err) {
                // Fallback to Web Audio Synth
                console.log(`[AUDIO] FMOD unavailable (${err.message}). Falling back to Web Audio Synth.`);
                if (window.EngineAudio) {
                    this.engine = new window.EngineAudio();
                    this.mode = 'SYNTH';
                } else {
                    console.error('[AUDIO] EngineAudio fallback also not found!');
                }
            }

            // Real recorded engine loops. FMOD keeps doing shifts and backfires.
            // ?sound=fmod in the URL turns this off so you can compare.
            const wantSamples = !/[?&]sound=fmod\b/.test(location.search);
            if (wantSamples && window.SampleEngine) {
                try {
                    const s = new window.SampleEngine();
                    await s.init();
                    this.samples = s;
                    console.log('[AUDIO] Dyno sample engine active.');
                } catch (err) {
                    console.log(`[AUDIO] Sample engine unavailable (${err.message}).`);
                }
            }

            this._ready = true;

            // Apply any pending commands if start was requested before init finished
            if (this._startRequested && this.engine) {
                this._doStart();
            }
        }

        /**
         * Starts the audio engine (requires user gesture).
         */
        start() {
            this._startRequested = true;
            if (this.engine && this._ready) {
                this._doStart();
            }
        }

        _doStart() {
            this.engine.start();
            this.engine.setRPM(this._pendingRPM);
            this.setVolume(this._pendingVolume);
            if (this.samples) {
                this.samples.start();
                this.samples.setRPM(this._pendingRPM);
                this.samples.setLoad(this._pendingLoad);
            }
            if (this.engine.setLoad) {
                this.engine.setLoad(this._pendingLoad);
            }
        }

        setRPM(rpm) {
            this._pendingRPM = rpm;
            if (this.samples) this.samples.setRPM(rpm);
            if (this.engine && this.engine.setRPM) {
                this.engine.setRPM(rpm);
            }
        }

        /**
         * New unified API to pass load (throttle). 
         * FMOD uses this for pitch/crossfade math.
         */
        setLoad(loadValue) {
            this._pendingLoad = loadValue;
            if (this.samples) this.samples.setLoad(loadValue);
            if (this.engine && this.engine.setLoad) {
                this.engine.setLoad(loadValue);
            }
        }

        triggerShiftBlip() {
            if (this.engine && this.engine.triggerShiftBlip) {
                this.engine.triggerShiftBlip();
            }
        }

        triggerBackfire() {
            if (this.engine && this.engine.triggerBackfire) {
                this.engine.triggerBackfire();
            }
        }

        setVolume(level) {
            this._pendingVolume = level;
            if (this.samples) this.samples.setVolume(level);
            if (this.engine && this.engine.setVolume) {
                // With samples on, FMOD's engine loop is muted; its shift
                // and backfire one-shots still play at full level.
                this.engine.setVolume(this.samples ? 0 : level);
            }
        }

        isRunning() {
            if (!this.engine) return false;
            if (this.mode === 'FMOD') return this.engine.isRunningStatus();
            if (this.mode === 'SYNTH') return this.engine.isRunning();
            return false;
        }
        
        stop() {
            this._startRequested = false;
            if (this.samples) this.samples.stop();
            if (this.mode === 'SYNTH' && this.engine && this.engine.stop) {
                this.engine.stop();
            }
        }
    }

    return AudioManager;
})();
