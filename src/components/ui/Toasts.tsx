import React from 'react';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { createPortal } from 'react-dom';
import { useNotifications, type ToastType } from '../../state/notifications_store';
import { cx } from '../../core/utils/cx';

const icons: Record<ToastType, React.ReactNode> = {
  info: <Info size="calc(15px * var(--ui-factor))" className="text-[var(--status-info)]" />,
  success: <CheckCircle2 size="calc(15px * var(--ui-factor))" className="text-[var(--status-ok)]" />,
  warn: <AlertTriangle size="calc(15px * var(--ui-factor))" className="text-[var(--status-warn)]" />,
  error: <XCircle size="calc(15px * var(--ui-factor))" className="text-[var(--status-danger)]" />,
};

export function Toasts() {
  const { toasts, dismiss } = useNotifications();
  if (toasts.length === 0) return null;
  return createPortal(
    <div className="fixed bottom-9 right-4 z-[95] flex flex-col gap-2 w-[calc(340px*var(--ui-factor))]">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cx(
            'flex items-start gap-2.5 rounded-[calc(6px*var(--ui-factor))] border bg-[var(--bg-overlay)] px-3 py-2.5 shadow-[var(--shadow-popup)] kub-toast',
            t.type === 'error' ? 'border-[var(--status-danger)]/50' : 'border-[var(--border-default)]'
          )}
        >
          <span className="mt-0.5">{icons[t.type]}</span>
          <div className="flex-1 min-w-0">
            <div className="text-xs font-medium text-[var(--text-primary)]">{t.title}</div>
            {t.description && <div className="text-[length:calc(11px*var(--ui-factor))] text-[var(--text-secondary)] mt-0.5 break-words">{t.description}</div>}
          </div>
          <button onClick={() => dismiss(t.id)} className="text-[var(--text-muted)] hover:text-[var(--text-primary)] mt-0.5">
            <X size="calc(13px * var(--ui-factor))" />
          </button>
        </div>
      ))}
    </div>,
    document.body
  );
}
