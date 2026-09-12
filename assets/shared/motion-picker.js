import { motionFrame } from './motion-recipes.js';
import { TRANSITION_STYLES } from './desktop-motion.js';
import presets from './motion-presets.json';
export const MOTION_PRESETS = presets;

const copy = {
  ru: {
    eyebrow: 'ДВИЖЕНИЕ ПРОСТРАНСТВА',
    title: 'Свой характер.',
    replay: 'Проиграть',
    pause: 'Пауза',
    apply: 'Применить',
    cancel: 'Отмена',
    reduced: 'Движение уменьшено системой. Контур можно сравнить ползунком.',
    choose: 'Выбрать анимацию окон',
    group: 'Анимация окон',
    frame: 'Кадр',
    open: 'Открытие',
    close: 'Закрытие',
    mid: 'Середина',
  },
  en: {
    eyebrow: 'SPACE IN MOTION',
    title: 'Your own character.',
    replay: 'Play',
    pause: 'Pause',
    apply: 'Apply',
    cancel: 'Cancel',
    reduced: 'Motion is reduced by your system. Compare the shapes with the slider.',
    choose: 'Choose a window animation',
    group: 'Window animation',
    frame: 'Frame',
    open: 'Opening',
    close: 'Closing',
    mid: 'Midpoint',
  },
};

export function initializeMotionPicker(select) {
  const dialog = document.getElementById('motion-picker-dialog');
  if (!dialog || !select) return;
  const cards = [...dialog.querySelectorAll('[data-motion-style]')];
  const preview = dialog.querySelector('.motion-preview-window');
  const stage = dialog.querySelector('.motion-preview-stage');
  const outline = dialog.querySelector('.motion-preview-outline');
  const outlinePath = outline.querySelector('path');
  const replay = document.getElementById('motion-preview-replay');
  const slider = document.getElementById('motion-preview-progress');
  let pending = select.value,
    progress = 0.45,
    direction = 'open',
    frame = 0,
    version = 0,
    playing = false,
    mixIndex = 0;
  const lang = () => (document.documentElement.lang === 'en' ? 'en' : 'ru');
  const enabled = () => document.documentElement.dataset.motion !== 'off';
  const effect = () => (pending === 'mix' ? TRANSITION_STYLES[mixIndex % TRANSITION_STYLES.length] : pending);

  function draw(value = progress) {
    progress = Math.max(0, Math.min(1, value));
    const width = preview.offsetWidth,
      height = preview.offsetHeight;
    if (!width || !height) return;
    const p = direction === 'open' ? progress : 1 - progress;
    const sample = motionFrame(effect(), width, height, p);
    preview.style.clipPath = sample.clipPath;
    preview.style.transform = sample.transform;
    outline.setAttribute('viewBox', `0 0 ${width} ${height}`);
    outlinePath.setAttribute('d', sample.path);
    outline.style.transform = sample.transform;
    slider.value = String(Math.round(progress * 100));
    slider.style.setProperty('--fill', `${progress * 100}%`);
    document.getElementById('motion-preview-percent').textContent = `${Math.round(progress * 100)}%`;
    stage.dataset.sample = effect();
    stage.dataset.progress = progress.toFixed(3);
  }
  function stop() {
    cancelAnimationFrame(frame);
    frame = 0;
    version++;
    playing = false;
    delete stage.dataset.playing;
    replay.setAttribute('aria-pressed', 'false');
    replay.querySelector('span').textContent = copy[lang()].replay;
  }
  function render() {
    const language = lang();
    for (const node of dialog.querySelectorAll('[data-motion-text]'))
      node.textContent = copy[language][node.dataset.motionText];
    document.getElementById('motion-choices').setAttribute('aria-label', copy[language].group);
    slider.setAttribute('aria-label', language === 'en' ? 'Animation frame' : 'Кадр анимации');
    dialog
      .querySelector('.motion-preview-directions')
      .setAttribute('aria-label', language === 'en' ? 'Preview direction' : 'Направление предпросмотра');
    const selected = MOTION_PRESETS.find((item) => item.id === pending) || MOTION_PRESETS[0];
    document.getElementById('motion-preview-name').textContent =
      selected.title + (pending === 'mix' ? ` / ${effect()}` : '');
    document.getElementById('motion-preview-description').textContent = selected[language];
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
      trigger.setAttribute('aria-label', `${copy[language].choose}: ${current.title}`);
      trigger.dataset.motionMode = current.id;
    }
    for (const button of dialog.querySelectorAll('[data-preview-direction]'))
      button.setAttribute('aria-pressed', String(button.dataset.previewDirection === direction));
    replay.disabled = !enabled();
    replay.querySelector('span').textContent = playing ? copy[language].pause : copy[language].replay;
    document.getElementById('motion-reduced-note').hidden = enabled();
  }
  function play() {
    if (playing) {
      stop();
      return;
    }
    if (!enabled() || !dialog.open) return;
    stop();
    if (pending === 'mix') mixIndex++;
    const run = version;
    let elapsed = 0,
      last = performance.now();
    playing = true;
    stage.dataset.playing = 'true';
    replay.setAttribute('aria-pressed', 'true');
    render();
    draw(0);
    const tick = (now) => {
      if (run !== version) return;
      if (!enabled() || !dialog.open) {
        stop();
        return;
      }
      elapsed += Math.min(90, Math.max(0, now - last));
      last = now;
      draw(Math.min(1, elapsed / 1700));
      if (elapsed < 1700) frame = requestAnimationFrame(tick);
      else stop();
    };
    frame = requestAnimationFrame(tick);
  }
  function choose(id, focus = false) {
    stop();
    pending = id;
    progress = 0.45;
    render();
    draw();
    if (focus) cards.find((card) => card.dataset.motionStyle === id)?.focus();
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
      stop();
      pending = select.value;
      progress = 0.45;
      render();
      const ready = () => {
        if (!dialog.open) return;
        draw();
        if (dialog.classList.contains('morphing') || dialog.classList.contains('is-morphing'))
          requestAnimationFrame(ready);
      };
      requestAnimationFrame(ready);
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
  slider.addEventListener('input', () => {
    stop();
    draw(Number(slider.value) / 100);
  });
  document.getElementById('motion-preview-mid').addEventListener('click', () => {
    stop();
    draw(0.5);
  });
  for (const button of dialog.querySelectorAll('[data-preview-direction]'))
    button.addEventListener('click', () => {
      stop();
      direction = button.dataset.previewDirection;
      render();
      draw();
    });
  dialog.addEventListener('close', stop);
  select.addEventListener('change', render);
  window.addEventListener('resize', () => {
    stop();
    draw();
  });
  window.addEventListener('preferenceschange', () => {
    render();
    if (!enabled()) stop();
    draw();
  });
  new MutationObserver(() => {
    render();
    if (!enabled()) stop();
    draw();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['lang', 'data-motion'] });
  render();
}
