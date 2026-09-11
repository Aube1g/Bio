import { requireValue } from '../errors.js';

export const PRACTICE_CREDIT = 100_000;

// Money is always an integer number of hundredths. Calls belong to the caller's SQL transaction.
export class LocalWallet {
  constructor(db) {
    this.db = db;
  }

  adjust(userId, delta, reason, roundId = null) {
    requireValue(Number.isSafeInteger(delta), 400, 'invalid_amount', 'Некорректная сумма');
    const account = this.db.prepare('SELECT balance, revision FROM users WHERE id = ?').get(userId);
    requireValue(account && account.balance + delta >= 0, 409, 'insufficient_balance', 'Недостаточно фишек');
    requireValue(
      Number.isSafeInteger(account.balance + delta),
      409,
      'balance_limit',
      'Достигнут предел счёта',
    );
    if (delta !== 0) {
      this.db
        .prepare('UPDATE users SET balance = balance + ?, revision = revision + 1 WHERE id = ?')
        .run(delta, userId);
      this.db
        .prepare('INSERT INTO ledger(user_id, round_id, delta, reason, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(userId, roundId, delta, reason, Date.now());
    }
    return this.read(userId);
  }

  read(userId) {
    const row = this.db.prepare('SELECT balance, revision FROM users WHERE id = ?').get(userId);
    return { balanceMinor: row.balance, revision: row.revision, currency: 'practice', decimals: 2 };
  }
}
