export function finishBoot() {
  const root = document.documentElement;
  const loader = document.getElementById('app-preloader');
  if (!loader) return;
  if (!root.dataset.booting) {
    loader.hidden = true;
    return;
  }

  const started = performance.now();
  const motionAllowed = () =>
    root.dataset.motion !== 'off' && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const english = root.lang === 'en';
  loader.setAttribute('aria-label', english ? 'Loading' : 'Загрузка');
  document.getElementById('loader-label').textContent = english
    ? 'BUILDING YOUR SPACE…'
    : 'СОБИРАЮ ПРОСТРАНСТВО…';

  let deadline = 0;
  let progressFrame = 0;
  let finished = false;
  const progress = document.getElementById('preloader-progress');
  const progressBar = progress?.parentElement;
  if (progressBar) progressBar.setAttribute('aria-valuenow', '0');

  const paintProgress = (now) => {
    if (finished) return;
    const ratio = Math.min(0.9, (now - started) / 1500);
    if (progress) progress.style.transform = `scaleX(${ratio})`;
    if (progressBar) progressBar.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
    progressFrame = requestAnimationFrame(paintProgress);
  };
  progressFrame = requestAnimationFrame(paintProgress);

  const complete = () => {
    if (finished) return;
    finished = true;
    clearTimeout(deadline);
    cancelAnimationFrame(progressFrame);
    if (progress) progress.style.transform = 'scaleX(1)';
    if (progressBar) progressBar.setAttribute('aria-valuenow', '100');
    const announce = Boolean(root.dataset.booting);
    loader.hidden = true;
    delete root.dataset.booting;
    if (announce) window.dispatchEvent(new Event('apprevealed'));
  };

  const reveal = () => {
    if (finished) return;
    if (!motionAllowed() || document.hidden || !loader.animate) {
      complete();
      return;
    }
    const islandMark = document.querySelector('#bio-island .island-trigger-mark');
    const mark = loader.querySelector('.preloader-mark');
    let deltaX = 0;
    let deltaY = 0;
    let scale = 0.38;
    if (islandMark && mark) {
      const target = islandMark.getBoundingClientRect();
      const source = mark.getBoundingClientRect();
      deltaX = target.left + target.width / 2 - (source.left + source.width / 2);
      deltaY = target.top + target.height / 2 - (source.top + source.height / 2);
      scale = Math.max(0.18, Math.min(0.4, target.width / Math.max(1, source.width)));
    }
    const clipCenter = `${Math.round(window.innerWidth / 2)}px ${Math.round(window.innerHeight / 2)}px`;
    const targetCenter = islandMark
      ? `${Math.round(islandMark.getBoundingClientRect().left + islandMark.getBoundingClientRect().width / 2)}px ${Math.round(islandMark.getBoundingClientRect().top + islandMark.getBoundingClientRect().height / 2)}px`
      : clipCenter;
    const animation = loader.animate(
      [
        { clipPath: `circle(150vmax at ${clipCenter})`, opacity: 1, offset: 0 },
        { clipPath: `circle(105vmax at ${clipCenter})`, opacity: 1, offset: 0.28 },
        { clipPath: `circle(46vmax at ${targetCenter})`, opacity: 1, offset: 0.75 },
        { clipPath: `circle(0 at ${targetCenter})`, opacity: 0.96, offset: 1 },
      ],
      { duration: 960, easing: 'cubic-bezier(.7,0,.16,1)', fill: 'forwards' },
    );
    if (mark) {
      mark.animate(
        [
          { transform: 'translate3d(0,0,0) scale(1) rotate(0)', opacity: 1 },
          {
            transform: `translate3d(${deltaX * 0.44}px,${deltaY * 0.44}px,0) scale(${Math.sqrt(scale)}) rotate(16deg)`,
            opacity: 1,
            offset: 0.58,
          },
          { transform: `translate3d(${deltaX}px,${deltaY}px,0) scale(${scale}) rotate(0)`, opacity: 0.2 },
        ],
        { duration: 900, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'forwards' },
      );
    }
    animation.finished.then(complete).catch(complete);
  };

  deadline = setTimeout(reveal, 2800);
  Promise.race([
    document.fonts?.ready || Promise.resolve(),
    new Promise((resolve) => setTimeout(resolve, 1500)),
  ]).then(() => {
    setTimeout(reveal, Math.max(0, 760 - (performance.now() - started)));
  });
  document.addEventListener(
    'visibilitychange',
    () => {
      if (document.hidden) complete();
    },
    { once: true },
  );
}
