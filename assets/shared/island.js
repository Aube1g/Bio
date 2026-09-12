export class ExpandingIsland {
  constructor(element, trigger, panel) {
    this.element = element;
    this.trigger = trigger;
    this.panel = panel;
    this.finish = null;
    trigger.addEventListener('click', () => this.toggle(element.dataset.open !== 'true'));
    document.addEventListener('click', (event) => {
      if (!document.querySelector('dialog[open]') && !element.contains(event.target)) this.toggle(false);
    });
    document.addEventListener('keydown', (event) => {
      if (
        event.key === 'Escape' &&
        !document.querySelector('dialog[open]') &&
        element.dataset.open === 'true'
      ) {
        event.preventDefault();
        this.toggle(false);
        trigger.focus({ preventScroll: true });
      }
    });
    window.addEventListener('resize', () => this.finish?.());
    window.addEventListener('preferenceschange', () => {
      if (document.documentElement.dataset.motion === 'off') this.finish?.();
    });
  }
  toggle(open) {
    const { element, trigger, panel } = this;
    if (element.dataset.open === String(open)) return;
    const before = element.getBoundingClientRect();
    this.finish?.();
    element.dataset.open = String(open);
    trigger.setAttribute('aria-expanded', String(open));
    panel.hidden = !open;
    panel.inert = !open;
    const after = element.getBoundingClientRect();
    if (document.documentElement.dataset.motion === 'off') return;
    // Keep the closing content painted while removing it from focus and hit testing.
    panel.hidden = false;
    element.dataset.resizing = 'true';
    const animation = element.animate(
      [
        { width: `${before.width}px`, height: `${before.height}px` },
        { width: `${after.width}px`, height: `${after.height}px` },
      ],
      { duration: open ? 460 : 320, easing: 'cubic-bezier(.22,1.18,.36,1)', fill: 'both' },
    );
    const content = panel.animate(
      [
        { opacity: open ? 0 : 1, transform: open ? 'translateY(9px)' : 'none' },
        { opacity: open ? 1 : 0, transform: open ? 'none' : 'translateY(-6px)' },
      ],
      { duration: open ? 300 : 170, delay: open ? 75 : 0, fill: 'both', easing: 'cubic-bezier(.2,0,0,1)' },
    );
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      panel.hidden = !open;
      delete element.dataset.resizing;
      animation.cancel();
      content.cancel();
      if (this.finish === finish) this.finish = null;
    };
    this.finish = finish;
    animation.finished.then(finish).catch(() => {});
  }
}
