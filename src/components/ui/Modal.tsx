import React, { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cx } from '../../core/utils/cx';
import { IconButton } from './Button';
import { uiPixels } from '../../core/appearance';

const modalStack: HTMLElement[] = [];
let appWasInert = false;

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
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = document.getElementById('root');
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!modalStack.length) appWasInert = root?.inert ?? false;
    modalStack.push(dialog);
    if (root) root.inert = true;
    const focusable = () => Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]'
    ) ?? []).filter((node) => node.getClientRects().length && !node.closest('[hidden], [inert]'));
    // Prefer the first field; dialogs with no fields start at their first action.
    const field = dialogRef.current?.querySelector<HTMLElement>('input:not(:disabled), select:not(:disabled), textarea:not(:disabled)');
    (field ?? focusable()[0] ?? dialogRef.current)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (modalStack[modalStack.length - 1] !== dialog || e.defaultPrevented) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeRef.current(); }
      if (e.key !== 'Tab') return;
      const nodes = focusable();
      const first = nodes[0]; const last = nodes[nodes.length - 1];
      if (!first) { e.preventDefault(); dialogRef.current?.focus(); }
      else if (e.shiftKey && (document.activeElement === first || !dialogRef.current?.contains(document.activeElement))) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !dialogRef.current?.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      const index = modalStack.indexOf(dialog);
      if (index >= 0) modalStack.splice(index, 1);
      if (root) root.inert = modalStack.length > 0 || appWasInert;
      if (previous?.isConnected && !previous.closest('[inert]')) previous.focus();
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-start justify-center pt-[12vh]">
      <div className="absolute inset-0 bg-black/45 kub-fade" onClick={onClose} />
      <div
        ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={title !== undefined ? titleId : undefined} aria-label={title === undefined ? "Dialog" : undefined} tabIndex={-1}
        style={{ width: uiPixels(width), maxWidth: 'calc(100vw - 24px)' }}
        className={cx(
          'relative max-h-[76vh] flex flex-col rounded-[calc(8px*var(--ui-factor))] border border-[var(--border-default)]',
          'bg-[var(--bg-overlay)] shadow-[var(--shadow-dialog)] kub-pop'
        )}
      >
        {title !== undefined && (
          <div className="flex items-center justify-between px-4 h-11 border-b border-[var(--border-subtle)] shrink-0">
            <span id={titleId} className="text-[length:calc(13px*var(--ui-factor))] font-semibold text-[var(--text-primary)] truncate">{title}</span>
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
