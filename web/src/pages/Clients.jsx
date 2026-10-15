import { Package, Plus, Search } from 'lucide-react';
import { motion } from 'motion/react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useToast } from '../components/toast.jsx';
import { AppIcon, Button, CopyButton, ease, Field, Segmented, Sheet, spring } from '../components/ui.jsx';
import { gradientFor, plural, timeAgo } from '../format.js';
import { PlatformIcon, PLATFORMS, platformById } from '../platforms.jsx';

const shelf = { show: { transition: { staggerChildren: 0.06 } } };
const rise = {
  hidden: { opacity: 0, y: 24, scale: 0.97 },
  show: { opacity: 1, y: 0, scale: 1, transition: { duration: 0.6, ease } },
};

const today = new Date().toLocaleDateString('en', { weekday: 'long', day: 'numeric', month: 'long' });

const linkFor = (platform, isMaster) => (isMaster ? platform.links.direct : platform.links.protected);
const available = (client) => client.platforms.filter((p) => p.current);

// App Store "Today" style card for a recent build.
function FeatureCard({ client, isMaster }) {
  const release = client.latest;
  const platform = client.platforms.find((p) => p.id === release.platform);
  const [a, b] = gradientFor(client.name);
  return (
    <motion.div variants={rise} className="feature-wrap" whileHover={{ y: -6 }} whileTap={{ scale: 0.97 }} transition={spring}>
      <div className="feature-card" style={{ '--fa': a, '--fb': b }}>
        {/* The whole card opens the client; the copy button sits above this layer. */}
        <Link to={`/clients/${client.slug}`} className="feature-hit" aria-label={`Open ${client.name}`} />
        <div className="feature-copy">
          <span className="feature-eyebrow">
            New build · {platformById(release.platform).label}
          </span>
          <h3>{client.name}</h3>
          <p>Uploaded {timeAgo(release.uploadedAt)}</p>
        </div>
        <div className="feature-art" aria-hidden="true">
          <span className="feature-platform">
            <PlatformIcon id={release.platform} size={22} />
          </span>
          <span className="feature-version">{release.version}</span>
        </div>
        <div className="feature-strip">
          <AppIcon name={client.name} size={46} />
          <div className="feature-strip-text">
            <strong>{client.name}</strong>
            <span>
              {release.version} · build {release.build}
            </span>
          </div>
          <CopyButton variant="get" label="COPY" text={linkFor(platform, isMaster)} message={`${client.name} ${platformById(release.platform).label} link copied`} className="get-pill-light" />
        </div>
      </div>
    </motion.div>
  );
}

function ClientRow({ client, isMaster }) {
  const ready = available(client);
  const primary = ready.find((p) => p.id === client.latest?.platform) || ready[0];
  return (
    <motion.li variants={rise} className="app-row">
      <Link to={`/clients/${client.slug}`} className="app-row-link">
        <motion.span whileHover={{ scale: 1.06, rotate: -2 }} transition={spring} className="app-row-icon">
          <AppIcon name={client.name} size={62} />
        </motion.span>
        <span className="app-row-text">
          <strong>{client.name}</strong>
          {primary ? (
            <span className="app-row-sub">
              {primary.current.version}
              <span className="app-row-platforms">
                {ready.map((p) => (
                  <span key={p.id} title={platformById(p.id).long}>
                    <PlatformIcon id={p.id} size={13} />
                  </span>
                ))}
              </span>
            </span>
          ) : (
            <span className="app-row-sub muted">No builds yet</span>
          )}
          <span className="app-row-meta">{client.latest ? `Updated ${timeAgo(client.latest.uploadedAt)}` : client.notes || `Added ${timeAgo(client.createdAt)}`}</span>
        </span>
      </Link>
      {primary && (
        <CopyButton variant="get" label="COPY" text={linkFor(primary, isMaster)} message={`${client.name} ${platformById(primary.id).label} link copied`} />
      )}
    </motion.li>
  );
}

function NewClientSheet({ open, onClose }) {
  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const toast = useToast();

  useEffect(() => {
    if (open) {
      setName('');
      setNotes('');
      setError('');
      setBusy(false);
    }
  }, [open]);

  async function onSubmit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { client } = await api('/clients', { method: 'POST', body: { name, notes } });
      toast(`${client.name} added`);
      navigate(`/clients/${client.slug}`);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title="New Client" subtitle="Each client keeps its own builds, per platform, and its own links.">
      <form onSubmit={onSubmit} className="sheet-body">
        <Field label="Name" error={error}>
          {(id) => <input id={id} className="input" placeholder="Ganesham Teleradiology" value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={80} />}
        </Field>
        <Field label="Notes" hint="Optional. Site, contact, anything worth remembering.">
          {(id) => <input id={id} className="input" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />}
        </Field>
        <div className="sheet-actions">
          <Button variant="plain" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={busy} disabled={!name.trim()}>
            Add Client
          </Button>
        </div>
      </form>
    </Sheet>
  );
}

export default function Clients() {
  const { isMaster } = useAuth();
  const [clients, setClients] = useState(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [platform, setPlatform] = useState('all');
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    api('/clients')
      .then((d) => setClients(d.clients))
      .catch((err) => setError(err.message));
  }, []);

  const filtered = useMemo(() => {
    if (!clients) return null;
    const q = query.trim().toLowerCase();
    return clients.filter(
      (c) =>
        (!q || c.name.toLowerCase().includes(q) || c.notes.toLowerCase().includes(q)) &&
        (platform === 'all' || c.platforms.some((p) => p.id === platform && p.current)),
    );
  }, [clients, query, platform]);

  const recent = useMemo(
    () =>
      (clients || [])
        .filter((c) => c.latest)
        .sort((a, b) => new Date(b.latest.uploadedAt) - new Date(a.latest.uploadedAt))
        .slice(0, 6),
    [clients],
  );

  const builds = clients?.reduce((n, c) => n + c.releaseCount, 0) ?? 0;
  const counts = Object.fromEntries(PLATFORMS.map((p) => [p.id, clients?.filter((c) => c.platforms.some((x) => x.id === p.id && x.current)).length ?? 0]));

  return (
    <>
      <header className="large-header">
        <div>
          <p className="eyebrow">{today}</p>
          <h1>Clients</h1>
          <p className="page-sub">{clients ? `${plural(clients.length, 'client')} · ${plural(builds, 'build')} stored` : ' '}</p>
        </div>
        <div className="header-tools">
          <label className="search glass">
            <Search size={16} strokeWidth={2.4} />
            <input id="client-search" type="search" placeholder="Search" aria-label="Search clients" value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
          {isMaster && (
            <Button icon={Plus} onClick={() => setAdding(true)}>
              New Client
            </Button>
          )}
        </div>
      </header>

      {error && <p className="load-error">{error}</p>}

      {!clients && !error && (
        <div className="shelf">
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="feature-wrap">
              <div className="feature-card skeleton" />
            </div>
          ))}
        </div>
      )}

      {recent.length > 0 && !query && platform === 'all' && (
        <section className="section">
          <div className="section-head">
            <h2>Latest Builds</h2>
          </div>
          <motion.div className="shelf" variants={shelf} initial="hidden" animate="show">
            {recent.map((c) => (
              <FeatureCard key={c.id} client={c} isMaster={isMaster} />
            ))}
          </motion.div>
        </section>
      )}

      {clients?.length > 0 && (
        <section className="section">
          <div className="section-head">
            <h2>All Clients</h2>
            <Segmented
              label="Platform"
              size="sm"
              value={platform}
              onChange={setPlatform}
              options={[
                { id: 'all', label: 'All' },
                ...PLATFORMS.map((p) => ({ id: p.id, label: p.label, icon: <PlatformIcon id={p.id} size={14} />, badge: counts[p.id] })),
              ]}
            />
          </div>
          {filtered.length > 0 ? (
            <motion.ul className="app-list" variants={shelf} initial="hidden" animate="show" key={`${query}|${platform}`}>
              {filtered.map((c) => (
                <ClientRow key={c.id} client={c} isMaster={isMaster} />
              ))}
            </motion.ul>
          ) : (
            <div className="empty">
              <h2>No matches</h2>
              <p>{query ? `Nothing matches “${query}”.` : `No client has a ${platformById(platform).long} build yet.`}</p>
            </div>
          )}
        </section>
      )}

      {clients?.length === 0 && (
        <motion.div className="empty" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, ease }}>
          <span className="empty-icon">
            <Package size={36} strokeWidth={1.6} />
          </span>
          <h2>No clients yet</h2>
          <p>
            {isMaster
              ? 'Add a client, then drop in its router installer. The publish script creates clients automatically too.'
              : 'Clients appear here once the master account adds them.'}
          </p>
          {isMaster && (
            <Button icon={Plus} size="lg" onClick={() => setAdding(true)}>
              Add Your First Client
            </Button>
          )}
        </motion.div>
      )}

      <NewClientSheet open={adding} onClose={() => setAdding(false)} />
    </>
  );
}
