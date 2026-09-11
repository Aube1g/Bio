// A press repeats a setting, never a wager. Native click/keyboard activation remains intact.
export function bindPressRepeat(button, action, { delay = 360, interval = 100, fastInterval = 60 } = {}) {
  let timer = 0,
    started = 0,
    held = false,
    repeated = false,
    pointer = null;
  const clear = () => {
    clearTimeout(timer);
    timer = 0;
    held = false;
    pointer = null;
  };
  const tick = () => {
    if (!held || button.disabled || document.hidden || !button.isConnected) {
      clear();
      return;
    }
    repeated = true;
    if (action() === false) {
      clear();
      return;
    }
    timer = setTimeout(tick, performance.now() - started > 1200 ? fastInterval : interval);
  };
  button.addEventListener('pointerdown', (event) => {
    if (button.disabled || event.button !== 0) return;
    clear();
    held = true;
    repeated = false;
    pointer = event.pointerId;
    started = performance.now();
    button.setPointerCapture?.(event.pointerId);
    timer = setTimeout(tick, delay);
  });
  button.addEventListener('pointerup', (event) => {
    if (event.pointerId === pointer) clear();
  });
  button.addEventListener('pointercancel', () => {
    repeated = false;
    clear();
  });
  button.addEventListener('lostpointercapture', clear);
  button.addEventListener('click', (event) => {
    if (repeated && event.detail > 0) {
      event.preventDefault();
      repeated = false;
      return;
    }
    if (!button.disabled) action();
  });
  button.addEventListener('keydown', (event) => {
    if (![' ', 'Enter'].includes(event.key) || button.disabled) return;
    event.preventDefault();
    if (event.repeat || held) return;
    held = true;
    repeated = false;
    started = performance.now();
    action();
    timer = setTimeout(tick, delay);
  });
  button.addEventListener('keyup', (event) => {
    if ([' ', 'Enter'].includes(event.key)) {
      event.preventDefault();
      repeated = false;
      clear();
    }
  });
  button.addEventListener('blur', clear);
  window.addEventListener('blur', clear);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) clear();
  });
  return clear;
}
