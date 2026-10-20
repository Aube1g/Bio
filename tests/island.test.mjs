import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseLrc } from '../assets/bio/dynamic-island.js';

test('LRC lyrics parse hundredths, millisecond fractions, multiple timestamps, and sort chronologically', () => {
  assert.deepEqual(parseLrc('[ar:Demo]\n[00:03.50]third\n[00:01.2][00:02.025]shared\n[00:04:125]last'), [
    { time: 1.2, text: 'shared' },
    { time: 2.025, text: 'shared' },
    { time: 3.5, text: 'third' },
    { time: 4.125, text: 'last' },
  ]);
});

test('Bio island follows the compact reference shell and keeps only media, lyrics, and weather', async () => {
  const template = await readFile(new URL('../templates/bio-island.html', import.meta.url), 'utf8');
  const implementation = await readFile(new URL('../assets/bio/dynamic-island.js', import.meta.url), 'utf8');
  const intro = await readFile(new URL('../templates/bio-intro.html', import.meta.url), 'utf8');
  const boot = await readFile(new URL('../templates/boot-screen.html', import.meta.url), 'utf8');
  const bootScript = await readFile(new URL('../assets/shared/boot-screen.js', import.meta.url), 'utf8');
  const bootStyles = await readFile(new URL('../assets/shared/experience.css', import.meta.url), 'utf8');
  const bioApp = await readFile(new URL('../assets/bio/app.js', import.meta.url), 'utf8');
  const bioEntry = await readFile(new URL('../assets/bio/entry.js', import.meta.url), 'utf8');
  const settings = await readFile(new URL('../templates/bio.html', import.meta.url), 'utf8');
  const html = template + implementation + intro + boot + bootScript + settings + bioEntry;
  for (const marker of [
    'bio-island-wrap',
    'class="bio-island-trigger"',
    'bio-island-identity',
    'island-quick-grid',
    'island-audio-input',
    'island-lyrics-input',
    'island-lyrics-search-button',
    'lrclib.net',
    'island-weather-location',
    'island-weather-search',
    'api.open-meteo.com',
    'geocoding-api.open-meteo.com',
    'bio-welcome',
    'sound-switch',
    'preloader-mark',
    'apprevealed',
  ])
    assert(html.includes(marker), `Missing Bio experience feature: ${marker}`);
  assert.match(bioApp, /import \{ BioSound \} from '\.\/sound\.js'/);
  assert.match(bioApp, /sound\.play\(control\.matches/);
  assert.match(bioEntry, /addEventListener\('apprevealed', showWelcome/);
  assert.match(bioEntry, /bio\.welcome\.dismissed/);
  assert.match(html, /preloader-orbit-path/);
  assert.match(bootStyles, /@keyframes orbit-turn/);
  assert.match(bootStyles, /@keyframes preloader-mark-float/);
  for (const removed of [
    'island-timer-',
    'island-shelf-',
    'island-qr-',
    'data-island-tab="timer"',
    'data-island-tab="shelf"',
  ])
    assert(!html.includes(removed), `Unrequested island feature remains: ${removed}`);
  assert(!html.includes('class="loader-clock-hand'));
});
