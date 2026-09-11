(() => {
  const root = document.documentElement;
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
    root.dataset.motion =
      matchMedia('(prefers-reduced-motion: reduce)').matches || localStorage.getItem('bio.motion') === 'off'
        ? 'off'
        : 'on';
  } catch {
    root.dataset.theme = 'dark';
  }
})();
