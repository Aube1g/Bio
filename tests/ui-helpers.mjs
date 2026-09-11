export async function enterGame(page, name) {
  await page.locator(`.game-dock [data-go="${name}"]`).click();
  if (name !== 'lobby') {
    const active = await page.locator('html').getAttribute('data-game');
    if (active !== name) {
      await page.locator('#lobby-launch').waitFor({ state: 'visible' });
      await page.locator('#launch-selected').click();
    }
  }
  await page.waitForFunction((name) => document.documentElement.dataset.game === name, name);
}
