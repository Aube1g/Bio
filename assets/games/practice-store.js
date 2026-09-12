import { BrowserFairRandom, hashSeed, newPracticeSeed } from './browser-random.js';
import {
  GAME_IDS,
  MIN_BET,
  MAX_BET,
  SLOT_RTP,
  diceOdds,
  diceOutcome,
  slotsOutcome,
  plinkoOutcome,
  shuffledDeck,
  handValue,
  blackjackResult,
  payout,
} from '../shared/game-rules.js';

const STORAGE_KEY = 'aubeig.practice.session';
const CREDIT = 100_000;
const clone = (value) => structuredClone(value);
const id = () =>
  crypto.randomUUID?.() ||
  `${newPracticeSeed().slice(0, 8)}-${newPracticeSeed().slice(0, 4)}-4000-8000-${newPracticeSeed().slice(0, 12)}`;
const storage = {
  get() {
    try {
      return sessionStorage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
  },
  set(value) {
    try {
      sessionStorage.setItem(STORAGE_KEY, value);
    } catch {
      /* The current page still works in memory. */
    }
  },
  clear() {
    try {
      sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      /* No persistent session. */
    }
  },
};
export class PracticeError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
function requireValue(condition, code, message, status = 400) {
  if (!condition) throw new PracticeError(code, message, status);
}

// Browser-only play money. This state never becomes a server/Violas wallet or a Telegram identity.
export class PracticeStore {
  constructor({ persistence = storage, now = Date.now } = {}) {
    this.storage = persistence;
    this.now = now;
    this.data = null;
    this.queue = Promise.resolve();
    try {
      const saved = JSON.parse(persistence.get() || 'null');
      if (
        saved?.version === 1 &&
        saved.user?.local === true &&
        saved.user.id.startsWith('practice-') &&
        Number.isSafeInteger(saved.balance) &&
        saved.balance >= 0 &&
        /^[a-f0-9]{64}$/.test(saved.seed) &&
        Array.isArray(saved.rounds) &&
        saved.requests &&
        Number.isSafeInteger(saved.nonce)
      )
        this.data = saved;
    } catch {
      /* Corrupt local practice data does not prevent starting a fresh session. */
    }
  }
  persist() {
    if (!this.data) {
      this.storage.clear();
      return;
    }
    const active = this.data.rounds.filter((round) => round.status === 'active');
    const settled = this.data.rounds.filter((round) => round.status === 'settled').slice(0, 150);
    this.data.rounds = [...active, ...settled].sort((a, b) => b.createdAt - a.createdAt);
    const keys = Object.keys(this.data.requests);
    for (const key of keys.slice(0, Math.max(0, keys.length - 200))) delete this.data.requests[key];
    this.storage.set(JSON.stringify(this.data));
  }
  call(path, body) {
    const next = this.queue.then(() => this.dispatch(path, body));
    this.queue = next.catch(() => {});
    return next;
  }
  fairness() {
    return { nextHash: hashSeed(this.data.seed), nonce: this.data.nonce };
  }
  wallet() {
    return {
      balanceMinor: this.data.balance,
      revision: this.data.revision,
      mode: 'practice',
      integration: 'browser',
    };
  }
  adjust(amount) {
    requireValue(
      Number.isSafeInteger(amount) &&
        this.data.balance + amount >= 0 &&
        Number.isSafeInteger(this.data.balance + amount),
      'insufficient_balance',
      'Недостаточно тестовых фишек',
      409,
    );
    this.data.balance += amount;
    this.data.revision++;
  }
  stats() {
    const value = this.data.statistics || {
      rounds: 0,
      wins: 0,
      losses: 0,
      pushes: 0,
      netMinor: 0,
      bestPayoutMinor: 0,
    };
    return { ...value, winRate: value.rounds ? Math.round((value.wins / value.rounds) * 100) : 0 };
  }
  countRound(round) {
    if (round.status !== 'settled' || round.counted) return;
    const stats = (this.data.statistics ||= {
      rounds: 0,
      wins: 0,
      losses: 0,
      pushes: 0,
      netMinor: 0,
      bestPayoutMinor: 0,
    });
    stats.rounds++;
    stats[
      round.payoutMinor > round.betMinor ? 'wins' : round.payoutMinor < round.betMinor ? 'losses' : 'pushes'
    ]++;
    stats.netMinor += round.payoutMinor - round.betMinor;
    stats.bestPayoutMinor = Math.max(stats.bestPayoutMinor, round.payoutMinor);
    round.counted = true;
  }
  publicRound(round) {
    const result = clone(round);
    delete result.privateState;
    delete result.counted;
    result.netMinor = result.payoutMinor - result.betMinor;
    result.proof.origin = 'local';
    if (round.game === 'blackjack') {
      const hand = round.privateState;
      const active = round.status === 'active';
      result.outcome = {
        ...round.outcome,
        player: [...hand.player],
        dealer: active ? [hand.dealer[0], null] : [...hand.dealer],
        playerValue: handValue(hand.player),
        dealerValue: handValue(active ? [hand.dealer[0]] : hand.dealer),
        canDouble: active && hand.player.length === 2 && !hand.doubled,
      };
    }
    if (round.status === 'active') delete result.proof.serverSeed;
    return result;
  }
  active() {
    const round = this.data.rounds.find((round) => round.game === 'blackjack' && round.status === 'active');
    return round ? this.publicRound(round) : null;
  }
  snapshot() {
    if (!this.data) return { user: null, mode: 'local' };
    return {
      user: clone(this.data.user),
      csrf: 'local-practice',
      mode: 'local',
      wallet: this.wallet(),
      fairness: this.fairness(),
      stats: this.stats(),
      activeBlackjack: this.active(),
      history: this.data.rounds.slice(0, 12).map((round) => this.publicRound(round)),
    };
  }
  guest() {
    if (!this.data) {
      this.data = {
        version: 1,
        user: { id: 'practice-' + id(), name: 'Гость', kind: 'guest', username: '', local: true },
        balance: CREDIT,
        revision: 1,
        seed: newPracticeSeed(),
        nonce: 0,
        rounds: [],
        requests: {},
        resetAt: 0,
      };
      this.persist();
    }
    return this.snapshot();
  }
  mutate(key, request, operation) {
    requireValue(
      typeof key === 'string' && /^[a-zA-Z0-9_-]{16,80}$/.test(key),
      'invalid_request_key',
      'Некорректный запрос',
    );
    const hash = hashSeed(JSON.stringify(request));
    const saved = this.data.requests[key];
    if (saved) {
      requireValue(saved.hash === hash, 'request_conflict', 'Этот запрос уже использован', 409);
      return clone(saved.result);
    }
    const before = clone(this.data);
    try {
      const result = {
        ...operation(),
        wallet: this.wallet(),
        fairness: this.fairness(),
        stats: this.stats(),
        activeBlackjack: this.active(),
        mode: 'local',
      };
      this.data.requests[key] = { hash, result: clone(result) };
      this.persist();
      return clone(result);
    } catch (error) {
      this.data = before;
      throw error;
    }
  }
  play(game, request) {
    return this.mutate(request.actionId, { game, request }, () => {
      requireValue(GAME_IDS.includes(game), 'unknown_game', 'Игра не найдена');
      const bet = request.betMinor,
        parameters = request.parameters || {};
      requireValue(
        Number.isSafeInteger(bet) && bet >= MIN_BET && bet <= MAX_BET && bet % 100 === 0,
        'invalid_bet',
        'Ставка: от 5 до 500 фишек',
      );
      requireValue(
        typeof request.clientSeed === 'string' && /^[a-zA-Z0-9 _-]{1,64}$/.test(request.clientSeed),
        'invalid_client_seed',
        'Некорректный client seed',
      );
      requireValue(
        request.commit === hashSeed(this.data.seed) && request.nonce === this.data.nonce,
        'stale_commit',
        'Состояние игры изменилось',
        409,
      );
      requireValue(this.data.balance >= bet, 'insufficient_balance', 'Недостаточно фишек', 409);
      const rng = new BrowserFairRandom(this.data.seed, request.clientSeed, this.data.nonce, game);
      const round = {
        id: id(),
        game,
        status: 'settled',
        betMinor: bet,
        payoutMinor: 0,
        parameters: clone(parameters),
        outcome: {},
        version: 0,
        createdAt: this.now(),
        settledAt: this.now(),
        proof: {
          hash: hashSeed(this.data.seed),
          serverSeed: this.data.seed,
          clientSeed: request.clientSeed,
          nonce: this.data.nonce,
          game,
          origin: 'local',
        },
      };
      if (game === 'dice') {
        requireValue(
          ['under', 'over'].includes(parameters.mode) &&
            Number.isInteger(parameters.target) &&
            parameters.target >= 1 &&
            parameters.target <= 6 &&
            diceOdds(parameters.mode, parameters.target).successfulFaces > 0,
          'invalid_dice',
          'Выбери допустимый порог',
        );
        round.outcome = diceOutcome(rng, parameters.mode, parameters.target);
        round.payoutMinor = round.outcome.win ? payout(bet, round.outcome.multiplier) : 0;
      } else if (game === 'slots') {
        round.outcome = slotsOutcome(rng);
        round.payoutMinor = payout(bet, round.outcome.multiplier);
      } else if (game === 'plinko') {
        requireValue(
          [8, 12, 16].includes(parameters.rows) && ['low', 'medium', 'high'].includes(parameters.risk),
          'invalid_plinko',
          'Выбери ряды и риск',
        );
        round.outcome = plinkoOutcome(rng, parameters.rows, parameters.risk);
        round.payoutMinor = payout(bet, round.outcome.multiplier);
      } else {
        requireValue(!this.active(), 'blackjack_active', 'Сначала закончи раздачу', 409);
        const deck = shuffledDeck(rng);
        round.privateState = {
          deck,
          cursor: 4,
          player: [deck[0], deck[2]],
          dealer: [deck[1], deck[3]],
          doubled: false,
        };
        if (handValue(round.privateState.player).natural || handValue(round.privateState.dealer).natural) {
          const result = blackjackResult(round.privateState.player, round.privateState.dealer, bet);
          round.payoutMinor = result.payoutMinor;
          round.outcome.reason = result.reason;
        } else {
          round.status = 'active';
          round.settledAt = null;
        }
      }
      this.adjust(-bet);
      if (round.payoutMinor) this.adjust(round.payoutMinor);
      this.countRound(round);
      this.data.rounds.unshift(round);
      this.data.seed = newPracticeSeed();
      this.data.nonce++;
      return { round: this.publicRound(round) };
    });
  }
  blackjackAction(roundId, request) {
    return this.mutate(request.actionId, { roundId, request }, () => {
      const round = this.data.rounds.find((round) => round.id === roundId && round.game === 'blackjack');
      requireValue(round, 'round_not_found', 'Раздача не найдена', 404);
      requireValue(
        round.status === 'active' && round.version === request.version,
        'round_changed',
        'Раздача уже изменилась',
        409,
      );
      requireValue(['hit', 'stand', 'double'].includes(request.action), 'invalid_action', 'Недопустимый ход');
      const hand = round.privateState;
      if (request.action === 'double') {
        requireValue(
          hand.player.length === 2 && !hand.doubled,
          'double_unavailable',
          'Удвоение недоступно',
          409,
        );
        this.adjust(-round.betMinor);
        round.betMinor *= 2;
        hand.doubled = true;
      }
      if (request.action !== 'stand') hand.player.push(hand.deck[hand.cursor++]);
      if (request.action !== 'hit' || handValue(hand.player).total >= 21) {
        if (handValue(hand.player).total <= 21)
          while (handValue(hand.dealer).total < 17) hand.dealer.push(hand.deck[hand.cursor++]);
        const result = blackjackResult(hand.player, hand.dealer, round.betMinor);
        round.status = 'settled';
        round.settledAt = this.now();
        round.payoutMinor = result.payoutMinor;
        round.outcome.reason = result.reason;
        if (round.payoutMinor) this.adjust(round.payoutMinor);
      }
      this.countRound(round);
      round.version++;
      return { round: this.publicRound(round) };
    });
  }
  dispatch(path, body) {
    const url = new URL(path, 'https://practice.invalid');
    if (url.pathname === '/api/config')
      return {
        telegram: { enabled: false, miniApp: false, username: '' },
        wallet: { mode: 'practice', integration: 'browser', initialMinor: CREDIT, decimals: 2 },
        limits: { minBetMinor: MIN_BET, maxBetMinor: MAX_BET },
        slotsRtp: SLOT_RTP,
      };
    if (url.pathname === '/api/session') return this.snapshot();
    if (url.pathname === '/api/auth/guest') return this.guest();
    if (url.pathname.startsWith('/api/auth/telegram'))
      throw new PracticeError('telegram_unavailable', 'Для Telegram нужен серверный вход', 503);
    requireValue(this.data, 'login_required', 'Начни тестовую игру', 401);
    if (url.pathname === '/api/auth/logout') {
      this.data = null;
      this.persist();
      return { ok: true };
    }
    const game = url.pathname.match(/^\/api\/games\/(blackjack|slots|dice|plinko)$/);
    if (game && body) return this.play(game[1], body);
    const action = url.pathname.match(/^\/api\/blackjack\/([a-f0-9-]+)\/action$/);
    if (action && body) return this.blackjackAction(action[1], body);
    if (url.pathname === '/api/history') {
      const before = url.searchParams.get('before');
      const start = before ? this.data.rounds.findIndex((round) => round.id === before) + 1 : 0;
      const rounds = this.data.rounds.slice(start, start + 30);
      return {
        rounds: rounds.map((round) => this.publicRound(round)),
        nextCursor: start + 30 < this.data.rounds.length ? rounds.at(-1).id : null,
      };
    }
    if (url.pathname.startsWith('/api/rounds/')) {
      const round = this.data.rounds.find((round) => round.id === url.pathname.split('/').at(-1));
      requireValue(round, 'round_not_found', 'Партия не найдена', 404);
      return { round: this.publicRound(round) };
    }
    if (url.pathname.startsWith('/api/requests/')) {
      const result = this.data.requests[url.pathname.split('/').at(-1)]?.result;
      return { found: Boolean(result), result: result ? clone(result) : undefined };
    }
    if (url.pathname === '/api/wallet/practice-reset' && body)
      return this.mutate(body.actionId, { operation: 'reset', body }, () => {
        requireValue(!this.active(), 'blackjack_active', 'Сначала закончи раздачу', 409);
        this.adjust(CREDIT - this.data.balance);
        this.data.resetAt = this.now();
        return { reset: true };
      });
    throw new PracticeError('not_found', 'Маршрут не найден', 404);
  }
}
