import { CloudUpload, FileDown, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useRef, useState } from 'react';
import { uploadRelease } from '../api.js';
import { useAuth } from '../auth.jsx';
import { formatBytes, guessVersion } from '../format.js';
import { Button, ease, Field, SuccessMark } from './ui.jsx';

const ACCEPT = ['.exe', '.msi', '.zip', '.7z', '.dmg', '.pkg'];
const swap = {
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -8, transition: { duration: 0.14 } },
  transition: { duration: 0.35, ease },
};

export default function UploadPanel({ client, onUploaded }) {
  const { app } = useAuth();
  const [phase, setPhase] = useState('idle'); // idle | ready | uploading | done
  const [file, setFile] = useState(null);
  const [version, setVersion] = useState('');
  const [notes, setNotes] = useState('');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const [doneVersion, setDoneVersion] = useState('');
  const picker = useRef(null);
  const active = useRef(null);
  const dragDepth = useRef(0);

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
    setNotes('');
    setPhase('ready');
  }

  function reset() {
    setFile(null);
    setError('');
    setProgress(0);
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
      file,
      onProgress: (loaded, total) => setProgress(loaded / total),
    });
    active.current = upload;
    try {
      const { release } = await upload.promise;
      setDoneVersion(release.version);
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
      animate={{ scale: dragging ? 1.012 : 1 }}
      transition={{ type: 'spring', stiffness: 420, damping: 26 }}
      aria-label="Add a version"
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
            <motion.span className="drop-icon" animate={{ y: dragging ? -6 : 0 }} transition={{ type: 'spring', stiffness: 300, damping: 14 }}>
              <CloudUpload size={30} strokeWidth={1.7} />
            </motion.span>
            <h3>{dragging ? 'Drop to add this version' : 'Add a version'}</h3>
            <p>
              Drag the installer from the <code>dist</code> folder here, or{' '}
              <button type="button" className="link" onClick={() => picker.current.click()}>
                choose a file
              </button>
              .
            </p>
          </motion.div>
        )}

        {phase === 'ready' && (
          <motion.form key="ready" className="drop-form" onSubmit={start} {...swap}>
            <div className="file-chip">
              <span className="file-chip-icon">
                <FileDown size={20} strokeWidth={1.9} />
              </span>
              <div className="file-chip-text">
                <strong>{file.name}</strong>
                <span>{formatBytes(file.size)}</span>
              </div>
              <button type="button" className="icon-btn" onClick={reset} aria-label="Remove file">
                <X size={16} />
              </button>
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
                Upload to {client.name}
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
              <span>
                {progress >= 1 ? 'Verifying and storing…' : `${formatBytes(progress * file.size)} of ${formatBytes(file.size)}`}
              </span>
              <button type="button" className="link" onClick={() => active.current?.cancel()}>
                Cancel
              </button>
            </div>
          </motion.div>
        )}

        {phase === 'done' && (
          <motion.div key="done" className="drop-idle" {...swap}>
            <SuccessMark size={56} />
            <h3>Version {doneVersion} is now current</h3>
            <p>
              The client’s link already points to it.{' '}
              <button type="button" className="link" onClick={reset}>
                Add another
              </button>
            </p>
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
