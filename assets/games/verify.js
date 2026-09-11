import {
  diceOutcome,
  slotsOutcome,
  plinkoOutcome,
  shuffledDeck,
  blackjackResult,
  handValue,
  payout,
} from '../shared/game-rules.js';
const text = new TextEncoder();
const hex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
async function randomFor(proof) {
  const key = await crypto.subtle.importKey(
    'raw',
    text.encode(proof.serverSeed),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const message = `${proof.game}:${proof.nonce}:${proof.clientSeed}`;
  const blocks = await Promise.all(
    Array.from({ length: 32 }, (_, i) => crypto.subtle.sign('HMAC', key, text.encode(`${message}:${i}`))),
  );
  const values = blocks.flatMap((buffer) => {
    const view = new DataView(buffer);
    return Array.from({ length: 8 }, (_, i) => view.getUint32(i * 4));
  });
  let offset = 0;
  return {
    int(size) {
      const limit = Math.floor(0x100000000 / size) * size;
      let n;
      do {
        if (offset >= values.length) throw new Error('Random buffer exhausted');
        n = values[offset++];
      } while (n >= limit);
      return n % size;
    },
  };
}
export async function verifyRound(round) {
  if (!crypto.subtle || !round.proof.serverSeed) throw new Error('Verification unavailable');
  if (hex(await crypto.subtle.digest('SHA-256', text.encode(round.proof.serverSeed))) !== round.proof.hash)
    return false;
  const rng = await randomFor(round.proof),
    parameters = round.parameters,
    actual = round.outcome;
  let expected;
  if (round.game === 'dice') {
    expected = diceOutcome(rng, parameters.mode, parameters.target);
    return (
      actual.face === expected.face &&
      actual.mode === expected.mode &&
      actual.target === expected.target &&
      actual.multiplier === expected.multiplier &&
      round.payoutMinor === (expected.win ? payout(round.betMinor, expected.multiplier) : 0)
    );
  }
  if (round.game === 'slots') {
    expected = slotsOutcome(rng);
    return (
      actual.multiplier === expected.multiplier &&
      JSON.stringify(actual.symbols) === JSON.stringify(expected.symbols) &&
      round.payoutMinor === payout(round.betMinor, expected.multiplier)
    );
  }
  if (round.game === 'plinko') {
    expected = plinkoOutcome(rng, parameters.rows, parameters.risk);
    return (
      actual.multiplier === expected.multiplier &&
      JSON.stringify(actual.directions) === JSON.stringify(expected.directions) &&
      actual.slot === expected.slot &&
      round.payoutMinor === payout(round.betMinor, expected.multiplier)
    );
  }
  const deck = shuffledDeck(rng),
    player = [deck[0], deck[2], ...deck.slice(4, 4 + actual.player.length - 2)],
    cursor = 4 + actual.player.length - 2;
  const dealer = [deck[1], deck[3], ...deck.slice(cursor, cursor + actual.dealer.length - 2)];
  return (
    actual.playerValue.total === handValue(player).total &&
    actual.dealerValue.total === handValue(dealer).total &&
    JSON.stringify(player) === JSON.stringify(actual.player) &&
    JSON.stringify(dealer) === JSON.stringify(actual.dealer) &&
    blackjackResult(player, dealer, round.betMinor).payoutMinor === round.payoutMinor
  );
}
