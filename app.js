/* ═══════════════════════════════════════════════════════════════
   PORSCHE GT3 RS VIRTUAL COCKPIT — Core Application Logic
   ═══════════════════════════════════════════════════════════════
   Handles: WebSocket communication, tachometer rendering,
   touch controls, telemetry display, demo simulation mode.
   Target: Samsung Galaxy S24 Ultra (3120×1440 landscape)
   ═══════════════════════════════════════════════════════════════ */

(function () {
    'use strict';

    /* ══════════════════════════════════════════════════════════
       CONFIGURATION
       ══════════════════════════════════════════════════════════ */
    const CONFIG = {
        // ── WebSocket ──
        WS_URL_KEY: 'porsche_ws_url',
        WS_DEFAULT: 'ws://192.168.4.1:81',
        RECONNECT_BASE_MS: 1000,
        RECONNECT_MAX_MS: 8000,
        DEMO_AFTER_ATTEMPTS: 3,

        // ── Background Image (native 3120×1440) ──
        BG_WIDTH: 3120,
        BG_HEIGHT: 1440,

        // ── Tachometer Geometry (% of background image) ──
        TACH_CENTER_X_PCT: 50.0,
        TACH_CENTER_Y_PCT: 53.0,
        TACH_RADIUS_PCT: 19.0,
        NEEDLE_START_DEG: 150,
        NEEDLE_SWEEP_DEG: 240,
        NEEDLE_LERP: 0.12,
        MAX_RPM: 10000,
        REDLINE_RPM: 9000,

        // ── Gear Display (% of background image) ──
        GEAR_X_PCT: 49.8,
        GEAR_Y_PCT: 79.5,

        // ── RPM Readout (% of background image) ──
        RPM_X_PCT: 49.8,
        RPM_Y_PCT: 84.5,

        // ── Touch Zone Definitions (% of background image) ──
        ZONES: {
            steerLeft:  { x: 0.5,  y: 0,    w: 13,  h: 32 },
            steerRight: { x: 86.5, y: 0,    w: 13,  h: 32 },
            shiftDown:  { x: 23,   y: 24,   w: 13,  h: 42 },
            shiftUp:    { x: 64,   y: 24,   w: 13,  h: 42 },
            brake:      { x: 2,    y: 48,   w: 14,  h: 50 },
            throttle:   { x: 84,   y: 48,   w: 14,  h: 50 },
        },

        // ── Timing ──
        SHIFT_DEBOUNCE_MS: 120,
        PEDAL_SEND_INTERVAL_MS: 16,
    };


    /* ══════════════════════════════════════════════════════════
       UTILITY
       ══════════════════════════════════════════════════════════ */

    function getImageBounds() {
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const imgAspect = CONFIG.BG_WIDTH / CONFIG.BG_HEIGHT;
        const screenAspect = vw / vh;
        let imgW, imgH, offsetX, offsetY;

        if (screenAspect >= imgAspect) {
            imgW = vw;
            imgH = vw / imgAspect;
            offsetX = 0;
            offsetY = (vh - imgH) / 2;
        } else {
            imgH = vh;
            imgW = vh * imgAspect;
            offsetX = (vw - imgW) / 2;
            offsetY = 0;
        }
        return { imgW, imgH, offsetX, offsetY };
    }

    function tryUnlockAudio(app) {
        if (app && app.engineAudio) {
            try { app.engineAudio.start(); } catch (e) {}
        }
        if (window.__fmod_core_system) {
            try { window.__fmod_core_system.mixerResume(); } catch (e) {}
        }
    }

    function imgToViewport(xPct, yPct) {
        const { imgW, imgH, offsetX, offsetY } = getImageBounds();
        return {
            x: offsetX + (xPct / 100) * imgW,
            y: offsetY + (yPct / 100) * imgH,
        };
    }

    function imgSizeToViewport(wPct, hPct) {
        const { imgW, imgH } = getImageBounds();
        return {
            w: (wPct / 100) * imgW,
            h: (hPct / 100) * imgH,
        };
    }

    function degToRad(deg) { return deg * Math.PI / 180; }
    function lerp(a, b, t) { return a + (b - a) * t; }
    function clamp(val, min, max) { return Math.max(min, Math.min(max, val)); }

    /**
     * Adds BOTH mouse and touch listeners to an element for cross-device support.
     * Returns a cleanup function.
     */
    function addPointerListeners(el, handlers) {
        const opts = { passive: false };

        // Touch events
        if (handlers.touchstart)  el.addEventListener('touchstart',  handlers.touchstart,  opts);
        if (handlers.touchmove)   el.addEventListener('touchmove',   handlers.touchmove,   opts);
        if (handlers.touchend)    el.addEventListener('touchend',    handlers.touchend,    opts);
        if (handlers.touchcancel) el.addEventListener('touchcancel', handlers.touchcancel, opts);

        // Mouse fallbacks (for desktop testing)
        if (handlers.mousedown)  el.addEventListener('mousedown',  handlers.mousedown,  opts);
        if (handlers.mousemove)  el.addEventListener('mousemove',  handlers.mousemove,  opts);
        if (handlers.mouseup)    el.addEventListener('mouseup',    handlers.mouseup,    opts);
        if (handlers.mouseleave) el.addEventListener('mouseleave', handlers.mouseleave, opts);
    }


    /* ══════════════════════════════════════════════════════════
       WEBSOCKET MANAGER
       ══════════════════════════════════════════════════════════ */
    class WSManager {
        constructor(url) {
            this.url = url;
            this.ws = null;
            this.isConnected = false;
            this.reconnectAttempts = 0;
            this.reconnectTimer = null;
            this.onTelemetryCb = null;
            this.onStatusChangeCb = null;
            this._lastSendTime = {};   // per command (THROTTLE / BRAKE), so one pedal can't block the other
            this._stopped = false;
        }

        onTelemetry(cb) { this.onTelemetryCb = cb; }
        onStatusChange(cb) { this.onStatusChangeCb = cb; }

        setURL(url) {
            this.url = url;
            this.disconnect();          // closes the old socket (sets _stopped = true)
            this._stopped = false;      // ...so allow reconnecting AFTER that, not before
            this.reconnectAttempts = 0;
            this.connect();
        }

        connect() {
            if (this._stopped) return;
            if (this.ws && (this.ws.readyState === WebSocket.CONNECTING ||
                            this.ws.readyState === WebSocket.OPEN)) {
                return;
            }

            try {
                console.log(`[WS] Connecting to ${this.url} (attempt ${this.reconnectAttempts + 1})...`);
                this.ws = new WebSocket(this.url);

                this.ws.onopen = () => {
                    console.log("Connected to GT3 RS ESP32!");
                    this.isConnected = true;
                    this.reconnectAttempts = 0;
                    if (this.onStatusChangeCb) this.onStatusChangeCb(true);
                };

                this.ws.onclose = (e) => {
                    console.log(`[WS] Closed (code: ${e.code})`);
                    this.isConnected = false;
                    if (this.onStatusChangeCb) this.onStatusChangeCb(false);
                    if (!this._stopped) this._scheduleReconnect();
                };

                this.ws.onerror = (error) => {
                    console.error("WebSocket Error:", error);
                };

                this.ws.onmessage = (event) => {
                    try {
                        const data = JSON.parse(event.data);
                        if (this.onTelemetryCb) this.onTelemetryCb(data);
                    } catch (err) {
                        console.warn('[WS] Parse error:', event.data);
                    }
                };
            } catch (err) {
                console.error('[WS] Connection failed:', err);
                if (!this._stopped) this._scheduleReconnect();
            }
        }

        disconnect() {
            this._stopped = true;
            clearTimeout(this.reconnectTimer);
            if (this.ws) {
                this.ws.onclose = null;
                this.ws.onerror = null;
                try { this.ws.close(); } catch (e) { /* ignore */ }
                this.ws = null;
            }
            this.isConnected = false;
        }

        send(token) {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(token);
            }
            // Always log for debugging even when not connected
            console.log(`[WS→] ${token}`);
        }

        sendThrottled(token) {
            const now = performance.now();
            const key = token.split(':')[0];
            if (now - (this._lastSendTime[key] || 0) >= CONFIG.PEDAL_SEND_INTERVAL_MS) {
                this.send(token);
                this._lastSendTime[key] = now;
            }
        }

        getAttempts() { return this.reconnectAttempts; }

        /** @private */
        _scheduleReconnect() {
            if (this._stopped) return;
            this.reconnectAttempts++;
            const delay = Math.min(
                CONFIG.RECONNECT_BASE_MS * Math.pow(1.5, this.reconnectAttempts - 1),
                CONFIG.RECONNECT_MAX_MS
            );
            console.log(`[WS] Reconnect in ${Math.round(delay)}ms (attempt ${this.reconnectAttempts})`);
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = setTimeout(() => {
                if (!this._stopped) this.connect();
            }, delay);

            // Notify app of the attempt count for demo auto-start
            if (this.onStatusChangeCb) this.onStatusChangeCb(false);
        }
    }


    /* ══════════════════════════════════════════════════════════
       TACHOMETER RENDERER
       ══════════════════════════════════════════════════════════ */
    class TachometerRenderer {
        constructor(canvas) {
            this.canvas = canvas;
            this.ctx = canvas.getContext('2d');
            this.currentAngleDeg = CONFIG.NEEDLE_START_DEG;
            this.targetAngleDeg = CONFIG.NEEDLE_START_DEG;
            this.currentRPM = 0;

            this.resolution = 600;
            this.canvas.width = this.resolution;
            this.canvas.height = this.resolution;
            this.centerX = this.resolution / 2;
            this.centerY = this.resolution / 2;
            this.needleLength = this.resolution * 0.42;
            this.needleBaseWidth = 6;
            this.needleTipWidth = 1.5;
        }

        setRPM(rpm) {
            this.currentRPM = clamp(rpm, 0, CONFIG.MAX_RPM);
            this.targetAngleDeg = CONFIG.NEEDLE_START_DEG +
                (this.currentRPM / CONFIG.MAX_RPM) * CONFIG.NEEDLE_SWEEP_DEG;
        }

        layout() {
            const center = imgToViewport(CONFIG.TACH_CENTER_X_PCT, CONFIG.TACH_CENTER_Y_PCT);
            const { imgW } = getImageBounds();
            const radiusPx = (CONFIG.TACH_RADIUS_PCT / 100) * imgW;
            const size = radiusPx * 2;

            this.canvas.style.left = (center.x - radiusPx) + 'px';
            this.canvas.style.top = (center.y - radiusPx) + 'px';
            this.canvas.style.width = size + 'px';
            this.canvas.style.height = size + 'px';
        }

        render() {
            this.currentAngleDeg = lerp(
                this.currentAngleDeg,
                this.targetAngleDeg,
                CONFIG.NEEDLE_LERP
            );

            const ctx = this.ctx;
            const cx = this.centerX;
            const cy = this.centerY;
            const angleRad = degToRad(this.currentAngleDeg);

            ctx.clearRect(0, 0, this.resolution, this.resolution);

            const inRedline = this.currentRPM >= CONFIG.REDLINE_RPM;
            const needleColor = inRedline ? '#FF2020' : '#FF5722';
            const glowColor = inRedline
                ? 'rgba(255, 32, 32, 0.9)'
                : 'rgba(255, 87, 34, 0.7)';
            const glowSize = inRedline ? 25 : 15;

            // Draw needle
            ctx.save();
            ctx.translate(cx, cy);
            ctx.rotate(angleRad);

            ctx.shadowColor = glowColor;
            ctx.shadowBlur = glowSize;

            ctx.beginPath();
            ctx.moveTo(0, -this.needleBaseWidth / 2);
            ctx.lineTo(this.needleLength, -this.needleTipWidth / 2);
            ctx.lineTo(this.needleLength, this.needleTipWidth / 2);
            ctx.lineTo(0, this.needleBaseWidth / 2);
            ctx.closePath();

            const grad = ctx.createLinearGradient(0, 0, this.needleLength, 0);
            grad.addColorStop(0, needleColor);
            grad.addColorStop(0.7, needleColor);
            grad.addColorStop(1, inRedline ? '#FF6666' : '#FFAB91');
            ctx.fillStyle = grad;
            ctx.fill();

            // Counter-weight
            ctx.shadowBlur = 0;
            ctx.beginPath();
            ctx.moveTo(0, -4);
            ctx.lineTo(-this.needleLength * 0.12, -2);
            ctx.lineTo(-this.needleLength * 0.12, 2);
            ctx.lineTo(0, 4);
            ctx.closePath();
            ctx.fillStyle = '#888';
            ctx.fill();

            ctx.restore();

            // Center hub
            ctx.save();
            ctx.shadowColor = 'rgba(0,0,0,0.5)';
            ctx.shadowBlur = 10;

            const hubGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, 14);
            hubGrad.addColorStop(0, '#DDD');
            hubGrad.addColorStop(0.4, '#BBB');
            hubGrad.addColorStop(0.8, '#888');
            hubGrad.addColorStop(1, '#555');

            ctx.beginPath();
            ctx.arc(cx, cy, 14, 0, Math.PI * 2);
            ctx.fillStyle = hubGrad;
            ctx.fill();

            ctx.strokeStyle = 'rgba(255,255,255,0.15)';
            ctx.lineWidth = 1;
            ctx.stroke();
            ctx.restore();
        }
    }


    /* ══════════════════════════════════════════════════════════
       TOUCH CONTROLLER — with mouse fallback for desktop
       ══════════════════════════════════════════════════════════ */
    class TouchController {
        constructor(wsManager, app) {
            this.ws = wsManager;
            this.app = app;

            this.zones = {
                steerLeft:  document.getElementById('zone-steer-left'),
                steerRight: document.getElementById('zone-steer-right'),
                shiftDown:  document.getElementById('zone-shift-down'),
                shiftUp:    document.getElementById('zone-shift-up'),
                brake:      document.getElementById('zone-brake'),
                throttle:   document.getElementById('zone-throttle'),
            };

            this._lastShiftTime = 0;
            this.layout();
            this._init();
        }

        layout() {
            for (const [key, zone] of Object.entries(this.zones)) {
                const def = CONFIG.ZONES[key];
                if (!def) continue;
                const pos = imgToViewport(def.x, def.y);
                const size = imgSizeToViewport(def.w, def.h);
                zone.style.left = pos.x + 'px';
                zone.style.top = pos.y + 'px';
                zone.style.width = size.w + 'px';
                zone.style.height = size.h + 'px';
            }
        }

        _init() {
            // ── Steering: hold buttons ──
            this._initHoldButton(this.zones.steerLeft, 'STEER:-255', 'STEER:0');
            this._initHoldButton(this.zones.steerRight, 'STEER:255', 'STEER:0');

            // ── Paddle shifters: tap ──
            this._initTapButton(this.zones.shiftDown, () => {
                if (this._shiftDebounce()) return;
                this.ws.send('SHIFT_DOWN');
                this.app.localShift(-1);
            });

            this._initTapButton(this.zones.shiftUp, () => {
                if (this._shiftDebounce()) return;
                this.ws.send('SHIFT_UP');
                this.app.localShift(1);
            });

            // ── Pedals: vertical drag ──
            this._initDragPedal(this.zones.throttle, 'throttle');
            this._initDragPedal(this.zones.brake, 'brake');
        }

        /**
         * Hold button — sends pressToken on press, releaseToken on release.
         * Works with both touch and mouse.
         */
        _initHoldButton(el, pressToken, releaseToken) {
            let isActive = false;
            let touchId = null;

            const activate = () => {
                if (isActive) return;
                isActive = true;
                el.classList.add('active');
                this.ws.send(pressToken);
            };

            const deactivate = () => {
                if (!isActive) return;
                isActive = false;
                touchId = null;
                el.classList.remove('active');
                this.ws.send(releaseToken);
            };

            addPointerListeners(el, {
                touchstart: (e) => {
                    e.preventDefault();
                    tryUnlockAudio(this.app);
                    touchId = e.changedTouches[0].identifier;
                    activate();
                },
                touchend: (e) => {
                    e.preventDefault();
                    for (const t of e.changedTouches) {
                        if (t.identifier === touchId) {
                            deactivate();
                            break;
                        }
                    }
                },
                touchcancel: () => deactivate(),

                mousedown: (e) => {
                    e.preventDefault();
                    tryUnlockAudio(this.app);
                    activate();
                    // Listen on window for mouseup in case cursor leaves element
                    const onUp = () => {
                        deactivate();
                        window.removeEventListener('mouseup', onUp);
                    };
                    window.addEventListener('mouseup', onUp);
                },
            });
        }

        /**
         * Tap button — fires callback on press.
         * Works with both touch and mouse.
         */
        _initTapButton(el, callback) {
            const doTap = () => {
                // Visual flash
                el.classList.add('shift-flash');
                setTimeout(() => el.classList.remove('shift-flash'), 150);
                callback();
            };

            addPointerListeners(el, {
                touchstart: (e) => {
                    e.preventDefault();
                    tryUnlockAudio(this.app);
                    doTap();
                },
                mousedown: (e) => {
                    e.preventDefault();
                    tryUnlockAudio(this.app);
                    doTap();
                },
            });
        }

        /**
         * Drag pedal — vertical drag sends proportional values.
         * Works with both touch and mouse.
         */
        _initDragPedal(el, type) {
            const isThrottle = type === 'throttle';
            const barEl = document.getElementById(isThrottle ? 'throttle-bar' : 'brake-bar');
            let touchId = null;
            let isMouseActive = false;

            const applyValue = (clientY) => {
                const rect = el.getBoundingClientRect();
                let pct = 1.0;
                if (rect.height > 0) {
                    pct = clamp((rect.bottom - clientY) / rect.height, 0.35, 1.0);
                }
                const value = Math.round(pct * 255);

                if (isThrottle) {
                    this.ws.sendThrottled(`THROTTLE:${value}`);
                    this.app.localThrottle(value);
                } else {
                    this.ws.sendThrottled(`BRAKE:${value}`);
                    this.app.localBrake(value);
                }

                if (barEl) barEl.style.height = (pct * 100) + '%';
            };

            const release = () => {
                el.classList.remove('active');
                if (barEl) barEl.style.height = '0%';
                touchId = null;
                isMouseActive = false;

                if (isThrottle) {
                    this.ws.send('THROTTLE:0');
                    this.app.localThrottle(0);
                } else {
                    this.ws.send('BRAKE:0');
                    this.app.localBrake(0);
                }
            };

            // ── Touch handlers ──
            addPointerListeners(el, {
                touchstart: (e) => {
                    e.preventDefault();
                    tryUnlockAudio(this.app);
                    const touch = e.changedTouches[0];
                    touchId = touch.identifier;
                    el.classList.add('active');
                    applyValue(touch.clientY);
                },
                touchmove: (e) => {
                    e.preventDefault();
                    for (const touch of e.changedTouches) {
                        if (touch.identifier === touchId) {
                            applyValue(touch.clientY);
                            break;
                        }
                    }
                },
                touchend: (e) => {
                    e.preventDefault();
                    for (const touch of e.changedTouches) {
                        if (touch.identifier === touchId) {
                            release();
                            break;
                        }
                    }
                },
                touchcancel: () => release(),

                // ── Mouse handlers ──
                mousedown: (e) => {
                    e.preventDefault();
                    tryUnlockAudio(this.app);
                    isMouseActive = true;
                    el.classList.add('active');
                    applyValue(e.clientY);

                    const onMove = (me) => {
                        if (!isMouseActive) return;
                        me.preventDefault();
                        applyValue(me.clientY);
                    };
                    const onUp = () => {
                        if (isMouseActive) release();
                        window.removeEventListener('mousemove', onMove);
                        window.removeEventListener('mouseup', onUp);
                    };
                    window.addEventListener('mousemove', onMove);
                    window.addEventListener('mouseup', onUp);
                },
            });
        }

        _shiftDebounce() {
            const now = performance.now();
            if (now - this._lastShiftTime < CONFIG.SHIFT_DEBOUNCE_MS) return true;
            this._lastShiftTime = now;
            return false;
        }
    }


    /* ══════════════════════════════════════════════════════════
       KEYBOARD CONTROLLER — W/S/A/D + Arrow keys for desktop
       ══════════════════════════════════════════════════════════ */
    class KeyboardController {
        constructor(app) {
            this.app = app;
            this.activeKeys = new Set();
            this._init();
        }

        _init() {
            window.addEventListener('keydown', (e) => {
                if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
                const key = e.key.toLowerCase();
                if (this.activeKeys.has(key)) return;
                this.activeKeys.add(key);

                tryUnlockAudio(this.app);

                if (key === 'w' || e.key === 'ArrowUp') {
                    this.app.wsManager.send('THROTTLE:255');
                    this.app.localThrottle(255);
                    this._setPedalBar('throttle', 100);
                } else if (key === 's' || e.key === 'ArrowDown') {
                    this.app.wsManager.send('BRAKE:255');
                    this.app.localBrake(255);
                    this._setPedalBar('brake', 100);
                } else if (key === 'a' || e.key === 'ArrowLeft') {
                    this.app.wsManager.send('STEER:-255');
                } else if (key === 'd' || e.key === 'ArrowRight') {
                    this.app.wsManager.send('STEER:255');
                } else if (key === 'e' || key === 'shift' || e.key === '.') {
                    this.app.wsManager.send('SHIFT_UP');
                    this.app.localShift(1);
                } else if (key === 'q' || key === 'control' || e.key === ',') {
                    this.app.wsManager.send('SHIFT_DOWN');
                    this.app.localShift(-1);
                }
            });

            window.addEventListener('keyup', (e) => {
                if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
                const key = e.key.toLowerCase();
                this.activeKeys.delete(key);

                if (key === 'w' || e.key === 'ArrowUp') {
                    this.app.wsManager.send('THROTTLE:0');
                    this.app.localThrottle(0);
                    this._setPedalBar('throttle', 0);
                } else if (key === 's' || e.key === 'ArrowDown') {
                    this.app.wsManager.send('BRAKE:0');
                    this.app.localBrake(0);
                    this._setPedalBar('brake', 0);
                } else if (key === 'a' || e.key === 'ArrowLeft' || key === 'd' || e.key === 'ArrowRight') {
                    this.app.wsManager.send('STEER:0');
                }
            });

            // If the window loses focus while a key is held, the browser never
            // sends the keyup, so the car would keep driving. Stop it instead.
            window.addEventListener('blur', () => this._releaseAll());
            document.addEventListener('visibilitychange', () => {
                if (document.hidden) this._releaseAll();
            });
        }

        /** Lets go of every held key, e.g. when you alt-tab away mid-drive. */
        _releaseAll() {
            if (this.activeKeys.size === 0) return;
            this.activeKeys.clear();
            this.app.wsManager.send('THROTTLE:0');
            this.app.wsManager.send('BRAKE:0');
            this.app.wsManager.send('STEER:0');
            this.app.localThrottle(0);
            this.app.localBrake(0);
            this._setPedalBar('throttle', 0);
            this._setPedalBar('brake', 0);
        }

        _setPedalBar(type, pct) {
            const isThrottle = type === 'throttle';
            const barEl = document.getElementById(isThrottle ? 'throttle-bar' : 'brake-bar');
            if (barEl) barEl.style.height = pct + '%';
        }
    }


    /* ══════════════════════════════════════════════════════════
       TELEMETRY DISPLAY
       ══════════════════════════════════════════════════════════ */
    class TelemetryDisplay {
        constructor() {
            this.gearEl = document.getElementById('gear-display');
            this.rpmEl = document.getElementById('rpm-readout');
            this.vignetteEl = document.getElementById('redline-vignette');
            this.currentGear = 'N';
            this._flashTimeout = null;
        }

        layout() {
            const gearPos = imgToViewport(CONFIG.GEAR_X_PCT, CONFIG.GEAR_Y_PCT);
            this.gearEl.style.left = gearPos.x + 'px';
            this.gearEl.style.top = gearPos.y + 'px';
            this.gearEl.style.transform = 'translate(-50%, -50%)';

            const rpmPos = imgToViewport(CONFIG.RPM_X_PCT, CONFIG.RPM_Y_PCT);
            this.rpmEl.style.left = rpmPos.x + 'px';
            this.rpmEl.style.top = rpmPos.y + 'px';
            this.rpmEl.style.transform = 'translate(-50%, -50%)';
        }

        updateGear(gear) {
            if (gear === this.currentGear) return;
            this.currentGear = gear;
            this.gearEl.textContent = gear;
            this.gearEl.classList.toggle('reverse', gear === 'R');

            clearTimeout(this._flashTimeout);
            this.gearEl.classList.add('flash');
            this._flashTimeout = setTimeout(() => {
                this.gearEl.classList.remove('flash');
            }, 150);
        }

        updateRPM(rpm) {
            const displayRPM = Math.round(rpm / 100) * 100;
            this.rpmEl.textContent = displayRPM.toLocaleString();
            const inRedline = rpm >= CONFIG.REDLINE_RPM;
            this.rpmEl.classList.toggle('redline', inRedline);
            this.vignetteEl.classList.toggle('active', inRedline);
        }
    }


    /* ══════════════════════════════════════════════════════════
       DEMO MODE
       ══════════════════════════════════════════════════════════ */
    class DemoMode {
        constructor(app) {
            this.app = app;
            this.active = false;
            this.rpm = 800;
            this.gear = 'N';
            this.gearIndex = 1;       // Index into GEAR_ORDER: 0=R, 1=N, 2=1, ...
            this.throttleInput = 0;
            this.brakeInput = 0;
            this._animFrame = null;
            this._lastTime = 0;

            this.gearRatios = {
                'N': { idle: 800, max: 9000, accel: 12000 },
                '1': { idle: 800, max: 9000, accel: 8000 },
                '2': { idle: 2000, max: 9000, accel: 6500 },
                '3': { idle: 2500, max: 9200, accel: 5500 },
                '4': { idle: 3000, max: 9500, accel: 4500 },
                '5': { idle: 3500, max: 9800, accel: 3800 },
                '6': { idle: 4000, max: 10000, accel: 3200 },
                'R': { idle: 800, max: 5000, accel: 5000 },
            };
        }

        start() {
            if (this.active) return;
            this.active = true;
            this.rpm = 800;
            this.gear = 'N';
            this.gearIndex = 1;
            this._lastTime = performance.now();
            document.getElementById('demo-badge').classList.remove('hidden');
            console.log('[DEMO] ▶ Simulation mode activated');
            this._tick();
        }

        stop() {
            this.active = false;
            if (this._animFrame) {
                cancelAnimationFrame(this._animFrame);
                this._animFrame = null;
            }
            document.getElementById('demo-badge').classList.add('hidden');
            console.log('[DEMO] ■ Simulation mode stopped');
        }

        setThrottle(value) {
            this.throttleInput = value / 255;
        }

        setBrake(value) {
            this.brakeInput = value / 255;
        }

        /**
         * Shift gears in demo mode.
         * @param {number} direction - +1 for upshift, -1 for downshift
         */
        shift(direction) {
            const GEAR_ORDER = ['R', 'N', '1', '2', '3', '4', '5', '6'];
            this.gearIndex = clamp(this.gearIndex + direction, 0, GEAR_ORDER.length - 1);
            this.gear = GEAR_ORDER[this.gearIndex];
            console.log(`[DEMO] Gear → ${this.gear}`);
        }

        _tick() {
            if (!this.active) return;

            const now = performance.now();
            const dt = Math.min((now - this._lastTime) / 1000, 0.1);
            this._lastTime = now;

            const gearSpec = this.gearRatios[this.gear] || this.gearRatios['N'];

            if (this.throttleInput > 0.05) {
                const targetRPM = gearSpec.idle + (gearSpec.max - gearSpec.idle) * this.throttleInput;
                const accelRate = gearSpec.accel * this.throttleInput;
                this.rpm = Math.min(targetRPM, this.rpm + accelRate * dt);
            } else if (this.brakeInput > 0.05) {
                this.rpm = Math.max(gearSpec.idle, this.rpm - 5000 * this.brakeInput * dt);
            } else {
                this.rpm = Math.max(gearSpec.idle, this.rpm - 2000 * dt);
            }

            this.rpm = clamp(this.rpm, 0, CONFIG.MAX_RPM);

            // Push telemetry to the app including current throttle load
            this.app.onTelemetry({ 
                rpm: Math.round(this.rpm), 
                gear: this.gear, 
                throttle: Math.round(this.throttleInput * 255) 
            });

            this._animFrame = requestAnimationFrame(() => this._tick());
        }
    }


    /* ══════════════════════════════════════════════════════════
       SETTINGS PANEL
       ══════════════════════════════════════════════════════════ */
    class SettingsPanel {
        constructor(app) {
            this.app = app;
            this.overlay = document.getElementById('settings-overlay');
            this.urlInput = document.getElementById('ws-url-input');
            this.statusDot = document.getElementById('settings-status-dot');
            this.statusText = document.getElementById('settings-status-text');

            const saved = localStorage.getItem(CONFIG.WS_URL_KEY);
            this.urlInput.value = saved || CONFIG.WS_DEFAULT;

            document.getElementById('btn-settings').addEventListener('click', (e) => {
                e.stopPropagation();
                this.open();
            });
            document.getElementById('btn-close-settings').addEventListener('click', () => this.close());
            document.getElementById('btn-connect').addEventListener('click', () => this.connect());
            document.getElementById('btn-demo').addEventListener('click', () => {
                this.close();
                this.app.startDemoMode();
            });

            this.urlInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') this.connect();
            });

            // Close overlay when clicking outside the panel
            this.overlay.addEventListener('click', (e) => {
                if (e.target === this.overlay) this.close();
            });
        }

        open() {
            this.overlay.classList.remove('hidden');
            this.updateStatus(this.app.wsManager.isConnected);
        }

        close() {
            this.overlay.classList.add('hidden');
        }

        connect() {
            const url = this.urlInput.value.trim();
            if (!url) return;
            localStorage.setItem(CONFIG.WS_URL_KEY, url);
            this.app.wsManager.setURL(url);
            this.statusText.textContent = 'Connecting...';
            this.close();
        }

        updateStatus(connected) {
            this.statusDot.classList.toggle('connected', connected);
            this.statusText.textContent = connected ? 'Connected (ESP32)' : 'Not connected';
        }
    }


    /* ══════════════════════════════════════════════════════════
       MAIN APPLICATION
       ══════════════════════════════════════════════════════════ */
    class App {
        constructor() {
            this.wsManager = new WSManager(
                localStorage.getItem(CONFIG.WS_URL_KEY) || CONFIG.WS_DEFAULT
            );
            this.tachRenderer = new TachometerRenderer(
                document.getElementById('needle-canvas')
            );
            this.telemetryDisplay = new TelemetryDisplay();
            this.demoMode = new DemoMode(this);
            this.touchController = null;
            this.settingsPanel = null;
            this.engineAudio = new window.AudioManager();

            this.currentGear = 'N';
            this.currentRPM = 0;
            this.gearSequence = ['R', 'N', '1', '2', '3', '4', '5', '6'];
            this.gearIndex = 1; // N
            this._running = false;
            this._demoAutoStarted = false;
            this._splashDismissed = false;
            this._startupActive = false;

            this.connDot = document.getElementById('connection-dot');
            this.connText = document.getElementById('connection-text');
        }

        init() {
            console.log('[APP] GT3 RS Virtual Cockpit initializing...');

            this._layout();

            window.addEventListener('resize', () => this._layout());
            if (screen.orientation) {
                screen.orientation.addEventListener('change', () => {
                    setTimeout(() => this._layout(), 100);
                });
            }

            this.touchController = new TouchController(this.wsManager, this);
            this.keyboardController = new KeyboardController(this);
            this.settingsPanel = new SettingsPanel(this);

            // Unlock audio on any initial gesture
            const unlockAudio = () => tryUnlockAudio(this);
            window.addEventListener('touchstart', unlockAudio, { passive: true });
            window.addEventListener('mousedown', unlockAudio);
            window.addEventListener('keydown', unlockAudio);

            // Initialize Audio system asynchronously
            this.engineAudio.init();

            this.wsManager.onTelemetry((data) => this.onTelemetry(data));
            this.wsManager.onStatusChange((connected) => this._onConnectionChange(connected));

            this._initSplash();

            // Start render loop
            this._running = true;
            this._renderLoop();

            // Try connecting (after a short delay so splash shows first)
            setTimeout(() => this.wsManager.connect(), 500);

            console.log('[APP] Initialization complete');
        }

        onTelemetry(data) {
            if (this._startupActive) return; // Block telemetry during startup sequence
            
            if (data.rpm !== undefined) {
                this.currentRPM = data.rpm;
                this.tachRenderer.setRPM(data.rpm);
                this.telemetryDisplay.updateRPM(data.rpm);

                if (this.engineAudio) {
                    if (!this.engineAudio.isRunning()) {
                        this.engineAudio.start();
                    }
                    this.engineAudio.setRPM(data.rpm);
                    if (data.throttle !== undefined) {
                        this.engineAudio.setLoad(data.throttle / 255.0);
                    }
                }
            }

            if (data.gear !== undefined) {
                const oldGear = this.currentGear;
                this.currentGear = data.gear;

                // Sync gearIndex
                const idx = this.gearSequence.indexOf(data.gear);
                if (idx >= 0) this.gearIndex = idx;

                this.telemetryDisplay.updateGear(data.gear);

                if (oldGear !== data.gear && this.engineAudio && this.engineAudio.isRunning()) {
                    this.engineAudio.triggerShiftBlip();
                }
            }
        }

        /**
         * Handle gear shift from touch input.
         * In demo mode, delegates to DemoMode.shift() which updates gearIndex.
         * In live mode, sends WS token and does optimistic local update.
         */
        localShift(direction) {
            if (!this.wsManager.isConnected && !this.demoMode.active) {
                this.demoMode.start();
            }
            if (this.demoMode.active) {
                this.demoMode.shift(direction);
            } else {
                // Optimistic local update
                const newIndex = clamp(this.gearIndex + direction, 0, this.gearSequence.length - 1);
                if (newIndex === this.gearIndex) return;
                this.gearIndex = newIndex;
                this.onTelemetry({ gear: this.gearSequence[this.gearIndex] });
            }

            // Trigger exhaust burble on downshift at high RPM
            if (direction < 0 && this.currentRPM >= 4000 && this.engineAudio && this.engineAudio.isRunning()) {
                this.engineAudio.triggerBackfire();
            }
        }

        localThrottle(value) {
            tryUnlockAudio(this);
            this._liveThrottleInput = value / 255.0;
            if (this.engineAudio) {
                if (!this.engineAudio.isRunning()) {
                    this.engineAudio.start();
                }
                this.engineAudio.setLoad(value / 255.0);
            }
            if (!this.wsManager.isConnected && !this.demoMode.active) {
                this.demoMode.start();
            }
            if (this.demoMode.active) {
                this.demoMode.setThrottle(value);
            }
            // When ESP32 is connected (not demo), run local RPM simulation for audio
            if (this.wsManager.isConnected && !this.demoMode.active) {
                this._startLiveAudioLoop();
            }
        }

        localBrake(value) {
            this._liveBrakeInput = value / 255.0;
            if (!this.wsManager.isConnected && !this.demoMode.active) {
                this.demoMode.start();
            }
            if (this.demoMode.active) {
                this.demoMode.setBrake(value);
            }
        }

        /**
         * Lightweight RPM simulation loop for live ESP32 mode.
         * Uses gear ratios to compute RPM from throttle, drives tachometer + audio.
         * Stops automatically when throttle is released and RPM settles to idle.
         */
        _startLiveAudioLoop() {
            if (this._liveAudioRunning) return;
            this._liveAudioRunning = true;
            this._liveLastTime = performance.now();

            const gearRatios = {
                'N': { idle: 800, max: 9000, accel: 12000 },
                '1': { idle: 800, max: 9000, accel: 8000 },
                '2': { idle: 2000, max: 9000, accel: 6500 },
                '3': { idle: 2500, max: 9200, accel: 5500 },
                '4': { idle: 3000, max: 9500, accel: 4500 },
                '5': { idle: 3500, max: 9800, accel: 3800 },
                '6': { idle: 4000, max: 10000, accel: 3200 },
                'R': { idle: 800, max: 5000, accel: 5000 },
            };

            const tick = (now) => {
                if (!this._liveAudioRunning) return;
                // Stop if demo mode took over or ESP32 disconnected
                if (this.demoMode.active || !this.wsManager.isConnected) {
                    this._liveAudioRunning = false;
                    return;
                }

                const dt = Math.min((now - this._liveLastTime) / 1000, 0.1);
                this._liveLastTime = now;

                const throttle = this._liveThrottleInput || 0;
                const brake = this._liveBrakeInput || 0;
                const gear = this.currentGear || 'N';
                const spec = gearRatios[gear] || gearRatios['N'];

                if (throttle > 0.05) {
                    const targetRPM = spec.idle + (spec.max - spec.idle) * throttle;
                    const accelRate = spec.accel * throttle;
                    this.currentRPM = Math.min(targetRPM, this.currentRPM + accelRate * dt);
                } else if (brake > 0.05) {
                    this.currentRPM = Math.max(spec.idle, this.currentRPM - 5000 * brake * dt);
                } else {
                    this.currentRPM = Math.max(spec.idle, this.currentRPM - 2000 * dt);
                }

                this.currentRPM = clamp(this.currentRPM, 0, CONFIG.MAX_RPM);
                const rpm = Math.round(this.currentRPM);

                // Update tachometer and RPM display
                this.tachRenderer.setRPM(rpm);
                this.telemetryDisplay.updateRPM(rpm);

                // Update audio engine
                if (this.engineAudio) {
                    this.engineAudio.setRPM(rpm);
                }

                // Keep running while there's meaningful RPM above idle
                if (throttle > 0.01 || brake > 0.01 || this.currentRPM > spec.idle + 50) {
                    requestAnimationFrame(tick);
                } else {
                    this._liveAudioRunning = false;
                }
            };

            requestAnimationFrame(tick);
        }

        startDemoMode() {
            this.wsManager.disconnect();
            this.demoMode.start();
        }

        _onConnectionChange(connected) {
            this.connDot.classList.toggle('connected', connected);
            this.connText.textContent = connected ? 'CONNECTED (ESP32)' : 'OFFLINE';

            if (this.settingsPanel) {
                this.settingsPanel.updateStatus(connected);
            }

            if (connected) {
                if (this.demoMode.active) this.demoMode.stop();
                this._demoAutoStarted = false;
            } else {
                // Auto-start demo after N failed attempts
                if (!this._demoAutoStarted &&
                    !this.demoMode.active &&
                    this.wsManager.getAttempts() >= CONFIG.DEMO_AFTER_ATTEMPTS) {
                    console.log('[APP] Auto-starting demo mode after failed connections');
                    this._demoAutoStarted = true;
                    this.startDemoMode();
                }
            }
        }

        _playStartupSequence() {
            console.log('[APP] Playing startup sequence...');
            this._startupActive = true;
            
            const startTick = performance.now();
            
            const animate = (now) => {
                const elapsed = now - startTick;
                
                // 0 to 500ms: Gauge Sweep up to 10000
                if (elapsed < 500) {
                    const pct = elapsed / 500;
                    this.currentRPM = pct * 10000;
                }
                // 500 to 1000ms: Gauge Sweep down to 0
                else if (elapsed < 1000) {
                    const pct = (elapsed - 500) / 500;
                    this.currentRPM = 10000 - (pct * 10000);
                }
                // 1000 to 1200ms: Engine crank silence/starter
                else if (elapsed < 1200) {
                    this.currentRPM = 0;
                    if (this.engineAudio) this.engineAudio.setLoad(0.0);
                }
                // 1200 to 1400ms: Engine fires up (rev to 3000)
                else if (elapsed < 1400) {
                    const pct = (elapsed - 1200) / 200;
                    this.currentRPM = pct * 3000;
                    if (this.engineAudio) this.engineAudio.setLoad(0.6);
                }
                // 1400 to 2200ms: Settle to idle (800)
                else if (elapsed < 2200) {
                    const pct = (elapsed - 1400) / 800;
                    this.currentRPM = 3000 - (pct * 2200);
                    if (this.engineAudio) this.engineAudio.setLoad(0.0);
                }
                // Done
                else {
                    this.currentRPM = 800;
                    this._startupActive = false;
                    
                    // Sync demo mode so it doesn't jump
                    if (this.demoMode) {
                        this.demoMode.rpm = 800;
                    }
                    return;
                }
                
                // Update visuals and audio
                this.tachRenderer.setRPM(this.currentRPM);
                this.telemetryDisplay.updateRPM(this.currentRPM);
                if (this.engineAudio && this.engineAudio.isRunning()) {
                    this.engineAudio.setRPM(this.currentRPM);
                }
                
                requestAnimationFrame(animate);
            };
            
            requestAnimationFrame(animate);
        }

        _initSplash() {
            const splash = document.getElementById('splash-overlay');
            if (!splash) return;

            let dismissed = false;

            const dismiss = (e) => {
                if (dismissed) return;
                dismissed = true;
                if (e) e.preventDefault();

                splash.classList.add('dismiss');

                // Start engine audio (requires user gesture)
                try {
                    if (this.engineAudio) {
                        this.engineAudio.start();
                        this.engineAudio.setVolume(1.0);
                        this._playStartupSequence();
                    }
                } catch (err) {
                    console.warn('[AUDIO] Engine audio start failed:', err);
                }

                this._requestFullscreen();
                this._lockOrientation();

                // Remove splash after animation completes
                setTimeout(() => {
                    if (splash.parentNode) splash.parentNode.removeChild(splash);
                    this._splashDismissed = true;
                    console.log('[APP] Splash dismissed, cockpit active');
                }, 700);
            };

            // Both touch and click for cross-device
            splash.addEventListener('touchstart', dismiss, { passive: false });
            splash.addEventListener('click', dismiss);
        }

        _requestFullscreen() {
            const el = document.documentElement;
            const req = el.requestFullscreen ||
                        el.webkitRequestFullscreen ||
                        el.mozRequestFullScreen ||
                        el.msRequestFullscreen;
            if (req) {
                req.call(el).catch(() => {
                    console.log('[APP] Fullscreen request denied');
                });
            }
        }

        _lockOrientation() {
            try {
                if (screen.orientation && screen.orientation.lock) {
                    screen.orientation.lock('landscape').catch(() => {});
                }
            } catch (e) { /* ignore */ }
        }

        _layout() {
            this.tachRenderer.layout();
            this.telemetryDisplay.layout();
            if (this.touchController) {
                this.touchController.layout();
            }
        }

        _renderLoop() {
            if (!this._running) return;
            this.tachRenderer.render();
            requestAnimationFrame(() => this._renderLoop());
        }
    }


    /* ══════════════════════════════════════════════════════════
       BOOTSTRAP
       ══════════════════════════════════════════════════════════ */
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => new App().init());
    } else {
        new App().init();
    }

})();
