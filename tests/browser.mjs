import { enterGame } from './ui-helpers.mjs';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

const base = process.env.BASE_URL || 'http://127.0.0.1:8000';
const artifacts = process.env.ARTIFACT_DIR || 'test-results/browser';
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
  args: JSON.parse(process.env.CHROMIUM_ARGS || '[]'),
  headless: true,
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  reducedMotion: 'reduce',
});
const page = await context.newPage();
const errors = [],
  audits = [],
  steps = [];
page.on('pageerror', (error) => {
  errors.push(error.stack);
  console.error(error.stack);
});
const pass = (message) => {
  steps.push(message);
  console.log('PASS', message);
};
async function session() {
  return page.evaluate(() => fetch('/api/session').then((r) => r.json()));
}
async function ready() {
  await page.waitForFunction(() => document.documentElement.dataset.ready === 'true');
}
async function audit(name) {
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  audits.push({
    name,
    violations: result.violations.map((v) => ({
      id: v.id,
      nodes: v.nodes.map((n) => ({ target: n.target, message: n.failureSummary })),
    })),
  });
  console.log('AUDIT', name, result.violations.length);
  await writeFile(`${artifacts}/audits.json`, JSON.stringify(audits, null, 2));
}
async function game(name) {
  await enterGame(page, name);
  await page.waitForFunction((name) => document.documentElement.dataset.game === name, name);
}
async function play(name) {
  const promise = page.waitForResponse(
    (r) => r.url().endsWith('/api/games/' + name) && r.request().method() === 'POST' && r.status() === 200,
  );
  await page.locator('#play-button').click();
  const data = await (await promise).json();
  await page.waitForFunction(() => document.querySelector('#play-button').dataset.busy === 'false');
  if (data.round.status === 'settled') await page.locator('#result-proof').waitFor({ state: 'visible' });
  return data.round;
}
async function proof(round) {
  await page.locator('#result-proof').click();
  await page.locator('#verify-round').click();
  await page.waitForFunction(() =>
    /совпадают|match/.test(document.querySelector('#verify-status').textContent),
  );
  assert.match(await page.locator('#proof-content').textContent(), new RegExp(round.proof.hash));
  await page.keyboard.press('Escape');
}
try {
  await page.goto(base + '/games.html');
  await ready();
  assert.equal(await page.locator('nav').count(), 1);
  assert.equal(await page.locator('.game-card').count(), 4);
  const missing = await page.evaluate(() =>
    [...document.querySelectorAll('use[href]')]
      .map((e) => e.getAttribute('href'))
      .filter((h) => h.startsWith('#') && !document.getElementById(h.slice(1))),
  );
  assert.deepEqual(missing, []);
  await audit('lobby-dark');
  await page.locator('#account-button').click();
  await audit('auth');
  await page.locator('#telegram-login').click();
  await page.waitForFunction(() =>
    /недоступен|unavailable/.test(document.querySelector('#auth-error').textContent),
  );
  assert.equal((await session()).user, null);
  await page.locator('#guest-login').click();
  await page.waitForFunction(() => !document.querySelector('#auth-dialog').open);
  const first = await session();
  assert.equal(first.user.kind, 'guest');
  assert.equal(first.wallet.balanceMinor, 100000);
  pass('Real guest session; unavailable Telegram does not impersonate an account');

  for (const name of ['dice', 'slots', 'plinko']) {
    await game(name);
    const before = (await session()).wallet.balanceMinor;
    const round = await play(name);
    const after = await session();
    assert.equal(after.wallet.balanceMinor, before - round.betMinor + round.payoutMinor);
    if (name === 'dice') {
      assert.equal(Number(await page.locator('#dice-cube').getAttribute('data-value')), round.outcome.face);
      assert.equal(await page.locator('#dice-cube .cube-face').count(), 6);
    }
    if (name === 'slots')
      assert.equal(
        await page.locator('#slot-reels').getAttribute('data-symbols'),
        round.outcome.symbols.join(','),
      );
    if (name === 'plinko')
      assert.equal(
        Number(await page.locator('#plinko-bins').getAttribute('data-landed')),
        round.outcome.slot,
      );
    await proof(round);
    await audit(name + '-dark');
    pass(name + ': receipt, visible result, wallet arithmetic and browser verification');
  }

  await game('blackjack');
  let hand;
  for (let i = 0; i < 12; i++) {
    hand = await play('blackjack');
    if (hand.status === 'active') break;
  }
  assert.equal(hand.status, 'active');
  assert.equal(hand.proof.serverSeed, undefined);
  const savedBalance = (await session()).wallet.balanceMinor;
  await page.reload();
  await ready();
  await page.waitForFunction(
    () => document.querySelectorAll('#player-hand .playing-card:not(.card-back)').length === 2,
  );
  assert.equal(await page.locator('#dealer-hand .card-back').count(), 1);
  assert.equal((await session()).wallet.balanceMinor, savedBalance);
  const doubleResponse = page.waitForResponse(
    (r) => r.url().includes('/api/blackjack/') && r.status() === 200,
  );
  await page.locator('[data-bj-action="double"]').click();
  const doubled = (await (await doubleResponse).json()).round;
  assert.equal(doubled.betMinor, hand.betMinor * 2);
  assert.equal(doubled.status, 'settled');
  await page.locator('#result-proof').waitFor({ state: 'visible' });
  await proof(doubled);
  await audit('blackjack-dark');
  pass('Blackjack resumes after reload without a refund; double settles once and verifies');

  // A response disappears after the server committed it. The client retries the SAME key.
  await game('dice');
  let drop = true,
    lostRound;
  const roundsBefore = (await session()).stats.rounds;
  await page.route('**/api/games/dice', async (route) => {
    if (drop) {
      drop = false;
      const response = await route.fetch();
      lostRound = (await response.json()).round;
      await route.abort('failed');
    } else await route.continue();
  });
  const repeated = await play('dice');
  await page.unroute('**/api/games/dice');
  assert.equal(repeated.id, lostRound.id);
  assert.equal((await session()).stats.rounds, roundsBefore + 1);
  pass('Lost HTTP response retries safely: one round, one debit');
  const unchanged = (await session()).wallet.balanceMinor;
  await page.evaluate(() => localStorage.setItem('ab_balance', '999999999'));
  await page.reload();
  await ready();
  assert.equal((await session()).wallet.balanceMinor, unchanged);
  pass('Editing legacy localStorage cannot change the server wallet');

  await page.locator('#island-trigger').click();
  assert.equal(await page.locator('#island-trigger').getAttribute('aria-expanded'), 'true');
  await page.locator('.island-history').click();
  await page.locator('.history-item').first().waitFor();
  await audit('history');
  await page.keyboard.press('Escape');
  assert(await page.locator('.island-history').evaluate((e) => e === document.activeElement));
  await page.keyboard.press('Escape');
  await page.locator('.game-dock [data-open="game-settings-dialog"]').click();
  await audit('settings-dark');
  await page.locator('#pref-theme').check();
  await page.locator('[data-language="en"]').click();
  await page.locator('[data-background="aurora"]').click();
  await page.locator('[data-table-color="green"]').click();
  assert.equal(await page.locator('html').getAttribute('lang'), 'en');
  await audit('settings-light-en');
  await page.keyboard.press('Escape');
  for (const name of ['lobby', 'plinko', 'dice', 'slots', 'blackjack']) {
    await game(name);
    await audit(name + '-light-en');
  }
  for (const width of [1440, 1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const name of ['lobby', 'plinko', 'dice', 'slots', 'blackjack']) {
      await game(name);
      assert(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        name + ' at ' + width,
      );
    }
  }
  pass('All five views in English/light mode at 320–1440px without horizontal overflow');
  await game('plinko');
  await audit('plinko-320');
  const playBox = await page.locator('#play-button').boundingBox();
  assert(playBox.y < 500, 'Mobile Plinko action must be above the board');

  // Same preferences carry into the portfolio; its original project demos remain usable.
  await page.goto(base + '/bio.html');
  await ready();
  assert.equal(await page.locator('html').getAttribute('lang'), 'en');
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
  assert.equal(await page.locator('[data-mounted]').count(), 7);
  assert.equal(await page.locator('nav').count(), 1);
  await page.locator('.bio-island-trigger').click();
  assert.equal(await page.locator('.bio-island-trigger').getAttribute('aria-expanded'), 'true');
  await page.keyboard.press('Escape');
  await page.locator('.rail-action[data-dialog="settings-dialog"]').click();
  await page.locator('[data-language="ru"]').click();
  await page.locator('#theme-switch').uncheck();
  await page.keyboard.press('Escape');
  for (const name of ['home', 'projects', 'lab', 'store', 'partners']) {
    await page.locator(`.rail-link[data-view="${name}"]`).click();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  }
  await page.locator('.rail-link[data-view="lab"]').click();
  await page.locator('[data-agent="xgo"]').click();
  assert.equal(await page.locator('#lab-chat .chat-keyboard [data-chat-action]').count(), 7);
  pass('Bio keeps seven previews, one dock, RU/EN sync and its expanding island');

  await page.goto(base + '/games.html#plinko');
  await ready();
  await page.waitForFunction(() => /\d/.test(document.querySelector('#island-value').textContent));
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.waitForFunction(() => document.documentElement.dataset.motion === 'on');
  await page.locator('#play-button').click();
  await page.waitForFunction(() => !document.querySelector('#round-queue').hidden);
  assert(await page.locator('[data-rows="16"]').isDisabled());
  await page.waitForFunction(() => document.querySelector('#play-button').dataset.busy === 'false');
  await page.locator('#play-button').click();
  await page.waitForFunction(() => document.querySelector('#play-button').dataset.busy === 'false');
  await page.setViewportSize({ width: 620, height: 850 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForFunction(() => document.querySelector('#round-queue').hidden);
  const latest = await session();
  assert.equal(
    latest.wallet.balanceMinor,
    Math.round(
      Number(
        (await page.locator('#island-value').textContent())
          .replace(/\s|\u00a0|\u202f/g, '')
          .replace(',', '.'),
      ) * 100,
    ),
  );
  pass('Plinko in flight: locked parameters, concurrent rounds, resize and reduced-motion settlement');
  assert.deepEqual(errors, []);
  await writeFile(`${artifacts}/result.json`, JSON.stringify({ steps, audits, errors }, null, 2));
  assert(
    audits.every((entry) => entry.violations.length === 0),
    'See audits.json for accessibility findings',
  );
  console.log('ALL BROWSER CHECKS PASSED');
} catch (error) {
  await writeFile(
    `${artifacts}/result.json`,
    JSON.stringify({ steps, audits, errors, failure: error.stack }, null, 2),
  );
  await page.screenshot({ path: `${artifacts}/failure.png`, fullPage: true }).catch(() => {});
  throw error;
} finally {
  await browser.close();
}
