import { finishBoot } from '../shared/boot-screen.js';
import { initializeTextMotion } from '../shared/text-motion.js';
import { initializeMotionPicker } from '../shared/motion-picker.js';
import './app.js';
import { $, $$ } from '../shared/dom.js';
import { readPreferences, safeStorage } from '../shared/preferences.js';
import { ExpandingIsland } from '../shared/island.js';
import { initializeSwitches } from '../shared/controls.js';

const element = $('#bio-island');
const trigger = $('.bio-island-trigger');
const island = new ExpandingIsland(element, trigger, $('#bio-island-panel'));
initializeSwitches();
initializeMotionPicker(document.getElementById('transition-select'));
$$('.rail-link').forEach((link, index) => link.setAttribute('aria-keyshortcuts', `Alt+${index + 1}`));

function updateIsland() {
  const english = document.documentElement.lang === 'en';
  $('#bio-island-section').textContent = $('#view-label').textContent;
  const transitioning = $('#view-stage').getAttribute('aria-busy') === 'true';
  element.dataset.activity = transitioning ? 'transition' : 'idle';
  $('#bio-island-status').textContent = transitioning
    ? $('#view-label').textContent
    : english
      ? 'Open to ideas'
      : 'Открыт к идеям';
  $('.bio-island-time').textContent = new Intl.DateTimeFormat(document.documentElement.lang, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date());
}
new MutationObserver(updateIsland).observe($('#view-stage'), {
  attributes: true,
  attributeFilter: ['aria-busy'],
});
new MutationObserver(updateIsland).observe($('#view-label'), { childList: true });
new MutationObserver(updateIsland).observe(document.documentElement, {
  attributes: true,
  attributeFilter: ['lang'],
});
updateIsland();
setInterval(updateIsland, 60_000);

document.addEventListener('click', (event) => {
  if (event.target.closest('.bio-island-panel [data-dialog],.bio-island-panel a')) island.toggle(false);
});
let copyTimer;
$('#island-copy-contact').addEventListener('click', async () => {
  let copied = false;
  try {
    await navigator.clipboard.writeText('@Aubeig');
    copied = true;
  } catch {
    const input = Object.assign(document.createElement('textarea'), { value: '@Aubeig' });
    input.style.cssText = 'position:fixed;left:-9999px;top:0';
    document.body.append(input);
    input.select();
    try {
      copied = document.execCommand('copy');
    } catch {
      /* Keep the contact visible. */
    }
    input.remove();
    $('#island-copy-contact').focus({ preventScroll: true });
  }
  const text = $('#island-copy-contact span');
  text.textContent = copied ? (document.documentElement.lang === 'en' ? 'Copied' : 'Скопировано') : '@Aubeig';
  clearTimeout(copyTimer);
  copyTimer = setTimeout(() => {
    text.textContent = '@Aubeig';
  }, 1800);
});

function synchronizePreferences() {
  const root = document.documentElement;
  const current = readPreferences();
  Object.assign(current, { theme: root.dataset.theme, lang: root.lang, background: root.dataset.background });
  for (const key of ['ripple', 'particles', 'liquid', 'glass']) current[key] = root.dataset[key] === 'true';
  current.transition = $('#transition-select').value;
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
document.documentElement.dataset.ready = 'true';

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
finishBoot();
