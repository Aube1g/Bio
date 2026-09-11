import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { GameStore } from '../server/store.js';
import { FairRandom, seedHash } from '../server/random.js';
import { validateWidget, validateMiniApp } from '../server/telegram.js';
import { createApp } from '../server/app.js';
import { configuration } from '../server/config.js';
import {
  diceOdds,
  diceOutcome,
  slotsOutcome,
  SLOT_RTP,
  plinkoTable,
  plinkoRtp,
  plinkoOutcome,
  handValue,
  shuffledDeck,
  blackjackResult,
} from '../assets/shared/game-rules.js';

const storeFor = (fn) => {
  const store = new GameStore(':memory:');
  try {
    return fn(store);
  } finally {
    store.close();
  }
};
function request(store, userId, parameters = {}, betMinor = 1000) {
  const fair = store.fairness(userId);
  return {
    actionId: randomUUID(),
    clientSeed: 'tests',
    commit: fair.nextHash,
    nonce: fair.nonce,
    betMinor,
    parameters,
  };
}
function activeHand(store, userId) {
  let seed;
  for (let i = 0; i < 1000; i++) {
    seed = seedHash(`fixture-${i}`);
    const deck = shuffledDeck(new FairRandom(seed, 'tests', store.fairness(userId).nonce, 'blackjack'));
    if (handValue([deck[0], deck[2]]).total < 17 && !handValue([deck[1], deck[3]]).natural) break;
  }
  store.db.prepare('UPDATE users SET next_seed = ? WHERE id = ?').run(seed, userId);
  return store.play(userId, 'blackjack', request(store, userId));
}

test('Dice: all six faces and both strict comparisons match the displayed probability', () => {
  for (const mode of ['under', 'over'])
    for (let target = 1; target <= 6; target++) {
      const outcomes = Array.from({ length: 6 }, (_, face) => diceOutcome({ int: () => face }, mode, target));
      assert.equal(outcomes.filter((r) => r.win).length, diceOdds(mode, target).successfulFaces);
      assert.deepEqual(
        outcomes.map((r) => r.face),
        [1, 2, 3, 4, 5, 6],
      );
    }
});

test('Slots: independent reels, one payout, all 512 outcomes and exact theoretical return', () => {
  let total = 0;
  for (let a = 0; a < 8; a++)
    for (let b = 0; b < 8; b++)
      for (let c = 0; c < 8; c++) {
        const values = [a, b, c];
        const outcome = slotsOutcome({ int: () => values.shift() });
        total += outcome.multiplier;
        if (a !== b) assert.equal(outcome.multiplier, 0);
      }
  assert.equal(total / 512, SLOT_RTP);
  assert.equal(SLOT_RTP, 0.96484375);
});

test('Plinko: rows + 1 bins, symmetric tables, normalized risk, reachable corners', () => {
  for (const rows of [8, 12, 16])
    for (const risk of ['low', 'medium', 'high']) {
      const table = plinkoTable(rows, risk);
      assert.equal(table.length, rows + 1);
      assert.deepEqual(table, [...table].reverse());
      assert(plinkoRtp(rows, risk) <= 0.97000001);
      assert(plinkoRtp(rows, risk) > 0.95);
      for (const bit of [0, 1]) {
        const round = plinkoOutcome({ int: () => bit }, rows, risk);
        assert.equal(round.slot, bit * rows);
        assert.equal(round.multiplier, table[round.slot]);
      }
    }
});

test('Blackjack: aces, soft 17, 3:2, pushes and bust ordering', () => {
  assert.deepEqual(handValue([0, 5]), { total: 17, soft: true, natural: false });
  assert.equal(handValue([0, 13, 8]).total, 21);
  assert.equal(handValue([0, 12, 9]).total, 21);
  assert.equal(blackjackResult([0, 12], [13, 25], 1000).payoutMinor, 1000);
  assert.equal(blackjackResult([0, 12], [9, 7], 1000).payoutMinor, 2500);
  assert.equal(blackjackResult([9, 9, 9], [9, 9, 9], 1000).payoutMinor, 0);
});

test('Randomness: deterministic domain separation and rejection sampling', () => {
  const a = new FairRandom('seed', 'client', 4, 'dice'),
    b = new FairRandom('seed', 'client', 4, 'dice');
  assert.deepEqual(
    Array.from({ length: 100 }, () => a.int(6)),
    Array.from({ length: 100 }, () => b.int(6)),
  );
  assert.notEqual(
    new FairRandom('seed', 'client', 4, 'slots').uint32(),
    new FairRandom('seed', 'client', 4, 'dice').uint32(),
  );
  const rng = new FairRandom('a', 'b', 0, 'x');
  rng.buffer = Buffer.alloc(8);
  rng.buffer.writeUInt32BE(0xffffffff);
  rng.buffer.writeUInt32BE(5, 4);
  assert.equal(rng.int(6), 5);
});

test('Atomic wallet, idempotency and commitment are authoritative on the server', () =>
  storeFor((store) => {
    const { session } = store.guest(),
      id = session.userId;
    const bet = request(store, id, { rows: 12, risk: 'high' });
    const result = store.play(id, 'plinko', bet);
    assert.deepEqual(store.play(id, 'plinko', bet), result);
    assert.equal(store.fairness(id).nonce, 1);
    assert.equal(store.wallet.read(id).balanceMinor, 100_000 - bet.betMinor + result.round.payoutMinor);
    assert.equal(seedHash(result.round.proof.serverSeed), bet.commit);
    assert.throws(
      () => store.play(id, 'dice', bet),
      (e) => e.code === 'request_conflict',
    );
    const ledger = store.db.prepare('SELECT SUM(delta) AS total FROM ledger WHERE user_id = ?').get(id);
    assert.equal(ledger.total, store.wallet.read(id).balanceMinor);
  }));

test('Invalid stakes, stale seeds and insufficient funds never change the ledger', () =>
  storeFor((store) => {
    const { session } = store.guest(),
      id = session.userId;
    for (const bet of [0, -1, 1.5, 501, 50001, '1000', Infinity])
      assert.throws(() => store.play(id, 'dice', request(store, id, { mode: 'under', target: 4 }, bet)));
    const bad = request(store, id, { mode: 'over', target: 6 });
    assert.throws(() => store.play(id, 'dice', bad));
    const stale = { ...request(store, id), commit: 'x' };
    assert.throws(() => store.play(id, 'slots', stale));
    assert.equal(store.fairness(id).nonce, 0);
    assert.equal(store.wallet.read(id).balanceMinor, 100_000);
    store.wallet.adjust(id, -100_000, 'fixture');
    assert.equal(store.snapshot(session).wallet.balanceMinor, 0);
    assert.throws(
      () => store.play(id, 'slots', request(store, id)),
      (e) => e.code === 'insufficient_balance',
    );
    assert.equal(store.wallet.read(id).balanceMinor, 0);
  }));

test('Blackjack: hidden seed/deck, resume, no mid-hand refund, safe double and once-only settlement', () =>
  storeFor((store) => {
    const { session } = store.guest(),
      id = session.userId;
    const start = activeHand(store, id);
    const round = start.round;
    assert.equal(round.status, 'active');
    assert.equal(round.proof.serverSeed, undefined);
    assert.equal(round.outcome.dealer[1], null);
    assert(!('deck' in round.outcome));
    assert.equal(store.snapshot(session).activeBlackjack.id, round.id);
    assert.throws(
      () => store.resetPractice(id, { actionId: randomUUID() }),
      (e) => e.code === 'blackjack_active',
    );
    assert.throws(
      () => store.play(id, 'blackjack', request(store, id)),
      (e) => e.code === 'blackjack_active',
    );
    const action = { actionId: randomUUID(), action: 'double', version: 0 };
    const end = store.blackjackAction(id, round.id, action);
    assert.equal(end.round.betMinor, 2000);
    assert.equal(end.round.outcome.player.length, 3);
    assert.equal(end.round.status, 'settled');
    assert.equal(seedHash(end.round.proof.serverSeed), round.proof.hash);
    assert.deepEqual(store.blackjackAction(id, round.id, action), end);
    assert.throws(
      () => store.blackjackAction(id, round.id, { ...action, actionId: randomUUID() }),
      (e) => e.code === 'round_changed',
    );
    assert.equal(store.wallet.read(id).balanceMinor, 100_000 - 2000 + end.round.payoutMinor);
  }));

test('Per-account isolation and logout invalidation', () =>
  storeFor((store) => {
    const a = store.guest(),
      b = store.guest();
    const round = store.play(a.session.userId, 'slots', request(store, a.session.userId)).round;
    assert.throws(
      () => store.round(b.session.userId, round.id),
      (e) => e.status === 404,
    );
    store.logout(a.session);
    assert.equal(store.session(a.token), null);
    assert(store.session(b.token));
  }));

const testToken = '123456:unit-test-token-not-a-real-secret';
function widgetFixture(now = 10000) {
  const data = { id: '456', first_name: 'Тест', username: 'tester', auth_date: String(now) };
  const check = Object.entries(data)
    .sort()
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  data.hash = createHmac('sha256', createHash('sha256').update(testToken).digest())
    .update(check)
    .digest('hex');
  return data;
}

test('Telegram: real HMAC signatures, freshness, spoofing rejection and one-time assertions', () => {
  const data = widgetFixture();
  const user = validateWidget(data, testToken, 10000);
  assert.equal(user.telegramId, '456');
  assert.throws(() => validateWidget({ ...data, id: '1' }, testToken, 10000));
  assert.throws(() => validateWidget(data, testToken, 10400));
  assert.throws(() => validateWidget(data, testToken, 9900));
  storeFor((store) => {
    const login = store.telegram(user);
    assert.equal(store.snapshot(login.session).user.kind, 'telegram');
    assert.throws(
      () => store.telegram(user),
      (e) => e.code === 'auth_replayed',
    );
  });
});

test('Telegram Mini Apps use the WebAppData HMAC, not the widget key', () => {
  const params = new URLSearchParams({
    auth_date: '10000',
    query_id: 'fixture',
    user: JSON.stringify({ id: 42, first_name: 'Mini' }),
  });
  const check = [...params]
    .sort()
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(testToken).digest();
  params.set('hash', createHmac('sha256', secret).update(check).digest('hex'));
  assert.equal(validateMiniApp(params.toString(), testToken, 10000).telegramId, '42');
  assert.throws(() => validateMiniApp(params.toString().replace('10000', '10001'), testToken, 10000));
});

test('HTTP: guest cookie, CSRF, origin checks, idempotent games and protected server files', async () => {
  const app = createApp(configuration({ DATABASE_PATH: ':memory:', PORT: '0' }));
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    assert.equal((await fetch(base + '/api/session').then((r) => r.json())).user, null);
    const guest = await fetch(base + '/api/auth/guest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base },
      body: '{}',
    });
    const session = await guest.json();
    const setCookie = guest.headers.get('set-cookie');
    assert.match(setCookie, /HttpOnly/);
    const cookie = setCookie.split(';')[0];
    const headers = { 'Content-Type': 'application/json', Origin: base, Cookie: cookie };
    assert.equal(
      (await fetch(base + '/api/games/dice', { method: 'POST', headers, body: '{}' })).status,
      403,
    );
    headers['X-CSRF-Token'] = session.csrf;
    assert.equal(
      (
        await fetch(base + '/api/games/dice', {
          method: 'POST',
          headers: { ...headers, Origin: 'https://evil.example' },
          body: '{}',
        })
      ).status,
      403,
    );
    const body = JSON.stringify({
      actionId: randomUUID(),
      betMinor: 1000,
      parameters: { mode: 'under', target: 4 },
      clientSeed: 'http',
      commit: session.fairness.nextHash,
      nonce: session.fairness.nonce,
    });
    const [a, b] = await Promise.all(
      [1, 2].map(() =>
        fetch(base + '/api/games/dice', { method: 'POST', headers, body }).then((r) => r.json()),
      ),
    );
    assert.equal(a.round.id, b.round.id);
    assert.equal((await fetch(base + '/server/store.js')).status, 404);
    assert.equal((await fetch(base + '/.env')).status, 404);
    assert.equal(
      (await fetch(base + '/api/auth/telegram/start', { method: 'POST', headers, body: '{}' })).status,
      503,
    );
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    app.store.close();
  }
});

test('History cursors traverse every round without duplicates and remain account-bound', () =>
  storeFor((store) => {
    const a = store.guest(),
      b = store.guest();
    for (let i = 0; i < 35; i++)
      store.play(a.session.userId, 'slots', request(store, a.session.userId, {}, 500));
    const first = store.historyPage(a.session.userId),
      second = store.historyPage(a.session.userId, first.nextCursor);
    assert.equal(first.rounds.length, 30);
    assert.equal(second.rounds.length, 5);
    assert.equal(second.nextCursor, null);
    assert.equal(new Set([...first.rounds, ...second.rounds].map((r) => r.id)).size, 35);
    assert.throws(
      () => store.historyPage(b.session.userId, first.nextCursor),
      (e) => e.code === 'invalid_cursor',
    );
  }));
