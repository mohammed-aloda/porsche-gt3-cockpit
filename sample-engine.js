/* ═══════════════════════════════════════════════════════════════
   SAMPLE ENGINE  (sound-test-dyno branch)
   Engine sound made from real recorded loops of a 992 GT3 RS on a
   dyno. Each loop was cut at one steady RPM, so playing it faster or
   slower shifts its pitch. We keep every loop running and blend the
   two closest to the current RPM:

     rpm ──► pick neighbours (e.g. 5500 and 6100 loops)
         ──► playbackRate = rpm / loopRpm   (pitch lines up)
         ──► equal-power crossfade between them
     load ─► blend the on-throttle set with the off-throttle set

   FMOD still plays the gear-shift and backfire one-shots.
   Add ?sound=fmod to the URL to hear the old FMOD engine instead.
   ═══════════════════════════════════════════════════════════════ */

window.SampleEngine = (function () {
    const BASE = 'sfx/engine/';
    const RATE_MIN = 0.7, RATE_MAX = 1.5;   // never stretch a loop far: that's what sounds synthetic
    const SMOOTH = 0.025;          // seconds, time constant for param glides

    class SampleEngine {
        constructor() {
            this.ctx = null;
            this.loops = [];           // {rpm, load, buffer, src, gain}
            this._rpm = 950;
            this._load = 0;
            this._volume = 0.3;
            this._running = false;
        }

        async init() {
            const AC = window.AudioContext || window.webkitAudioContext;
            if (!AC) throw new Error('Web Audio not supported');
            this.ctx = new AC({ latencyHint: 'interactive' });

            const res = await fetch(BASE + 'manifest.json');
            if (!res.ok) throw new Error('engine sample manifest missing');
            const list = await res.json();

            // Shared chain: loops ─► on/off buses ─► master ─► limiter ─► out
            const c = this.ctx;
            this.master = c.createGain();
            this.master.gain.value = 0;
            this.limiter = c.createDynamicsCompressor();
            this.limiter.threshold.value = -8;
            this.limiter.knee.value = 6;
            this.limiter.ratio.value = 12;
            this.limiter.attack.value = 0.003;
            this.limiter.release.value = 0.12;
            // Tone: a low-shelf adds body at low revs, a high-shelf trims the
            // fizzy top end that makes pitched-up samples sound "digital".
            this.lowShelf = c.createBiquadFilter();
            this.lowShelf.type = 'lowshelf';
            this.lowShelf.frequency.value = 160;
            this.highShelf = c.createBiquadFilter();
            this.highShelf.type = 'highshelf';
            this.highShelf.frequency.value = 4500;
            this.master.connect(this.lowShelf).connect(this.highShelf)
                .connect(this.limiter).connect(c.destination);
            this.onBus = c.createGain();
            this.offBus = c.createGain();
            this.onBus.connect(this.master);
            this.offBus.connect(this.master);

            const decoded = await Promise.all(list.map(async (e) => {
                const r = await fetch(BASE + e.file);
                if (!r.ok) throw new Error('missing ' + e.file);
                const buf = await c.decodeAudioData(await r.arrayBuffer());
                return { rpm: e.rpm, load: e.load, buffer: buf };
            }));

            // Idle loops belong to both sets. Below 2500 rpm on- and off-throttle
            // sound nearly the same, so the low on-load loops fill the off set too.
            const on = decoded.filter(l => l.load === 'on' || l.load === 'idle');
            const off = decoded.filter(l => l.load === 'off' || l.load === 'idle' || l.rpm < 2500);
            this.sets = {
                on: on.sort((a, b) => a.rpm - b.rpm).map(l => this._voice(l, this.onBus)),
                off: off.sort((a, b) => a.rpm - b.rpm).map(l => this._voice(l, this.offBus)),
            };
            console.log(`[SAMPLES] Loaded ${decoded.length} dyno loops`);
        }

        _voice(l, bus) {
            const g = this.ctx.createGain();
            g.gain.value = 0;
            g.connect(bus);
            return { rpm: l.rpm, buffer: l.buffer, gain: g, src: null };
        }

        start() {
            if (!this.ctx) return;
            this.ctx.resume();
            if (this._running) return;
            this._running = true;
            for (const set of Object.values(this.sets)) {
                for (const v of set) {
                    const s = this.ctx.createBufferSource();
                    s.buffer = v.buffer;
                    s.loop = true;          // gapless: the browser loops it sample-exact
                    s.connect(v.gain);
                    // Random start point so loops don't all pulse together
                    s.start(0, Math.random() * v.buffer.duration);
                    v.src = s;
                }
            }
            // Wake the context again after a tab switch or phone lock
            const wake = () => this.ctx && this.ctx.state !== 'running' && this.ctx.resume();
            document.addEventListener('visibilitychange', wake);
            window.addEventListener('pointerdown', wake);
            window.addEventListener('keydown', wake);
            // A real idle never sits perfectly still: it hunts a few rpm.
            // A slow random wobble stops the low end sounding like a machine loop.
            this._wobble = 0;
            setInterval(() => {
                this._wobble += (Math.random() - 0.5) * 0.004;
                this._wobble *= 0.92;
                if (this._rpm < 2000) this._update();
            }, 80);
            this._update();
        }

        setRPM(rpm) { this._rpm = Math.max(600, Math.min(10000, rpm || 0)); this._update(); }
        setLoad(l) { this._load = Math.max(0, Math.min(1, l || 0)); this._update(); }
        setVolume(v) { this._volume = v; this._update(); }
        isRunning() { return this._running && this.ctx && this.ctx.state === 'running'; }

        stop() {
            if (!this._running) return;
            const t = this.ctx.currentTime;
            this.master.gain.setTargetAtTime(0, t, 0.05);
        }

        /* Work out every voice's pitch and level for the current RPM/load. */
        _update() {
            if (!this._running) return;
            const t = this.ctx.currentTime;
            const fade = Math.max(0, Math.min(1, (2000 - this._rpm) / 1000));
            const rpm = this._rpm * (1 + this._wobble * fade);
            this._mixSet(this.sets.on, rpm, t);
            this._mixSet(this.sets.off, rpm, t);

            // Equal-power blend of on- and off-throttle sets
            const L = this._load;
            this.onBus.gain.setTargetAtTime(Math.sin(L * Math.PI / 2), t, 0.06);
            this.offBus.gain.setTargetAtTime(Math.cos(L * Math.PI / 2), t, 0.06);

            // Real engines get louder with throttle and revs
            const loud = (0.55 + 0.45 * L) * (0.75 + 0.25 * Math.min(rpm, 9000) / 9000);
            this.master.gain.setTargetAtTime(this._volume * loud * 0.9, t, 0.05);

            // Deeper at low revs: +7 dB bass at idle easing to +2 dB by 5000 rpm
            const lowK = Math.max(0, Math.min(1, (rpm - 1200) / 3800));
            this.lowShelf.gain.setTargetAtTime(7 - 5 * lowK, t, 0.1);
            this.highShelf.gain.setTargetAtTime(-5 + 4 * lowK, t, 0.1);
        }

        _mixSet(set, rpm, t) {
            // Find the two loops either side of rpm, measured on a log scale
            // (pitch is logarithmic, so 3000→3600 "feels" like 6000→7200).
            let i = set.findIndex(v => v.rpm >= rpm);
            let lo, hi, k;
            if (i <= 0) { lo = hi = set[i === 0 ? 0 : set.length - 1]; k = 0; }
            else {
                lo = set[i - 1]; hi = set[i];
                k = Math.log(rpm / lo.rpm) / Math.log(hi.rpm / lo.rpm);
            }
            for (const v of set) {
                let w = 0;
                if (v === lo && v === hi) w = 1;
                else if (v === lo) w = Math.cos(k * Math.PI / 2);
                else if (v === hi) w = Math.sin(k * Math.PI / 2);
                v.gain.gain.setTargetAtTime(w, t, SMOOTH);
                if (v.src) {
                    const rate = Math.max(RATE_MIN, Math.min(RATE_MAX, rpm / v.rpm));
                    v.src.playbackRate.setTargetAtTime(rate, t, SMOOTH);
                }
            }
        }
    }

    return SampleEngine;
})();
