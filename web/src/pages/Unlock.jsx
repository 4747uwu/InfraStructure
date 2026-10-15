import { ArrowDownToLine, Lock, LockOpen } from 'lucide-react';
import { AnimatePresence, motion, useAnimationControls } from 'motion/react';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api.js';
import { AppIcon, Aurora, Button, ease, softSpring, Spinner, SuccessMark } from '../components/ui.jsx';
import { fileKind, formatBytes } from '../format.js';
import { PlatformIcon, platformById } from '../platforms.jsx';

const swap = {
  initial: { opacity: 0, y: 12, filter: 'blur(6px)' },
  animate: { opacity: 1, y: 0, filter: 'blur(0px)' },
  exit: { opacity: 0, y: -10, filter: 'blur(6px)', transition: { duration: 0.18 } },
  transition: { duration: 0.45, ease },
};

function Notice({ title, children }) {
  return (
    <motion.div key={title} className="unlock-notice" {...swap}>
      <span className="unlock-lock">
        <Lock size={26} strokeWidth={2} />
      </span>
      <h1>{title}</h1>
      <p>{children}</p>
    </motion.div>
  );
}

// The page behind a helper link. Reachable by anyone holding the link; the
// password set by the master is what releases the file.
export default function Unlock() {
  const { token } = useParams();
  const [info, setInfo] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [downloadUrl, setDownloadUrl] = useState('');
  const shake = useAnimationControls();

  useEffect(() => {
    api(`/public/link/${token}`)
      .then((data) => {
        setInfo(data);
        document.title = `${data.clientName} · Download`;
      })
      .catch(setLoadError);
  }, [token]);

  async function onSubmit(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const { url } = await api(`/public/unlock/${token}`, { method: 'POST', body: { password } });
      setDownloadUrl(url);
      // The response is an attachment, so this starts the download and leaves the page in place.
      window.location.href = url;
    } catch (err) {
      setError(err.message);
      setBusy(false);
      shake.start({ x: [0, -12, 11, -8, 6, -3, 0], transition: { duration: 0.45 } });
    }
  }

  const release = info?.release;
  return (
    <div className="stage">
      <Aurora />
      <motion.div animate={shake} className="stage-inner">
        <motion.div className="glass-card unlock" initial={{ opacity: 0, y: 28, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={softSpring}>
          <AnimatePresence mode="wait" initial={false}>
            {!info && !loadError && (
              <motion.div key="loading" className="unlock-loading" {...swap}>
                <Spinner size={26} />
              </motion.div>
            )}

            {loadError && (
              <Notice key="invalid" title={loadError.status === 404 ? 'This link is not valid' : 'Something went wrong'}>
                {loadError.status === 404 ? 'It may have been replaced. Ask the person who sent it for a new one.' : loadError.message}
              </Notice>
            )}

            {info && !release && (
              <Notice key="withdrawn" title="No longer available">
                This version of {info.clientName} has been withdrawn. Ask for an up-to-date link.
              </Notice>
            )}

            {info && release && !info.passwordSet && (
              <Notice key="closed" title="Not open yet">
                Downloads for {info.clientName} have not been opened yet. Ask the person who sent this link.
              </Notice>
            )}

            {info && release && info.passwordSet && !downloadUrl && (
              <motion.form key="form" onSubmit={onSubmit} {...swap}>
                <AppIcon name={info.clientName} size={84} />
                <h1>{info.clientName}</h1>
                <p className="unlock-version">Version {release.version}</p>
                <p className="unlock-platform">
                  <PlatformIcon id={info.platform} size={14} />
                  {platformById(info.platform).long}
                </p>
                <p className="unlock-file">
                  {fileKind(release.fileName)} · {formatBytes(release.size)}
                </p>

                <div className="unlock-field">
                  <Lock size={16} strokeWidth={2.2} />
                  <input
                    id="unlock-password"
                    className="input"
                    type="password"
                    placeholder="Download password"
                    aria-label="Download password"
                    autoComplete="off"
                    autoFocus
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </div>

                <motion.p className="form-error" role="alert" initial={false} animate={{ opacity: error ? 1 : 0, height: error ? 'auto' : 0 }} transition={{ duration: 0.25, ease }}>
                  {error}
                </motion.p>

                <Button type="submit" size="lg" className="btn-block" icon={LockOpen} busy={busy} disabled={!password}>
                  Unlock and Download
                </Button>
                <p className="unlock-foot">{release.fileName}</p>
              </motion.form>
            )}

            {downloadUrl && (
              <motion.div key="done" className="unlock-done" {...swap}>
                <SuccessMark size={76} />
                <h1>Your download has started</h1>
                <p>
                  {release.fileName} · {formatBytes(release.size)}
                </p>
                <a className="btn btn-tinted btn-lg" href={downloadUrl}>
                  <ArrowDownToLine size={16} strokeWidth={2.2} />
                  <span>Download Again</span>
                </a>
                <p className="unlock-foot">Open the file when it finishes to install {info.clientName}.</p>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      </motion.div>
    </div>
  );
}
