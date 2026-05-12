import React, { createContext, useContext, useState, useCallback, useRef } from 'react';

const ToastContext = createContext(null);

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}

const MAX_TOASTS = 4;
const DURATIONS = { success: 3000, error: 6000, warning: 5000 };

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const idRef = useRef(0);

  const removeToast = useCallback((id) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const showToast = useCallback(({ type = 'success', message }) => {
    const id = ++idRef.current;
    setToasts(prev => {
      const next = [...prev, { id, type, message }];
      // Evict oldest if over max
      return next.length > MAX_TOASTS ? next.slice(next.length - MAX_TOASTS) : next;
    });
    setTimeout(() => removeToast(id), DURATIONS[type] || 3000);
    return id;
  }, [removeToast]);

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <ToastContainer toasts={toasts} onDismiss={removeToast} />
    </ToastContext.Provider>
  );
}

// ─── Toast Container ────────────────────────────────────────────────

const COLORS = {
  success: { bg: '#064e3b', border: '#059669', text: '#a7f3d0' },
  error:   { bg: '#450a0a', border: '#dc2626', text: '#fca5a5' },
  warning: { bg: '#451a03', border: '#d97706', text: '#fde68a' },
};

function ToastContainer({ toasts, onDismiss }) {
  if (toasts.length === 0) return null;

  return (
    <div style={{
      position: 'fixed',
      bottom: 16,
      right: 16,
      zIndex: 9999,
      display: 'flex',
      flexDirection: 'column-reverse',
      gap: 8,
      pointerEvents: 'none',
    }}>
      {toasts.map(toast => (
        <Toast key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function Toast({ toast, onDismiss }) {
  const colors = COLORS[toast.type] || COLORS.success;

  return (
    <div style={{
      pointerEvents: 'auto',
      padding: '10px 14px',
      borderRadius: 8,
      background: colors.bg,
      border: `1px solid ${colors.border}`,
      color: colors.text,
      fontSize: '12px',
      fontFamily: 'var(--font-mono)',
      maxWidth: 360,
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
      animation: 'toastIn 0.2s ease-out',
    }}>
      <span style={{ flex: 1 }}>{toast.message}</span>
      <button
        onClick={() => onDismiss(toast.id)}
        title="Dismiss notification"
        style={{
          padding: 2,
          color: colors.text,
          opacity: 0.6,
          fontSize: '14px',
          lineHeight: 1,
          flexShrink: 0,
        }}
      >
        ×
      </button>
    </div>
  );
}
