import { Bell, Check, CircleAlert, TriangleAlert } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { timeAgo } from '../format.js';
import { useToast } from './toast.jsx';

// Open alerts, polled so the bell stays current wherever you are in the app.
export function useOpenAlerts() {
  const [alerts, setAlerts] = useState([]);
  const load = useCallback(
    () =>
      api('/alerts')
        .then((d) => setAlerts(d.alerts))
        .catch(() => {}),
    [],
  );
  useEffect(() => {
    load();
    const timer = setInterval(() => document.visibilityState === 'visible' && load(), 30_000);
    const onChange = () => load();
    window.addEventListener('rh:alerts-changed', onChange);
    return () => {
      clearInterval(timer);
      window.removeEventListener('rh:alerts-changed', onChange);
    };
  }, [load]);
  return [alerts, load];
}

export function AlertRow({ alert, onAcknowledged, onNavigate }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const Icon = alert.level === 'critical' ? CircleAlert : TriangleAlert;

  async function acknowledge(e) {
    e.preventDefault();
    e.stopPropagation();
    setBusy(true);
    try {
      await api(`/alerts/${alert.id}/acknowledge`, { method: 'POST' });
      toast('Acknowledged');
      window.dispatchEvent(new Event('rh:alerts-changed'));
      onAcknowledged?.();
    } catch (err) {
      toast(err.message, 'error');
      setBusy(false);
    }
  }

  return (
    <li className={`alert-row is-${alert.level} ${alert.acknowledgedAt ? 'is-acknowledged' : ''}`}>
      <Link to={`/servers/${alert.serverId}`} className="alert-row-link" onClick={onNavigate}>
        <span className="alert-icon">
          <Icon size={17} strokeWidth={2.3} />
        </span>
        <span className="alert-text">
          <strong>{alert.serverName}</strong>
          <span>{alert.message}</span>
          <span className="alert-meta">
            {alert.level === 'critical' ? 'Critical' : 'Warning'} · since {timeAgo(alert.openedAt).replace(/ ago$/, ' ago')}
            {alert.acknowledgedAt ? ` · acknowledged by ${alert.acknowledgedBy}` : ''}
          </span>
        </span>
      </Link>
      {!alert.acknowledgedAt && (
        <button type="button" className="btn btn-plain btn-sm" onClick={acknowledge} disabled={busy}>
          <Check size={14} strokeWidth={2.6} />
          <span>Acknowledge</span>
        </button>
      )}
    </li>
  );
}

// The bell in the navbar: count of open alerts, the list one click away.
export function AlertsBell() {
  const [alerts] = useOpenAlerts();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const unacknowledged = alerts.filter((a) => !a.acknowledgedAt);
  const critical = unacknowledged.some((a) => a.level === 'critical');

  useEffect(() => {
    if (!open) return;
    const close = (e) => !ref.current?.contains(e.target) && setOpen(false);
    const onKey = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="bell" ref={ref}>
      <button
        type="button"
        className="bell-btn glass"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={alerts.length ? `${alerts.length} open alert${alerts.length === 1 ? '' : 's'}` : 'No open alerts'}
      >
        <motion.span key={unacknowledged.length} initial={{ rotate: unacknowledged.length ? -18 : 0 }} animate={{ rotate: 0 }} transition={{ type: 'spring', stiffness: 300, damping: 8 }}>
          <Bell size={18} strokeWidth={2.2} />
        </motion.span>
        <AnimatePresence>
          {unacknowledged.length > 0 && (
            <motion.span
              className={`bell-badge ${critical ? 'is-critical' : ''}`}
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              exit={{ scale: 0 }}
              transition={{ type: 'spring', stiffness: 500, damping: 22 }}
            >
              {unacknowledged.length}
            </motion.span>
          )}
        </AnimatePresence>
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            role="dialog"
            aria-label="Open alerts"
            className="menu glass bell-panel"
            initial={{ opacity: 0, scale: 0.88, y: -10, filter: 'blur(6px)' }}
            animate={{ opacity: 1, scale: 1, y: 0, filter: 'blur(0px)' }}
            exit={{ opacity: 0, scale: 0.94, transition: { duration: 0.14 } }}
            transition={{ type: 'spring', stiffness: 480, damping: 34 }}
          >
            <div className="bell-head">
              <strong>Alerts</strong>
              <span>{alerts.length ? `${alerts.length} open` : 'All clear'}</span>
            </div>
            {alerts.length ? (
              <ul className="alert-list-panel">
                {alerts.map((a) => (
                  <AlertRow key={a.id} alert={a} onNavigate={() => setOpen(false)} />
                ))}
              </ul>
            ) : (
              <p className="bell-empty">No open alerts. Storage, memory, CPU and reporting are all within limits.</p>
            )}
            <Link to="/servers" className="bell-foot" onClick={() => setOpen(false)}>
              Open Servers
            </Link>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
