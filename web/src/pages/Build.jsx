import { Check, ChevronDown, CircleAlert, ExternalLink, Hammer, ImagePlus, LoaderCircle, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useToast } from '../components/toast.jsx';
import { AppIcon, Banner, Button, CopyButton, ease, Field } from '../components/ui.jsx';
import { formatBytes, timeAgo } from '../format.js';

const STEP_LABELS = {
  queued: 'Queued',
  preparing: 'Preparing',
  customizing: 'Applying settings',
  engine: 'Building engine',
  packaging: 'Packaging installer',
  uploading: 'Uploading',
  done: 'Done',
};
const STEPS = ['preparing', 'customizing', 'engine', 'packaging', 'uploading'];

const BLANK = {
  clientId: '',
  productName: '',
  version: '1.0.0',
  aet: '',
  peer1: '',
  peer2: '',
  apiMain: '',
  apiBackup: '',
  dicomPort: 8899,
  httpPort: 9044,
  compression: false,
  peerUsername: '',
  peerPassword: '',
  settingsPin: '',
};

// "Quest Teleradiology" -> "QUEST"; what the AE title starts as until someone edits it.
const aetFrom = (name) => (name.split(/\s+/)[0] || '').toUpperCase().replace(/[^A-Z0-9_]/g, '').slice(0, 16);
const bump = (v) => {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v || '');
  return m ? `${m[1]}.${m[2]}.${Number(m[3]) + 1}` : '1.0.0';
};

function Toggle({ id, checked, onChange, label, hint }) {
  return (
    <label className="toggle toggle-row" htmlFor={id}>
      <span className="toggle-text">
        <span className="toggle-label">{label}</span>
        {hint && <span className="field-hint">{hint}</span>}
      </span>
      <input id={id} type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-track" aria-hidden="true">
        <span className="toggle-thumb" />
      </span>
    </label>
  );
}

function LogoPicker({ value, onChange }) {
  const input = useRef(null);
  const toast = useToast();
  function pick(file) {
    if (!file) return;
    if (file.type !== 'image/png') return toast('Use a PNG image for the logo.', 'error');
    if (file.size > 2 * 1024 * 1024) return toast('The logo must be 2 MB or smaller.', 'error');
    const reader = new FileReader();
    reader.onload = () => onChange(reader.result);
    reader.readAsDataURL(file);
  }
  return (
    <div className="logo-picker">
      <input ref={input} id="build-logo" type="file" accept="image/png" hidden onChange={(e) => (pick(e.target.files?.[0]), (e.target.value = ''))} />
      <button type="button" className="logo-well" onClick={() => input.current.click()} aria-label="Choose a logo">
        {value ? <img src={value} alt="" /> : <ImagePlus size={24} strokeWidth={1.8} />}
      </button>
      <div className="logo-text">
        <strong>{value ? 'Client logo' : 'No logo'}</strong>
        <span>{value ? 'Used for the app, its shortcut and the installer.' : 'A neutral router icon is used. PNG, square, 512 px or larger is best.'}</span>
        <span className="logo-actions">
          <button type="button" className="link" onClick={() => input.current.click()}>
            {value ? 'Replace' : 'Choose PNG'}
          </button>
          {value && (
            <button type="button" className="link" onClick={() => onChange(null)}>
              Remove
            </button>
          )}
        </span>
      </div>
    </div>
  );
}

function Stepper({ build }) {
  const at = build.status === 'succeeded' ? STEPS.length : Math.max(0, STEPS.indexOf(build.step));
  return (
    <ol className="stepper">
      {STEPS.map((s, i) => {
        const state = build.status === 'succeeded' || i < at ? 'done' : i === at && build.status === 'running' ? 'active' : i === at && (build.status === 'failed' || build.status === 'cancelled') ? 'failed' : 'todo';
        return (
          <li key={s} className={`step is-${state}`}>
            <span className="step-dot">
              {state === 'done' ? <Check size={13} strokeWidth={3.2} /> : state === 'active' ? <LoaderCircle size={14} strokeWidth={2.6} className="spin" /> : state === 'failed' ? <X size={13} strokeWidth={3} /> : i + 1}
            </span>
            <span className="step-label">{STEP_LABELS[s]}</span>
          </li>
        );
      })}
    </ol>
  );
}

// Polls a build while it runs and appends new log lines as they arrive.
function useBuild(id) {
  const [build, setBuild] = useState(null);
  const [log, setLog] = useState([]);
  const length = useRef(0);
  useEffect(() => {
    if (!id) return;
    let stop = false;
    length.current = 0;
    setLog([]);
    setBuild(null);
    const tick = async () => {
      try {
        const { build: b } = await api(`/builds/${id}?since=${length.current}`);
        if (stop) return;
        setBuild(b);
        if (b.log.length) setLog((prev) => [...prev, ...b.log]);
        length.current = b.logLength;
        if (b.status === 'queued' || b.status === 'running') setTimeout(tick, 1500);
      } catch {
        if (!stop) setTimeout(tick, 4000);
      }
    };
    tick();
    return () => {
      stop = true;
    };
  }, [id]);
  return [build, log];
}

function BuildView({ id, onChanged }) {
  const [build, log] = useBuild(id);
  const [release, setRelease] = useState(null);
  const box = useRef(null);
  const stick = useRef(true);
  const toast = useToast();

  useEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [log]);

  useEffect(() => {
    if (build && ['succeeded', 'failed', 'cancelled'].includes(build.status)) onChanged?.();
    if (build?.status === 'succeeded' && build.result?.releaseId && build.result.clientSlug) {
      api(`/clients/${build.result.clientSlug}`)
        .then((d) => setRelease(d.releases.find((r) => r.id === build.result.releaseId) || null))
        .catch(() => {});
    }
  }, [build?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!build) return <div className="build-view skeleton" style={{ minHeight: 260 }} />;

  async function cancel() {
    try {
      await api(`/builds/${build.id}/cancel`, { method: 'POST' });
      toast('Cancelling…');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  const running = build.status === 'queued' || build.status === 'running';
  return (
    <motion.section className="build-view" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, ease }}>
      <header className="build-view-head">
        <AppIcon name={build.spec.productName} size={46} />
        <div>
          <h3>
            {build.spec.productName} {build.spec.version}
          </h3>
          <p>
            For {build.clientName} · started by {build.createdBy} {timeAgo(build.createdAt)}
          </p>
        </div>
        <span className={`build-status is-${build.status}`}>{build.status === 'running' ? STEP_LABELS[build.step] : build.status[0].toUpperCase() + build.status.slice(1)}</span>
        {running && !build.cancelRequested && (
          <Button variant="plain" size="sm" onClick={cancel}>
            Cancel
          </Button>
        )}
      </header>

      <Stepper build={build} />

      <AnimatePresence>
        {build.status === 'succeeded' && (
          <motion.div className="build-done" initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} transition={{ type: 'spring', stiffness: 300, damping: 24 }}>
            <span className="build-done-mark">
              <Check size={20} strokeWidth={3} />
            </span>
            <div>
              <strong>{build.result?.duplicate ? 'Already on the hub' : `${build.result.fileName} is ready`}</strong>
              <span>
                {build.result?.duplicate ? build.result.message : `Build ${build.result.build} · ${formatBytes(build.result.size)} · now the current Windows version of ${build.clientName}`}
              </span>
            </div>
            <div className="build-done-actions">
              {release && <CopyButton size="sm" text={release.links.direct} label="Copy Link" message="Direct link copied" />}
              {build.result?.clientSlug && (
                <Link className="btn btn-tinted btn-sm" to={`/clients/${build.result.clientSlug}`}>
                  <ExternalLink size={14} strokeWidth={2.2} />
                  <span>Open Client</span>
                </Link>
              )}
            </div>
          </motion.div>
        )}
        {(build.status === 'failed' || build.status === 'cancelled') && build.error && (
          <motion.div className="build-failed" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            <CircleAlert size={18} strokeWidth={2.2} />
            <span>{build.error}</span>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="build-log" ref={box} onScroll={(e) => (stick.current = e.target.scrollHeight - e.target.scrollTop - e.target.clientHeight < 40)} role="log" aria-live="polite" aria-label="Build output">
        {log.length === 0 && <span className="log-line is-muted">{build.status === 'queued' ? 'Waiting for the builder…' : 'No output yet.'}</span>}
        {log.map((line, i) => (
          <span key={i} className={`log-line ${line.startsWith('==>') ? 'is-step' : line.startsWith('!!') ? 'is-error' : line.startsWith('$ ') ? 'is-cmd' : ''}`}>
            {line}
          </span>
        ))}
      </div>
    </motion.section>
  );
}

export default function Build() {
  const toast = useToast();
  const [clients, setClients] = useState([]);
  const [form, setForm] = useState(BLANK);
  const [aetTouched, setAetTouched] = useState(false);
  const [logo, setLogo] = useState(null);
  const [advanced, setAdvanced] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [builds, setBuilds] = useState([]);
  const [selected, setSelected] = useState(null);
  const [builder, setBuilder] = useState(null);

  const loadBuilds = useCallback(
    () =>
      api('/builds')
        .then((d) => setBuilds(d.builds))
        .catch(() => {}),
    [],
  );

  useEffect(() => {
    api('/clients')
      .then((d) => setClients(d.clients))
      .catch(() => {});
    loadBuilds().then(() => {});
    const status = () =>
      api('/builds/builder')
        .then(setBuilder)
        .catch(() => {});
    status();
    const t = setInterval(() => document.visibilityState === 'visible' && (status(), loadBuilds()), 10_000);
    return () => clearInterval(t);
  }, [loadBuilds]);

  useEffect(() => {
    if (!selected && builds.length) setSelected(builds[0].id);
  }, [builds, selected]);

  const set = (key) => (e) => {
    const value = e?.target ? (e.target.type === 'number' ? e.target.value : e.target.value) : e;
    setForm((f) => {
      const next = { ...f, [key]: value };
      if (key === 'productName' && !aetTouched) next.aet = aetFrom(value);
      return next;
    });
  };

  // Choosing a client: start from its last build's settings, one version up.
  async function chooseClient(id) {
    const client = clients.find((c) => c.id === id);
    setForm((f) => ({ ...f, clientId: id, productName: f.productName || client?.name || '' }));
    if (!id) return;
    try {
      const { spec } = await api(`/builds/last-spec?client=${id}`);
      if (spec) {
        setForm({ ...BLANK, ...spec, clientId: id, version: bump(spec.version), peerPassword: '' });
        setAetTouched(true);
        toast(`Loaded the settings of the last ${client?.name} build`);
      } else if (!aetTouched) {
        setForm((f) => ({ ...f, aet: aetFrom(f.productName) }));
      }
    } catch {}
  }

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const body = { ...form, dicomPort: Number(form.dicomPort), httpPort: Number(form.httpPort), logo };
      if (!body.clientId) delete body.clientId;
      const { build } = await api('/builds', { method: 'POST', body });
      toast(`Building ${build.spec.productName} ${build.spec.version}`);
      setSelected(build.id);
      loadBuilds();
      setTimeout(() => document.getElementById('build-progress')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 150);
    } catch (err) {
      setError(err.message);
    }
    setBusy(false);
  }

  const installerName = `${form.productName || 'Product'} Setup ${form.version || '1.0.0'}.exe`;
  const sortedClients = useMemo(() => [...clients].sort((a, b) => a.name.localeCompare(b.name)), [clients]);
  const ready = form.productName.trim() && form.aet && form.peer1.trim() && form.apiMain.trim() && form.version;

  return (
    <>
      <header className="large-header">
        <div>
          <p className="eyebrow">Router Builder</p>
          <h1>Build a Router</h1>
          <p className="page-sub">From the Ganesham router code, for any client: fill in its servers and defaults, and the installer is built on the server.</p>
        </div>
        {builder && (
          <span className={`status-pill ${builder.online ? 'is-online' : 'is-offline'}`}>
            <span className="status-dot" />
            {builder.online ? (builder.busy ? 'Builder busy' : 'Builder ready') : 'Builder offline'}
            {builder.queued > 0 && <span className="status-age">· {builder.queued} queued</span>}
          </span>
        )}
      </header>

      {builder && !builder.online && (
        <Banner icon={CircleAlert} tone="warn">
          The builder is not running, so new builds will wait in the queue. It starts with the server stack; if it stays offline, check the deployment.
        </Banner>
      )}

      <div className="build-layout">
        <form className="build-form" onSubmit={submit}>
          <section className="form-group">
            <h2>Client &amp; product</h2>
            <div className="form-card">
              <Field label="Client" hint="An existing client loads its last build's settings. Leave empty to create a client named after the product.">
                {(id) => (
                  <select id={id} className="input select" value={form.clientId} onChange={(e) => chooseClient(e.target.value)}>
                    <option value="">New client</option>
                    {sortedClients.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <div className="form-grid">
                <Field label="Product name" hint="Shown in the window, Start menu and installer.">
                  {(id) => <input id={id} className="input" placeholder="Quest Teleradiology" value={form.productName} onChange={set('productName')} maxLength={60} required />}
                </Field>
                <Field label="Version">{(id) => <input id={id} className="input" placeholder="1.0.0" value={form.version} onChange={set('version')} maxLength={20} required />}</Field>
              </div>
              <LogoPicker value={logo} onChange={setLogo} />
            </div>
          </section>

          <section className="form-group">
            <h2>Receivers</h2>
            <div className="form-card">
              <div className="form-grid">
                <Field label="Peer 1 URL" hint="Main receiver studies are sent to.">
                  {(id) => <input id={id} className="input" type="url" placeholder="https://router.client.com" value={form.peer1} onChange={set('peer1')} required />}
                </Field>
                <Field label="Peer 2 URL" hint="Fallback receiver. Optional.">
                  {(id) => <input id={id} className="input" type="url" placeholder="https://clientrouter.xcentic.com" value={form.peer2} onChange={set('peer2')} />}
                </Field>
              </div>
            </div>
          </section>

          <section className="form-group">
            <h2>PACS API</h2>
            <div className="form-card">
              <div className="form-grid">
                <Field label="Main API URL" hint="Login, study notifications and lab status.">
                  {(id) => <input id={id} className="input" type="url" placeholder="https://pacs.client.com" value={form.apiMain} onChange={set('apiMain')} required />}
                </Field>
                <Field label="Backup API URL" hint="Used when the main one is unreachable. Optional.">
                  {(id) => <input id={id} className="input" type="url" placeholder="https://client.xcentic.com" value={form.apiBackup} onChange={set('apiBackup')} />}
                </Field>
              </div>
            </div>
          </section>

          <section className="form-group">
            <h2>Defaults</h2>
            <div className="form-card">
              <div className="form-grid form-grid-3">
                <Field label="DICOM port" hint="Modalities send here.">
                  {(id) => <input id={id} className="input" type="number" min={1} max={65535} value={form.dicomPort} onChange={set('dicomPort')} required />}
                </Field>
                <Field label="AE title" hint="Up to 16 capitals.">
                  {(id) => (
                    <input
                      id={id}
                      className="input mono"
                      value={form.aet}
                      onChange={(e) => (setAetTouched(true), set('aet')({ target: { value: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '').slice(0, 16) } }))}
                      required
                    />
                  )}
                </Field>
                <Field label="Local API port" hint="Between the app and its engine.">
                  {(id) => <input id={id} className="input" type="number" min={1024} max={65535} value={form.httpPort} onChange={set('httpPort')} required />}
                </Field>
              </div>
              <Toggle
                id="build-compression"
                checked={form.compression}
                onChange={(v) => setForm((f) => ({ ...f, compression: v }))}
                label="Compression"
                hint="JPEG 2000 lossy before sending. The PACS's per-centre setting still overrides this."
              />
            </div>
          </section>

          <section className="form-group">
            <button type="button" className="disclosure" onClick={() => setAdvanced((a) => !a)} aria-expanded={advanced}>
              <motion.span animate={{ rotate: advanced ? 0 : -90 }} transition={{ duration: 0.2 }}>
                <ChevronDown size={18} strokeWidth={2.4} />
              </motion.span>
              Advanced
            </button>
            <AnimatePresence initial={false}>
              {advanced && (
                <motion.div className="form-card" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.3, ease }} style={{ overflow: 'hidden' }}>
                  <div className="form-grid form-grid-3">
                    <Field label="Receiver username" hint="Empty: the standard Xcentic ingestion login.">
                      {(id) => <input id={id} className="input" autoComplete="off" value={form.peerUsername} onChange={set('peerUsername')} />}
                    </Field>
                    <Field label="Receiver password" hint="Empty: the standard one.">
                      {(id) => <input id={id} className="input" type="password" autoComplete="new-password" value={form.peerPassword} onChange={set('peerPassword')} />}
                    </Field>
                    <Field label="Settings PIN" hint="Unlocks Settings in the app. Empty: 18967.">
                      {(id) => <input id={id} className="input mono" inputMode="numeric" value={form.settingsPin} onChange={set('settingsPin')} maxLength={12} />}
                    </Field>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </section>
        </form>

        <aside className="build-preview">
          <div className="preview-card">
            <div className="preview-icon">{logo ? <img src={logo} alt="" /> : form.productName ? <AppIcon name={form.productName} size={96} /> : <span className="preview-blank" />}</div>
            <h3>{form.productName || 'New router'}</h3>
            <p className="preview-file">{installerName}</p>
            <dl className="preview-facts">
              <div>
                <dt>DICOM</dt>
                <dd>
                  {form.aet || '—'} : {form.dicomPort || '—'}
                </dd>
              </div>
              <div>
                <dt>Compression</dt>
                <dd>{form.compression ? 'On' : 'Off'}</dd>
              </div>
              <div>
                <dt>Receivers</dt>
                <dd>{[form.peer1, form.peer2].filter((x) => x.trim()).length || '—'}</dd>
              </div>
              <div>
                <dt>Windows</dt>
                <dd>7 and later · 32/64-bit</dd>
              </div>
            </dl>
            <AnimatePresence>
              {error && (
                <motion.p className="form-error" role="alert" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}>
                  {error}
                </motion.p>
              )}
            </AnimatePresence>
            <Button size="lg" className="btn-block" icon={Hammer} busy={busy} disabled={!ready} onClick={submit}>
              Build Installer
            </Button>
            <p className="field-hint">Takes about 2 to 4 minutes. The installer is added to the client as its current Windows version.</p>
          </div>
        </aside>
      </div>

      {selected && (
        <section className="section" id="build-progress">
          <div className="section-head">
            <h2>Build</h2>
          </div>
          <BuildView key={selected} id={selected} onChanged={loadBuilds} />
        </section>
      )}

      {builds.length > 0 && (
        <section className="section">
          <div className="section-head">
            <h2>Recent Builds</h2>
          </div>
          <ul className="inset-list build-list">
            {builds.map((b) => (
              <li key={b.id}>
                <button type="button" className={`build-row ${b.id === selected ? 'is-selected' : ''}`} onClick={() => setSelected(b.id)}>
                  <AppIcon name={b.spec.productName} size={34} />
                  <span className="build-row-text">
                    <strong>
                      {b.spec.productName} {b.spec.version}
                    </strong>
                    <span>
                      {b.clientName} · {b.createdBy} · {timeAgo(b.createdAt)}
                    </span>
                  </span>
                  <span className={`build-status is-${b.status}`}>{b.status === 'running' ? STEP_LABELS[b.step] : b.status[0].toUpperCase() + b.status.slice(1)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
