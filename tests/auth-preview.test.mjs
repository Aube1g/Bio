import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { configuration } from '../server/config.js';

async function fixture(embeddedPreview) {
  const app = createApp(
    configuration({ DATABASE_PATH: ':memory:', EMBEDDED_PREVIEW: String(embeddedPreview) }),
  );
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (path, { body, token, csrf, cookie } = {}) => {
    const response = await fetch(base + path, {
      method: body ? 'POST' : 'GET',
      headers: {
        ...(body ? { 'Content-Type': 'application/json', Origin: base } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return {
      status: response.status,
      body: await response.json(),
      cookie: response.headers.get('set-cookie')?.split(';')[0],
    };
  };
  return {
    call,
    async close() {
      await new Promise((resolve) => app.server.close(resolve));
      app.store.close();
    },
  };
}

test('Embedded guest survives blocked cookies, plays with CSRF, and logs out', async () => {
  const app = await fixture(true);
  try {
    const first = await app.call('/api/auth/guest', { body: {} });
    assert.equal(first.status, 201);
    assert.match(first.body.sessionToken, /^[a-f0-9]{64}$/);
    const token = first.body.sessionToken;
    const restored = await app.call('/api/session', { token });
    assert.equal(restored.body.user.id, first.body.user.id);
    const repeat = await app.call('/api/auth/guest', { token, body: {} });
    assert.equal(repeat.status, 200);
    assert.equal(repeat.body.user.id, first.body.user.id);
    const action = {
      actionId: randomUUID(),
      betMinor: 1000,
      parameters: { mode: 'under', target: 4 },
      commit: first.body.fairness.nextHash,
      nonce: first.body.fairness.nonce,
      clientSeed: 'guest-preview',
    };
    assert.equal((await app.call('/api/games/dice', { token, body: action })).status, 403);
    const play = await app.call('/api/games/dice', { token, csrf: first.body.csrf, body: action });
    assert.equal(play.status, 200);
    assert.equal(play.body.wallet.balanceMinor, 100000 - 1000 + play.body.round.payoutMinor);
    assert.equal((await app.call('/api/auth/logout', { token, csrf: 'é'.repeat(48), body: {} })).status, 403);
    assert.equal(
      (await app.call('/api/auth/logout', { token, csrf: first.body.csrf, body: {} })).status,
      200,
    );
    assert.equal((await app.call('/api/session', { token })).body.user, null);
  } finally {
    await app.close();
  }
});

test('Normal deployments do not expose preview tokens; HttpOnly cookie takes precedence', async () => {
  const normal = await fixture(false);
  try {
    const login = await normal.call('/api/auth/guest', { body: {} });
    assert.equal(login.body.sessionToken, undefined);
    assert.equal(
      (await normal.call('/api/session', { cookie: login.cookie })).body.user.id,
      login.body.user.id,
    );
    assert.equal((await normal.call('/api/session', { token: login.cookie.split('=')[1] })).body.user, null);
  } finally {
    await normal.close();
  }
  const embedded = await fixture(true);
  try {
    const one = await embedded.call('/api/auth/guest', { body: {} });
    const two = await embedded.call('/api/auth/guest', { body: {} });
    const session = await embedded.call('/api/session', { cookie: two.cookie, token: one.body.sessionToken });
    assert.equal(session.body.user.id, two.body.user.id);
  } finally {
    await embedded.close();
  }
});
