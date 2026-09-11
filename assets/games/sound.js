import { preferences } from '../shared/preferences.js';

export const SOUND_EVENTS = [
  'select',
  'betUp',
  'betDown',
  'launch',
  'diceRoll',
  'diceLand',
  'reelSpin',
  'reelStop',
  'card',
  'hit',
  'stand',
  'double',
  'plinkoDrop',
  'plinkoPeg',
  'win',
  'loss',
  'push',
  'blackjack',
];

export class GameSound {
  constructor() {
    this.context = null;
    this.master = null;
    this.voices = new Set();
    this.lastTick = 0;
    this.lastUi = 0;
    this.noiseBuffer = null;
    window.addEventListener('preferenceschange', () => {
      if (this.master)
        this.master.gain.setTargetAtTime(
          preferences.sound ? preferences.volume * 0.65 : 0,
          this.context.currentTime,
          0.025,
        );
      if (!preferences.sound) {
        this.stop();
        this.context?.suspend().catch(() => {});
      }
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.stop();
        this.context?.suspend().catch(() => {});
      }
    });
  }
  unlock() {
    if (!preferences.sound || document.hidden) return;
    const Audio = window.AudioContext || window.webkitAudioContext;
    if (!Audio) return;
    if (!this.context) {
      this.context = new Audio();
      this.master = this.context.createGain();
      this.master.gain.value = preferences.volume * 0.65;
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
  envelope(source, duration, delay, volume, filter = null) {
    const ctx = this.context;
    if (!ctx || document.hidden || !preferences.sound || this.voices.size >= 20) return;
    const start = ctx.currentTime + delay,
      gain = ctx.createGain();
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(volume, start + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    if (filter) {
      source.connect(filter);
      filter.connect(gain);
    } else source.connect(gain);
    gain.connect(this.master);
    this.voices.add(source);
    source.start(start);
    source.stop(start + duration + 0.01);
    source.addEventListener(
      'ended',
      () => {
        source.disconnect();
        filter?.disconnect();
        gain.disconnect();
        this.voices.delete(source);
      },
      { once: true },
    );
  }
  tone(frequency, duration = 0.12, delay = 0, volume = 0.1, type = 'sine', endFrequency = frequency) {
    if (!preferences.sound || document.hidden) return;
    this.unlock();
    if (!this.context) return;
    const source = this.context.createOscillator(),
      start = this.context.currentTime + delay;
    source.type = type;
    source.frequency.setValueAtTime(frequency, start);
    source.frequency.exponentialRampToValueAtTime(Math.max(30, endFrequency), start + duration);
    this.envelope(source, duration, delay, volume);
  }
  noise(duration = 0.13, delay = 0, volume = 0.07, frequency = 1900) {
    if (!preferences.sound || document.hidden) return;
    this.unlock();
    if (!this.context) return;
    const ctx = this.context;
    if (!this.noiseBuffer) {
      this.noiseBuffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * 0.6), ctx.sampleRate);
      const data = this.noiseBuffer.getChannelData(0);
      // Cosmetic audio texture only; game results never use Math.random().
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    }
    const source = ctx.createBufferSource(),
      filter = ctx.createBiquadFilter();
    source.buffer = this.noiseBuffer;
    filter.type = 'bandpass';
    filter.frequency.value = frequency;
    filter.Q.value = 0.8;
    this.envelope(source, duration, delay, volume, filter);
  }
  impact() {
    this.play('plinkoPeg');
  }
  result(type) {
    this.play(typeof type === 'boolean' ? (type ? 'win' : 'loss') : type);
  }
  play(name, variant = 0) {
    if (!preferences.sound || document.hidden) return;
    this.unlock();
    const now = performance.now();
    if (name === 'plinkoPeg') {
      if (now - this.lastTick < 75) return;
      this.lastTick = now;
      this.tone(690 + (variant % 5) * 45, 0.065, 0, 0.045);
      return;
    }
    if (['betUp', 'betDown', 'select'].includes(name)) {
      if (now - this.lastUi < 48) return;
      this.lastUi = now;
    }
    switch (name) {
      case 'select':
        this.tone(440, 0.11, 0, 0.09, 'sine', 640);
        break;
      case 'betUp':
        this.tone(790, 0.07, 0, 0.065, 'triangle', 1050);
        break;
      case 'betDown':
        this.tone(650, 0.07, 0, 0.065, 'triangle', 410);
        break;
      case 'launch':
        this.tone(330, 0.18, 0, 0.11, 'sine', 680);
        this.tone(990, 0.12, 0.1, 0.06);
        break;
      case 'diceRoll':
        this.noise(0.25, 0, 0.09, 1000);
        this.noise(0.2, 0.22, 0.07, 1600);
        this.tone(150, 0.2, 0, 0.08, 'triangle', 85);
        break;
      case 'diceLand':
        this.noise(0.09, 0, 0.13, 700);
        this.tone(130, 0.14, 0, 0.16, 'sine', 65);
        break;
      case 'reelSpin':
        this.noise(0.4, 0, 0.075, 2500);
        this.tone(150, 0.32, 0, 0.055, 'triangle', 360);
        break;
      case 'reelStop':
        this.tone(360 + variant * 80, 0.09, 0, 0.08, 'triangle');
        this.noise(0.055, 0, 0.06, 1300);
        break;
      case 'card':
        this.noise(0.11, 0, 0.1, 3100);
        this.tone(850, 0.045, 0.035, 0.035);
        break;
      case 'hit':
        this.tone(480, 0.09, 0, 0.075, 'triangle', 720);
        break;
      case 'stand':
        this.tone(320, 0.12, 0, 0.1, 'triangle', 220);
        break;
      case 'double':
        this.tone(710, 0.11, 0, 0.08);
        this.tone(980, 0.15, 0.1, 0.1);
        break;
      case 'plinkoDrop':
        this.tone(920, 0.15, 0, 0.08, 'sine', 390);
        break;
      case 'blackjack':
        [523, 659, 784, 1046].forEach((note, i) => this.tone(note, 0.35, i * 0.12, 0.1));
        break;
      case 'win':
        [523, 659, 784].forEach((note, i) => this.tone(note, 0.3, i * 0.12, 0.1));
        this.tone(1046, 0.48, 0.3, 0.065);
        break;
      case 'loss':
        this.tone(330, 0.25, 0, 0.09, 'sine', 245);
        this.tone(196, 0.32, 0.12, 0.055);
        break;
      case 'push':
        this.tone(440, 0.18, 0, 0.085);
        this.tone(440, 0.22, 0.18, 0.065);
        break;
    }
  }
}
