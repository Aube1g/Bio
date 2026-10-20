import { finishBoot } from '../shared/boot-screen.js';
import { initializeTextMotion } from '../shared/text-motion.js';
import { initializeMotionPicker } from '../shared/motion-picker.js';
import './app.js';
import { $, $$ } from '../shared/dom.js';
import { readPreferences, safeStorage } from '../shared/preferences.js';
import { ExpandingIsland } from '../shared/island.js';
import { initializeSwitches } from '../shared/controls.js';
import { initializeDynamicIsland } from './dynamic-island.js';

const element = $('#bio-island');
const trigger = $('#bio-island-trigger');
const island = new ExpandingIsland(element, trigger, $('#bio-island-panel'));
initializeDynamicIsland(island);
initializeSwitches();
initializeMotionPicker(document.getElementById('transition-select'));
$$('.rail-link').forEach((link, index) => link.setAttribute('aria-keyshortcuts', `Alt+${index + 1}`));

function updateIsland() {
  const english = document.documentElement.lang === 'en';
  const transitioning = $('#view-stage')?.getAttribute('aria-busy') === 'true';
  element.dataset.activity = transitioning ? 'transition' : 'idle';
  const status = document.getElementById('island-live-label');
  if (status && !element.matches('[data-playing="true"]'))
    status.textContent = transitioning ? (english ? 'CHANGING' : 'ПЕРЕХОД') : english ? 'READY' : 'ГОТОВ';
}
new MutationObserver(updateIsland).observe($('#view-stage'), {
  attributes: true,
  attributeFilter: ['aria-busy'],
});
new MutationObserver(updateIsland).observe(document.documentElement, {
  attributes: true,
  attributeFilter: ['lang'],
});
updateIsland();

// Small bilingual labels in the island and welcome screen follow the site's language setting.
function translateInline() {
  const english = document.documentElement.lang === 'en';
  document.querySelectorAll('[data-i18n-ru][data-i18n-en]').forEach((node) => {
    node.textContent = english ? node.dataset.i18nEn : node.dataset.i18nRu;
  });
  const welcomeCopy = english
    ? {
        'welcome-kicker': 'YOUR DIGITAL ORBIT',
        'welcome-title': 'Everything that matters.<br><em>On your own orbit.</em>',
        'welcome-description':
          'Bio is your personal hub: projects, games, and tools in one living space. Start with your profile or open the compact island above.',
        'welcome-step-one': 'Explore',
        'welcome-hint-one': 'choose games and projects',
        'welcome-step-two': 'Personalize',
        'welcome-hint-two': 'make the space yours',
        'welcome-step-three': 'Discover',
        'welcome-hint-three': 'quick tools in the island',
        'welcome-remember-copy': 'Do not show again',
        'welcome-explore': 'Explore Bio <span>↗</span>',
        'welcome-island': 'Open the island <span>↓</span>',
        'welcome-foot-copy': 'MADE FOR YOU <i>✳</i> RUNS IN YOUR BROWSER',
      }
    : {
        'welcome-kicker': 'ТВОЯ ЦИФРОВАЯ ОРБИТА',
        'welcome-title': 'Всё важное.<br><em>На своей орбите.</em>',
        'welcome-description':
          'Bio — твой личный центр: проекты, игры и инструменты собраны в одном живом пространстве. Начни с профиля или загляни в компактный остров сверху.',
        'welcome-step-one': 'Исследуй',
        'welcome-hint-one': 'выбирай игры и проекты',
        'welcome-step-two': 'Персонализируй',
        'welcome-hint-two': 'собери своё оформление',
        'welcome-step-three': 'Открывай',
        'welcome-hint-three': 'остров — быстрые инструменты',
        'welcome-remember-copy': 'Больше не показывать',
        'welcome-explore': 'Исследовать Bio <span>↗</span>',
        'welcome-island': 'Открыть остров <span>↓</span>',
        'welcome-foot-copy': 'СОЗДАНО ДЛЯ ТЕБЯ <i>✳</i> РАБОТАЕТ В ТВОЁМ БРАУЗЕРЕ',
      };
  for (const [id, text] of Object.entries(welcomeCopy)) {
    const node = document.getElementById(id);
    if (node)
      id.includes('title') || id.includes('foot') || id.includes('explore') || id.includes('island')
        ? (node.innerHTML = text)
        : (node.textContent = text);
  }
  const skip = document.getElementById('welcome-skip');
  if (skip) skip.setAttribute('aria-label', english ? 'Close' : 'Закрыть');
  const lyricsQuery = document.getElementById('island-lyrics-query');
  if (lyricsQuery) {
    lyricsQuery.placeholder = english ? 'Artist and title' : 'Исполнитель и название';
    lyricsQuery.setAttribute('aria-label', english ? 'Search synced lyrics' : 'Поиск синхронного текста');
  }
  updateIsland();
}
new MutationObserver(translateInline).observe(document.documentElement, {
  attributes: true,
  attributeFilter: ['lang'],
});
translateInline();

const welcome = document.getElementById('bio-welcome');
let welcomeReturnFocus = null;
function dismissWelcome({ remember = false, openIsland = false } = {}) {
  if (!welcome || welcome.hidden) return;
  const finish = () => {
    welcome.hidden = true;
    if (remember && document.getElementById('welcome-remember').checked)
      safeStorage.set('bio.welcome.dismissed', 'true');
    welcomeReturnFocus?.focus?.({ preventScroll: true });
    welcomeReturnFocus = null;
    if (openIsland) island.toggle(true);
  };
  if (
    document.documentElement.dataset.motion === 'off' ||
    matchMedia('(prefers-reduced-motion: reduce)').matches ||
    !welcome.animate
  ) {
    finish();
    return;
  }
  const card = welcome.querySelector('.welcome-card');
  const animation = card.animate(
    [
      { opacity: 1, transform: 'translateY(0) scale(1)', filter: 'blur(0)' },
      { opacity: 0, transform: 'translateY(12px) scale(.97)', filter: 'blur(5px)' },
    ],
    { duration: 240, easing: 'cubic-bezier(.4,0,1,1)', fill: 'forwards' },
  );
  animation.finished.then(finish).catch(finish);
}
function showWelcome() {
  if (!welcome || safeStorage.get('bio.welcome.dismissed') === 'true') return;
  welcomeReturnFocus = document.activeElement;
  welcome.hidden = false;
  requestAnimationFrame(() => document.getElementById('welcome-explore')?.focus({ preventScroll: true }));
}
if (welcome) {
  window.addEventListener('apprevealed', showWelcome, { once: true });
  document.getElementById('welcome-skip').addEventListener('click', () => dismissWelcome({ remember: true }));
  document
    .getElementById('welcome-explore')
    .addEventListener('click', () => dismissWelcome({ remember: true }));
  document
    .getElementById('welcome-island')
    .addEventListener('click', () => dismissWelcome({ remember: true, openIsland: true }));
  welcome.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      dismissWelcome({ remember: true });
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [...welcome.querySelectorAll('button:not([disabled]),input:not([disabled])')];
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
}

function synchronizePreferences() {
  const root = document.documentElement;
  const current = readPreferences();
  Object.assign(current, { theme: root.dataset.theme, lang: root.lang, background: root.dataset.background });
  for (const key of ['ripple', 'particles', 'liquid', 'glass']) current[key] = root.dataset[key] === 'true';
  const transition = document.getElementById('transition-select');
  if (transition) current.transition = transition.value;
  current.motion = safeStorage.get('bio.motion') !== 'off';
  safeStorage.set('aubeig.preferences', JSON.stringify(current));
}
document.addEventListener('change', (event) => {
  if (event.target.closest('#settings-dialog')) queueMicrotask(synchronizePreferences);
});
document.addEventListener('click', (event) => {
  if (event.target.closest('[data-language],button[data-background],[data-theme-toggle],#reset-settings'))
    queueMicrotask(synchronizePreferences);
});
document.addEventListener('keydown', (event) => {
  if (
    !event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.target.closest('input,textarea,select') ||
    document.querySelector('dialog[open]')
  )
    return;
  const index = Number(event.key) - 1;
  const link = $$('.rail-link')[index];
  if (link) {
    event.preventDefault();
    link.click();
  }
});

document.querySelectorAll('[data-profile-view]').forEach((button) =>
  button.addEventListener('click', async () => {
    const dialog = button.closest('dialog');
    const closed = new Promise((resolve) => dialog.addEventListener('close', resolve, { once: true }));
    dialog.querySelector('[data-close]').click();
    await closed;
    document.querySelector(`.rail-link[data-view="${button.dataset.profileView}"]`)?.click();
  }),
);

initializeTextMotion();
document.documentElement.dataset.ready = 'true';
finishBoot();
