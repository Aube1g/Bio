import { transitionPath, transitionTransform } from './motion-recipes.js';
import { TRANSITION_STYLES, isDesktopMotion, desktopMask, desktopTransform } from './desktop-motion.js';
import { $, $$, clamp, lerp } from './dom.js';
import { motionEnabled, preferences } from './preferences.js';

const ease = (t) => 1 - (1 - t) ** 4;
const spring = (t) =>
  t >= 1 ? 1 : 1 - Math.exp(-7.5 * t) * (Math.cos(11.5 * t) + 0.65 * Math.sin(11.5 * t));
let sequence = 0;
export function roundedPath(x, y, width, height, radius = 25) {
  const w = Math.max(0.01, width),
    h = Math.max(0.01, height),
    r = Math.max(0, Math.min(radius, w / 2, h / 2));
  return `M${x + r} ${y}H${x + w - r}Q${x + w} ${y} ${x + w} ${y + r}V${y + h - r}Q${x + w} ${y + h} ${x + w - r} ${y + h}H${x + r}Q${x} ${y + h} ${x} ${y + h - r}V${y + r}Q${x} ${y} ${x + r} ${y}Z`;
}
function mask(effect, w, h, t, origin = {}) {
  return transitionPath(effect, w, h, t, origin);
}
const effectName = () =>
  preferences.transition && preferences.transition !== 'mix'
    ? preferences.transition
    : TRANSITION_STYLES[sequence++ % TRANSITION_STYLES.length];
let surface;
export function transitionSurface(stage, change, source) {
  surface?.finish();
  const current = $('.portal-view:not([hidden])', stage),
    before = current?.getBoundingClientRect();
  if (!motionEnabled() || !current || !before.width) {
    change();
    return;
  }
  const copy = current.cloneNode(true);
  $$('canvas', copy).forEach((canvas, i) => {
    const original = $$('canvas', current)[i];
    canvas.getContext('2d')?.drawImage(original, 0, 0);
  });
  [copy, ...$$('*', copy)].forEach((el) => {
    for (const attr of [...el.attributes])
      if (attr.name === 'id' || attr.name.startsWith('data-')) el.removeAttribute(attr.name);
  });
  copy.className = 'surface-snapshot';
  copy.inert = true;
  copy.setAttribute('aria-hidden', 'true');
  const stageBox = stage.getBoundingClientRect();
  const verticalFrame = stageBox.height - before.height;
  Object.assign(copy.style, {
    width: before.width + 'px',
    height: before.height + 'px',
    left: before.x - stageBox.x - stage.clientLeft + 'px',
    top: before.y - stageBox.y - stage.clientTop + 'px',
  });
  change();
  const incoming = $('.portal-view:not([hidden])', stage),
    after = incoming.getBoundingClientRect();
  stage.append(copy);
  stage.classList.add('surface-transition');
  stage.setAttribute('aria-busy', 'true');
  incoming.classList.add('surface-incoming');
  const rect = source?.getBoundingClientRect(),
    origin = {
      x: rect ? rect.x - after.x + rect.width / 2 : after.width / 2,
      y: Math.min(after.height / 2, 240),
      direction: Number(stage.dataset.direction) || 1,
      surfaceHeight: Math.min(
        after.height,
        Math.max(180, innerHeight - Math.max(0, after.top + scrollY) - 20),
      ),
    };
  const effect = effectName();
  incoming.dataset.effect = effect;
  let frame,
    done = false,
    elapsed = 0,
    last = performance.now();
  surface = {
    finish() {
      if (done) return;
      done = true;
      cancelAnimationFrame(frame);
      copy.remove();
      stage.classList.remove('surface-transition');
      stage.removeAttribute('aria-busy');
      stage.style.height = '';
      incoming.style.clipPath = '';
      incoming.style.transform = '';
      incoming.classList.remove('surface-incoming');
      surface = null;
    },
  };
  const record = surface;
  function tick(now) {
    elapsed += Math.min(100, Math.max(0, now - last));
    last = now;
    const t = motionEnabled() ? clamp(elapsed / (isDesktopMotion(effect) ? 440 : 580), 0, 1) : 1;
    stage.style.height = lerp(before.height, after.height, ease(t)) + verticalFrame + 'px';
    incoming.style.clipPath = `path("${mask(effect, after.width, after.height, t, origin)}")`;
    incoming.style.transform = transitionTransform(
      effect,
      after.width,
      t,
      Number(stage.dataset.direction) || 1,
    );
    incoming.style.transformOrigin = '50% 25%';
    if (t < 1) frame = requestAnimationFrame(tick);
    else record.finish();
  }
  tick(last);
}

export class MorphDialogs {
  constructor() {
    this.records = new Map();
    this.openers = new WeakMap();
    this.closing = new WeakMap();
    $$('dialog').forEach((dialog) => {
      dialog.addEventListener('cancel', (event) => {
        event.preventDefault();
        this.close(dialog);
      });
      dialog.addEventListener('click', (event) => {
        const r = dialog.getBoundingClientRect();
        if (
          event.target === dialog &&
          (event.clientX < r.x || event.clientX > r.right || event.clientY < r.y || event.clientY > r.bottom)
        )
          this.close(dialog);
      });
    });
    document.addEventListener('click', (event) => {
      const close = event.target.closest('[data-close]');
      if (close) this.close(close.closest('dialog'));
    });
    window.addEventListener('resize', () => {
      for (const record of this.records.values()) record.finish();
      surface?.finish();
    });
    window.addEventListener('preferenceschange', () => {
      if (!motionEnabled()) {
        for (const record of this.records.values()) record.finish();
        surface?.finish();
      }
    });
  }
  open(dialog, opener = document.activeElement) {
    if (!dialog || dialog.open) return;
    this.openers.set(dialog, opener);
    dialog.showModal();
    dialog.scrollTop = 0;
    const target = dialog.getBoundingClientRect(),
      source = opener?.getBoundingClientRect?.() || target;
    this.animate(dialog, source, target, true);
  }
  close(dialog) {
    if (!dialog?.open) return Promise.resolve();
    if (dialog.dataset.closing === 'true') return this.closing.get(dialog);
    dialog.dataset.closing = 'true';
    const opener = this.openers.get(dialog);
    const originalBox = opener?.getBoundingClientRect?.();
    const fallback = $('#island-trigger')?.getBoundingClientRect() || dialog.getBoundingClientRect();
    const source = originalBox?.width > 0 && originalBox.height > 0 ? originalBox : fallback;
    const closing = this.animate(dialog, dialog.getBoundingClientRect(), source, false).then((finished) => {
      if (!finished) return;
      dialog.close();
      delete dialog.dataset.closing;
      if (opener?.isConnected && !opener.closest('[hidden]')) opener.focus({ preventScroll: true });
      else $('#island-trigger')?.focus({ preventScroll: true });
      this.closing.delete(dialog);
    });
    this.closing.set(dialog, closing);
    return closing;
  }
  animate(dialog, from, to, opening) {
    this.records.get(dialog)?.cancel();
    if (!motionEnabled()) return Promise.resolve(true);
    const originalStyle = dialog.dataset.restStyle ?? dialog.getAttribute('style') ?? '';
    dialog.dataset.restStyle = originalStyle;
    dialog.style.setProperty('--content-width', (opening ? to.width : from.width) - 2 + 'px');
    const effect = opening ? effectName() : dialog.dataset.effect;
    dialog.dataset.effect = effect;
    dialog.classList.add('morphing');
    return new Promise((resolve) => {
      let frame,
        elapsed = 0,
        last = performance.now(),
        done = false;
      const finish = (success) => {
        if (done) return;
        done = true;
        cancelAnimationFrame(frame);
        dialog.classList.remove('morphing');
        dialog.style.cssText = originalStyle;
        delete dialog.dataset.restStyle;
        this.records.delete(dialog);
        resolve(success);
      };
      const record = { finish: () => finish(true), cancel: () => finish(false) };
      this.records.set(dialog, record);
      function tick(now) {
        elapsed += Math.min(100, Math.max(0, now - last));
        last = now;
        const t = motionEnabled()
            ? clamp(elapsed / (opening ? (isDesktopMotion(effect) ? 440 : 530) : 300), 0, 1)
            : 1,
          p = ease(t),
          wide = opening ? clamp(spring(t), 0, 1.015) : p;
        const w = lerp(from.width, to.width, wide),
          h = lerp(from.height, to.height, p);
        Object.assign(dialog.style, {
          position: 'fixed',
          margin: '0',
          left: lerp(from.x, to.x, p) + 'px',
          top: lerp(from.y, to.y, p) + 'px',
          width: w + 'px',
          height: h + 'px',
        });
        dialog.style.clipPath = `path("${mask(effect, w, h, opening ? t : 1 - t)}")`;
        dialog.style.setProperty('--content-opacity', opening ? clamp((t - 0.2) / 0.5, 0, 1) : 1 - ease(t));
        if (t < 1) frame = requestAnimationFrame(tick);
        else finish(true);
      }
      tick(last);
    });
  }
}

export function springGroups() {
  const records = new WeakMap();
  function sync(group, animate = true) {
    const target = $('button[aria-pressed="true"],a[aria-current="page"]', group);
    if (!target || !group.getClientRects().length || group.closest('[hidden]')) return;
    let thumb = $('.spring-indicator', group);
    if (!thumb) {
      thumb = document.createElement('span');
      thumb.className = 'spring-indicator';
      thumb.setAttribute('aria-hidden', 'true');
      group.prepend(thumb);
    }
    const previous = thumb.getBoundingClientRect(),
      bounds = group.getBoundingClientRect(),
      hasPrevious = records.has(group);
    records.get(group)?.cancel();
    const x = target.offsetLeft,
      y = target.offsetTop;
    Object.assign(thumb.style, {
      left: x + 'px',
      top: y + 'px',
      width: target.offsetWidth + 'px',
      height: target.offsetHeight + 'px',
    });
    if (hasPrevious && animate && motionEnabled()) {
      const animation = thumb.animate(
        [
          {
            transform: `translate(${previous.x - bounds.x - x}px,${previous.y - bounds.y - y}px)`,
            width: previous.width + 'px',
          },
          { transform: 'none', width: target.offsetWidth + 'px' },
        ],
        { duration: 610, easing: 'cubic-bezier(.34,1.56,.64,1)' },
      );
      animation.finished.catch(() => {});
      records.set(group, animation);
    } else records.set(group, null);
  }
  $$('.spring-group').forEach((group) => {
    const observer = new MutationObserver(() => sync(group));
    observer.observe(group, {
      attributes: true,
      subtree: true,
      attributeFilter: ['aria-pressed', 'aria-current'],
    });
    new ResizeObserver(() => sync(group, false)).observe(group);
    sync(group, false);
  });
  return () => $$('.spring-group').forEach((group) => sync(group, false));
}

export function kineticControls() {
  document.addEventListener('pointerover', (event) => {
    const button = event.target.closest('button,a');
    if (!button || button.contains(event.relatedTarget) || !motionEnabled() || !preferences.liquid) return;
    const glyph = $('svg.icon', button);
    if (!glyph) return;
    const spin = /settings|replay/.test($('use', glyph)?.getAttribute('href'));
    const animation = glyph.animate(
      spin
        ? [
            { transform: 'rotate(0deg)' },
            { transform: 'rotate(395deg)', offset: 0.78 },
            { transform: 'rotate(360deg)' },
          ]
        : [
            { transform: 'scale(.88) rotate(-8deg)' },
            { transform: 'scale(1.16) rotate(8deg)', offset: 0.5 },
            { transform: 'none' },
          ],
      { duration: 560, easing: 'cubic-bezier(.22,1,.36,1)', composite: 'add' },
    );
    animation.finished.catch(() => {});
  });
  document.addEventListener('pointerdown', (event) => {
    const button = event.target.closest('button,a');
    if (!button || button.disabled || !motionEnabled() || !preferences.ripple) return;
    const rect = button.getBoundingClientRect(),
      wave = document.createElement('span');
    wave.className = 'tap-wave';
    wave.setAttribute('aria-hidden', 'true');
    Object.assign(wave.style, { left: event.clientX - rect.x + 'px', top: event.clientY - rect.y + 'px' });
    button.append(wave);
    const animation = wave.animate(
      [
        { transform: 'translate(-50%,-50%) scale(0)', opacity: 0.4 },
        { transform: 'translate(-50%,-50%) scale(1)', opacity: 0 },
      ],
      { duration: 620, easing: 'ease-out' },
    );
    animation.finished.catch(() => {}).then(() => wave.remove());
  });
}

export { mask as transitionMask };
