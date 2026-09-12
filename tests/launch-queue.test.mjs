import test from 'node:test';
import assert from 'node:assert/strict';
import { LaunchQueue } from '../assets/games/launch-queue.js';

test('Batch submits one round at a time and reports the exact remaining count', async () => {
  const progress = [],
    calls = [];
  const queue = new LaunchQueue((state) =>
    progress.push({ running: state.running, remaining: state.remaining }),
  );
  let simultaneous = 0;
  const accepted = await queue.run(
    5,
    async (index) => {
      assert.equal(++simultaneous, 1);
      calls.push(index);
      await Promise.resolve();
      simultaneous--;
      return true;
    },
    { spacing: 0 },
  );
  assert.equal(accepted, 5);
  assert.deepEqual(calls, [0, 1, 2, 3, 4]);
  assert.equal(queue.running, false);
  assert.equal(queue.remaining, 0);
  assert(progress.some((state) => state.remaining === 3));
});

test('Leaving cancels only unsubmitted balls; the in-flight acceptance is not retried', async () => {
  const queue = new LaunchQueue();
  const calls = [];
  const accepted = await queue.run(
    8,
    async (index) => {
      calls.push(index);
      if (index === 1) queue.cancel();
      return true;
    },
    { spacing: 0 },
  );
  assert.equal(accepted, 2);
  assert.deepEqual(calls, [0, 1]);
  assert.equal(queue.running, false);
});

test('A failed receipt stops the batch; there is no next wager or automatic retry', async () => {
  const queue = new LaunchQueue(),
    calls = [];
  assert.equal(
    await queue.run(
      5,
      async (index) => {
        calls.push(index);
        return index < 2;
      },
      { spacing: 0 },
    ),
    2,
  );
  assert.deepEqual(calls, [0, 1, 2]);
  assert.equal(queue.running, false);
});

test('A second launch cannot overlap an active submission queue', async () => {
  const queue = new LaunchQueue();
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const first = queue.run(
    3,
    async () => {
      await blocked;
      return true;
    },
    { spacing: 0 },
  );
  assert.equal(await queue.run(3, async () => true), 0);
  release();
  assert.equal(await first, 3);
  for (const count of [0, 9, -1, 1.5, '3']) assert.equal(await queue.run(count, async () => true), 0);
});
