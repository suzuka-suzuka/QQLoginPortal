import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const KEY_LENGTH = 32;
const SCRYPT_N = 32_768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

async function derive(password, salt, n = SCRYPT_N, r = SCRYPT_R, p = SCRYPT_P) {
  return scrypt(password, salt, KEY_LENGTH, { N: n, r, p, maxmem: SCRYPT_MAXMEM });
}

export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 12) {
    throw new Error('访问密码至少需要 12 个字符');
  }
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password, encoded) {
  const parts = typeof encoded === 'string' ? encoded.split('$') : [];
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nText, rText, pText, saltText, keyText] = parts;
  const n = Number(nText);
  const r = Number(rText);
  const p = Number(pText);
  if (n !== SCRYPT_N || r !== SCRYPT_R || p !== SCRYPT_P) return false;

  try {
    const expected = Buffer.from(keyText, 'base64url');
    if (expected.length !== KEY_LENGTH) return false;
    const actual = await derive(String(password ?? ''), Buffer.from(saltText, 'base64url'), n, r, p);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export async function verifyConfiguredPassword(password, auth) {
  if (typeof auth?.password === 'string' && auth.password.length > 0) {
    const actual = createHash('sha256').update(String(password ?? ''), 'utf8').digest();
    const expected = createHash('sha256').update(auth.password, 'utf8').digest();
    return timingSafeEqual(actual, expected);
  }
  return verifyPassword(password, auth?.passwordHash);
}

export function generatePassword() {
  return randomBytes(18).toString('base64url');
}

export class SessionStore {
  constructor(ttlMs, now = () => Date.now()) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.sessions = new Map();
  }

  create() {
    const token = randomBytes(32).toString('base64url');
    this.sessions.set(token, this.now() + this.ttlMs);
    return token;
  }

  has(token) {
    if (!token) return false;
    const expiresAt = this.sessions.get(token);
    if (!expiresAt || expiresAt <= this.now()) {
      this.sessions.delete(token);
      return false;
    }
    return true;
  }

  revoke(token) {
    if (token) this.sessions.delete(token);
  }

  clear() {
    this.sessions.clear();
  }

  setTtl(ttlMs) {
    this.ttlMs = ttlMs;
  }
}

export function parseCookies(header = '') {
  const cookies = {};
  for (const entry of header.split(';')) {
    const index = entry.indexOf('=');
    if (index <= 0) continue;
    const name = entry.slice(0, index).trim();
    const value = entry.slice(index + 1).trim();
    if (!name) continue;
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}
