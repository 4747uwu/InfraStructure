import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, unlink } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Router } from 'express';
import { requireMaster, requireUploader } from '../auth.js';
import { ALLOWED_EXTENSIONS, config } from '../config.js';
import { clients, ObjectId, releases, toObjectId } from '../db.js';
import { cleanText, HttpError, safeFileName } from '../http.js';
import { newToken } from '../security.js';
import { releaseView } from '../serialize.js';
import { createClient, findClient, parseClientName } from './clients.js';

const router = Router();

const findDuplicate = (clientId, sha256) => releases().findOne({ clientId, sha256, archived: { $ne: true } });

const duplicateMessage = (dup) =>
  `This exact file is already stored as version ${dup.version} (build ${dup.build}). Nothing was uploaded.`;

// Lets the publish script find out a build is already stored before sending 60+ MB.
router.get('/upload/check', requireUploader, async (req, res) => {
  const sha = cleanText(req.query.sha256, 64).toLowerCase();
  const client = await findClient(String(req.query.client ?? ''));
  const dup = client && /^[0-9a-f]{64}$/.test(sha) ? await findDuplicate(client._id, sha) : null;
  res.json({
    clientExists: Boolean(client),
    client: client ? { name: client.name, slug: client.slug } : null,
    duplicate: dup ? { version: dup.version, build: dup.build, uploadedAt: dup.uploadedAt } : null,
  });
});

// The file is the raw request body; everything else rides in the query string.
// That keeps the browser (XHR with progress) and the script (curl -T) on one code path.
router.put('/upload', requireUploader, async (req, res) => {
  const fail = (status, message) => {
    req.resume(); // drain the unread body so the client receives the answer instead of a reset
    throw new HttpError(status, message);
  };

  const fileName = safeFileName(req.query.filename);
  const version = cleanText(req.query.version, 40);
  const notes = cleanText(req.query.notes, 2000);
  const clientRef = cleanText(req.query.client, 80);
  const expectedSha = cleanText(req.query.sha256, 64).toLowerCase();
  const force = req.query.force === '1';

  if (!clientRef) fail(400, 'Choose which client this router belongs to.');
  if (!version) fail(400, 'Enter a version, for example 0.1.2.');
  if (!fileName) fail(400, 'The file needs a name.');
  if (!ALLOWED_EXTENSIONS.includes(extname(fileName).toLowerCase())) {
    fail(415, `Only installer files can be stored (${ALLOWED_EXTENSIONS.join(', ')}).`);
  }
  const maxMb = Math.round(config.maxUploadBytes / 1048576);
  if (Number(req.get('content-length')) > config.maxUploadBytes) fail(413, `This file is larger than the ${maxMb} MB limit.`);

  let client = await findClient(clientRef);
  if (!client) {
    let parsed;
    try {
      parsed = parseClientName(clientRef);
    } catch (err) {
      fail(err.status, err.message);
    }
    client = await createClient(parsed, '', req.auth.username);
  }

  const id = new ObjectId();
  const incoming = join(config.storageDir, '.incoming', `${id}.part`);
  const discard = () => unlink(incoming).catch(() => {});

  const hash = createHash('sha256');
  let size = 0;
  const meter = new Transform({
    transform(chunk, _enc, done) {
      size += chunk.length;
      if (size > config.maxUploadBytes) return done(new HttpError(413, `This file is larger than the ${maxMb} MB limit.`));
      hash.update(chunk);
      done(null, chunk);
    },
  });

  try {
    await pipeline(req, meter, createWriteStream(incoming));
  } catch (err) {
    await discard();
    throw err instanceof HttpError ? err : new HttpError(400, 'The upload was interrupted. Try again.');
  }

  const sha256 = hash.digest('hex');
  if (size === 0) {
    await discard();
    throw new HttpError(400, 'The file is empty.');
  }
  if (expectedSha && expectedSha !== sha256) {
    await discard();
    throw new HttpError(422, 'The file was damaged in transit (checksum mismatch). Try again.');
  }
  if (!force) {
    const dup = await findDuplicate(client._id, sha256);
    if (dup) {
      await discard();
      throw new HttpError(409, duplicateMessage(dup));
    }
  }

  // Build numbers tell apart rebuilds that keep the same version string.
  const { buildSeq: build } = await clients().findOneAndUpdate(
    { _id: client._id },
    { $inc: { buildSeq: 1 } },
    { returnDocument: 'after' },
  );

  const storedPath = `${client.slug}/${String(build).padStart(4, '0')}__${fileName}`;
  await mkdir(join(config.storageDir, client.slug), { recursive: true });
  await rename(incoming, join(config.storageDir, storedPath));

  const release = {
    _id: id,
    clientId: client._id,
    version,
    build,
    fileName,
    storedPath,
    size,
    sha256,
    notes,
    source: req.auth.role === 'deploy' ? 'script' : 'web',
    uploadedBy: req.auth.username,
    uploadedAt: new Date(),
    directToken: newToken(),
    protectedToken: newToken(),
    downloads: 0,
    lastDownloadAt: null,
    archived: false,
  };
  await releases().insertOne(release);

  // A new upload becomes the version the client's "latest" links serve.
  client = await clients().findOneAndUpdate(
    { _id: client._id },
    { $set: { currentReleaseId: id, updatedAt: release.uploadedAt } },
    { returnDocument: 'after' },
  );

  res.status(201).json({
    release: releaseView(req, release, client),
    client: { id: String(client._id), name: client.name, slug: client.slug },
  });
});

router.patch('/releases/:id', requireMaster, async (req, res) => {
  const release = await releases().findOne({ _id: toObjectId(req.params.id) });
  if (!release) throw new HttpError(404, 'This version does not exist.');

  const set = {};
  if (req.body?.notes !== undefined) set.notes = cleanText(req.body.notes, 2000);
  if (req.body?.version !== undefined) {
    set.version = cleanText(req.body.version, 40);
    if (!set.version) throw new HttpError(400, 'Enter a version, for example 0.1.2.');
  }
  if (req.body?.archived !== undefined) set.archived = Boolean(req.body.archived);
  if (Object.keys(set).length) await releases().updateOne({ _id: release._id }, { $set: set });

  // Archiving withdraws the links but keeps the file. If it was the current
  // version, fall back to the newest one still available.
  if (set.archived === true) {
    const client = await clients().findOne({ _id: release.clientId });
    if (String(client?.currentReleaseId) === String(release._id)) {
      const next = await releases()
        .find({ clientId: release.clientId, archived: { $ne: true } })
        .sort({ uploadedAt: -1 })
        .limit(1)
        .next();
      await clients().updateOne(
        { _id: release.clientId },
        { $set: { currentReleaseId: next?._id || null, updatedAt: new Date() } },
      );
    }
  }
  // Restoring into a client left with no current version makes this one current again.
  if (set.archived === false) {
    await clients().updateOne(
      { _id: release.clientId, currentReleaseId: null },
      { $set: { currentReleaseId: release._id, updatedAt: new Date() } },
    );
  }
  res.json({ ok: true });
});

// Invalidates the links already shared for this one version.
router.post('/releases/:id/rotate-links', requireMaster, async (req, res) => {
  const result = await releases().updateOne(
    { _id: toObjectId(req.params.id) },
    { $set: { directToken: newToken(), protectedToken: newToken() } },
  );
  if (!result.matchedCount) throw new HttpError(404, 'This version does not exist.');
  res.json({ ok: true });
});

export default router;
