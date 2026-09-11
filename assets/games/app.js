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
  slots = new SlotsRenderer($('#slot-reels'), () => sound.impact());
const plinko = new PlinkoRenderer($('#plinko-canvas'), $('#plinko-bins'), () => sound.impact());
const syncIndicators = springGroups();
let toastTimer;
let actionEpoch = 0;
const gameIsland = new ExpandingIsland($('#game-island'), $('#island-trigger'), $('#island-panel'));
const shownRounds = new Set();

function notify(message) {
  const toast = $('#portal-toast');
  toast.textContent = message;
  toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 3500);
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
  dice.finish?.();
  slots.finish?.();
  plinko.finishAll();
}
const dialogs = new PortalDialogs({
  morph,
  api,
  state: () => state,
  notify,
  onError,
  onData: ingest,
  onSession: setSession,
  finishVisuals,
  onNavigate: navigate,
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
  $('#island-subtitle').textContent = t('practice');
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
function renderControls() {
  if (state.game === 'lobby') return;
  const game = state.game,
    locked = Boolean(
      state.networkBusy ||
        state.uncertain ||
        (game === 'plinko' ? state.busy.plinko : state.busy[game]) ||
        (game === 'blackjack' && state.activeBlackjack),
    );
  $('#bet-amount').value = state.betMinor / 100;
  $('#bet-amount').disabled = locked;
  $$('[data-bet-step],[data-bet-factor]').forEach((button) => (button.disabled = locked));
  $$('[data-risk],[data-rows]').forEach((button) => {
    button.disabled = Boolean(state.busy.plinko || state.networkBusy || state.uncertain);
    const selected = button.dataset.risk
      ? button.dataset.risk === state.plinko.risk
      : Number(button.dataset.rows) === state.plinko.rows;
    button.setAttribute('aria-pressed', String(selected));
  });
  $$('[data-dice-mode]').forEach((button) => {
    button.disabled = state.busy.dice || state.networkBusy || state.uncertain;
    button.setAttribute('aria-pressed', String(button.dataset.diceMode === state.dice.mode));
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
  $('#plinko-max').textContent = money(
    Math.floor(state.betMinor * plinkoTable(state.plinko.rows, state.plinko.risk)[0]),
  );
  $('#play-label').textContent = state.networkBusy ? t('waitingServer') : t(games[game].play);
  $('#play-button').dataset.busy = String(state.networkBusy);
  $('.play-button-icon use').setAttribute('href', '#i-' + (state.networkBusy ? 'replay' : games[game].icon));
  $('#play-button').hidden = game === 'blackjack' && Boolean(state.activeBlackjack);
  $('#play-button').disabled = Boolean(
    state.networkBusy ||
      state.uncertain ||
      (game === 'plinko' ? state.busy.plinko >= 8 : state.busy[game]) ||
      (state.user && displayedBalance() < state.betMinor),
  );
  $('#blackjack-actions').hidden = !state.activeBlackjack;
  $$('[data-bj-action]').forEach(
    (button) =>
      (button.disabled = Boolean(
        state.networkBusy ||
          state.uncertain ||
          !state.activeBlackjack ||
          (button.dataset.bjAction === 'double' &&
            (!state.activeBlackjack?.outcome.canDouble ||
              displayedBalance() < state.activeBlackjack.betMinor)),
      )),
  );
  $('#round-queue').hidden = !state.busy.plinko;
  $('#round-queue-label').textContent = t('activeBalls', { count: state.busy.plinko });
  const active = game === 'blackjack' ? Boolean(state.activeBlackjack) : Boolean(state.busy[game]);
  $('#scene-status-text').textContent = state.networkBusy
    ? t('waitingServer')
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
  renderCardHand($('#dealer-hand'), round?.outcome.dealer || [null, null]);
  renderCardHand($('#player-hand'), round?.outcome.player || [null, null]);
  $('#dealer-score').textContent = round?.outcome.dealerValue.total ?? '—';
  $('#player-score').textContent = round?.outcome.playerValue.total ?? '—';
}
function renderRecent() {
  if (state.game === 'lobby') return;
  const rounds = [...state.rounds.values()]
    .filter(
      (round) =>
        round.game === state.game && round.status === 'settled' && !state.pendingCredits.has(round.id),
    )
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 8);
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
  sound.result(round.netMinor > 0);
  renderChrome();
  renderRecent();
}
function renderAll() {
  renderChrome();
  renderControls();
  renderRecent();
}
function resetResult() {
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
function navigate(game, source = null, push = true, animate = true) {
  if (game !== 'lobby' && !games[game]) game = 'lobby';
  if (game === state.game && document.documentElement.dataset.ready) return;
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
  if (push && location.hash !== '#' + game) history.pushState(null, '', '#' + game);
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
    state.uncertain ||
    (state.game === 'plinko' ? state.busy.plinko : state.busy[state.game]) ||
    (state.game === 'blackjack' && state.activeBlackjack)
  )
    return;
  const number = Number(value);
  if (!Number.isFinite(number)) return;
  state.betMinor = clamp(Math.round(number) * 100, MIN_BET, MAX_BET);
  renderControls();
}
async function animateRound(round) {
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
    state.busy.dice = false;
  } else if (round.game === 'slots') {
    state.busy.slots = true;
    renderControls();
    await slots.spin(round.outcome.symbols);
    state.busy.slots = false;
  }
  state.pendingCredits.delete(round.id);
  showResult(round);
  renderControls();
}
async function play() {
  const game = state.game;
  if (!games[game] || state.networkBusy || state.uncertain) return;
  if (!state.user) {
    dialogs.open('auth-dialog', $('#play-button'));
    return;
  }
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
  state.networkBusy = true;
  actionEpoch++;
  sound.unlock();
  renderControls();
  $('#result-title').textContent = t('waitingServer');
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
    if (data.round.status === 'active') {
      renderHand(data.round);
      $('#result-title').textContent = t('handActive');
      $('#result-detail').textContent = t('waitingForMove');
      renderAll();
    } else {
      animateRound(data.round).catch(onError);
      renderControls();
    }
  } catch (error) {
    state.networkBusy = false;
    onError(error);
  }
}
async function blackjackAction(action) {
  const round = state.activeBlackjack;
  if (!round || state.networkBusy || state.uncertain) return;
  state.networkBusy = true;
  actionEpoch++;
  renderControls();
  sound.unlock();
  try {
    const data = await api.mutate(`/api/blackjack/${round.id}/action`, {
      actionId: uuid(),
      action,
      version: round.version,
    });
    ingest(data);
    renderHand(data.round);
    state.networkBusy = false;
    if (data.round.status === 'settled') showResult(data.round);
    else {
      sound.impact();
      $('#result-title').textContent = t('handActive');
      $('#result-detail').textContent = t('waitingForMove');
    }
    renderControls();
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
  const [config, session] = await Promise.all([api.call('/api/config'), api.call('/api/session')]);
  state.config = config;
  if (generation !== api.generation || epoch !== actionEpoch) return;
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
  $('#guest-login').dataset.busy = String(busy);
  $('#auth-dialog').setAttribute('aria-busy', String(busy));
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
    $('#auth-error').textContent = errorMessage(error);
    onError(error);
  } finally {
    setAuthBusy(false);
  }
}
async function telegramLogin() {
  if (state.authBusy) return;
  api.beginAuthentication();
  setAuthBusy(true);
  $('#auth-error').textContent = '';
  try {
    if (initData) {
      setSession(await api.call('/api/auth/telegram/miniapp', { initData }));
      morph.close($('#auth-dialog'));
      history.replaceState(null, '', location.pathname + '#lobby');
      notify(t('guestGreeting'));
      return;
    }
    const data = await api.call('/api/auth/telegram/start', {}),
      container = $('#telegram-widget');
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
    $('#auth-error').textContent = errorMessage(error);
  } finally {
    setAuthBusy(false);
  }
}

$('#hero-cube').innerHTML = cubeHTML();
$('#mini-plinko').innerHTML =
  `<svg viewBox="0 0 248 220" fill="none">${Array.from({ length: 7 }, (_, r) => Array.from({ length: r + 1 }, (_, c) => `<circle cx="${124 + (c - r / 2) * 26}" cy="${54 + r * 26}" r="2.1" fill="#adb68b" opacity="${0.5 + r * 0.05}"/>`).join('')).join('')}${Array.from({ length: 8 }, (_, i) => `<rect x="${26 + i * 26}" y="210" width="19" height="7" rx="2" fill="${i === 0 || i === 7 ? '#dcbe8e' : '#939e6f'}"/>`).join('')}</svg><span class="mini-dot"></span>`;
$$('[data-go]').forEach((button) =>
  button.addEventListener('click', (event) => {
    if (event.ctrlKey || event.metaKey || event.shiftKey) return;
    event.preventDefault();
    navigate(button.dataset.go, button);
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
      navigate(name);
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
$('#scene-sound').addEventListener('click', () => {
  sound.unlock();
  savePreferences({ sound: !preferences.sound });
  if (preferences.sound) sound.tone(660);
});
$('#bet-amount').addEventListener('change', (event) => setBet(event.target.value));
$$('[data-bet-step]').forEach((button) =>
  button.addEventListener('click', () => setBet(state.betMinor / 100 + Number(button.dataset.betStep))),
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
    renderControls();
  }),
);
$$('[data-rows]').forEach((button) =>
  button.addEventListener('click', () => {
    if (state.busy.plinko) return;
    state.plinko.rows = Number(button.dataset.rows);
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
  state.connected = false;
  $('#connection-banner').hidden = false;
  $('#connection-message').textContent = t('connectionLost');
  renderChrome();
});
document.addEventListener('visibilitychange', () => {
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
    // Signing in is always an explicit action, including when initData is supplied by Telegram.
    if (state.user && api.pending()) {
      state.uncertain = true;
      $('#connection-banner').hidden = false;
      $('#connection-message').textContent = t('pendingRound');
      renderControls();
    }
  })
  .catch(onError);
