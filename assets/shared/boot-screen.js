export function finishBoot() {
  const root = document.documentElement,
    loader = document.getElementById('app-preloader');
  if (!loader) return;
  // Liquid clock: real time, continuously sweeping hands — no API dependency.
  let clockTimer = 0;
  const tickClock = () => {
    const hour = document.getElementById('clock-hour'),
      min = document.getElementById('clock-min'),
      sec = document.getElementById('clock-sec');
    if (!hour || !min || !sec) return;
    const now = new Date();
    const ms = now.getMilliseconds() / 1000;
    const seconds = now.getSeconds() + ms;
    const minutes = now.getMinutes() + seconds / 60;
    const hours = (now.getHours() % 12) + minutes / 60;
    hour.style.transform = `rotate(${hours * 30}deg)`;
    min.style.transform = `rotate(${minutes * 6}deg)`;
    sec.style.transform = `rotate(${seconds * 6}deg)`;
    clockTimer = requestAnimationFrame(tickClock);
  };
  clockTimer = requestAnimationFrame(tickClock);
  if (!root.dataset.booting) {
    loader.hidden = true;
    cancelAnimationFrame(clockTimer);
    return;
  }
  const started = performance.now();
  const enabled = () => root.dataset.motion !== 'off';
  const english = root.lang === 'en';
  loader.setAttribute('aria-label', english ? 'Loading' : 'Загрузка');
  document.getElementById('loader-label').textContent = english ? 'LOADING…' : 'ЗАГРУЗКА…';
  const progress = document.getElementById('loader-progress');
  let finished = false;
  const paint = (value) => {
    if (progress) progress.style.width = `${Math.min(100, Math.max(0, value))}%`;
  };
  // A quick, honest fill that eases out instead of a fake clock.
  const tick = () => {
    if (finished) return;
    const elapsed = performance.now() - started;
    const t = Math.min(1, elapsed / 1150);
    paint(4 + 88 * (1 - Math.pow(1 - t, 3)));
    if (t < 1) requestAnimationFrame(tick);
  };
  paint(0);
  if (enabled()) requestAnimationFrame(tick);
  else paint(92);
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(deadline);
    paint(100);
    const complete = () => {
      const announce = Boolean(root.dataset.booting);
      loader.hidden = true;
      cancelAnimationFrame(clockTimer);
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
  const deadline = setTimeout(finish, 2000);
  // Fonts are embedded. A lost API request must never keep the loader above the games.
  Promise.race([
    document.fonts?.ready || Promise.resolve(),
    new Promise((resolve) => setTimeout(resolve, 1600)),
  ]).then(() => {
    // Give the liquid clock a beat or two to sweep before the reveal.
    setTimeout(finish, enabled() ? Math.max(0, 1400 - (performance.now() - started)) : 0);
  });
}
