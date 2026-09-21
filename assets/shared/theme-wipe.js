import { motionEnabled } from './preferences.js';

/* Iris-in wipe when the theme flips: a circle of the new background grows
   from the tap point. Pure WAAPI, removed right after it finishes. */
export function initThemeWipe() {
  const root = document.documentElement;
  let theme = root.dataset.theme;
  let point = { x: innerWidth / 2, y: 64 };
  document.addEventListener(
    'pointerdown',
    (event) => {
      point = { x: event.clientX, y: event.clientY };
    },
    { capture: true, passive: true },
  );
  new MutationObserver(() => {
    if (root.dataset.theme === theme) return;
    theme = root.dataset.theme;
    if (!motionEnabled() || !document.body) return;
    const wipe = document.createElement('div');
    wipe.className = 'theme-wipe';
    wipe.setAttribute('aria-hidden', 'true');
    let background = getComputedStyle(document.body).backgroundColor;
    if (!background || background === 'rgba(0, 0, 0, 0)' || background === 'transparent') {
      background = getComputedStyle(root).getPropertyValue('--bg').trim() || '#080813';
    }
    wipe.style.background = background;
    document.body.append(wipe);
    point = {
      x: Math.min(Math.max(point.x, 0), innerWidth),
      y: Math.min(Math.max(point.y, 0), innerHeight),
    };
    const radius =
      Math.hypot(Math.max(point.x, innerWidth - point.x), Math.max(point.y, innerHeight - point.y)) +
      60;
    const animation = wipe.animate(
      [
        { clipPath: `circle(0px at ${point.x}px ${point.y}px)` },
        { clipPath: `circle(${radius}px at ${point.x}px ${point.y}px)` },
      ],
      { duration: 680, easing: 'cubic-bezier(.3,1,.25,1)' },
    );
    animation.finished
      .catch(() => {})
      .then(() => wipe.remove());
  }).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
}
