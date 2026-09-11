export const TRANSITION_STYLES = ['hyprland', 'caelestia', 'liquid', 'iris', 'shutters', 'cascade'];
export const isDesktopMotion = (name) => name === 'hyprland' || name === 'caelestia';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
export const emphasized = (t) => 1 - (1 - clamp(t, 0, 1)) ** 5;
export function workspaceProgress(t) {
  t = clamp(t, 0, 1);
  return t === 1 ? 1 : 1 - Math.exp(-8 * t) * (Math.cos(10 * t) + 0.8 * Math.sin(10 * t));
}

function rounded(x, y, w, h, radius) {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  return `M${x + r} ${y}H${x + w - r}Q${x + w} ${y} ${x + w} ${y + r}V${y + h - r}Q${x + w} ${y + h} ${x + w - r} ${y + h}H${x + r}Q${x} ${y + h} ${x} ${y + h - r}V${y + r}Q${x} ${y} ${x + r} ${y}Z`;
}

// Workspace slides and emphasized panel expansion, inspired by desktop compositors.
export function desktopMask(effect, width, height, t, direction = 1) {
  const w = Math.max(1, width),
    h = Math.max(1, height),
    p = emphasized(t);
  if (effect === 'hyprland') {
    const cut = (1 - p) * w * 0.22;
    return rounded(direction > 0 ? cut : 0, 0, w - cut, h, 24 + (1 - p) * 30);
  }
  const insetX = (1 - p) * w * 0.035;
  const insetY = (1 - p) * Math.min(130, h * 0.2);
  return rounded(insetX, insetY, w - insetX * 2, h - insetY * 2, 24 + Math.sin(Math.PI * t) * 34);
}

export function desktopTransform(effect, width, t, direction = 1) {
  if (effect === 'hyprland') {
    const x = (1 - workspaceProgress(t)) * Math.min(115, width * 0.16) * direction;
    return `translate3d(${x}px,0,0)`;
  }
  const remaining = 1 - workspaceProgress(t);
  return `translate3d(0,${remaining * 26}px,0) scale(${1 - remaining * 0.035})`;
}
