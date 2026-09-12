import { $, $$ } from '../shared/dom.js';
import { preferences, savePreferences, resetPreferences, reducedMotion } from '../shared/preferences.js';
import { t } from './strings.js';

export function renderSettings() {
  $$('[data-preference]').forEach((input) => {
    input.checked =
      input.dataset.preference === 'theme'
        ? preferences.theme === 'light'
        : Boolean(preferences[input.dataset.preference]);
    if (input.dataset.preference === 'motion') {
      input.disabled = reducedMotion.matches;
      input.checked = preferences.motion && !reducedMotion.matches;
    }
  });
  $$('[data-language]').forEach((button) =>
    button.setAttribute('aria-pressed', String(button.dataset.language === preferences.lang)),
  );
  $$('button[data-background]').forEach((button) =>
    button.setAttribute('aria-pressed', String(button.dataset.background === preferences.background)),
  );
  $$('[data-table-color]').forEach((button) =>
    button.setAttribute('aria-pressed', String(button.dataset.tableColor === preferences.table)),
  );
  $('#transition-style').value = preferences.transition;
  $('#sound-volume').value = Math.round(preferences.volume * 100);
  $('#sound-volume-value').textContent = Math.round(preferences.volume * 100) + '%';
  $('#sound-volume').disabled = !preferences.sound;
  $('#sound-volume').style.setProperty('--fill', Math.round(preferences.volume * 100) + '%');
  $('#reduced-note').hidden = !reducedMotion.matches;
}

export function bindSettings(sound, notify) {
  $$('[data-preference]').forEach((input) =>
    input.addEventListener('change', () => {
      savePreferences({
        [input.dataset.preference]:
          input.dataset.preference === 'theme' ? (input.checked ? 'light' : 'dark') : input.checked,
      });
      if (input.dataset.preference === 'sound' && input.checked) {
        sound.unlock();
        sound.tone(660);
      }
    }),
  );
  $$('[data-language]').forEach((button) =>
    button.addEventListener('click', () => savePreferences({ lang: button.dataset.language })),
  );
  $$('button[data-background]').forEach((button) =>
    button.addEventListener('click', () => savePreferences({ background: button.dataset.background })),
  );
  $$('[data-table-color]').forEach((button) =>
    button.addEventListener('click', () => savePreferences({ table: button.dataset.tableColor })),
  );
  $('#transition-style').addEventListener('change', (event) =>
    savePreferences({ transition: event.target.value }),
  );
  $('#sound-volume').addEventListener('input', (event) =>
    savePreferences({ volume: Number(event.target.value) / 100 }),
  );
  $('#reset-preferences').addEventListener('click', () => {
    resetPreferences();
    notify(t('settingsReset'));
  });
  renderSettings();
}
