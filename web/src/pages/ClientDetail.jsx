import {
  Archive,
  ArchiveRestore,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Download,
  ExternalLink,
  Lock,
  Pencil,
  RefreshCw,
  SquareKanban,
  Star,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, copyText } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useToast } from '../components/toast.jsx';
import { AppIcon, Banner, Button, CopyButton, ease, Field, Menu, Segmented, Sheet } from '../components/ui.jsx';
import UploadPanel from '../components/UploadPanel.jsx';
import { fileKind, formatBytes, formatDate, gradientFor, plural, timeAgo } from '../format.js';
import { PlatformIcon, PLATFORMS, platformById } from '../platforms.jsx';

function EditClientSheet({ client, open, onClose, onSaved }) {
  const [name, setName] = useState(client.name);
  const [notes, setNotes] = useState(client.notes);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setName(client.name);
      setNotes(client.notes);
      setError('');
      setBusy(false);
    }
  }, [open, client]);

  async function onSubmit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { slug } = await api(`/clients/${client.id}`, { method: 'PATCH', body: { name, notes } });
      onSaved(slug);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title="Edit Client">
      <form onSubmit={onSubmit} className="sheet-body">
        <Field label="Name" error={error}>
          {(id) => <input id={id} className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus />}
        </Field>
        <Field label="Notes">{(id) => <input id={id} className="input" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />}</Field>
        <div className="sheet-actions">
          <Button variant="plain" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={busy} disabled={!name.trim()}>
            Save
          </Button>
        </div>
      </form>
    </Sheet>
  );
}

function EditReleaseSheet({ release, onClose, onSaved }) {
  const [version, setVersion] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (release) {
      setVersion(release.version);
      setNotes(release.notes);
      setError('');
      setBusy(false);
    }
  }, [release]);

  async function onSubmit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api(`/releases/${release.id}`, { method: 'PATCH', body: { version, notes } });
      onSaved();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Sheet open={Boolean(release)} onClose={onClose} title="Edit Build" subtitle={release?.fileName}>
      <form onSubmit={onSubmit} className="sheet-body">
        <Field label="Version" error={error}>
          {(id) => <input id={id} className="input" value={version} onChange={(e) => setVersion(e.target.value)} maxLength={40} autoFocus />}
        </Field>
        <Field label="What changed">{(id) => <input id={id} className="input" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} />}</Field>
        <div className="sheet-actions">
          <Button variant="plain" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={busy} disabled={!version.trim()}>
            Save
          </Button>
        </div>
      </form>
    </Sheet>
  );
}

function ConfirmSheet({ confirm, onClose }) {
  const [busy, setBusy] = useState(false);
  // Keep the last question on screen while the sheet animates away.
  const [shown, setShown] = useState(confirm);
  useEffect(() => {
    if (confirm) {
      setShown(confirm);
      setBusy(false);
    }
  }, [confirm]);
  return (
    <Sheet open={Boolean(confirm)} onClose={onClose} title={shown?.title || ''} width={420}>
      <div className="sheet-body">
        <p className="sheet-text">{shown?.body}</p>
        <div className="sheet-actions">
          <Button variant="plain" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={shown?.danger ? 'danger' : 'primary'}
            busy={busy}
            onClick={async () => {
              setBusy(true);
              await shown.run();
              onClose();
            }}
          >
            {shown?.action}
          </Button>
        </div>
      </div>
    </Sheet>
  );
}

// App Store style metadata strip for the selected platform's current build.
function InfoStrip({ release }) {
  const cells = [
    ['Version', release.version, `Build ${release.build}`],
    ['Size', formatBytes(release.size), fileKind(release.fileName)],
    ['Downloads', String(release.downloads), release.lastDownloadAt ? `Last ${timeAgo(release.lastDownloadAt)}` : 'None yet'],
    ['Updated', timeAgo(release.uploadedAt).replace(/^in /, ''), new Date(release.uploadedAt).toLocaleDateString('en', { day: 'numeric', month: 'short' })],
    ['Platform', platformById(release.platform).label, release.platform === 'windows' ? 'Installer' : 'Mac'],
  ];
  return (
    <div className="info-strip">
      {cells.map(([caption, value, sub]) => (
        <div className="info-cell" key={caption}>
          <span className="info-caption">{caption}</span>
          <span className="info-value">{value}</span>
          <span className="info-sub">{sub}</span>
        </div>
      ))}
    </div>
  );
}

function VersionRow({ release, isMaster, actions }) {
  const primary = isMaster ? release.links.direct : release.links.protected;
  return (
    <motion.li
      layout
      className={`version-row ${release.archived ? 'is-archived' : ''}`}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, transition: { duration: 0.15 } }}
      transition={{ duration: 0.4, ease }}
    >
      <div className="version-main">
        <div className="version-title">
          <span className="version-number">Version {release.version}</span>
          {release.isCurrent && <span className="badge badge-current">Current</span>}
          {release.archived && <span className="badge badge-archived">Archived</span>}
          <span className="version-date" title={formatDate(release.uploadedAt)}>
            {timeAgo(release.uploadedAt)}
          </span>
        </div>
        {release.notes && <p className="version-notes">{release.notes}</p>}
        <p className="version-meta" title={`SHA-256 ${release.sha256}`}>
          Build {release.build} · {release.fileName} · {formatBytes(release.size)} · {plural(release.downloads, 'download')} ·{' '}
          {{ script: 'publish script', builder: 'Router Builder' }[release.source] || release.uploadedBy}
        </p>
      </div>

      <div className="version-actions">
        {!release.archived && (
          <CopyButton
            variant="get"
            label="COPY"
            text={primary}
            message={isMaster ? `Direct link to ${release.version} copied` : `Protected link to ${release.version} copied`}
          />
        )}
        {isMaster ? (
          <Menu
            label={`Actions for version ${release.version}`}
            items={
              release.archived
                ? [{ label: 'Restore', icon: ArchiveRestore, onSelect: () => actions.setArchived(release, false) }]
                : [
                    { label: 'Copy Protected Link', icon: Lock, onSelect: () => actions.copyProtected(release) },
                    { label: 'Download', icon: Download, onSelect: () => (window.location.href = release.links.direct) },
                    'separator',
                    !release.isCurrent && { label: 'Make Current', icon: Star, onSelect: () => actions.makeCurrent(release) },
                    { label: 'Edit Details', icon: Pencil, onSelect: () => actions.edit(release) },
                    { label: 'Reset Links', icon: RefreshCw, onSelect: () => actions.resetLinks(release) },
                    'separator',
                    { label: 'Archive', icon: Archive, danger: true, onSelect: () => actions.archive(release) },
                  ]
            }
          />
        ) : (
          <a className="icon-btn" href={release.links.protected} target="_blank" rel="noreferrer" aria-label={`Open download page for ${release.version}`} title="Open download page">
            <ExternalLink size={18} />
          </a>
        )}
      </div>
    </motion.li>
  );
}

export default function ClientDetail() {
  const { slug } = useParams();
  const { isMaster, app } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [data, setData] = useState(null);
  const [openCards, setOpenCards] = useState(0);
  const [servers, setServers] = useState([]);
  const [error, setError] = useState('');
  const [platformId, setPlatformId] = useState(null);
  const [editing, setEditing] = useState(false);
  const [editingRelease, setEditingRelease] = useState(null);
  const [confirm, setConfirm] = useState(null);

  const load = useCallback(
    () =>
      api(`/clients/${slug}`)
        .then((d) => {
          setData(d);
          // Open on the platform of the newest build, then stay where the user puts it.
          setPlatformId((current) => current || d.client.latest?.platform || 'windows');
        })
        .catch((err) => setError(err.message)),
    [slug],
  );
  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!data) return;
    api('/tasks')
      .then((d) => setOpenCards(d.tasks.filter((t) => t.clientId === data.client.id && t.status !== 'completed').length))
      .catch(() => {});
    api('/servers')
      .then((d) => setServers(d.servers.filter((s) => s.clientId === data.client.id)))
      .catch(() => {});
  }, [data]);

  const releases = useMemo(() => data?.releases.filter((r) => r.platform === platformId) || [], [data, platformId]);

  if (error) {
    return (
      <div className="empty">
        <h2>Client unavailable</h2>
        <p>{error}</p>
        <Link to="/" className="btn btn-tinted">
          Back to Clients
        </Link>
      </div>
    );
  }
  if (!data || !platformId) return <div className="detail-skeleton skeleton" />;

  const { client } = data;
  const platform = client.platforms.find((p) => p.id === platformId);
  const current = platform.current;
  const meta = platformById(platformId);
  const [ca, cb] = gradientFor(client.name);

  // Each action reports failures as a toast and reloads on success, so rows never show stale state.
  const run = async (work, done) => {
    try {
      await work();
      await load();
      if (done) toast(done);
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  const actions = {
    edit: setEditingRelease,
    copyProtected: async (r) =>
      (await copyText(r.links.protected)) ? toast(`Protected link to ${r.version} copied`) : toast('Could not copy the link.', 'error'),
    makeCurrent: (r) =>
      run(() => api(`/clients/${client.id}`, { method: 'PATCH', body: { currentReleaseId: r.id } }), `${r.version} is now current for ${platformById(r.platform).label}`),
    setArchived: (r, archived) =>
      run(() => api(`/releases/${r.id}`, { method: 'PATCH', body: { archived } }), archived ? `Version ${r.version} archived` : `Version ${r.version} restored`),
    archive: (r) =>
      setConfirm({
        title: `Archive version ${r.version}?`,
        body: 'Its links stop working straight away. The file stays on the server and you can restore it at any time.',
        action: 'Archive',
        danger: true,
        run: () => actions.setArchived(r, true),
      }),
    resetLinks: (r) =>
      setConfirm({
        title: `Reset links for ${r.version}?`,
        body: 'Every link already shared for this build stops working. New links are created in their place.',
        action: 'Reset Links',
        danger: true,
        run: () => run(() => api(`/releases/${r.id}/rotate-links`, { method: 'POST' }), 'New links created'),
      }),
  };

  const resetLatestLinks = () =>
    setConfirm({
      title: `Reset the ${meta.label} latest links?`,
      body: `Every always-latest ${meta.long} link already shared for ${client.name} stops working. Other platforms and links to individual builds are not affected.`,
      action: 'Reset Links',
      danger: true,
      run: () => run(() => api(`/clients/${client.id}/rotate-links`, { method: 'POST', body: { platform: platformId } }), 'New links created'),
    });

  return (
    <div className="product" style={{ '--ca': ca, '--cb': cb }}>
      <div className="product-glow" aria-hidden="true" />

      <Link to="/" className="back glass">
        <ChevronLeft size={18} strokeWidth={2.6} />
        Clients
      </Link>

      <header className="product-head">
        <motion.div initial={{ scale: 0.7, opacity: 0, rotate: -6 }} animate={{ scale: 1, opacity: 1, rotate: 0 }} transition={{ type: 'spring', stiffness: 260, damping: 18 }}>
          <AppIcon name={client.name} size={128} />
        </motion.div>
        <div className="product-title">
          <h1>{client.name}</h1>
          <p className="page-sub">{client.notes || `${plural(client.releaseCount, 'build')} across ${client.platforms.filter((p) => p.count).length || 0} platforms`}</p>
          <div className="product-actions">
            {current ? (
              <>
                <CopyButton
                  size="lg"
                  text={isMaster ? platform.links.direct : platform.links.protected}
                  label="Copy Link"
                  message={isMaster ? `${meta.label} direct link copied` : `${meta.label} protected link copied`}
                />
                {isMaster ? (
                  <CopyButton size="lg" variant="glass" icon={Lock} text={platform.links.protected} label="Protected Link" message={`${meta.label} protected link copied`} />
                ) : (
                  <a className="btn btn-glass btn-lg glass" href={platform.links.protected} target="_blank" rel="noreferrer">
                    <ExternalLink size={17} strokeWidth={2.2} />
                    <span>Download Page</span>
                  </a>
                )}
              </>
            ) : (
              <span className="product-none">No {meta.long} build yet</span>
            )}
            {isMaster && (
              <Menu
                trigger="glass"
                label="Client actions"
                items={[
                  current && { label: 'Download', icon: Download, onSelect: () => (window.location.href = platform.links.direct) },
                  { label: 'Edit Client', icon: Pencil, onSelect: () => setEditing(true) },
                  { label: `Reset ${meta.label} Links`, icon: RefreshCw, onSelect: resetLatestLinks },
                ]}
              />
            )}
          </div>
          {current && (
            <p className="product-hint">
              Always serves the current {meta.long} build. {isMaster ? 'Downloads at once, no password.' : 'Asks for the download password.'}
            </p>
          )}
        </div>
      </header>

      {app && !app.downloadPasswordSet && (
        <Banner icon={CircleAlert} tone="warn">
          {isMaster ? (
            <>
              Protected links cannot be opened until you set a download password. <Link to="/settings">Set it in Settings</Link>
            </>
          ) : (
            'The download password has not been set yet. Protected links will not open until the master account sets one.'
          )}
        </Banner>
      )}

      <div className="platform-bar">
        <Segmented
          label="Platform"
          value={platformId}
          onChange={setPlatformId}
          options={client.platforms.map((p) => ({ id: p.id, label: platformById(p.id).label, icon: <PlatformIcon id={p.id} size={15} />, badge: p.count }))}
        />
        <div className="platform-links">
          {servers.map((s) => (
            <Link key={s.id} to={`/servers/${s.id}`} className={`board-link server-link is-${s.status}`} title={`Server ${s.name}`}>
              <span className="status-dot" />
              {s.name}
              {s.summary?.storagePct != null && <span className="server-link-pct">Storage {Math.round(s.summary.storagePct)}%</span>}
              <ChevronRight size={15} strokeWidth={2.4} />
            </Link>
          ))}
          <Link to={`/board?client=${client.id}`} className="board-link">
            <SquareKanban size={16} strokeWidth={2.2} />
            {openCards ? `${plural(openCards, 'open change')}` : 'No open changes'}
            <ChevronRight size={15} strokeWidth={2.4} />
          </Link>
        </div>
      </div>

      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={platformId + (current?.id || 'none')}
          initial={{ opacity: 0, y: 10, filter: 'blur(6px)' }}
          animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
          exit={{ opacity: 0, y: -6, filter: 'blur(4px)', transition: { duration: 0.12 } }}
          transition={{ duration: 0.4, ease }}
        >
          {current ? (
            <InfoStrip release={current} />
          ) : (
            <div className="platform-empty">
              <span className="platform-empty-icon">
                <PlatformIcon id={platformId} size={26} />
              </span>
              <div>
                <h3>No {meta.long} build</h3>
                <p>{isMaster ? `Add one below. Its always-latest link works the moment the upload finishes.` : `Nothing has been uploaded for ${meta.long} yet.`}</p>
              </div>
            </div>
          )}
        </motion.div>
      </AnimatePresence>

      {isMaster && <UploadPanel client={client} platform={platformId} onUploaded={load} />}

      {releases.length > 0 && (
        <section className="section">
          <div className="section-head">
            <h2>Version History</h2>
            <span className="section-count">
              {meta.label} · {releases.length}
            </span>
          </div>
          <ul className="inset-list version-list">
            <AnimatePresence initial={false}>
              {releases.map((r) => (
                <VersionRow key={r.id} release={r} isMaster={isMaster} actions={actions} />
              ))}
            </AnimatePresence>
          </ul>
        </section>
      )}

      {isMaster && (
        <>
          <EditClientSheet
            client={client}
            open={editing}
            onClose={() => setEditing(false)}
            onSaved={(newSlug) => {
              setEditing(false);
              toast('Client updated');
              if (newSlug !== slug) navigate(`/clients/${newSlug}`, { replace: true });
              else load();
            }}
          />
          <EditReleaseSheet
            release={editingRelease}
            onClose={() => setEditingRelease(null)}
            onSaved={() => {
              setEditingRelease(null);
              toast('Build updated');
              load();
            }}
          />
          <ConfirmSheet confirm={confirm} onClose={() => setConfirm(null)} />
        </>
      )}
    </div>
  );
}
