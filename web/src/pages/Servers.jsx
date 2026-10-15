import { Activity, Plus, ServerCog } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { Rings, RingLegend, StatusLabel } from '../components/charts.jsx';
import { useToast } from '../components/toast.jsx';
import { AppIcon, Button, CopyButton, ease, Field, Sheet } from '../components/ui.jsx';
import { formatBytes, plural, timeAgo } from '../format.js';

const grid = { show: { transition: { staggerChildren: 0.05 } } };
const rise = { hidden: { opacity: 0, y: 20, scale: 0.98 }, show: { opacity: 1, y: 0, scale: 1, transition: { duration: 0.55, ease } } };

export const ringValues = (s) => ({ cpu: s?.cpuPct ?? null, mem: s?.memPct ?? null, disk: s?.storagePct ?? null });

export function StatusPill({ server, compact = false }) {
  const text = { online: 'Online', offline: 'Offline', waiting: compact ? 'Waiting' : 'Waiting for first report' }[server.status];
  return (
    <span className={`status-pill is-${server.status} ${compact ? 'is-compact' : ''}`}>
      <span className="status-dot" />
      {text}
      {server.lastReportAt && server.status !== 'waiting' && <span className="status-age">· {timeAgo(server.lastReportAt)}</span>}
    </span>
  );
}

export function ServerIcon({ server, client, size = 48 }) {
  if (client) return <AppIcon name={client.name} size={size} />;
  return (
    <span className="server-icon" style={{ width: size, height: size, borderRadius: size * 0.2237 }} aria-hidden="true">
      <ServerCog size={size * 0.5} strokeWidth={1.8} />
    </span>
  );
}

// Quotes a value for a POSIX shell only when it needs it, so simple values stay readable.
export function shellQuote(value) {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// The install command with the optional Orthanc settings appended. `mask` hides the password for display.
export function buildInstallCommand(base, orthanc, { mask = false } = {}) {
  if (!orthanc.enabled) return base;
  const parts = [base];
  if (orthanc.url.trim()) parts.push('--orthanc-url', shellQuote(orthanc.url.trim()));
  if (orthanc.user) parts.push('--orthanc-user', shellQuote(orthanc.user));
  if (orthanc.user || orthanc.pass) parts.push('--orthanc-pass', mask && orthanc.pass ? '••••••••' : shellQuote(orthanc.pass));
  if (orthanc.storage.trim()) parts.push('--storage', shellQuote(orthanc.storage.trim()));
  return parts.join(' ');
}

const NO_ORTHANC = { enabled: false, user: '', pass: '', url: '', storage: '' };

// Shown once after adding a server or asking for a new token. The Orthanc login is only
// ever put into the command shown here; Router Hub does not store it.
export function InstallSheet({ install, onClose }) {
  const [orthanc, setOrthanc] = useState(NO_ORTHANC);
  const [reveal, setReveal] = useState(false);
  useEffect(() => {
    if (install) {
      setOrthanc(NO_ORTHANC);
      setReveal(false);
    }
  }, [install]);

  const set = (key) => (e) => setOrthanc((o) => ({ ...o, [key]: e.target.value }));
  const base = install?.command || '';
  const command = buildInstallCommand(base, orthanc);
  const shown = buildInstallCommand(base, orthanc, { mask: !reveal });
  const missingPass = orthanc.enabled && orthanc.user && !orthanc.pass;

  return (
    <Sheet open={Boolean(install)} onClose={onClose} title="Install the Agent" subtitle={install?.name} width={660}>
      <div className="sheet-body">
        <p className="sheet-text">Run this once on the server, as root. It installs a small script that reports every minute, and sends the first report straight away.</p>

        <label className="check-row" htmlFor="install-orthanc">
          <input id="install-orthanc" type="checkbox" checked={orthanc.enabled} onChange={(e) => setOrthanc((o) => ({ ...o, enabled: e.target.checked }))} />
          <span>
            <strong>This server runs Orthanc</strong>
            <span>Add its login so the page can show patients, studies and storage. The agent finds Orthanc by itself; the address and storage are only needed if it cannot.</span>
          </span>
        </label>

        <AnimatePresence initial={false}>
          {orthanc.enabled && (
            <motion.div
              className="orthanc-fields"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.3, ease }}
            >
              <div className="drop-fields">
                <Field label="Orthanc username">
                  {(id) => <input id={id} className="input" value={orthanc.user} onChange={set('user')} autoComplete="off" autoCapitalize="none" spellCheck="false" placeholder="orthanc" autoFocus />}
                </Field>
                <Field label="Orthanc password" error={missingPass ? 'Enter the password too.' : ''}>
                  {(id) => <input id={id} className="input" type="password" value={orthanc.pass} onChange={set('pass')} autoComplete="new-password" />}
                </Field>
              </div>
              <div className="drop-fields">
                <Field label="Address" hint="Optional. Found automatically.">
                  {(id) => <input id={id} className="input" value={orthanc.url} onChange={set('url')} placeholder="http://127.0.0.1:8042" autoComplete="off" spellCheck="false" />}
                </Field>
                <Field label="DICOM storage" hint="Optional. Found automatically.">
                  {(id) => <input id={id} className="input" value={orthanc.storage} onChange={set('storage')} placeholder="/mnt/dicom" autoComplete="off" spellCheck="false" />}
                </Field>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="code-box">
          <pre>{shown}</pre>
          <div className="code-actions">
            <CopyButton variant="tinted" size="sm" text={command} label="Copy" message="Install command copied" />
            {orthanc.enabled && orthanc.pass && (
              <button type="button" className="link" onClick={() => setReveal((r) => !r)}>
                {reveal ? 'Hide password' : 'Show password'}
              </button>
            )}
          </div>
        </div>
        <p className="field-hint">
          The token in this command is shown only now. {orthanc.enabled && orthanc.pass ? 'Copy includes the real password; it is not saved in Router Hub. ' : ''}Already installed? Running the
          command again just updates the settings.
        </p>
        <div className="sheet-actions">
          <Button onClick={onClose}>Done</Button>
        </div>
      </div>
    </Sheet>
  );
}

export function ServerSheet({ open, server, clients, onClose, onSaved }) {
  const [name, setName] = useState('');
  const [clientId, setClientId] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const isNew = !server;

  useEffect(() => {
    if (!open) return;
    setName(server?.name || '');
    setClientId(server?.clientId || '');
    setError('');
    setBusy(false);
  }, [open, server]);

  async function onSubmit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const body = { name, clientId: clientId || null };
      const result = isNew ? await api('/servers', { method: 'POST', body }) : await api(`/servers/${server.id}`, { method: 'PATCH', body });
      onSaved(result);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title={isNew ? 'Add Server' : 'Edit Server'} subtitle={isNew ? 'You get a one-line install command for the server next.' : undefined}>
      <form onSubmit={onSubmit} className="sheet-body">
        <Field label="Name" error={error}>
          {(id) => <input id={id} className="input" placeholder="Ganesham PACS" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus />}
        </Field>
        <Field label="Client" hint="Optional. Links this server to a client, so its status shows on the client's page.">
          {(id) => (
            <select id={id} className="input select" value={clientId} onChange={(e) => setClientId(e.target.value)}>
              <option value="">No client</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <div className="sheet-actions">
          <Button variant="plain" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={busy} disabled={!name.trim()}>
            {isNew ? 'Add Server' : 'Save'}
          </Button>
        </div>
      </form>
    </Sheet>
  );
}

function ServerCard({ server, client }) {
  const s = server.summary;
  const orthanc = server.orthanc;
  const studies = s?.studies;
  return (
    <motion.div variants={rise} whileHover={{ y: -4 }} whileTap={{ scale: 0.985 }} transition={{ type: 'spring', stiffness: 400, damping: 28 }}>
      <Link to={`/servers/${server.id}`} className={`server-card is-${server.status}`}>
        <header>
          <ServerIcon server={server} client={client} size={44} />
          <div className="server-card-title">
            <strong>{server.name}</strong>
            <span className="server-card-sub">
              <StatusPill server={server} compact />
              <span>{client?.name || server.host?.hostname || 'No client linked'}</span>
            </span>
          </div>
        </header>
        {server.status === 'waiting' ? (
          <p className="server-waiting">No report yet. Run the install command on the server to start monitoring.</p>
        ) : (
          <div className="server-card-body">
            <Rings values={ringValues(s)} size={108} />
            <RingLegend
              values={ringValues(s)}
              details={{
                disk: s?.storageTotalBytes ? `${formatBytes(s.storageUsedBytes)} of ${formatBytes(s.storageTotalBytes)}` : '',
                mem: s?.memTotalBytes ? `of ${formatBytes(s.memTotalBytes)}` : '',
                cpu: server.host?.cores ? plural(server.host.cores, 'core') : '',
              }}
            />
          </div>
        )}
        <footer>
          {server.alerts.filter((a) => ['status', 'orthanc', 'volume'].includes(a.metric)).map((a) => (
            <StatusLabel key={a.metric} level={a.level}>
              {a.message}
            </StatusLabel>
          ))}
          {orthanc.length > 0 && orthanc.some((o) => o.reachable) && (
            <span className="server-orthanc">
              {studies !== null && studies !== undefined ? `${studies.toLocaleString()} studies` : 'Orthanc'} · Orthanc {orthanc.find((o) => o.version)?.version || ''}
              {orthanc.length > 1 ? ` · ${orthanc.length} instances` : ''}
            </span>
          )}
          {server.status !== 'waiting' && orthanc.length === 0 && <span className="server-orthanc muted">No Orthanc found</span>}
        </footer>
      </Link>
    </motion.div>
  );
}

function Tile({ label, value, detail, tone }) {
  return (
    <div className={`stat-tile ${tone ? `is-${tone}` : ''}`}>
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {detail && <span className="stat-detail">{detail}</span>}
    </div>
  );
}

export default function Servers() {
  const { isMaster } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [servers, setServers] = useState(null);
  const [clients, setClients] = useState([]);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [install, setInstall] = useState(null);

  const load = useCallback(
    () =>
      api('/servers')
        .then((d) => setServers(d.servers))
        .catch((err) => setError(err.message)),
    [],
  );

  useEffect(() => {
    load();
    api('/clients')
      .then((d) => setClients(d.clients))
      .catch(() => {});
    // Reports arrive every minute; keep the page current while it is open.
    const timer = setInterval(() => document.visibilityState === 'visible' && load(), 30_000);
    return () => clearInterval(timer);
  }, [load]);

  const byId = useMemo(() => Object.fromEntries(clients.map((c) => [c.id, c])), [clients]);
  const stats = useMemo(() => {
    if (!servers) return null;
    const online = servers.filter((s) => s.status === 'online').length;
    const attention = servers.filter((s) => s.alerts.length).length;
    const studies = servers.reduce((n, s) => n + (s.summary?.studies || 0), 0);
    const used = servers.reduce((n, s) => n + (s.summary?.storageUsedBytes || 0), 0);
    const total = servers.reduce((n, s) => n + (s.summary?.storageTotalBytes || 0), 0);
    return { online, attention, studies, used, total };
  }, [servers]);

  // Needing attention first, then by name.
  const sorted = useMemo(() => [...(servers || [])].sort((a, b) => b.alerts.length - a.alerts.length || a.name.localeCompare(b.name)), [servers]);

  return (
    <>
      <header className="large-header">
        <div>
          <p className="eyebrow">Monitoring</p>
          <h1>Servers</h1>
          <p className="page-sub">{servers ? `${plural(servers.length, 'server')} · updates every minute` : ' '}</p>
        </div>
        {isMaster && (
          <div className="header-tools">
            <Button icon={Plus} onClick={() => setAdding(true)}>
              Add Server
            </Button>
          </div>
        )}
      </header>

      {error && <p className="load-error">{error}</p>}

      {stats && servers.length > 0 && (
        <motion.div className="stat-row" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease }}>
          <Tile label="Online" value={`${stats.online} of ${servers.length}`} detail={stats.online === servers.length ? 'All reporting' : `${servers.length - stats.online} not reporting`} tone={stats.online < servers.length ? 'critical' : null} />
          <Tile label="Need attention" value={String(stats.attention)} detail={stats.attention ? 'See the flagged servers below' : 'Nothing flagged'} tone={stats.attention ? 'warning' : null} />
          <Tile label="Studies stored" value={stats.studies.toLocaleString()} detail="Across every Orthanc" />
          <Tile label="DICOM storage used" value={formatBytes(stats.used)} detail={stats.total ? `of ${formatBytes(stats.total)}` : ''} />
        </motion.div>
      )}

      {!servers && !error && (
        <div className="server-grid">
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="server-card skeleton" style={{ minHeight: 250 }} />
          ))}
        </div>
      )}

      {servers?.length > 0 && (
        <motion.div className="server-grid" variants={grid} initial="hidden" animate="show">
          {sorted.map((s) => (
            <ServerCard key={s.id} server={s} client={byId[s.clientId]} />
          ))}
        </motion.div>
      )}

      {servers?.length === 0 && (
        <motion.div className="empty" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, ease }}>
          <span className="empty-icon">
            <Activity size={36} strokeWidth={1.6} />
          </span>
          <h2>No servers yet</h2>
          <p>
            {isMaster
              ? 'Add a client server to watch its CPU, memory and Orthanc storage. You get a one-line command to run on it.'
              : 'Servers appear here once the master account adds them.'}
          </p>
          {isMaster && (
            <Button icon={Plus} size="lg" onClick={() => setAdding(true)}>
              Add Your First Server
            </Button>
          )}
        </motion.div>
      )}

      <ServerSheet
        open={adding}
        clients={clients}
        onClose={() => setAdding(false)}
        onSaved={(result) => {
          setAdding(false);
          toast(`${result.server.name} added`);
          setInstall({ name: result.server.name, command: result.installCommand, id: result.server.id });
          load();
        }}
      />
      <InstallSheet
        install={install}
        onClose={() => {
          const id = install?.id;
          setInstall(null);
          if (id) navigate(`/servers/${id}`);
        }}
      />
    </>
  );
}
