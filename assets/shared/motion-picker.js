import { transitionMask } from './motion.js';
import { TRANSITION_STYLES, desktopTransform, isDesktopMotion, emphasized } from './desktop-motion.js';

import presets from './motion-presets.json';
export const MOTION_PRESETS = presets;

const text = {
  ru: {
    eyebrow: 'ДВИЖЕНИЕ ПРОСТРАНСТВА',
    title: 'Свой характер.',
    replay: 'Повторить',
    apply: 'Применить',
    cancel: 'Отмена',
    reduced: 'Движение уменьшено в настройках системы.',
    choose: 'Выбрать анимацию окон',
    group: 'Анимация окон',
  },
  en: {
    eyebrow: 'SPACE IN MOTION',
    title: 'Your own character.',
    replay: 'Replay',
    apply: 'Apply',
    cancel: 'Cancel',
    reduced: 'Motion is reduced by your system settings.',
    choose: 'Choose a window animation',
    group: 'Window animation',
  },
};

export function initializeMotionPicker(select) {
  const dialog = document.getElementById('motion-picker-dialog');
  if (!dialog || !select) return;
  const cards = [...dialog.querySelectorAll('[data-motion-style]')];
  const preview = dialog.querySelector('.motion-preview-window');
  const stage = dialog.querySelector('.motion-preview-stage');
  const replay = document.getElementById('motion-preview-replay');
  let pending = select.value,
    frame = 0,
    version = 0,
    sequence = 0;
  const lang = () => (document.documentElement.lang === 'en' ? 'en' : 'ru');
  const enabled = () => document.documentElement.dataset.motion !== 'off';

  function stop() {
    cancelAnimationFrame(frame);
    version++;
    preview.style.cssText = '';
    delete stage.dataset.playing;
  }
  function render() {
    const language = lang();
    for (const node of dialog.querySelectorAll('[data-motion-text]'))
      node.textContent = text[language][node.dataset.motionText];
    document.getElementById('motion-choices').setAttribute('aria-label', text[language].group);
    const preset = MOTION_PRESETS.find((item) => item.id === pending) || MOTION_PRESETS[0];
    document.getElementById('motion-preview-name').textContent = preset.title;
    document.getElementById('motion-preview-description').textContent = preset[language];
    cards.forEach((card) => {
      const item = MOTION_PRESETS.find((item) => item.id === card.dataset.motionStyle);
      card.querySelector('small').textContent = item[language];
      card.setAttribute('aria-checked', String(item.id === pending));
      card.tabIndex = item.id === pending ? 0 : -1;
    });
    const current = MOTION_PRESETS.find((item) => item.id === select.value) || MOTION_PRESETS[0];
    for (const trigger of document.querySelectorAll('[data-motion-picker]')) {
      trigger.querySelector('[data-motion-current]').textContent = current.title;
      trigger.querySelector('[data-motion-hint]').textContent = current[language];
      trigger.setAttribute('aria-label', `${text[language].choose}: ${current.title}`);
      trigger.dataset.motionMode = current.id;
    }
    replay.disabled = !enabled();
    document.getElementById('motion-reduced-note').hidden = enabled();
  }
  function play() {
    stop();
    if (!enabled() || !dialog.open) return;
    const run = version;
    const effect = pending === 'mix' ? TRANSITION_STYLES[sequence++ % TRANSITION_STYLES.length] : pending;
    const box = preview.getBoundingClientRect(),
      parent = stage.getBoundingClientRect();
    const origin = dialog.querySelector('.motion-preview-source').getBoundingClientRect();
    const target = { x: box.left - parent.left, y: box.top - parent.top, w: box.width, h: box.height };
    const source = {
      x: origin.left - parent.left,
      y: origin.top - parent.top,
      w: origin.width,
      h: origin.height,
    };
    let elapsed = 0,
      last = performance.now();
    stage.dataset.playing = 'true';
    const tick = (now) => {
      if (run !== version) return;
      elapsed += Math.min(70, Math.max(0, now - last));
      last = now;
      const t = enabled() ? Math.min(1, elapsed / (isDesktopMotion(effect) ? 540 : 700)) : 1;
      const p = emphasized(t),
        w = source.w + (target.w - source.w) * p,
        h = source.h + (target.h - source.h) * p;
      Object.assign(preview.style, {
        left: `${source.x + (target.x - source.x) * p}px`,
        top: `${source.y + (target.y - source.y) * p}px`,
        width: `${w}px`,
        height: `${h}px`,
        transform: isDesktopMotion(effect) ? desktopTransform(effect, w, t) : 'none',
        clipPath: `path("${transitionMask(effect, w, h, 0.15 + 0.85 * t)}")`,
      });
      if (t < 1) frame = requestAnimationFrame(tick);
      else stop();
    };
    tick(last);
  }
  function choose(id, focus = false) {
    pending = id;
    render();
    if (focus) cards.find((card) => card.dataset.motionStyle === id)?.focus();
    play();
  }
  for (const card of cards) {
    card.addEventListener('click', () => choose(card.dataset.motionStyle));
    card.addEventListener('keydown', (event) => {
      if (!['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const index = cards.indexOf(card);
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? cards.length - 1
            : (index + (['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : -1) + cards.length) %
              cards.length;
      choose(cards[next].dataset.motionStyle, true);
    });
  }
  document.addEventListener(
    'click',
    (event) => {
      if (!event.target.closest('[data-motion-picker]')) return;
      pending = select.value;
      render();
      const whenReady = () => {
        if (!dialog.open) return;
        if (dialog.classList.contains('morphing') || dialog.classList.contains('is-morphing')) {
          requestAnimationFrame(whenReady);
          return;
        }
        play();
      };
      requestAnimationFrame(whenReady);
    },
    true,
  );
  document.getElementById('motion-apply').addEventListener('click', () => {
    select.value = pending;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    render();
    dialog.querySelector('[data-close]').click();
  });
  replay.addEventListener('click', play);
  dialog.addEventListener('close', stop);
  select.addEventListener('change', render);
  window.addEventListener('resize', stop);
  window.addEventListener('preferenceschange', () => {
    render();
    if (!enabled()) stop();
  });
  new MutationObserver(() => {
    render();
    if (!enabled()) stop();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['lang', 'data-motion'] });
  render();
}
