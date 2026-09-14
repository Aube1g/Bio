import { bindPressRepeat } from '../shared/press-repeat.js';
import { LaunchQueue } from './launch-queue.js';
import { GameFeedback } from './feedback.js';
import { BlackjackRenderer } from './blackjack-renderer.js';
import { finishBoot } from '../shared/boot-screen.js';
import { initializeTextMotion } from '../shared/text-motion.js';
import { initializeMotionPicker } from '../shared/motion-picker.js';
import { ExpandingIsland } from '../shared/island.js';
import { initializeSwitches } from '../shared/controls.js';
import { $, $$, icon, escapeHTML, uuid, clamp } from '../shared/dom.js';
import {
  preferences,
  applyPreferences,
  motionEnabled,
  installPreferenceListeners,
  safeStorage,
  savePreferences,
} from '../shared/preferences.js';
import { transitionSurface, MorphDialogs, springGroups, kineticControls } from '../shared/motion.js';
import { diceOdds, plinkoTable, MIN_BET, MAX_BET } from '../shared/game-rules.js';
import { t, money, signedMoney, translatePage } from './strings.js';
import { GameApi, RequestError } from './api.js';
import { GameSound } from './sound.js';
import {
  DiceRenderer,
  SlotsRenderer,
  PlinkoRenderer,
  cardHTML,
  cubeHTML,
  renderCardHand,
} from './renderers.js';
import { PortalDialogs } from './dialogs.js';
import { bindSettings, renderSettings } from './settings.js';

const games = {
  blackjack: {
    title: 'Blackjack',
    code: '01 / THE TABLE',
    description: 'blackjackCard',
    play: 'deal',
    icon: 'spade',
  },
  slots: { title: 'Slots', code: '02 / THE SPIN', description: 'slotsCard', play: 'spinReels', icon: 'slot' },
  dice: { title: 'Dice', code: '03 / THE ROLL', description: 'diceCard', play: 'rollDice', icon: 'dice' },
  plinko: {
    title: 'Plinko',
    code: '04 / THE DROP',
    description: 'plinkoCard',
    play: 'dropBall',
    icon: 'plinko',
  },
};
const emptyStats = () => ({ rounds: 0, wins: 0, losses: 0, netMinor: 0, winRate: 0 });
const state = {
  user: null,
  wallet: { balanceMinor: 0, revision: -1 },
  fairness: null,
  stats: emptyStats(),
  activeBlackjack: null,
  game: 'lobby',
  selectedGame: null,
  batchCount: 1,
  batchRunning: false,
  batchRemaining: 0,
  batchReceipts: new Map(),
  betMinor: 1000,
  plinko: { rows: 12, risk: 'medium' },
  dice: { mode: 'under', target: 4 },
  networkBusy: false,
  authBusy: false,
  uncertain: false,
  busy: { blackjack: false, slots: false, dice: false, plinko: 0 },
  pendingCredits: new Map(),
  rounds: new Map(),
  lastRound: null,
  connected: false,
  config: null,
  clientSeed: safeStorage.get('games.clientSeed') || uuid(),
};
safeStorage.set('games.clientSeed', state.clientSeed);
let favorites;
try {
  favorites = new Set(JSON.parse(safeStorage.get('games.favorites') || '[]'));
} catch {
  favorites = new Set();
}
const api = new GameApi(),
  sound = new GameSound(),
  morph = new MorphDialogs();
const dice = new DiceRenderer($('#dice-cube')),
  slots = new SlotsRenderer($('#slot-reels'), (index) => sound.play('reelStop', index));
const plinko = new PlinkoRenderer($('#plinko-canvas'), $('#plinko-bins'), (row) =>
  sound.play('plinkoPeg', row),
);
const blackjack = new BlackjackRenderer($('#board-blackjack'), sound);
const feedback = new GameFeedback($('#game-scene'));
const launchQueue = new LaunchQueue((queue) => {
  state.batchRunning = queue.running;
  state.batchRemaining = queue.remaining;
  renderControls();
  finishBatchFeedback();
});
const syncIndicators = springGroups();
let toastTimer;
let islandNotifyReset = null;
let actionEpoch = 0;
const gameIsland = new ExpandingIsland($('#game-island'), $('#island-trigger'), $('#island-panel'));
const shownRounds = new Set();

/* Dynamic-island notification: the balance pill collapses into the bare Viola
   circle, grows back showing the message, then returns to the balance. */
function islandNotify(message) {
  const island = $('#game-island');
  const strong = $('#island-value');
  const small = $('#island-subtitle');
  clearTimeout(toastTimer);
  islandNotifyReset?.();
  if (!island || !strong) return;
  const prevStrong = strong.textContent;
  const prevSmall = small.textContent;
  let settled = false;
  const restore = () => {
    if (settled) return;
    settled = true;
    delete island.dataset.notifying;
    strong.textContent = prevStrong;
    small.textContent = prevSmall;
    islandNotifyReset = null;
  };
  islandNotifyReset = restore;
  const collapse = () => (island.dataset.notifying = 'true');
  const expand = () => delete island.dataset.notifying;
  strong.textContent = message;
  small.textContent = '';
  collapse();
  toastTimer = setTimeout(expand, 340);
  toastTimer = setTimeout(() => {
    collapse();
    toastTimer = setTimeout(restore, 320);
  }, 2600);
}

/* Fallback toast used when the island panel is open and must not be disturbed. */
function toastNotify(message) {
  const toast = $('#portal-toast');
  $('#toast-msg').textContent = message;
  clearTimeout(toastTimer);
  toast.classList.add('visible');
  if (motionEnabled()) {
    toast.getAnimations().forEach((animation) => animation.cancel());
    toast.animate(
      [
        { opacity: 0, transform: 'translateX(-50%) scale(0.4) translateY(-12px)', borderRadius: '999px' },
        { opacity: 1, transform: 'translateX(-50%) scale(1.05) translateY(0)', borderRadius: '20px', offset: 0.6 },
        { opacity: 1, transform: 'translateX(-50%) scale(1) translateY(0)', borderRadius: '999px' },
      ],
      { duration: 640, easing: 'cubic-bezier(0.22, 1.24, 0.36, 1)' },
    );
  }
  toastTimer = setTimeout(() => {
    if (!toast.classList.contains('visible')) return;
    if (motionEnabled()) {
      const hide = toast.animate(
        [
          { opacity: 1, transform: 'translateX(-50%) scale(1)', borderRadius: '999px' },
          { opacity: 0, transform: 'translateX(-50%) scale(0.45) translateY(-12px)', borderRadius: '999px' },
        ],
        { duration: 380, easing: 'cubic-bezier(0.4, 0, 0.7, 0.4)' },
      );
      hide.finished.then(() => toast.classList.remove('visible')).catch(() => {});
    } else {
      toast.classList.remove('visible');
    }
  }, 3400);
}

function notify(message) {
  const island = $('#game-island');
  if (island?.dataset.open === 'true') {
    toastNotify(message);
    return;
  }
  islandNotify(message);
}
function displayedBalance() {
  return Math.max(
    0,
    state.wallet.balanceMinor - [...state.pendingCredits.values()].reduce((sum, value) => sum + value, 0),
  );
}
function remember(round) {
  if (!round) return;
  const previous = state.rounds.get(round.id);
  if (!previous || previous.version <= round.version) state.rounds.set(round.id, round);
}
function ingest(data) {
  if (data.wallet && data.wallet.revision >= state.wallet.revision) {
    state.wallet = data.wallet;
    if (data.stats) state.stats = data.stats;
  }
  if (data.fairness && (!state.fairness || data.fairness.nonce >= state.fairness.nonce))
    state.fairness = data.fairness;
  remember(data.round);
  if (data.activeBlackjack) {
    remember(data.activeBlackjack);
    const known = state.rounds.get(data.activeBlackjack.id);
    if (known.status === 'active') state.activeBlackjack = known;
  }
  if (
    data.round?.game === 'blackjack' &&
    data.round.status === 'settled' &&
    state.activeBlackjack?.id === data.round.id
  )
    state.activeBlackjack = null;
  state.connected = true;
  renderAll();
}
function setSession(data) {
  const changed = state.user?.id !== data.user?.id;
  if (changed) {
    state.rounds.clear();
    state.pendingCredits.clear();
    state.lastRound = null;
    state.wallet = { balanceMinor: 0, revision: -1 };
    state.stats = emptyStats();
    state.fairness = null;
    state.activeBlackjack = null;
  }
  state.user = data.user || null;
  state.uncertain = Boolean(data.user && api.pending());
  if (data.user) {
    for (const round of data.history || []) remember(round);
    if (data.wallet.revision >= state.wallet.revision) {
      state.wallet = data.wallet;
      state.stats = data.stats;
    }
    if (!state.fairness || data.fairness.nonce >= state.fairness.nonce) state.fairness = data.fairness;
    if (data.activeBlackjack) {
      remember(data.activeBlackjack);
      const known = state.rounds.get(data.activeBlackjack.id);
      if (known.status === 'active') state.activeBlackjack = known;
    } else if (state.activeBlackjack && state.rounds.get(state.activeBlackjack.id)?.status === 'settled')
      state.activeBlackjack = null;
  }
  state.connected = true;
  updateGame();
  renderAll();
}
function errorMessage(error) {
  const keys = {
    login_required: 'loginNeeded',
    insufficient_balance: 'insufficient',
    invalid_bet: 'invalidBet',
    connection_lost: 'connectionLost',
    service_unavailable: 'serviceUnavailable',
    telegram_unavailable: 'telegramUnavailable',
    session_unavailable: 'sessionUnavailable',
    stale_commit: 'staleState',
    round_changed: 'staleState',
    invalid_csrf: 'staleState',
  };
  if (keys[error.code]) return t(keys[error.code]);
  return preferences.lang === 'ru' && error.message ? error.message : t('genericError');
}
function onError(error) {
  if (['connection_lost', 'service_unavailable'].includes(error.code) || error.status >= 500) {
    state.connected = false;
    state.uncertain = Boolean(api.pending());
    $('#connection-banner').hidden = false;
    $('#connection-message').textContent = errorMessage(error);
  } else if (error.status === 401) {
    state.user = null;
    dialogs.open('auth-dialog', $('#account-button'));
  } else if (['stale_commit', 'round_changed', 'invalid_csrf'].includes(error.code)) {
    synchronize(false).catch(() => {});
  }
  notify(errorMessage(error));
  renderControls();
  renderChrome();
}
function finishVisuals() {
  launchQueue.cancel();
  feedback.clear();
  blackjack.finish?.();
  dice.finish?.();
  slots.finish?.();
  plinko.finishAll();
}
const dialogs = new PortalDialogs({
  morph,
  api,
  state: () => state,
  notify,
  sound,
  onError,
  onData: ingest,
  onSession: setSession,
  finishVisuals,
  onNavigate: requestGame,
  onServerLogin: openServerLogin,
});

function updateFavorites() {
  $$('[data-favorite]').forEach((button) => {
    button.setAttribute('aria-pressed', String(favorites.has(button.dataset.favorite)));
    button.setAttribute(
      'aria-label',
      `${games[button.dataset.favorite].title} · ${preferences.lang === 'en' ? 'Favorite' : 'Избранное'}`,
    );
  });
}
function renderChrome() {
  if (state.user && $('#account-dialog').open) dialogs.account();
  $('#scene-sound').setAttribute('aria-pressed', String(preferences.sound));
  $('#scene-sound').setAttribute('aria-label', t('sound'));
  $('#scene-sound use').setAttribute('href', preferences.sound ? '#i-volume' : '#i-volume-off');
  $('#account-label').textContent = state.user
    ? state.user.kind === 'guest'
      ? t('guest')
      : state.user.name
    : t('signIn');
  $('#island-value').textContent = state.user
    ? money(displayedBalance())
    : preferences.lang === 'en'
      ? 'Your game account'
      : 'Твой игровой счёт';
  $('#island-subtitle').textContent = t(api.isPractice ? 'localPractice' : 'practice');
  document.documentElement.dataset.playMode = api.mode;
  $('#server-login-action').hidden = !api.isPractice;
  $('#practice-mode-badge').hidden = !api.isPractice;
  $('#island-rounds').textContent = state.stats.rounds;
  $('#island-wins').textContent = state.stats.wins;
  $('#island-net').textContent = signedMoney(state.stats.netMinor);
  $('#island-session-type').textContent = state.user
    ? t(state.user.kind === 'guest' ? 'guest' : 'telegramAccount')
    : '—';
  $('#connection-dot').classList.toggle('offline', !state.connected);
  $('#island-activity').textContent = state.activeBlackjack
    ? t('resumeHand')
    : state.lastRound
      ? `${games[state.lastRound.game].title} · ${signedMoney(state.lastRound.netMinor)}`
      : t('firstRound');
  $('#session-summary').textContent = state.stats.rounds
    ? t('sessionSummary', {
        rounds: state.stats.rounds,
        wins: state.stats.wins,
        net: signedMoney(state.stats.netMinor),
      })
    : t('firstRound');
  $('#resume-round').hidden = !state.activeBlackjack;
  $('#available-balance').textContent = state.user ? money(displayedBalance()) : '—';
  $('#account-button').setAttribute('aria-label', state.user ? t('profile') : t('signIn'));
  updateFavorites();
}
function setPressed(button, value) {
  const next = String(value);
  if (button.getAttribute('aria-pressed') !== next) button.setAttribute('aria-pressed', next);
}
function renderControls() {
  document.documentElement.dataset.gameBusy = String(
    state.networkBusy || state.batchRunning || Object.values(state.busy).some(Boolean),
  );
  if (state.game === 'lobby') return;
  const game = state.game,
    locked = Boolean(
      state.networkBusy ||
        state.batchRunning ||
        state.uncertain ||
        (game === 'plinko' ? state.busy.plinko : state.busy[game]) ||
        (game === 'blackjack' && state.activeBlackjack),
    );
  $('#bet-amount').value = state.betMinor / 100;
  $('#bet-amount').disabled = locked;
  $$('[data-bet-step],[data-bet-factor]').forEach((button) => (button.disabled = locked));
  $$('[data-risk],[data-rows]').forEach((button) => {
    button.disabled = Boolean(
      state.busy.plinko || state.batchRunning || state.networkBusy || state.uncertain,
    );
    const selected = button.dataset.risk
      ? button.dataset.risk === state.plinko.risk
      : Number(button.dataset.rows) === state.plinko.rows;
    setPressed(button, selected);
  });
  $$('[data-dice-mode]').forEach((button) => {
    button.disabled = state.busy.dice || state.networkBusy || state.uncertain;
    setPressed(button, button.dataset.diceMode === state.dice.mode);
  });
  const slider = $('#dice-target');
  slider.min = state.dice.mode === 'under' ? 2 : 1;
  slider.max = state.dice.mode === 'under' ? 6 : 5;
  slider.value = state.dice.target;
  slider.disabled = state.busy.dice || state.networkBusy || state.uncertain;
  slider.style.setProperty(
    '--fill',
    ((state.dice.target - Number(slider.min)) / (Number(slider.max) - Number(slider.min))) * 100 + '%',
  );
  $('#dice-target-value').textContent = state.dice.target;
  const odds = diceOdds(state.dice.mode, state.dice.target);
  $('#dice-chance').textContent = (odds.chance * 100).toFixed(odds.successfulFaces === 3 ? 0 : 2) + '%';
  $('#dice-multiplier').textContent = Number(odds.multiplier.toFixed(3)) + '×';
  $('#dice-possible').innerHTML = Array.from(
    { length: 6 },
    (_, i) =>
      `<span class="possible-face ${(state.dice.mode === 'under' ? i + 1 < state.dice.target : i + 1 > state.dice.target) ? 'is-win' : ''}">${i + 1}</span>`,
  ).join('');
  $$('[data-batch]').forEach((button) => {
    button.disabled = Boolean(
      state.networkBusy || state.batchRunning || state.busy.plinko || state.uncertain,
    );
    setPressed(button, Number(button.dataset.batch) === state.batchCount);
  });
  $('#batch-cost').textContent = money(state.betMinor * state.batchCount);
  $('#plinko-max').textContent = money(
    Math.floor(state.betMinor * state.batchCount * plinkoTable(state.plinko.rows, state.plinko.risk)[0]),
  );
  $('#play-label').textContent = state.networkBusy
    ? t(api.isPractice ? 'calculating' : 'waitingServer')
    : !state.user
      ? t('startPractice')
      : game === 'plinko' && state.batchCount > 1
        ? t('dropBatch', { count: state.batchCount })
        : t(games[game].play);
  $('#play-button').dataset.busy = String(state.networkBusy);
  $('.play-button-icon use').setAttribute('href', '#i-' + (state.networkBusy ? 'replay' : games[game].icon));
  $('#play-button').hidden = game === 'blackjack' && Boolean(state.activeBlackjack);
  $('#play-button').disabled = Boolean(
    state.networkBusy ||
      state.uncertain ||
      (game === 'plinko'
        ? state.batchRunning ||
          (state.batchCount > 1 && state.busy.plinko > 0) ||
          state.busy.plinko + state.batchCount > 8
        : state.busy[game]) ||
      (state.user && displayedBalance() < state.betMinor * (game === 'plinko' ? state.batchCount : 1)),
  );
  $('#blackjack-actions').hidden = !state.activeBlackjack;
  $$('[data-bj-action]').forEach(
    (button) =>
      (button.disabled = Boolean(
        state.networkBusy ||
          state.uncertain ||
          !state.activeBlackjack ||
          state.busy.blackjack ||
          (button.dataset.bjAction === 'double' &&
            (!state.activeBlackjack?.outcome.canDouble ||
              displayedBalance() < state.activeBlackjack.betMinor)),
      )),
  );
  $('#round-queue').hidden = !state.busy.plinko && !state.batchRunning;
  $('#round-queue-label').textContent =
    t('activeBalls', { count: state.busy.plinko }) +
    (state.batchRemaining ? ' · ' + t('ballsQueued', { count: state.batchRemaining }) : '');
  const active = game === 'blackjack' ? Boolean(state.activeBlackjack) : Boolean(state.busy[game]);
  $('#scene-status-text').textContent = state.networkBusy
    ? t(api.isPractice ? 'calculating' : 'waitingServer')
    : active
      ? t(game === 'blackjack' ? 'handActive' : 'playing')
      : t('ready');
  $('#scene-badge').textContent =
    game === 'plinko'
      ? `${state.plinko.rows} ROWS / ${state.plinko.risk.toUpperCase()}`
      : game === 'blackjack'
        ? 'S17 · 3:2'
        : game === 'dice'
          ? '6 SIDES'
          : '3 REELS';
}
function renderHand(round = state.activeBlackjack) {
  if (!state.busy.blackjack) blackjack.restore(round);
}
let recentKey = '';
function renderRecent() {
  if (state.game === 'lobby') return;
  const rounds = [...state.rounds.values()]
    .filter(
      (round) =>
        round.game === state.game && round.status === 'settled' && !state.pendingCredits.has(round.id),
    )
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 8);
  const key =
    state.game +
    ':' +
    preferences.lang +
    ':' +
    rounds.map((round) => round.id + ':' + round.version).join(',');
  if (key === recentKey) return;
  recentKey = key;
  $('#recent-rounds-list').innerHTML = rounds.length
    ? rounds
        .map(
          (round) =>
            `<button type="button" class="recent-result ${round.netMinor > 0 ? 'win' : 'loss'}" data-round-id="${round.id}" aria-label="${t('checkRound')} ${signedMoney(round.netMinor)}">${round.game === 'plinko' ? Number(round.outcome.multiplier.toFixed(2)) + '×' : signedMoney(round.netMinor)}</button>`,
        )
        .join('')
    : `<span class="muted">${t('noRounds')}</span>`;
}
function resultDetail(round) {
  const outcome = round.outcome;
  if (round.game === 'dice')
    return t('diceDetail', {
      face: outcome.face,
      mode: t(outcome.mode).toLowerCase(),
      target: outcome.target,
    });
  if (round.game === 'plinko')
    return t('plinkoDetail', { slot: outcome.slot + 1, multiplier: outcome.multiplier.toFixed(2) });
  if (round.game === 'slots')
    return t('slotsDetail', { combination: t(outcome.combination), multiplier: outcome.multiplier });
  return t(outcome.reason || 'handActive');
}
function showResult(round) {
  state.lastRound = round;
  if (state.game === round.game) {
    const type = round.netMinor > 0 ? 'win' : round.netMinor === 0 ? 'push' : 'loss';
    $('#result-strip').dataset.result = type;
    $('#result-amount').hidden = false;
    $('#result-net').textContent = signedMoney(round.netMinor);
    $('.result-icon use').setAttribute(
      'href',
      '#i-' + (type === 'win' ? 'check' : type === 'push' ? 'equal' : 'close'),
    );
    $('#result-title').textContent = t(
      type === 'win' ? 'winTitle' : type === 'push' ? 'pushTitle' : 'lossTitle',
    );
    $('#result-detail').textContent = t('returnDetail', {
      detail: resultDetail(round),
      payout: money(round.payoutMinor),
    });
    $('#result-proof').hidden = false;
    if (round.game === 'dice') {
      $('#dice-value').textContent = round.outcome.face;
      $('#dice-relation').textContent = `${t(round.outcome.mode)} ${round.outcome.target}`;
    }
    if (round.game === 'blackjack') renderHand(round);
  }
  if (motionEnabled())
    $('#game-island').animate([{ scale: 1 }, { scale: 1.035, offset: 0.45 }, { scale: 1 }], {
      duration: 530,
      easing: 'cubic-bezier(.34,1.56,.64,1)',
    });
  const batch = state.batchReceipts.has(round.id);
  if (!batch && state.game === round.game && !document.hidden) {
    const type = round.netMinor > 0 ? 'win' : round.netMinor === 0 ? 'push' : 'loss';
    feedback.show({
      type,
      title:
        round.outcome.reason === 'blackjack'
          ? 'BLACKJACK'
          : t(type === 'win' ? 'winTitle' : type === 'push' ? 'pushTitle' : 'lossTitle'),
      value: signedMoney(round.netMinor),
      game: games[round.game].title,
    });
    sound.play(round.outcome.reason === 'blackjack' ? 'blackjack' : type);
  }
  finishBatchFeedback();
  renderChrome();
  renderRecent();
}
function renderAll() {
  renderChrome();
  renderControls();
  renderRecent();
}
function resetResult() {
  feedback.clear();
  $('#result-amount').hidden = true;
  delete $('#result-strip').dataset.result;
  $('#result-title').textContent = t('makeYourMove');
  $('#result-detail').textContent = t('chooseBet');
  $('#result-proof').hidden = true;
}
function updateGame() {
  if (state.game === 'lobby') return;
  const game = games[state.game];
  $('#active-game-title').textContent = game.title;
  $('#active-game-glyph').setAttribute('href', '#i-' + game.icon);
  $('#active-game-code').textContent = game.code;
  $('#active-game-description').textContent = t(game.description);
  for (const key of Object.keys(games)) {
    $('#board-' + key).hidden = key !== state.game;
    $('#' + key + '-options').hidden = key !== state.game;
  }
  if (state.game === 'blackjack') {
    renderHand(
      state.activeBlackjack ||
        [...state.rounds.values()]
          .filter((round) => round.game === 'blackjack')
          .sort((a, b) => b.createdAt - a.createdAt)[0],
    );
    if (state.activeBlackjack) {
      $('#result-title').textContent = t('handActive');
      $('#result-detail').textContent = t('waitingForMove');
    }
  }
  plinko.resize();
  renderAll();
}
async function requestGame(game, source = null) {
  if (game === 'lobby' || !games[game]) {
    navigate('lobby', source);
    return;
  }
  if (state.networkBusy || state.authBusy || state.uncertain) return;
  if (source?.closest?.('[data-go],.game-card-main')) {
    // Card or dock tap: select first, then the dock tray offers a pretty Play.
    selectGame(game, source);
    return;
  }
  if (state.game === game) return;
  // Quick start (profile quick games, keyboard, deep links): launch right away.
  sound.play('select');
  if (!state.user) {
    await startPractice(null);
    if (!state.user) return;
  }
  sound.play('launch');
  navigate(game, source);
}
function selectGame(game, source) {
  if (game === 'lobby' || !games[game]) return;
  state.selectedGame = game;
  sound.play('flip');
  $$('.game-card-main').forEach((card) => {
    const on = card.dataset.go === game;
    card.setAttribute('aria-pressed', String(on));
    card.closest('.game-card')?.classList.toggle('is-selected', on);
  });
  const tray = $('#dock-launch'),
    symbol = $('.launch-symbol use', tray);
  tray.dataset.game = game;
  $('#dock-launch-title').textContent = games[game].title;
  if (symbol) symbol.setAttribute('href', '#i-' + games[game].icon);
  tray.hidden = false;
  try {
    sound.unlock();
    sound.play('glide');
  } catch {
    /* Sound is optional. */
  }
  if (motionEnabled()) {
    tray.getAnimations().forEach((animation) => animation.cancel());
    // Fly up from behind the dock: rise fast, overshoot above, swing, then settle.
    tray.animate(
      [
        { opacity: 0, transform: 'translate(-50%, 130%) scale(0.5) rotate(-5deg)' },
        { opacity: 1, transform: 'translate(-50%, -14px) scale(1.05) rotate(1.2deg)', offset: 0.68 },
        { opacity: 1, transform: 'translate(-50%, 2px) scale(0.99) rotate(-0.4deg)', offset: 0.86 },
        { opacity: 1, transform: 'translate(-50%, 0) scale(1) rotate(0deg)' },
      ],
      { duration: 720, easing: 'cubic-bezier(0.18, 0.9, 0.32, 1.18)' },
    );
    tray.animate(
      [
        { boxShadow: '0 0 0 0 color-mix(in srgb, var(--tray-accent, var(--lime)) 0%, transparent)' },
        { boxShadow: '0 0 0 14px color-mix(in srgb, var(--tray-accent, var(--lime)) 26%, transparent)', offset: 0.5 },
        { boxShadow: '0 24px 60px #0006, 0 0 0 4px color-mix(in srgb, var(--tray-accent, var(--lime)) 10%, transparent)' },
      ],
      { duration: 900, easing: 'ease-out' },
    );
  }
}
function hideDockLaunch() {
  state.selectedGame = null;
  $('#dock-launch').hidden = true;
  $$('.game-card-main').forEach((card) => {
    card.removeAttribute('aria-pressed');
    card.closest('.game-card')?.classList.remove('is-selected');
  });
}
async function launchSelected() {
  const game = state.selectedGame;
  if (!game || game === 'lobby' || state.networkBusy || state.authBusy || state.uncertain) return;
  sound.play('launch');
  if (!state.user) {
    await startPractice(null);
    if (!state.user) return;
  }
  hideDockLaunch();
  navigate(game);
}
function navigate(game, source = null, push = true, animate = true) {
  if (game !== 'lobby' && !games[game]) game = 'lobby';
  if (game === state.game && document.documentElement.dataset.ready) return;
  hideDockLaunch();
  if (animate) sound.play('whoosh');
  finishVisuals();
  toggleIsland(false);
  const order = ['lobby', 'blackjack', 'slots', 'dice', 'plinko'];
  $('#portal-stage').dataset.direction = String(
    Math.sign(order.indexOf(game) - order.indexOf(state.game)) || 1,
  );
  state.game = game;

  document.documentElement.dataset.game = game;
  safeStorage.set('games.lastGame', game);
  const change = () => {
    $('#view-lobby').hidden = game !== 'lobby';
    $('#view-game').hidden = game === 'lobby';
    resetResult();
    updateGame();
  };
  if (animate) transitionSurface($('#portal-stage'), change, source);
  else change();
  $$('.dock-games a').forEach((link) => {
    if (link.dataset.go === game) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  if (push && location.hash !== '#' + game) {
    try {
      history.pushState(null, '', '#' + game);
    } catch {
      /* Sandboxed file viewers still navigate locally. */
    }
  }
  scrollTo({ top: 0, behavior: 'instant' });
  requestAnimationFrame(() => {
    plinko.resize();
    syncIndicators();
  });
  const heading = game === 'lobby' ? $('#lobby-title') : $('#active-game-title');
  heading.tabIndex = -1;
  heading.focus({ preventScroll: true });
}
function setBet(value) {
  if (
    state.networkBusy ||
    state.batchRunning ||
    state.uncertain ||
    (state.game === 'plinko' ? state.busy.plinko : state.busy[state.game]) ||
    (state.game === 'blackjack' && state.activeBlackjack)
  )
    return;
  const number = Number(value);
  if (!Number.isFinite(number)) return;
  const next = clamp(Math.round(number) * 100, MIN_BET, MAX_BET);
  if (next === state.betMinor) return false;
  state.betMinor = next;
  renderControls();
  return true;
}
async function animateRound(round, action = 'deal') {
  const owner = state.user?.id;
  if (shownRounds.has(round.id)) return;
  shownRounds.add(round.id);
  if (state.game !== round.game || document.hidden) {
    state.pendingCredits.delete(round.id);
    showResult(round);
    return;
  }
  const progress = { plinko: 'falling', dice: 'rolling', slots: 'spinning' }[round.game];
  if (progress) {
    $('#result-title').textContent = t(progress);
    $('#result-detail').textContent = `${t('bet')}: ${money(round.betMinor)}`;
  }
  if (round.game === 'plinko') {
    state.busy.plinko++;
    renderControls();
    await plinko.drop(round);
    state.busy.plinko--;
  } else if (round.game === 'dice') {
    state.busy.dice = true;
    renderControls();
    await dice.land(round.outcome.face);
    sound.play('diceLand');
    state.busy.dice = false;
  } else if (round.game === 'slots') {
    state.busy.slots = true;
    renderControls();
    await slots.spin(round.outcome.symbols);
    state.busy.slots = false;
  }
  if (round.game === 'blackjack') {
    state.busy.blackjack = true;
    renderControls();
    await blackjack.play(round, action);
    state.busy.blackjack = false;
  }
  state.pendingCredits.delete(round.id);
  if (state.user?.id !== owner) {
    renderControls();
    return;
  }
  if (round.status === 'settled') showResult(round);
  else {
    $('#result-title').textContent = t('yourTurn');
    $('#result-detail').textContent = t('waitingForMove');
  }
  renderControls();
}
function finishBatchFeedback() {
  if (state.batchRunning || state.busy.plinko || !state.batchReceipts.size) return;
  const rounds = [...state.batchReceipts.values()];
  state.batchReceipts.clear();
  if (state.game !== 'plinko' || document.hidden) return;
  const net = rounds.reduce((sum, round) => sum + round.netMinor, 0);
  const paid = rounds.reduce((sum, round) => sum + round.payoutMinor, 0);
  const type = net > 0 ? 'win' : net === 0 ? 'push' : 'loss';
  const title = t('batchFinished', { count: rounds.length });
  $('#result-strip').dataset.result = type;
  $('#result-title').textContent = title;
  $('#result-detail').textContent = t('batchReturn', { value: money(paid) });
  $('#result-amount').hidden = false;
  $('#result-net').textContent = signedMoney(net);
  feedback.show({ type, title, value: signedMoney(net), game: 'Plinko' });
  sound.play(type);
}
async function play() {
  const game = state.game;
  if (
    !games[game] ||
    state.networkBusy ||
    state.uncertain ||
    state.batchRunning ||
    (state.busy[game] && game !== 'plinko')
  )
    return;
  if (!state.user) {
    await startPractice(null);
    return;
  }
  const count = game === 'plinko' ? state.batchCount : 1;
  if (game === 'plinko' && (state.busy.plinko + count > 8 || (count > 1 && state.busy.plinko > 0))) return;
  if (displayedBalance() < state.betMinor * count) {
    notify(t('insufficient'));
    return;
  }
  if (count === 1) {
    await submitRound(game);
    return;
  }
  state.batchReceipts.clear();
  resetResult();
  await launchQueue.run(count, () => submitRound('plinko', true), { spacing: motionEnabled() ? 170 : 0 });
}
async function submitRound(game, batch = false) {
  if (!games[game] || state.networkBusy || state.uncertain) return;
  if (!state.user) return false;
  if (game === 'plinko' ? state.busy.plinko >= 8 : state.busy[game]) return;
  const entered = Number($('#bet-amount').value);
  if (!Number.isInteger(entered) || entered * 100 < MIN_BET || entered * 100 > MAX_BET) {
    notify(t('invalidBet'));
    return;
  }
  state.betMinor = entered * 100;
  if (state.betMinor > displayedBalance()) {
    notify(t('insufficient'));
    return;
  }
  if (!batch) {
    state.batchReceipts.clear();
    resetResult();
  }
  state.networkBusy = true;
  actionEpoch++;
  sound.unlock();
  sound.play({ dice: 'diceRoll', slots: 'reelSpin', plinko: 'plinkoDrop', blackjack: 'launch' }[game]);
  renderControls();
  $('#result-title').textContent = t(api.isPractice ? 'calculating' : 'waitingServer');
  $('#result-detail').textContent = '';
  $('#result-proof').hidden = true;
  const parameters = game === 'plinko' ? { ...state.plinko } : game === 'dice' ? { ...state.dice } : {};
  const request = {
    actionId: uuid(),
    betMinor: state.betMinor,
    parameters,
    clientSeed: state.clientSeed,
    commit: state.fairness.nextHash,
    nonce: state.fairness.nonce,
  };
  try {
    const data = await api.mutate('/api/games/' + game, request);
    if (data.round.status === 'settled') state.pendingCredits.set(data.round.id, data.round.payoutMinor);
    ingest(data);
    state.networkBusy = false;
    if (batch) state.batchReceipts.set(data.round.id, data.round);
    animateRound(data.round).catch(onError);
    renderControls();
    return true;
  } catch (error) {
    state.networkBusy = false;
    onError(error);
    return false;
  }
}
async function blackjackAction(action) {
  const round = state.activeBlackjack;
  if (!round || state.networkBusy || state.busy.blackjack || state.uncertain) return;
  state.networkBusy = true;
  actionEpoch++;
  renderControls();
  sound.unlock();
  sound.play(action);
  feedback.clear();
  try {
    const data = await api.mutate(`/api/blackjack/${round.id}/action`, {
      actionId: uuid(),
      action,
      version: round.version,
    });
    if (data.round.status === 'settled') state.pendingCredits.set(data.round.id, data.round.payoutMinor);
    ingest(data);
    state.networkBusy = false;
    // An action updates the same round; replay this new visual version once.
    shownRounds.delete(data.round.id);
    await animateRound(data.round, action);
    renderAll();
  } catch (error) {
    state.networkBusy = false;
    onError(error);
  }
}
function toggleIsland(open) {
  gameIsland.toggle(open);
}
async function synchronize(recover = true) {
  if (state.networkBusy) return;
  const epoch = actionEpoch;
  const generation = api.generation;
  const [config, session] = await Promise.all([api.call('/api/config'), api.call('/api/session')]).catch(
    (error) => {
      if (generation !== api.generation) return [null, null];
      throw error;
    },
  );
  if (generation !== api.generation || epoch !== actionEpoch) return;
  state.config = config;
  setSession(session);
  if (recover && session.user && api.pending()) {
    state.uncertain = true;
    notify(t('pendingRound'));
    const result = await api.recover();
    if (result) {
      ingest(result);
      if (result.round) {
        remember(result.round);
        state.lastRound = result.round;
        if (result.round.status === 'settled') {
          if (state.game === 'plinko' && result.round.game === 'plinko') {
            state.plinko = { rows: result.round.outcome.rows, risk: result.round.outcome.risk };
            plinko.configure(state.plinko.rows, state.plinko.risk);
          }
          await animateRound(result.round);
        }
        notify(t('savedRound'));
      }
    }
  }
  state.uncertain = Boolean(api.pending());
  state.connected = true;
  $('#connection-banner').hidden = !state.uncertain;
  if (state.uncertain) $('#connection-message').textContent = t('pendingRound');
  renderAll();
}
function setAuthBusy(busy) {
  state.authBusy = busy;
  for (const id of ['guest-login', 'telegram-login']) $('#' + id).disabled = busy;
  $('#practice-login').disabled = state.networkBusy || state.uncertain;
  $('#guest-login').dataset.busy = String(busy);
  $('#auth-dialog').setAttribute('aria-busy', String(busy));
}
async function startPractice(target = null) {
  if ((state.authBusy && api.isPractice) || state.networkBusy || state.uncertain) return;
  setAuthBusy(true);
  finishVisuals();
  try {
    api.usePractice();
    state.config = await api.call('/api/config');
    setSession(await api.call('/api/auth/guest', {}));
    state.connected = true;
    state.uncertain = false;
    $('#connection-banner').hidden = true;
    $('#auth-error').textContent = '';
    await morph.close($('#auth-dialog'));
    if (target && state.game === 'lobby') requestGame(target);
    else if (state.game === 'lobby')
      $('#game-collection').scrollIntoView({
        behavior: motionEnabled() ? 'smooth' : 'instant',
        block: 'start',
      });
    renderAll();
  } catch (error) {
    onError(error);
  } finally {
    setAuthBusy(false);
  }
}
async function openServerLogin() {
  if (state.networkBusy || state.uncertain) return;
  finishVisuals();
  await morph.close($('#account-dialog'));
  api.useServer();
  setSession({ user: null });
  dialogs.open('auth-dialog', $('#account-button'));
  synchronize(false).catch((error) => {
    $('#auth-error').textContent = errorMessage(error);
  });
}
async function guestLogin() {
  if (state.authBusy) return;
  const generation = api.beginAuthentication();
  setAuthBusy(true);
  $('#auth-error').textContent = '';
  try {
    await api.call('/api/auth/guest', {});
    const session = await api.call('/api/session');
    if (generation !== api.generation) return;
    if (!session.user) throw new RequestError('session_unavailable', 'Session could not be restored');
    setSession(session);
    morph.close($('#auth-dialog'));
    notify(t('guestGreeting'));
    $('#connection-banner').hidden = true;
  } catch (error) {
    if (generation !== api.generation) return;
    $('#auth-error').textContent = errorMessage(error);
    onError(error);
  } finally {
    if (generation === api.generation) setAuthBusy(false);
  }
}
async function telegramLogin() {
  if (state.authBusy) return;
  const generation = api.beginAuthentication();
  setAuthBusy(true);
  $('#auth-error').textContent = '';
  try {
    if (initData) {
      const session = await api.call('/api/auth/telegram/miniapp', { initData });
      if (generation !== api.generation) return;
      setSession(session);
      morph.close($('#auth-dialog'));
      history.replaceState(null, '', location.pathname + '#lobby');
      notify(t('guestGreeting'));
      return;
    }
    const data = await api.call('/api/auth/telegram/start', {}),
      container = $('#telegram-widget');
    if (generation !== api.generation) return;
    container.replaceChildren();
    const script = document.createElement('script');
    script.src = 'https://telegram.org/js/telegram-widget.js?22';
    script.async = true;
    script.setAttribute('data-telegram-login', data.username);
    script.setAttribute('data-size', 'large');
    script.setAttribute('data-radius', '14');
    script.setAttribute('data-userpic', 'false');
    script.setAttribute('data-auth-url', data.authUrl);
    script.addEventListener('error', () => {
      $('#auth-error').textContent = t('telegramUnavailable');
    });
    container.append(script);
  } catch (error) {
    if (generation !== api.generation) return;
    $('#auth-error').textContent = errorMessage(error);
  } finally {
    if (generation === api.generation) setAuthBusy(false);
  }
}

$('#hero-cube').innerHTML = cubeHTML();
$('#mini-plinko').innerHTML =
  `<svg viewBox="0 0 248 220" fill="none">${Array.from({ length: 7 }, (_, r) => Array.from({ length: r + 1 }, (_, c) => `<circle cx="${124 + (c - r / 2) * 26}" cy="${54 + r * 26}" r="2.1" fill="#adb68b" opacity="${0.5 + r * 0.05}"/>`).join('')).join('')}${Array.from({ length: 8 }, (_, i) => `<rect x="${26 + i * 26}" y="210" width="19" height="7" rx="2" fill="${i === 0 || i === 7 ? '#dcbe8e' : '#939e6f'}"/>`).join('')}</svg><span class="mini-dot"></span>`;
$$('[data-go]').forEach((button) =>
  button.addEventListener('click', (event) => {
    if (event.ctrlKey || event.metaKey || event.shiftKey) return;
    event.preventDefault();
    requestGame(button.dataset.go, button);
  }),
);
$$('.dock-games a').forEach((link, index) => link.setAttribute('aria-keyshortcuts', `Alt+${index + 1}`));
window.addEventListener('hashchange', () => navigate(location.hash.slice(1) || 'lobby', null, false));
$('#choose-game').addEventListener('click', () =>
  $('#game-collection').scrollIntoView({ behavior: motionEnabled() ? 'smooth' : 'instant', block: 'start' }),
);
$$('[data-favorite]').forEach((button) =>
  button.addEventListener('click', () => {
    const id = button.dataset.favorite;
    if (favorites.has(id)) {
      favorites.delete(id);
      notify(t('favoriteRemoved'));
    } else {
      favorites.add(id);
      notify(t('favoriteAdded'));
    }
    safeStorage.set('games.favorites', JSON.stringify([...favorites]));
    updateFavorites();
  }),
);
$('#account-button').addEventListener('click', (event) =>
  dialogs.open(state.user ? 'account-dialog' : 'auth-dialog', event.currentTarget),
);
$('#guest-login').addEventListener('click', guestLogin);
$('#practice-login').addEventListener('click', () => startPractice(null));
$('#practice-launch').addEventListener('click', () => startPractice());
$('#practice-retry').addEventListener('click', () => startPractice());
$('#telegram-login').addEventListener('click', telegramLogin);

document.addEventListener('click', (event) => {
  if (!document.querySelector('dialog[open]') && !event.target.closest('#game-island')) toggleIsland(false);
});
document.addEventListener('keydown', (event) => {
  if (
    event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.target.closest('input,textarea,select') &&
    !document.querySelector('dialog[open]')
  ) {
    const name = ['lobby', 'blackjack', 'slots', 'dice', 'plinko'][Number(event.key) - 1];
    if (name) {
      event.preventDefault();
      requestGame(name);
      return;
    }
  }
  if (
    event.key === 'Enter' &&
    !event.repeat &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    state.game !== 'lobby' &&
    !document.querySelector('dialog[open]') &&
    !event.target.closest('button,a') &&
    event.target.type !== 'range'
  ) {
    event.preventDefault();
    play();
  }
});
$('#play-button').addEventListener('click', play);
$('#dock-launch-play').addEventListener('click', launchSelected);

/* Atmosphere particles are tappable and shimmer under the pointer. */
document.addEventListener('pointerdown', (event) => {
  const flake = event.target.closest('.ny-snow i, .garden-petals i');
  if (flake) {
    try {
      sound.unlock();
      sound.play('chime');
    } catch {
      /* Sound is optional. */
    }
  }
});
document.addEventListener(
  'pointerover',
  (event) => {
    if (event.pointerType === 'touch') return;
    if (event.target.closest('.ny-snow i')) {
      try {
        sound.unlock();
        sound.play('sparkle');
      } catch {
        /* Sound is optional. */
      }
    }
  },
  { passive: true },
);

/* Cards hum softly under the pointer. */
document.addEventListener(
  'pointerover',
  (event) => {
    if (event.pointerType === 'touch') return;
    if (event.target.closest('.game-card-main, .game-dock a, .game-dock button')) {
      try {
        sound.unlock();
        sound.play('hover');
      } catch {
        /* Sound is optional. */
      }
    }
  },
  { passive: true },
);

/* Long-press the dock settings gear to flip the Blackjack table style fast. */
(function quickTableStyle() {
  const dockSettings = $('#dock-settings'),
    popover = $('#table-popover');
  if (!dockSettings || !popover) return;
  let holdTimer = 0,
    holdFired = false;
  const openPopover = () => {
    popover.hidden = false;
    $$('[data-pop-table-color]').forEach((button) =>
      button.setAttribute('aria-pressed', String(button.dataset.popTableColor === preferences.table)),
    );
    if (motionEnabled())
      popover.animate(
        [
          { opacity: 0, transform: 'translateY(12px) scale(.95)' },
          { opacity: 1, transform: 'translateY(0) scale(1)' },
        ],
        { duration: 320, easing: 'cubic-bezier(.22,1,.36,1)' },
      );
    sound.play('select');
  };
  $$('[data-pop-table-color]').forEach((button) =>
    button.addEventListener('click', () => {
      savePreferences({ table: button.dataset.popTableColor });
      sound.play('select');
      $$('[data-pop-table-color]').forEach((item) =>
        item.setAttribute('aria-pressed', String(item === button)),
      );
      closePopover();
    }),
  );
  const closePopover = () => {
    popover.hidden = true;
  };
  dockSettings.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    holdFired = false;
    clearTimeout(holdTimer);
    holdTimer = setTimeout(() => {
      holdFired = true;
      openPopover();
    }, 500);
  });
  for (const name of ['pointerup', 'pointercancel', 'pointerleave'])
    dockSettings.addEventListener(name, () => clearTimeout(holdTimer));
  dockSettings.addEventListener('click', (event) => {
    if (holdFired) {
      event.preventDefault();
      event.stopPropagation();
      holdFired = false;
    }
  });
  $('#popover-open-settings').addEventListener('click', () => {
    closePopover();
    dialogs.open('game-settings-dialog', dockSettings);
  });
  document.addEventListener('pointerdown', (event) => {
    if (!popover.hidden && !event.target.closest('#table-popover') && !event.target.closest('#dock-settings'))
      closePopover();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !popover.hidden) closePopover();
  });
})();

/* Dialog open/close whooshes. */
const dialogSoundObserver = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    if (mutation.type !== 'attributes' || mutation.attributeName !== 'open') continue;
    sound.play(mutation.target.open ? 'open' : 'close');
  }
});
$$('dialog').forEach((dialog) =>
  dialogSoundObserver.observe(dialog, { attributes: true, attributeFilter: ['open'] }),
);

$$('[data-batch]').forEach((button) =>
  button.addEventListener('click', () => {
    if (state.networkBusy || state.batchRunning || state.busy.plinko || state.uncertain) return;
    state.batchCount = Number(button.dataset.batch);
    renderControls();
    sound.play('select');
  }),
);
$('#scene-sound').addEventListener('click', () => {
  sound.unlock();
  savePreferences({ sound: !preferences.sound });
  if (preferences.sound) sound.tone(660);
});
$('#bet-amount').addEventListener('change', (event) => setBet(event.target.value));
$$('[data-bet-step]').forEach((button) =>
  bindPressRepeat(button, () => {
    const changed = setBet(state.betMinor / 100 + Number(button.dataset.betStep));
    if (changed) sound.play(Number(button.dataset.betStep) > 0 ? 'betUp' : 'betDown');
    return changed;
  }),
);
$$('[data-bet-factor]').forEach((button) =>
  button.addEventListener('click', () =>
    setBet(
      button.dataset.betFactor === 'half'
        ? state.betMinor / 200
        : button.dataset.betFactor === 'double'
          ? state.betMinor / 50
          : Math.min(MAX_BET, displayedBalance()) / 100,
    ),
  ),
);
$$('[data-risk]').forEach((button) =>
  button.addEventListener('click', () => {
    if (state.busy.plinko) return;
    state.plinko.risk = button.dataset.risk;
    plinko.configure(state.plinko.rows, state.plinko.risk);
    sound.play('softPop');
    renderControls();
  }),
);
$$('[data-rows]').forEach((button) =>
  button.addEventListener('click', () => {
    if (state.busy.plinko) return;
    state.plinko.rows = Number(button.dataset.rows);
    sound.play('tick');
    plinko.configure(state.plinko.rows, state.plinko.risk);
    renderControls();
  }),
);
$$('[data-dice-mode]').forEach((button) =>
  button.addEventListener('click', () => {
    if (state.busy.dice) return;
    state.dice.mode = button.dataset.diceMode;
    state.dice.target = clamp(
      state.dice.target,
      state.dice.mode === 'under' ? 2 : 1,
      state.dice.mode === 'under' ? 6 : 5,
    );
    renderControls();
  }),
);
$('#dice-target').addEventListener('input', (event) => {
  if (state.busy.dice) return;
  state.dice.target = Number(event.target.value);
  renderControls();
});
$$('[data-bj-action]').forEach((button) =>
  button.addEventListener('click', () => blackjackAction(button.dataset.bjAction)),
);
$('#retry-connection').addEventListener('click', () => synchronize(true).catch(onError));
window.addEventListener('online', () => synchronize(true).catch(onError));
window.addEventListener('offline', () => {
  if (api.isPractice) return;
  state.connected = false;
  $('#connection-banner').hidden = false;
  $('#connection-message').textContent = t('connectionLost');
  renderChrome();
});
document.addEventListener('visibilitychange', () => {
  document.documentElement.dataset.fxPaused = String(document.hidden);
  if (document.hidden) finishVisuals();
  else if (!state.networkBusy) synchronize(false).catch(onError);
});
window.addEventListener('preferenceschange', () => {
  translatePage();
  renderSettings();
  if (!motionEnabled()) finishVisuals();
  updateGame();
  renderAll();
  syncIndicators();
});
document.addEventListener('pointerdown', () => sound.unlock(), { once: true });
initializeSwitches();
initializeMotionPicker(document.getElementById('transition-style'));
bindSettings(sound, notify);
installPreferenceListeners();
kineticControls();
applyPreferences();
translatePage();
renderAll();
const initialHash = location.hash.slice(1),
  initData = window.Telegram?.WebApp?.initData || new URLSearchParams(initialHash).get('tgWebAppData');
navigate(games[initialHash] ? initialHash : 'lobby', null, false, false);
document.documentElement.dataset.ready = 'true';
if (new URLSearchParams(location.search).get('auth') === 'failed') {
  dialogs.open('auth-dialog', $('#account-button'));
  $('#auth-error').textContent = t('lostAuth');
  history.replaceState(null, '', location.pathname + location.hash);
}
synchronize(false)
  .then(async () => {
    // Preview builds sign in as a guest automatically so history, wallet and
    // profile work right away instead of showing a login wall.
    if (state.config?.preview && !state.user && !api.isPractice) {
      try {
        await api.call('/api/auth/guest', {});
        const session = await api.call('/api/session');
        if (session.user) setSession(session);
      } catch {
        /* The explicit sign-in flow stays available. */
      }
    }
    // Signing in is always an explicit action, including when initData is supplied by Telegram.
    if (state.user && api.pending()) {
      state.uncertain = true;
      $('#connection-banner').hidden = false;
      $('#connection-message').textContent = t('pendingRound');
      renderControls();
    }
  })
  .catch(onError);

initializeTextMotion();
finishBoot();

/* --- Secrets -------------------------------------------------------------
   Small discoverable easter eggs:
   - Konami code (↑ ↑ ↓ ↓ ← → ← → B A) unlocks the Nebula atmosphere.
   - Five quick clicks on the brand logo do the same.
   The unlocked option appears in Settings → Atmosphere and persists locally.
--------------------------------------------------------------------------- */
const NEBULA_KEY = 'aubeig.secrets.nebula';
const nebulaUnlocked = () => safeStorage.get(NEBULA_KEY) === 'on';
function revealNebulaOption() {
  $$('button[data-background="nebula"]').forEach((button) => (button.hidden = false));
}
function confettiBurst() {
  if (!motionEnabled()) return;
  const layer = document.createElement('div');
  layer.className = 'secret-confetti';
  layer.setAttribute('aria-hidden', 'true');
  document.body.append(layer);
  const colors = ['#c4e27e', '#7fc4ea', '#eec27e', '#b9a2f4', '#fc5474'];
  const pieces = [];
  for (let i = 0; i < 42; i++) {
    const piece = document.createElement('i');
    piece.style.setProperty('--c', colors[i % colors.length]);
    piece.style.setProperty('--dx', `${(Math.random() - 0.5) * 210}px`);
    piece.style.setProperty('--dr', `${Math.random() * 540 - 270}deg`);
    piece.style.setProperty('--dur', `${780 + Math.random() * 560}ms`);
    layer.append(piece);
    pieces.push(piece);
  }
  const animations = pieces.map((piece, i) => {
    const animation = piece.animate(
      [
        { opacity: 0, transform: 'translate3d(0, -10px, 0) rotate(0deg)' },
        { opacity: 1, offset: 0.12 },
        {
          opacity: 0,
          transform: `translate3d(var(--dx), ${-60 - i * 7}px, 0) rotate(var(--dr))`,
        },
      ],
      { duration: 1300, delay: (i % 9) * 22, easing: 'cubic-bezier(.14,.6,.3,1)' },
    );
    animation.finished.catch(() => {});
    return animation;
  });
  Promise.all(animations.map((a) => a.finished)).finally(() => layer.remove());
}
function rainbowFlash() {
  if (!motionEnabled()) return;
  const layer = document.createElement('div');
  layer.className = 'secret-rainbow';
  layer.setAttribute('aria-hidden', 'true');
  document.body.append(layer);
  setTimeout(() => layer.remove(), 1600);
}
function coinRain() {
  if (!motionEnabled()) return;
  const layer = document.createElement('div');
  layer.className = 'secret-coins';
  layer.setAttribute('aria-hidden', 'true');
  document.body.append(layer);
  const glyphs = ['7', '7', '7', '●', '●'];
  for (let i = 0; i < 34; i++) {
    const coin = document.createElement('i');
    coin.textContent = glyphs[i % glyphs.length];
    coin.style.setProperty('--x', `${Math.random() * 100}%`);
    coin.style.setProperty('--dx', `${(Math.random() - 0.5) * 160}px`);
    coin.style.setProperty('--dr', `${Math.random() * 720 - 360}deg`);
    coin.style.setProperty('--dur', `${1100 + Math.random() * 800}ms`);
    coin.style.setProperty('--delay', `${Math.random() * 320}ms`);
    layer.append(coin);
  }
  setTimeout(() => layer.remove(), 2400);
}
function secretStamp() {
  if (!motionEnabled()) return;
  const layer = document.createElement('div');
  layer.className = 'secret-stamp';
  layer.setAttribute('aria-hidden', 'true');
  layer.innerHTML = `<span class="stamp-mark">${icon('mark')}</span><span class="stamp-ring"></span><span class="stamp-ring two"></span>`;
  document.body.append(layer);
  setTimeout(() => layer.remove(), 1500);
}
function unlockNebula() {
  const already = nebulaUnlocked();
  safeStorage.set(NEBULA_KEY, 'on');
  revealNebulaOption();
  confettiBurst();
  rainbowFlash();
  secretStamp();
  if (!already) {
    try {
      sound.unlock();
      sound.play('levelup');
    } catch {
      /* Sound is optional. */
    }
  }
  notify(t('secretUnlocked'));
}
(function bindSecrets() {
  if (nebulaUnlocked()) revealNebulaOption();
  const sequence = [
    'ArrowUp',
    'ArrowUp',
    'ArrowDown',
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
    'ArrowLeft',
    'ArrowRight',
    'b',
    'a',
  ];
  let step = 0,
    konamiTimer = 0;
  document.addEventListener('keydown', (event) => {
    if (event.target.closest('input,textarea,select') || event.altKey || event.ctrlKey || event.metaKey)
      return;
    const expected = sequence[step];
    if (event.key === expected || event.key.toLowerCase() === expected) {
      step++;
      clearTimeout(konamiTimer);
      konamiTimer = setTimeout(() => (step = 0), 2200);
      if (step === sequence.length) {
        step = 0;
        unlockNebula();
      }
    } else {
      step = 0;
    }
  });
  let brandClicks = 0,
    brandTimer = 0;
  const brand = document.querySelector('.site-brand');
  if (brand)
    brand.addEventListener('click', () => {
      brandClicks++;
      clearTimeout(brandTimer);
      brandTimer = setTimeout(() => (brandClicks = 0), 1600);
      if (brandClicks >= 5) {
        brandClicks = 0;
        unlockNebula();
      }
    });
  // Seven quick taps on the hero "7" chip pays out pure luck.
  let sevenTaps = 0,
    sevenTimer = 0;
  document.addEventListener('pointerdown', (event) => {
    const seven = event.target.closest('.hero-seven');
    if (!seven) return;
    sevenTaps++;
    clearTimeout(sevenTimer);
    sevenTimer = setTimeout(() => (sevenTaps = 0), 1100);
    if (sevenTaps < 7) {
      try {
        sound.unlock();
        sound.play('coin');
      } catch {
        /* Sound is optional. */
      }
      return;
    }
    sevenTaps = 0;
    coinRain();
    try {
      sound.unlock();
      sound.play('levelup');
    } catch {
      /* Sound is optional. */
    }
      notify(t('luckySeven'));
  });
  // Typing "aubeig" anywhere sends a quiet hello.
  let typed = '';
  document.addEventListener('keydown', (event) => {
    if (event.target.closest('input,textarea,select') || event.altKey || event.ctrlKey || event.metaKey)
      return;
    if (event.key.length !== 1) return;
    typed = (typed + event.key.toLowerCase()).slice(-6);
    if (typed !== 'aubeig') return;
    typed = '';
    confettiBurst();
    try {
      sound.unlock();
      sound.play('win');
    } catch {
      /* Sound is optional. */
    }
    notify(t('secretUnlocked'));
  });
})();
