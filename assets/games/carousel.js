import { $, $$ } from '../shared/dom.js';
import { preferences } from '../shared/preferences.js';

/* Spotlight carousel for the game collection.
   Native scroll-snap does the heavy lifting; this module only centres cards,
   tracks the card nearest to the middle and wires arrows / dots / keyboard. */
export function setupCarousel(games, { t, motionEnabled }) {
  const track = document.querySelector('.game-collection');
  const dotsHost = $('#carousel-dots');
  if (!track || !dotsHost) return { scrollToGame() {}, sync() {} };
  const cards = $$('.game-card', track);
  const names = cards.map((card) => card.dataset.card);
  cards.forEach((card) => card.setAttribute('role', 'option'));
  track.setAttribute('tabindex', '0');
  track.setAttribute('role', 'listbox');
  track.setAttribute('aria-label', preferences.lang === 'en' ? 'Game collection' : 'Коллекция игр');

  const dots = names.map((name, index) => {
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.className = 'carousel-dot';
    dot.setAttribute('role', 'tab');
    dot.dataset.index = String(index);
    dot.setAttribute('aria-label', games[name]?.title || name);
    const slide = document.createElement('i');
    dot.append(slide);
    dot.addEventListener('click', () => center(index));
    dotsHost.append(dot);
    return dot;
  });

  let active = -1,
    frame = 0;

  function center(index, instant = false) {
    const card = cards[Math.max(0, Math.min(index, cards.length - 1))];
    if (!card) return;
    const left = card.offsetLeft - (track.clientWidth - card.offsetWidth) / 2;
    track.scrollTo({ left, behavior: !instant && motionEnabled() ? 'smooth' : 'instant' });
  }
  function nearest() {
    const middle = track.scrollLeft + track.clientWidth / 2;
    let best = 0,
      bestDistance = Infinity;
    cards.forEach((card, index) => {
      const cardMiddle = card.offsetLeft + card.offsetWidth / 2;
      const distance = Math.abs(cardMiddle - middle);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    });
    return best;
  }
  const DEPTH_VARS = ['--rz', '--tz', '--ty', '--sc', '--dim'];
  function paint() {
    frame = 0;
    const index = nearest();
    const widthRef = (cards[0]?.offsetWidth || 300) + 14;
    const motionOff = !motionEnabled();
    const tiltMax = track.clientWidth < 720 ? -20 : -30;
    if (!motionOff) {
      const middle = track.scrollLeft + track.clientWidth / 2;
      cards.forEach((card, i) => {
        const cardMiddle = card.offsetLeft + card.offsetWidth / 2;
        const d = Math.max(-1.6, Math.min(1.6, (cardMiddle - middle) / widthRef));
        const a = Math.abs(d);
        card.style.setProperty('--rz', (tiltMax * d).toFixed(2) + 'deg');
        card.style.setProperty('--tz', (-96 * Math.min(a, 1.4)).toFixed(1) + 'px');
        card.style.setProperty('--ty', (i === index ? -6 : 0) + 'px');
        card.style.setProperty('--sc', (1 - Math.min(a * 0.1, 0.18)).toFixed(3));
        card.style.setProperty('--dim', (1 - Math.min(a * 0.3, 0.55)).toFixed(3));
        card.style.zIndex = String(40 - Math.round(a * 10));
      });
    } else {
      cards.forEach((card) => {
        DEPTH_VARS.forEach((name) => card.style.removeProperty(name));
        card.style.zIndex = '';
      });
    }
    if (index === active && cards[index]?.classList.contains('is-focus')) return;
    active = index;
    cards.forEach((card, i) => card.classList.toggle('is-focus', i === index));
    dots.forEach((dot, i) => {
      dot.classList.toggle('is-active', i === index);
      dot.setAttribute('aria-selected', String(i === index));
    });
    const prev = $('#carousel-prev'),
      next = $('#carousel-next');
    prev?.setAttribute('aria-disabled', String(index === 0));
    next?.setAttribute('aria-disabled', String(index === cards.length - 1));
  }
  function schedule() {
    if (!frame) frame = requestAnimationFrame(paint);
  }
  track.addEventListener('scroll', schedule, { passive: true });
  track.addEventListener(
    'wheel',
    (event) => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      event.preventDefault();
      track.scrollLeft += event.deltaY;
    },
    { passive: false },
  );
  track.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      center(nearest() + 1);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      center(nearest() - 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      center(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      center(cards.length - 1);
    }
  });
  $('#carousel-prev')?.addEventListener('click', () => center(nearest() - 1));
  $('#carousel-next')?.addEventListener('click', () => center(nearest() + 1));
  new ResizeObserver(() => schedule()).observe(track);
  new MutationObserver(() => schedule()).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-motion'],
  });

  // First paint: centre the opening card without a long animated slide.
  requestAnimationFrame(() => {
    center(0, true);
    paint();
  });

  let tourTimer = 0;
  function cancelTour() {
    clearTimeout(tourTimer);
    tourTimer = 0;
  }
  track.addEventListener('pointerdown', cancelTour, { passive: true });
  track.addEventListener('wheel', cancelTour, { passive: true });
  /* Hero ride: sweep through the collection, then glide back to the start. */
  function tour() {
    cancelTour();
    const start = nearest();
    const route = [];
    for (let i = start + 1; i < cards.length; i++) route.push(i);
    for (let i = 0; i <= start; i++) route.push(i);
    if (!motionEnabled() || route.length < 2) {
      center(start);
      return;
    }
    route.forEach((index, step) => {
      tourTimer = setTimeout(() => {
        center(index);
        if (step === route.length - 1) tourTimer = 0;
      }, 480 + step * 460);
    });
  }
  return {
    scrollToGame(game) {
      cancelTour();
      const index = names.indexOf(game);
      if (index >= 0) center(index);
    },
    sync: paint,
    tour,
  };
}
