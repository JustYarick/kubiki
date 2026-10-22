import { OverviewSection } from './OverviewSection';
import { useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import type { ResourceItem } from '../../types/k8s';
import type { ResourceIssue } from '../../core/resources/diagnostics';
import { ResourceKindBadge } from './ResourceKindBadge';
import { useWorkspaceStore } from '../../state/workspace_store';

export function OverviewProblems({ problems, warningEvents, partial }: { problems: Array<{ item: ResourceItem; issues: ResourceIssue[]; severity: string }>; warningEvents: number | null; partial: boolean }) {
  const [filter, setFilter] = useState('all');
  const [limit, setLimit] = useState(50);
  const critical = problems.filter(problem => problem.severity === 'error').length;
  const warnings = problems.length - critical;
  const filtered = problems.filter(problem => filter === 'all' || problem.severity === filter);
  return <OverviewSection label="Detected issues" className="overview-problems" description={partial ? 'Some source snapshots are unavailable or stale.' : undefined} title={<span className="overview-problems-title"><TriangleAlert size={14} aria-hidden="true" className="text-[var(--status-warn)]" />Problems <span className="overview-muted">{problems.length}</span></span>} actions={problems.length > 0 &&
    <div className="overview-problem-filters" role="group" aria-label="Problem severity">
      {([['all', 'All', problems.length], ['error', 'Critical', critical], ['warning', 'Warning', warnings]] as const).map(([value, label, count]) => <button key={value} aria-pressed={filter === value} aria-label={`${label} problems`} onClick={() => { setFilter(value); setLimit(50); }} className={`rounded border px-2 py-1 ${filter === value ? 'border-[var(--accent)] bg-[var(--bg-hover)]' : 'border-[var(--border-default)]'} ${value === 'error' ? 'text-[var(--status-danger)]' : value === 'warning' ? 'text-[var(--status-warn)]' : 'text-[var(--text-secondary)]'}`}>{label} <span className="font-mono">{count}</span></button>)}
    </div>}>
    {warningEvents !== 0 && <p className="overview-muted mb-2">Warning Events: {warningEvents ?? '—'}</p>}
    <div className="overview-problems-list kubiki-scrollbar">
      {!filtered.length && <p className="text-xs text-[var(--text-secondary)]">{!problems.length ? 'No issues detected in available data.' : 'No problems match this severity.'}</p>}
      {filtered.slice(0, limit).map(({ item, issues, severity }) => {
        const primary = issues.find(issue => issue.severity === 'error') ?? issues[0];
        return <button key={`${item.kind}/${item.uid}`} className="overview-problem-row" onClick={() => useWorkspaceStore.getState().openResourceDetail(item)}><div className="flex items-center flex-wrap gap-2 min-w-0"><span className={`text-xs font-medium ${severity === 'error' ? 'text-[var(--status-danger)]' : 'text-[var(--status-warn)]'}`}>{severity === 'error' ? 'Critical' : 'Warning'}</span><ResourceKindBadge kind={item.kind} apiVersion={item.apiVersion} /><span className="font-mono text-xs truncate min-w-0 flex-1" title={item.name}>{item.name}</span></div><p className="text-xs text-[var(--text-secondary)] mt-1 break-words">{item.namespace ? `${item.namespace} · ` : ''}{primary.summary}{issues.length > 1 ? ` (+${issues.length - 1})` : ''}</p>{primary.message && <p className="text-xs text-[var(--text-secondary)] mt-1 break-words line-clamp-2" title={primary.message}>{primary.message}</p>}</button>;
      })}
      {filtered.length > limit && <button className="text-xs text-[var(--accent)] p-2" onClick={() => setLimit(value => value + 50)}>Show next 50 problems</button>}
    </div>
  </OverviewSection>;
}
