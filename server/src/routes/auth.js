import { Router } from 'express';
import { endSession, startSession } from '../auth.js';
import { config } from '../config.js';
import { getSettings, users } from '../db.js';
import { baseUrl, cleanText, HttpError } from '../http.js';
import { failureLimiter, verifyPassword } from '../security.js';

const router = Router();
const loginFailures = failureLimiter({ windowMs: 10 * 60 * 1000, max: 10 });

router.post('/auth/login', async (req, res) => {
  const username = cleanText(req.body?.username, 60).toLowerCase();
  const password = String(req.body?.password ?? '');
  const key = req.ip;

  if (loginFailures.blocked(key)) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');

  const user = username && (await users().findOne({ username }));
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    loginFailures.fail(key);
    throw new HttpError(401, 'Incorrect username or password.');
  }

  loginFailures.clear(key);
  await startSession(res, user);
  res.json({ user: { username: user.username, role: user.role } });
});

router.post('/auth/logout', async (req, res) => {
  await endSession(req, res);
  res.json({ ok: true });
});

router.get('/me', async (req, res) => {
  if (!req.auth || req.auth.role === 'deploy') return res.json({ user: null });
  const s = await getSettings();
  res.json({
    user: { username: req.auth.username, role: req.auth.role },
    app: {
      baseUrl: baseUrl(req),
      downloadPasswordSet: Boolean(s?.downloadPassword),
      maxUploadBytes: config.maxUploadBytes,
    },
  });
});

export default router;
