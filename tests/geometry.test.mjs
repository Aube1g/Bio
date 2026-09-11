import test from 'node:test';
import assert from 'node:assert/strict';
import { plinkoGeometry, plinkoTrajectory, plinkoPosition } from '../assets/games/plinko-path.js';
import { GameStore } from '../server/store.js';
import { verifyRound } from '../assets/games/verify.js';
import { randomUUID } from 'node:crypto';

test('Plinko geometry: every path ends at its paid bin, with no peg penetration', () => {
  for (const rows of [8, 12, 16])
    for (const [width, height] of [
      [280, 311],
      [400, 324],
      [950, 470],
    ]) {
      const geometry = plinkoGeometry(rows, width, height);
      for (const path of [
        Array(rows).fill(0),
        Array(rows).fill(1),
        Array.from({ length: rows }, (_, i) => i % 2),
        Array.from({ length: rows }, (_, i) => Number(i % 3 === 0)),
      ]) {
        const trajectory = plinkoTrajectory(path, geometry),
          slot = path.reduce((sum, bit) => sum + bit, 0);
        const final = plinkoPosition(trajectory, trajectory.duration + 1);
        assert.equal(final.x, geometry.bins[slot].x);
        assert.equal(final.y, geometry.bins[slot].y);
        assert(final.done);
        for (let time = 0; time < trajectory.duration; time += 1 / 120) {
          const position = plinkoPosition(trajectory, time);
          assert(position.x >= 0 && position.x <= width && position.y >= 0 && position.y <= height);
          for (const row of geometry.pegs)
            for (const peg of row) {
              const distance = Math.hypot(position.x - peg.x, position.y - peg.y);
              assert(
                distance >= geometry.ballRadius + geometry.pegRadius - 0.05,
                JSON.stringify({ rows, width, height, time, position, peg, distance }),
              );
            }
        }
        const resized = plinkoTrajectory(path, plinkoGeometry(rows, width * 0.75, height * 0.85));
        assert.equal(resized.duration, trajectory.duration);
        assert.equal(resized.slot, trajectory.slot);
        for (const bin of geometry.bins)
          assert(bin.x - geometry.gap / 2 >= 0 && bin.x + geometry.gap / 2 <= width);
      }
    }
});

test('Browser verifier reproduces all game receipts and rejects edited values', async () => {
  const store = new GameStore(':memory:');
  try {
    const { session } = store.guest(),
      user = session.userId;
    for (const game of ['dice', 'slots', 'plinko', 'blackjack']) {
      const fair = store.fairness(user);
      let receipt = store.play(user, game, {
        actionId: randomUUID(),
        betMinor: 1000,
        parameters:
          game === 'dice'
            ? { mode: 'under', target: 4 }
            : game === 'plinko'
              ? { rows: 16, risk: 'high' }
              : {},
        clientSeed: 'browser-test',
        commit: fair.nextHash,
        nonce: fair.nonce,
      });
      if (receipt.round.status === 'active')
        receipt = store.blackjackAction(user, receipt.round.id, {
          actionId: randomUUID(),
          action: 'stand',
          version: 0,
        });
      assert(await verifyRound(receipt.round), game);
      assert.equal(
        await verifyRound({ ...receipt.round, payoutMinor: receipt.round.payoutMinor + 1 }),
        false,
      );
      assert.equal(
        await verifyRound({ ...receipt.round, proof: { ...receipt.round.proof, hash: '0'.repeat(64) } }),
        false,
      );
    }
  } finally {
    store.close();
  }
});
