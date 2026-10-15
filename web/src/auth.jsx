import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from './api.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [state, setState] = useState({ loading: true, user: null, app: null });

  const refresh = useCallback(async () => {
    const data = await api('/me');
    setState({ loading: false, user: data.user, app: data.app || null });
    return data.user;
  }, []);

  useEffect(() => {
    refresh().catch(() => setState({ loading: false, user: null, app: null }));
    const onSignedOut = () => setState((s) => ({ ...s, user: null }));
    window.addEventListener('rh:signed-out', onSignedOut);
    return () => window.removeEventListener('rh:signed-out', onSignedOut);
  }, [refresh]);

  const value = useMemo(
    () => ({
      ...state,
      isMaster: state.user?.role === 'master',
      refresh,
      async signIn(username, password) {
        await api('/auth/login', { method: 'POST', body: { username, password } });
        return refresh();
      },
      async signOut() {
        await api('/auth/logout', { method: 'POST' }).catch(() => {});
        setState((s) => ({ ...s, user: null }));
      },
    }),
    [state, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
