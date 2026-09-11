const controllers = new Set();
let installed = false;
const motionAllowed = () => document.documentElement.dataset.motion !== 'off';
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function installLensFilter() {
  if (document.getElementById('switch-refraction')) return;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('aria-hidden', 'true');
  svg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none';
  svg.innerHTML = `<defs><filter id="switch-refraction" x="-30%" y="-40%" width="160%" height="180%" color-interpolation-filters="sRGB"><feTurbulence type="fractalNoise" baseFrequency=".021 .055" numOctaves="1" seed="8" result="texture"/><feGaussianBlur in="texture" stdDeviation="1.2" result="soft"/><feDisplacementMap in="SourceGraphic" in2="soft" scale="7" xChannelSelector="R" yChannelSelector="G"/></filter></defs>`;
  document.body.prepend(svg);
}

class GlassSwitch {
  constructor(input) {
    this.input = input;
    this.host = input.parentElement;
    this.position = input.checked ? 1 : 0;
    this.target = this.position;
    this.velocity = 0;
    this.frame = 0;
    this.gesture = null;
    this.suppressClick = false;
    this.lens = document.createElement('span');
    this.lens.className = 'glass-switch-lens';
    this.lens.setAttribute('aria-hidden', 'true');
    this.host.append(this.lens);
    this.host.classList.add('glass-switch');
    input.setAttribute('role', 'switch');
    const description = input.closest('.setting-row')?.querySelector('.setting-description');
    if (description && input.id) {
      description.id ||= `${input.id}-description`;
      input.setAttribute('aria-describedby', description.id);
    }
    input.addEventListener('change', () => this.sync());
    input.addEventListener('pointerdown', (event) => this.startDrag(event));
    input.addEventListener('pointermove', (event) => this.drag(event));
    input.addEventListener('pointerup', (event) => this.endDrag(event));
    input.addEventListener('pointercancel', () => this.cancelDrag());
    input.addEventListener('lostpointercapture', () => {
      if (this.gesture) this.cancelDrag();
    });
    input.addEventListener(
      'click',
      (event) => {
        if (this.suppressClick && event.detail !== 0) {
          // Cancelling the native click also restores its pre-activation checked state.
          event.preventDefault();
          this.suppressClick = false;
        }
      },
      true,
    );
    this.paint();
  }
  paint() {
    this.host.style.setProperty('--switch-position', this.position.toFixed(4));
    const deformation = motionAllowed() ? Math.min(0.2, Math.abs(this.velocity) * 0.022) : 0;
    this.host.style.setProperty('--lens-stretch', String(1 + deformation));
    this.host.style.setProperty('--lens-squash', String(1 - deformation * 0.36));
  }
  sync(animate = motionAllowed()) {
    const next = this.input.checked ? 1 : 0;
    if (this.gesture) return;
    if (!animate || this.input.disabled) {
      cancelAnimationFrame(this.frame);
      this.frame = 0;
      this.position = this.target = next;
      this.velocity = 0;
      this.paint();
      return;
    }
    if (next === this.target && Math.abs(this.position - next) < 0.001) return;
    this.target = next;
    if (this.frame) return;
    let last = performance.now();
    const tick = (now) => {
      this.frame = 0;
      if (!motionAllowed()) {
        this.sync(false);
        return;
      }
      const dt = Math.min((now - last) / 1000, 0.035);
      last = now;
      // Two small integration steps keep the lens stable on slow frames.
      for (let i = 0; i < 2; i++) {
        this.velocity += (((this.target - this.position) * 430 - this.velocity * 25) * dt) / 2;
        this.position = clamp(this.position + (this.velocity * dt) / 2, -0.065, 1.065);
      }
      this.paint();
      if (Math.abs(this.target - this.position) > 0.001 || Math.abs(this.velocity) > 0.012)
        this.frame = requestAnimationFrame(tick);
      else {
        this.position = this.target;
        this.velocity = 0;
        this.paint();
      }
    };
    this.frame = requestAnimationFrame(tick);
  }
  startDrag(event) {
    if (this.input.disabled || event.button !== 0) return;
    this.suppressClick = false;
    this.gesture = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      position: this.position,
      moved: false,
    };
    this.host.dataset.touching = 'true';
    this.input.setPointerCapture?.(event.pointerId);
  }
  drag(event) {
    const gesture = this.gesture;
    if (!gesture || gesture.id !== event.pointerId) return;
    const dx = event.clientX - gesture.x;
    if (!gesture.moved && Math.abs(dx) <= 4) return;
    gesture.moved = true;
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    const distance = this.host.getBoundingClientRect().width - 42;
    this.position = clamp(gesture.position + dx / Math.max(1, distance), 0, 1);
    this.velocity = 0;
    this.host.dataset.dragging = 'true';
    this.paint();
  }
  endDrag(event) {
    const gesture = this.gesture;
    if (!gesture || gesture.id !== event.pointerId) return;
    this.gesture = null;
    delete this.host.dataset.touching;
    delete this.host.dataset.dragging;
    if (!gesture.moved) return;
    this.suppressClick = true;
    const checked = this.position >= 0.5;
    if (this.input.checked !== checked) {
      this.input.checked = checked;
      this.input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    this.sync();
  }
  cancelDrag() {
    this.gesture = null;
    delete this.host.dataset.touching;
    delete this.host.dataset.dragging;
    this.sync();
  }
}

export function initializeSwitches(scope = document) {
  installLensFilter();
  for (const input of scope.querySelectorAll('.switch input, .toggle-control input')) {
    if (!input.parentElement.classList.contains('glass-switch')) controllers.add(new GlassSwitch(input));
  }
  if (installed) return;
  installed = true;
  const sync = () => controllers.forEach((controller) => controller.sync());
  window.addEventListener('preferenceschange', sync);
  new MutationObserver(sync).observe(document.documentElement, {
    attributes: true,
    attributeFilter: [
      'data-theme',
      'data-motion',
      'data-ripple',
      'data-particles',
      'data-liquid',
      'data-glass',
    ],
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) controllers.forEach((controller) => controller.sync(false));
  });
}
