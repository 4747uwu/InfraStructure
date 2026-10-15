import { Router } from 'express';
import { endAllSessionsFor, requireMaster, startSession } from '../auth.js';
import { getSettings, settings, SETTINGS_ID, users } from '../db.js';
import { cleanText, HttpError } from '../http.js';
import { hashPassword, newToken, sha256Hex, verifyPassword } from '../security.js';

const router = Router();
router.use('/settings', requireMaster);

const MIN_PASSWORD = 8;

function requirePassword(value, label) {
  const password = String(value ?? '');
  if (password.length < MIN_PASSWORD) throw new HttpError(400, `${label} must be at least ${MIN_PASSWORD} characters.`);
  if (password.length > 200) throw new HttpError(400, `${label} is too long.`);
  return password;
}

router.get('/settings', async (_req, res) => {
  const [s, accounts] = await Promise.all([getSettings(), users().find().sort({ role: -1 }).toArray()]);
  res.json({
    downloadPassword: { set: Boolean(s?.downloadPassword), updatedAt: s?.downloadPassword?.updatedAt || null },
    deployToken: s?.deployToken
      ? { hint: s.deployToken.hint, createdAt: s.deployToken.createdAt, lastUsedAt: s.deployToken.lastUsedAt || null }
      : null,
    accounts: accounts.map((u) => ({ role: u.role, username: u.username, updatedAt: u.updatedAt })),
  });
});

// The one password that unlocks every helper link.
router.put('/settings/download-password', async (req, res) => {
  const password = requirePassword(req.body?.password, 'The download password');
  await settings().updateOne(
    { _id: SETTINGS_ID },
    { $set: { downloadPassword: { hash: await hashPassword(password), updatedAt: new Date() } } },
  );
  res.json({ ok: true });
});

// Shown once. Generating a new token stops the previous one working.
router.post('/settings/deploy-token', async (_req, res) => {
  const token = `rh_${newToken(24)}`;
  await settings().updateOne(
    { _id: SETTINGS_ID },
    { $set: { deployToken: { hash: sha256Hex(token), hint: token.slice(-4), createdAt: new Date(), lastUsedAt: null } } },
  );
  res.json({ token });
});

router.put('/settings/accounts/:role', async (req, res) => {
  const user = await users().findOne({ role: req.params.role });
  if (!user) throw new HttpError(404, 'That account does not exist.');

  const set = { updatedAt: new Date() };
  if (req.body?.username !== undefined) {
    set.username = cleanText(req.body.username, 60).toLowerCase();
    if (!/^[a-z0-9._-]{3,60}$/.test(set.username)) {
      throw new HttpError(400, 'Usernames are 3-60 characters: letters, numbers, dot, dash or underscore.');
    }
  }
  if (req.body?.password !== undefined) {
    const password = requirePassword(req.body.password, 'The password');
    // Changing the master's own password needs the current one, so a borrowed session cannot lock the owner out.
    if (user.role === 'master' && !(await verifyPassword(String(req.body.currentPassword ?? ''), user.passwordHash))) {
      throw new HttpError(403, 'The current master password is not correct.');
    }
    set.passwordHash = await hashPassword(password);
  }

  try {
    await users().updateOne({ _id: user._id }, { $set: set });
  } catch (err) {
    if (err?.code === 11000) throw new HttpError(409, 'That username is already taken.');
    throw err;
  }

  if (set.passwordHash) {
    await endAllSessionsFor(user._id);
    if (user.role === 'master') await startSession(res, user); // keep the person who made the change signed in
  }
  res.json({ ok: true });
});

export default router;
