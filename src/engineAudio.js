// Engine sound, synthesised live from the car's real RPM and throttle.
// No audio files: a stack of oscillators tuned to the V6's firing frequency,
// distortion for the rasp, a filter that opens with the throttle, plus wind
// noise that grows with speed. A second, quieter engine plays the nearest
// ghost car so you hear it close in and pass.

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function noiseBuffer(ctx, seconds = 2) {
  const buffer = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

function distortionCurve(amount) {
  const curve = new Float32Array(1024);
  for (let i = 0; i < curve.length; i++) {
    const x = (i / (curve.length - 1)) * 2 - 1;
    curve[i] = Math.tanh(amount * x);
  }
  return curve;
}

class EngineVoice {
  constructor(ctx, destination, noise) {
    this.ctx = ctx;
    const now = ctx.currentTime;

    this.output = ctx.createGain();
    this.output.gain.value = 0;
    this.panner = ctx.createStereoPanner();
    this.output.connect(this.panner).connect(destination);

    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.Q.value = 1.2;
    this.filter.frequency.value = 1500;

    const shaper = ctx.createWaveShaper();
    shaper.curve = distortionCurve(2.6);
    shaper.oversample = '2x';

    // Crank-speed wobble gives the engine its pulsing character.
    this.pulse = ctx.createGain();
    this.pulse.gain.value = 1;
    this.lfo = ctx.createOscillator();
    this.lfo.type = 'sine';
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 0.18;
    this.lfo.connect(lfoDepth).connect(this.pulse.gain);

    const mix = ctx.createGain();
    mix.gain.value = 0.32;
    mix.connect(shaper).connect(this.pulse).connect(this.filter).connect(this.output);

    // Harmonic stack around the firing frequency.
    this.oscs = [
      { type: 'sawtooth', ratio: 1, gain: 0.55, detune: 0 },
      { type: 'sawtooth', ratio: 2, gain: 0.28, detune: 6 },
      { type: 'square', ratio: 0.5, gain: 0.3, detune: -4 },
      { type: 'triangle', ratio: 3, gain: 0.12, detune: 3 },
    ].map((o) => {
      const osc = ctx.createOscillator();
      osc.type = o.type;
      osc.detune.value = o.detune;
      const g = ctx.createGain();
      g.gain.value = o.gain;
      osc.connect(g).connect(mix);
      osc.start(now);
      return { osc, ratio: o.ratio };
    });

    // A band of noise at twice the firing frequency for the exhaust rasp.
    this.rasp = ctx.createBufferSource();
    this.rasp.buffer = noise;
    this.rasp.loop = true;
    this.raspFilter = ctx.createBiquadFilter();
    this.raspFilter.type = 'bandpass';
    this.raspFilter.Q.value = 3;
    this.raspGain = ctx.createGain();
    this.raspGain.gain.value = 0;
    this.rasp.connect(this.raspFilter).connect(this.raspGain).connect(this.filter);
    this.rasp.start(now);
    this.lfo.start(now);

    this.lastGear = null;
  }

  update({ rpm, throttle, gear, volume, pan = 0 }) {
    const t = this.ctx.currentTime;
    const smooth = 0.035;
    const firing = (clamp(rpm, 3000, 13500) / 60) * 3; // V6, four-stroke: 3 pulses per revolution
    for (const { osc, ratio } of this.oscs) osc.frequency.setTargetAtTime(firing * ratio, t, smooth);
    this.lfo.frequency.setTargetAtTime(firing / 6, t, smooth);
    this.raspFilter.frequency.setTargetAtTime(firing * 2, t, smooth);

    const load = throttle / 100;
    this.filter.frequency.setTargetAtTime(900 + load * 5200 + (rpm / 13000) * 1500, t, 0.05);
    this.raspGain.gain.setTargetAtTime(0.05 + load * 0.25, t, 0.05);
    this.panner.pan.setTargetAtTime(clamp(pan, -1, 1), t, 0.1);

    // Engine is quieter off the throttle, loud on it.
    let level = volume * (0.38 + load * 0.62);

    // Upshift: a short cut in power, like the real thing.
    if (this.lastGear != null && gear > this.lastGear) {
      this.output.gain.cancelScheduledValues(t);
      this.output.gain.setValueAtTime(this.output.gain.value, t);
      this.output.gain.linearRampToValueAtTime(level * 0.35, t + 0.025);
      this.output.gain.linearRampToValueAtTime(level, t + 0.09);
    } else {
      this.output.gain.setTargetAtTime(level, t, 0.06);
    }
    this.lastGear = gear;
  }

  silence() {
    this.output.gain.setTargetAtTime(0, this.ctx.currentTime, 0.12);
    this.lastGear = null;
  }
}

export class RaceAudio {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.volume = 0.6;
  }

  // Browsers only allow sound after the person has clicked or pressed a key.
  async unlock() {
    if (!this.enabled) return;
    if (!this.ctx) this.build();
    if (this.ctx.state !== 'running') await this.ctx.resume();
  }

  build() {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.ctx = ctx;
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -16;
    compressor.ratio.value = 4;
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(compressor).connect(ctx.destination);

    const noise = noiseBuffer(ctx);
    this.own = new EngineVoice(ctx, this.master, noise);
    this.ghost = new EngineVoice(ctx, this.master, noise);

    // Wind rush that builds with speed.
    const wind = ctx.createBufferSource();
    wind.buffer = noise;
    wind.loop = true;
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'bandpass';
    this.windFilter.Q.value = 0.6;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    wind.connect(this.windFilter).connect(this.windGain).connect(this.master);
    wind.start();
  }

  setEnabled(on) {
    this.enabled = on;
    if (!this.ctx) return on ? this.unlock() : undefined;
    this.master.gain.setTargetAtTime(on ? this.volume : 0, this.ctx.currentTime, 0.05);
    if (on) this.unlock();
  }

  // own: { rpm, throttle, gear, speed }. ghost: same plus gapMetres (+ ahead, - behind), or null.
  update({ playing, own, ghost }) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const t = this.ctx.currentTime;
    if (!playing || !own) {
      this.own.silence();
      this.ghost.silence();
      this.windGain.gain.setTargetAtTime(0, t, 0.15);
      return;
    }
    this.own.update({ ...own, volume: 0.9 });

    const speedShare = clamp(own.speed / 340, 0, 1);
    this.windGain.gain.setTargetAtTime(speedShare * speedShare * 0.22, t, 0.1);
    this.windFilter.frequency.setTargetAtTime(300 + speedShare * 1400, t, 0.1);

    if (ghost) {
      // Louder the closer it is; it sounds ahead or behind via a slight pan.
      const closeness = clamp(1 - Math.abs(ghost.gapMetres) / 90, 0, 1);
      this.ghost.update({ ...ghost, volume: closeness * closeness * 0.55, pan: ghost.gapMetres > 0 ? 0.25 : -0.25 });
    } else {
      this.ghost.silence();
    }
  }
}