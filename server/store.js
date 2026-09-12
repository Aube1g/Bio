import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { ApiError, requireValue } from './errors.js';
import { FairRandom, newSeed, seedHash } from './random.js';
import { LocalWallet, PRACTICE_CREDIT } from './wallet/local.js';
import {
  MIN_BET,
  MAX_BET,
  GAME_IDS,
  diceOdds,
  diceOutcome,
  slotsOutcome,
  plinkoOutcome,
  handValue,
  shuffledDeck,
  blackjackResult,
  payout,
} from '../assets/shared/game-rules.js';

const digest = (text) => createHash('sha256').update(text).digest('hex');
const json = JSON.stringify;

export class GameStore {
  constructor(filename) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, telegram_id TEXT UNIQUE, name TEXT NOT NULL, username TEXT NOT NULL DEFAULT '',
        balance INTEGER NOT NULL DEFAULT 0 CHECK(balance >= 0), revision INTEGER NOT NULL DEFAULT 0,
        next_seed TEXT NOT NULL, nonce INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), csrf TEXT NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS login_assertions (fingerprint TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS rounds (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), game TEXT NOT NULL, status TEXT NOT NULL,
        bet INTEGER NOT NULL, payout INTEGER NOT NULL DEFAULT 0, parameters TEXT NOT NULL, outcome TEXT NOT NULL,
        private_state TEXT, server_seed TEXT NOT NULL, client_seed TEXT NOT NULL, seed_hash TEXT NOT NULL, nonce INTEGER NOT NULL,
        version INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, settled_at INTEGER
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_blackjack ON rounds(user_id) WHERE game = 'blackjack' AND status = 'active';
      CREATE INDEX IF NOT EXISTS round_history ON rounds(user_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS ledger (
        id INTEGER PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), round_id TEXT REFERENCES rounds(id),
        delta INTEGER NOT NULL, reason TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS requests (
        user_id TEXT NOT NULL REFERENCES users(id), request_key TEXT NOT NULL, body_hash TEXT NOT NULL,
        response TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(user_id, request_key)
      );
    `);
    this.wallet = new LocalWallet(this.db);
  }

  close() {
    this.db.close();
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  createUser(name, telegramId = null, username = '') {
    const id = randomUUID();
    this.db
      .prepare(
        'INSERT INTO users(id, telegram_id, name, username, next_seed, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(id, telegramId, name, username, newSeed(), Date.now());
    this.wallet.adjust(id, PRACTICE_CREDIT, 'practice_grant');
    return id;
  }

  createSession(userId) {
    const token = randomBytes(32).toString('hex');
    this.db
      .prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)')
      .run(digest(token), userId, randomBytes(24).toString('hex'), Date.now() + 30 * 86400_000);
    return { token, session: this.session(token) };
  }

  guest() {
    return this.transaction(() => this.createSession(this.createUser('Гость')));
  }

  telegram(profile) {
    return this.transaction(() => {
      this.db.prepare('DELETE FROM login_assertions WHERE expires_at < ?').run(Date.now());
      requireValue(
        !this.db.prepare('SELECT 1 FROM login_assertions WHERE fingerprint = ?').get(profile.fingerprint),
        401,
        'auth_replayed',
        'Открой вход через Telegram ещё раз',
      );
      this.db
        .prepare('INSERT INTO login_assertions VALUES (?, ?)')
        .run(profile.fingerprint, Date.now() + 10 * 60_000);
      let user = this.db.prepare('SELECT id FROM users WHERE telegram_id = ?').get(profile.telegramId);
      if (!user) user = { id: this.createUser(profile.name, profile.telegramId, profile.username) };
      else
        this.db
          .prepare('UPDATE users SET name = ?, username = ? WHERE id = ?')
          .run(profile.name, profile.username, user.id);
      return this.createSession(user.id);
    });
  }

  session(token) {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;
    return (
      this.db
        .prepare(
          'SELECT user_id AS userId, csrf, token_hash AS tokenHash FROM sessions WHERE token_hash = ? AND expires_at > ?',
        )
        .get(digest(token), Date.now()) || null
    );
  }

  logout(session) {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(session.tokenHash);
  }

  fairness(userId) {
    const user = this.db.prepare('SELECT next_seed, nonce FROM users WHERE id = ?').get(userId);
    return { nextHash: seedHash(user.next_seed), nonce: user.nonce };
  }

  stats(userId) {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS rounds, COALESCE(SUM(payout > bet), 0) AS wins,
      COALESCE(SUM(payout < bet), 0) AS losses, COALESCE(SUM(payout = bet), 0) AS pushes,
      COALESCE(SUM(payout - bet), 0) AS netMinor, COALESCE(MAX(payout), 0) AS bestPayoutMinor
      FROM rounds WHERE user_id = ? AND status = 'settled'`,
      )
      .get(userId);
    return { ...row, winRate: row.rounds ? Math.round((row.wins / row.rounds) * 100) : 0 };
  }

  activeBlackjack(userId) {
    const row = this.db
      .prepare("SELECT * FROM rounds WHERE user_id = ? AND game = 'blackjack' AND status = 'active'")
      .get(userId);
    return row ? this.publicRound(row) : null;
  }

  snapshot(session) {
    const user = this.db
      .prepare('SELECT id, telegram_id, name, username FROM users WHERE id = ?')
      .get(session.userId);
    return {
      user: {
        id: user.id,
        kind: user.telegram_id ? 'telegram' : 'guest',
        name: user.name,
        username: user.username,
      },
      csrf: session.csrf,
      wallet: this.wallet.read(user.id),
      fairness: this.fairness(user.id),
      stats: this.stats(user.id),
      activeBlackjack: this.activeBlackjack(user.id),
      history: this.history(user.id, 12),
    };
  }

  publicRound(row) {
    let outcome = JSON.parse(row.outcome);
    if (row.game === 'blackjack') {
      const state = JSON.parse(row.private_state);
      const active = row.status === 'active';
      outcome = {
        ...outcome,
        player: state.player,
        dealer: active ? [state.dealer[0], null] : state.dealer,
        playerValue: handValue(state.player),
        dealerValue: handValue(active ? [state.dealer[0]] : state.dealer),
        canDouble: active && state.player.length === 2 && !state.doubled,
      };
    }
    return {
      id: row.id,
      game: row.game,
      status: row.status,
      betMinor: row.bet,
      payoutMinor: row.payout,
      netMinor: row.payout - row.bet,
      parameters: JSON.parse(row.parameters),
      outcome,
      version: row.version,
      createdAt: row.created_at,
      settledAt: row.settled_at,
      proof: {
        hash: row.seed_hash,
        clientSeed: row.client_seed,
        nonce: row.nonce,
        game: row.game,
        ...(row.status === 'settled' ? { serverSeed: row.server_seed } : {}),
      },
    };
  }

  history(userId, limit = 30) {
    return this.db
      .prepare('SELECT * FROM rounds WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?')
      .all(userId, limit)
      .map((row) => this.publicRound(row));
  }

  historyPage(userId, before = null) {
    let beforeRow = Number.MAX_SAFE_INTEGER;
    if (before) {
      const cursor = this.db
        .prepare('SELECT rowid AS rowNumber FROM rounds WHERE user_id = ? AND id = ?')
        .get(userId, before);
      requireValue(cursor, 400, 'invalid_cursor', 'Страница истории не найдена');
      beforeRow = cursor.rowNumber;
    }
    const rows = this.db
      .prepare('SELECT * FROM rounds WHERE user_id = ? AND rowid < ? ORDER BY rowid DESC LIMIT 31')
      .all(userId, beforeRow);
    const more = rows.length > 30;
    const page = rows.slice(0, 30);
    return { rounds: page.map((row) => this.publicRound(row)), nextCursor: more ? page.at(-1).id : null };
  }

  round(userId, id) {
    const row = this.db.prepare('SELECT * FROM rounds WHERE user_id = ? AND id = ?').get(userId, id);
    requireValue(row, 404, 'round_not_found', 'Партия не найдена');
    return this.publicRound(row);
  }

  request(userId, key) {
    const row = this.db
      .prepare('SELECT response FROM requests WHERE user_id = ? AND request_key = ?')
      .get(userId, key);
    return row ? JSON.parse(row.response) : null;
  }

  idempotent(userId, key, body, fn) {
    requireValue(
      typeof key === 'string' && /^[a-zA-Z0-9_-]{16,80}$/.test(key),
      400,
      'invalid_request_key',
      'Нужен идентификатор запроса',
    );
    const bodyHash = digest(json(body));
    return this.transaction(() => {
      const previous = this.db
        .prepare('SELECT body_hash, response FROM requests WHERE user_id = ? AND request_key = ?')
        .get(userId, key);
      if (previous) {
        requireValue(
          previous.body_hash === bodyHash,
          409,
          'request_conflict',
          'Этот запрос уже использован с другими параметрами',
        );
        return JSON.parse(previous.response);
      }
      const result = fn();
      const response = {
        ...result,
        wallet: this.wallet.read(userId),
        fairness: this.fairness(userId),
        stats: this.stats(userId),
        activeBlackjack: this.activeBlackjack(userId),
      };
      this.db
        .prepare('INSERT INTO requests VALUES (?, ?, ?, ?, ?)')
        .run(userId, key, bodyHash, json(response), Date.now());
      return response;
    });
  }

  validateBet(bet) {
    requireValue(
      Number.isSafeInteger(bet) && bet >= MIN_BET && bet <= MAX_BET && bet % 100 === 0,
      400,
      'invalid_bet',
      'Ставка: целое число от 5 до 500 фишек',
    );
  }

  play(userId, game, request) {
    requireValue(GAME_IDS.includes(game), 404, 'unknown_game', 'Игра не найдена');
    return this.idempotent(userId, request.actionId, { operation: 'play', game, request }, () => {
      this.validateBet(request.betMinor);
      requireValue(
        typeof request.clientSeed === 'string' && /^[a-zA-Z0-9 _-]{1,64}$/.test(request.clientSeed),
        400,
        'invalid_client_seed',
        'Некорректный client seed',
      );
      const user = this.db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
      requireValue(
        request.commit === seedHash(user.next_seed) && request.nonce === user.nonce,
        409,
        'stale_commit',
        'Счёт изменился в другой вкладке. Обнови состояние и повтори.',
      );
      requireValue(user.balance >= request.betMinor, 409, 'insufficient_balance', 'Недостаточно фишек');
      const parameters = request.parameters || {};
      let outcome = {},
        state = null,
        status = 'settled';
      const rng = new FairRandom(user.next_seed, request.clientSeed, user.nonce, game);
      let reward = 0;
      if (game === 'dice') {
        requireValue(
          ['under', 'over'].includes(parameters.mode) &&
            Number.isInteger(parameters.target) &&
            parameters.target >= 1 &&
            parameters.target <= 6 &&
            diceOdds(parameters.mode, parameters.target).successfulFaces > 0,
          400,
          'invalid_dice',
          'Выбери допустимый диапазон',
        );
        outcome = diceOutcome(rng, parameters.mode, parameters.target);
        reward = outcome.win ? payout(request.betMinor, outcome.multiplier) : 0;
      } else if (game === 'slots') {
        outcome = slotsOutcome(rng);
        reward = payout(request.betMinor, outcome.multiplier);
      } else if (game === 'plinko') {
        requireValue(
          [8, 12, 16].includes(parameters.rows) && ['low', 'medium', 'high'].includes(parameters.risk),
          400,
          'invalid_plinko',
          'Выбери ряды и риск',
        );
        outcome = plinkoOutcome(rng, parameters.rows, parameters.risk);
        reward = payout(request.betMinor, outcome.multiplier);
      } else {
        requireValue(
          !this.activeBlackjack(userId),
          409,
          'blackjack_active',
          'Сначала закончи текущую раздачу',
        );
        const deck = shuffledDeck(rng);
        state = { deck, cursor: 4, player: [deck[0], deck[2]], dealer: [deck[1], deck[3]], doubled: false };
        if (handValue(state.player).natural || handValue(state.dealer).natural) {
          const result = blackjackResult(state.player, state.dealer, request.betMinor);
          reward = result.payoutMinor;
          outcome = { reason: result.reason };
        } else status = 'active';
      }
      const id = randomUUID(),
        now = Date.now();
      this.db
        .prepare(
          `INSERT INTO rounds(id,user_id,game,status,bet,payout,parameters,outcome,private_state,server_seed,client_seed,seed_hash,nonce,created_at,settled_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          userId,
          game,
          status,
          request.betMinor,
          reward,
          json(parameters),
          json(outcome),
          state ? json(state) : null,
          user.next_seed,
          request.clientSeed,
          seedHash(user.next_seed),
          user.nonce,
          now,
          status === 'settled' ? now : null,
        );
      this.wallet.adjust(userId, -request.betMinor, 'wager', id);
      if (status === 'settled' && reward > 0) this.wallet.adjust(userId, reward, 'payout', id);
      this.db
        .prepare('UPDATE users SET next_seed = ?, nonce = nonce + 1 WHERE id = ?')
        .run(newSeed(), userId);
      return { round: this.round(userId, id) };
    });
  }

  blackjackAction(userId, id, request) {
    return this.idempotent(
      userId,
      request.actionId,
      { operation: 'blackjack_action', roundId: id, request },
      () => {
        const row = this.db
          .prepare("SELECT * FROM rounds WHERE user_id = ? AND id = ? AND game = 'blackjack'")
          .get(userId, id);
        requireValue(row, 404, 'round_not_found', 'Раздача не найдена');
        requireValue(
          row.status === 'active' && row.version === request.version,
          409,
          'round_changed',
          'Раздача уже изменилась. Обнови её.',
        );
        requireValue(
          ['hit', 'stand', 'double'].includes(request.action),
          400,
          'invalid_action',
          'Недопустимое действие',
        );
        const state = JSON.parse(row.private_state);
        if (request.action === 'double') {
          requireValue(
            state.player.length === 2 && !state.doubled,
            409,
            'double_unavailable',
            'Удвоение доступно только на первых двух картах',
          );
          this.wallet.adjust(userId, -row.bet, 'double_wager', id);
          row.bet *= 2;
          state.doubled = true;
        }
        if (request.action !== 'stand') state.player.push(state.deck[state.cursor++]);
        const end = request.action !== 'hit' || handValue(state.player).total >= 21;
        let result = { payoutMinor: 0, reason: '' };
        if (end) {
          if (handValue(state.player).total <= 21) {
            while (handValue(state.dealer).total < 17) state.dealer.push(state.deck[state.cursor++]);
          }
          result = blackjackResult(state.player, state.dealer, row.bet);
        }
        this.db
          .prepare(
            'UPDATE rounds SET status = ?, bet = ?, payout = ?, outcome = ?, private_state = ?, version = version + 1, settled_at = ? WHERE id = ?',
          )
          .run(
            end ? 'settled' : 'active',
            row.bet,
            result.payoutMinor,
            json({ reason: result.reason }),
            json(state),
            end ? Date.now() : null,
            id,
          );
        if (end && result.payoutMinor > 0) this.wallet.adjust(userId, result.payoutMinor, 'payout', id);
        return { round: this.round(userId, id) };
      },
    );
  }

  resetPractice(userId, request) {
    return this.idempotent(userId, request.actionId, { operation: 'practice_reset', request }, () => {
      requireValue(!this.activeBlackjack(userId), 409, 'blackjack_active', 'Сначала закончи раздачу');
      const recent = this.db
        .prepare("SELECT 1 FROM ledger WHERE user_id = ? AND reason = 'practice_reset' AND created_at > ?")
        .get(userId, Date.now() - 60_000);
      requireValue(!recent, 429, 'reset_limit', 'Следующее обновление счёта — через минуту');
      this.wallet.adjust(userId, PRACTICE_CREDIT - this.wallet.read(userId).balanceMinor, 'practice_reset');
      return { reset: true };
    });
  }
}
