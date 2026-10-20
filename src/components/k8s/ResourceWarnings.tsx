import { memo, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { TriangleAlert } from 'lucide-react';
import { resourceIssues, type ResourceIssue } from '../../core/resources/diagnostics';
import { useResourceStore } from '../../state/resource_store';
import { useClusterStore } from '../../state/cluster_store';
import { cx } from '../../core/utils/cx';
import type { ResourceItem } from '../../types/k8s';

export const ResourceWarnings = memo(function ResourceWarnings({ item, showSummary = false }: { item: ResourceItem; showSummary?: boolean }) {
  const pods = useResourceStore((state) => item.kind === 'Service' ? state.resources.Pod : undefined);
  const podError = useResourceStore((state) => item.kind === 'Service' ? state.loadErrors.Pod : undefined);
  const storageClasses = useResourceStore((state) => item.kind === 'PersistentVolumeClaim' ? state.resources.StorageClass : undefined);
  const podsCurrent = useResourceStore((s) => s.syncMode !== 'watch' || s.watchStates.Pod?.phase === 'live');
  const snapshotsReady = useClusterStore((state) => item.kind === 'Service' ? state.isConnected && !state.isLoading : false);
  const storageClassName = item.spec?.storageClassName ?? item.storageClass;
  const issues = resourceIssues(item, {
    pods: pods ? [...pods.values()] : undefined,
    podsLoaded: snapshotsReady && podsCurrent && !podError,
    storageClass: storageClasses ? [...storageClasses.values()].find((entry) => entry.name === storageClassName) : undefined,
  });
  if (!issues.length) return null;
  return <IssueIndicator issues={issues} showSummary={showSummary} />;
});

function IssueIndicator({ issues, showSummary }: { issues: ResourceIssue[]; showSummary: boolean }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const anchor = useRef<HTMLSpanElement>(null);
  const tooltip = useRef<HTMLDivElement>(null);
  const tooltipId = useId();
  const error = issues.some((issue) => issue.severity === 'error');
  const description = issues.map((issue) => [issue.summary, issue.message].filter(Boolean).join(': ')).join('\n');

  useLayoutEffect(() => {
    if (!open || !anchor.current) return;
    const bounds = anchor.current.getBoundingClientRect();
    const width = Math.min(380, window.innerWidth - 16);
    const height = tooltip.current?.offsetHeight ?? 100;
    setPosition({ left: Math.max(8, Math.min(bounds.left, window.innerWidth - width - 8)), top: bounds.bottom + height + 8 < window.innerHeight ? bounds.bottom + 6 : Math.max(8, bounds.top - height - 6) });
  }, [open, description]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    document.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => { document.removeEventListener('scroll', close, true); window.removeEventListener('resize', close); };
  }, [open]);

  return <>
    <span ref={anchor} role="img" tabIndex={0} aria-label={`Resource issues: ${description}`} aria-describedby={open ? tooltipId : undefined}
      data-resource-issues={issues.length} data-severity={error ? 'error' : 'warning'}
      className={cx('inline-flex items-center gap-1.5 min-w-0 align-middle', error ? 'text-[var(--status-danger)]' : 'text-[var(--status-warn)]')}
      onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}
      onKeyDown={(event) => { if (event.key === 'Escape') setOpen(false); }}>
      <TriangleAlert size="calc(13px * var(--ui-factor))" strokeWidth={2} className="shrink-0" />
      {showSummary && <span className="text-[length:calc(11px*var(--ui-factor))] truncate">{issues[0].summary}{issues.length > 1 ? ` (+${issues.length - 1})` : ''}</span>}
    </span>
    {open && createPortal(<div ref={tooltip} id={tooltipId} role="tooltip" style={{ ...position, width: 'min(380px, calc(100vw - 16px))' }} className="pointer-events-none fixed z-[110] rounded-md border border-[var(--border-strong)] bg-[var(--bg-overlay)] shadow-[var(--shadow-popup)] p-3 text-left whitespace-normal max-h-[70vh] overflow-hidden">
      <div className={cx('font-medium text-xs mb-2', error ? 'text-[var(--status-danger)]' : 'text-[var(--status-warn)]')}>{issues.length === 1 ? 'Resource issue' : `${issues.length} resource issues`}</div>
      <ul className="space-y-2">{issues.slice(0, 8).map((issue) => <li key={issue.id}><div className="text-[length:calc(11px*var(--ui-factor))] text-[var(--text-primary)] break-words">{issue.summary}</div>{issue.message && <div className="mt-0.5 text-[length:calc(11px*var(--ui-factor))] text-[var(--text-secondary)] break-words whitespace-pre-wrap">{issue.message}</div>}</li>)}</ul>
      {issues.length > 8 && <div className="text-[length:calc(10px*var(--ui-factor))] text-[var(--text-muted)] mt-2">Open resource conditions for more details.</div>}
    </div>, document.body)}
  </>;
}
