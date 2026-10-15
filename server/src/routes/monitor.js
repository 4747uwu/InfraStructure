import { Router } from 'express';
import { requireMaster, requireUser } from '../auth.js';
import { clients, metrics, servers, toObjectId } from '../db.js';
import { baseUrl, cleanText, HttpError } from '../http.js';
import { newToken, sha256Hex } from '../security.js';

// Monitoring: each client server runs agent/routerhub-agent.sh, which posts a report
// every minute. The latest report is kept on the server document; a slim copy of the
// headline numbers goes into `metrics` for the history charts.

const router = Router();

export const RETENTION_DAYS = 30;
const MIN_REPORT_GAP_MS = 10_000;

// Thresholds that turn a figure into a warning or a critical alert (percent used).
const LIMITS = {
  storage: { warning: 85, critical: 95 },
  memory: { warning: 90, critical: 95 },
  cpu: { warning: 90, critical: 97 },
};

// ---- report validation ------------------------------------------------------

const num = (v, max = 1e18) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max ? v : null);
const str = (v, len = 200) => (typeof v === 'string' ? v.slice(0, len) : '');
const pct = (used, total) => (used !== null && total ? Math.min(100, Math.max(0, (used / total) * 100)) : null);

function volume(v) {
  return {
    path: str(v?.path, 400),
    label: str(v?.label, 120),
    mount: str(v?.mount, 400),
    fs: str(v?.fs, 200),
    type: str(v?.type, 40),
    sizeBytes: num(v?.sizeBytes),
    usedBytes: num(v?.usedBytes),
    availBytes: num(v?.availBytes),
    error: str(v?.error, 120),
  };
}

function orthancStats(s) {
  if (!s || typeof s !== 'object') return null;
  return {
    patients: num(s.CountPatients),
    studies: num(s.CountStudies),
    series: num(s.CountSeries),
    instances: num(s.CountInstances),
    diskSizeMB: num(Number(s.TotalDiskSizeMB)),
    uncompressedSizeMB: num(Number(s.TotalUncompressedSizeMB)),
  };
}

export function parseReport(body) {
  if (!body || typeof body !== 'object' || !body.host || !body.cpu || !body.memory) {
    throw new HttpError(400, 'Report is missing host, cpu or memory.');
  }
  const list = (v, max) => (Array.isArray(v) ? v.slice(0, max) : []);
  return {
    agentVersion: str(body.agent, 20),
    interval: num(body.interval, 3600) || 60,
    host: {
      hostname: str(body.host.hostname, 120),
      os: str(body.host.os, 120),
      kernel: str(body.host.kernel, 80),
      uptimeSec: num(body.host.uptimeSec),
      cores: num(body.host.cores, 4096),
    },
    cpu: {
      usagePct: num(body.cpu.usagePct, 100),
      load1: num(body.cpu.load1, 1e6),
      load5: num(body.cpu.load5, 1e6),
      load15: num(body.cpu.load15, 1e6),
    },
    memory: {
      totalBytes: num(body.memory.totalBytes),
      availableBytes: num(body.memory.availableBytes),
      swapTotalBytes: num(body.memory.swapTotalBytes),
      swapFreeBytes: num(body.memory.swapFreeBytes),
    },
    disks: list(body.disks, 40).map(volume).filter((d) => d.mount && d.sizeBytes),
    storage: list(body.storage, 20).map(volume).filter((d) => d.path),
    orthanc: list(body.orthanc, 12).map((o) => ({
      name: str(o?.name, 120) || 'orthanc',
      url: str(o?.url, 300),
      storagePath: str(o?.storagePath, 400),
      httpStatus: num(o?.httpStatus, 999) || 0,
      version: str(o?.system?.Version, 40),
      stats: orthancStats(o?.statistics),
    })),
  };
}

// Headline numbers, used for the cards, alerts and history.
export function summarize(report) {
  const mem = report.memory;
  const memUsed = mem.totalBytes !== null && mem.availableBytes !== null ? mem.totalBytes - mem.availableBytes : null;

  // The DICOM storage is what matters most. Use the fullest of the storage volumes the
  // agent reported (configured paths and Orthanc's own); without any, the fullest disk.
  const volumes = report.storage.filter((v) => v.sizeBytes);
  const pool = volumes.length ? volumes : report.disks;
  // Same basis as df's Use%: used / (used + available), which leaves out root-reserved blocks.
  const capacity = (v) => (v.usedBytes !== null && v.availBytes !== null ? v.usedBytes + v.availBytes : v.sizeBytes);
  let storage = null;
  for (const v of pool) {
    const p = pct(v.usedBytes, capacity(v));
    if (p !== null && (!storage || p > storage.pct)) storage = { pct: p, usedBytes: v.usedBytes, totalBytes: capacity(v), path: v.path || v.mount, mount: v.mount };
  }

  // A folder under /mnt or /media that df places on "/" means the volume meant for it is
  // not mounted (detached, or missing from fstab after a reboot): files land on the system disk.
  const offVolume = report.storage.filter((v) => /^\/(mnt|media)\//.test(v.path) && v.mount === '/').map((v) => v.path);

  const reached = report.orthanc.filter((o) => o.stats);
  const sum = (key) => (reached.length ? reached.reduce((n, o) => n + (o.stats[key] || 0), 0) : null);
  return {
    cpuPct: report.cpu.usagePct,
    memPct: pct(memUsed, mem.totalBytes),
    memUsedBytes: memUsed,
    memTotalBytes: mem.totalBytes,
    storagePct: storage?.pct ?? null,
    storageUsedBytes: storage?.usedBytes ?? null,
    storageTotalBytes: storage?.totalBytes ?? null,
    storagePath: storage?.path || '',
    orthancFound: report.orthanc.length,
    orthancReached: reached.length,
    studies: sum('studies'),
    instances: sum('instances'),
    offVolume,
  };
}

// ---- views ------------------------------------------------------------------

function statusOf(server, now = Date.now()) {
  if (!server.lastReportAt) return 'waiting';
  const interval = (server.last?.interval || 60) * 1000;
  return now - new Date(server.lastReportAt).getTime() <= Math.max(3 * interval, 150_000) ? 'online' : 'offline';
}

function level(value, limits) {
  if (value === null || value === undefined) return null;
  if (value >= limits.critical) return 'critical';
  if (value >= limits.warning) return 'warning';
  return null;
}

function alertsOf(server, status) {
  const out = [];
  if (status === 'offline') out.push({ level: 'critical', metric: 'status', message: 'Not reporting' });
  const s = server.summary;
  if (!s) return out;
  const add = (metric, value, label) => {
    const l = level(value, LIMITS[metric]);
    if (l) out.push({ level: l, metric, message: `${label} at ${Math.round(value)}%` });
  };
  add('storage', s.storagePct, 'Storage');
  add('memory', s.memPct, 'Memory');
  add('cpu', s.cpuPct, 'CPU');
  if (s.offVolume?.length) {
    out.push({ level: 'warning', metric: 'volume', message: `Storage folder ${s.offVolume[0]} is on the system disk; its volume is not mounted` });
  }
  if (s.orthancFound > s.orthancReached) {
    out.push({ level: 'warning', metric: 'orthanc', message: s.orthancReached ? 'An Orthanc is not answering' : 'Orthanc is not answering' });
  }
  return out;
}

function serverView(server, { full = false } = {}) {
  const status = statusOf(server);
  return {
    id: String(server._id),
    name: server.name,
    clientId: server.clientId ? String(server.clientId) : null,
    tokenHint: server.tokenHint,
    createdAt: server.createdAt,
    lastReportAt: server.lastReportAt || null,
    status,
    alerts: alertsOf(server, status),
    summary: server.summary || null,
    host: server.last?.host || null,
    agentVersion: server.last?.agentVersion || null,
    interval: server.last?.interval || null,
    orthanc: (server.last?.orthanc || []).map((o) => ({ name: o.name, version: o.version, reachable: Boolean(o.stats), stats: o.stats })),
    ...(full ? { report: server.last || null } : {}),
  };
}

function installCommand(req, token) {
  const base = baseUrl(req);
  return `curl -fsSL ${base}/agent/install.sh | sudo bash -s -- --hub ${base} --token ${token}`;
}

async function parseServerFields(body, { partial }) {
  const out = {};
  if (!partial || body.name !== undefined) {
    out.name = cleanText(body.name, 80);
    if (!out.name) throw new HttpError(400, 'Give the server a name.');
  }
  if (body.clientId !== undefined) {
    if (!body.clientId) out.clientId = null;
    else {
      const client = await clients().findOne({ _id: toObjectId(body.clientId) }, { projection: { _id: 1 } });
      if (!client) throw new HttpError(400, 'That client does not exist.');
      out.clientId = client._id;
    }
  }
  return out;
}

const newAgentToken = () => {
  const token = `ra_${newToken(24)}`;
  return { token, tokenHash: sha256Hex(token), tokenHint: token.slice(-4) };
};

async function findServer(id) {
  const server = await servers().findOne({ _id: toObjectId(id) });
  if (!server) throw new HttpError(404, 'This server is not being monitored.');
  return server;
}

// ---- agent ingest (token auth, no session) ------------------------------------

router.post('/agent/report', async (req, res) => {
  const bearer = /^Bearer\s+(ra_[\w-]{16,64})$/i.exec(req.get('authorization') || '');
  if (!bearer) throw new HttpError(401, 'Send the agent token as a Bearer token.');
  const server = await servers().findOne({ tokenHash: sha256Hex(bearer[1]) });
  if (!server) throw new HttpError(401, 'Unknown agent token. Re-run the install command from Router Hub.');

  const now = new Date();
  if (server.lastReportAt && now - server.lastReportAt < MIN_REPORT_GAP_MS) {
    throw new HttpError(429, 'Reports are coming in too often.');
  }

  const report = parseReport(req.body);
  const summary = summarize(report);
  await servers().updateOne({ _id: server._id }, { $set: { last: report, summary, lastReportAt: now } });
  await metrics().insertOne({
    serverId: server._id,
    at: now,
    cpu: summary.cpuPct,
    mem: summary.memPct,
    disk: summary.storagePct,
    studies: summary.studies,
  });
  res.json({ ok: true, interval: report.interval });
});

// ---- servers --------------------------------------------------------------------

router.get('/servers', requireUser, async (_req, res) => {
  const all = await servers().find().sort({ name: 1 }).collation({ locale: 'en', strength: 2 }).toArray();
  res.json({ servers: all.map((s) => serverView(s)) });
});

router.get('/servers/:id', requireUser, async (req, res) => {
  res.json({ server: serverView(await findServer(req.params.id), { full: true }) });
});

const RANGES = {
  '6h': { span: 6 * 3600e3, bucket: 2 * 60e3 },
  '24h': { span: 24 * 3600e3, bucket: 5 * 60e3 },
  '7d': { span: 7 * 24 * 3600e3, bucket: 30 * 60e3 },
  '30d': { span: 30 * 24 * 3600e3, bucket: 2 * 3600e3 },
};

// Averaged into buckets, so a week of minute-by-minute reports stays a few hundred points.
router.get('/servers/:id/history', requireUser, async (req, res) => {
  const server = await findServer(req.params.id);
  const range = RANGES[req.query.range] ? req.query.range : '24h';
  const { span, bucket } = RANGES[range];
  const since = new Date(Date.now() - span);
  const rows = await metrics()
    .aggregate([
      { $match: { serverId: server._id, at: { $gte: since } } },
      { $group: { _id: { $subtract: [{ $toLong: '$at' }, { $mod: [{ $toLong: '$at' }, bucket] }] }, cpu: { $avg: '$cpu' }, mem: { $avg: '$mem' }, disk: { $max: '$disk' } } },
      { $sort: { _id: 1 } },
    ])
    .toArray();
  const round = (v) => (typeof v === 'number' ? Math.round(v * 10) / 10 : null);
  res.json({
    range,
    bucketMs: bucket,
    since,
    points: rows.map((r) => ({ t: new Date(r._id), cpu: round(r.cpu), mem: round(r.mem), disk: round(r.disk) })),
  });
});

router.post('/servers', requireMaster, async (req, res) => {
  const fields = await parseServerFields(req.body || {}, { partial: false });
  const { token, tokenHash, tokenHint } = newAgentToken();
  const doc = { name: fields.name, clientId: fields.clientId ?? null, tokenHash, tokenHint, createdBy: req.auth.username, createdAt: new Date(), lastReportAt: null };
  const { insertedId } = await servers().insertOne(doc);
  res.status(201).json({ server: serverView({ ...doc, _id: insertedId }), token, installCommand: installCommand(req, token) });
});

router.patch('/servers/:id', requireMaster, async (req, res) => {
  const server = await findServer(req.params.id);
  const set = await parseServerFields(req.body || {}, { partial: true });
  await servers().updateOne({ _id: server._id }, { $set: set });
  res.json({ ok: true });
});

// A new token (and install command); the old one stops working at once.
router.post('/servers/:id/token', requireMaster, async (req, res) => {
  const server = await findServer(req.params.id);
  const { token, tokenHash, tokenHint } = newAgentToken();
  await servers().updateOne({ _id: server._id }, { $set: { tokenHash, tokenHint } });
  res.json({ token, installCommand: installCommand(req, token) });
});

// Stops monitoring a server: its token stops working and its history is removed.
router.delete('/servers/:id', requireMaster, async (req, res) => {
  const server = await findServer(req.params.id);
  await servers().deleteOne({ _id: server._id });
  await metrics().deleteMany({ serverId: server._id });
  res.json({ ok: true });
});

export default router;
