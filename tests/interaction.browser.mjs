import { enterGame } from './ui-helpers.mjs';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

const base = process.env.BASE_URL || 'http://127.0.0.1:8000';
const output = process.env.ARTIFACT_DIR || 'test-results/interactions';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
  args: JSON.parse(process.env.CHROMIUM_ARGS || '[]'),
  headless: true,
});
const checks = [],
  errors = [];
const context = () => browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
const watch = (page) => page.on('pageerror', (error) => errors.push(error.stack));
const pass = (text) => {
  checks.push(text);
  console.log('PASS', text);
};

try {
  // Delay only transport; authentication and all game results come from the real backend.
  const first = await context(),
    page = await first.newPage();
  watch(page);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route('**/api/config', async (route) => {
    await gate;
    await route.continue();
  });
  const anonymous = page.waitForResponse((response) => response.url().endsWith('/api/session'));
  await page.goto(base + '/games.html');
  assert.equal((await (await anonymous).json()).user, null);
  await page.locator('#account-button').click();
  await page.locator('#guest-login').click();
  await page.waitForFunction(() => !document.querySelector('#auth-dialog').open);
  const loaded = page.waitForResponse((response) => response.url().endsWith('/api/config'));
  release();
  await loaded;
  await page.waitForTimeout(120);
  assert.match(await page.locator('#account-label').textContent(), /Гость|Guest/);
  assert.equal((await page.evaluate(() => fetch('/api/session').then((r) => r.json()))).user.kind, 'guest');
  pass('A late anonymous bootstrap cannot overwrite a successful guest login');
  await enterGame(page, 'dice');
  let saved;
  await page.route('**/api/games/dice', async (route) => {
    const response = await route.fetch();
    saved = (await response.json()).round;
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'service_unavailable', message: 'Unavailable' } }),
    });
  });
  await page.locator('#play-button').click();
  await page.locator('#connection-banner').waitFor({ state: 'visible' });
  await page.unroute('**/api/games/dice');
  const refresh = page.waitForResponse((response) => response.url().endsWith('/api/session'));
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await refresh;
  await page.waitForTimeout(80);
  assert(await page.locator('#play-button').isDisabled());
  await page.locator('#retry-connection').click();
  await page.waitForFunction(() => document.querySelector('#connection-banner').hidden);
  assert.equal(Number(await page.locator('#dice-cube').getAttribute('data-value')), saved.outcome.face);
  assert(!(await page.locator('#result-proof').isHidden()));
  pass('Uncertain bets stay locked across refresh and recover the paid result without another wager');

  const blocked = await context(),
    parent = await blocked.newPage();
  watch(parent);
  await parent.route('**/api/**', async (route) => {
    const response = await route.fetch({ headers: { ...(await route.request().allHeaders()), cookie: '' } });
    const headers = { ...response.headers() };
    delete headers['set-cookie'];
    await blocked.clearCookies();
    await route.fulfill({ response, headers });
  });
  await parent.route('**/frame-test', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<iframe title="Portal" src="${base}/games.html" style="width:100vw;height:100vh;border:0"></iframe>`,
    }),
  );
  await parent.goto(base + '/frame-test');
  const frame = parent.frames().find((frame) => frame.url().includes('/games.html'));
  await frame.waitForFunction(() => document.documentElement.dataset.ready === 'true');
  await frame.locator('#account-button').click();
  await frame.locator('#guest-login').click();
  await frame.waitForFunction(() => !document.querySelector('#auth-dialog').open);
  assert.match(
    await frame.evaluate(() => sessionStorage.getItem('aubeig.preview.session')),
    /^[a-f0-9]{64}$/,
  );
  assert.equal((await blocked.cookies()).length, 0);
  await enterGame(frame, 'plinko');
  const paid = parent.waitForResponse(
    (response) => response.url().endsWith('/api/games/plinko') && response.status() === 200,
  );
  await frame.locator('#play-button').click();
  const round = (await (await paid).json()).round;
  await frame.waitForFunction(() => !document.querySelector('#result-proof').hidden);
  assert.equal(Number(await frame.locator('#plinko-bins').getAttribute('data-landed')), round.outcome.slot);
  await frame.evaluate(() => location.reload());
  await frame.waitForFunction(() =>
    /Гость|Guest/.test(document.querySelector('#account-label')?.textContent || ''),
  );
  assert.equal((await blocked.cookies()).length, 0);
  pass('Embedded guest plays and survives reload with all cookies stripped; tab token + CSRF are used');

  const uiContext = await context(),
    ui = await uiContext.newPage();
  watch(ui);
  await ui.goto(base + '/bio.html');
  await ui.waitForFunction(() => document.documentElement.dataset.ready === 'true');
  await ui.locator('.bio-island-trigger').click();
  assert.equal(await ui.locator('.bio-island-trigger').getAttribute('aria-expanded'), 'true');
  await ui.screenshot({ path: `${output}/bio-island.png` });
  await ui.keyboard.press('Escape');
  await ui.locator('.rail-action[data-dialog="settings-dialog"]').click();
  for (const id of ['theme-switch', 'ripple-switch', 'liquid-switch', 'glass-switch']) {
    const input = ui.locator('#' + id);
    assert.equal(await input.getAttribute('role'), 'switch');
    await input.check();
    const geometry = await input.evaluate((input) => {
      const label = input.parentElement.getBoundingClientRect(),
        track = input.nextElementSibling;
      const thumb = getComputedStyle(input.parentElement.querySelector('.glass-switch-lens'));
      return {
        hitHeight: label.height,
        trackHeight: track.getBoundingClientRect().height,
        thumbWidth: parseFloat(thumb.width),
        x: new DOMMatrix(thumb.transform).m41,
        color: thumb.backgroundColor,
      };
    });
    assert(geometry.hitHeight >= 44);
    assert.equal(geometry.trackHeight, 24);
    assert.equal(geometry.thumbWidth, 46);
    assert.equal(geometry.x, 22);
    assert.notEqual(geometry.color, 'rgb(255, 255, 255)');
    await input.uncheck();
    assert.equal(
      await input.evaluate(
        (e) =>
          new DOMMatrix(getComputedStyle(e.parentElement.querySelector('.glass-switch-lens')).transform).m41,
      ),
      0,
    );
  }
  await ui.locator('#theme-switch').uncheck();
  await ui.screenshot({ path: `${output}/bio-settings.png` });
  await ui.keyboard.press('Escape');
  await ui.setViewportSize({ width: 390, height: 844 });
  await ui.evaluate(() => scrollTo(0, 400));
  const fixed = await ui.locator('.bio-island-trigger').boundingBox();
  assert(fixed.y >= 0 && fixed.y < 35);
  await ui.locator('.bio-island-trigger').click();
  const expanded = await ui.locator('#bio-island').boundingBox();
  assert(expanded.x >= 0 && expanded.x + expanded.width <= 390);
  await ui.screenshot({ path: `${output}/bio-island-mobile.png` });
  await ui.keyboard.press('Escape');
  pass('Liquid-glass switch geometry, keyboard state and fixed responsive Bio island');

  await ui.setViewportSize({ width: 1280, height: 900 });
  await ui.emulateMedia({ reducedMotion: 'no-preference' });
  for (const effect of ['hyprland', 'caelestia']) {
    await ui.locator('.rail-action[data-dialog="settings-dialog"]').click();
    await ui.waitForFunction(() => document.querySelector('#settings-dialog').dataset.morphPhase === 'rest');
    await ui.locator('[data-motion-picker]').click();
    await ui.waitForFunction(
      () => document.querySelector('#motion-picker-dialog').dataset.morphPhase === 'rest',
    );
    await ui.locator(`[data-motion-style="${effect}"]`).click();
    await ui.locator('#motion-apply').click();
    await ui.waitForFunction(() => !document.querySelector('#motion-picker-dialog').open);
    await ui.keyboard.press('Escape');
    await ui.waitForFunction(() => !document.querySelector('#settings-dialog').open);
    const trace = await ui.evaluate(
      (effect) =>
        new Promise((resolve) => {
          const target = effect === 'hyprland' ? 'projects' : 'home';
          const el = document.getElementById(target),
            frames = [];
          document.querySelector(`.rail-link[data-view="${target}"]`).click();
          const tick = () => {
            frames.push({
              effect: el.dataset.transitionEffect,
              path: el.style.clipPath,
              transform: el.style.transform,
            });
            if (!document.querySelector('.window-snapshot')) resolve(frames);
            else requestAnimationFrame(tick);
          };
          tick();
        }),
      effect,
    );
    assert(
      trace.some(
        (frame) => frame.effect === effect && frame.path.startsWith('path(') && frame.transform !== 'none',
      ),
    );
    assert.equal(await ui.locator('.window-snapshot').count(), 0);
    const source =
      effect === 'hyprland' ? '#projects [data-project="anon"]' : '.signal-node[data-project="xli"]';
    await ui.locator(source).click();
    await ui.keyboard.press('Escape');
    await ui.waitForFunction(() => !document.querySelector('#detail-dialog').open);
    assert.equal(await ui.locator('.morph-card-copy').count(), 0);
  }
  await ui.evaluate(() => {
    const t = document.querySelector('.bio-island-trigger');
    t.click();
    setTimeout(() => t.click(), 60);
    setTimeout(() => t.click(), 120);
  });
  await ui.waitForFunction(
    () =>
      document.querySelector('#bio-island').dataset.open === 'true' &&
      !document.querySelector('#bio-island').dataset.resizing,
  );
  assert(!(await ui.locator('#bio-island-panel').evaluate((e) => e.hidden || e.inert)));
  await ui.keyboard.press('Escape');
  await ui.waitForFunction(() => document.querySelector('#bio-island-panel').hidden);
  pass('Both compositor profiles morph locally; early close and island reversals leave no stuck layers');
  assert.deepEqual(errors, []);
  await writeFile(`${output}/result.json`, JSON.stringify({ checks, errors }, null, 2));
} finally {
  await browser.close();
}
