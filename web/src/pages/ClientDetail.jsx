import {
  Archive,
  ArchiveRestore,
  ChevronLeft,
  CircleAlert,
  Download,
  ExternalLink,
  FileDown,
  Link as LinkIcon,
  Lock,
  Pencil,
  RefreshCw,
  Star,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, copyText } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useToast } from '../components/toast.jsx';
import { Avatar, Banner, Button, CopyButton, ease, Field, Menu, Sheet } from '../components/ui.jsx';
import UploadPanel from '../components/UploadPanel.jsx';
import { fileKind, formatBytes, formatDate, plural, timeAgo } from '../format.js';

const DIRECT_HINT = 'Downloads immediately. No password.';
const PROTECTED_HINT = 'Asks for the download password first.';

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
    <Sheet open={open} onClose={onClose} title="Edit client">
      <form onSubmit={onSubmit} className="sheet-body">
        <Field label="Client name" error={error}>
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
    <Sheet open={Boolean(release)} onClose={onClose} title="Edit version" subtitle={release?.fileName}>
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
    <Sheet open={Boolean(confirm)} onClose={onClose} title={shown?.title || ''} width={400}>
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
          <span className="version-number">{release.version}</span>
          <span className="version-build">build {release.build}</span>
          {release.isCurrent && <span className="badge badge-current">Current</span>}
          {release.archived && <span className="badge badge-archived">Archived</span>}
        </div>
        <p className="version-file">
          {release.fileName} · {formatBytes(release.size)}
        </p>
        {release.notes && <p className="version-notes">{release.notes}</p>}
        <p className="version-meta" title={`SHA-256 ${release.sha256}`}>
          {formatDate(release.uploadedAt)} · {release.source === 'script' ? 'publish script' : release.uploadedBy} ·{' '}
          {plural(release.downloads, 'download')}
        </p>
      </div>

      <div className="version-actions">
        {!release.archived && (
          <CopyButton
            variant="tinted"
            size="sm"
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
                    { label: 'Copy protected link', icon: Lock, onSelect: () => actions.copyProtected(release) },
                    { label: 'Download', icon: Download, onSelect: () => (window.location.href = release.links.direct) },
                    'separator',
                    !release.isCurrent && { label: 'Make current', icon: Star, onSelect: () => actions.makeCurrent(release) },
                    { label: 'Edit details', icon: Pencil, onSelect: () => actions.edit(release) },
                    { label: 'Reset links', icon: RefreshCw, onSelect: () => actions.resetLinks(release) },
                    'separator',
                    { label: 'Archive', icon: Archive, danger: true, onSelect: () => actions.archive(release) },
                  ]
            }
          />
        ) : (
          <a className="icon-btn" href={release.links.protected} target="_blank" rel="noreferrer" aria-label={`Open download page for ${release.version}`} title="Open download page">
            <ExternalLink size={17} />
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
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [editingRelease, setEditingRelease] = useState(null);
  const [confirm, setConfirm] = useState(null);

  const load = useCallback(
    () =>
      api(`/clients/${slug}`)
        .then(setData)
        .catch((err) => setError(err.message)),
    [slug],
  );
  useEffect(() => {
    load();
  }, [load]);

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
  if (!data) return <div className="detail-skeleton skeleton" />;

  const { client, releases } = data;
  const current = client.current;

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
      run(() => api(`/clients/${client.id}`, { method: 'PATCH', body: { currentReleaseId: r.id } }), `Version ${r.version} is now current`),
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
        body: 'Every link already shared for this version stops working. New links are created in their place.',
        action: 'Reset Links',
        danger: true,
        run: () => run(() => api(`/releases/${r.id}/rotate-links`, { method: 'POST' }), 'New links created'),
      }),
  };

  const resetClientLinks = () =>
    setConfirm({
      title: 'Reset the always-latest links?',
      body: `Every always-latest link already shared for ${client.name} stops working. Links to individual versions are not affected.`,
      action: 'Reset Links',
      danger: true,
      run: () => run(() => api(`/clients/${client.id}/rotate-links`, { method: 'POST' }), 'New links created'),
    });

  return (
    <>
      <Link to="/" className="back">
        <ChevronLeft size={18} />
        Clients
      </Link>

      <div className="detail-head">
        <Avatar name={client.name} size={76} />
        <div className="detail-title">
          <h1>{client.name}</h1>
          <p className="page-sub">{client.notes || plural(client.releaseCount, 'version')}</p>
        </div>
        {isMaster && (
          <Menu
            label="Client actions"
            items={[
              { label: 'Edit client', icon: Pencil, onSelect: () => setEditing(true) },
              { label: 'Reset latest links', icon: RefreshCw, onSelect: resetClientLinks },
            ]}
          />
        )}
      </div>

      {app && !app.downloadPasswordSet && (
        <Banner icon={CircleAlert} tone="warn">
          {isMaster ? (
            <>
              Protected links cannot be opened until you set a download password. <Link to="/settings">Set it in Settings</Link>
            </>
          ) : (
            'The download password has not been set yet. Links will not open until the master account sets one.'
          )}
        </Banner>
      )}

      <motion.section className="card hero" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.55, ease, delay: 0.05 }}>
        {current ? (
          <>
            <div className="hero-main">
              <span className="eyebrow">Current version</span>
              <div className="hero-version">
                <AnimatePresence mode="popLayout" initial={false}>
                  <motion.span
                    key={current.id}
                    initial={{ opacity: 0, y: 18, filter: 'blur(8px)' }}
                    animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                    exit={{ opacity: 0, y: -18, filter: 'blur(8px)' }}
                    transition={{ duration: 0.45, ease }}
                  >
                    {current.version}
                  </motion.span>
                </AnimatePresence>
              </div>
              <p className="hero-file">
                <FileDown size={16} strokeWidth={2} />
                <span>{current.fileName}</span>
              </p>
              <p className="hero-meta">
                {fileKind(current.fileName)} · {formatBytes(current.size)} · build {current.build} · uploaded {timeAgo(current.uploadedAt)}
              </p>
            </div>

            <div className="hero-actions">
              <CopyButton
                size="lg"
                text={isMaster ? client.links.direct : client.links.protected}
                label="Copy Link"
                message={isMaster ? 'Direct link copied' : 'Protected link copied'}
              />
              {isMaster ? (
                <>
                  <CopyButton size="lg" variant="tinted" icon={Lock} text={client.links.protected} label="Copy Protected Link" message="Protected link copied" />
                  <a className="btn btn-plain btn-lg" href={client.links.direct}>
                    <Download size={16} strokeWidth={2.2} />
                    <span>Download</span>
                  </a>
                </>
              ) : (
                <a className="btn btn-tinted btn-lg" href={client.links.protected} target="_blank" rel="noreferrer">
                  <ExternalLink size={16} strokeWidth={2.2} />
                  <span>Open Download Page</span>
                </a>
              )}
              <p className="hero-hint">
                <LinkIcon size={13} strokeWidth={2.4} />
                Always serves the current version. {isMaster ? DIRECT_HINT : PROTECTED_HINT}
              </p>
            </div>
          </>
        ) : (
          <div className="hero-empty">
            <span className="eyebrow">No versions yet</span>
            <p>{isMaster ? 'Add the first installer below. Its link is ready the moment the upload finishes.' : 'Nothing has been uploaded for this client yet.'}</p>
          </div>
        )}
      </motion.section>

      {isMaster && <UploadPanel client={client} onUploaded={load} />}

      {releases.length > 0 && (
        <section className="versions">
          <div className="section-head">
            <h2>Versions</h2>
            <span>{releases.length}</span>
          </div>
          <ul className="card version-list">
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
              toast('Version updated');
              load();
            }}
          />
          <ConfirmSheet confirm={confirm} onClose={() => setConfirm(null)} />
        </>
      )}
    </>
  );
}
