import { SESSION_COOKIE, SESSION_TTL_MS, config } from './config.js';
import { getSettings, sessions, settings, SETTINGS_ID, users } from './db.js';
import { HttpError } from './http.js';
import { newToken, safeEqual, sha256Hex } from './security.js';

function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

const cookieOptions = () => ({
  httpOnly: true,
  sameSite: 'lax',
  secure: config.secureCookies,
  path: '/',
});

export async function startSession(res, user) {
  const token = newToken(32);
  const now = Date.now();
  await sessions().insertOne({
    _id: sha256Hex(token),
    userId: user._id,
    createdAt: new Date(now),
    expiresAt: new Date(now + SESSION_TTL_MS),
  });
  res.cookie(SESSION_COOKIE, token, { ...cookieOptions(), maxAge: SESSION_TTL_MS });
}

export async function endSession(req, res) {
  const token = readCookie(req, SESSION_COOKIE);
  if (token) await sessions().deleteOne({ _id: sha256Hex(token) });
  res.clearCookie(SESSION_COOKIE, cookieOptions());
}

export const endAllSessionsFor = (userId) => sessions().deleteMany({ userId });

// Resolves who is calling: a signed-in user (cookie) or the publish script (bearer deploy token).
export async function loadAuth(req, _res, next) {
  req.auth = null;

  const bearer = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') || '');
  if (bearer) {
    const s = await getSettings();
    const stored = s?.deployToken;
    if (stored && safeEqual(sha256Hex(bearer[1]), stored.hash)) {
      req.auth = { role: 'deploy', username: 'publish script' };
      settings()
        .updateOne({ _id: SETTINGS_ID }, { $set: { 'deployToken.lastUsedAt': new Date() } })
        .catch(() => {});
    } else if (s?.builderToken && safeEqual(bearer[1], s.builderToken)) {
      req.auth = { role: 'builder', username: 'Router Builder' };
    }
    return next();
  }

  const token = readCookie(req, SESSION_COOKIE);
  if (token) {
    const session = await sessions().findOne({ _id: sha256Hex(token), expiresAt: { $gt: new Date() } });
    const user = session && (await users().findOne({ _id: session.userId }));
    if (user) req.auth = { role: user.role, username: user.username, userId: user._id };
  }
  next();
}

export function requireUser(req, _res, next) {
  if (req.auth?.role === 'master' || req.auth?.role === 'helper') return next();
  next(new HttpError(401, 'Sign in to continue.'));
}

export function requireMaster(req, _res, next) {
  if (req.auth?.role === 'master') return next();
  next(new HttpError(req.auth ? 403 : 401, req.auth ? 'Only the master account can do this.' : 'Sign in to continue.'));
}

export function requireUploader(req, _res, next) {
  if (req.auth?.role === 'master' || req.auth?.role === 'deploy' || req.auth?.role === 'builder') return next();
  next(new HttpError(req.auth ? 403 : 401, req.auth ? 'Only the master account can upload.' : 'Sign in or send a deploy token.'));
}
