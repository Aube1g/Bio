const animations = new Set();
const active = new WeakMap();
const canMove = () => document.documentElement.dataset.motion !== 'off';

export function initializeTextMotion() {
  const targets =
    'h1,h2,.hero-tagline,.lobby-hero-copy>p,.game-heading-copy>p,.dialog-intro,.dialog-lead,.bio-profile-summary';
  function reveal(scope) {
    if (!canMove() || document.documentElement.dataset.booting || !scope?.isConnected) return;
    const nodes = [...scope.querySelectorAll(targets)].filter(
      (node) =>
        node.getClientRects().length &&
        !node.closest('[hidden],.window-snapshot,.surface-snapshot,.morph-card-copy,.motion-preview-stage'),
    );
    nodes.slice(0, 12).forEach((node, index) => {
      active.get(node)?.cancel();
      const title = /^H[12]$/.test(node.tagName);
      const animation = node.animate(
        [
          {
            opacity: 0,
            transform: `translateY(${title ? 15 : 9}px)`,
            filter: 'blur(4px)',
            clipPath: 'inset(0 0 100% 0)',
          },
          { opacity: 1, transform: 'none', filter: 'blur(0px)', clipPath: 'inset(0 0 0% 0)' },
        ],
        { duration: title ? 640 : 520, delay: Math.min(index, 5) * 45, easing: 'cubic-bezier(.16,1,.3,1)' },
      );
      node.dataset.textMotion = 'revealing';
      animations.add(animation);
      active.set(node, animation);
      animation.finished
        .catch(() => {})
        .then(() => {
          animations.delete(animation);
          if (active.get(node) === animation) {
            active.delete(node);
            delete node.dataset.textMotion;
          }
        });
    });
  }
  const roots = [...document.querySelectorAll('.view,.portal-view,dialog')];
  const states = new WeakMap();
  for (const scope of roots) {
    const inspect = () => {
      const visible = scope.tagName === 'DIALOG' ? scope.open : !scope.hidden;
      const busy =
        scope.classList.contains('morphing') ||
        scope.classList.contains('is-morphing') ||
        scope.classList.contains('is-window-entering') ||
        scope.classList.contains('surface-incoming');
      if (!visible || busy) {
        states.set(scope, false);
        return;
      }
      if (!states.get(scope)) {
        states.set(scope, true);
        requestAnimationFrame(() => reveal(scope));
      }
    };
    new MutationObserver(inspect).observe(scope, {
      attributes: true,
      attributeFilter: ['hidden', 'open', 'class'],
    });
  }
  const initial = () => {
    reveal(document.body);
    roots.forEach((scope) => states.set(scope, scope.tagName === 'DIALOG' ? scope.open : !scope.hidden));
  };
  window.addEventListener('apprevealed', initial, { once: true });
  window.addEventListener('preferenceschange', () => {
    if (!canMove()) for (const animation of animations) animation.cancel();
  });
  new MutationObserver(() => {
    if (!canMove()) for (const animation of animations) animation.cancel();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-motion'] });
  if (!document.documentElement.dataset.booting) requestAnimationFrame(initial);
}
