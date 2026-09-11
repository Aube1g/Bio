import { $, $$, icon, clamp } from '../shared/dom.js';
import { motionEnabled, preferences } from '../shared/preferences.js';
import { plinkoTable, SLOT_SYMBOLS } from '../shared/game-rules.js';

export const symbolHTML = (index) =>
  `<span class="slot-symbol symbol-${SLOT_SYMBOLS[index]}">${index === 6 ? '<b>7</b>' : icon(SLOT_SYMBOLS[index])}</span>`;
const rankNames = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const suitNames = ['spade', 'heart', 'club', 'diamond'];
export function cardHTML(card) {
  if (card === null)
    return `<div class="playing-card card-back" role="img" aria-label="Закрытая карта">${icon('mark')}</div>`;
  const rank = rankNames[card % 13],
    suit = suitNames[Math.floor(card / 13)];
  return `<div class="playing-card ${suit === 'heart' || suit === 'diamond' ? 'red' : 'black'}" role="img" aria-label="${rank} ${suit}"><span class="card-corner">${rank}${icon(suit)}</span><span class="card-suit">${icon(suit)}</span><span class="card-corner bottom">${rank}${icon(suit)}</span></div>`;
}
export function cubeHTML() {
  const positions = {
    1: [5],
    2: [1, 9],
    3: [1, 5, 9],
    4: [1, 3, 7, 9],
    5: [1, 3, 5, 7, 9],
    6: [1, 3, 4, 6, 7, 9],
  };
  return (
    Array.from({ length: 6 }, (_, i) => `<div class="cube-core core-${i + 1}"></div>`).join('') +
    Object.entries(positions)
      .map(
        ([face, pips]) =>
          `<div class="cube-face face-${face}" data-face="${face}">${Array.from({ length: 9 }, (_, i) => `<i class="${pips.includes(i + 1) ? 'pip' : 'blank'}"></i>`).join('')}</div>`,
      )
      .join('')
  );
}
const orientations = { 1: [0, 0], 2: [-90, 0], 3: [0, -90], 4: [0, 90], 5: [90, 0], 6: [0, 180] };

export class DiceRenderer {
  constructor(element) {
    this.element = element;
    this.element.innerHTML = cubeHTML();
    this.finish = null;
    this.value = 1;
  }
  land(value) {
    this.finish?.();
    this.value = value;
    const [x, y] = orientations[value];
    this.element.dataset.value = value;
    this.element.setAttribute('aria-label', `${preferences.lang === 'en' ? 'Die' : 'Кубик'}: ${value}`);
    const target = `rotateX(${x}deg) rotateY(${y}deg)`;
    if (!motionEnabled()) {
      this.element.style.transform = target;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const animation = this.element.animate(
        [
          { transform: this.element.style.transform || 'rotateX(0deg) rotateY(0deg)' },
          { transform: `translateY(-34px) rotateX(${x + 480}deg) rotateY(${y + 430}deg)`, offset: 0.42 },
          { transform: `translateY(5px) rotateX(${x + 715}deg) rotateY(${y + 716}deg)`, offset: 0.82 },
          { transform: `translateY(-4px) rotateX(${x + 722}deg) rotateY(${y + 722}deg)`, offset: 0.93 },
          { transform: `translateY(0) rotateX(${x + 720}deg) rotateY(${y + 720}deg)` },
        ],
        { duration: 1300, easing: 'cubic-bezier(.16,.7,.22,1)' },
      );
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        animation.cancel();
        this.element.style.transform = target;
        this.finish = null;
        resolve();
      };
      this.finish = finish;
      animation.finished.then(finish).catch(() => {});
    });
  }
}

export class SlotsRenderer {
  constructor(element, onStop = () => {}) {
    this.element = element;
    this.onStop = onStop;
    this.finish = null;
    this.show([0, 4, 5]);
  }
  show(symbols) {
    this.element.innerHTML = symbols
      .map(
        (symbol) =>
          `<div class="reel-window"><div class="reel-strip">${[(symbol + 1) % 8, symbol, (symbol + 7) % 8].map((s) => `<div class="reel-cell">${symbolHTML(s)}</div>`).join('')}</div><div class="reel-payline"></div></div>`,
      )
      .join('');
    this.element.dataset.symbols = symbols.join(',');
  }
  spin(symbols) {
    this.finish?.();
    if (!motionEnabled()) {
      this.show(symbols);
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let frame,
        done = false;
      const start = performance.now();
      const positions = [23, 29, 35];
      this.element.innerHTML = symbols
        .map((symbol, i) => {
          const values = Array.from({ length: positions[i] + 3 }, (_, j) =>
            j === positions[i] ? symbol : (j * 3 + i * 5) % 8,
          );
          values[positions[i] - 1] = (symbol + 1) % 8;
          values[positions[i] + 1] = (symbol + 7) % 8;
          return `<div class="reel-window"><div class="reel-strip">${values.map((s) => `<div class="reel-cell">${symbolHTML(s)}</div>`).join('')}</div><div class="reel-payline"></div></div>`;
        })
        .join('');
      const reels = $$('.reel-strip', this.element);
      this.finish = () => {
        if (done) return;
        done = true;
        cancelAnimationFrame(frame);
        this.show(symbols);
        this.finish = null;
        resolve();
      };
      const tick = (now) => {
        reels.forEach((reel, index) => {
          const t = clamp((now - start) / (1400 + index * 320), 0, 1),
            p = 1 - (1 - t) ** 4;
          const position = 1 + (positions[index] - 1) * p;
          reel.style.transform = `translateY(calc(${1 - position} * var(--reel-cell)))`;
          const window = reel.closest('.reel-window');
          if (t === 1 && !window.classList.contains('stopped')) this.onStop();
          window.classList.toggle('stopped', t === 1);
        });
        if (now - start < 2040 && motionEnabled()) frame = requestAnimationFrame(tick);
        else this.finish?.();
      };
      frame = requestAnimationFrame(tick);
    });
  }
}

export { PlinkoRenderer } from './plinko-renderer.js';

export function renderCardHand(container, cards) {
  const previous = [...container.children];
  let added = 0;
  cards.forEach((card, index) => {
    const identity = card === null ? 'hidden' : String(card);
    if (previous[index]?.dataset.card === identity) return;
    const wrapper = document.createElement('div');
    wrapper.innerHTML = cardHTML(card);
    const node = wrapper.firstElementChild;
    node.dataset.card = identity;
    const flip = previous[index]?.dataset.card === 'hidden' && card !== null;
    if (previous[index]) previous[index].replaceWith(node);
    else container.append(node);
    if (motionEnabled()) {
      const animation = node.animate(
        [
          {
            opacity: flip ? 0.5 : 0,
            transform: flip ? 'rotateY(-80deg)' : 'translate(18px,-26px) rotate(7deg)',
          },
          { opacity: 1, transform: 'none' },
        ],
        { duration: flip ? 390 : 420, delay: added++ * 75, easing: 'cubic-bezier(.16,1,.3,1)' },
      );
      animation.finished.catch(() => {});
    }
  });
  previous.slice(cards.length).forEach((node) => node.remove());
}
