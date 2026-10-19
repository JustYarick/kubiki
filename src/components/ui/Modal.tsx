import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cx } from '../../core/utils/cx';
import { IconButton } from './Button';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  width?: number;
  children: React.ReactNode;
  footer?: React.ReactNode;
  padded?: boolean;
}

export function Modal({ open, onClose, title, width = 480, children, footer, padded = true }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-start justify-center pt-[12vh]" role="dialog" aria-modal>
      <div className="absolute inset-0 bg-black/45 kub-fade" onClick={onClose} />
      <div
        style={{ width }}
        className={cx(
          'relative max-h-[76vh] flex flex-col rounded-[8px] border border-[var(--border-default)]',
          'bg-[var(--bg-overlay)] shadow-[var(--shadow-dialog)] kub-pop'
        )}
      >
        {title !== undefined && (
          <div className="flex items-center justify-between px-4 h-11 border-b border-[var(--border-subtle)] shrink-0">
            <span className="text-[13px] font-semibold text-[var(--text-primary)] truncate">{title}</span>
            <IconButton icon={X} onClick={onClose} aria-label="Close" />
          </div>
        )}
        <div className={cx('flex-1 overflow-y-auto kubiki-scrollbar', padded && 'p-4')}>{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-[var(--border-subtle)] shrink-0">{footer}</div>}
      </div>
    </div>,
    document.body
  );
}
