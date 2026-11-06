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

   Shifts and burbles are built here too (see "FX" below): the engine
   note cuts out for ~70 ms on an upshift, downshifts get a throttle
   blip, and lift-off burbles are strings of separate pops with random
   timing, pitch and level so no two sound the same.
   Add ?sound=fmod to the URL to hear the old FMOD engine instead.
   ═══════════════════════════════════════════════════════════════ */

window.SampleEngine = (function () {
    const BASE = 'sfx/engine/';
    const RATE_MIN = 0.7, RATE_MAX = 1.5;   // never stretch a loop far: that's what sounds synthetic
    const SMOOTH_UP = 0.015;       // revs climb fast...
    const SMOOTH_DOWN = 0.05;      // ...and fall more slowly (flywheel inertia)
    const FX = 'sfx/fx/';
    const POPS = 8;
    const LIMIT_RPM = 8900;
    const rnd = (a, b) => a + Math.random() * (b - a);

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
            // cut: a gain we slam down for upshift ignition cuts and the limiter
            this.cut = c.createGain();
            this.master.connect(this.lowShelf).connect(this.highShelf)
                .connect(this.cut).connect(this.limiter).connect(c.destination);
            this.fxBus = c.createGain();
            this.fxBus.gain.value = 0.7;
            this.fxBus.connect(this.limiter);
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
            const load = async (f) => c.decodeAudioData(await (await fetch(f)).arrayBuffer());
            this.pops = await Promise.all(Array.from({ length: POPS }, (_, i) => load(`${FX}pop_${i + 1}.wav`)));
            this.shiftBuf = await load(FX + 'shift.wav');
            this._pending = [];        // pops scheduled in the future (cancel on throttle)
            this._loadHist = [];
            console.log(`[SAMPLES] Loaded ${decoded.length} dyno loops, ${POPS} pops`);
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
            // Rev limiter: fuel cut chops the note ~14 times a second
            this._chop = false;
            setInterval(() => {
                const t = this.ctx.currentTime;
                if (this._cutUntil > t) return;     // an upshift owns the cut right now
                if (this._rpm >= LIMIT_RPM && this._load > 0.5) {
                    this._chop = !this._chop;
                    this.cut.gain.setTargetAtTime(this._chop ? 0.3 : 1, t, 0.004);
                    if (this._chop && Math.random() < 0.25) this._pop(t + 0.01, 0.35);
                } else if (this._chop) {
                    this._chop = false;
                    this.cut.gain.setTargetAtTime(1, t, 0.01);
                }
            }, 36);
            this._update();
        }

        setRPM(rpm) { this._rpm = Math.max(600, Math.min(10000, rpm || 0)); this._update(); }
        setLoad(l) {
            const prev = this._load;
            this._load = Math.max(0, Math.min(1, l || 0));
            if (this._running) this._watchThrottle(prev, this._load);
            this._update();
        }
        setVolume(v) { this._volume = v; this._update(); }
        isRunning() { return this._running && this.ctx && this.ctx.state === 'running'; }

        /* ── FX ─────────────────────────────────────────────────── */

        // One pop: a random slice, random pitch, random level.
        _pop(when, level) {
            const s = this.ctx.createBufferSource();
            s.buffer = this.pops[Math.floor(Math.random() * this.pops.length)];
            s.playbackRate.value = rnd(0.82, 1.18);
            const g = this.ctx.createGain();
            g.gain.value = level * rnd(0.55, 1.0);
            s.connect(g).connect(this.fxBus);
            s.start(when);
            this._pending.push({ s, when });
            s.onended = () => { this._pending = this._pending.filter(p => p.s !== s); };
        }

        // Overrun burble: a few sharp cracks that thin out as revs fall.
        burble(intensity = 1) {
            if (!this._running || this._rpm < 3500) return;
            const t = this.ctx.currentTime;
            const revK = Math.min(1, (this._rpm - 3500) / 5000);
            const n = Math.round(rnd(1, 3) + 5 * revK * intensity);
            let at = t + rnd(0.04, 0.12);
            for (let i = 0; i < n; i++) {
                this._pop(at, (0.9 - i * 0.6 / n) * (0.5 + 0.5 * revK));
                at += rnd(0.03, 0.09) + i * rnd(0.02, 0.07);   // gaps widen
            }
        }

        // Throttle back on: real burbles stop instantly.
        _cancelPops() {
            const t = this.ctx.currentTime;
            for (const p of this._pending) if (p.when > t) { try { p.s.stop(); } catch (e) {} }
            this._pending = this._pending.filter(p => p.when <= t);
        }

        _watchThrottle(prev, now) {
            const t = this.ctx.currentTime;
            this._loadHist.push([t, now]);
            this._loadHist = this._loadHist.filter(([tt]) => t - tt < 0.35);
            const peak = Math.max(...this._loadHist.map(h => h[1]));
            if (now > 0.25) this._cancelPops();
            // Lift-off from high revs: burble
            if (peak >= 0.5 && now <= 0.15 && this._rpm >= 4000 && !(this._lastBurble > t - 0.6)) {
                this._lastBurble = t;
                this._loadHist = [[t, now]];
                this.burble(1);
            }
            // Throttle stab: short intake bark (brighter, louder for ~120 ms)
            if (now - prev >= 0.35) this._bark(t, 1);
        }

        _bark(t, k) {
            this._barkUntil = t + 0.12;
            this._barkK = k;
            if (!(this._cutUntil > t)) {
                this.cut.gain.setTargetAtTime(1 + 0.2 * k, t, 0.01);
                this.cut.gain.setTargetAtTime(1, t + 0.12, 0.05);
            }
            this._update();
            setTimeout(() => this._update(), 140);
        }

        // dir +1 upshift, -1 downshift
        shift(dir) {
            if (!this._running) return;
            const t = this.ctx.currentTime;
            const L = this._load, revK = Math.min(1, this._rpm / 9000);
            const crack = (when, lvl) => {
                const s = this.ctx.createBufferSource();
                s.buffer = this.shiftBuf;
                s.playbackRate.value = rnd(0.9, 1.1) * (dir > 0 ? 1 : 0.92);
                const g = this.ctx.createGain();
                g.gain.value = lvl;
                s.connect(g).connect(this.fxBus);
                s.start(when);
            };
            if (dir > 0) {
                // Ignition cut: note drops out ~70 ms while the next gear grabs
                const depth = 0.08 + 0.5 * (1 - L);
                this._cutUntil = t + 0.12;
                this.cut.gain.cancelScheduledValues(t);
                this.cut.gain.setTargetAtTime(depth, t, 0.006);
                this.cut.gain.setTargetAtTime(1, t + 0.07, 0.025);
                crack(t + 0.03, 0.25 + 0.75 * L * revK);
                if (L > 0.6 && revK > 0.6 && Math.random() < 0.6) this._pop(t + 0.06, 0.7 * revK);
            } else {
                // Rev-match blip: a quick bark, a soft clunk, and maybe a crackle
                this._bark(t, 1.3);
                crack(t + 0.02, 0.2 + 0.3 * revK);
                if (this._rpm > 4000) this.burble(0.5);
            }
        }

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
            const tau = rpm >= (this._lastRpm || 0) ? SMOOTH_UP : SMOOTH_DOWN;
            this._lastRpm = rpm;
            this._mixSet(this.sets.on, rpm, t, tau);
            this._mixSet(this.sets.off, rpm, t, tau);

            // Equal-power blend of on- and off-throttle sets
            const L = this._load;
            this.onBus.gain.setTargetAtTime(Math.sin(L * Math.PI / 2), t, 0.06);
            this.offBus.gain.setTargetAtTime(Math.cos(L * Math.PI / 2), t, 0.06);

            // Real engines get louder with throttle and revs
            const loud = (0.45 + 0.55 * L) * (0.72 + 0.28 * Math.min(rpm, 9000) / 9000);
            this.master.gain.setTargetAtTime(this._volume * loud * 0.9, t, 0.05);

            // Deeper at low revs: +7 dB bass at idle easing to +2 dB by 5000 rpm
            const lowK = Math.max(0, Math.min(1, (rpm - 1200) / 3800));
            this.lowShelf.gain.setTargetAtTime(7 - 5 * lowK, t, 0.1);
            // and rawer on full throttle, softer on part throttle
            const bark = this._barkUntil > t ? 3 * this._barkK : 0;
            this.highShelf.gain.setTargetAtTime(-5 + 4 * lowK + 2.5 * (L - 0.5) + bark, t, bark ? 0.01 : 0.1);
        }

        _mixSet(set, rpm, t, tau) {
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
                v.gain.gain.setTargetAtTime(w, t, tau);
                if (v.src) {
                    const rate = Math.max(RATE_MIN, Math.min(RATE_MAX, rpm / v.rpm));
                    v.src.playbackRate.setTargetAtTime(rate, t, tau);
                }
            }
        }
    }

    return SampleEngine;
})();
