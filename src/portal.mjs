import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCookies, SessionStore, verifyConfiguredPassword } from './auth.mjs';

const COOKIE_NAME = 'qq_login_portal_session';
const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const INSTANCE_ROUTE_RE = /^\/api\/instances\/([a-z0-9][a-z0-9_-]{0,31})\/(start|stop|refresh|quick-login|logout|qrcode)$/;
const INSTANCE_ITEM_ROUTE_RE = /^\/api\/instances\/([a-z0-9][a-z0-9_-]{0,31})$/;
const UIN_RE = /^[1-9]\d{4,19}$/;
const PUBLIC_ASSETS = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);

function setSecurityHeaders(res) {
  res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

async function readJson(req, limit = 4_096) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('请求内容过大');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new Error('请求内容不是有效 JSON');
  }
}

function sessionCookie(token, config, maxAgeSeconds) {
  const pieces = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (config.auth.secureCookie) pieces.push('Secure');
  return pieces.join('; ');
}

class LoginLimiter {
  constructor({ maxAttempts = 5, windowMs = 5 * 60_000, now = () => Date.now() } = {}) {
    this.maxAttempts = maxAttempts;
    this.windowMs = windowMs;
    this.now = now;
    this.entries = new Map();
  }

  check(key) {
    const entry = this.entries.get(key);
    if (!entry || this.now() >= entry.resetAt) {
      this.entries.delete(key);
      return 0;
    }
    return entry.failures >= this.maxAttempts ? Math.ceil((entry.resetAt - this.now()) / 1_000) : 0;
  }

  fail(key) {
    const current = this.entries.get(key);
    const entry = !current || this.now() >= current.resetAt
      ? { failures: 0, resetAt: this.now() + this.windowMs }
      : current;
    entry.failures += 1;
    this.entries.set(key, entry);
  }

  clear(key) {
    this.entries.delete(key);
  }
}

function requestIp(req) {
  return req.socket.remoteAddress || 'unknown';
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function statusForError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith('不存在 QQ 实例')) return 404;
  if (/必须|请输入有效|只能|不能小于|至少需要保留/.test(message)) return 400;
  if (/已存在|已达到上限|请先停止/.test(message)) return 409;
  if (/当前没有可用二维码|尚未|未连接|已在配置中停用|ENOENT|ECONNREFUSED/.test(message)) return 409;
  return 500;
}

export function createPortalServer({ config, instanceManager, now, verify = verifyConfiguredPassword }) {
  let sessionTtlMs = config.auth.sessionTtlMinutes * 60_000;
  const sessions = new SessionStore(sessionTtlMs, now);
  const limiter = new LoginLimiter({ now });

  return http.createServer(async (req, res) => {
    setSecurityHeaders(res);
    const url = new URL(req.url || '/', 'http://localhost');
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[COOKIE_NAME];
    const authenticated = sessions.has(token);

    try {
      if (req.method === 'GET' && PUBLIC_ASSETS.has(url.pathname)) {
        const [filename, type] = PUBLIC_ASSETS.get(url.pathname);
        res.statusCode = 200;
        res.setHeader('Content-Type', type);
        res.end(await readFile(path.join(PUBLIC_DIR, filename)));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/healthz') {
        json(res, 200, { ok: true });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/session') {
        json(res, 200, { authenticated });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/session') {
        if (!sameOrigin(req)) return json(res, 403, { message: '请求来源无效' });
        const ip = requestIp(req);
        const retryAfter = limiter.check(ip);
        if (retryAfter > 0) {
          res.setHeader('Retry-After', String(retryAfter));
          json(res, 429, { message: `尝试次数过多，请在 ${retryAfter} 秒后重试` });
          return;
        }
        const body = await readJson(req);
        if (!await verify(body.password, config.auth)) {
          limiter.fail(ip);
          json(res, 401, { message: '访问密码错误' });
          return;
        }
        limiter.clear(ip);
        const newToken = sessions.create();
        res.setHeader('Set-Cookie', sessionCookie(newToken, config, Math.floor(sessionTtlMs / 1_000)));
        json(res, 200, { authenticated: true });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/logout') {
        if (!sameOrigin(req)) return json(res, 403, { message: '请求来源无效' });
        sessions.revoke(token);
        res.setHeader('Set-Cookie', sessionCookie('', config, 0));
        json(res, 200, { authenticated: false });
        return;
      }

      if (!authenticated && url.pathname.startsWith('/api/')) {
        json(res, 401, { message: '请先登录' });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/status') {
        json(res, 200, await instanceManager.snapshot());
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/settings') {
        json(res, 200, instanceManager.settings());
        return;
      }

      if (req.method === 'PUT' && url.pathname === '/api/settings') {
        if (!sameOrigin(req)) return json(res, 403, { message: '请求来源无效' });
        const body = await readJson(req, 8_192);
        if (!await verify(body.currentPassword, config.auth)) {
          json(res, 403, { message: '当前访问密码错误' });
          return;
        }
        const changingPassword = typeof body.newPassword === 'string' && body.newPassword.length > 0;
        const settings = await instanceManager.updateSettings({
          newPassword: changingPassword ? body.newPassword : undefined,
          sessionTtlMinutes: body.sessionTtlMinutes,
          maxInstances: body.maxInstances,
        });
        sessionTtlMs = config.auth.sessionTtlMinutes * 60_000;
        sessions.setTtl(sessionTtlMs);
        if (changingPassword) {
          sessions.clear();
          const newToken = sessions.create();
          res.setHeader('Set-Cookie', sessionCookie(newToken, config, Math.floor(sessionTtlMs / 1_000)));
        }
        json(res, 200, settings);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/instances') {
        if (!sameOrigin(req)) return json(res, 403, { message: '请求来源无效' });
        const body = await readJson(req);
        json(res, 201, await instanceManager.addInstance({
          uin: body.uin,
          autostart: body.autostart === true,
          startNow: body.startNow === true,
        }));
        return;
      }

      const instanceItemMatch = INSTANCE_ITEM_ROUTE_RE.exec(url.pathname);
      if (instanceItemMatch) {
        if (!sameOrigin(req)) return json(res, 403, { message: '请求来源无效' });
        const [, id] = instanceItemMatch;
        if (req.method === 'PATCH') {
          const body = await readJson(req);
          json(res, 200, await instanceManager.updateInstance(id, { autostart: body.autostart }));
          return;
        }
        if (req.method === 'DELETE') {
          json(res, 200, await instanceManager.removeInstance(id));
          return;
        }
        return json(res, 405, { message: '请求方法不允许' });
      }

      const match = INSTANCE_ROUTE_RE.exec(url.pathname);
      if (match) {
        const [, id, action] = match;
        if (action === 'qrcode' && req.method === 'GET') {
          try {
            const response = await instanceManager.qrcode(id);
            const qrcode = response.qrcode;
            if (!qrcode || !/^image\/(?:png|jpeg|webp)$/.test(qrcode.mimeType)) {
              throw new Error('登录 Agent 返回了无效二维码');
            }
            const image = Buffer.from(qrcode.base64, 'base64');
            if (image.length === 0 || image.length > 1024 * 1024) throw new Error('登录 Agent 返回了无效二维码');
            res.statusCode = 200;
            res.setHeader('Content-Type', qrcode.mimeType);
            res.setHeader('Content-Length', String(image.length));
            res.end(image);
          } catch (error) {
            json(res, statusForError(error), { message: error instanceof Error ? error.message : String(error) });
          }
          return;
        }
        if (req.method !== 'POST') return json(res, 405, { message: '请求方法不允许' });
        if (!sameOrigin(req)) return json(res, 403, { message: '请求来源无效' });
        if (action === 'start') {
          json(res, 200, await instanceManager.startInstance(id));
          return;
        }
        if (action === 'stop') {
          json(res, 200, await instanceManager.stopInstance(id));
          return;
        }
        if (action === 'refresh') {
          json(res, 200, await instanceManager.refreshQrCode(id));
          return;
        }
        if (action === 'quick-login') {
          const body = await readJson(req);
          if (!UIN_RE.test(String(body.uin ?? ''))) return json(res, 400, { message: 'QQ 号格式无效' });
          json(res, 200, await instanceManager.quickLogin(id, String(body.uin)));
          return;
        }
        if (action === 'logout') {
          json(res, 200, await instanceManager.logoutInstance(id));
          return;
        }
      }

      json(res, 404, { message: '未找到页面' });
    } catch (error) {
      json(res, statusForError(error), { message: error instanceof Error ? error.message : String(error) });
    }
  });
}
