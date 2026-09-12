import { desktopMask, desktopTransform, isDesktopMotion } from './desktop-motion.js';

const clamp = (value) => Math.max(0, Math.min(1, value));
const smooth = (value) => {
  const t = clamp(value);
  return t * t * (3 - 2 * t);
};
const mix = (a, b, t) => a + (b - a) * t;
const f = (value) => Number(value.toFixed(3));
export function roundedRect(x, y, width, height, radius = 24) {
  const w = Math.max(0.01, width),
    h = Math.max(0.01, height),
    r = Math.max(0, Math.min(radius, w / 2, h / 2));
  return `M${f(x + r)} ${f(y)}H${f(x + w - r)}Q${f(x + w)} ${f(y)} ${f(x + w)} ${f(y + r)}V${f(y + h - r)}Q${f(x + w)} ${f(y + h)} ${f(x + w - r)} ${f(y + h)}H${f(x + r)}Q${f(x)} ${f(y + h)} ${f(x)} ${f(y + h - r)}V${f(y + r)}Q${f(x)} ${f(y)} ${f(x + r)} ${f(y)}Z`;
}
function circle(cx, cy, radius, reverse = false) {
  const r = Math.max(0.01, radius),
    sweep = reverse ? 0 : 1;
  return `M${f(cx + r)} ${f(cy)}A${f(r)} ${f(r)} 0 1 ${sweep} ${f(cx - r)} ${f(cy)}A${f(r)} ${f(r)} 0 1 ${sweep} ${f(cx + r)} ${f(cy)}Z`;
}
function curve(points, tension = 0.13) {
  let path = `M${points[0].map(f).join(' ')}`;
  for (let i = 0; i < points.length; i++) {
    const a = points[(i + points.length - 1) % points.length],
      b = points[i],
      c = points[(i + 1) % points.length],
      d = points[(i + 2) % points.length];
    const values = [
      b[0] + (c[0] - a[0]) * tension,
      b[1] + (c[1] - a[1]) * tension,
      c[0] - (d[0] - b[0]) * tension,
      c[1] - (d[1] - b[1]) * tension,
      ...c,
    ];
    path += `C${values.map(f).join(' ')}`;
  }
  return path + 'Z';
}
function polarWindow(effect, w, h, t) {
  const growth = mix(0.025, 1, smooth(t));
  const fill = smooth((t - 0.57) / 0.43);
  const cx = w / 2,
    cy = h / 2;
  const points = Array.from({ length: 48 }, (_, i) => {
    const angle = -Math.PI / 2 + (i * Math.PI * 2) / 48;
    const cos = Math.cos(angle),
      sin = Math.sin(angle);
    const boundary = Math.min(
      w / 2 / Math.max(0.00001, Math.abs(cos)),
      h / 2 / Math.max(0.00001, Math.abs(sin)),
    );
    if (effect === 'star') {
      const sx = (w / 2) * Math.sign(cos) * Math.abs(cos) ** 3;
      const sy = (h / 2) * Math.sign(sin) * Math.abs(sin) ** 3;
      return [cx + mix(sx, cos * boundary, fill) * growth, cy + mix(sy, sin * boundary, fill) * growth];
    }
    const factor = 0.57 + 0.43 * ((Math.cos(6 * angle) + 1) / 2);
    const radius = boundary * growth * mix(factor, 1, fill);
    return [cx + cos * radius, cy + sin * radius];
  });
  return curve(points, effect === 'star' ? 0.085 : 0.15);
}
function diagonalWindow(w, h, t) {
  const threshold = 0.015 + 1.985 * smooth(t);
  let polygon = [
    [0, 0],
    [w, 0],
    [w, h],
    [0, h],
  ];
  const result = [];
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i],
      b = polygon[(i + 1) % polygon.length];
    const da = a[0] / w + a[1] / h - threshold,
      db = b[0] / w + b[1] / h - threshold;
    if (da <= 0) result.push(a);
    if (da <= 0 !== db <= 0) {
      const p = da / (da - db);
      result.push([mix(a[0], b[0], p), mix(a[1], b[1], p)]);
    }
  }
  return `M${result.map((point) => point.map(f).join(' ')).join('L')}Z`;
}

// Shared by the real windows, section transitions and the scrubbable preview.
export function transitionPath(effect, width, height, progress, origin = {}) {
  const w = Math.max(1, width),
    h = Math.max(1, height),
    t = clamp(progress);
  if (t >= 0.9999) return roundedRect(0, 0, w, h, 24);
  if (origin.surfaceHeight && h > origin.surfaceHeight + 1) {
    const visible = Math.max(120, origin.surfaceHeight);
    return (
      transitionPath(effect, w, visible, t, { ...origin, surfaceHeight: undefined }) +
      roundedRect(0, visible - 1, w, h - visible + 1, 0)
    );
  }
  if (isDesktopMotion(effect)) return desktopMask(effect, w, h, t, origin.direction || 1);
  if (effect === 'star' || effect === 'bloom') return polarWindow(effect, w, h, t);
  if (effect === 'ribbon') return diagonalWindow(w, h, t);
  if (effect === 'orbit') {
    const r = (Math.hypot(w, h) / 2) * mix(0.025, 1.025, smooth(t));
    const hole = r * 0.71 * (1 - smooth((t - 0.5) / 0.36));
    return circle(w / 2, h / 2, r) + (hole > 0.1 ? circle(w / 2, h / 2, hole, true) : '');
  }
  if (effect === 'iris') return circle(w / 2, h / 2, (Math.hypot(w, h) / 2) * mix(0.015, 1.025, smooth(t)));
  const p = smooth(t),
    rw = mix(24, w, p),
    rh = mix(20, h, smooth((t - 0.03) / 0.97));
  const x = (w - rw) / 2,
    y = mix(Math.max(0, h * 0.62 - 10), 0, p);
  const warp = Math.sin(Math.PI * t) * 0.18;
  return curve(
    [
      [x + rw * 0.2, y],
      [x + rw * 0.5, y + rh * warp],
      [x + rw * 0.83, y],
      [x + rw, y + rh * 0.25],
      [x + rw - rw * warp, y + rh * 0.55],
      [x + rw, y + rh * 0.8],
      [x + rw * 0.75, y + rh],
      [x + rw * 0.46, y + rh - rh * warp],
      [x + rw * 0.18, y + rh],
      [x, y + rh * 0.75],
      [x + rw * warp, y + rh * 0.45],
      [x, y + rh * 0.2],
    ],
    0.15,
  );
}
export function transitionTransform(effect, width, progress, direction = 1) {
  const t = clamp(progress);
  if (isDesktopMotion(effect)) return desktopTransform(effect, width, t, direction);
  if (effect === 'ribbon')
    return `perspective(900px) rotateY(${(1 - smooth(t)) * -8}deg) rotateZ(${(1 - smooth(t)) * -2}deg)`;
  if (effect === 'bloom') return `rotate(${(1 - smooth(t)) * -8}deg)`;
  return 'none';
}
export function motionFrame(effect, width, height, progress, origin = {}) {
  const path = transitionPath(effect, width, height, progress, origin);
  return {
    path,
    clipPath: `path("${path}")`,
    transform: transitionTransform(effect, width, progress, origin.direction || 1),
  };
}
