import { handValue } from '../shared/game-rules.js';
import { motionEnabled } from '../shared/preferences.js';
import { renderCardHand } from './renderers.js';
import { t, money } from './strings.js';

export class BlackjackRenderer {
  constructor(board, sound) {
    this.board = board;
    this.sound = sound;
    this.player = document.getElementById('player-hand');
    this.dealer = document.getElementById('dealer-hand');
    this.playerCards = [];
    this.dealerCards = [];
    this.roundId = null;
    this.finish = null;
    this.timer = 0;
  }
  paint(player, dealer, phase, animate = false) {
    this.playerCards = [...player];
    this.dealerCards = [...dealer];
    renderCardHand(this.player, player, { animate });
    renderCardHand(this.dealer, dealer, { animate });
    const score = (cards) => {
      const known = cards.filter(Number.isInteger);
      return known.length ? handValue(known).total : '—';
    };
    document.getElementById('player-score').textContent = score(player);
    document.getElementById('dealer-score').textContent =
      String(score(dealer)) + (dealer.includes(null) ? ' + ?' : '');
    this.board.dataset.turn = phase;
    document.getElementById('blackjack-phase').textContent = t(
      {
        dealing: 'dealingCards',
        player: 'yourTurn',
        dealer: 'dealerTurn',
        settled: 'handComplete',
        idle: 'ready',
      }[phase] || 'ready',
    );
    this.player.style.setProperty('--hand-count', Math.max(2, player.length));
    this.dealer.style.setProperty('--hand-count', Math.max(2, dealer.length));
  }
  restore(round) {
    this.finish?.();
    this.roundId = round?.id || null;
    this.paint(
      round?.outcome.player || [null, null],
      round?.outcome.dealer || [null, null],
      !round ? 'idle' : round.status === 'active' ? 'player' : 'settled',
    );
    document.getElementById('table-bet').textContent = round ? money(round.betMinor) : '—';
  }
  play(round, action = 'deal') {
    this.finish?.();
    const player = round.outcome.player,
      dealer = round.outcome.dealer;
    const fresh = this.roundId !== round.id;
    this.roundId = round.id;
    document.getElementById('table-bet').textContent = money(round.betMinor);
    const finalPhase = round.status === 'active' ? 'player' : 'settled';
    if (!motionEnabled() || document.hidden) {
      this.paint(player, dealer, finalPhase);
      return Promise.resolve();
    }
    const jobs = [];
    if (fresh) {
      this.paint([null, null], [null, null], 'dealing');
      jobs.push(() => this.paint([player[0], null], [null, null], 'dealing', true));
      jobs.push(() => this.paint([player[0], null], [dealer[0], null], 'dealing', true));
      jobs.push(() => this.paint(player, [dealer[0], null], 'dealing', true));
      if (round.status === 'settled') jobs.push(() => this.paint(player, dealer, 'dealer', true));
    } else {
      if (player.length > this.playerCards.length)
        jobs.push(() => this.paint(player, this.dealerCards, action === 'hit' ? 'player' : 'dealer', true));
      if (!dealer.includes(null)) {
        jobs.push(() => this.paint(player, dealer.slice(0, 2), 'dealer', true));
        for (let count = 3; count <= dealer.length; count++)
          jobs.push(() => this.paint(player, dealer.slice(0, count), 'dealer', true));
      }
    }
    return new Promise((resolve) => {
      let index = 0,
        ended = false;
      const finish = () => {
        if (ended) return;
        ended = true;
        clearTimeout(this.timer);
        this.board.getAnimations({ subtree: true }).forEach((animation) => animation.cancel());
        this.paint(player, dealer, finalPhase);
        this.finish = null;
        resolve();
      };
      this.finish = finish;
      const tick = () => {
        if (!motionEnabled() || document.hidden) {
          finish();
          return;
        }
        if (index >= jobs.length) {
          this.timer = setTimeout(finish, 410);
          return;
        }
        jobs[index++]();
        this.sound.play('card');
        this.timer = setTimeout(tick, fresh ? 260 : 370);
      };
      tick();
    });
  }
}
