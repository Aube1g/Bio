import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { enterGame } from './ui-helpers.mjs';

const output = process.env.ARTIFACT_DIR || 'test-results/garden-ui';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
  args: JSON.parse(process.env.CHROMIUM_ARGS || '[]'),
  headless: true,
});
const context = await browser.newContext({
  viewport: { width: 1280, height: 950 },
  reducedMotion: 'no-preference',
});
await context.addInitScript(() => {
  window.soundNodes = 0;
  const Audio = window.AudioContext || window.webkitAudioContext;
  if (Audio)
    for (const method of ['createOscillator', 'createBufferSource']) {
      const original = Audio.prototype[method];
      Audio.prototype[method] = function (...args) {
        window.soundNodes++;
        return original.apply(this, args);
      };
    }
});
const page = await context.newPage(),
  errors = [],
  audits = [],
  checks = [];
page.on('pageerror', (error) => errors.push(error.stack));
const pass = (text) => {
  console.log('PASS', text);
  checks.push(text);
};
const saved = () => page.evaluate(() => JSON.parse(sessionStorage.getItem('aubeig.practice.session')));
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
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  audits.push({
    name,
    violations: r.violations.map((v) => ({
      id: v.id,
      nodes: v.nodes.map((n) => ({ target: n.target, reason: n.failureSummary })),
    })),
  });
  await writeFile(`${output}/audits.json`, JSON.stringify(audits, null, 2));
  console.log('AUDIT', name, r.violations.length);
}
try {
  await page.goto(pathToFileURL(resolve('games.html')).href);
  await ready();
  assert(await page.locator('#lobby-launch').isHidden());
  await page.locator('.game-card-main[data-go="dice"]').click();
  assert.equal(await page.locator('html').getAttribute('data-game'), 'lobby');
  assert.equal(await saved(), null);
  const launch = await page.locator('#lobby-launch').boundingBox(),
    dock = await page.locator('.game-dock').boundingBox();
  assert(launch.y + launch.height < dock.y, JSON.stringify({ launch, dock }));
  assert.equal(await page.locator('.game-card-main[data-go="dice"]').getAttribute('aria-pressed'), 'true');
  await page.locator('#launch-selected').click();
  await page.waitForFunction(() => document.documentElement.dataset.game === 'dice');
  assert.equal((await saved()).rounds.length, 0);
  pass('Card selection does not launch or wager; the Play tray appears above the one dock');

  await page.locator('.game-dock [data-open="game-settings-dialog"]').click();
  await rest('game-settings-dialog');
  await page.locator('#pref-sound').check();
  await close('game-settings-dialog');
  const plus = page.locator('[data-bet-step="5"]');
  let box = await plus.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(1150);
  await page.mouse.up();
  const held = Number(await page.locator('#bet-amount').inputValue());
  assert(held >= 25);
  await page.waitForTimeout(250);
  assert.equal(Number(await page.locator('#bet-amount').inputValue()), held);
  await plus.click();
  assert.equal(Number(await page.locator('#bet-amount').inputValue()), held + 5);
  await page.locator('#bet-amount').fill('5');
  await page.locator('#bet-amount').dispatchEvent('change');
  box = await page.locator('[data-bet-step="-5"]').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(700);
  await page.mouse.up();
  assert.equal(await page.locator('#bet-amount').inputValue(), '5');
  const audioBefore = await page.evaluate(() => window.soundNodes);
  await page.locator('#play-button').click();
  await page.waitForFunction(() => document.documentElement.dataset.gameBusy === 'true');
  assert(await plus.isDisabled());
  const durations = await page
    .locator('#dice-cube')
    .evaluate((e) => e.getAnimations().map((a) => a.effect.getTiming().duration));
  assert(durations.includes(2100));
  await page.waitForFunction(() => !document.querySelector('#result-proof').hidden);
  assert(await page.locator('#result-amount').isVisible());
  assert(['win', 'loss', 'push'].includes(await page.locator('#result-strip').getAttribute('data-result')));
  assert(await page.evaluate((before) => window.soundNodes > before, audioBefore));
  pass(
    'Holding +/− repeats and stops, respects limits; Dice is longer and has sound and a prominent receipt',
  );

  await enterGame(page, 'plinko');
  await page.locator('#bet-amount').fill('10');
  await page.locator('#bet-amount').dispatchEvent('change');
  await page.locator('[data-batch="3"]').click();
  assert.equal(await page.locator('#batch-cost').textContent(), '30');
  const before = await saved();
  await page.locator('#play-button').click();
  await page.waitForFunction(() => Number(document.querySelector('#plinko-canvas').dataset.activeBalls) >= 2);
  assert(await page.locator('[data-rows="16"]').isDisabled());
  assert(await plus.isDisabled());
  await page.waitForFunction(() => document.querySelector('#round-queue').hidden, {}, { timeout: 25000 });
  const after = await saved(),
    rounds = after.rounds.filter((r) => !before.rounds.some((old) => old.id === r.id));
  assert.equal(rounds.length, 3);
  assert.equal(after.balance, before.balance - 3000 + rounds.reduce((sum, r) => sum + r.payoutMinor, 0));
  assert.match(await page.locator('#result-title').textContent(), /3/);
  await page.locator('[data-batch="8"]').click();
  const startCount = (await saved()).statistics.rounds;
  await page.evaluate(() => {
    const canvas = document.querySelector('#plinko-canvas');
    const observer = new MutationObserver(() => {
      if (Number(canvas.dataset.activeBalls) > 0) {
        observer.disconnect();
        document.querySelector('.game-dock [data-go="lobby"]').click();
      }
    });
    observer.observe(canvas, { attributes: true, attributeFilter: ['data-active-balls'] });
  });
  await page.locator('#play-button').click();
  await page.waitForFunction(() => document.documentElement.dataset.game === 'lobby');
  await page.waitForTimeout(400);
  const cancelledCount = (await saved()).statistics.rounds;
  await page.waitForTimeout(800);
  assert.equal((await saved()).statistics.rounds, cancelledCount);
  assert(cancelledCount - startCount < 8);
  pass(
    'Plinko batches show total cost, have independent receipts, lock parameters and cancel unsubmitted balls',
  );

  await enterGame(page, 'blackjack');
  await page.locator('#play-button').click();
  await page.waitForFunction(() => document.querySelector('#board-blackjack').dataset.turn === 'dealing');
  const firstCards = await page.locator('#player-hand .playing-card:not(.card-back)').count();
  assert(firstCards < 2);
  await page.waitForFunction(() => document.documentElement.dataset.gameBusy === 'false');
  const hand = (await saved()).rounds.find((r) => r.game === 'blackjack');
  if (hand.status === 'active') {
    await page.locator('[data-bj-action="stand"]').click();
    await page.waitForFunction(() => document.querySelector('#board-blackjack').dataset.turn === 'dealer');
    await page.waitForFunction(
      () =>
        !document.querySelector('#result-proof').hidden &&
        document.documentElement.dataset.gameBusy === 'false',
    );
  }
  assert.equal(await page.locator('#board-blackjack').getAttribute('data-turn'), 'settled');
  assert.equal(await page.locator('#dealer-hand .card-back').count(), 0);
  pass(
    'Blackjack deals visibly in order, shows the active turn and reveals the dealer before settlement feedback',
  );

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator('.game-dock [data-open="game-settings-dialog"]').click();
  await page.locator('#pref-theme').check();
  await close('game-settings-dialog');
  await audit('garden-blackjack-light');
  await enterGame(page, 'lobby');
  await page.locator('.game-card-main[data-go="slots"]').click();
  await audit('selection-light');
  await page.screenshot({ path: `${output}/selection-light.png` });
  await page.locator('#launch-selected').click();
  await page.waitForFunction(() => document.documentElement.dataset.game === 'slots');
  await page.locator('#play-button').click();
  await page.waitForFunction(() => !document.querySelector('#result-proof').hidden);
  await audit('slots-result-light');
  await page.setViewportSize({ width: 320, height: 850 });
  await enterGame(page, 'plinko');
  await page.locator('[data-batch="5"]').click();
  await audit('batch-plinko-light-320');
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));

  await page.goto(pathToFileURL(resolve('bio.html')).href);
  await ready();
  await page.locator('.rail-link[data-view="partners"]').click();
  assert.equal(await page.locator('[data-partner="firstplatform"]').getAttribute('aria-disabled'), 'true');
  assert.equal(
    await page.locator('[data-partner="firstplatform"] a,[data-partner="firstplatform"] button').count(),
    0,
  );
  const inactive = await page.locator('[data-partner="firstplatform"]').boundingBox();
  await page.mouse.click(inactive.x + inactive.width / 2, inactive.y + inactive.height / 2);
  assert.equal(await page.locator('dialog[open]').count(), 0);
  await audit('inactive-fp-320');
  await page.locator('.rail-action[data-dialog="settings-dialog"]').click();
  await page.locator('#settings-dialog [data-dialog="license-dialog"]').click();
  assert.doesNotMatch(
    await page.locator('#license-dialog').textContent(),
    /Nunito|Font Awesome|Шрифт и иконки/,
  );
  await close('license-dialog');
  const glass = page.locator('#glass-switch');
  await glass.uncheck();
  const opaque = await page
    .locator('#ripple-switch')
    .evaluate((e) => getComputedStyle(e.parentElement.querySelector('.glass-switch-lens')).backgroundImage);
  assert.equal(opaque, 'none');
  await glass.check();
  assert.notEqual(
    await page
      .locator('#ripple-switch')
      .evaluate((e) => getComputedStyle(e.parentElement.querySelector('.glass-switch-lens')).backgroundImage),
    'none',
  );
  await close('settings-dialog');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator('.rail-link[data-view="lab"]').click();
  await page.locator('#lab-cli').scrollIntoViewIfNeeded();
  await page.locator('#lab-cli [data-demo-step]').click();
  const stepped = await page
    .locator('#lab-cli')
    .evaluate((e) => ({ index: e._player.index, total: e._player.queue.length }));
  assert(stepped.index > 0 && stepped.index < stepped.total);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.waitForFunction(() => {
    const p = document.querySelector('#lab-cli')._player;
    return p.index > 0 && p.index < p.queue.length && !p.paused;
  });
  const index = await page.locator('#lab-cli').evaluate((e) => e._player.index);
  await page.waitForFunction((index) => document.querySelector('#lab-cli')._player.index > index, index);
  await page.locator('[data-agent="xgo"]').click();
  await page.locator('#lab-chat').scrollIntoViewIfNeeded();
  await page.waitForFunction(() => {
    const p = document.querySelector('#lab-chat')._player;
    return p.index > 0 && p.index < p.queue.length;
  });
  pass('FP is inactive; CPL has no site/font note; glass affects controls; XLI and XGO resume real playback');
  assert.deepEqual(errors, []);
  await writeFile(`${output}/result.json`, JSON.stringify({ checks, audits, errors }, null, 2));
  assert(
    audits.every((a) => a.violations.length === 0),
    'See audits.json',
  );
} finally {
  await browser.close();
}
