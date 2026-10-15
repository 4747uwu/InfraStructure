import { Router } from 'express';
import { requireMaster, requireUser } from '../auth.js';
import { clients, releases, toObjectId } from '../db.js';
import { cleanText, HttpError, slugify } from '../http.js';
import { field, macLinkFields, normalizePlatform, PLATFORMS, platformOf, read } from '../platforms.js';
import { newToken } from '../security.js';
import { clientView, releaseView } from '../serialize.js';

const router = Router();

export function parseClientName(raw) {
  const name = cleanText(raw, 80);
  const slug = slugify(name);
  if (!name || !slug) throw new HttpError(400, 'Enter a client name using letters or numbers.');
  return { name, slug };
}

// Accepts an id, a slug, or the display name - the publish script only knows the name.
export async function findClient(ref) {
  const id = toObjectId(ref);
  if (id) {
    const byId = await clients().findOne({ _id: id });
    if (byId) return byId;
  }
  const slug = slugify(cleanText(ref, 80));
  return slug ? clients().findOne({ slug }) : null;
}

export async function createClient({ name, slug }, notes, createdBy) {
  const now = new Date();
  const doc = {
    name,
    slug,
    notes,
    // Windows "latest" links and current version (top-level for links made before platforms).
    directToken: newToken(),
    protectedToken: newToken(),
    currentReleaseId: null,
    ...macLinkFields(),
    buildSeq: 0,
    createdBy,
    createdAt: now,
    updatedAt: now,
  };
  try {
    const { insertedId } = await clients().insertOne(doc);
    return { ...doc, _id: insertedId };
  } catch (err) {
    if (err?.code === 11000) throw new HttpError(409, `A client named "${name}" already exists.`);
    throw err;
  }
}

// { clientId: { platform: count } } for versions that are still available.
async function countsByClient(match = {}) {
  const rows = await releases()
    .aggregate([
      { $match: { ...match, archived: { $ne: true } } },
      { $group: { _id: { client: '$clientId', platform: { $ifNull: ['$platform', 'windows'] } }, n: { $sum: 1 } } },
    ])
    .toArray();
  const out = new Map();
  for (const row of rows) {
    const key = String(row._id.client);
    out.set(key, { ...out.get(key), [row._id.platform]: row.n });
  }
  return out;
}

const currentIdsOf = (client) => PLATFORMS.map((p) => read(client, p, 'current')).filter(Boolean);

router.get('/clients', requireUser, async (req, res) => {
  const all = await clients().find().sort({ name: 1 }).collation({ locale: 'en', strength: 2 }).toArray();
  const counts = await countsByClient();
  const currents = new Map(
    (await releases().find({ _id: { $in: all.flatMap(currentIdsOf) } }).toArray()).map((r) => [String(r._id), r]),
  );
  res.json({
    clients: all.map((c) => clientView(req, c, { currents, counts: counts.get(String(c._id)) })),
  });
});

router.post('/clients', requireMaster, async (req, res) => {
  const client = await createClient(parseClientName(req.body?.name), cleanText(req.body?.notes, 500), req.auth.username);
  res.status(201).json({ client: clientView(req, client) });
});

router.get('/clients/:ref', requireUser, async (req, res) => {
  const client = await findClient(req.params.ref);
  if (!client) throw new HttpError(404, 'This client does not exist.');

  const filter = { clientId: client._id };
  // Archived releases are withdrawn; only the master can see and restore them.
  if (req.auth.role !== 'master') filter.archived = { $ne: true };
  const list = await releases().find(filter).sort({ uploadedAt: -1 }).toArray();

  const currents = new Map(list.map((r) => [String(r._id), r]));
  const counts = (await countsByClient({ clientId: client._id })).get(String(client._id));
  res.json({
    client: clientView(req, client, { currents, counts }),
    releases: list.map((r) => releaseView(req, r, client)),
  });
});

router.patch('/clients/:id', requireMaster, async (req, res) => {
  const client = await findClient(req.params.id);
  if (!client) throw new HttpError(404, 'This client does not exist.');

  const set = { updatedAt: new Date() };
  if (req.body?.name !== undefined) Object.assign(set, parseClientName(req.body.name));
  if (req.body?.notes !== undefined) set.notes = cleanText(req.body.notes, 500);
  if (req.body?.currentReleaseId !== undefined) {
    const release = await releases().findOne({ _id: toObjectId(req.body.currentReleaseId), clientId: client._id });
    if (!release) throw new HttpError(404, 'That version does not belong to this client.');
    if (release.archived) throw new HttpError(409, 'Restore this version before making it current.');
    // Each platform has its own current version.
    set[field(platformOf(release), 'current')] = release._id;
  }

  try {
    await clients().updateOne({ _id: client._id }, { $set: set });
  } catch (err) {
    if (err?.code === 11000) throw new HttpError(409, `A client named "${set.name}" already exists.`);
    throw err;
  }
  res.json({ ok: true, slug: set.slug || client.slug });
});

// Invalidates the always-latest links already shared for one platform (or all, if none is given).
router.post('/clients/:id/rotate-links', requireMaster, async (req, res) => {
  const client = await findClient(req.params.id);
  if (!client) throw new HttpError(404, 'This client does not exist.');
  const only = normalizePlatform(req.body?.platform);
  const set = { updatedAt: new Date() };
  for (const platform of only ? [only] : PLATFORMS) {
    set[field(platform, 'direct')] = newToken();
    set[field(platform, 'protected')] = newToken();
  }
  await clients().updateOne({ _id: client._id }, { $set: set });
  res.json({ ok: true });
});

export default router;
