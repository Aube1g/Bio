import {
  diceOutcome,
  slotsOutcome,
  plinkoOutcome,
  shuffledDeck,
  blackjackResult,
  handValue,
  payout,
} from '../shared/game-rules.js';
import { BrowserFairRandom, hashSeed } from './browser-random.js';
export async function verifyRound(round) {
  if (!round.proof.serverSeed) throw new Error('Verification unavailable');
  if (hashSeed(round.proof.serverSeed) !== round.proof.hash) return false;
  const rng = new BrowserFairRandom(
      round.proof.serverSeed,
      round.proof.clientSeed,
      round.proof.nonce,
      round.proof.game,
    ),
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
