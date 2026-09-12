import { $, $$ } from '../shared/dom.js';
import { preferences, motionEnabled } from '../shared/preferences.js';
import { binomial, plinkoTable } from '../shared/game-rules.js';
import { plinkoGeometry, plinkoTrajectory, plinkoPosition } from './plinko-path.js';

const BALL_COLORS = [
  ['#fcffdc', '#d5ef8e', '#81a940'],
  ['#fff1f8', '#f0a6d1', '#b86499'],
  ['#ecfaff', '#9cd9f0', '#538fae'],
];

export class PlinkoRenderer {
  constructor(canvas, bins, onImpact = () => {}) {
    this.canvas = canvas;
    this.context = canvas.getContext('2d');
    this.staticLayer = document.createElement('canvas');
    this.bins = bins;
    this.onImpact = onImpact;
    this.rows = 12;
    this.risk = 'medium';
    this.lastSlot = null;
    this.selectedSlot = 6;
    this.balls = [];
    this.impacts = [];
    this.frame = 0;
    this.last = 0;
    this.geometry = null;
    this.layoutKey = '';
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    bins.addEventListener('pointerover', (event) => this.inspect(event.target.closest('[data-bin]')));
    bins.addEventListener('focusin', (event) => this.inspect(event.target.closest('[data-bin]')));
    bins.addEventListener('click', (event) => this.inspect(event.target.closest('[data-bin]')));
    window.addEventListener('preferenceschange', () => {
      if (!motionEnabled()) this.finishAll();
      this.resize();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.finishAll();
      else this.start();
    });
    this.resize();
  }
  configure(rows, risk) {
    if (this.balls.length) return false;
    plinkoTable(rows, risk);
    if (rows !== this.rows || risk !== this.risk) {
      this.lastSlot = null;
      this.selectedSlot = Math.floor(rows / 2);
      delete this.bins.dataset.landed;
    }
    this.rows = rows;
    this.risk = risk;
    this.resize();
    return true;
  }
  resize() {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width < 100 || rect.height < 120) return;
    const key = [
      Math.round(rect.width * 10),
      Math.round(rect.height * 10),
      this.rows,
      this.risk,
      preferences.theme,
      preferences.lang,
      Math.min(devicePixelRatio || 1, 2),
    ].join(':');
    if (key === this.layoutKey) return;
    this.layoutKey = key;
    this.ratio = Math.min(devicePixelRatio || 1, 2);
    this.canvas.width = this.staticLayer.width = Math.round(rect.width * this.ratio);
    this.canvas.height = this.staticLayer.height = Math.round(rect.height * this.ratio);
    this.context?.setTransform(this.ratio, 0, 0, this.ratio, 0, 0);
    this.geometry = plinkoGeometry(this.rows, rect.width, rect.height);
    for (const ball of this.balls)
      ball.path = plinkoTrajectory(ball.round.outcome.directions, this.geometry, ball.round.id);
    const table = plinkoTable(this.rows, this.risk);
    this.bins.innerHTML = table
      .map((multiplier, index) => {
        const value = String(multiplier);
        const size = Math.max(6, Math.min(10, ((this.geometry.gap - 5) * 1.75) / value.length));
        return `<button type="button" class="plinko-bin ${this.lastSlot === index ? 'is-last ' : ''}${multiplier >= 4 ? 'hot' : multiplier >= 1 ? 'warm' : 'cool'}" data-bin="${index}" style="left:${this.geometry.bins[index].x}px;width:${Math.max(4, this.geometry.gap - 2)}px;--bin-font:${size}px" aria-label="${preferences.lang === 'en' ? 'Slot' : 'Ячейка'} ${index + 1} · ×${value}" title="×${value}"><span>${value}</span></button>`;
      })
      .join('');
    this.paintPegs();
    this.inspect(null);
    this.draw();
  }
  inspect(button) {
    if (button) this.selectedSlot = Number(button.dataset.bin);
    const slot = Math.min(this.rows, this.selectedSlot);
    const value = $('#plinko-inspect-multiplier');
    if (!value) return;
    value.textContent = `${plinkoTable(this.rows, this.risk)[slot]}×`;
    $('#plinko-inspect-chance').textContent =
      new Intl.NumberFormat(preferences.lang, { maximumFractionDigits: 3 }).format(
        (binomial(this.rows, slot) / 2 ** this.rows) * 100,
      ) + '%';
    $('#plinko-inspect-slot').textContent = `${slot + 1} / ${this.rows + 1}`;
    $$('[data-bin]', this.bins).forEach((bin) =>
      bin.classList.toggle('is-inspected', Number(bin.dataset.bin) === slot),
    );
  }
  drop(round) {
    if (!this.geometry) this.resize();
    if (round.outcome.rows !== this.rows || round.outcome.risk !== this.risk)
      this.configure(round.outcome.rows, round.outcome.risk);
    if (!motionEnabled() || !this.context || !this.geometry) {
      this.flash(round.outcome.slot);
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.balls.push({
        round,
        elapsed: 0,
        path: plinkoTrajectory(round.outcome.directions, this.geometry, round.id),
        resolve,
        step: -1,
        trail: [],
        colors: BALL_COLORS[(round.proof?.nonce || 0) % BALL_COLORS.length],
      });
      this.canvas.dataset.activeBalls = this.balls.length;
      this.start();
    });
  }
  start() {
    if (this.frame || document.hidden || !this.balls.length) return;
    this.last = 0;
    this.frame = requestAnimationFrame((time) => this.tick(time));
  }
  tick(now) {
    this.frame = 0;
    if (document.hidden) {
      this.finishAll();
      return;
    }
    const dt = this.last ? Math.min((now - this.last) / 1000, 0.1) : 1 / 60;
    this.last = now;
    for (const ball of [...this.balls]) {
      ball.elapsed += dt;
      const position = plinkoPosition(ball.path, ball.elapsed);
      for (let step = ball.step + 1; step <= position.step; step++) {
        const peg = ball.path.steps[step]?.from.peg;
        if (peg) {
          this.impacts.push({ ...peg, life: 1 });
          this.onImpact(peg.row);
        }
      }
      ball.step = position.step;
      // Trail times, not pixels, keep the same route after a responsive resize.
      ball.trail.push(ball.elapsed);
      if (ball.trail.length > 10) ball.trail.shift();
      if (position.done) {
        this.balls.splice(this.balls.indexOf(ball), 1);
        this.flash(ball.round.outcome.slot);
        ball.resolve();
      }
    }
    this.canvas.dataset.activeBalls = this.balls.length;
    this.impacts = this.impacts
      .map((point) => ({ ...point, life: point.life - dt * 3.5 }))
      .filter((point) => point.life > 0);
    this.draw();
    if (this.balls.length || this.impacts.length)
      this.frame = requestAnimationFrame((time) => this.tick(time));
    else this.last = 0;
  }
  flash(slot) {
    this.lastSlot = this.selectedSlot = slot;
    this.bins.dataset.landed = String(slot);
    this.canvas.setAttribute(
      'aria-label',
      `${preferences.lang === 'en' ? 'Plinko, slot' : 'Плинко, ячейка'} ${slot + 1}, ×${plinkoTable(this.rows, this.risk)[slot]}`,
    );
    $$('[data-bin]', this.bins).forEach((bin) =>
      bin.classList.toggle('is-last', Number(bin.dataset.bin) === slot),
    );
    this.inspect(null);
    const bin = $(`[data-bin="${slot}"]`, this.bins);
    if (bin && motionEnabled()) {
      const animation = bin.animate(
        [
          { translate: '0 0' },
          { translate: '0 5px', offset: 0.25 },
          { translate: '0 -3px', offset: 0.6 },
          { translate: '0 0' },
        ],
        { duration: 440, easing: 'cubic-bezier(.22,1.28,.36,1)' },
      );
      animation.finished.catch(() => {});
    }
  }
  finishAll() {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    const pending = this.balls.splice(0);
    for (const ball of pending) {
      this.flash(ball.round.outcome.slot);
      ball.resolve();
    }
    this.canvas.dataset.activeBalls = '0';
    this.impacts = [];
    this.last = 0;
    this.draw();
  }
  paintPegs() {
    const context = this.staticLayer.getContext('2d'),
      geometry = this.geometry;
    if (!context || !geometry) return;
    context.setTransform(this.ratio, 0, 0, this.ratio, 0, 0);
    context.clearRect(0, 0, geometry.width, geometry.height);
    const light = preferences.theme === 'light';
    context.strokeStyle = light ? '#8771b11a' : '#c3a0ff0c';
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(geometry.width / 2 - geometry.gap * 1.45, geometry.top - 10);
    context.lineTo(geometry.width / 2 - ((this.rows + 2) / 2) * geometry.gap, geometry.bins[0].y - 18);
    context.moveTo(geometry.width / 2 + geometry.gap * 1.45, geometry.top - 10);
    context.lineTo(geometry.width / 2 + ((this.rows + 2) / 2) * geometry.gap, geometry.bins[0].y - 18);
    context.stroke();
    for (const peg of [...geometry.pegs.flat(), ...geometry.guidePegs]) {
      context.fillStyle = light ? '#8b77ad' : '#75628f';
      context.beginPath();
      context.arc(peg.x, peg.y, geometry.pegRadius, 0, Math.PI * 2);
      context.fill();
      context.fillStyle = light ? '#e0d7ed' : '#e0cfef';
      context.beginPath();
      context.arc(peg.x - 0.4, peg.y - 0.6, geometry.pegRadius * 0.4, 0, Math.PI * 2);
      context.fill();
    }
  }
  draw() {
    const ctx = this.context,
      g = this.geometry;
    if (!ctx || !g) return;
    ctx.clearRect(0, 0, g.width, g.height);
    ctx.drawImage(this.staticLayer, 0, 0, g.width, g.height);
    for (const impact of this.impacts) {
      ctx.strokeStyle = `rgba(195,163,255,${impact.life * 0.8})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(impact.x, impact.y, g.pegRadius + (1 - impact.life) * 11, 0, Math.PI * 2);
      ctx.stroke();
    }
    for (const ball of this.balls) {
      for (const [index, time] of ball.trail.entries()) {
        const point = plinkoPosition(ball.path, time);
        ctx.globalAlpha = (index / ball.trail.length) * 0.2;
        ctx.fillStyle = ball.colors[1];
        ctx.beginPath();
        ctx.arc(point.x, point.y, (g.ballRadius * index) / ball.trail.length, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      const point = plinkoPosition(ball.path, ball.elapsed);
      const glow = ctx.createRadialGradient(point.x - 1, point.y - 2, 0, point.x, point.y, g.ballRadius);
      glow.addColorStop(0, ball.colors[0]);
      glow.addColorStop(0.5, ball.colors[1]);
      glow.addColorStop(1, ball.colors[2]);
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(point.x, point.y, g.ballRadius, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
