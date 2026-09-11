import { TRANSITION_STYLES } from './desktop-motion.js';
const defaults = {
  theme: 'dark',
  lang: 'ru',
  motion: true,
  ripple: true,
  particles: true,
  liquid: true,
  glass: true,
  background: 'constellation',
  table: 'royal',
  transition: 'hyprland',
  sound: false,
  volume: 0.25,
};
const memory = new Map();
export const safeStorage = {
  get(key) {
    if (memory.has(key)) return memory.get(key);
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    memory.set(key, value);
    try {
      localStorage.setItem(key, value);
    } catch {
      /* Session-only preferences remain available. */
    }
  },
};
const legacy = { particles: 'fx', liquid: 'liq' };
export function readPreferences() {
  let stored = {};
  try {
    const parsed = JSON.parse(safeStorage.get('aubeig.preferences') || '{}');
    stored = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    /* Fall back to individual preferences. */
  }
  const result = { ...defaults };
  for (const key of Object.keys(defaults)) {
    const value =
      stored[key] ?? safeStorage.get('bio.' + key) ?? safeStorage.get('ab_' + (legacy[key] || key));
    if (value == null) continue;
    if (typeof defaults[key] === 'boolean') result[key] = ![false, 'false', 'off'].includes(value);
    else result[key] = value;
  }
  if (!['dark', 'light'].includes(result.theme)) result.theme = 'dark';
  if (!['ru', 'en'].includes(result.lang)) result.lang = 'ru';
  if (!['constellation', 'aurora', 'plain'].includes(result.background)) result.background = 'constellation';
  if (!['royal', 'green', 'crimson', 'midnight', 'gold'].includes(result.table)) result.table = 'royal';
  if (!['mix', ...TRANSITION_STYLES].includes(result.transition)) result.transition = 'mix';
  result.volume = Math.max(0, Math.min(1, Number(result.volume) || 0));
  return result;
}
export let preferences = readPreferences();
export const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
export const motionEnabled = () => preferences.motion && !reducedMotion.matches;
export function applyPreferences() {
  const root = document.documentElement;
  root.lang = preferences.lang;
  root.dataset.theme = preferences.theme;
  root.dataset.motion = motionEnabled() ? 'on' : 'off';
  for (const key of ['ripple', 'particles', 'liquid', 'glass', 'background', 'table'])
    root.dataset[key] = String(preferences[key]);
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', preferences.theme === 'dark' ? '#080813' : '#f5f7ff');
  window.dispatchEvent(new CustomEvent('preferenceschange', { detail: preferences }));
}
export function savePreferences(patch) {
  preferences = { ...preferences, ...patch };
  safeStorage.set('aubeig.preferences', JSON.stringify(preferences));
  for (const [key, value] of Object.entries(preferences))
    safeStorage.set('bio.' + key, typeof value === 'boolean' ? (value ? 'on' : 'off') : String(value));
  applyPreferences();
}
export const resetPreferences = () => savePreferences(defaults);
export function installPreferenceListeners() {
  reducedMotion.addEventListener('change', applyPreferences);
  window.addEventListener('storage', (event) => {
    if (event.key === 'aubeig.preferences') {
      memory.delete(event.key);
      preferences = readPreferences();
      applyPreferences();
    }
  });
}
