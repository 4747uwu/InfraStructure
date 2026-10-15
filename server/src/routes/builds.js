import { Binary } from 'mongodb';
import { Router } from 'express';
import { requireMaster } from '../auth.js';
import { builderStatus, builds, clients, toObjectId } from '../db.js';
import { cleanText, HttpError } from '../http.js';
import { clientView } from '../serialize.js';
import { createClient, findClient, parseClientName } from './clients.js';

// Router Builder: the master fills in a form, the hub queues a job, and the builder
// container (builder/worker.mjs) turns ultimate/ into that client's installer and
// uploads it here as a new Windows build of the client.

const router = Router();
router.use('/builds', requireMaster);

export const STEPS = ['queued', 'preparing', 'customizing', 'engine', 'packaging', 'uploading', 'done'];
const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function url(value, label, { required }) {
  const raw = cleanText(value, 300);
  if (!raw) {
    if (required) throw new HttpError(400, `Enter the ${label}.`);
    return '';
  }
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new HttpError(400, `The ${label} is not a valid address. Use the form https://name.example.com`);
  }
  if (!/^https?:$/.test(u.protocol)) throw new HttpError(400, `The ${label} must start with https:// (or http://).`);
  if (u.username || u.password) throw new HttpError(400, `The ${label} must not contain a username or password.`);
  // Only scheme, host and port are used: the router appends its own paths.
  return `${u.protocol}//${u.host}`;
}

function port(value, label, min) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > 65535) throw new HttpError(400, `The ${label} must be a whole number from ${min} to 65535.`);
  return n;
}

// Mirrors the checks in ultimate/tools/customize.js, which runs them again on the builder.
export function parseSpec(body) {
  const productName = cleanText(body.productName, 60);
  if (!/^[A-Za-z0-9][A-Za-z0-9 .&()'-]*$/.test(productName)) {
    throw new HttpError(400, 'The product name may use letters, numbers, spaces and . & ( ) \' - only.');
  }
  const aet = cleanText(body.aet, 16).toUpperCase();
  if (!/^[A-Z0-9_]{1,16}$/.test(aet)) throw new HttpError(400, 'The AE title is 1 to 16 capital letters, digits or _.');
  const version = cleanText(body.version, 20) || '1.0.0';
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new HttpError(400, 'The version looks like 1.0.0.');

  const spec = {
    productName,
    aet,
    version,
    dicomPort: port(body.dicomPort, 'DICOM port', 1),
    httpPort: port(body.httpPort, 'local API port', 1024),
    peer1: url(body.peer1, 'Peer 1 URL', { required: true }),
    peer2: url(body.peer2, 'Peer 2 URL', { required: false }),
    apiMain: url(body.apiMain, 'main API URL', { required: true }),
    apiBackup: url(body.apiBackup, 'backup API URL', { required: false }),
    compression: Boolean(body.compression),
  };
  if (spec.dicomPort === spec.httpPort) throw new HttpError(400, 'The DICOM port and the local API port must be different.');

  // Optional advanced settings; the template's values apply when they are left empty.
  const user = cleanText(body.peerUsername, 80);
  if (user) {
    if (!/^[\w.@-]+$/.test(user)) throw new HttpError(400, 'The receiver username may use letters, numbers and . @ _ - only.');
    spec.peerUsername = user;
  }
  const pass = String(body.peerPassword ?? '').trim();
  if (pass) {
    if (!/^[\x21-\x7e]{1,120}$/.test(pass)) throw new HttpError(400, 'The receiver password may not contain spaces or special characters outside plain ASCII.');
    spec.peerPassword = pass;
  }
  const pin = cleanText(body.settingsPin, 12);
  if (pin) {
    if (!/^\d{4,12}$/.test(pin)) throw new HttpError(400, 'The settings PIN is 4 to 12 digits.');
    spec.settingsPin = pin;
  }
  return spec;
}

function parseLogo(dataUrl) {
  if (!dataUrl) return null;
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl));
  if (!m) throw new HttpError(400, 'The logo must be a PNG image.');
  const bytes = Buffer.from(m[1], 'base64');
  if (bytes.length > MAX_LOGO_BYTES) throw new HttpError(400, 'The logo must be 2 MB or smaller.');
  if (!bytes.subarray(0, 8).equals(PNG)) throw new HttpError(400, 'The logo is not a valid PNG file.');
  return new Binary(bytes);
}

const view = (job, { withLog = false, since = 0 } = {}) => ({
  id: String(job._id),
  status: job.status,
  step: job.step,
  steps: STEPS,
  spec: { ...job.spec, peerPassword: job.spec.peerPassword ? '••••••••' : undefined },
  hasLogo: Boolean(job.logo),
  clientId: job.clientId ? String(job.clientId) : null,
  clientName: job.clientName,
  createdBy: job.createdBy,
  createdAt: job.createdAt,
  startedAt: job.startedAt || null,
  finishedAt: job.finishedAt || null,
  error: job.error || null,
  result: job.result || null,
  cancelRequested: Boolean(job.cancelRequested),
  ...(withLog ? { log: (job.log || []).slice(since), logLength: (job.log || []).length } : {}),
});

const summaryProjection = { log: 0, logo: 0 };

router.get('/builds', async (_req, res) => {
  const list = await builds().find({}, { projection: summaryProjection }).sort({ createdAt: -1 }).limit(40).toArray();
  res.json({ builds: list.map((b) => view(b)) });
});

// Is the builder container alive? It writes a heartbeat every few seconds.
router.get('/builds/builder', async (_req, res) => {
  const s = await builderStatus().findOne({ _id: 'main' });
  const online = Boolean(s && Date.now() - new Date(s.lastSeen).getTime() < 45_000);
  const queued = await builds().countDocuments({ status: 'queued' });
  res.json({ online, lastSeen: s?.lastSeen || null, busy: s?.busy || null, version: s?.version || null, queued });
});

// The settings of the most recent build for a client, to start a rebuild from.
router.get('/builds/last-spec', async (req, res) => {
  const client = await findClient(String(req.query.client || ''));
  if (!client) return res.json({ spec: null });
  const last = await builds().find({ clientId: client._id }, { projection: { spec: 1 } }).sort({ createdAt: -1 }).limit(1).next();
  res.json({ spec: last?.spec || null });
});

router.get('/builds/:id', async (req, res) => {
  const job = await builds().findOne({ _id: toObjectId(req.params.id) }, { projection: { logo: 0 } });
  if (!job) throw new HttpError(404, 'This build does not exist.');
  res.json({ build: view(job, { withLog: true, since: Math.max(0, Number(req.query.since) || 0) }) });
});

router.post('/builds', async (req, res) => {
  const body = req.body || {};
  const spec = parseSpec(body);
  const logo = parseLogo(body.logo);

  // Into an existing client, or a new one named after the product.
  let client;
  if (body.clientId) {
    client = await clients().findOne({ _id: toObjectId(body.clientId) });
    if (!client) throw new HttpError(400, 'That client does not exist.');
  } else {
    const name = parseClientName(body.clientName || spec.productName);
    client = (await findClient(name.name)) || (await createClient(name, 'Created by Router Builder', req.auth.username));
  }

  // Do not let one client end up with two builds racing for the same version.
  const busy = await builds().findOne({ clientId: client._id, status: { $in: ['queued', 'running'] } });
  if (busy) throw new HttpError(409, `A build for ${client.name} is already ${busy.status}. Wait for it to finish.`);

  const doc = {
    status: 'queued',
    step: 'queued',
    spec,
    logo,
    clientId: client._id,
    clientName: client.name,
    createdBy: req.auth.username,
    createdAt: new Date(),
    log: [],
  };
  const { insertedId } = await builds().insertOne(doc);
  res.status(201).json({ build: view({ ...doc, _id: insertedId }), client: clientView(req, client) });
});

// Queued builds stop at once; a running one stops at the builder's next check (a few seconds).
router.post('/builds/:id/cancel', async (req, res) => {
  const id = toObjectId(req.params.id);
  const queued = await builds().updateOne({ _id: id, status: 'queued' }, { $set: { status: 'cancelled', finishedAt: new Date(), error: 'Cancelled before it started.' } });
  if (queued.modifiedCount) return res.json({ ok: true });
  const running = await builds().updateOne({ _id: id, status: 'running' }, { $set: { cancelRequested: true } });
  if (!running.matchedCount) throw new HttpError(409, 'This build has already finished.');
  res.json({ ok: true });
});

export default router;
