import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { GameStore } from '../server/store.js';

test('SQLite persists the session, ledger and idempotency response across a server restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aubeig-games-')),
    path = join(dir, 'test.sqlite');
  let store = new GameStore(path);
  try {
    const login = store.guest(),
      fair = store.fairness(login.session.userId);
    const request = {
      actionId: randomUUID(),
      clientSeed: 'persistence',
      nonce: fair.nonce,
      commit: fair.nextHash,
      betMinor: 1000,
      parameters: { rows: 12, risk: 'medium' },
    };
    const result = store.play(login.session.userId, 'plinko', request);
    store.close();
    store = new GameStore(path);
    const session = store.session(login.token);
    assert(session);
    assert.deepEqual(store.play(session.userId, 'plinko', request), result);
    assert.equal(store.snapshot(session).wallet.balanceMinor, result.wallet.balanceMinor);
    assert.equal(store.history(session.userId).length, 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
