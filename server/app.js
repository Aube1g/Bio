import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { GameStore } from './store.js';
import { ApiError, requireValue } from './errors.js';
import { validateWidget, validateMiniApp } from './telegram.js';
import { MIN_BET, MAX_BET, SLOT_RTP } from '../assets/shared/game-rules.js';

function cookies(request) {
  const result = {};
  for (const item of (request.headers.cookie || '').split(';')) {
    const index = item.indexOf('=');
    if (index > 0) result[item.slice(0, index).trim()] = item.slice(index + 1).trim();
  }
  return result;
}

function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const first = Buffer.from(a),
    second = Buffer.from(b);
  return first.length === second.length && timingSafeEqual(first, second);
}

async function readJson(request) {
  requireValue(
    (request.headers['content-type'] || '').split(';')[0] === 'application/json',
    415,
    'json_required',
    'Нужен JSON-запрос',
  );
  let size = 0,
    parts = [];
  for await (const chunk of request) {
    size += chunk.length;
    requireValue(size <= 16_384, 413, 'body_too_large', 'Запрос слишком большой');
    parts.push(chunk);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(parts).toString());
  } catch {
    throw new ApiError(400, 'invalid_json', 'Некорректный JSON');
  }
  requireValue(
    body && typeof body === 'object' && !Array.isArray(body),
    400,
    'invalid_body',
    'Некорректный запрос',
  );
  return body;
}

class RateLimiter {
  constructor() {
    this.entries = new Map();
  }
  check(key, limit, interval) {
    const now = Date.now();
    let entry = this.entries.get(key);
    if (!entry || entry.until <= now) {
      entry = { count: 0, until: now + interval };
      this.entries.set(key, entry);
    }
    requireValue(++entry.count <= limit, 429, 'rate_limit', 'Слишком много запросов. Подожди немного.');
    if (this.entries.size > 10_000)
      for (const [id, value] of this.entries) if (value.until <= now) this.entries.delete(id);
    requireValue(this.entries.size <= 20_000, 503, 'busy', 'Сервис занят. Попробуй чуть позже.');
  }
}

export function createApp(config, root = resolve('.')) {
  const store = new GameStore(config.databasePath);
  const limits = new RateLimiter();
  const loginStates = new Map();
  const htmlCache = new Map();
  const mime = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.jpg': 'image/jpeg',
    '.woff2': 'font/woff2',
    '.json': 'application/json; charset=utf-8',
  };

  function isSecure(request) {
    return Boolean(
      request.socket.encrypted ||
        config.publicOrigin.startsWith('https://') ||
        (config.trustProxy &&
          String(request.headers['x-forwarded-proto'] || '')
            .split(',')[0]
            .trim() === 'https'),
    );
  }
  function originOf(request) {
    return (
      config.publicOrigin ||
      `${isSecure(request) ? 'https' : 'http'}://${
        config.trustProxy
          ? String(request.headers['x-forwarded-host'] || request.headers.host)
              .split(',')[0]
              .trim()
          : request.headers.host
      }`
    );
  }
  function cookie(request, name, value, age) {
    const secure = isSecure(request);
    const mode =
      config.embeddedPreview && secure
        ? 'SameSite=None; Secure; Partitioned'
        : `SameSite=Lax${secure ? '; Secure' : ''}`;
    return `${name}=${value}; Path=/; HttpOnly; ${mode}; Max-Age=${age}`;
  }
  function send(response, status, body) {
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    response.end(JSON.stringify(body));
  }
  function protectOrigin(request) {
    const origin = request.headers.origin;
    requireValue(
      request.headers['sec-fetch-site'] !== 'cross-site',
      403,
      'cross_origin',
      'Недопустимый источник запроса',
    );
    if (origin)
      requireValue(origin === originOf(request), 403, 'cross_origin', 'Недопустимый источник запроса');
  }
  function requestSession(request) {
    const bearer = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.authorization || '');
    // The tab token is an explicit fallback for cookie-blocked embedded previews.
    return (
      store.session(cookies(request).aubeig_session) ||
      (config.embeddedPreview && bearer ? store.session(bearer[1]) : null)
    );
  }
  function loginResponse(login) {
    return {
      ...store.snapshot(login.session),
      ...(config.embeddedPreview ? { sessionToken: login.token } : {}),
    };
  }
  function authenticated(request, mutate = false) {
    const session = requestSession(request);
    requireValue(session, 401, 'login_required', 'Войди через Telegram или продолжи гостем');
    if (mutate)
      requireValue(
        sameSecret(request.headers['x-csrf-token'], session.csrf),
        403,
        'invalid_csrf',
        'Обнови страницу и повтори действие',
      );
    return session;
  }

  const server = createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    let path = '/';
    try {
      const url = new URL(request.url, 'http://internal');
      path = decodeURIComponent(url.pathname);
      const ip = config.trustProxy
        ? String(request.headers['x-forwarded-for'] || request.socket.remoteAddress)
            .split(',')[0]
            .trim()
        : request.socket.remoteAddress;
      if (path.startsWith('/api/')) {
        limits.check(`api:${ip}`, 500, 60_000);
        if (request.method === 'POST') protectOrigin(request);
        if (path === '/api/health' && request.method === 'GET') return send(response, 200, { ok: true });
        if (path === '/api/config' && request.method === 'GET')
          return send(response, 200, {
            telegram: {
              enabled: Boolean(config.telegramToken && config.telegramUsername),
              miniApp: Boolean(config.telegramToken),
              username: config.telegramUsername,
            },
            wallet: { mode: 'practice', integration: 'local', decimals: 2, initialMinor: 100_000 },
            limits: { minBetMinor: MIN_BET, maxBetMinor: MAX_BET },
            slotsRtp: SLOT_RTP,
          });
        if (path === '/api/session' && request.method === 'GET') {
          const session = requestSession(request);
          return send(response, 200, session ? store.snapshot(session) : { user: null });
        }
        if (path === '/api/auth/guest' && request.method === 'POST') {
          await readJson(request);
          const existing = requestSession(request);
          if (existing) return send(response, 200, store.snapshot(existing));
          limits.check(`guest:${ip}`, 10, 60 * 60_000);
          const login = store.guest();
          response.setHeader('Set-Cookie', cookie(request, 'aubeig_session', login.token, 30 * 86400));
          return send(response, 201, loginResponse(login));
        }
        if (path === '/api/auth/logout' && request.method === 'POST') {
          const session = authenticated(request, true);
          await readJson(request);
          store.logout(session);
          response.setHeader('Set-Cookie', cookie(request, 'aubeig_session', '', 0));
          return send(response, 200, { ok: true });
        }
        if (path === '/api/auth/telegram/start' && request.method === 'POST') {
          await readJson(request);
          limits.check(`telegram:${ip}`, 12, 60_000);
          requireValue(
            config.telegramToken && /^[a-zA-Z0-9_]{5,32}$/.test(config.telegramUsername),
            503,
            'telegram_unavailable',
            'Вход через Telegram пока недоступен. Можно продолжить гостем.',
          );
          const state = randomBytes(24).toString('hex');
          for (const [key, expires] of loginStates) if (expires < Date.now()) loginStates.delete(key);
          loginStates.set(state, Date.now() + 5 * 60_000);
          response.setHeader('Set-Cookie', cookie(request, 'aubeig_login', state, 300));
          return send(response, 200, {
            username: config.telegramUsername,
            authUrl: `${originOf(request)}/api/auth/telegram/callback?state=${state}`,
          });
        }
        if (path === '/api/auth/telegram/callback' && request.method === 'GET') {
          try {
            const state = url.searchParams.get('state');
            requireValue(
              state &&
                sameSecret(state, cookies(request).aubeig_login) &&
                loginStates.get(state) > Date.now(),
              401,
              'invalid_login_state',
              'Подтверждение входа истекло',
            );
            loginStates.delete(state);
            const payload = Object.fromEntries([...url.searchParams].filter(([key]) => key !== 'state'));
            const login = store.telegram(validateWidget(payload, config.telegramToken));
            response.setHeader('Set-Cookie', [
              cookie(request, 'aubeig_session', login.token, 30 * 86400),
              cookie(request, 'aubeig_login', '', 0),
            ]);
            response.writeHead(303, { Location: '/games.html' });
            response.end();
            return;
          } catch {
            response.writeHead(303, { Location: '/games.html?auth=failed', 'Cache-Control': 'no-store' });
            response.end();
            return;
          }
        }
        if (path === '/api/auth/telegram/miniapp' && request.method === 'POST') {
          const body = await readJson(request);
          limits.check(`telegram:${ip}`, 12, 60_000);
          const login = store.telegram(validateMiniApp(body.initData, config.telegramToken));
          response.setHeader('Set-Cookie', cookie(request, 'aubeig_session', login.token, 30 * 86400));
          return send(response, 200, loginResponse(login));
        }
        if (path === '/api/history' && request.method === 'GET')
          return send(
            response,
            200,
            store.historyPage(authenticated(request).userId, url.searchParams.get('before')),
          );
        const proofMatch = path.match(/^\/api\/rounds\/([a-f0-9-]{36})$/);
        if (proofMatch && request.method === 'GET')
          return send(response, 200, { round: store.round(authenticated(request).userId, proofMatch[1]) });
        const requestMatch = path.match(/^\/api\/requests\/([a-zA-Z0-9_-]{16,80})$/);
        if (requestMatch && request.method === 'GET') {
          const result = store.request(authenticated(request).userId, requestMatch[1]);
          return send(response, 200, { found: Boolean(result), result });
        }
        const gameMatch = path.match(/^\/api\/games\/(dice|slots|plinko|blackjack)$/);
        if (gameMatch && request.method === 'POST') {
          const session = authenticated(request, true);
          limits.check(`play:${session.userId}`, 180, 60_000);
          return send(response, 200, store.play(session.userId, gameMatch[1], await readJson(request)));
        }
        const actionMatch = path.match(/^\/api\/blackjack\/([a-f0-9-]{36})\/action$/);
        if (actionMatch && request.method === 'POST') {
          const session = authenticated(request, true);
          limits.check(`play:${session.userId}`, 180, 60_000);
          return send(
            response,
            200,
            store.blackjackAction(session.userId, actionMatch[1], await readJson(request)),
          );
        }
        if (path === '/api/wallet/practice-reset' && request.method === 'POST') {
          const session = authenticated(request, true);
          return send(response, 200, store.resetPractice(session.userId, await readJson(request)));
        }
        throw new ApiError(404, 'not_found', 'Маршрут не найден');
      }
      requireValue(
        ['GET', 'HEAD'].includes(request.method),
        405,
        'method_not_allowed',
        'Метод не поддерживается',
      );
      const routes = {
        '/': config.landingPage === 'bio' ? 'bio.html' : 'games.html',
        '/games.html': 'games.html',
        '/games': 'games.html',
        '/bio': 'bio.html',
        '/bio.html': 'bio.html',
        '/Портал (2).html': 'games.html',
      };
      const relative = routes[path] || (path.startsWith('/assets/') ? path.slice(1) : null);
      requireValue(
        relative && !relative.split('/').some((part) => part.startsWith('.')),
        404,
        'not_found',
        'Файл не найден',
      );
      const filename = resolve(root, relative);
      requireValue(filename.startsWith(root + sep), 404, 'not_found', 'Файл не найден');
      let content;
      try {
        content = await readFile(filename);
      } catch {
        throw new ApiError(404, 'not_found', 'Файл не найден');
      }
      if (extname(filename) === '.html') {
        const cacheKey = createHash('sha256').update(content).digest('base64');
        let csp = htmlCache.get(cacheKey);
        if (!csp) {
          const hashes = [...content.toString().matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
            .map((m) => `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`)
            .join(' ');
          csp = `default-src 'self'; script-src 'self' ${hashes} https://telegram.org; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self'; frame-src https://oauth.telegram.org https://telegram.org; object-src 'none'; base-uri 'self'; form-action 'self' https://oauth.telegram.org`;
          htmlCache.clear();
          htmlCache.set(cacheKey, csp);
        }
        response.setHeader('Content-Security-Policy', csp);
      }
      response.writeHead(200, {
        'Content-Type': mime[extname(filename)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (response.headersSent) {
        response.end();
        return;
      }
      const status = error instanceof ApiError ? error.status : 500;
      if (status === 500) console.error('Server error:', path, error.name, error.message);
      send(response, status, {
        error: {
          code: error.code || 'server_error',
          message:
            status === 500 ? 'Не удалось выполнить запрос. Проверь результат перед повтором.' : error.message,
        },
      });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return { server, store };
}
