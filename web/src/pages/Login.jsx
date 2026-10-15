import { motion, useAnimationControls } from 'motion/react';
import { useState } from 'react';
import { useAuth } from '../auth.jsx';
import { Aurora, Button, ease, Logo, softSpring } from '../components/ui.jsx';

export default function Login() {
  const { signIn } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const shake = useAnimationControls();

  async function onSubmit(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await signIn(username.trim(), password);
    } catch (err) {
      setError(err.message);
      setBusy(false);
      shake.start({ x: [0, -12, 11, -8, 6, -3, 0], transition: { duration: 0.45 } });
    }
  }

  return (
    <div className="stage">
      <Aurora />
      <motion.div animate={shake} className="stage-inner">
        <motion.form
          className="glass-card login"
          onSubmit={onSubmit}
          initial={{ opacity: 0, y: 28, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={softSpring}
        >
          <motion.div initial={{ scale: 0.5, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: 'spring', stiffness: 260, damping: 18, delay: 0.1 }}>
            <Logo size={68} />
          </motion.div>
          <h1>Router Hub</h1>
          <p className="login-sub">Sign in to store and share router installers.</p>

          <div className="input-stack">
            <input
              id="login-username"
              className="input"
              placeholder="Username"
              aria-label="Username"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck="false"
              autoFocus
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
            <input
              id="login-password"
              className="input"
              type="password"
              placeholder="Password"
              aria-label="Password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          <motion.p
            className="form-error"
            role="alert"
            initial={false}
            animate={{ opacity: error ? 1 : 0, height: error ? 'auto' : 0 }}
            transition={{ duration: 0.25, ease }}
          >
            {error}
          </motion.p>

          <Button type="submit" size="lg" className="btn-block" busy={busy} disabled={!username.trim() || !password}>
            Sign In
          </Button>
        </motion.form>
      </motion.div>
    </div>
  );
}
