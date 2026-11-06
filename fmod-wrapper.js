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

            // ── Resolve event descriptors via clean string paths ──

            // 1. engine_ext — continuous, looping engine sound
            r = this.system.getEvent('event:/engine_ext', out);
            if (r === F.OK && out.val) {
                this.engineDesc = out.val;
                console.log('[FMOD] ✓ Resolved event:/engine_ext');

                r = this.engineDesc.createInstance(out);
                if (r === F.OK) {
                    this.engineEvent = out.val;
                    console.log('[FMOD]   → Engine instance created');
                } else {
                    console.error('[FMOD]   ✗ createInstance for engine failed: ' + r);
                }
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

            // Safely initialize 3D attributes to prevent 3D panner muting (NaN crash)
            const attr = {
                position: { x: 0, y: 0, z: 0 },
                velocity: { x: 0, y: 0, z: 0 },
                forward: { x: 0, y: 0, z: 1 },
                up: { x: 0, y: 1, z: 0 }
            };
            this.engineEvent.set3DAttributes(attr);
            if (coreSys.set3DListenerAttributes) {
                coreSys.set3DListenerAttributes(0, attr.position, attr.velocity, attr.forward, attr.up);
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

            const F = window.FMOD;
            let stateOut = {};
            if (this.engineEvent.getPlaybackState(stateOut) === F.OK) {
                // 2 = FMOD_STUDIO_PLAYBACK_STOPPED
                if (stateOut.val === 2 || stateOut.val === F.STUDIO_PLAYBACK_STOPPED) {
                    this.engineEvent.start();
                }
            }

            this.engineEvent.setParameterByName('RPM', rpm, false);
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
            this.engineEvent.setParameterByName('LOAD', val, false);
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
            if (!this.backfireDesc) return;

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
            if (this.engineEvent) this.engineEvent.setVolume(level);
        }

        isRunningStatus() {
            return this.isRunning;
        }

        /* ──────────────────────────────────────────────────────────
           _tick — FMOD Studio update loop (must run every frame)
           ────────────────────────────────────────────────────────── */
        _tick() {
            if (this.system) {
                this.system.update();
                requestAnimationFrame(() => this._tick());
            }
        }
    }

    return FMODWrapper;
})();
