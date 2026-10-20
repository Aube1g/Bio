(() => {
  const root = document.documentElement;
  root.dataset.booting = 'true';
  setTimeout(() => {
    if (root.dataset.booting) {
      delete root.dataset.booting;
      window.dispatchEvent(new Event('apprevealed'));
    }
  }, 4500);
  try {
    const parsed = JSON.parse(localStorage.getItem('aubeig.preferences') || '{}');
    const saved = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    for (const [key, value] of Object.entries(saved))
      localStorage.setItem('bio.' + key, typeof value === 'boolean' ? (value ? 'on' : 'off') : String(value));
    root.dataset.theme =
      (saved.theme || localStorage.getItem('bio.theme') || localStorage.getItem('ab_theme')) === 'light'
        ? 'light'
        : 'dark';
    root.lang =
      (saved.lang || localStorage.getItem('bio.lang') || localStorage.getItem('ab_lang')) === 'en'
        ? 'en'
        : 'ru';
    const explicitMotion = localStorage.getItem('bio.motion') ?? localStorage.getItem('ab_motion');
    root.dataset.motion =
      explicitMotion != null
        ? ['off', 'false'].includes(explicitMotion)
          ? 'off'
          : 'on'
        : matchMedia('(prefers-reduced-motion: reduce)').matches
          ? 'off'
          : 'on';
  } catch {
    root.dataset.theme = 'dark';
  }
})();
