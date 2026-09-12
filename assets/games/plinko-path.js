// The server chooses the route. Geometry only visualizes those same left/right decisions.
export function plinkoGeometry(rows, width, height) {
  if (
    ![8, 12, 16].includes(rows) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width < 100 ||
    height < 120
  )
    throw new RangeError('Invalid Plinko dimensions');
  const padding = Math.min(22, width * 0.06);
  const top = 42;
  const rowGap = (height - top - 70) / rows;
  // Keep the triangle proportional on wide monitors instead of stretching every bounce.
  const gap = Math.min((width - padding * 2) / (rows + 2), rowGap / 0.8);
  const pegRadius = Math.min(3.8, Math.max(1.45, gap * 0.1));
  const ballRadius = Math.min(6.5, Math.max(2.1, gap * 0.19));
  const pegs = Array.from({ length: rows }, (_, row) =>
    Array.from({ length: row + 1 }, (_, col) => ({
      x: width / 2 + (col - row / 2) * gap,
      y: top + row * rowGap,
      row,
      col,
    })),
  );
  const guidePegs = pegs.flatMap((row) => [
    { ...row[0], x: row[0].x - gap },
    { ...row.at(-1), x: row.at(-1).x + gap },
  ]);
  const bins = Array.from({ length: rows + 1 }, (_, slot) => ({
    x: width / 2 + (slot - rows / 2) * gap,
    y: height - 18,
    slot,
  }));
  return { width, height, gap, top, rowGap, pegs, guidePegs, bins, pegRadius, ballRadius };
}

function seedNumber(seed) {
  let value = 2166136261;
  for (const char of String(seed)) value = Math.imul(value ^ char.charCodeAt(0), 16777619);
  return value >>> 0;
}

export function plinkoTrajectory(directions, geometry, seed = 0) {
  if (directions.length !== geometry.pegs.length || !directions.every((bit) => bit === 0 || bit === 1))
    throw new RangeError('Invalid Plinko route');
  let col = 0;
  const lift = geometry.pegRadius + geometry.ballRadius;
  const salt = seedNumber(seed);
  const noise = (index) => Math.sin((salt % 1021) + index * 2.39996);
  const points = [{ x: geometry.width / 2 + noise(0) * geometry.gap * 0.1, y: 7, peg: null }];
  for (let row = 0; row < directions.length; row++) {
    const peg = geometry.pegs[row][col];
    const offset = noise(row + 1) * lift * 0.1;
    points.push({ x: peg.x + offset, y: peg.y - Math.sqrt(lift * lift - offset * offset), peg });
    col += directions[row];
  }
  const last = points.at(-1);
  points.push({ x: geometry.bins[col].x, y: last.y + geometry.rowGap, peg: null });
  points.push({ ...geometry.bins[col], peg: null });
  const steps = [];
  let start = 0;
  for (let i = 1; i < points.length; i++) {
    const duration = i === 1 ? 0.34 : i === points.length - 1 ? 0.24 : 0.185 + (noise(i + 3) + 1) * 0.012;
    const kick = points[i - 1].peg ? -(points[i].y - points[i - 1].y) * (1.05 + (noise(i) + 1) * 0.035) : 0;
    steps.push({ from: points[i - 1], to: points[i], start, duration, kick });
    start += duration;
  }
  return { steps, duration: start, slot: col };
}

export function plinkoPosition(trajectory, elapsed) {
  if (elapsed >= trajectory.duration) {
    const end = trajectory.steps.at(-1).to;
    return { x: end.x, y: end.y, step: trajectory.steps.length - 1, done: true };
  }
  const index = trajectory.steps.findIndex((item) => elapsed < item.start + item.duration);
  const stepIndex = index < 0 ? trajectory.steps.length - 1 : index;
  const step = trajectory.steps[stepIndex];
  const t = Math.max(0, Math.min(1, (elapsed - step.start) / step.duration));
  return {
    x: step.from.x + (step.to.x - step.from.x) * t,
    y: step.from.y + step.kick * t + (step.to.y - step.from.y - step.kick) * t * t,
    step: stepIndex,
    done: elapsed >= trajectory.duration,
  };
}
