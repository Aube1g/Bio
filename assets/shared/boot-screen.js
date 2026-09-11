export function finishBoot() {
  const root = document.documentElement,
    loader = document.getElementById('app-preloader');
  if (!loader) return;
  if (!root.dataset.booting) {
    loader.hidden = true;
    return;
  }
  const started = performance.now();
  const enabled = () => root.dataset.motion !== 'off';
  const english = root.lang === 'en';
  loader.setAttribute('aria-label', english ? 'Loading' : 'Загрузка');
  document.getElementById('loader-label').textContent = english ? 'LOADING…' : 'ЗАГРУЗКА…';
  let timer = 0,
    finished = false;
  const tick = () => {
    const date = new Date(),
      seconds = date.getSeconds() + date.getMilliseconds() / 1000,
      minutes = date.getMinutes() + seconds / 60;
    document.getElementById('loader-hour').style.transform =
      `rotate(${(date.getHours() % 12) * 30 + minutes / 2}deg)`;
    document.getElementById('loader-minute').style.transform = `rotate(${minutes * 6}deg)`;
    document.getElementById('loader-second').style.transform = `rotate(${seconds * 6}deg)`;
  };
  tick();
  if (enabled()) timer = setInterval(tick, 80);
  const finish = () => {
    if (finished) return;
    finished = true;
    clearInterval(timer);
    clearTimeout(deadline);
    const complete = () => {
      const announce = Boolean(root.dataset.booting);
      loader.hidden = true;
      delete root.dataset.booting;
      if (announce) window.dispatchEvent(new Event('apprevealed'));
    };
    if (!enabled() || document.hidden) {
      complete();
      return;
    }
    const animation = loader.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300, easing: 'ease-out' });
    animation.finished.then(complete).catch(complete);
  };
  const deadline = setTimeout(finish, 2200);
  // Fonts are embedded. A lost API request must never keep the loader above the games.
  Promise.race([
    document.fonts?.ready || Promise.resolve(),
    new Promise((resolve) => setTimeout(resolve, 1600)),
  ]).then(() => {
    setTimeout(finish, enabled() ? Math.max(0, 620 - (performance.now() - started)) : 0);
  });
}
