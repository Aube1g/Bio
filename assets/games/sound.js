import { preferences } from '../shared/preferences.js';
export class GameSound {
  constructor() {
    this.context = null;
    this.lastTick = 0;
  }
  unlock() {
    if (!preferences.sound) return;
    const Audio = window.AudioContext || window.webkitAudioContext;
    if (!Audio) return;
    this.context ||= new Audio();
    this.context.resume().catch(() => {});
  }
  tone(frequency, duration = 0.09, delay = 0, volume = 0.035) {
    if (document.hidden || !preferences.sound || !this.context || this.context.state !== 'running') return;
    const start = this.context.currentTime + delay,
      oscillator = this.context.createOscillator(),
      gain = this.context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(frequency, start);
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(preferences.volume * volume, start + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    oscillator.connect(gain);
    gain.connect(this.context.destination);
    oscillator.start(start);
    oscillator.stop(start + duration);
    oscillator.addEventListener(
      'ended',
      () => {
        oscillator.disconnect();
        gain.disconnect();
      },
      { once: true },
    );
  }
  impact() {
    const now = performance.now();
    if (now - this.lastTick < 65) return;
    this.lastTick = now;
    this.tone(470, 0.045, 0, 0.013);
  }
  result(win) {
    this.tone(win ? 523 : 280, 0.14);
    if (win) {
      this.tone(659, 0.14, 0.09);
      this.tone(784, 0.18, 0.19);
    }
  }
}
