import { preferences, motionEnabled } from '../shared/preferences.js';
import { icon } from '../shared/dom.js';

export class GameFeedback {
  constructor(scene) {
    this.scene = scene;
    this.overlay = scene.querySelector('#round-feedback');
    this.particles = scene.querySelector('.result-particles');
    this.animations = new Set();
    this.timer = 0;
    this.version = 0;
    window.addEventListener('preferenceschange', () => {
      if (!motionEnabled()) this.clear();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.clear();
    });
  }
  run(element, frames, options) {
    const animation = element.animate(frames, options);
    this.animations.add(animation);
    animation.finished.catch(() => {}).then(() => this.animations.delete(animation));
    return animation;
  }
  clear() {
    this.version++;
    clearTimeout(this.timer);
    for (const animation of this.animations) animation.cancel();
    this.animations.clear();
    this.particles.replaceChildren();
    this.overlay.hidden = true;
    delete this.scene.dataset.reaction;
  }
  show({ type, title, value, game }) {
    this.clear();
    const version = this.version;
    this.scene.dataset.reaction = type;
    this.overlay.dataset.result = type;
    this.overlay.querySelector('.feedback-symbol').innerHTML = icon(
      type === 'win' ? 'check' : type === 'push' ? 'equal' : 'close',
    );
    this.overlay.querySelector('.feedback-label').textContent = title;
    this.overlay.querySelector('.feedback-value').textContent = value;
    this.overlay.querySelector('.feedback-game').textContent = game;
    // The persistent receipt remains visible for reduced motion; no moving layer is required.
    if (!motionEnabled() || document.hidden) return;
    this.overlay.hidden = false;
    this.run(
      this.overlay,
      [
        { opacity: 0, translate: '0 12px', scale: 0.92 },
        { opacity: 1, translate: '0 -3px', scale: 1.025, offset: 0.72 },
        { opacity: 1, translate: '0 0', scale: 1 },
      ],
      { duration: 430, easing: 'cubic-bezier(.16,1,.3,1)' },
    );
    if (type === 'win' && preferences.particles) {
      for (let i = 0; i < 14; i++) {
        const petal = document.createElement('i');
        petal.className = 'result-petal';
        petal.style.setProperty('--petal-color', i % 3 ? '#bfdda0' : '#efbdcd');
        this.particles.append(petal);
        const angle = (Math.PI * 2 * i) / 14;
        const animation = this.run(
          petal,
          [
            { opacity: 0, transform: 'translate(-50%,-50%) scale(.3)' },
            { opacity: 0.9, offset: 0.12 },
            {
              opacity: 0,
              transform: `translate(calc(-50% + ${Math.cos(angle) * 115}px),calc(-50% + ${Math.sin(angle) * 85 + 35}px)) rotate(${i * 47}deg) scale(.7)`,
            },
          ],
          { duration: 1050 + (i % 3) * 90, easing: 'cubic-bezier(.12,.6,.25,1)' },
        );
        animation.finished.catch(() => {}).then(() => petal.remove());
      }
    }
    this.timer = setTimeout(() => {
      if (this.version !== version) return;
      const hide = this.run(this.overlay, [{ opacity: 1 }, { opacity: 0, translate: '0 -6px' }], {
        duration: 230,
        easing: 'ease-out',
      });
      hide.finished
        .catch(() => {})
        .then(() => {
          if (this.version === version) this.overlay.hidden = true;
        });
    }, 1850);
  }
}
