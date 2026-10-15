import { Router } from 'express';
import { config, DOWNLOAD_TICKET_TTL_S } from '../config.js';
import { clients, getSettings, releases, toObjectId } from '../db.js';
import { HttpError, messagePage } from '../http.js';
import { failureLimiter, safeEqual, sign, verifyPassword } from '../security.js';

// Everything here is reachable without signing in: the link token is the credential.

export const publicApi = Router();
export const downloads = Router();

const unlockFailures = failureLimiter({ windowMs: 10 * 60 * 1000, max: 10 });
const TOKEN = /^[\w-]{16,64}$/;

// A token belongs either to one version, or to a client (meaning "whatever is current").
async function resolveLink(kind, token) {
  if (!TOKEN.test(token)) return null;
  const field = `${kind}Token`;

  const release = await releases().findOne({ [field]: token });
  if (release) {
    const client = await clients().findOne({ _id: release.clientId });
    return client ? { scope: 'version', client, release: release.archived ? null : release } : null;
  }

  const client = await clients().findOne({ [field]: token });
  if (!client) return null;
  const current = client.currentReleaseId
    ? await releases().findOne({ _id: client.currentReleaseId, archived: { $ne: true } })
    : null;
  return { scope: 'latest', client, release: current };
}

function sendRelease(req, res, release) {
  // Resumed and segmented downloads arrive as many ranged requests; count the first only.
  const range = req.get('range');
  if (req.method === 'GET' && (!range || /^bytes=0-/.test(range))) {
    releases()
      .updateOne({ _id: release._id }, { $inc: { downloads: 1 }, $set: { lastDownloadAt: new Date() } })
      .catch(() => {});
  }
  res.download(release.storedPath, release.fileName, { root: config.storageDir, dotfiles: 'allow' }, (err) => {
    if (err && !res.headersSent) {
      res.status(404).type('html').send(messagePage('File unavailable', 'This installer could not be found on the server.'));
    }
  });
}

const unavailable = (res, status, title, body) => res.status(status).type('html').send(messagePage(title, body));

// Master link: no password, starts downloading immediately.
downloads.get('/dl/:token', async (req, res) => {
  const link = await resolveLink('direct', req.params.token);
  if (!link) return unavailable(res, 404, 'Link not found', 'This download link is not valid. Ask for a new one.');
  if (!link.release) {
    return unavailable(res, 410, 'No longer available', 'This version has been withdrawn. Ask for an up-to-date link.');
  }
  sendRelease(req, res, link.release);
});

// Second half of the protected flow: a short-lived signed ticket issued by /unlock.
downloads.get('/dl/p/:releaseId', async (req, res) => {
  const expires = Number(req.query.e);
  const release = await releases().findOne({ _id: toObjectId(req.params.releaseId), archived: { $ne: true } });
  const secret = (await getSettings())?.linkSecret;
  const valid =
    release && secret && Number.isFinite(expires) && safeEqual(sign(secret, `${release._id}.${expires}`), req.query.s ?? '');

  if (!valid) return unavailable(res, 403, 'Link not valid', 'Open the original link again and enter the password.');
  if (expires < Date.now() / 1000) {
    return unavailable(res, 403, 'Link expired', 'Open the original link again and enter the password.');
  }
  sendRelease(req, res, release);
});

// What the unlock page shows before the password is entered.
publicApi.get('/public/link/:token', async (req, res) => {
  const link = await resolveLink('protected', req.params.token);
  if (!link) throw new HttpError(404, 'This download link is not valid.');
  const s = await getSettings();
  res.json({
    clientName: link.client.name,
    scope: link.scope,
    passwordSet: Boolean(s?.downloadPassword),
    release: link.release && {
      version: link.release.version,
      build: link.release.build,
      fileName: link.release.fileName,
      size: link.release.size,
      uploadedAt: link.release.uploadedAt,
    },
  });
});

publicApi.post('/public/unlock/:token', async (req, res) => {
  const key = `${req.ip}|${req.params.token}`;
  if (unlockFailures.blocked(key)) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');

  const link = await resolveLink('protected', req.params.token);
  if (!link) throw new HttpError(404, 'This download link is not valid.');

  const s = await getSettings();
  if (!s?.downloadPassword) throw new HttpError(423, 'Downloads are not open yet. Ask the sender to set a password.');
  if (!(await verifyPassword(String(req.body?.password ?? ''), s.downloadPassword.hash))) {
    unlockFailures.fail(key);
    throw new HttpError(401, 'Incorrect password.');
  }
  unlockFailures.clear(key);

  if (!link.release) throw new HttpError(410, 'This version has been withdrawn. Ask for an up-to-date link.');

  const expires = Math.floor(Date.now() / 1000) + DOWNLOAD_TICKET_TTL_S;
  const signature = sign(s.linkSecret, `${link.release._id}.${expires}`);
  res.json({
    url: `/dl/p/${link.release._id}?e=${expires}&s=${signature}`,
    fileName: link.release.fileName,
  });
});
