import { safeStorage } from '../shared/preferences.js';
import { sleep } from '../shared/dom.js';

export class RequestError extends Error {
  constructor(code, message, status = 0) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const TOKEN_KEY = 'aubeig.preview.session';
function tabToken(value) {
  try {
    if (value === undefined) return sessionStorage.getItem(TOKEN_KEY) || '';
    if (value) sessionStorage.setItem(TOKEN_KEY, value);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* A cookie or an in-memory session can still be used. */
  }
  return '';
}

export class GameApi {
  constructor() {
    this.csrf = '';
    this.userId = null;
    this.generation = 0;
    const saved = tabToken();
    this.token = /^[a-f0-9]{64}$/.test(saved) ? saved : '';
  }
  beginAuthentication() {
    return ++this.generation;
  }
  acceptSession(data) {
    this.csrf = data.csrf || '';
    this.userId = data.user?.id || null;
    if (data.sessionToken) {
      this.token = data.sessionToken;
      tabToken(this.token);
    } else if (!data.user) {
      this.token = '';
      tabToken('');
    }
  }
  async call(path, body, retry = false) {
    const generation = this.generation;
    const options = {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {},
    };
    if (this.token) options.headers.Authorization = `Bearer ${this.token}`;
    if (body !== undefined) {
      options.headers['Content-Type'] = 'application/json';
      options.headers['X-CSRF-Token'] = this.csrf;
      options.body = JSON.stringify(body);
    }
    try {
      const response = await fetch(path, { ...options, signal: AbortSignal.timeout(12_000) });
      if (!(response.headers.get('content-type') || '').includes('application/json'))
        throw new RequestError('service_unavailable', 'Server is unavailable');
      const data = await response.json();
      if (!response.ok)
        throw new RequestError(
          data.error?.code || 'server_error',
          data.error?.message || 'Server error',
          response.status,
        );
      // A late anonymous bootstrap response must never erase a newly authenticated session.
      if (generation === this.generation && Object.hasOwn(data, 'user')) this.acceptSession(data);
      return data;
    } catch (error) {
      if (error instanceof RequestError) throw error;
      if (retry && generation === this.generation) {
        await sleep(350);
        return this.call(path, body, false);
      }
      throw new RequestError('connection_lost', 'Connection lost');
    }
  }
  pendingKey() {
    return this.userId ? `games.pending.${this.userId}` : null;
  }
  async mutate(path, body) {
    const key = this.pendingKey();
    if (!key) throw new RequestError('login_required', 'Sign in first', 401);
    const pending = { path, body, userId: this.userId };
    safeStorage.set(key, JSON.stringify(pending));
    try {
      const result = await this.call(path, body, true);
      safeStorage.set(key, '');
      return result;
    } catch (error) {
      if (error.status && error.status < 500) safeStorage.set(key, '');
      throw error;
    }
  }
  pending() {
    try {
      const key = this.pendingKey();
      const pending = key ? JSON.parse(safeStorage.get(key) || 'null') : null;
      return pending?.userId === this.userId ? pending : null;
    } catch {
      return null;
    }
  }
  async recover() {
    const pending = this.pending();
    if (!pending) return null;
    const response = await this.call('/api/requests/' + encodeURIComponent(pending.body.actionId));
    if (response.found) {
      safeStorage.set(this.pendingKey(), '');
      return response.result;
    }
    return this.mutate(pending.path, pending.body);
  }
}
