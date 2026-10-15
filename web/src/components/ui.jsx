import { ArrowDownToLine, Check, Ellipsis, Link as LinkIcon, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { copyText } from '../api.js';
import { gradientFor, initials } from '../format.js';
import { useToast } from './toast.jsx';

export const spring = { type: 'spring', stiffness: 380, damping: 32 };
export const softSpring = { type: 'spring', stiffness: 220, damping: 28 };
export const ease = [0.22, 1, 0.36, 1];

export function Logo({ size = 32 }) {
  return (
    <span className="logo" style={{ width: size, height: size, borderRadius: size * 0.235 }} aria-hidden="true">
      <ArrowDownToLine size={size * 0.56} strokeWidth={2.4} />
    </span>
  );
}

export function Avatar({ name, size = 48 }) {
  const [from, to] = gradientFor(name);
  return (
    <span
      className="avatar"
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.38,
        borderRadius: size * 0.27,
        background: `linear-gradient(140deg, ${from}, ${to})`,
      }}
    >
      {initials(name)}
    </span>
  );
}

export function Spinner({ size = 16 }) {
  return <span className="spinner" style={{ width: size, height: size }} aria-hidden="true" />;
}

export function Button({ variant = 'primary', size, busy = false, icon: Icon, children, className = '', ...props }) {
  return (
    <motion.button
      type="button"
      whileTap={{ scale: 0.96 }}
      transition={spring}
      {...props}
      className={`btn btn-${variant} ${size ? `btn-${size}` : ''} ${className}`}
      disabled={busy || props.disabled}
    >
      {busy ? <Spinner /> : Icon && <Icon size={size === 'sm' ? 14 : 16} strokeWidth={2.2} />}
      {children && <span>{children}</span>}
    </motion.button>
  );
}

export function CopyButton({ text, label = 'Copy link', message = 'Link copied', variant = 'primary', size, icon: Icon = LinkIcon }) {
  const [done, setDone] = useState(false);
  const toast = useToast();
  const timer = useRef();
  useEffect(() => () => clearTimeout(timer.current), []);

  async function onClick(e) {
    e.preventDefault();
    e.stopPropagation();
    if (await copyText(text)) {
      setDone(true);
      toast(message);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setDone(false), 1600);
    } else {
      toast('Could not copy. Copy the link from the address bar instead.', 'error');
    }
  }

  const iconSize = size === 'sm' ? 14 : 16;
  return (
    <motion.button
      type="button"
      whileTap={{ scale: 0.96 }}
      transition={spring}
      className={`btn btn-${variant} ${size ? `btn-${size}` : ''}`}
      onClick={onClick}
      aria-label={label || message}
    >
      <span className="swap" style={{ width: iconSize, height: iconSize }}>
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={done ? 'done' : 'idle'}
            initial={{ scale: 0.3, opacity: 0, rotate: -30 }}
            animate={{ scale: 1, opacity: 1, rotate: 0 }}
            exit={{ scale: 0.3, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 600, damping: 30 }}
          >
            {done ? <Check size={iconSize} strokeWidth={3} /> : <Icon size={iconSize} strokeWidth={2.2} />}
          </motion.span>
        </AnimatePresence>
      </span>
      {label && <span>{done ? 'Copied' : label}</span>}
    </motion.button>
  );
}

export function Field({ label, hint, error, children }) {
  const id = useId();
  return (
    <div className={`field ${error ? 'has-error' : ''}`}>
      <label htmlFor={id}>{label}</label>
      {children(id)}
      {(error || hint) && <p className="field-hint">{error || hint}</p>}
    </div>
  );
}

export function Sheet({ open, onClose, title, subtitle, children, width = 440 }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className="sheet-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          onMouseDown={(e) => e.target === e.currentTarget && onClose()}
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label={title}
            className="sheet"
            style={{ maxWidth: width }}
            initial={{ opacity: 0, y: 48, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 28, scale: 0.97 }}
            transition={spring}
          >
            <div className="sheet-head">
              <div>
                <h2>{title}</h2>
                {subtitle && <p>{subtitle}</p>}
              </div>
              <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
                <X size={18} />
              </button>
            </div>
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

// items: { label, icon, onSelect, danger } | 'separator' | falsy (skipped)
export function Menu({ items, label = 'More actions' }) {
  const [open, setOpen] = useState(false);
  const [upward, setUpward] = useState(false);
  const ref = useRef(null);

  function toggle() {
    if (!open) {
      // Open upward when the list would run off the bottom of the window.
      const rect = ref.current.getBoundingClientRect();
      const needed = items.filter(Boolean).length * 38 + 24;
      setUpward(window.innerHeight - rect.bottom < needed && rect.top > needed);
    }
    setOpen((o) => !o);
  }

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => !ref.current?.contains(e.target) && setOpen(false);
    const onKey = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const visible = items.filter(Boolean);
  return (
    <div className="menu-wrap" ref={ref}>
      <button type="button" className="icon-btn" aria-haspopup="menu" aria-expanded={open} aria-label={label} onClick={toggle}>
        <Ellipsis size={18} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            role="menu"
            className={`menu ${upward ? 'menu-up' : ''}`}
            initial={{ opacity: 0, scale: 0.86, y: upward ? 8 : -8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.94, transition: { duration: 0.12 } }}
            transition={{ type: 'spring', stiffness: 560, damping: 34 }}
          >
            {visible.map((item, i) =>
              item === 'separator' ? (
                <div key={i} className="menu-sep" />
              ) : (
                <button
                  key={item.label}
                  type="button"
                  role="menuitem"
                  className={`menu-item ${item.danger ? 'danger' : ''}`}
                  onClick={() => {
                    setOpen(false);
                    item.onSelect();
                  }}
                >
                  <span>{item.label}</span>
                  {item.icon && <item.icon size={16} strokeWidth={2} />}
                </button>
              ),
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function Banner({ icon: Icon, tone = 'info', children }) {
  return (
    <motion.div className={`banner banner-${tone}`} initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, ease }}>
      {Icon && <Icon size={18} strokeWidth={2.2} />}
      <div>{children}</div>
    </motion.div>
  );
}

// Slow drifting colour behind the sign-in and download pages.
export function Aurora() {
  return (
    <div className="aurora" aria-hidden="true">
      <span className="aurora-blob a" />
      <span className="aurora-blob b" />
      <span className="aurora-blob c" />
    </div>
  );
}

// Animated tick, drawn stroke by stroke.
export function SuccessMark({ size = 64 }) {
  return (
    <motion.span
      className="success-mark"
      style={{ width: size, height: size }}
      initial={{ scale: 0.4, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ type: 'spring', stiffness: 320, damping: 20 }}
    >
      <svg viewBox="0 0 24 24" width={size * 0.5} height={size * 0.5} fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
        <motion.path d="M5 12.5l4.5 4.5L19 7.5" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.45, delay: 0.18, ease }} />
      </svg>
    </motion.span>
  );
}
