import { ChevronRight, Package, Plus, Search } from 'lucide-react';
import { motion } from 'motion/react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useToast } from '../components/toast.jsx';
import { Avatar, Button, CopyButton, ease, Field, Sheet } from '../components/ui.jsx';
import { plural, timeAgo } from '../format.js';

const grid = { show: { transition: { staggerChildren: 0.045 } } };
const cell = {
  hidden: { opacity: 0, y: 18, scale: 0.97 },
  show: { opacity: 1, y: 0, scale: 1, transition: { duration: 0.5, ease } },
};

function ClientCard({ client, isMaster }) {
  const current = client.current;
  return (
    <motion.div variants={cell} whileHover={{ y: -4 }} whileTap={{ scale: 0.985 }} transition={{ type: 'spring', stiffness: 400, damping: 28 }}>
      <Link to={`/clients/${client.slug}`} className="card client-card">
        <div className="client-card-top">
          <Avatar name={client.name} size={52} />
          {current && (
            <div className="client-card-copy">
              <CopyButton
                variant="tinted"
                size="sm"
                label=""
                text={isMaster ? client.links.direct : client.links.protected}
                message={isMaster ? `${client.name}: direct link copied` : `${client.name}: protected link copied`}
              />
            </div>
          )}
        </div>
        <h3>{client.name}</h3>
        {current ? (
          <p className="client-card-version">
            <span className="version-chip">{current.version}</span>
            <span>build {current.build}</span>
          </p>
        ) : (
          <p className="client-card-version muted">No versions yet</p>
        )}
        <div className="client-card-foot">
          <span>
            {current ? `${plural(client.releaseCount, 'version')} · ${timeAgo(current.uploadedAt)}` : `Added ${timeAgo(client.createdAt)}`}
          </span>
          <ChevronRight size={16} />
        </div>
      </Link>
    </motion.div>
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
    <Sheet open={open} onClose={onClose} title="New client" subtitle="Each client keeps its own router versions and links.">
      <form onSubmit={onSubmit} className="sheet-body">
        <Field label="Client name" error={error}>
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
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    api('/clients')
      .then((d) => setClients(d.clients))
      .catch((err) => setError(err.message));
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!clients || !q) return clients;
    return clients.filter((c) => c.name.toLowerCase().includes(q) || c.notes.toLowerCase().includes(q));
  }, [clients, query]);

  const totalVersions = clients?.reduce((n, c) => n + c.releaseCount, 0) ?? 0;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Clients</h1>
          <p className="page-sub">
            {clients ? `${plural(clients.length, 'client')} · ${plural(totalVersions, 'version')} stored` : ' '}
          </p>
        </div>
        <div className="page-tools">
          <label className="search">
            <Search size={16} />
            <input id="client-search" type="search" placeholder="Search" aria-label="Search clients" value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
          {isMaster && (
            <Button icon={Plus} onClick={() => setAdding(true)}>
              New Client
            </Button>
          )}
        </div>
      </div>

      {error && <p className="load-error">{error}</p>}

      {!clients && !error && (
        <div className="client-grid">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="card client-card skeleton" />
          ))}
        </div>
      )}

      {filtered?.length > 0 && (
        <motion.div className="client-grid" variants={grid} initial="hidden" animate="show" key={query ? 'search' : 'all'}>
          {filtered.map((c) => (
            <ClientCard key={c.id} client={c} isMaster={isMaster} />
          ))}
        </motion.div>
      )}

      {clients?.length === 0 && (
        <motion.div className="empty" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, ease }}>
          <span className="empty-icon">
            <Package size={34} strokeWidth={1.6} />
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

      {clients?.length > 0 && filtered?.length === 0 && (
        <div className="empty">
          <h2>No results for “{query}”</h2>
          <p>Check the spelling or try another name.</p>
        </div>
      )}

      <NewClientSheet open={adding} onClose={() => setAdding(false)} />
    </>
  );
}
