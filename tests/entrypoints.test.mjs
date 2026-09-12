import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const hash = (data) => createHash('sha256').update(data).digest('hex');

test('Both downloadable portal entrypoints contain exactly the same current implementation', async () => {
  const [canonical, legacy] = await Promise.all([
    readFile(new URL('../games.html', import.meta.url)),
    readFile(new URL('../Портал (2).html', import.meta.url)),
  ]);
  assert.equal(
    hash(legacy),
    hash(canonical),
    'Run npm run build; never leave an old portal at the uploaded filename.',
  );
  const html = canonical.toString();
  for (const marker of [
    'practice-launch',
    'PracticeStore',
    'glass-switch-lens',
    'motion-preview-progress',
    'data-motion-style="star"',
    'loader-clock-hand',
    'initializeTextMotion',
    'inline-pill',
  ]) {
    assert(html.includes(marker), `Missing current portal feature: ${marker}`);
  }
  assert(!html.includes('data-motion-style="cascade"'));
  assert(!html.includes('data-motion-style="shutters"'));
});

test('The uploaded original portal and original index are preserved without edits', async () => {
  assert.equal(
    hash(await readFile(new URL('../references/portal-original.html', import.meta.url))),
    'a35d4e0671577cb5473b85d4123c8c4d37e954eed6e0621fed11e7e46d1cce12',
  );
  assert.equal(
    hash(await readFile(new URL('../index.html', import.meta.url))),
    '4ae9ea9b1bf4009212bc41b84fb1c7204f0c8b87f9d93b2b6cf6c546acdf0607',
  );
});
