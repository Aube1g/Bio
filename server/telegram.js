import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { requireValue } from './errors.js';

function compareHash(actual, expected) {
  return (
    typeof actual === 'string' &&
    /^[a-f0-9]{64}$/i.test(actual) &&
    timingSafeEqual(Buffer.from(actual, 'hex'), expected)
  );
}

function validateTime(authDate, now) {
  requireValue(
    Number.isSafeInteger(Number(authDate)) && Number(authDate) <= now + 30 && Number(authDate) >= now - 300,
    401,
    'expired_telegram_auth',
    'Подтверждение Telegram истекло. Попробуй ещё раз.',
  );
}

function profile(user) {
  requireValue(
    Number.isSafeInteger(Number(user.id)) && Number(user.id) > 0,
    401,
    'invalid_telegram_user',
    'Не удалось подтвердить Telegram',
  );
  requireValue(
    typeof user.first_name === 'string' && user.first_name.length > 0 && user.first_name.length <= 256,
    401,
    'invalid_telegram_user',
    'Не удалось подтвердить Telegram',
  );
  return {
    telegramId: String(user.id),
    name: user.first_name.slice(0, 64),
    username:
      typeof user.username === 'string' && /^[a-zA-Z0-9_]{1,32}$/.test(user.username) ? user.username : '',
  };
}

export function validateWidget(payload, token, now = Math.floor(Date.now() / 1000)) {
  requireValue(token, 503, 'telegram_unavailable', 'Вход через Telegram пока недоступен');
  const allowed = new Set(['id', 'first_name', 'last_name', 'username', 'photo_url', 'auth_date', 'hash']);
  requireValue(
    payload &&
      Object.entries(payload).every(
        ([key, value]) => allowed.has(key) && ['string', 'number'].includes(typeof value),
      ),
    401,
    'invalid_telegram_auth',
    'Не удалось подтвердить Telegram',
  );
  const check = Object.entries(payload)
    .filter(([key]) => key !== 'hash')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secret = createHash('sha256').update(token).digest();
  const expected = createHmac('sha256', secret).update(check).digest();
  requireValue(
    compareHash(payload.hash, expected),
    401,
    'invalid_telegram_auth',
    'Не удалось подтвердить Telegram',
  );
  validateTime(payload.auth_date, now);
  return { ...profile(payload), fingerprint: payload.hash };
}

export function validateMiniApp(initData, token, now = Math.floor(Date.now() / 1000)) {
  requireValue(token, 503, 'telegram_unavailable', 'Вход через Telegram пока недоступен');
  requireValue(
    typeof initData === 'string' && initData.length < 12_000,
    401,
    'invalid_telegram_auth',
    'Не удалось подтвердить Telegram',
  );
  const params = new URLSearchParams(initData);
  requireValue(
    new Set(params.keys()).size === [...params.keys()].length,
    401,
    'invalid_telegram_auth',
    'Не удалось подтвердить Telegram',
  );
  const hash = params.get('hash');
  params.delete('hash');
  const check = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  requireValue(
    compareHash(hash, createHmac('sha256', secret).update(check).digest()),
    401,
    'invalid_telegram_auth',
    'Не удалось подтвердить Telegram',
  );
  validateTime(params.get('auth_date'), now);
  let user;
  try {
    user = JSON.parse(params.get('user'));
  } catch {
    user = null;
  }
  requireValue(
    user && typeof user === 'object',
    401,
    'invalid_telegram_user',
    'Не удалось подтвердить Telegram',
  );
  return { ...profile(user), fingerprint: hash };
}
