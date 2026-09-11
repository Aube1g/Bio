import { enterGame } from './ui-helpers.mjs';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const output = process.env.ARTIFACT_DIR || 'test-results/experience-ui';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
  args: JSON.parse(process.env.CHROMIUM_ARGS || '[]'),
  headless: true,
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  reducedMotion: 'no-preference',
});
await context.addInitScript(() => {
  window.experienceTrace = [];
  const sample = () =>
    window.experienceTrace.push({
      boot: document.documentElement?.dataset.booting,
      hands: document.querySelectorAll('.loader-clock-hand').length,
      text: document.querySelectorAll('[data-text-motion]').length,
    });
  document.addEventListener('DOMContentLoaded', sample);
  new MutationObserver(sample).observe(document, {
    subtree: true,
    attributes: true,
    attributeFilter: ['data-booting', 'data-text-motion'],
  });
});

const page = await context.newPage(),
  errors = [],
  audits = [];
page.on('pageerror', (e) => errors.push(e.stack));
const ready = () =>
  page.waitForFunction(
    () => document.documentElement.dataset.ready === 'true' && !document.documentElement.dataset.booting,
  );
const rest = (id) =>
  page.waitForFunction((id) => {
    const e = document.getElementById(id);
    return e.open && !e.classList.contains('morphing') && !e.classList.contains('is-morphing');
  }, id);
async function close(id) {
  await page.keyboard.press('Escape');
  await page.waitForFunction((id) => !document.getElementById(id).open, id);
}
async function audit(name) {
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  audits.push({
    name,
    violations: result.violations.map((v) => ({
      id: v.id,
      nodes: v.nodes.map((n) => ({ target: n.target, reason: n.failureSummary })),
    })),
  });
  await writeFile(`${output}/audits.json`, JSON.stringify(audits, null, 2));
  console.log('AUDIT', name, result.violations.length);
}
try {
  await page.goto('file://' + resolve('games.html'));
  await ready();
  await page.waitForFunction(() => window.experienceTrace.some((item) => item.text > 0));
  const trace = await page.evaluate(() => window.experienceTrace);
  assert(trace.some((item) => item.boot === 'true' && item.hands === 3));
  console.log('PASS original clock preloader is visible, finishes, and hands off to text reveals');
  await page.locator('.game-dock [data-open="game-settings-dialog"]').click();
  await rest('game-settings-dialog');
  const lens = await page.locator('#pref-ripple').evaluate((input) => {
    const lens = input.parentElement.querySelector('.glass-switch-lens');
    const style = getComputedStyle(lens);
    return {
      width: lens.offsetWidth,
      height: lens.offsetHeight,
      target: input.parentElement.clientHeight,
      border: style.borderRadius,
    };
  });
  assert.equal(lens.width, 46);
  assert.equal(lens.height, 26);
  assert(lens.target >= 44);
  await page.locator('[data-motion-picker]').click();
  await rest('motion-picker-dialog');
  const names = await page
    .locator('[data-motion-style]')
    .evaluateAll((nodes) => nodes.map((n) => n.dataset.motionStyle));
  assert(!names.includes('shutters') && !names.includes('cascade'));
  assert(
    names.includes('star') && names.includes('bloom') && names.includes('orbit') && names.includes('ribbon'),
  );
  const samples = [];
  for (const name of names.filter((name) => name !== 'mix')) {
    await page.locator(`[data-motion-style="${name}"]`).click();
    samples.push(
      await page.locator('.motion-preview-window').evaluate((e) => e.style.clipPath + e.style.transform),
    );
    if (['star', 'bloom', 'orbit', 'ribbon'].includes(name))
      await page.locator('.motion-preview-stage').screenshot({ path: `${output}/${name}.png` });
  }
  assert.equal(new Set(samples).size, names.length - 1);
  await page.locator('[data-motion-style="star"]').click();
  await page.locator('#motion-preview-progress').evaluate((e) => {
    e.value = '25';
    e.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const opening = await page.locator('.motion-preview-window').evaluate((e) => e.style.clipPath);
  await page.locator('[data-preview-direction="close"]').click();
  assert.notEqual(await page.locator('.motion-preview-window').evaluate((e) => e.style.clipPath), opening);
  await page.locator('#motion-preview-mid').click();
  assert.equal(await page.locator('#motion-preview-progress').inputValue(), '50');
  await page.locator('#motion-preview-replay').click();
  await page.waitForFunction(
    () => document.querySelector('.motion-preview-stage').dataset.playing === 'true',
  );
  await page.waitForFunction(
    () => !document.querySelector('.motion-preview-stage').dataset.playing,
    {},
    { timeout: 15000 },
  );
  await page.locator('#motion-apply').click();
  await page.waitForFunction(() => !document.querySelector('#motion-picker-dialog').open);
  await close('game-settings-dialog');
  console.log('PASS flattened pill lenses; eight distinct frame recipes, scrubbing and open/close playback');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator('#practice-launch').click();
  await enterGame(page, 'plinko');
  await page.locator('#play-button').click();
  await page.locator('#result-proof').waitFor();
  await audit('local-plinko-dark');
  await enterGame(page, 'blackjack');
  await page.locator('#rules-button').click();
  assert(await page.locator('#rules-content .inline-pill').count());
  assert(await page.locator('#rules-content .rich-emphasis').count());
  assert(await page.locator('#rules-content .inline-code').count());
  await audit('rich-rules-dark');
  await close('rules-dialog');
  await page.locator('.game-dock [data-open="game-settings-dialog"]').click();
  await page.locator('#pref-theme').check();
  await page.locator('[data-language="en"]').click();
  await audit('pill-settings-light');
  await page.locator('[data-motion-picker]').click();
  await audit('new-gallery-light');
  await page.setViewportSize({ width: 320, height: 850 });
  assert(await page.locator('#motion-picker-dialog').evaluate((e) => e.scrollWidth <= e.clientWidth));
  await audit('new-gallery-320');
  await close('motion-picker-dialog');
  await close('game-settings-dialog');
  for (const game of ['lobby', 'plinko', 'dice', 'slots', 'blackjack']) {
    await enterGame(page, game);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  }
  await audit('local-game-320-light');

  await page.goto('file://' + resolve('bio.html'));
  await ready();
  await page.locator('.bio-profile-open').click();
  await audit('bio-profile-pills-320');
  await close('bio-profile-dialog');
  await page.locator('.rail-link[data-view="projects"]').click();
  await page.locator('#projects [data-project="xli"]').click();
  assert(await page.locator('#detail-content .inline-pill').count());
  await audit('bio-rich-project-320');
  await close('detail-dialog');
  await page.locator('.rail-action[data-dialog="settings-dialog"]').click();
  await page.locator('[data-motion-picker]').click();
  await page.locator('[data-motion-style="star"]').click();
  assert.equal(await page.locator('.motion-preview-stage').getAttribute('data-sample'), 'star');
  assert(await page.locator('#motion-preview-replay').isDisabled());
  await audit('bio-gallery-320');
  assert.deepEqual(errors, []);
  await writeFile(
    `${output}/result.json`,
    JSON.stringify({ lens, names, distinct: new Set(samples).size, errors, audits }, null, 2),
  );
  assert(
    audits.every((result) => result.violations.length === 0),
    'See audits.json',
  );
  console.log('PASS local games, reduced motion, text accents, two themes, English and 320px');
} finally {
  await browser.close();
}
