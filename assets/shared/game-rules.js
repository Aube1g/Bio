export const GAME_IDS = ['blackjack', 'slots', 'dice', 'plinko'];
export const MIN_BET = 500;
export const MAX_BET = 50_000;
export const SLOT_SYMBOLS = ['cherry', 'lemon', 'bell', 'clover', 'star', 'gem', 'seven', 'meteor'];
export const SLOT_TRIPLES = [6, 8, 10, 16, 24, 40, 100, 192];
export const SLOT_PAIR = 1.75;
export const SLOT_RTP = (SLOT_TRIPLES.reduce((a, b) => a + b, 0) + 56 * SLOT_PAIR) / 512;

export function diceOdds(mode, target) {
  const successfulFaces = mode === 'under' ? target - 1 : 6 - target;
  return {
    successfulFaces,
    chance: successfulFaces / 6,
    multiplier: successfulFaces > 0 ? 5.88 / successfulFaces : 0,
  };
}

export function diceOutcome(random, mode, target) {
  const face = random.int(6) + 1;
  const odds = diceOdds(mode, target);
  return { face, mode, target, win: mode === 'under' ? face < target : face > target, ...odds };
}

export function slotsOutcome(random) {
  const symbols = Array.from({ length: 3 }, () => random.int(SLOT_SYMBOLS.length));
  const triple = symbols.every((symbol) => symbol === symbols[0]);
  const pair = symbols[0] === symbols[1];
  const multiplier = triple ? SLOT_TRIPLES[symbols[0]] : pair ? SLOT_PAIR : 0;
  return { symbols, multiplier, combination: triple ? 'triple' : pair ? 'pair' : 'none' };
}

export function binomial(n, k) {
  let result = 1;
  for (let i = 1; i <= Math.min(k, n - k); i++) result = (result * (n - i + 1)) / i;
  return result;
}

const PLINKO_WEIGHTS = {
  8: {
    low: [5.6, 2.1, 1.1, 1, 0.5, 1, 1.1, 2.1, 5.6],
    medium: [13, 3, 1.3, 0.7, 0.4, 0.7, 1.3, 3, 13],
    high: [29, 4, 1.5, 0.3, 0.2, 0.3, 1.5, 4, 29],
  },
  12: {
    low: [10, 3, 1.6, 1.4, 1.1, 1, 0.5, 1, 1.1, 1.4, 1.6, 3, 10],
    medium: [33, 11, 4, 2, 1.1, 0.5, 0.3, 0.5, 1.1, 2, 4, 11, 33],
    high: [170, 24, 8.1, 2, 0.7, 0.2, 0.2, 0.2, 0.7, 2, 8.1, 24, 170],
  },
  16: {
    low: [16, 9, 2, 1.4, 1.4, 1.2, 1.1, 1, 0.5, 1, 1.1, 1.2, 1.4, 1.4, 2, 9, 16],
    medium: [110, 41, 10, 5, 3, 1.5, 1, 0.5, 0.3, 0.5, 1, 1.5, 3, 5, 10, 41, 110],
    high: [1000, 130, 26, 9, 4, 2, 0.2, 0.2, 0.2, 0.2, 0.2, 2, 4, 9, 26, 130, 1000],
  },
};

export function plinkoTable(rows, risk) {
  const weights = PLINKO_WEIGHTS[rows]?.[risk];
  if (!weights) throw new RangeError('Unknown Plinko configuration');
  const expectation = weights.reduce((sum, value, k) => sum + (value * binomial(rows, k)) / 2 ** rows, 0);
  // Normalize each risk profile, then use the exact displayed two-decimal multipliers.
  return weights.map((value) => Math.floor(((value * 0.97) / expectation) * 100) / 100);
}

export function plinkoRtp(rows, risk) {
  return plinkoTable(rows, risk).reduce((sum, value, k) => sum + (value * binomial(rows, k)) / 2 ** rows, 0);
}

export function plinkoOutcome(random, rows, risk) {
  const directions = Array.from({ length: rows }, () => random.int(2));
  const slot = directions.reduce((sum, bit) => sum + bit, 0);
  return { directions, slot, rows, risk, multiplier: plinkoTable(rows, risk)[slot] };
}

export function handValue(cards) {
  let total = 0,
    aces = 0;
  for (const card of cards) {
    const rank = card % 13;
    if (rank === 0) {
      total += 11;
      aces++;
    } else total += Math.min(rank + 1, 10);
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces--;
  }
  return { total, soft: aces > 0, natural: cards.length === 2 && total === 21 };
}

export function shuffledDeck(random) {
  const deck = Array.from({ length: 52 }, (_, index) => index);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = random.int(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

export function blackjackResult(player, dealer, betMinor) {
  const p = handValue(player),
    d = handValue(dealer);
  if (p.natural && d.natural) return { payoutMinor: betMinor, reason: 'push' };
  if (p.natural) return { payoutMinor: Math.floor((betMinor * 5) / 2), reason: 'blackjack' };
  if (d.natural) return { payoutMinor: 0, reason: 'dealer_blackjack' };
  if (p.total > 21) return { payoutMinor: 0, reason: 'bust' };
  if (d.total > 21) return { payoutMinor: betMinor * 2, reason: 'dealer_bust' };
  if (p.total > d.total) return { payoutMinor: betMinor * 2, reason: 'win' };
  if (p.total === d.total) return { payoutMinor: betMinor, reason: 'push' };
  return { payoutMinor: 0, reason: 'loss' };
}

export function payout(betMinor, multiplier) {
  return Math.floor((betMinor * Math.round(multiplier * 10_000)) / 10_000);
}
