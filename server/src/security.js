import { createHash, createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password, stored) {
  const [scheme, salt, expected] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !salt || !expected) return false;
  const want = Buffer.from(expected, 'base64url');
  const got = await scrypt(String(password), Buffer.from(salt, 'base64url'), want.length);
  return timingSafeEqual(got, want);
}

export const newToken = (bytes = 16) => randomBytes(bytes).toString('base64url');
export const sha256Hex = (value) => createHash('sha256').update(value).digest('hex');

export function sign(secret, payload) {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

// Small in-memory failure counter. Enough for a two-user tool on one process;
// it resets on restart, which only ever errs in the caller's favour.
export function failureLimiter({ windowMs, max }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) if (entry.resetAt <= now) hits.delete(key);
  }, windowMs).unref();

  return {
    blocked(key) {
      const entry = hits.get(key);
      return Boolean(entry && entry.resetAt > Date.now() && entry.count >= max);
    },
    fail(key) {
      const now = Date.now();
      const entry = hits.get(key);
      if (!entry || entry.resetAt <= now) hits.set(key, { count: 1, resetAt: now + windowMs });
      else entry.count += 1;
    },
    clear(key) {
      hits.delete(key);
    },
  };
}
