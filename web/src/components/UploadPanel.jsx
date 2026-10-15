import { CloudUpload, FileDown, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { uploadRelease } from '../api.js';
import { useAuth } from '../auth.jsx';
import { formatBytes, guessVersion } from '../format.js';
import { guessPlatform, PlatformIcon, PLATFORMS, platformById } from '../platforms.jsx';
import { Button, ease, Field, Segmented, SuccessMark } from './ui.jsx';

const ACCEPT = ['.exe', '.msi', '.zip', '.7z', '.dmg', '.pkg'];
const swap = {
  initial: { opacity: 0, y: 12, filter: 'blur(6px)' },
  animate: { opacity: 1, y: 0, filter: 'blur(0px)' },
  exit: { opacity: 0, y: -8, filter: 'blur(4px)', transition: { duration: 0.14 } },
  transition: { duration: 0.4, ease },
};

export default function UploadPanel({ client, platform: defaultPlatform, onUploaded }) {
  const { app } = useAuth();
  const [phase, setPhase] = useState('idle'); // idle | ready | uploading | done
  const [file, setFile] = useState(null);
  const [version, setVersion] = useState('');
  const [platform, setPlatform] = useState(defaultPlatform);
  const [notes, setNotes] = useState('');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const [done, setDone] = useState(null);
  const picker = useRef(null);
  const active = useRef(null);
  const dragDepth = useRef(0);

  // Follow the platform the page is showing until a file has been picked.
  useEffect(() => {
    if (phase === 'idle') setPlatform(defaultPlatform);
  }, [defaultPlatform, phase]);

  function choose(candidate) {
    if (!candidate) return;
    const ext = `.${candidate.name.toLowerCase().split('.').pop()}`;
    if (!ACCEPT.includes(ext)) {
      setError(`“${candidate.name}” is not an installer. Use ${ACCEPT.join(', ')}.`);
      return;
    }
    if (app?.maxUploadBytes && candidate.size > app.maxUploadBytes) {
      setError(`This file is ${formatBytes(candidate.size)}. The limit is ${formatBytes(app.maxUploadBytes)}.`);
      return;
    }
    setError('');
    setFile(candidate);
    setVersion(guessVersion(candidate.name));
    // A Mac-looking file name wins; otherwise keep the platform the page is showing.
    const guessed = guessPlatform(candidate.name);
    setPlatform(guessed !== 'windows' ? guessed : defaultPlatform);
    setNotes('');
    setPhase('ready');
  }

  function reset() {
    setFile(null);
    setError('');
    setProgress(0);
    setPlatform(defaultPlatform);
    setPhase('idle');
  }

  async function start(e) {
    e.preventDefault();
    setError('');
    setProgress(0);
    setPhase('uploading');
    const upload = uploadRelease({
      client: client.id,
      version: version.trim(),
      notes: notes.trim(),
      platform,
      file,
      onProgress: (loaded, total) => setProgress(loaded / total),
    });
    active.current = upload;
    try {
      const { release } = await upload.promise;
      setDone(release);
      setPhase('done');
      onUploaded(release);
    } catch (err) {
      setPhase('ready');
      if (err.status !== -1) setError(err.message);
    }
  }

  const drop = {
    onDragEnter: (e) => {
      e.preventDefault();
      dragDepth.current += 1;
      setDragging(true);
    },
    onDragOver: (e) => e.preventDefault(),
    onDragLeave: () => {
      dragDepth.current -= 1;
      if (dragDepth.current <= 0) setDragging(false);
    },
    onDrop: (e) => {
      e.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      if (phase !== 'uploading') choose(e.dataTransfer.files?.[0]);
    },
  };

  return (
    <motion.section
      className={`dropzone ${dragging ? 'is-dragging' : ''} is-${phase}`}
      animate={{ scale: dragging ? 1.015 : 1 }}
      transition={{ type: 'spring', stiffness: 420, damping: 26 }}
      aria-label="Add a build"
      {...drop}
    >
      <input
        ref={picker}
        id="release-file"
        type="file"
        accept={ACCEPT.join(',')}
        hidden
        onChange={(e) => {
          choose(e.target.files?.[0]);
          e.target.value = '';
        }}
      />

      <AnimatePresence mode="wait" initial={false}>
        {phase === 'idle' && (
          <motion.div key="idle" className="drop-idle" {...swap}>
            <motion.span className="drop-icon" animate={{ y: dragging ? -8 : 0, scale: dragging ? 1.1 : 1 }} transition={{ type: 'spring', stiffness: 300, damping: 14 }}>
              <CloudUpload size={28} strokeWidth={1.9} />
            </motion.span>
            <div>
              <h3>{dragging ? 'Drop to add this build' : 'Add a build'}</h3>
              <p>
                Drag the installer from <code>dist</code> here, or{' '}
                <button type="button" className="link" onClick={() => picker.current.click()}>
                  choose a file
                </button>
                .
              </p>
            </div>
          </motion.div>
        )}

        {phase === 'ready' && (
          <motion.form key="ready" className="drop-form" onSubmit={start} {...swap}>
            <div className="file-chip">
              <span className="file-chip-icon">
                <FileDown size={20} strokeWidth={2} />
              </span>
              <div className="file-chip-text">
                <strong>{file.name}</strong>
                <span>{formatBytes(file.size)}</span>
              </div>
              <button type="button" className="icon-btn" onClick={reset} aria-label="Remove file">
                <X size={17} strokeWidth={2.4} />
              </button>
            </div>
            <div className="field">
              <span className="field-label">Platform</span>
              <Segmented
                label="Platform"
                value={platform}
                onChange={setPlatform}
                options={PLATFORMS.map((p) => ({ id: p.id, label: p.label, icon: <PlatformIcon id={p.id} size={14} /> }))}
              />
            </div>
            <div className="drop-fields">
              <Field label="Version">
                {(id) => <input id={id} className="input" placeholder="0.1.2" value={version} onChange={(e) => setVersion(e.target.value)} maxLength={40} autoFocus />}
              </Field>
              <Field label="What changed">
                {(id) => <input id={id} className="input" placeholder="Optional" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} />}
              </Field>
            </div>
            <div className="drop-actions">
              <Button type="submit" icon={CloudUpload} disabled={!version.trim()}>
                Upload for {platformById(platform).label}
              </Button>
            </div>
          </motion.form>
        )}

        {phase === 'uploading' && (
          <motion.div key="uploading" className="drop-progress" {...swap}>
            <div className="progress-head">
              <strong>Uploading {file.name}</strong>
              <span className="progress-pct">{Math.round(progress * 100)}%</span>
            </div>
            <div className="progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
              <motion.div className="progress-fill" animate={{ width: `${Math.max(progress * 100, 1.5)}%` }} transition={{ type: 'spring', stiffness: 120, damping: 24 }} />
            </div>
            <div className="progress-foot">
              <span>{progress >= 1 ? 'Verifying and storing…' : `${formatBytes(progress * file.size)} of ${formatBytes(file.size)}`}</span>
              <button type="button" className="link" onClick={() => active.current?.cancel()}>
                Cancel
              </button>
            </div>
          </motion.div>
        )}

        {phase === 'done' && (
          <motion.div key="done" className="drop-idle" {...swap}>
            <SuccessMark size={56} />
            <div>
              <h3>
                {done.version} is now current for {platformById(done.platform).label}
              </h3>
              <p>
                Its always-latest link already serves it.{' '}
                <button type="button" className="link" onClick={reset}>
                  Add another
                </button>
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {error && (
          <motion.p className="drop-error" role="alert" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}>
            {error}
          </motion.p>
        )}
      </AnimatePresence>
    </motion.section>
  );
}
