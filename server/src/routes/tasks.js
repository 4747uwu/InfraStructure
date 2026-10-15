import { Router } from 'express';
import { requireUser } from '../auth.js';
import { clients, tasks, toObjectId } from '../db.js';
import { cleanText, HttpError } from '../http.js';
import { normalizePlatform } from '../platforms.js';

// The change board: requests and to-dos, each optionally tagged with a client and a
// platform, moved between Pending, In Progress and Completed. Both accounts can use it.

const router = Router();
router.use('/tasks', requireUser);

export const STATUSES = ['pending', 'in_progress', 'completed'];
export const PRIORITIES = ['urgent', 'high', 'medium', 'low'];
const GAP = 1024; // spacing between card positions; new positions go halfway between neighbours

const view = (t) => ({
  id: String(t._id),
  title: t.title,
  details: t.details || '',
  status: t.status,
  order: t.order,
  clientId: t.clientId ? String(t.clientId) : null,
  platform: t.platform || null,
  priority: t.priority || 'medium',
  dueAt: t.dueAt || null,
  createdBy: t.createdBy,
  createdAt: t.createdAt,
  updatedBy: t.updatedBy,
  updatedAt: t.updatedAt,
  completedAt: t.completedAt || null,
});

async function parseFields(body, { partial }) {
  const out = {};
  if (!partial || body.title !== undefined) {
    out.title = cleanText(body.title, 200);
    if (!out.title) throw new HttpError(400, 'Give the card a title.');
  }
  if (body.details !== undefined) out.details = String(body.details ?? '').slice(0, 4000);
  if (!partial || body.status !== undefined) {
    out.status = body.status ?? 'pending';
    if (!STATUSES.includes(out.status)) throw new HttpError(400, 'Status must be pending, in progress or completed.');
  }
  if (body.clientId !== undefined) {
    if (body.clientId === null || body.clientId === '') out.clientId = null;
    else {
      const client = await clients().findOne({ _id: toObjectId(body.clientId) }, { projection: { _id: 1 } });
      if (!client) throw new HttpError(400, 'That client does not exist.');
      out.clientId = client._id;
    }
  }
  if (body.platform !== undefined) {
    out.platform = body.platform ? normalizePlatform(body.platform) : null;
    if (body.platform && !out.platform) throw new HttpError(400, 'Platform must be windows, mac-arm or mac-intel.');
  }
  if (!partial || body.priority !== undefined) {
    out.priority = body.priority ?? 'medium';
    if (!PRIORITIES.includes(out.priority)) throw new HttpError(400, 'Priority must be urgent, high, medium or low.');
  }
  if (body.dueAt !== undefined) {
    if (body.dueAt === null || body.dueAt === '') out.dueAt = null;
    else {
      out.dueAt = new Date(body.dueAt);
      if (Number.isNaN(out.dueAt.getTime())) throw new HttpError(400, 'The due date is not a valid date and time.');
    }
  }
  if (body.order !== undefined) {
    out.order = Number(body.order);
    if (!Number.isFinite(out.order)) throw new HttpError(400, 'Order must be a number.');
  }
  return out;
}

async function bottomOf(status) {
  const last = await tasks().find({ status }).sort({ order: -1 }).limit(1).next();
  return (last?.order ?? 0) + GAP;
}

router.get('/tasks', async (_req, res) => {
  const all = await tasks().find().sort({ status: 1, order: 1 }).toArray();
  res.json({ tasks: all.map(view) });
});

router.post('/tasks', async (req, res) => {
  const fields = await parseFields(req.body || {}, { partial: false });
  const now = new Date();
  const doc = {
    title: fields.title,
    details: fields.details || '',
    status: fields.status,
    clientId: fields.clientId ?? null,
    platform: fields.platform ?? null,
    priority: fields.priority,
    dueAt: fields.dueAt ?? null,
    order: fields.order ?? (await bottomOf(fields.status)),
    createdBy: req.auth.username,
    createdAt: now,
    updatedBy: req.auth.username,
    updatedAt: now,
    completedAt: fields.status === 'completed' ? now : null,
  };
  const { insertedId } = await tasks().insertOne(doc);
  res.status(201).json({ task: view({ ...doc, _id: insertedId }) });
});

router.patch('/tasks/:id', async (req, res) => {
  const id = toObjectId(req.params.id);
  const existing = id && (await tasks().findOne({ _id: id }));
  if (!existing) throw new HttpError(404, 'This card no longer exists.');

  const set = await parseFields(req.body || {}, { partial: true });
  set.updatedBy = req.auth.username;
  set.updatedAt = new Date();
  if (set.status && set.status !== existing.status) {
    set.completedAt = set.status === 'completed' ? set.updatedAt : null;
    if (set.order === undefined) set.order = await bottomOf(set.status);
  }
  const updated = await tasks().findOneAndUpdate({ _id: id }, { $set: set }, { returnDocument: 'after' });
  res.json({ task: view(updated) });
});

router.delete('/tasks/:id', async (req, res) => {
  const result = await tasks().deleteOne({ _id: toObjectId(req.params.id) });
  if (!result.deletedCount) throw new HttpError(404, 'This card no longer exists.');
  res.json({ ok: true });
});

export default router;
