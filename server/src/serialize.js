import { baseUrl } from './http.js';
import { PLATFORMS, platformOf, read } from './platforms.js';

// The passwordless link is only ever sent to the master account. Helpers get the
// password-protected link and nothing that would let them derive the direct one.
export function linksFor(req, tokens) {
  const base = baseUrl(req);
  const links = { protected: `${base}/get/${tokens.protectedToken}` };
  if (req.auth?.role === 'master') links.direct = `${base}/dl/${tokens.directToken}`;
  return links;
}

const isCurrent = (client, release) =>
  Boolean(client && String(read(client, platformOf(release), 'current')) === String(release._id));

export function releaseView(req, release, client) {
  return {
    id: String(release._id),
    clientId: String(release.clientId),
    platform: platformOf(release),
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
    isCurrent: isCurrent(client, release),
    links: linksFor(req, release),
  };
}

// currents: Map(releaseId -> release) holding at least this client's current releases.
// counts: { [platform]: number of available versions }
export function clientView(req, client, { currents = new Map(), counts = {} } = {}) {
  const platforms = PLATFORMS.map((platform) => {
    const current = currents.get(String(read(client, platform, 'current')));
    return {
      id: platform,
      count: counts[platform] || 0,
      current: current && !current.archived ? releaseView(req, current, client) : null,
      // Always-latest links: they serve whichever version is current for this platform.
      links: linksFor(req, {
        directToken: read(client, platform, 'direct'),
        protectedToken: read(client, platform, 'protected'),
      }),
    };
  });
  const latest = platforms
    .map((p) => p.current)
    .filter(Boolean)
    .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt))[0];

  return {
    id: String(client._id),
    name: client.name,
    slug: client.slug,
    notes: client.notes || '',
    createdAt: client.createdAt,
    updatedAt: client.updatedAt,
    releaseCount: platforms.reduce((n, p) => n + p.count, 0),
    latest: latest || null,
    platforms,
  };
}
