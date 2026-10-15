import { Router } from 'express';
import { endAllSessionsFor, requireMaster, startSession } from '../auth.js';
import { getSettings, settings, SETTINGS_ID, users } from '../db.js';
import { storageThreshold } from '../alerts.js';
import { baseUrl, cleanText, HttpError } from '../http.js';
import { sendEmail, sendTelegram } from '../notify.js';
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
    notifications: notificationsView(s),
  });
});

// ---- alert notifications ----------------------------------------------------------
// Secrets (SMTP password, Telegram bot token) are stored so alerts can be sent, but are
// never sent back to the browser: the page only learns whether one is set.

function notificationsView(s) {
  const n = s?.notifications || {};
  const email = n.email || {};
  const telegram = n.telegram || {};
  return {
    storageThreshold: storageThreshold(s),
    email: {
      enabled: Boolean(email.enabled),
      host: email.host || '',
      port: email.port || 587,
      secure: Boolean(email.secure),
      user: email.user || '',
      passwordSet: Boolean(email.pass),
      from: email.from || '',
      to: email.to || [],
    },
    telegram: {
      enabled: Boolean(telegram.enabled),
      tokenSet: Boolean(telegram.botToken),
      chatId: telegram.chatId || '',
    },
  };
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseNotifications(body, current) {
  const n = current || {};
  const out = { ...n };

  if (body.storageThreshold !== undefined) {
    const v = Number(body.storageThreshold);
    if (!Number.isFinite(v) || v < 50 || v > 99) throw new HttpError(400, 'The storage alert threshold must be between 50% and 99%.');
    out.storageThreshold = Math.round(v);
  }

  if (body.email) {
    const e = body.email;
    const prev = n.email || {};
    const email = {
      enabled: Boolean(e.enabled),
      host: cleanText(e.host, 200),
      port: Number(e.port) || 587,
      secure: Boolean(e.secure),
      user: cleanText(e.user, 200),
      // An empty password field means "keep the one already saved".
      pass: e.password ? String(e.password).slice(0, 500) : prev.pass || '',
      from: cleanText(e.from, 200),
      to: (Array.isArray(e.to) ? e.to : String(e.to || '').split(/[,;\s]+/)).map((x) => cleanText(x, 200)).filter(Boolean).slice(0, 20),
    };
    if (email.enabled) {
      if (!email.host) throw new HttpError(400, 'Enter the SMTP server for email alerts.');
      if (!email.to.length) throw new HttpError(400, 'Enter at least one address to send email alerts to.');
      const bad = email.to.find((x) => !EMAIL.test(x));
      if (bad) throw new HttpError(400, `"${bad}" is not an email address.`);
      const sender = email.from.replace(/^.*<|>$/g, '');
      if (email.from && !EMAIL.test(sender)) throw new HttpError(400, 'The sender must be an email address.');
      if (!email.from && !EMAIL.test(email.user)) throw new HttpError(400, 'Enter a sender address (or log in with an email address).');
    }
    out.email = email;
  }

  if (body.telegram) {
    const tg = body.telegram;
    const prev = n.telegram || {};
    const telegram = {
      enabled: Boolean(tg.enabled),
      botToken: tg.botToken ? cleanText(tg.botToken, 200) : prev.botToken || '',
      chatId: cleanText(tg.chatId, 100),
    };
    if (telegram.enabled) {
      if (!/^\d+:[\w-]{20,}$/.test(telegram.botToken)) throw new HttpError(400, 'The Telegram bot token looks like 123456789:ABC... (from @BotFather).');
      if (!/^-?\d+$|^@\w{4,}$/.test(telegram.chatId)) throw new HttpError(400, 'The Telegram chat ID is a number (or @channelname).');
    }
    out.telegram = telegram;
  }
  return out;
}

router.put('/settings/notifications', async (req, res) => {
  const s = await getSettings();
  const next = parseNotifications(req.body || {}, s?.notifications);
  // Remembered so alert messages sent in the background can link back to the hub.
  next.baseUrl = baseUrl(req);
  await settings().updateOne({ _id: SETTINGS_ID }, { $set: { notifications: next } });
  res.json({ notifications: notificationsView({ ...s, notifications: next }) });
});

// Sends a test message through one channel with the saved settings.
router.post('/settings/notifications/test', async (req, res) => {
  const n = (await getSettings())?.notifications || {};
  const channel = req.body?.channel;
  const subject = 'Router Hub test alert';
  const text =
    "This is a test. Router Hub alerts will arrive here, for example when a server's storage goes above the threshold or a server stops reporting.";
  try {
    if (channel === 'email') {
      if (!n.email?.host) throw new Error('save the email settings first.');
      await sendEmail(n.email, subject, text);
    } else if (channel === 'telegram') {
      if (!n.telegram?.botToken) throw new Error('save the Telegram settings first.');
      await sendTelegram(n.telegram, `${subject}\n\n${text}`);
    } else {
      throw new HttpError(400, 'Choose email or telegram.');
    }
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(502, `The test was not delivered: ${err.message}`);
  }
  res.json({ ok: true });
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
