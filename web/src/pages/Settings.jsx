import { Check, KeyRound, Lock, Terminal, UserRound } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useToast } from '../components/toast.jsx';
import { Button, CopyButton, ease, Field, Sheet } from '../components/ui.jsx';
import { formatDate, timeAgo } from '../format.js';

function Section({ icon: Icon, tint, title, description, children, index }) {
  return (
    <motion.section className="settings-section" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease, delay: index * 0.06 }}>
      <div className="settings-intro">
        <span className={`settings-icon tint-${tint}`}>
          <Icon size={19} strokeWidth={2.1} />
        </span>
        <div>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
      </div>
      <div className="card settings-card">{children}</div>
    </motion.section>
  );
}

function DownloadPassword({ status, onSaved }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  async function onSubmit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/settings/download-password', { method: 'PUT', body: { password } });
      setPassword('');
      toast(status.set ? 'Download password changed' : 'Download password set');
      onSaved();
    } catch (err) {
      setError(err.message);
    }
    setBusy(false);
  }

  return (
    <>
      <div className="row">
        <div className="row-text">
          <strong>Status</strong>
          <span>{status.set ? `Set ${timeAgo(status.updatedAt)}` : 'Not set. Protected links cannot be opened yet.'}</span>
        </div>
        <span className={`badge ${status.set ? 'badge-current' : 'badge-warn'}`}>{status.set ? 'Active' : 'Needed'}</span>
      </div>
      <form className="row row-form" onSubmit={onSubmit}>
        <Field label={status.set ? 'New password' : 'Password'} error={error} hint="At least 8 characters. Changing it applies to every protected link, including ones already shared.">
          {(id) => (
            <input
              id={id}
              className="input"
              type="text"
              autoComplete="off"
              spellCheck="false"
              placeholder="Something easy to read out over the phone"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          )}
        </Field>
        <Button type="submit" busy={busy} disabled={password.length < 8}>
          {status.set ? 'Change Password' : 'Set Password'}
        </Button>
      </form>
    </>
  );
}

function AccountSheet({ account, onClose, onSaved }) {
  const [username, setUsername] = useState('');
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const isMaster = account?.role === 'master';

  useEffect(() => {
    if (account) {
      setUsername(account.username);
      setCurrent('');
      setPassword('');
      setError('');
      setBusy(false);
    }
  }, [account]);

  async function onSubmit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const body = {};
    if (username.trim().toLowerCase() !== account.username) body.username = username;
    if (password) Object.assign(body, { password, currentPassword: current });
    try {
      await api(`/settings/accounts/${account.role}`, { method: 'PUT', body });
      onSaved(account.role);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  const changed = account && (username.trim().toLowerCase() !== account.username || password.length > 0);
  return (
    <Sheet
      open={Boolean(account)}
      onClose={onClose}
      title={isMaster ? 'Master account' : 'Helper account'}
      subtitle={isMaster ? 'Full access. Links copied by this account need no password.' : 'View only. Links copied by this account need the download password.'}
    >
      <form onSubmit={onSubmit} className="sheet-body">
        <Field label="Username">
          {(id) => <input id={id} className="input" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" autoCapitalize="none" spellCheck="false" />}
        </Field>
        {isMaster && (
          <Field label="Current password" hint="Only needed when changing the password.">
            {(id) => <input id={id} className="input" type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />}
          </Field>
        )}
        <Field label="New password" error={error} hint={isMaster ? 'At least 8 characters.' : 'At least 8 characters. The helper is signed out everywhere.'}>
          {(id) => <input id={id} className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" placeholder="Leave empty to keep the current one" />}
        </Field>
        <div className="sheet-actions">
          <Button variant="plain" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={busy} disabled={!changed || (password.length > 0 && password.length < 8)}>
            Save
          </Button>
        </div>
      </form>
    </Sheet>
  );
}

function DeployToken({ status, baseUrl, onChanged }) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  async function generate() {
    setBusy(true);
    try {
      const data = await api('/settings/deploy-token', { method: 'POST' });
      setToken(data.token);
      onChanged();
    } catch (err) {
      toast(err.message, 'error');
    }
    setBusy(false);
  }

  const configJson = JSON.stringify({ server: baseUrl, token }, null, 2);
  return (
    <>
      <div className="row">
        <div className="row-text">
          <strong>Deploy token</strong>
          <span>
            {status
              ? `Ends in ${status.hint} · created ${formatDate(status.createdAt)} · ${status.lastUsedAt ? `last used ${timeAgo(status.lastUsedAt)}` : 'never used'}`
              : 'None yet. The publish script needs one to upload.'}
          </span>
        </div>
        <Button variant="tinted" busy={busy} onClick={generate}>
          {status ? 'Replace Token' : 'Create Token'}
        </Button>
      </div>

      <AnimatePresence initial={false}>
        {token && (
          <motion.div className="row row-stack" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.4, ease }}>
            <p className="reveal-note">
              <Check size={15} strokeWidth={3} />
              Copy this now. It is not shown again, and any earlier token has stopped working.
            </p>
            <p className="row-label">
              Save as <code>tools\publish.config.json</code>
            </p>
            <div className="code-box">
              <pre>{configJson}</pre>
              <CopyButton variant="tinted" size="sm" text={configJson} label="Copy" message="Config copied" />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="row row-stack">
        <p className="row-label">Build a router and upload it in one step</p>
        <div className="code-box">
          <pre>{'tools\\publish-router.bat "D:\\work\\Go exe\\KENYA" -Client "Kenya"'}</pre>
        </div>
        <p className="field-hint">
          Add <code>-SkipBuild</code> to upload the installer already in <code>dist</code> without rebuilding.
        </p>
      </div>
    </>
  );
}

export default function Settings() {
  const { app, refresh } = useAuth();
  const toast = useToast();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [account, setAccount] = useState(null);

  const load = useCallback(
    () =>
      api('/settings')
        .then(setData)
        .catch((err) => setError(err.message)),
    [],
  );
  useEffect(() => {
    load();
  }, [load]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p className="page-sub">Passwords, accounts and the publish script.</p>
        </div>
      </div>

      {error && <p className="load-error">{error}</p>}
      {!data && !error && <div className="detail-skeleton skeleton" />}

      {data && (
        <div className="settings">
          <Section index={0} icon={Lock} tint="blue" title="Download password" description="One password unlocks every protected link. Share it only with the people who should be able to install.">
            <DownloadPassword
              status={data.downloadPassword}
              onSaved={() => {
                load();
                refresh();
              }}
            />
          </Section>

          <Section index={1} icon={UserRound} tint="purple" title="Accounts" description="Two sign-ins. The master manages everything; the helper can browse and copy protected links.">
            {data.accounts.map((a) => (
              <div className="row" key={a.role}>
                <div className="row-text">
                  <strong>{a.role === 'master' ? 'Master' : 'Helper'}</strong>
                  <span>
                    {a.username} · {a.role === 'master' ? 'links need no password' : 'links need the download password'}
                  </span>
                </div>
                <Button variant="tinted" icon={KeyRound} onClick={() => setAccount(a)}>
                  Edit
                </Button>
              </div>
            ))}
          </Section>

          <Section index={2} icon={Terminal} tint="green" title="Publish script" description="Builds a router with the same steps as build.bat, then uploads the installer to the matching client.">
            <DeployToken status={data.deployToken} baseUrl={app?.baseUrl || window.location.origin} onChanged={load} />
          </Section>
        </div>
      )}

      <AccountSheet
        account={account}
        onClose={() => setAccount(null)}
        onSaved={(role) => {
          setAccount(null);
          toast(`${role === 'master' ? 'Master' : 'Helper'} account updated`);
          load();
          refresh();
        }}
      />
    </>
  );
}
