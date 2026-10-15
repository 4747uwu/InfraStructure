import { LogOut } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { Link, NavLink, useLocation, useOutlet } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { ease, Logo, spring } from './ui.jsx';

function Tab({ to, end, children }) {
  return (
    <NavLink to={to} end={end} className="tab">
      {({ isActive }) => (
        <>
          {isActive && <motion.span layoutId="tab-pill" className="tab-pill" transition={spring} />}
          <span className="tab-label">{children}</span>
        </>
      )}
    </NavLink>
  );
}

export default function Shell() {
  const { user, isMaster, signOut } = useAuth();
  const location = useLocation();
  const outlet = useOutlet();
  // Client pages count as "Clients" for the tab highlight.
  const onClients = location.pathname === '/' || location.pathname.startsWith('/clients');

  return (
    <div className="app">
      <header className="nav">
        <div className="nav-inner">
          <Link to="/" className="brand">
            <Logo size={28} />
            <span>Router Hub</span>
          </Link>

          <nav className="tabs" aria-label="Sections">
            <NavLink to="/" className="tab">
              {onClients && <motion.span layoutId="tab-pill" className="tab-pill" transition={spring} />}
              <span className="tab-label">Clients</span>
            </NavLink>
            {isMaster && <Tab to="/settings">Settings</Tab>}
          </nav>

          <div className="nav-right">
            <span className={`role role-${user.role}`} title={`Signed in as ${user.username}`}>
              {isMaster ? 'Master' : 'Helper'}
            </span>
            <button type="button" className="icon-btn" onClick={signOut} aria-label="Sign out" title="Sign out">
              <LogOut size={17} />
            </button>
          </div>
        </div>
      </header>

      <AnimatePresence mode="wait" initial={false}>
        <motion.main
          key={location.pathname}
          className="page"
          initial={{ opacity: 0, y: 14, filter: 'blur(6px)' }}
          animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
          exit={{ opacity: 0, y: -8, filter: 'blur(4px)', transition: { duration: 0.16 } }}
          transition={{ duration: 0.5, ease }}
        >
          {outlet}
        </motion.main>
      </AnimatePresence>
    </div>
  );
}
