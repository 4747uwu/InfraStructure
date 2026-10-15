import { BellRing, Check, KeyRound, Lock, Terminal, UserRound } from 'lucide-react';
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

function Toggle({ id, checked, onChange, label }) {
  return (
    <label className="toggle" htmlFor={id}>
      <input id={id} type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-track" aria-hidden="true">
        <span className="toggle-thumb" />
      </span>
      <span className="toggle-label">{label}</span>
    </label>
  );
}

// Alert threshold and the two delivery channels. Secrets are write-only: the page only
// knows whether one is saved, and an empty field keeps the saved value.
function Notifications({ value, onSaved }) {
  const toast = useToast();
  const [threshold, setThreshold] = useState(value.storageThreshold);
  const [email, setEmail] = useState({ ...value.email, password: '', to: value.email.to.join(', ') });
  const [telegram, setTelegram] = useState({ ...value.telegram, botToken: '' });
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    setThreshold(value.storageThreshold);
    setEmail({ ...value.email, password: '', to: value.email.to.join(', ') });
    setTelegram({ ...value.telegram, botToken: '' });
  }, [value]);

  const setE = (key) => (e) => setEmail((x) => ({ ...x, [key]: e.target.value }));
  const setT = (key) => (e) => setTelegram((x) => ({ ...x, [key]: e.target.value }));

  async function save(e) {
    e?.preventDefault();
    setBusy(true);
    setError('');
    try {
      const d = await api('/settings/notifications', {
        method: 'PUT',
        body: {
          storageThreshold: Number(threshold),
          email: { enabled: email.enabled, host: email.host, port: Number(email.port), secure: email.secure, user: email.user, password: email.password, from: email.from, to: email.to },
          telegram: { enabled: telegram.enabled, botToken: telegram.botToken, chatId: telegram.chatId },
        },
      });
      toast('Alert settings saved');
      onSaved(d.notifications);
      setBusy(false);
      return true;
    } catch (err) {
      setError(err.message);
      setBusy(false);
      return false;
    }
  }

  async function test(channel) {
    setTesting(channel);
    // Test what is on screen: save first.
    if (await save()) {
      try {
        await api('/settings/notifications/test', { method: 'POST', body: { channel } });
        toast(channel === 'email' ? 'Test email sent' : 'Test message sent to Telegram');
      } catch (err) {
        toast(err.message, 'error');
      }
    }
    setTesting('');
  }

  return (
    <form onSubmit={save}>
      <div className="row row-form">
        <Field label="Storage alert at" hint="An alert opens when a server's DICOM storage reaches this, and resolves once it is a point below.">
          {(id) => (
            <div className="threshold-input">
              <input id={id} className="input" type="number" min={50} max={99} value={threshold} onChange={(e) => setThreshold(e.target.value)} />
              <span>% used</span>
            </div>
          )}
        </Field>
      </div>

      <div className="row row-stack">
        <Toggle id="notify-email" checked={email.enabled} onChange={(v) => setEmail((x) => ({ ...x, enabled: v }))} label="Email" />
        <AnimatePresence initial={false}>
          {email.enabled && (
            <motion.div className="channel-fields" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.3, ease }}>
              <div className="channel-grid">
                <Field label="SMTP server">{(id) => <input id={id} className="input" placeholder="smtp.gmail.com" value={email.host} onChange={setE('host')} />}</Field>
                <Field label="Port">{(id) => <input id={id} className="input" type="number" value={email.port} onChange={setE('port')} />}</Field>
                <Field label="Username">{(id) => <input id={id} className="input" autoComplete="off" value={email.user} onChange={setE('user')} />}</Field>
                <Field label="Password" hint={email.passwordSet ? 'Saved. Leave empty to keep it.' : 'For Gmail, an app password.'}>
                  {(id) => <input id={id} className="input" type="password" autoComplete="new-password" placeholder={email.passwordSet ? '••••••••' : ''} value={email.password} onChange={setE('password')} />}
                </Field>
                <Field label="From">{(id) => <input id={id} className="input" placeholder="alerts@yourcompany.com" value={email.from} onChange={setE('from')} />}</Field>
                <Field label="Send to" hint="Separate addresses with commas.">
                  {(id) => <input id={id} className="input" placeholder="you@yourcompany.com" value={email.to} onChange={setE('to')} />}
                </Field>
              </div>
              <div className="channel-foot">
                <label className="inline-check" htmlFor="smtp-secure">
                  <input id="smtp-secure" type="checkbox" checked={email.secure} onChange={(e) => setEmail((x) => ({ ...x, secure: e.target.checked }))} />
                  Use SSL from the start (port 465)
                </label>
                <Button variant="tinted" size="sm" busy={testing === 'email'} onClick={() => test('email')}>
                  Send Test Email
                </Button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="row row-stack">
        <Toggle id="notify-telegram" checked={telegram.enabled} onChange={(v) => setTelegram((x) => ({ ...x, enabled: v }))} label="Telegram" />
        <AnimatePresence initial={false}>
          {telegram.enabled && (
            <motion.div className="channel-fields" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.3, ease }}>
              <div className="channel-grid">
                <Field label="Bot token" hint={telegram.tokenSet ? 'Saved. Leave empty to keep it.' : 'From @BotFather, after /newbot.'}>
                  {(id) => <input id={id} className="input" type="password" autoComplete="off" placeholder={telegram.tokenSet ? '••••••••' : '123456789:AA…'} value={telegram.botToken} onChange={setT('botToken')} />}
                </Field>
                <Field label="Chat ID" hint="Add the bot to your group, send it a message, then read the chat id from api.telegram.org/bot<token>/getUpdates.">
                  {(id) => <input id={id} className="input" placeholder="-1001234567890" value={telegram.chatId} onChange={setT('chatId')} />}
                </Field>
              </div>
              <div className="channel-foot">
                <span />
                <Button variant="tinted" size="sm" busy={testing === 'telegram'} onClick={() => test('telegram')}>
                  Send Test Message
                </Button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="row channel-save">
        {error ? <p className="form-error">{error}</p> : <span className="field-hint">Alerts always appear under the bell in the app, with or without these.</span>}
        <Button type="submit" busy={busy}>
          Save
        </Button>
      </div>
    </form>
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
        <p className="row-label">Build a router and upload it in one step, from its folder</p>
        <div className="code-box">
          <pre>{'publish-to-hub.bat -Notes "what changed"'}</pre>
        </div>
        <p className="field-hint">
          Every router folder has its own <code>publish-to-hub.bat</code>, already tied to its client. Add <code>-SkipBuild</code> to upload the installer already in <code>dist</code>, or <code>-Platform mac-arm</code> / <code>mac-intel</code> for a Mac build.
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

          <Section index={2} icon={BellRing} tint="red" title="Alerts" description="Server alerts appear under the bell in the app. Add email or Telegram to be told even when Router Hub is closed.">
            <Notifications value={data.notifications} onSaved={(n) => (setData((d) => ({ ...d, notifications: n })), refresh())} />
          </Section>

          <Section index={3} icon={Terminal} tint="green" title="Publish script" description="Builds a router with the same steps as build.bat, then uploads the installer to the matching client.">
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
