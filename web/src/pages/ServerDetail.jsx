import { ChevronLeft, KeyRound, Pencil, Trash } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { AreaChart, Meter, METRICS, Rings, RingLegend, StatusLabel } from '../components/charts.jsx';
import { useToast } from '../components/toast.jsx';
import { Button, Menu, Segmented, Sheet } from '../components/ui.jsx';
import { formatBytes, formatDate, plural, timeAgo } from '../format.js';
import { InstallSheet, ringValues, ServerIcon, ServerSheet, StatusPill } from './Servers.jsx';

const RANGES = [
  { id: '6h', label: '6 hours' },
  { id: '24h', label: '24 hours' },
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
];

function uptime(sec) {
  if (!sec) return '—';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  return d ? `${plural(d, 'day')}, ${plural(h, 'hour')}` : `${plural(h, 'hour')}, ${plural(Math.floor((sec % 3600) / 60), 'minute')}`;
}

const MB = 1024 * 1024;

function OrthancCard({ instance, volume }) {
  const s = instance.stats;
  const figures = s
    ? [
        ['Patients', s.patients],
        ['Studies', s.studies],
        ['Series', s.series],
        ['Instances', s.instances],
      ]
    : [];
  return (
    <div className="orthanc-card">
      <header>
        <div>
          <h3>{instance.name}</h3>
          <p>
            {instance.version ? `Orthanc ${instance.version}` : 'Orthanc'} · {instance.url || 'address unknown'}
          </p>
        </div>
        {s ? (
          <span className="status-pill is-online">
            <span className="status-dot" />
            Answering
          </span>
        ) : (
          <StatusLabel level="warning">{instance.httpStatus === 401 ? 'Needs a login' : 'Not answering'}</StatusLabel>
        )}
      </header>
      {s ? (
        <div className="figure-row">
          {figures.map(([label, value]) => (
            <div key={label} className="figure">
              <span className="figure-value">{value === null ? '—' : value.toLocaleString()}</span>
              <span className="figure-label">{label}</span>
            </div>
          ))}
          <div className="figure">
            <span className="figure-value">{s.diskSizeMB === null ? '—' : formatBytes(s.diskSizeMB * MB)}</span>
            <span className="figure-label">Stored</span>
          </div>
        </div>
      ) : (
        <p className="orthanc-help">
          {instance.httpStatus === 401
            ? 'Orthanc asked for a login. Re-run the install command with --orthanc-user and --orthanc-pass.'
            : 'The agent found this Orthanc but could not read its statistics. If it listens elsewhere, re-run the install command with --orthanc-url.'}
        </p>
      )}
      {volume && volume.sizeBytes ? (
        <div className="orthanc-volume">
          <span className="volume-path">
            Storage <code>{instance.storagePath}</code> on <code>{volume.mount}</code>
          </span>
          <Meter usedBytes={volume.usedBytes} totalBytes={volume.usedBytes + volume.availBytes} />
        </div>
      ) : (
        instance.storagePath && <p className="orthanc-help">Storage folder {instance.storagePath} could not be measured.</p>
      )}
    </div>
  );
}

export default function ServerDetail() {
  const { id } = useParams();
  const { isMaster } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [server, setServer] = useState(null);
  const [clients, setClients] = useState([]);
  const [history, setHistory] = useState(null);
  const [range, setRange] = useState('24h');
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [install, setInstall] = useState(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removing, setRemoving] = useState(false);

  const loadServer = useCallback(
    () =>
      api(`/servers/${id}`)
        .then((d) => setServer(d.server))
        .catch((err) => setError(err.message)),
    [id],
  );
  const loadHistory = useCallback(() => {
    setLoadingHistory(true);
    return api(`/servers/${id}/history?range=${range}`)
      .then((d) => setHistory({ ...d, until: new Date().toISOString() }))
      .catch(() => {})
      .finally(() => setLoadingHistory(false));
  }, [id, range]);

  useEffect(() => {
    loadServer();
    api('/clients')
      .then((d) => setClients(d.clients))
      .catch(() => {});
    const timer = setInterval(() => document.visibilityState === 'visible' && loadServer(), 30_000);
    return () => clearInterval(timer);
  }, [loadServer]);

  useEffect(() => {
    loadHistory();
    const timer = setInterval(() => document.visibilityState === 'visible' && loadHistory(), 60_000);
    return () => clearInterval(timer);
  }, [loadHistory]);

  const client = useMemo(() => clients.find((c) => c.id === server?.clientId), [clients, server]);

  if (error) {
    return (
      <div className="empty">
        <h2>Server unavailable</h2>
        <p>{error}</p>
        <Link to="/servers" className="btn btn-tinted">
          Back to Servers
        </Link>
      </div>
    );
  }
  if (!server) return <div className="detail-skeleton skeleton" />;

  const s = server.summary;
  const report = server.report;
  const values = ringValues(s);

  async function newToken() {
    try {
      const d = await api(`/servers/${server.id}/token`, { method: 'POST' });
      setInstall({ name: server.name, command: d.installCommand });
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function remove() {
    setRemoving(true);
    try {
      await api(`/servers/${server.id}`, { method: 'DELETE' });
      toast(`${server.name} is no longer monitored`);
      navigate('/servers');
    } catch (err) {
      toast(err.message, 'error');
      setRemoving(false);
    }
  }

  const volumeFor = (path) => report?.storage.find((v) => v.path === path);
  const otherStorage = report?.storage.filter((v) => !report.orthanc.some((o) => o.storagePath === v.path)) || [];

  return (
    <div className="server-detail">
      <Link to="/servers" className="back glass">
        <ChevronLeft size={18} strokeWidth={2.6} />
        Servers
      </Link>

      <header className="product-head">
        <ServerIcon server={server} client={client} size={112} />
        <div className="product-title">
          <h1>{server.name}</h1>
          <p className="page-sub">
            {client ? <Link to={`/clients/${client.slug}`}>{client.name}</Link> : 'No client linked'}
            {server.host?.hostname ? ` · ${server.host.hostname}` : ''}
          </p>
          <div className="product-actions">
            <StatusPill server={server} />
            {isMaster && (
              <Menu
                trigger="glass"
                label="Server actions"
                items={[
                  { label: 'Edit Server', icon: Pencil, onSelect: () => setEditing(true) },
                  { label: 'New Install Command', icon: KeyRound, onSelect: newToken },
                  'separator',
                  { label: 'Stop Monitoring', icon: Trash, danger: true, onSelect: () => setConfirmRemove(true) },
                ]}
              />
            )}
          </div>
        </div>
      </header>

      {server.status === 'waiting' ? (
        <div className="platform-empty">
          <div>
            <h3>Waiting for the first report</h3>
            <p>
              Run the install command on the server as root.{' '}
              {isMaster ? 'Lost it? Use New Install Command in the ⋯ menu; the previous one stops working.' : 'The master account has the command.'}
            </p>
          </div>
        </div>
      ) : (
        <>
          {server.alerts.length > 0 && (
            <div className="alert-list">
              {server.alerts.map((a) => (
                <StatusLabel key={a.metric} level={a.level}>
                  {a.message}
                </StatusLabel>
              ))}
            </div>
          )}

          <section className="vitals">
            <Rings values={values} size={196} />
            <RingLegend
              large
              values={values}
              details={{
                disk: s?.storageTotalBytes ? `${formatBytes(s.storageUsedBytes)} of ${formatBytes(s.storageTotalBytes)} · ${s.storagePath}` : '',
                mem: s?.memTotalBytes ? `${formatBytes(s.memUsedBytes)} of ${formatBytes(s.memTotalBytes)}` : '',
                cpu: report?.cpu ? `load ${report.cpu.load1 ?? '—'} · ${plural(report.host.cores || 0, 'core')}` : '',
              }}
            />
          </section>

          <section className="section">
            <div className="section-head">
              <h2>History</h2>
              <Segmented label="Time range" size="sm" value={range} onChange={setRange} options={RANGES} />
            </div>
            <div className={`chart-stack ${loadingHistory ? 'is-loading' : ''}`}>
              {history &&
                METRICS.map((m) => <AreaChart key={m.id} metric={m.id} points={history.points} since={history.since} until={history.until} bucketMs={history.bucketMs} />)}
            </div>
            {history?.points.length > 0 && (
              <details className="data-table">
                <summary>Show as a table</summary>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">Time</th>
                        {METRICS.map((m) => (
                          <th key={m.id} scope="col">
                            {m.label}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {[...history.points].reverse().map((p) => (
                        <tr key={p.t}>
                          <td>{new Date(p.t).toLocaleString('en', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })}</td>
                          {METRICS.map((m) => (
                            <td key={m.id}>{p[m.id] === null ? '—' : `${p[m.id]}%`}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            )}
          </section>

          <section className="section">
            <div className="section-head">
              <h2>Orthanc</h2>
              <span className="section-count">{report?.orthanc.length ? plural(report.orthanc.length, 'instance') : ''}</span>
            </div>
            {report?.orthanc.length ? (
              <div className="orthanc-list">
                {report.orthanc.map((o, i) => (
                  <OrthancCard key={`${o.name}-${i}`} instance={o} volume={volumeFor(o.storagePath)} />
                ))}
              </div>
            ) : (
              <div className="platform-empty">
                <div>
                  <h3>No Orthanc found</h3>
                  <p>The agent looks in Docker and on port 8042. If Orthanc runs elsewhere, re-run the install command with --orthanc-url and --storage.</p>
                </div>
              </div>
            )}
          </section>

          <section className="section">
            <div className="section-head">
              <h2>Disks</h2>
              <span className="section-count">{plural((report?.disks.length || 0) + otherStorage.length, 'volume')}</span>
            </div>
            <ul className="inset-list disk-list">
              {[...otherStorage.map((v) => ({ ...v, title: v.path, sub: v.error || `${v.mount} · ${v.type}` })), ...(report?.disks || []).map((d) => ({ ...d, title: d.mount, sub: `${d.fs} · ${d.type}` }))].map((d) => (
                <li key={`${d.title}-${d.fs}`} className="disk-row">
                  <div className="disk-name">
                    <strong>{d.title}</strong>
                    <span>{d.sub}</span>
                  </div>
                  {d.sizeBytes ? <Meter usedBytes={d.usedBytes} totalBytes={d.usedBytes + d.availBytes} /> : <span className="muted">Not measured</span>}
                </li>
              ))}
            </ul>
          </section>

          <section className="section">
            <div className="section-head">
              <h2>System</h2>
            </div>
            <ul className="inset-list info-list">
              {[
                ['Hostname', server.host?.hostname],
                ['Operating system', server.host?.os],
                ['Kernel', server.host?.kernel],
                ['Processor', plural(server.host?.cores || 0, 'core')],
                ['Load average', report ? `${report.cpu.load1} · ${report.cpu.load5} · ${report.cpu.load15}` : '—'],
                ['Swap', report?.memory.swapTotalBytes ? `${formatBytes(report.memory.swapTotalBytes - report.memory.swapFreeBytes)} of ${formatBytes(report.memory.swapTotalBytes)}` : 'None'],
                ['Up for', uptime(server.host?.uptimeSec)],
                ['Last report', server.lastReportAt ? `${timeAgo(server.lastReportAt)} (${formatDate(server.lastReportAt)})` : '—'],
                ['Agent', server.agentVersion ? `${server.agentVersion} · every ${server.interval}s` : '—'],
              ].map(([k, v]) => (
                <li key={k}>
                  <span>{k}</span>
                  <span>{v || '—'}</span>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}

      {isMaster && (
        <>
          <ServerSheet
            open={editing}
            server={server}
            clients={clients}
            onClose={() => setEditing(false)}
            onSaved={() => {
              setEditing(false);
              toast('Server updated');
              loadServer();
            }}
          />
          <InstallSheet install={install} onClose={() => setInstall(null)} />
          <Sheet open={confirmRemove} onClose={() => setConfirmRemove(false)} title={`Stop monitoring ${server.name}?`} width={440}>
            <div className="sheet-body">
              <p className="sheet-text">
                Its agent token stops working and its history is removed from Router Hub. Nothing on the server itself is touched; the agent there will keep trying until you disable it with{' '}
                <code>systemctl disable --now routerhub-agent.timer</code>.
              </p>
              <div className="sheet-actions">
                <Button variant="plain" onClick={() => setConfirmRemove(false)}>
                  Cancel
                </Button>
                <Button variant="danger" busy={removing} onClick={remove}>
                  Stop Monitoring
                </Button>
              </div>
            </div>
          </Sheet>
        </>
      )}
    </div>
  );
}
