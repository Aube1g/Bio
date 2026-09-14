/* Lightweight synthesized UI sounds for the bio workspace.
   No samples, no network: a handful of soft tones and noise textures. */
export class BioSound {
  constructor(enabled) {
    this.enabled = enabled;
    this.context = null;
    this.master = null;
    this.voices = new Set();
    this.noiseBuffer = null;
    this.lastUi = 0;
  }
  setEnabled(value) {
    this.enabled = value;
    if (!value) {
      this.stop();
      this.context?.suspend().catch(() => {});
    }
  }
  unlock() {
    if (!this.enabled || document.hidden) return;
    const Audio = window.AudioContext || window.webkitAudioContext;
    if (!Audio) return;
    if (!this.context) {
      this.context = new Audio();
      this.master = this.context.createGain();
      this.master.gain.value = 0.16;
      this.master.connect(this.context.destination);
    }
    if (this.context.state === 'suspended') this.context.resume().catch(() => {});
  }
  stop() {
    for (const voice of this.voices) {
      try {
        voice.stop();
      } catch {
        /* Already ended. */
      }
    }
    this.voices.clear();
  }
  envelope(source, duration, delay, volume) {
    const ctx = this.context;
    if (!ctx || document.hidden || !this.enabled || this.voices.size >= 16) return;
    const start = ctx.currentTime + delay,
      gain = ctx.createGain();
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(volume, start + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    source.connect(gain);
    gain.connect(this.master);
    this.voices.add(source);
    source.start(start);
    source.stop(start + duration + 0.02);
    source.addEventListener(
      'ended',
      () => {
        source.disconnect();
        gain.disconnect();
        this.voices.delete(source);
      },
      { once: true },
    );
  }
  tone(frequency, duration = 0.1, delay = 0, volume = 0.05, type = 'sine', endFrequency = frequency) {
    if (!this.enabled || document.hidden) return;
    this.unlock();
    if (!this.context) return;
    const source = this.context.createOscillator(),
      start = this.context.currentTime + delay;
    source.type = type;
    source.frequency.setValueAtTime(frequency, start);
    source.frequency.exponentialRampToValueAtTime(Math.max(30, endFrequency), start + duration);
    this.envelope(source, duration, delay, volume);
  }
  noise(duration = 0.1, delay = 0, volume = 0.04, frequency = 2000) {
    if (!this.enabled || document.hidden) return;
    this.unlock();
    if (!this.context) return;
    const ctx = this.context;
    if (!this.noiseBuffer) {
      this.noiseBuffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * 0.5), ctx.sampleRate);
      const data = this.noiseBuffer.getChannelData(0);
      // Cosmetic texture only; never used for gameplay randomness.
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    }
    const source = ctx.createBufferSource(),
      filter = ctx.createBiquadFilter();
    source.buffer = this.noiseBuffer;
    filter.type = 'bandpass';
    filter.frequency.value = frequency;
    filter.Q.value = 0.7;
    const start = ctx.currentTime + delay,
      gain = ctx.createGain();
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(volume, start + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    this.voices.add(source);
    source.start(start);
    source.stop(start + duration + 0.02);
    source.addEventListener(
      'ended',
      () => {
        source.disconnect();
        filter.disconnect();
        gain.disconnect();
        this.voices.delete(source);
      },
      { once: true },
    );
  }
  play(name) {
    if (!this.enabled || document.hidden) return;
    this.unlock();
    const now = performance.now();
    if (['tap', 'toggle'].includes(name)) {
      if (now - this.lastUi < 60) return;
      this.lastUi = now;
    }
    switch (name) {
      case 'tap':
        this.tone(430, 0.08, 0, 0.05, 'sine', 620);
        break;
      case 'toggle':
        this.tone(560, 0.09, 0, 0.05, 'triangle', 780);
        break;
      case 'open':
        this.tone(300, 0.2, 0, 0.055, 'sine', 700);
        this.noise(0.12, 0, 0.02, 2400);
        break;
      case 'close':
        this.tone(540, 0.16, 0, 0.05, 'sine', 240);
        break;
      case 'swoosh':
        this.noise(0.28, 0, 0.035, 900);
        break;
      case 'pop':
        this.tone(720, 0.06, 0, 0.045, 'sine', 980);
        break;
      case 'secret':
        [392, 523, 659, 784, 1046].forEach((note, i) => this.tone(note, 0.22, i * 0.07, 0.06));
        this.noise(0.4, 0.3, 0.03, 3200);
        break;
      case 'chime':
        this.tone(1568, 0.12, 0, 0.05, 'sine', 1568);
        this.tone(2093, 0.18, 0.06, 0.035, 'sine', 2093);
        break;
    }
  }
}
