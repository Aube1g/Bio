import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

const base = process.env.BASE_URL || 'http://127.0.0.1:8000';
const output = process.env.ARTIFACT_DIR || 'test-results/glass-ui';
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
const page = await context.newPage(),
  errors = [],
  audits = [],
  steps = [];
page.on('pageerror', (error) => errors.push(error.stack));
const pass = (message) => {
  steps.push(message);
  console.log('PASS', message);
};
const close = async (id) => {
  await page.keyboard.press('Escape');
  await page.waitForFunction((id) => !document.getElementById(id).open, id);
};
const rest = async (id) =>
  page.waitForFunction((id) => {
    const element = document.getElementById(id);
    return (
      element.open && !element.classList.contains('morphing') && !element.classList.contains('is-morphing')
    );
  }, id);
async function audit(name) {
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  audits.push({
    name,
    violations: result.violations.map((v) => ({
      id: v.id,
      nodes: v.nodes.map((n) => ({ target: n.target, message: n.failureSummary })),
    })),
  });
  await writeFile(`${output}/audits.json`, JSON.stringify(audits, null, 2));
  console.log('AUDIT', name, result.violations.length);
}
async function picker(mode, apply = true) {
  await page.locator('[data-motion-picker]').click();
  await rest('motion-picker-dialog');
  await page.locator(`[data-motion-style="${mode}"]`).click();
  if (apply) {
    await page.locator('#motion-apply').click();
    await page.waitForFunction(() => !document.querySelector('#motion-picker-dialog').open);
  }
}
try {
  await page.goto(base + '/games.html');
  await page.waitForFunction(() => document.documentElement.dataset.ready === 'true');
  assert.equal(await page.locator('.island-coin .viola-icon').count(), 1);
  assert(await page.locator('.island-coin img').evaluate((img) => img.complete && img.naturalWidth > 0));
  await page.locator('.game-dock [data-open="game-settings-dialog"]').click();
  await rest('game-settings-dialog');
  const input = page.locator('#pref-ripple');
  await input.uncheck();
  await page.waitForFunction(
    () =>
      Math.abs(
        Number(
          document.querySelector('#pref-ripple').parentElement.style.getPropertyValue('--switch-position'),
        ),
      ) < 0.001,
  );
  const appearance = await input.evaluate((input) => {
    const host = input.parentElement,
      lens = host.querySelector('.glass-switch-lens'),
      style = getComputedStyle(lens);
    return {
      width: lens.offsetWidth,
      height: lens.offsetHeight,
      filter: style.backdropFilter,
      background: style.backgroundColor,
      targetHeight: host.clientHeight,
    };
  });
  assert.equal(appearance.width, 38);
  assert.equal(appearance.height, 36);
  assert(appearance.targetHeight >= 44);
  assert.notEqual(appearance.background, 'rgb(255, 255, 255)');
  assert.notEqual(appearance.filter, 'none');
  await page.evaluate(() => {
    window.switchChanges = 0;
    document.querySelector('#pref-ripple').addEventListener('change', () => window.switchChanges++);
  });
  let box = await input.boundingBox();
  await page.mouse.move(box.x + 13, box.y + box.height / 2);
  await page.mouse.down();
  assert.equal(await input.evaluate((e) => e.parentElement.dataset.touching), 'true');
  await page.mouse.move(box.x + 60, box.y + box.height / 2, { steps: 12 });
  await page.mouse.up();
  assert(await input.isChecked());
  assert.equal(await page.evaluate(() => window.switchChanges), 1);
  await page.waitForFunction(
    () =>
      Math.abs(
        Number(
          document.querySelector('#pref-ripple').parentElement.style.getPropertyValue('--switch-position'),
        ) - 1,
      ) < 0.001,
  );
  box = await input.boundingBox();
  await page.mouse.move(box.x + 59, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 11, box.y + box.height / 2, { steps: 12 });
  await page.mouse.up();
  assert(!(await input.isChecked()));
  assert.equal(await page.evaluate(() => window.switchChanges), 2);
  await input.focus();
  await page.keyboard.press('Space');
  assert(await input.isChecked());
  pass(
    'Glass lens is transparent/refractive, draggable in both directions, keyboard-accessible, and changes once',
  );

  const previous = await page.locator('#transition-style').inputValue();
  await picker('iris', false);
  await page.waitForFunction(() => !document.querySelector('.motion-preview-stage').dataset.playing);
  await close('motion-picker-dialog');
  assert.equal(await page.locator('#transition-style').inputValue(), previous);
  await picker('caelestia');
  assert.equal(await page.locator('#transition-style').inputValue(), 'caelestia');
  await picker('hyprland', false);
  const radio = page.locator('[data-motion-style="hyprland"]');
  await radio.focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('[data-motion-style="caelestia"]').getAttribute('aria-checked'), 'true');
  await page.locator('#motion-apply').click();
  await page.waitForFunction(() => !document.querySelector('#motion-picker-dialog').open);
  await close('game-settings-dialog');
  await page.reload();
  await page.locator('.game-dock [data-open="game-settings-dialog"]').click();
  await rest('game-settings-dialog');
  assert.equal(await page.locator('#transition-style').inputValue(), 'caelestia');
  pass('Motion gallery previews, cancels, applies, supports radio-key navigation and persists its selection');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await picker('mix', false);
  assert(await page.locator('#motion-preview-replay').isDisabled());
  assert.equal(await page.locator('[data-motion-style]').count(), 7);
  assert.equal(await page.locator('[data-motion-style="star"]').count(), 0);
  await audit('motion-gallery-dark');
  await close('motion-picker-dialog');
  await close('game-settings-dialog');
  await page.locator('#account-button').click();
  await page.locator('#guest-login').click();
  await page.waitForFunction(() => !document.querySelector('#auth-dialog').open);
  await page.locator('#account-button').click();
  assert.equal(await page.locator('#account-stats .profile-stat').count(), 4);
  assert.equal(await page.locator('#profile-games button').count(), 4);
  assert.equal(await page.locator('#account-dialog .viola-icon').count(), 2);
  await audit('player-profile-dark');
  await page.screenshot({ path: `${output}/profile-desktop.png` });
  await page.locator('#account-dialog [data-open="wallet-dialog"]').click();
  await audit('wallet-dark');
  await close('wallet-dialog');
  await page.locator('[data-profile-game="dice"]').click();
  await page.waitForFunction(
    () => document.documentElement.dataset.game === 'dice' && !document.querySelector('#account-dialog').open,
  );
  await page.locator('#rules-button').click();
  assert.equal(await page.locator('#rules-dialog .rule-facts .info-card').count(), 3);
  await audit('rules-dark');
  await close('rules-dialog');
  pass('Profile, account image, nested wallet, quick-game launch and structured rules are functional');

  await page.locator('.game-dock [data-open="game-settings-dialog"]').click();
  await page.locator('#pref-theme').check();
  await page.locator('[data-language="en"]').click();
  await audit('glass-settings-light');
  await picker('liquid', false);
  await audit('motion-gallery-light');
  await close('motion-picker-dialog');
  await close('game-settings-dialog');
  await page.locator('#account-button').click();
  await audit('player-profile-light');
  await page.setViewportSize({ width: 320, height: 850 });
  assert(await page.locator('#account-dialog').evaluate((e) => e.scrollWidth <= e.clientWidth));
  await audit('player-profile-320');
  await close('account-dialog');
  await page.locator('.game-dock [data-open="game-settings-dialog"]').click();
  await page.locator('[data-motion-picker]').click();
  assert(await page.locator('#motion-picker-dialog').evaluate((e) => e.scrollWidth <= e.clientWidth));
  await audit('motion-gallery-320');
  await close('motion-picker-dialog');
  await close('game-settings-dialog');
  pass('New panels stay within 320px and support the light theme and English');

  await page.goto(base + '/bio.html');
  await page.waitForFunction(() => document.documentElement.dataset.ready === 'true');
  await page.locator('.bio-profile-open').click();
  assert.match(await page.locator('#bio-profile-title').textContent(), /Aubeig/);
  await audit('bio-profile-320');
  assert(await page.locator('#bio-profile-dialog').evaluate((e) => e.scrollWidth <= e.clientWidth));
  await page.locator('[data-profile-view="projects"]').click();
  await page.waitForFunction(
    () => !document.querySelector('#bio-profile-dialog').open && !document.querySelector('#projects').hidden,
  );
  await page.locator('#projects [data-project="anon"]').click();
  assert.equal(await page.locator('#detail-content .info-grid li').count(), 4);
  await audit('bio-project-cards-320');
  await close('detail-dialog');
  await page.locator('.rail-action[data-dialog="settings-dialog"]').click();
  await page.locator('[data-motion-picker]').click();
  await audit('bio-motion-320');
  await close('motion-picker-dialog');
  await close('settings-dialog');
  const missing = await page.evaluate(() =>
    [...document.querySelectorAll('use[href]')]
      .map((e) => e.getAttribute('href'))
      .filter((h) => h.startsWith('#') && !document.getElementById(h.slice(1))),
  );
  assert.deepEqual(missing, []);
  assert.deepEqual(errors, []);
  pass('Bio profile and project cards work with the same gallery and glass controls');
  await writeFile(`${output}/result.json`, JSON.stringify({ steps, audits, errors }, null, 2));
  assert(
    audits.every((a) => a.violations.length === 0),
    'See audits.json',
  );
} catch (error) {
  await writeFile(`${output}/failure.txt`, error.stack);
  await page.screenshot({ path: `${output}/failure.png`, fullPage: true }).catch(() => {});
  throw error;
} finally {
  await browser.close();
}
