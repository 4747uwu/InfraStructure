import { config } from './config.js';
import { alerts, clients, getSettings, servers } from './db.js';
import { notify } from './notify.js';

// Alert lifecycle: a condition that becomes true opens one alert (and notifies); it stays
// open, however many reports repeat it, until the condition clears, which resolves it (and
// notifies again). Noisy figures must persist across several reports before they count.

export const DEFAULT_STORAGE_THRESHOLD = 93;
const HYSTERESIS = 1; // storage must fall this many points below the threshold to resolve
const SUSTAINED = { memory: 5, cpu: 5, orthanc: 3 }; // consecutive reports (about a minute each)
const MEMORY_LIMIT = 95;
const CPU_LIMIT = 97;
// Both overridable for tests only.
const OFFLINE_AFTER_MS = Number(process.env.ALERT_OFFLINE_AFTER_MS ?? 5 * 60_000);
const SWEEP_EVERY_MS = Number(process.env.ALERT_SWEEP_MS ?? 60_000);

export const storageThreshold = (settings) => settings?.notifications?.storageThreshold ?? DEFAULT_STORAGE_THRESHOLD;

const GB = 1024 ** 3;
const size = (b) => (b >= 1024 * GB ? `${(b / (1024 * GB)).toFixed(1)} TB` : `${(b / GB).toFixed(1)} GB`);
const pct = (v) => `${Math.round(v)}%`;

// The conditions true right now for this server, keyed by alert type.
function currentConditions(summary, streaks, threshold, storageAlreadyOpen) {
  const out = new Map();
  const limit = storageAlreadyOpen ? threshold - HYSTERESIS : threshold;
  if (summary.storagePct !== null && summary.storagePct >= limit) {
    out.set('storage', {
      level: 'critical',
      value: summary.storagePct,
      message: `Storage at ${pct(summary.storagePct)}: ${size(summary.storageUsedBytes)} of ${size(summary.storageTotalBytes)} used on ${summary.storagePath}`,
    });
  }
  if (summary.offVolume?.length) {
    out.set('volume', {
      level: 'warning',
      message: `Storage folder ${summary.offVolume[0]} is on the system disk; its volume is not mounted`,
    });
  }
  if (streaks.orthanc >= SUSTAINED.orthanc) {
    out.set('orthanc', { level: 'warning', message: summary.orthancReached ? 'An Orthanc on this server is not answering' : 'Orthanc is not answering' });
  }
  if (streaks.memory >= SUSTAINED.memory) {
    out.set('memory', { level: 'warning', value: summary.memPct, message: `Memory above ${MEMORY_LIMIT}% for ${streaks.memory} minutes (now ${pct(summary.memPct)})` });
  }
  if (streaks.cpu >= SUSTAINED.cpu) {
    out.set('cpu', { level: 'warning', value: summary.cpuPct, message: `CPU above ${CPU_LIMIT}% for ${streaks.cpu} minutes (now ${pct(summary.cpuPct)})` });
  }
  return out;
}

async function describe(server) {
  const client = server.clientId ? await clients().findOne({ _id: server.clientId }, { projection: { name: 1 } }) : null;
  return client ? `${server.name} (${client.name})` : server.name;
}

async function link(serverId) {
  const base = config.publicBaseUrl || (await getSettings())?.notifications?.baseUrl || '';
  return base ? `\n\nOpen: ${base}/servers/${serverId}` : '';
}

async function open(server, key, condition) {
  const now = new Date();
  const doc = { serverId: server._id, key, level: condition.level, message: condition.message, value: condition.value ?? null, open: true, openedAt: now, resolvedAt: null, acknowledgedAt: null, acknowledgedBy: null };
  try {
    const { insertedId } = await alerts().insertOne(doc);
    const who = await describe(server);
    const tag = condition.level === 'critical' ? 'CRITICAL' : 'WARNING';
    const results = await notify(`[${tag}] ${who}: ${condition.message}`, `${condition.message}.\n\nServer: ${who}\nSince: ${now.toUTCString()}${await link(server._id)}`);
    await alerts().updateOne({ _id: insertedId }, { $set: { notifiedAt: new Date(), notifyResults: results } });
  } catch (err) {
    if (err?.code !== 11000) throw err; // another report already opened it
  }
}

async function resolve(server, alert, detail) {
  const now = new Date();
  const result = await alerts().updateOne({ _id: alert._id, open: true }, { $set: { open: false, resolvedAt: now, resolvedDetail: detail || '' } });
  if (!result.modifiedCount) return;
  const who = await describe(server);
  const minutes = Math.max(1, Math.round((now - alert.openedAt) / 60_000));
  await notify(`[RESOLVED] ${who}: ${alert.message}`, `Cleared after ${minutes} minute${minutes === 1 ? '' : 's'}. ${detail || ''}\n\nServer: ${who}${await link(server._id)}`);
}

// Called after every report.
export async function evaluateReport(server, summary) {
  const settings = await getSettings();
  const threshold = storageThreshold(settings);

  const prev = server.streaks || {};
  const streaks = {
    memory: summary.memPct !== null && summary.memPct >= MEMORY_LIMIT ? (prev.memory || 0) + 1 : 0,
    cpu: summary.cpuPct !== null && summary.cpuPct >= CPU_LIMIT ? (prev.cpu || 0) + 1 : 0,
    orthanc: summary.orthancFound > summary.orthancReached ? (prev.orthanc || 0) + 1 : 0,
  };
  await servers().updateOne({ _id: server._id }, { $set: { streaks } });

  const openAlerts = await alerts().find({ serverId: server._id, open: true }).toArray();
  const openKeys = new Map(openAlerts.map((a) => [a.key, a]));
  const now = currentConditions(summary, streaks, threshold, openKeys.has('storage'));

  for (const [key, condition] of now) {
    if (!openKeys.has(key)) await open(server, key, condition);
    else if (condition.value !== undefined) await alerts().updateOne({ _id: openKeys.get(key)._id }, { $set: { value: condition.value } });
  }
  for (const [key, alert] of openKeys) {
    if (key === 'offline') await resolve(server, alert, 'The server is reporting again.');
    else if (!now.has(key)) {
      const detail = key === 'storage' && summary.storagePct !== null ? `Storage is now at ${pct(summary.storagePct)}.` : '';
      await resolve(server, alert, detail);
    }
  }
}

// Runs every minute: servers that have gone quiet.
export async function sweepOffline() {
  const nowMs = Date.now();
  const candidates = await servers().find({ lastReportAt: { $ne: null } }).toArray();
  for (const server of candidates) {
    const quietFor = nowMs - new Date(server.lastReportAt).getTime();
    const allowed = Math.max(OFFLINE_AFTER_MS, 3 * (server.last?.interval || 60) * 1000);
    if (quietFor <= allowed) continue;
    const existing = await alerts().findOne({ serverId: server._id, key: 'offline', open: true });
    if (!existing) {
      await open(server, 'offline', {
        level: 'critical',
        message: `Not reporting since ${new Date(server.lastReportAt).toUTCString()}`,
      });
    }
  }
}

let timer = null;
export function startAlertSweeper() {
  if (timer) return;
  timer = setInterval(() => sweepOffline().catch((err) => console.error('  Offline check failed:', err.message)), SWEEP_EVERY_MS);
  timer.unref();
}
