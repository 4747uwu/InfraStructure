import { Activity, ChevronDown, Hammer, LayoutGrid, LogOut, Settings as SettingsIcon, SquareKanban } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, useLocation, useOutlet } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { setStorageThreshold } from './charts.jsx';
import { AlertsBell } from './Alerts.jsx';
import { ease, Logo, spring } from './ui.jsx';

function Tab({ to, icon: Icon, active, children }) {
  return (
    <NavLink to={to} className={`tab ${active ? 'is-active' : ''}`} aria-current={active ? 'page' : undefined}>
      {active && <motion.span layoutId="tab-lens" className="tab-lens" transition={spring} />}
      <span className="tab-label">
        <Icon size={17} strokeWidth={2.2} />
        <span>{children}</span>
      </span>
    </NavLink>
  );
}

function Account() {
  const { user, isMaster, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const close = (e) => !ref.current?.contains(e.target) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  return (
    <div className="account" ref={ref}>
      <button type="button" className="account-btn glass" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="menu">
        <span className={`account-dot ${isMaster ? 'is-master' : ''}`}>{user.username[0].toUpperCase()}</span>
        <span className="account-role">{isMaster ? 'Master' : 'Helper'}</span>
        <ChevronDown size={14} strokeWidth={2.6} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            role="menu"
            className="menu glass account-menu"
            initial={{ opacity: 0, scale: 0.85, y: -10, filter: 'blur(6px)' }}
            animate={{ opacity: 1, scale: 1, y: 0, filter: 'blur(0px)' }}
            exit={{ opacity: 0, scale: 0.92, transition: { duration: 0.14 } }}
            transition={{ type: 'spring', stiffness: 520, damping: 32 }}
          >
            <div className="menu-caption">
              Signed in as <strong>{user.username}</strong>
              <span>{isMaster ? 'Full access. Copied links need no password.' : 'View and board. Copied links ask for the password.'}</span>
            </div>
            <div className="menu-sep" />
            <button type="button" role="menuitem" className="menu-item" onClick={signOut}>
              <span>Sign Out</span>
              <LogOut size={17} strokeWidth={2} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function Shell() {
  const { isMaster, app } = useAuth();
  // Keep the charts' storage colouring in step with the alert threshold set in Settings.
  // Set during render so the very first paint of any chart already uses it.
  setStorageThreshold(app?.storageThreshold);
  const location = useLocation();
  const outlet = useOutlet();
  const path = location.pathname;
  const section = path.startsWith('/board') ? 'board' : path.startsWith('/settings') ? 'settings' : path.startsWith('/servers') ? 'servers' : path.startsWith('/build') ? 'build' : 'clients';

  return (
    <div className="app">
      <div className="ambient" aria-hidden="true" />
      <div className="scroll-edge" aria-hidden="true" />

      <header className="nav">
        <Link to="/" className="brand">
          <Logo size={34} />
          <span>Router Hub</span>
        </Link>

        <nav className="tabbar glass" aria-label="Sections">
          <Tab to="/" icon={LayoutGrid} active={section === 'clients'}>
            Clients
          </Tab>
          <Tab to="/servers" icon={Activity} active={section === 'servers'}>
            Servers
          </Tab>
          <Tab to="/board" icon={SquareKanban} active={section === 'board'}>
            Board
          </Tab>
          {isMaster && (
            <Tab to="/build" icon={Hammer} active={section === 'build'}>
              Build
            </Tab>
          )}
          {isMaster && (
            <Tab to="/settings" icon={SettingsIcon} active={section === 'settings'}>
              Settings
            </Tab>
          )}
        </nav>

        <div className="nav-right">
          <AlertsBell />
          <Account />
        </div>
      </header>

      <AnimatePresence mode="wait" initial={false}>
        <motion.main
          key={path}
          className={`page page-${section}`}
          initial={{ opacity: 0, y: 18, scale: 0.985, filter: 'blur(8px)' }}
          animate={{ opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }}
          exit={{ opacity: 0, y: -10, scale: 0.99, filter: 'blur(6px)', transition: { duration: 0.16 } }}
          transition={{ duration: 0.55, ease }}
        >
          {outlet}
        </motion.main>
      </AnimatePresence>
    </div>
  );
}
