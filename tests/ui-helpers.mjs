export async function enterGame(page, name) {
  await page.locator(`.game-dock [data-go="${name}"]`).click();
  if (name !== 'lobby') await page.locator('#dock-launch-play').click();
  await page.waitForFunction((name) => document.documentElement.dataset.game === name, name);
}
