import { copyText } from '../shared/clipboard.js';
import { $, $$, icon, escapeHTML, uuid } from '../shared/dom.js';
import { preferences, safeStorage } from '../shared/preferences.js';
import {
  SLOT_SYMBOLS,
  SLOT_TRIPLES,
  plinkoTable,
  plinkoRtp,
  binomial,
  diceOdds,
} from '../shared/game-rules.js';
import { t, money, signedMoney } from './strings.js';
import { verifyRound } from './verify.js';

const gameIcon = { blackjack: 'spade', slots: 'slot', dice: 'dice', plinko: 'plinko' };
const title = (name) =>
  ({ blackjack: 'Blackjack', slots: 'Slots', dice: 'Dice', plinko: 'Plinko' })[name] || name;

export class PortalDialogs {
  constructor({ morph, api, state, notify, onError, onData, onSession, finishVisuals, onNavigate }) {
    Object.assign(this, { morph, api, state, notify, onError, onData, onSession, finishVisuals, onNavigate });
    this.rounds = new Map();
    this.proofRound = null;
    this.historyCursor = null;
    document.addEventListener('click', (event) => {
      const trigger = event.target.closest('[data-open]');
      if (trigger) this.open(trigger.dataset.open, trigger);
      const history = event.target.closest('[data-round-id]');
      if (history)
        this.showProof(
          this.rounds.get(history.dataset.roundId) || this.state().rounds.get(history.dataset.roundId),
          history,
        );
      const verify = event.target.closest('#verify-round');
      if (verify) this.verify(verify);
      if (event.target.closest('#save-client-seed')) this.saveSeed();
      const launch = event.target.closest('[data-profile-game]');
      if (launch)
        this.morph.close($('#account-dialog')).then(() => this.onNavigate(launch.dataset.profileGame));
      if (event.target.closest('#copy-account-id') && this.state().user) {
        copyText(this.state().user.id).then((copied) => this.notify(t(copied ? 'idCopied' : 'copyFailed')));
      }
    });
    $('#history-more').addEventListener('click', () => this.history(true));
    $('#rules-button').addEventListener('click', (event) => this.rules(event.currentTarget));
    $('#plinko-table-button').addEventListener('click', (event) => this.rules(event.currentTarget));
    $('#slot-table-button').addEventListener('click', (event) => this.rules(event.currentTarget));
    $('#fairness-button').addEventListener('click', (event) => this.nextProof(event.currentTarget));
    $('#result-proof').addEventListener('click', (event) =>
      this.showProof(this.state().lastRound, event.currentTarget),
    );
    $('#practice-reset').addEventListener('click', () => this.resetPractice());
    $('#logout-button').addEventListener('click', () => this.logout());
    $('#account-dialog').addEventListener('close', () => {
      delete $('#logout-button').dataset.confirm;
      $('#logout-button span').textContent = t('logout');
    });
  }
  open(id, opener) {
    if (['account-dialog', 'history-dialog', 'wallet-dialog'].includes(id) && !this.state().user) {
      this.morph.open($('#auth-dialog'), opener);
      return;
    }
    if (id === 'account-dialog') this.account();
    if (id === 'history-dialog') this.history();
    if (id === 'wallet-dialog') {
      $('#wallet-amount').textContent = money(this.state().wallet.balanceMinor);
      $('#practice-reset').disabled = Boolean(
        this.state().networkBusy || this.state().activeBlackjack || this.state().pendingCredits.size,
      );
    }
    this.morph.open($('#' + id), opener);
  }
  account() {
    const state = this.state();
    if (!state.user) return;
    const name = state.user.kind === 'guest' ? t('guest') : state.user.name;
    $('#account-title').textContent = name;
    $('#account-type').textContent = state.user.username
      ? '@' + state.user.username
      : t(state.user.kind === 'guest' ? 'guestAccount' : 'telegramAccount');
    $('#player-avatar').textContent = Array.from(name.trim())[0]?.toUpperCase() || 'G';
    $('#player-avatar').dataset.kind = state.user.kind;
    $('#account-badge').innerHTML =
      icon(state.user.kind === 'guest' ? 'user' : 'telegram') +
      `<span>${t(state.user.kind === 'guest' ? 'guest' : 'telegramAccount')}</span>`;
    $('#profile-balance').textContent = money(state.wallet.balanceMinor);
    $('#account-stats').innerHTML = [
      ['gamepad', 'rounds', state.stats.rounds],
      ['check', 'wins', state.stats.wins],
      ['chart', 'winRate', (state.stats.winRate || 0) + '%'],
      ['gem', 'bestReturn', money(state.stats.bestPayoutMinor || 0)],
    ]
      .map(
        ([glyph, label, value]) =>
          `<div class="profile-stat">${icon(glyph)}<strong>${escapeHTML(value)}</strong><span>${t(label)}</span></div>`,
      )
      .join('');
    const favorites = new Set(
      $$('[data-favorite][aria-pressed="true"]').map((button) => button.dataset.favorite),
    );
    const order = Object.keys(gameIcon).sort((a, b) => Number(favorites.has(b)) - Number(favorites.has(a)));
    $('#profile-games').innerHTML = order
      .map(
        (game) =>
          `<button class="profile-game" type="button" data-profile-game="${game}">${icon(gameIcon[game])}<span>${title(game)}</span></button>`,
      )
      .join('');
    $('#profile-favorites-label').textContent = favorites.size
      ? `${t('favorites')}: ${favorites.size}`
      : '04 GAMES';
    $('#profile-session-summary').textContent = state.activeBlackjack
      ? t('resumeHand')
      : state.stats.rounds
        ? t('sessionSummary', {
            rounds: state.stats.rounds,
            wins: state.stats.wins,
            net: signedMoney(state.stats.netMinor),
          })
        : t('firstRound');
    $('#profile-account-id').textContent = 'ID ' + state.user.id.slice(0, 8);
    $('#copy-account-id').setAttribute('aria-label', t('copyAccountId'));
    $('#guest-profile-warning').hidden = state.user.kind !== 'guest';
  }
  async history(append = false) {
    const userId = this.state().user?.id;
    if (!append) {
      this.historyCursor = null;
      this.rounds.clear();
      $('#history-list').innerHTML =
        `<div class="empty-state">${icon('history')}<p>${t('noHistory')}</p></div>`;
      $('#history-more').hidden = true;
    }
    $('#history-more').disabled = true;
    try {
      const data = await this.api.call(
        '/api/history' + (append && this.historyCursor ? '?before=' + this.historyCursor : ''),
      );
      if (userId !== this.state().user?.id) return;
      for (const round of data.rounds) this.rounds.set(round.id, round);
      this.historyCursor = data.nextCursor;
      $('#history-more').hidden = !data.nextCursor;
      if (!this.rounds.size) return;
      $('#history-list').innerHTML = [...this.rounds.values()]
        .map((round) => {
          const date = new Intl.DateTimeFormat(preferences.lang, {
            hour: '2-digit',
            minute: '2-digit',
            day: '2-digit',
            month: 'short',
          }).format(round.createdAt);
          return `<button type="button" class="history-item ${round.netMinor > 0 ? 'win' : ''}" data-round-id="${round.id}">${icon(gameIcon[round.game])}<span><strong>${title(round.game)}</strong><small>${date} · ${t('bet')} ${money(round.betMinor)}</small></span><span class="history-return">${round.status === 'active' ? t('active') : signedMoney(round.netMinor)}<small>${round.status === 'settled' ? `${t('paid')} ${money(round.payoutMinor)}` : ''}</small></span>${icon('arrow')}</button>`;
        })
        .join('');
    } catch (error) {
      this.onError(error);
    } finally {
      $('#history-more').disabled = false;
    }
  }
  rules(opener) {
    const state = this.state(),
      game = state.game;
    $('#rules-title').textContent = title(game);
    const odds = diceOdds(state.dice.mode, state.dice.target);
    const facts =
      game === 'blackjack'
        ? [
            [t('blackjackPay'), '3:2'],
            [t('dealer'), 'S17'],
            [t('ace'), '1 / 11'],
          ]
        : game === 'dice'
          ? [
              [t('faces'), '6'],
              [t('chance'), (odds.chance * 100).toFixed(1) + '%'],
              [t('multiplier'), odds.multiplier.toFixed(2) + '×'],
            ]
          : game === 'slots'
            ? [
                [t('reels'), '3'],
                [t('slotSymbols'), '8'],
                [t('maxReturn'), '192×'],
              ]
            : [
                [t('rowCount'), state.plinko.rows],
                [t('risk'), t(state.plinko.risk)],
                [t('multiplier'), plinkoTable(state.plinko.rows, state.plinko.risk)[0] + '×'],
              ];
    let html = `<section class="modal-section-card"><div class="info-card-heading">${icon(gameIcon[game])}<h3>${t('howToPlay')}</h3></div><p>${t('rules' + game[0].toUpperCase() + game.slice(1))}</p></section><div class="rule-facts">${facts.map(([label, value]) => `<div class="info-card"><span>${escapeHTML(label)}</span><strong>${escapeHTML(value)}</strong></div>`).join('')}</div>`;
    if (game === 'slots')
      html += `<div class="table-card"><table class="payout-table"><thead><tr><th>${t('slotSymbols')}</th><th>${t('threeSame')}</th><th>${t('twoSame')}</th></tr></thead><tbody>${SLOT_SYMBOLS.map((name, i) => `<tr><td>${name === 'seven' ? '<strong>7</strong>' : icon(name)} ${name.toUpperCase()}</td><td>${SLOT_TRIPLES[i]}×</td><td>1.75×</td></tr>`).join('')}</tbody></table></div>`;
    if (game === 'plinko') {
      const { rows, risk } = state.plinko;
      html += `<h3>${t('rowsRisk', { rows, risk: t(risk) })}</h3><div class="table-card"><table class="payout-table"><thead><tr><th>${t('cell')}</th><th>${t('multiplier')}</th><th>${t('probability')}</th></tr></thead><tbody>${plinkoTable(
        rows,
        risk,
      )
        .map(
          (multiplier, i) =>
            `<tr><td>${i + 1}</td><td>${multiplier.toFixed(2)}×</td><td>${((binomial(rows, i) / 2 ** rows) * 100).toFixed(3)}%</td></tr>`,
        )
        .join(
          '',
        )}</tbody></table></div><p style="margin-top:16px">RTP: ${(plinkoRtp(rows, risk) * 100).toFixed(2)}%</p>`;
    }
    html += `<aside class="info-callout" style="margin-top:14px">${icon('info')}<p>${t('rulesPractice')}</p></aside>`;
    $('#rules-content').innerHTML = html;
    this.morph.open($('#rules-dialog'), opener);
  }
  field(label, value) {
    return `<div class="proof-field"><span>${escapeHTML(label)}</span><code>${escapeHTML(value)}</code></div>`;
  }
  nextProof(opener) {
    const state = this.state();
    if (!state.user) {
      this.open('auth-dialog', opener);
      return;
    }
    this.proofRound = null;
    $('#proof-content').innerHTML =
      `<aside class="info-callout">${icon('shield')}<p>${t('seedIntro')}</p></aside>${this.field(t('nextHash'), state.fairness.nextHash)}${this.field('Nonce', state.fairness.nonce)}<label class="field-label" for="client-seed-input">${t('clientSeed')}</label><input id="client-seed-input" class="seed-input" maxlength="64" value="${escapeHTML(state.clientSeed)}"><button class="primary-button" type="button" id="save-client-seed">${icon('check')}<span>${t('saveSeed')}</span></button><aside class="info-callout" style="margin-top:14px">${icon('info')}<p>${t('fairLocal')}</p></aside>`;
    this.morph.open($('#proof-dialog'), opener);
  }
  showProof(round, opener) {
    if (!round) return;
    this.proofRound = round;
    $('#proof-content').innerHTML =
      `<p>${title(round.game)} · ${escapeHTML(round.id.slice(0, 8))}</p><div class="proof-results"><span>${t('bet')}<strong>${money(round.betMinor)}</strong></span><span>${t('paid')}<strong>${round.status === 'settled' ? money(round.payoutMinor) : '—'}</strong></span></div><aside class="info-callout">${icon('shield')}<p>${t('seedIntro')}</p></aside>${this.field('Server seed hash', round.proof.hash)}${this.field(t('clientSeed'), round.proof.clientSeed)}${this.field('Nonce', round.proof.nonce)}${round.proof.serverSeed ? this.field('Server seed', round.proof.serverSeed) : `<p>${t('proofWaiting')}</p>`}${round.proof.serverSeed ? `<button class="primary-button" type="button" id="verify-round">${icon('shield')}<span>${t('verify')}</span></button><p id="verify-status" class="verify-status" role="status"></p>` : ''}<aside class="info-callout" style="margin-top:14px">${icon('info')}<p>${t('fairLocal')}</p></aside>`;
    this.morph.open($('#proof-dialog'), opener);
  }
  async verify(button) {
    button.disabled = true;
    $('#verify-status').textContent = t('verifying');
    try {
      const valid = await verifyRound(this.proofRound);
      $('#verify-status').innerHTML =
        icon(valid ? 'check' : 'close') + `<span>${t(valid ? 'hashConfirmed' : 'hashFailed')}</span>`;
    } catch {
      $('#verify-status').textContent = t('proofUnsupported');
    } finally {
      button.disabled = false;
    }
  }
  saveSeed() {
    const state = this.state();
    if (state.networkBusy || state.pendingCredits.size || state.activeBlackjack) {
      this.notify(t('noSeedChange'));
      return;
    }
    const seed = $('#client-seed-input').value.trim();
    if (!/^[a-zA-Z0-9 _-]{1,64}$/.test(seed)) {
      this.notify('Client seed: A–Z, 0–9, _ -');
      return;
    }
    state.clientSeed = seed;
    safeStorage.set('games.clientSeed', seed);
    this.notify(t('seedSaved'));
  }
  async resetPractice() {
    if (!this.state().user) {
      this.open('auth-dialog', $('#practice-reset'));
      return;
    }
    const button = $('#practice-reset');
    button.disabled = true;
    try {
      const data = await this.api.mutate('/api/wallet/practice-reset', { actionId: uuid() });
      this.onData(data);
      $('#wallet-amount').textContent = money(data.wallet.balanceMinor);
      this.notify(t('resetDone'));
    } catch (error) {
      this.onError(error);
    } finally {
      button.disabled = false;
    }
  }
  async logout() {
    const button = $('#logout-button');
    if (!button.dataset.confirm) {
      button.dataset.confirm = 'true';
      $('span', button).textContent = t('confirmLogout');
      return;
    }
    if (this.state().networkBusy || this.state().uncertain) {
      this.notify(t('pendingRound'));
      return;
    }
    button.disabled = true;
    try {
      this.finishVisuals();
      this.api.beginAuthentication();
      await this.api.call('/api/auth/logout', {});
      this.api.acceptSession({ user: null });
      this.onSession({ user: null });
      this.morph.close($('#account-dialog'));
      this.notify(t('signedOut'));
    } catch (error) {
      this.onError(error);
    } finally {
      button.disabled = false;
    }
  }
}
