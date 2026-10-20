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

test('Bio ships the browser-safe island features and the ring-free morph preloader', async () => {
  const html = await readFile(new URL('../bio.html', import.meta.url), 'utf8');
  for (const marker of [
    'bio-island-trigger',
    'data-island-tab="player"',
    'data-island-tab="timer"',
    'data-island-tab="shelf"',
    'data-island-tab="tools"',
    'island-audio-input',
    'island-lyrics-input',
    'island-lyrics-search-button',
    'lrclib.net',
    'island-qr-camera',
    'island-weather-refresh',
    'bio-welcome',
    'preloader-mark',
    'apprevealed',
  ])
    assert(html.includes(marker), `Missing Bio experience feature: ${marker}`);
  assert(!html.includes('class="loader-clock-hand'));
  assert(html.includes('api.open-meteo.com'));
});
