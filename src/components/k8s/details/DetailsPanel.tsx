import { useEffect, useId, useRef, type ReactNode } from 'react';
import { ResourceHeader, type ResourceHeaderProps } from './ResourceHeader';
import './details.css';

export type DetailsPanelProps = Omit<ResourceHeaderProps, 'tabPrefix'> & {
  children: ReactNode;
  footer?: ReactNode;
  busy?: boolean;
  busyLabel?: string;
};

/** One details shell for inspectors, workspace tabs and split panes. */
export function DetailsPanel({ children, footer, onClose, busy = false, busyLabel = 'Refreshing resource…', ...header }: DetailsPanelProps) {
  const tabPrefix = useId();
  const root = useRef<HTMLDivElement>(null);
  const origin = useRef<HTMLElement | null>(null);
  const previousTab = useRef(header.rightTab);
  useEffect(() => {
    if (previousTab.current !== header.rightTab) root.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
    previousTab.current = header.rightTab;
  }, [header.rightTab]);
  useEffect(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body && !root.current?.contains(active)) origin.current = active;
  }, [header.item.uid]);
  const close = onClose ? () => { onClose(); if (origin.current?.isConnected) origin.current.focus(); } : undefined;
  return <div ref={root} data-testid="resource-details" aria-busy={busy} className="details-panel h-full flex flex-col bg-[var(--bg-canvas)] min-h-0 min-w-0"
    onKeyDown={event => {
      const target = event.target as HTMLElement;
      const tooltip = target.closest('[aria-describedby]')?.getAttribute('aria-describedby')?.split(' ').some(id => document.getElementById(id)?.getAttribute('role') === 'tooltip');
      if (event.key === 'Escape' && !event.defaultPrevented && close && !tooltip && !target.closest('[role="dialog"], [role="menu"], .monaco-editor')) {
        event.preventDefault(); event.stopPropagation(); close();
      }
    }}>
    <div className="details-progress" aria-hidden="true" />
    <span role="status" className="sr-only">{busy ? busyLabel : ''}</span>
    <ResourceHeader {...header} onClose={close} tabPrefix={tabPrefix} />
    <div role="tabpanel" id={`${tabPrefix}-panel`} aria-labelledby={`${tabPrefix}-${header.rightTab}`} className="flex-1 min-h-0 min-w-0 overflow-hidden">
      {children}
    </div>
    {footer}
  </div>;
}
