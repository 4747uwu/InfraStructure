import { baseUrl } from './http.js';

// The passwordless link is only ever sent to the master account. Helpers get the
// password-protected link and nothing that would let them derive the direct one.
export function linksFor(req, doc) {
  const base = baseUrl(req);
  const links = { protected: `${base}/get/${doc.protectedToken}` };
  if (req.auth?.role === 'master') links.direct = `${base}/dl/${doc.directToken}`;
  return links;
}

export function releaseView(req, release, client) {
  return {
    id: String(release._id),
    clientId: String(release.clientId),
    version: release.version,
    build: release.build,
    fileName: release.fileName,
    size: release.size,
    sha256: release.sha256,
    notes: release.notes || '',
    source: release.source,
    uploadedBy: release.uploadedBy,
    uploadedAt: release.uploadedAt,
    downloads: release.downloads || 0,
    lastDownloadAt: release.lastDownloadAt || null,
    archived: Boolean(release.archived),
    isCurrent: Boolean(client?.currentReleaseId && String(client.currentReleaseId) === String(release._id)),
    links: linksFor(req, release),
  };
}

export function clientView(req, client, { current = null, releaseCount = 0 } = {}) {
  return {
    id: String(client._id),
    name: client.name,
    slug: client.slug,
    notes: client.notes || '',
    createdAt: client.createdAt,
    updatedAt: client.updatedAt,
    releaseCount,
    current: current ? releaseView(req, current, client) : null,
    // "Latest" links always serve whichever release is current.
    links: linksFor(req, client),
  };
}
