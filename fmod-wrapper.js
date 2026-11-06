/* ═══════════════════════════════════════════════════════════════
   FMOD WRAPPER
   Handles loading and interfacing with FMOD HTML5 Engine.

   Banks:  sfx/Master.bank  +  sfx/Master.strings.bank
   Events: event:/engine_ext   – continuous engine loop (RPM + LOAD)
           event:/gear_ext     – one-shot shift click
           event:/backfire_ext – one-shot exhaust burble
   Params: RPM (float), LOAD (float 0-1)
   ═══════════════════════════════════════════════════════════════ */

window.FMODWrapper = (function () {
    'use strict';

    class FMODWrapper {
        constructor() {
            this.system = null;
            this.engineDesc = null;
            this.engineEvent = null;
            this.gearDesc = null;
            this.backfireDesc = null;
            this.isRunning = false;

            // Live state for parameter binding + backfire detection
            this._currentRPM = 0;
            this._currentLoad = 0;
            this._lastBackfireTime = 0;
            this._throttleHistory = [];
            this._volume = 1.0;
            this._restarts = 0;
            this._fading = [];          // old engine copies being faded out: { inst, age }
            this._progress = 0;         // how far through its sample the engine is (0..1)
            this._lastTickTime = 0;
        }

        /* ──────────────────────────────────────────────────────────
           INIT — preloads banks, boots WASM, resolves events
           ────────────────────────────────────────────────────────── */
        init() {
            return new Promise((resolve, reject) => {
                if (window.FMOD && this.system) {
                    resolve();
                    return;
                }

                // Give WASM up to 10 seconds to load (was 4s — too tight)
                const timeoutId = setTimeout(() => {
                    reject(new Error('FMOD initialization timed out. WASM probably failed to load.'));
                }, 10000);

                const self = this;

                // 1. Configure global FMOD object expected by fmodstudio.js
                window.FMOD = {
                    TOTAL_MEMORY: 64 * 1024 * 1024,

                    locateFile: function (path, prefix) {
                        if (path.endsWith('.wasm')) return 'wasm/' + path;
                        return prefix + path;
                    },

                    preRun: function () {
                        console.log('[FMOD] Preloading bank files into virtual FS...');
                        const banks = [
                            { virt: 'Master.bank', real: 'sfx/Master.bank' },
                            { virt: 'Master.strings.bank', real: 'sfx/Master.strings.bank' }
                        ];
                        for (const b of banks) {
                            try {
                                window.FMOD.FS_createPreloadedFile('/', b.virt, b.real, true, false);
                                console.log('[FMOD]   ✓ ' + b.virt);
                            } catch (e) {
                                console.error('[FMOD]   ✗ ' + b.virt, e);
                            }
                        }
                    },

                    onRuntimeInitialized: function () {
                        clearTimeout(timeoutId);
                        console.log('[FMOD] Runtime initialized.');
                        try {
                            self._setupFMOD();
                            resolve();
                        } catch (e) {
                            reject(e);
                        }
                    },

                    onAbort: function (msg) {
                        clearTimeout(timeoutId);
                        reject(new Error('FMOD Aborted: ' + msg));
                    }
                };

                // 2. Inject fmodstudio.js from wasm folder
                const script = document.createElement('script');
                script.src = 'wasm/fmodstudio.js';
                script.onload = () => {
                    if (typeof window.FMODModule === 'function') {
                        console.log('[FMOD] Found FMODModule factory. Booting...');
                        window.FMODModule(window.FMOD).then(instance => {
                            window.FMOD = instance;
                        }).catch(e => {
                            clearTimeout(timeoutId);
                            reject(new Error('FMODModule failed: ' + e));
                        });
                    } else {
                        console.log('[FMOD] No factory found — assuming legacy auto-init.');
                    }
                };
                script.onerror = () => {
                    clearTimeout(timeoutId);
                    reject(new Error('wasm/fmodstudio.js not found. Fallback triggered.'));
                };
                document.head.appendChild(script);
            });
        }

        /* ──────────────────────────────────────────────────────────
           _setupFMOD — load banks, resolve events, start tick loop
           ────────────────────────────────────────────────────────── */
        _setupFMOD() {
            const F = window.FMOD;
            let out = {};

            // Create Studio System
            let r = F.Studio_System_Create(out);
            if (r !== F.OK) throw new Error('Studio_System_Create failed: ' + r);
            this.system = out.val;

            // Initialize (128 virtual channels)
            r = this.system.initialize(128, F.STUDIO_INIT_NORMAL, F.INIT_NORMAL, null);
            if (r !== F.OK) throw new Error('system.initialize failed: ' + r);

            // Load strings bank FIRST (enables string-path lookups)
            r = this.system.loadBankFile('/Master.strings.bank', F.STUDIO_LOAD_BANK_NORMAL, out);
            if (r !== F.OK) {
                console.warn('[FMOD] Master.strings.bank load returned code ' + r);
            } else {
                console.log('[FMOD] ✓ Loaded Master.strings.bank');
            }

            // Load main bank (contains audio data + event metadata)
            r = this.system.loadBankFile('/Master.bank', F.STUDIO_LOAD_BANK_NORMAL, out);
            if (r !== F.OK) throw new Error('Failed to load Master.bank. Code: ' + r);
            console.log('[FMOD] ✓ Loaded Master.bank');

            // ── Turn the whole mix down so it stops clipping ──
            // The bank is mixed very hot: at full volume the output went past
            // 1.0 (the most a speaker can take) most of the time, which
            // sounds harsh and crackly. Scaling the master bus fixes it for
            // the engine, shift and backfire sounds together.
            r = this.system.getBus('bus:/', out);
            if (r === F.OK && out.val) {
                out.val.setVolume(FMODWrapper.MASTER_VOLUME);
            } else {
                console.warn('[FMOD] Could not get master bus (code ' + r + ')');
            }

            // ── Resolve event descriptors via clean string paths ──

            // 1. engine_ext — continuous, looping engine sound
            r = this.system.getEvent('event:/engine_ext', out);
            if (r === F.OK && out.val) {
                this.engineDesc = out.val;
                console.log('[FMOD] ✓ Resolved event:/engine_ext');

                this.engineEvent = this._createEngineInstance();
                if (this.engineEvent) console.log('[FMOD]   → Engine instance created');
            } else {
                console.error('[FMOD] ✗ Could not resolve event:/engine_ext (code ' + r + ')');
            }

            // Dump discovered parameters for debugging
            if (this.engineDesc) {
                this._dumpParams(this.engineDesc);
            }

            // 2. gear_ext — one-shot shift click
            r = this.system.getEvent('event:/gear_ext', out);
            if (r === F.OK && out.val) {
                this.gearDesc = out.val;
                console.log('[FMOD] ✓ Resolved event:/gear_ext');
            } else {
                console.warn('[FMOD] ✗ Could not resolve event:/gear_ext (code ' + r + ')');
            }

            // 3. backfire_ext — one-shot exhaust burble / pop
            r = this.system.getEvent('event:/backfire_ext', out);
            if (r === F.OK && out.val) {
                this.backfireDesc = out.val;
                console.log('[FMOD] ✓ Resolved event:/backfire_ext');
            } else {
                console.warn('[FMOD] ✗ Could not resolve event:/backfire_ext (code ' + r + ')');
            }

            // Start the FMOD update tick
            this._tick();
        }

        /**
         * Makes a new engine sound instance, already set to the current
         * RPM / LOAD / volume so it sounds right from its first sample.
         * @private
         */
        _createEngineInstance(volume = this._volume) {
            const F = window.FMOD;
            const out = {};
            const r = this.engineDesc.createInstance(out);
            if (r !== F.OK || !out.val) {
                console.error('[FMOD]   ✗ createInstance for engine failed: ' + r);
                return null;
            }
            const inst = out.val;
            // 3D event: give it a real position, or the panner can mute it (NaN)
            inst.set3DAttributes({
                position: { x: 0, y: 0, z: 0 },
                velocity: { x: 0, y: 0, z: 0 },
                forward: { x: 0, y: 0, z: 1 },
                up: { x: 0, y: 1, z: 0 }
            });
            // "true" = jump straight to the value instead of gliding up from 0
            inst.setParameterByName('RPM', this._currentRPM, true);
            inst.setParameterByName('LOAD', this._currentLoad, true);
            inst.setVolume(volume);
            return inst;
        }

        /**
         * WHY THE SOUND USED TO CUT OUT
         * ------------------------------
         * In the sound bank, engine_ext plays a recorded engine sample that
         * does NOT loop. FMOD speeds the sample up for higher RPM, so it
         * runs out after about 4.7 s at idle and about 1.1 s near 7,500 RPM.
         * When it ran out, the event stopped, and the old code only restarted
         * it once it had fully stopped. A freshly started event takes a moment
         * to make sound, so you heard a 50-150 ms hole.
         *
         * THE FIX: track how far through the sample we are (faster at high
         * RPM, using the timings measured below). Just before it runs out,
         * start a fresh copy and cross-fade from the old copy to the new one,
         * like a DJ mixing two records. That way the engine never goes quiet.
         * @private
         */
        _keepEngineAlive(dtMs) {
            if (!this.isRunning || !this.engineEvent) return;
            const F = window.FMOD;

            // 1. Fade out and free old copies from earlier hand-overs
            const HOLD_MS = 90, FADE_MS = 140;   // overlap first, then fade
            this._fading = this._fading.filter((f) => {
                f.age += dtMs;
                if (f.age < HOLD_MS) return true;
                const k = 1 - (f.age - HOLD_MS) / FADE_MS;
                if (k <= 0) {
                    f.inst.stop(F.STUDIO_STOP_IMMEDIATE);
                    f.inst.release();
                    return false;
                }
                f.inst.setVolume(this._volume * k);
                return true;
            });

            // 2. Advance our estimate of how much of the sample has played
            const rpm = this._readParam(this.engineEvent, 'RPM', this._currentRPM);
            this._progress += dtMs / FMODWrapper.sampleLifeMs(rpm);

            // 3. Near the end, or already stopping? Hand over to a fresh copy.
            const o = {};
            const state = this.engineEvent.getPlaybackState(o) === F.OK ? o.val : F.STUDIO_PLAYBACK_STOPPED;
            const stopping = state === F.STUDIO_PLAYBACK_STOPPING || state === F.STUDIO_PLAYBACK_STOPPED;
            if (this._progress >= 0.75 || stopping) {
                const fresh = this._createEngineInstance();
                if (!fresh) return;
                fresh.start();
                if (stopping) {
                    this.engineEvent.release();          // already silent, nothing to fade
                } else {
                    this._fading.push({ inst: this.engineEvent, age: 0 });
                }
                this.engineEvent = fresh;
                this._progress = 0;
                this._restarts++;
            }
        }

        /** Reads an event parameter's current value (after FMOD's smoothing). @private */
        _readParam(inst, name, fallback) {
            const v = {}, fv = {};
            if (inst.getParameterByName(name, v, fv) === window.FMOD.OK && typeof v.val === 'number') return v.val;
            return fallback;
        }

        /** Sends a parameter to the engine and to any copies still fading out. @private */
        _setEngineParam(name, value) {
            if (this.engineEvent) this.engineEvent.setParameterByName(name, value, false);
            for (const f of this._fading) f.inst.setParameterByName(name, value, false);
        }

        /**
         * Debug helper — logs all parameter names + ranges on a descriptor.
         * @private
         */
        _dumpParams(desc) {
            const F = window.FMOD;
            let countOut = {};
            if (desc.getParameterDescriptionCount(countOut) !== F.OK) return;
            const n = countOut.val || 0;
            console.log(`[FMOD] Engine event has ${n} parameter(s):`);
            for (let i = 0; i < n; i++) {
                let dOut = {};
                if (desc.getParameterDescriptionByIndex(i, dOut) === F.OK && dOut.val) {
                    const p = dOut.val;
                    console.log(`[FMOD]   [${i}] name="${p.name || '(unnamed)'}" min=${p.minimum} max=${p.maximum}`);
                }
            }
        }

        /* ──────────────────────────────────────────────────────────
           START — resumes AudioContext + starts engine event
           ────────────────────────────────────────────────────────── */
        start() {
            if (this.isRunning || !this.engineEvent) return;

            const F = window.FMOD;
            let coreOut = {};
            if (this.system.getCoreSystem(coreOut) !== F.OK) return;

            const coreSys = coreOut.val;
            window.__fmod_core_system = coreSys;
            coreSys.mixerResume();           // unblock suspended AudioContext

            // Listener at the origin, facing the engine (prevents 3D panner muting)
            if (coreSys.set3DListenerAttributes) {
                coreSys.set3DListenerAttributes(0,
                    { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 },
                    { x: 0, y: 0, z: 1 }, { x: 0, y: 1, z: 0 });
            }

            // If the tab was hidden or the laptop slept, the browser may pause
            // audio. Wake it up again when the page comes back.
            if (!this._resumeHooked) {
                this._resumeHooked = true;
                const resume = () => { try { coreSys.mixerResume(); } catch (e) { /* ignore */ } };
                document.addEventListener('visibilitychange', () => { if (!document.hidden) resume(); });
                window.addEventListener('focus', resume);
                window.addEventListener('pointerdown', resume);
            }

            this.engineEvent.start();
            this.isRunning = true;
            console.log('[FMOD] ▶ Engine event started');
        }

        /* ──────────────────────────────────────────────────────────
           setRPM — binds live RPM → FMOD "RPM" parameter
           ────────────────────────────────────────────────────────── */
        setRPM(rpm) {
            this._currentRPM = rpm;
            if (!this.engineEvent) return;

            // (Restarting a stopped engine is handled every frame in _tick.)
            this._setEngineParam('RPM', rpm);
        }

        /* ──────────────────────────────────────────────────────────
           setLoad — binds throttle → FMOD "LOAD" parameter
                     also auto-detects rapid throttle drops for burble
           ────────────────────────────────────────────────────────── */
        setLoad(load) {
            // Normalise 0-255 range → 0-1 if caller sends raw byte value
            let val = (typeof load === 'number' && load > 1.0) ? load / 255.0 : load;

            // ── Rapid-throttle-drop → backfire detection ──
            const now = performance.now();
            this._throttleHistory.push({ t: now, v: val });
            // Keep only the last 300ms of samples
            this._throttleHistory = this._throttleHistory.filter(s => now - s.t <= 300);

            if (this._throttleHistory.length >= 2) {
                const peak = Math.max(...this._throttleHistory.map(s => s.v));
                const drop = peak - val;
                // Fire backfire if throttle drops >= 0.35 while RPM is high
                if (this._currentRPM >= 3500 && drop >= 0.35) {
                    if (now - this._lastBackfireTime > 300) {
                        this.triggerBackfire();
                        this._lastBackfireTime = now;
                        // Reset history so we don't retrigger on same drop
                        this._throttleHistory = [{ t: now, v: val }];
                    }
                }
            }

            this._currentLoad = val;

            if (!this.engineEvent) return;
            this._setEngineParam('LOAD', val);
        }

        /* ──────────────────────────────────────────────────────────
           triggerShiftBlip — fires one-shot "event:/gear_ext"
           ────────────────────────────────────────────────────────── */
        triggerShiftBlip() {
            if (!this.gearDesc) return;

            const F = window.FMOD;
            let out = {};
            if (this.gearDesc.createInstance(out) === F.OK) {
                const inst = out.val;
                inst.start();
                inst.release();  // auto-frees when done
                console.log('[FMOD] 🔊 Gear shift one-shot fired');
            }
        }

        /* ──────────────────────────────────────────────────────────
           triggerBackfire — fires one-shot "event:/backfire_ext"
           ────────────────────────────────────────────────────────── */
        triggerBackfire() {
            if (!this.backfireDesc || this.fxMuted) return;

            const F = window.FMOD;
            let out = {};
            if (this.backfireDesc.createInstance(out) === F.OK) {
                const inst = out.val;
                inst.start();
                inst.release();
                console.log('[FMOD] 💥 Backfire one-shot fired');
            }
        }

        /* ──────────────────────────────────────────────────────────
           setVolume / isRunningStatus
           ────────────────────────────────────────────────────────── */
        setVolume(level) {
            this._volume = level;
            if (this.engineEvent) this.engineEvent.setVolume(level);
            // (copies that are fading out pick up the new level on the next frame)
        }

        isRunningStatus() {
            return this.isRunning;
        }

        /* ──────────────────────────────────────────────────────────
           _tick — FMOD Studio update loop (must run every frame)
           ────────────────────────────────────────────────────────── */
        _tick() {
            if (this.system) {
                const now = performance.now();
                const dt = this._lastTickTime ? Math.min(now - this._lastTickTime, 1000) : 16;
                this._lastTickTime = now;
                this._keepEngineAlive(dt);
                this.system.update();
                // A timer instead of requestAnimationFrame: rAF stops completely
                // when the tab is in the background, which froze FMOD too.
                setTimeout(() => this._tick(), 16);
            }
        }
    }

    /**
     * How long one play-through of the engine sample lasts at a given RPM,
     * in ms. Measured by holding each RPM steady and timing when FMOD
     * stopped the event. Values in between are interpolated.
     */
    const SAMPLE_LIFE = [
        [800, 4742], [2400, 4742], [2800, 3559], [3200, 2976], [3600, 2559],
        [4000, 2259], [4400, 2009], [4800, 1809], [5200, 1676], [5600, 1509],
        [6000, 1426], [6400, 1343], [6800, 1243], [7200, 1159], [7600, 1093],
        [7800, 1093], [8000, 1376], [9200, 1376], [9600, 1593], [10000, 1593],
    ];
    /** Master level for all FMOD sounds (1.0 = as authored, which clips). */
    FMODWrapper.MASTER_VOLUME = 0.25;

    FMODWrapper.sampleLifeMs = function (rpm) {
        if (rpm <= SAMPLE_LIFE[0][0]) return SAMPLE_LIFE[0][1];
        for (let i = 1; i < SAMPLE_LIFE.length; i++) {
            const [r1, l1] = SAMPLE_LIFE[i];
            if (rpm <= r1) {
                const [r0, l0] = SAMPLE_LIFE[i - 1];
                return l0 + (l1 - l0) * (rpm - r0) / (r1 - r0);
            }
        }
        return SAMPLE_LIFE[SAMPLE_LIFE.length - 1][1];
    };

    return FMODWrapper;
})();
