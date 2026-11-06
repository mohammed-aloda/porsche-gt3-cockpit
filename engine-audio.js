'use strict';

/**
 * @fileoverview Web Audio API engine sound synthesizer for a Porsche GT3 RS
 * flat-six engine simulation. Designed for real-time RC car telemetry dashboards.
 *
 * Synthesis chain:
 *   OSC1 (sawtooth) ──► Gain1 ──┐
 *   OSC2 (triangle) ──► Gain2 ──┼──► LowpassFilter ──► MasterGain ──► Compressor ──► Destination
 *   OSC3 (square)   ──► Gain3 ──┘
 *
 * Load via <script> tag before app.js. Access via window.EngineAudio.
 */
(function () {

  /** Ramp duration in seconds for smooth parameter transitions. */
  const RAMP_DURATION = 0.05;

  /** Fade-out duration in seconds when stopping the engine. */
  const FADE_OUT_DURATION = 0.2;

  /** Shift blip drop duration in seconds. */
  const SHIFT_DROP_DURATION = 0.08;

  /** Shift blip recovery duration in seconds. */
  const SHIFT_RECOVER_DURATION = 0.15;

  /** Frequency drop factor during a PDK shift blip. */
  const SHIFT_DROP_FACTOR = 0.7;

  /**
   * Calculates the base frequency from RPM.
   * @param {number} rpm - Engine RPM (0–10000).
   * @returns {number} Base frequency in Hz.
   */
  function rpmToBaseFreq(rpm) {
    return 35 + (rpm / 10000) * 200;
  }

  /**
   * Calculates the lowpass filter cutoff frequency from RPM.
   * @param {number} rpm - Engine RPM (0–10000).
   * @returns {number} Cutoff frequency in Hz.
   */
  function rpmToCutoff(rpm) {
    return 300 + (rpm / 10000) * 3000;
  }

  /**
   * Calculates the engine volume gain from RPM.
   * Idle (<1000) = 0.05, mid-range = 0.15, redline (9000+) = 0.3.
   * @param {number} rpm - Engine RPM (0–10000).
   * @returns {number} Gain value (0.05–0.3).
   */
  function rpmToGain(rpm) {
    if (rpm < 1000) {
      // Idle zone: scale from 0.05 at 0 RPM to 0.05 at 1000 RPM
      return 0.05;
    }
    if (rpm >= 9000) {
      // Redline zone
      return 0.3;
    }
    // Mid-range: linear interpolation from 0.05 at 1000 RPM to 0.3 at 9000 RPM
    var t = (rpm - 1000) / (9000 - 1000);
    return 0.05 + t * (0.3 - 0.05);
  }

  /**
   * EngineAudio — Web Audio API engine sound synthesizer for a Porsche GT3 RS
   * flat-six engine. Uses three layered oscillators with RPM-responsive filtering
   * and dynamics compression for clean, real-time output.
   *
   * @class
   * @example
   *   var engine = new EngineAudio();
   *   startButton.addEventListener('click', function () {
   *     engine.start();
   *     engine.setRPM(800);
   *   });
   */
  function EngineAudio() {
    /** @private @type {AudioContext|null} */
    this._ctx = null;

    /** @private @type {OscillatorNode|null} */
    this._osc1 = null;
    /** @private @type {OscillatorNode|null} */
    this._osc2 = null;
    /** @private @type {OscillatorNode|null} */
    this._osc3 = null;

    /** @private @type {GainNode|null} */
    this._gain1 = null;
    /** @private @type {GainNode|null} */
    this._gain2 = null;
    /** @private @type {GainNode|null} */
    this._gain3 = null;

    /** @private @type {BiquadFilterNode|null} */
    this._filter = null;
    /** @private @type {GainNode|null} */
    this._masterGain = null;
    /** @private @type {DynamicsCompressorNode|null} */
    this._compressor = null;

    /** @private @type {boolean} */
    this._running = false;

    /** @private @type {number} */
    this._currentRPM = 0;

    /** @private @type {number} */
    this._volume = 1.0;

    /** @private @type {number} */
    this._load = 0.0;
  }

  /**
   * Updates throttle load (0.0 to 1.0) for dynamic tone and gain adjustment.
   * @param {number} load - Throttle load (0.0–1.0 or 0–255).
   */
  EngineAudio.prototype.setLoad = function setLoad(load) {
    var val = (typeof load === 'number' && load > 1.0) ? load / 255.0 : (load || 0);
    this._load = Math.max(0, Math.min(1, val));
    if (this._running && this._ctx) {
      this.setRPM(this._currentRPM);
    }
  };

  /**
   * Resumes or creates the AudioContext and builds the full synthesis chain.
   * Must be called from a user gesture handler (click, touch, keydown).
   * Safe to call multiple times — subsequent calls resume a suspended context.
   *
   * @returns {Promise<void>} Resolves when the audio context is running.
   */
  EngineAudio.prototype.start = function start() {
    var self = this;

    // If already running, just ensure context is active
    if (this._running && this._ctx) {
      if (this._ctx.state === 'suspended') {
        return this._ctx.resume();
      }
      return Promise.resolve();
    }

    // Create AudioContext if needed
    if (!this._ctx) {
      var AudioCtx = window.AudioContext || window.webkitAudioContext;
      this._ctx = new AudioCtx();
    }

    var ctx = this._ctx;

    return ctx.resume().then(function () {
      self._buildSynthChain();
      self._running = true;
      // Set initial idle RPM state
      self.setRPM(self._currentRPM || 0);
    });
  };

  /**
   * Builds all audio nodes and connects the synthesis chain.
   * @private
   */
  EngineAudio.prototype._buildSynthChain = function _buildSynthChain() {
    var ctx = this._ctx;
    var now = ctx.currentTime;

    // --- Oscillators ---

    // OSC1: Primary engine growl (sawtooth)
    this._osc1 = ctx.createOscillator();
    this._osc1.type = 'sawtooth';
    this._osc1.frequency.setValueAtTime(rpmToBaseFreq(0), now);

    // OSC2: Harmonic undertone (triangle, half frequency)
    this._osc2 = ctx.createOscillator();
    this._osc2.type = 'triangle';
    this._osc2.frequency.setValueAtTime(rpmToBaseFreq(0) * 0.5, now);

    // OSC3: High harmonic crackle (square, double frequency, very low gain)
    this._osc3 = ctx.createOscillator();
    this._osc3.type = 'square';
    this._osc3.frequency.setValueAtTime(rpmToBaseFreq(0) * 2.0, now);

    // --- Per-oscillator Gain Nodes ---

    this._gain1 = ctx.createGain();
    this._gain1.gain.setValueAtTime(0.6, now); // Primary layer

    this._gain2 = ctx.createGain();
    this._gain2.gain.setValueAtTime(0.3, now); // Undertone layer

    this._gain3 = ctx.createGain();
    this._gain3.gain.setValueAtTime(0.08, now); // Crackle layer (very low)

    // --- Lowpass Filter ---

    this._filter = ctx.createBiquadFilter();
    this._filter.type = 'lowpass';
    this._filter.frequency.setValueAtTime(rpmToCutoff(0), now);
    this._filter.Q.setValueAtTime(1.5, now);

    // --- Master Gain ---

    this._masterGain = ctx.createGain();
    this._masterGain.gain.setValueAtTime(rpmToGain(0) * this._volume, now);

    // --- Dynamics Compressor ---

    this._compressor = ctx.createDynamicsCompressor();
    this._compressor.threshold.setValueAtTime(-24, now);
    this._compressor.knee.setValueAtTime(12, now);
    this._compressor.ratio.setValueAtTime(4, now);
    this._compressor.attack.setValueAtTime(0.003, now);
    this._compressor.release.setValueAtTime(0.15, now);

    // --- Wiring ---
    // OSC -> per-osc gain -> filter -> master gain -> compressor -> destination

    this._osc1.connect(this._gain1);
    this._osc2.connect(this._gain2);
    this._osc3.connect(this._gain3);

    this._gain1.connect(this._filter);
    this._gain2.connect(this._filter);
    this._gain3.connect(this._filter);

    this._filter.connect(this._masterGain);
    this._masterGain.connect(this._compressor);
    this._compressor.connect(ctx.destination);

    // --- Start oscillators ---
    this._osc1.start(now);
    this._osc2.start(now);
    this._osc3.start(now);
  };

  /**
   * Updates all oscillator frequencies, filter cutoff, and master gain to match
   * the target RPM. Uses linear ramps over 50ms for click-free transitions.
   *
   * @param {number} rpm - Target engine RPM, clamped to 0–10000.
   */
  EngineAudio.prototype.setRPM = function setRPM(rpm) {
    if (!this._running || !this._ctx) {
      this._currentRPM = Math.max(0, Math.min(10000, rpm));
      return;
    }

    rpm = Math.max(0, Math.min(10000, rpm));
    this._currentRPM = rpm;

    var ctx = this._ctx;
    var now = ctx.currentTime;
    var target = now + RAMP_DURATION;

    var loadBoost = this._load || 0;
    var baseFreq = rpmToBaseFreq(rpm);
    var cutoff = rpmToCutoff(rpm) * (1 + loadBoost * 0.4);
    var gain = rpmToGain(rpm) * (1 + loadBoost * 0.5) * this._volume;

    // Cancel any pending ramps before scheduling new ones
    this._osc1.frequency.cancelScheduledValues(now);
    this._osc1.frequency.setValueAtTime(this._osc1.frequency.value, now);
    this._osc1.frequency.linearRampToValueAtTime(baseFreq, target);

    this._osc2.frequency.cancelScheduledValues(now);
    this._osc2.frequency.setValueAtTime(this._osc2.frequency.value, now);
    this._osc2.frequency.linearRampToValueAtTime(baseFreq * 0.5, target);

    this._osc3.frequency.cancelScheduledValues(now);
    this._osc3.frequency.setValueAtTime(this._osc3.frequency.value, now);
    this._osc3.frequency.linearRampToValueAtTime(baseFreq * 2.0, target);

    // Filter cutoff
    this._filter.frequency.cancelScheduledValues(now);
    this._filter.frequency.setValueAtTime(this._filter.frequency.value, now);
    this._filter.frequency.linearRampToValueAtTime(cutoff, target);

    // Master gain (RPM-scaled × user volume)
    this._masterGain.gain.cancelScheduledValues(now);
    this._masterGain.gain.setValueAtTime(this._masterGain.gain.value, now);
    this._masterGain.gain.linearRampToValueAtTime(gain, target);
  };

  /**
   * Updates throttle load (0.0 to 1.0) and reapplies RPM-dependent parameters.
   * @param {number} load - Throttle load (0.0–1.0 or 0–255).
   */
  EngineAudio.prototype.setLoad = function setLoad(load) {
    // Normalize load to 0.0–1.0 range, handling 0–255 values.
    var val = (typeof load === 'number' && load > 1.0) ? load / 255.0 : (load || 0);
    this._load = Math.max(0, Math.min(1, val));
    // Reapply RPM settings to incorporate new load boost.
    if (this._running) {
      this.setRPM(this._currentRPM);
    }
  };

  /**
   * Simulates a PDK gear-shift rev-match blip. Drops all oscillator frequencies
   * by 30% over 80ms, then ramps them back to the current RPM target over 150ms.
   * No-op if the engine is not running.
   */
  EngineAudio.prototype.triggerShiftBlip = function triggerShiftBlip() {
    if (!this._running || !this._ctx) {
      return;
    }

    var ctx = this._ctx;
    var now = ctx.currentTime;
    var rpm = this._currentRPM;
    var baseFreq = rpmToBaseFreq(rpm);

    var droppedBase = baseFreq * SHIFT_DROP_FACTOR;
    var dropEnd = now + SHIFT_DROP_DURATION;
    var recoverEnd = dropEnd + SHIFT_RECOVER_DURATION;

    // --- OSC1: sawtooth (base frequency) ---
    this._osc1.frequency.cancelScheduledValues(now);
    this._osc1.frequency.setValueAtTime(this._osc1.frequency.value, now);
    this._osc1.frequency.linearRampToValueAtTime(droppedBase, dropEnd);
    this._osc1.frequency.linearRampToValueAtTime(baseFreq, recoverEnd);

    // --- OSC2: triangle (base × 0.5) ---
    this._osc2.frequency.cancelScheduledValues(now);
    this._osc2.frequency.setValueAtTime(this._osc2.frequency.value, now);
    this._osc2.frequency.linearRampToValueAtTime(droppedBase * 0.5, dropEnd);
    this._osc2.frequency.linearRampToValueAtTime(baseFreq * 0.5, recoverEnd);

    // --- OSC3: square (base × 2.0) ---
    this._osc3.frequency.cancelScheduledValues(now);
    this._osc3.frequency.setValueAtTime(this._osc3.frequency.value, now);
    this._osc3.frequency.linearRampToValueAtTime(droppedBase * 2.0, dropEnd);
    this._osc3.frequency.linearRampToValueAtTime(baseFreq * 2.0, recoverEnd);

    // Brief gain bump during blip for audible pop
    var currentGain = rpmToGain(rpm) * this._volume;
    this._masterGain.gain.cancelScheduledValues(now);
    this._masterGain.gain.setValueAtTime(this._masterGain.gain.value, now);
    this._masterGain.gain.linearRampToValueAtTime(currentGain * 1.3, dropEnd);
    this._masterGain.gain.linearRampToValueAtTime(currentGain, recoverEnd);
  };

  /**
   * Sets the master volume level.
   *
   * @param {number} level - Volume from 0.0 (silent) to 1.0 (full).
   */
  EngineAudio.prototype.setVolume = function setVolume(level) {
    this._volume = Math.max(0, Math.min(1, level));

    if (!this._running || !this._ctx || !this._masterGain) {
      return;
    }

    var ctx = this._ctx;
    var now = ctx.currentTime;
    var gain = rpmToGain(this._currentRPM) * this._volume;

    this._masterGain.gain.cancelScheduledValues(now);
    this._masterGain.gain.setValueAtTime(this._masterGain.gain.value, now);
    this._masterGain.gain.linearRampToValueAtTime(gain, now + RAMP_DURATION);
  };

  /**
   * Fades out over 200ms, stops all oscillators, disconnects every node,
   * and suspends the AudioContext. Safe to call when already stopped.
   *
   * @returns {Promise<void>} Resolves after cleanup and context suspension.
   */
  EngineAudio.prototype.stop = function stop() {
    if (!this._running || !this._ctx) {
      return Promise.resolve();
    }

    var self = this;
    var ctx = this._ctx;
    var now = ctx.currentTime;
    var fadeEnd = now + FADE_OUT_DURATION;

    // Fade master gain to zero
    this._masterGain.gain.cancelScheduledValues(now);
    this._masterGain.gain.setValueAtTime(this._masterGain.gain.value, now);
    this._masterGain.gain.linearRampToValueAtTime(0, fadeEnd);

    this._running = false;

    // Schedule cleanup after fade completes
    return new Promise(function (resolve) {
      setTimeout(function () {
        self._destroyNodes();
        if (self._ctx) {
          self._ctx.suspend().then(resolve).catch(resolve);
        } else {
          resolve();
        }
      }, FADE_OUT_DURATION * 1000 + 50); // Small buffer past fade end
    });
  };

  /**
   * Stops oscillators and disconnects all audio nodes. Nullifies references.
   * @private
   */
  EngineAudio.prototype._destroyNodes = function _destroyNodes() {
    var oscillators = [this._osc1, this._osc2, this._osc3];
    var nodes = [
      this._gain1, this._gain2, this._gain3,
      this._filter, this._masterGain, this._compressor
    ];

    // Stop oscillators
    for (var i = 0; i < oscillators.length; i++) {
      if (oscillators[i]) {
        try { oscillators[i].stop(); } catch (e) { /* already stopped */ }
        try { oscillators[i].disconnect(); } catch (e) { /* noop */ }
      }
    }

    // Disconnect all other nodes
    for (var j = 0; j < nodes.length; j++) {
      if (nodes[j]) {
        try { nodes[j].disconnect(); } catch (e) { /* noop */ }
      }
    }

    this._osc1 = null;
    this._osc2 = null;
    this._osc3 = null;
    this._gain1 = null;
    this._gain2 = null;
    this._gain3 = null;
    this._filter = null;
    this._masterGain = null;
    this._compressor = null;
  };

  /**
   * Returns whether the engine audio synthesis is currently active.
   *
   * @returns {boolean} True if the engine is running and producing audio.
   */
  EngineAudio.prototype.isRunning = function isRunning() {
    return this._running;
  };

  // --- Expose on window ---
  window.EngineAudio = EngineAudio;

})();
