import { Check, CircleAlert } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { createContext, useCallback, useContext, useRef, useState } from 'react';

const ToastContext = createContext(() => {});

// One pill at a time, dropping in from the top - a newer message replaces the current one.
export function ToastProvider({ children }) {
  const [toast, setToast] = useState(null);
  const timer = useRef();

  const show = useCallback((message, tone = 'success') => {
    clearTimeout(timer.current);
    setToast({ id: Date.now(), message, tone });
    timer.current = setTimeout(() => setToast(null), tone === 'error' ? 4200 : 2200);
  }, []);

  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="toast-layer" aria-live="polite">
        <AnimatePresence mode="popLayout">
          {toast && (
            <motion.div
              key={toast.id}
              className="toast"
              initial={{ opacity: 0, y: -28, scale: 0.86 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -18, scale: 0.94 }}
              transition={{ type: 'spring', stiffness: 520, damping: 34 }}
            >
              <span className={`toast-icon ${toast.tone}`}>
                {toast.tone === 'error' ? <CircleAlert size={15} strokeWidth={2.6} /> : <Check size={15} strokeWidth={3} />}
              </span>
              {toast.message}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
