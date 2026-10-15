import { MotionConfig } from 'motion/react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth.jsx';
import Shell from './components/Shell.jsx';
import { ToastProvider } from './components/toast.jsx';
import { Logo } from './components/ui.jsx';
import ClientDetail from './pages/ClientDetail.jsx';
import Clients from './pages/Clients.jsx';
import Login from './pages/Login.jsx';
import Settings from './pages/Settings.jsx';
import Unlock from './pages/Unlock.jsx';

function Workspace() {
  const { loading, user, isMaster } = useAuth();

  if (loading) {
    return (
      <div className="splash">
        <Logo size={56} />
      </div>
    );
  }

  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to="/" replace /> : <Login />} />
      <Route element={user ? <Shell /> : <Navigate to="/login" replace />}>
        <Route index element={<Clients />} />
        <Route path="clients/:slug" element={<ClientDetail />} />
        <Route path="settings" element={isMaster ? <Settings /> : <Navigate to="/" replace />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <MotionConfig reducedMotion="user">
      <ToastProvider>
        <BrowserRouter>
          <Routes>
            {/* Public download page: no session, no app chrome. */}
            <Route path="/get/:token" element={<Unlock />} />
            <Route
              path="/*"
              element={
                <AuthProvider>
                  <Workspace />
                </AuthProvider>
              }
            />
          </Routes>
        </BrowserRouter>
      </ToastProvider>
    </MotionConfig>
  );
}
