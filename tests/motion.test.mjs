import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TRANSITION_STYLES,
  desktopMask,
  desktopTransform,
  workspaceProgress,
} from '../assets/shared/desktop-motion.js';
import { plinkoGeometry, plinkoTrajectory, plinkoPosition } from '../assets/games/plinko-path.js';

test('Compositor profiles: reversible direction, finite geometry, resting transforms', () => {
  assert(TRANSITION_STYLES.includes('hyprland') && TRANSITION_STYLES.includes('caelestia'));
  assert.equal(workspaceProgress(0), 0);
  assert.equal(workspaceProgress(1), 1);
  for (const mode of ['hyprland', 'caelestia'])
    for (const width of [250, 620, 1440])
      for (const direction of [-1, 1]) {
        const shapes = Array.from({ length: 21 }, (_, i) => desktopMask(mode, width, 500, i / 20, direction));
        assert(shapes.every((shape) => shape.startsWith('M') && !/NaN|Infinity/.test(shape)));
        assert(new Set(shapes).size > 10);
        assert(!/NaN|Infinity/.test(desktopTransform(mode, width, 0.35, direction)));
      }
  assert.notEqual(desktopTransform('hyprland', 600, 0.3, -1), desktopTransform('hyprland', 600, 0.3, 1));
});

test('Seeded Plinko routes: exact landing, guard-peg clearance and resize stability', () => {
  let seed = 21;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  for (const rows of [8, 12, 16])
    for (let trial = 0; trial < 24; trial++) {
      const geometry = plinkoGeometry(rows, trial % 2 ? 244 : 880, trial % 2 ? 345 : 450);
      const route = Array.from({ length: rows }, () => random() >>> 31);
      const salt = `ball-${trial}`;
      const trajectory = plinkoTrajectory(route, geometry, salt);
      const resized = plinkoTrajectory(route, plinkoGeometry(rows, 400, 370), salt);
      assert.equal(trajectory.duration, resized.duration);
      assert.equal(
        trajectory.slot,
        route.reduce((a, b) => a + b, 0),
      );
      for (let t = 0; t < trajectory.duration; t += 1 / 100) {
        const ball = plinkoPosition(trajectory, t);
        for (const peg of [...geometry.pegs.flat(), ...geometry.guidePegs]) {
          assert(
            Math.hypot(ball.x - peg.x, ball.y - peg.y) >= geometry.ballRadius + geometry.pegRadius - 0.06,
            JSON.stringify({ rows, trial, t }),
          );
        }
      }
      const final = plinkoPosition(trajectory, trajectory.duration);
      assert.equal(final.x, geometry.bins[trajectory.slot].x);
      assert.equal(final.y, geometry.bins[trajectory.slot].y);
    }
});
