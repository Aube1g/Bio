import { enterGame } from './ui-helpers.mjs';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const base = process.env.BASE_URL || 'http://127.0.0.1:8000';
const entry = process.env.GAME_HTML || 'games.html';
const artifacts = process.env.ARTIFACT_DIR || 'test-results/offline-play';
await mkdir(artifacts, { recursive: true });
const launch = () =>
  chromium.launch({
    executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
    args: JSON.parse(process.env.CHROMIUM_ARGS || '[]'),
    headless: true,
  });
const checks = [];
const pass = (message) => {
  checks.push(message);
  console.log('PASS', message);
};

{
  const browser = await launch();
  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      reducedMotion: 'reduce',
      offline: true,
    });
    const page = await context.newPage(),
      errors = [],
      requests = [];
    page.on('pageerror', (error) => errors.push(error.stack));
    page.on('request', (request) => {
      if (request.url().includes('/api/')) requests.push(request.url());
    });
    await page.goto(pathToFileURL(resolve(entry)).href);
    await page.waitForFunction(
      () => document.documentElement.dataset.ready === 'true' && !document.documentElement.dataset.booting,
    );
    await page.locator('#practice-launch').click();
    assert.equal(await page.locator('html').getAttribute('data-play-mode'), 'local');
    const snapshot = () => page.evaluate(() => JSON.parse(sessionStorage.getItem('aubeig.practice.session')));
    for (const game of ['dice', 'slots', 'plinko']) {
      await enterGame(page, game);
      const before = (await snapshot()).balance;
      await page.locator('#play-button').click();
      await page.waitForFunction(() => !document.querySelector('#result-proof').hidden);
      const after = await snapshot(),
        round = after.rounds[0];
      assert.equal(round.game, game);
      assert.equal(after.balance, before - round.betMinor + round.payoutMinor);
      await page.locator('#result-proof').click();
      await page.locator('#verify-round').click();
      await page.waitForFunction(() =>
        /совпадают|match/.test(document.querySelector('#verify-status').textContent),
      );
      await page.keyboard.press('Escape');
    }
    await enterGame(page, 'blackjack');
    let hand;
    for (let i = 0; i < 15; i++) {
      await page.locator('#play-button').click();
      await page.waitForFunction(() => document.querySelector('#play-button').dataset.busy === 'false');
      hand = (await snapshot()).rounds.find((round) => round.game === 'blackjack');
      if (hand.status === 'active') break;
    }
    assert.equal(hand.status, 'active');
    const balance = (await snapshot()).balance;
    await page.reload();
    await page.waitForFunction(
      () =>
        !document.documentElement.dataset.booting &&
        document.querySelectorAll('#player-hand .playing-card:not(.card-back)').length === 2,
    );
    assert.equal((await snapshot()).balance, balance);
    assert.equal(await page.locator('#dealer-hand .card-back').count(), 1);
    await page.locator('[data-bj-action="double"]').click();
    await page.locator('#result-proof').waitFor({ state: 'visible' });
    const final = (await snapshot()).rounds.find((round) => round.id === hand.id);
    assert.equal(final.status, 'settled');
    assert.equal(final.betMinor, hand.betMinor * 2);
    await page.locator('#result-proof').click();
    await page.locator('#verify-round').click();
    await page.waitForFunction(() =>
      /совпадают|match/.test(document.querySelector('#verify-status').textContent),
    );
    await page.keyboard.press('Escape');
    await enterGame(page, 'plinko');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `${artifacts}/file-play-mobile.png`, fullPage: true });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.deepEqual(requests, []);
    assert.deepEqual(errors, []);
    pass(
      `Downloaded ${entry}, offline: all four games, balances, proofs and Blackjack reload/double with zero API requests`,
    );
  } finally {
    await browser.close();
  }
}
{
  const browser = await launch();
  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      reducedMotion: 'reduce',
    });
    const page = await context.newPage(),
      errors = [],
      requests = [];
    page.on('pageerror', (error) => errors.push(error.stack));
    page.on('request', (request) => {
      if (request.url().includes('/api/')) requests.push(request.url());
    });
    await page.setContent(
      '<iframe title="Downloaded portal" sandbox="allow-scripts allow-forms allow-modals" style="width:100vw;height:100vh;border:0"></iframe>',
    );
    const source = await readFile(entry, 'utf8');
    await page.locator('iframe').evaluate((iframe, source) => {
      iframe.srcdoc = source;
    }, source);
    const frame = page.frames().find((frame) => frame !== page.mainFrame());
    await frame.waitForFunction(
      () => document.documentElement.dataset.ready === 'true' && !document.documentElement.dataset.booting,
    );
    assert.equal(await frame.evaluate(() => location.origin), 'null');
    await enterGame(frame, 'dice');
    await frame.locator('#play-button').click();
    await frame.waitForFunction(() => !document.querySelector('#result-proof').hidden);
    assert.match(await frame.locator('#dice-value').textContent(), /^[1-6]$/);
    for (const game of ['slots', 'plinko']) {
      await enterGame(frame, game);
      await frame.locator('#play-button').click();
      await frame.waitForFunction(() => !document.querySelector('#result-proof').hidden);
    }
    assert.deepEqual(requests, []);
    assert.deepEqual(errors, []);
    pass('Opaque sandbox/srcdoc viewer: test games work with no origin, no sessionStorage and no API');
  } finally {
    await browser.close();
  }
}
{
  const browser = await launch();
  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      reducedMotion: 'reduce',
    });
    const page = await context.newPage(),
      errors = [];
    let apiRequests = 0;
    page.on('pageerror', (error) => errors.push(error.stack));
    await page.route('**/api/**', (route) => {
      apiRequests++;
      return route.abort();
    });
    await page.goto(base + '/' + encodeURIComponent(entry));
    await page.waitForFunction(
      () => document.documentElement.dataset.ready === 'true' && !document.documentElement.dataset.booting,
    );
    await page.locator('#practice-launch').click();
    await enterGame(page, 'plinko');
    const requestsBeforePlay = apiRequests;
    await page.locator('#play-button').click();
    await page.waitForFunction(() => !document.querySelector('#result-proof').hidden);
    assert.equal(apiRequests, requestsBeforePlay);
    assert(await page.locator('#connection-banner').isHidden());
    await page.reload();
    await page.waitForFunction(() =>
      /Гость|Guest/.test(document.querySelector('#account-label')?.textContent || ''),
    );
    assert.equal(await page.locator('html').getAttribute('data-play-mode'), 'local');
    assert(await page.locator('#connection-banner').isHidden());
    assert.deepEqual(errors, []);
    pass('HTTP page with every API request blocked: explicit test mode stays playable and survives reload');
  } finally {
    await browser.close();
  }
}
await writeFile(`${artifacts}/result.json`, JSON.stringify(checks, null, 2));
