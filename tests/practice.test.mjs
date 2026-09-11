import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PracticeStore } from '../assets/games/practice-store.js';
import { BrowserFairRandom, hashSeed } from '../assets/games/browser-random.js';
import { FairRandom, seedHash } from '../server/random.js';
import { verifyRound } from '../assets/games/verify.js';
import { richText } from '../assets/shared/rich-text.js';
import { TRANSITION_STYLES, normalizeTransition } from '../assets/shared/desktop-motion.js';
import { motionFrame } from '../assets/shared/motion-recipes.js';

const memory = () => {
  let text = null;
  return {
    get: () => text,
    set: (value) => {
      text = value;
    },
    clear: () => {
      text = null;
    },
  };
};
const options = (game) =>
  game === 'dice' ? { mode: 'under', target: 4 } : game === 'plinko' ? { rows: 16, risk: 'high' } : {};
async function play(store, game, parameters = options(game)) {
  const session = await store.call('/api/session');
  return store.call('/api/games/' + game, {
    actionId: randomUUID(),
    betMinor: 500,
    parameters,
    clientSeed: 'practice-tests',
    commit: session.fairness.nextHash,
    nonce: session.fairness.nonce,
  });
}

test('Portable SHA/HMAC randomness exactly matches Node for all games and rejection ranges', () => {
  for (const game of ['dice', 'plinko', 'slots', 'blackjack']) {
    const seed = 'portable-' + game;
    assert.equal(hashSeed(seed), seedHash(seed));
    const browser = new BrowserFairRandom(seed, 'client', 21, game),
      server = new FairRandom(seed, 'client', 21, game);
    for (let i = 0; i < 200; i++)
      assert.equal(browser.int(i % 3 === 0 ? 0x80000001 : 52), server.int(i % 3 === 0 ? 0x80000001 : 52));
  }
});

test('All four games work locally with verified receipts, exact balances and no backend dependency', async () => {
  const store = new PracticeStore({ persistence: memory() });
  assert.equal((await store.call('/api/session')).user, null);
  const start = await store.call('/api/auth/guest', {});
  assert.equal(start.user.local, true);
  assert.equal(start.wallet.balanceMinor, 100000);
  for (const game of ['dice', 'slots', 'plinko', 'blackjack']) {
    const before = (await store.call('/api/session')).wallet.balanceMinor;
    let result = await play(store, game);
    if (result.round.status === 'active')
      result = await store.call(`/api/blackjack/${result.round.id}/action`, {
        actionId: randomUUID(),
        version: 0,
        action: 'stand',
      });
    assert.equal(result.wallet.balanceMinor, before - result.round.betMinor + result.round.payoutMinor);
    assert(await verifyRound(result.round), game);
    assert.equal(result.round.proof.origin, 'local');
  }
});

test('Local Blackjack survives reload, hides unfinished cards/seed, doubles once and cannot be reset mid-hand', async () => {
  const persistence = memory();
  let store = new PracticeStore({ persistence });
  await store.call('/api/auth/guest', {});
  let hand;
  for (let i = 0; i < 20; i++) {
    hand = (await play(store, 'blackjack')).round;
    if (hand.status === 'active') break;
  }
  assert.equal(hand.status, 'active');
  assert.equal(hand.proof.serverSeed, undefined);
  assert.equal(hand.outcome.dealer[1], null);
  assert.equal(hand.privateState, undefined);
  const before = (await store.call('/api/session')).wallet.balanceMinor;
  store = new PracticeStore({ persistence });
  assert.equal((await store.call('/api/session')).activeBlackjack.id, hand.id);
  assert.equal((await store.call('/api/session')).wallet.balanceMinor, before);
  await assert.rejects(store.call('/api/wallet/practice-reset', { actionId: randomUUID() }), /раздачу/);
  const request = { actionId: randomUUID(), version: 0, action: 'double' };
  const result = await store.call(`/api/blackjack/${hand.id}/action`, request);
  assert.equal(result.round.betMinor, hand.betMinor * 2);
  assert.equal(result.round.status, 'settled');
  assert(await verifyRound(result.round));
  assert.deepEqual(await store.call(`/api/blackjack/${hand.id}/action`, request), result);
});

test('Local mutations are serialized and idempotent; invalid stakes leave the wallet untouched', async () => {
  const store = new PracticeStore({ persistence: memory() });
  const session = await store.call('/api/auth/guest', {});
  const request = {
    actionId: randomUUID(),
    betMinor: 1000,
    parameters: options('dice'),
    clientSeed: 'practice-tests',
    commit: session.fairness.nextHash,
    nonce: session.fairness.nonce,
  };
  const [one, two] = await Promise.all([
    store.call('/api/games/dice', request),
    store.call('/api/games/dice', request),
  ]);
  assert.deepEqual(one, two);
  assert.equal((await store.call('/api/session')).stats.rounds, 1);
  const unchanged = (await store.call('/api/session')).wallet.balanceMinor;
  await assert.rejects(store.call('/api/games/dice', { ...request, betMinor: 2000 }), /использован/);
  for (const bet of [0, -500, 599, 50001, Infinity, '1000'])
    await assert.rejects(
      store.call('/api/games/dice', { ...request, actionId: randomUUID(), betMinor: bet }),
    );
  assert.equal((await store.call('/api/session')).wallet.balanceMinor, unchanged);
});

test('Bounded local history retains lifetime statistics, and sign-out clears only that local session', async () => {
  const store = new PracticeStore({ persistence: memory() });
  await store.call('/api/auth/guest', {});
  for (let i = 0; i < 155; i++) await play(store, 'dice', { mode: 'under', target: 6 });
  const session = await store.call('/api/session');
  assert.equal(session.stats.rounds, 155);
  assert.equal(store.data.rounds.length, 150);
  const reset = await store.call('/api/wallet/practice-reset', { actionId: randomUUID() });
  assert.equal(reset.wallet.balanceMinor, 100000);
  await store.call('/api/auth/logout', {});
  assert.equal((await store.call('/api/session')).user, null);
});

test('Markdown accents never treat HTML as trusted content', () => {
  const rendered = richText('**Важно**: `process(&job)` через Telegram <img src=x onerror=alert(1)>');
  assert.match(rendered, /rich-emphasis/);
  assert.match(rendered, /inline-code/);
  assert.match(rendered, /inline-pill/);
  assert.doesNotMatch(rendered, /<img/);
  assert.match(rendered, /&lt;img/);
});

test('Star, Bloom, Orbit and Ribbon have distinct mid-frames; retired curtains migrate to Star', () => {
  assert(!TRANSITION_STYLES.includes('cascade'));
  assert(!TRANSITION_STYLES.includes('shutters'));
  assert.equal(normalizeTransition('cascade'), 'star');
  assert.equal(normalizeTransition('shutters'), 'star');
  const frames = TRANSITION_STYLES.map((effect) => motionFrame(effect, 300, 180, 0.45));
  assert.equal(new Set(frames.map((frame) => frame.path + frame.transform)).size, TRANSITION_STYLES.length);
  for (const effect of TRANSITION_STYLES)
    for (let i = 0; i <= 20; i++) {
      const frame = motionFrame(effect, 300, 180, i / 20);
      assert(frame.path.startsWith('M'));
      assert(!/NaN|Infinity/.test(frame.path));
    }
});
