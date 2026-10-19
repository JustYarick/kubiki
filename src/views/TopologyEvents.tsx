import { memo, useId, useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, Clock3, TriangleAlert } from 'lucide-react';
import { topologyEvents } from '../core/resources/topology_events';
import type { ResourceGraph } from '../core/resources/relationships';
import { useResourceStore } from '../state/resource_store';
import { useUiStore } from '../state/ui_store';

/** Separate from the canvas: snapshot/timeline updates do not restart ELK or reset positions. */
export const TopologyEvents = memo(function TopologyEvents({ scope, graph }: { scope: string; graph: ResourceGraph }) {
  const resources = useResourceStore((state) => state.resources);
  const error = useResourceStore((state) => state.loadErrors.Event);
  const [expanded, setExpanded] = useState(true);
  const id = useId();
  const { entries, total, warnings } = useMemo(() => topologyEvents(resources.Event.values(), scope, graph, resources), [resources, scope, graph]);
  return <aside aria-label="Topology events" className="topology-events" data-testid="topology-events">
    <button className="flex items-center gap-2 w-full px-3 py-2 text-left text-xs font-medium" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded((value) => !value)}>
      <Clock3 size={13} className="text-[var(--text-secondary)]" /><span className="flex-1">Recent events <span className="text-[var(--text-muted)]">({total})</span></span>
      {warnings > 0 && <span className="text-[10px] text-[var(--status-warn)] flex items-center gap-1"><TriangleAlert size={11} />{warnings}</span>}
      {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
    </button>
    {expanded && <div id={id} className="border-t border-[var(--border-default)]">
      {error && <p className="p-3 text-[11px] text-[var(--status-warn)]">Events unavailable: {error}</p>}
      {!entries.length && !error && <p className="p-3 text-[11px] text-[var(--text-muted)]">No events in the loaded snapshot for this scope.</p>}
      {!!entries.length && <ol className="topology-events-list">{entries.map((entry) => <li key={entry.event.uid} className="px-3 py-2 border-b last:border-0 border-[var(--border-subtle)] text-[11px]">
        <div className="flex items-center gap-1.5">
          {entry.warning ? <TriangleAlert size={12} className="text-[var(--status-warn)] shrink-0" aria-label="Warning" /> : <span className="w-1.5 h-1.5 rounded-full bg-[var(--status-ok)] shrink-0" />}
          <span className="font-medium truncate" title={entry.reason}>{entry.reason}</span>{entry.count > 1 && <span className="text-[10px] text-[var(--text-muted)]">×{entry.count}</span>}
          <time dateTime={entry.timestamp} title={entry.timestamp ? new Date(entry.timestamp).toLocaleString() : 'Time unavailable'} className="ml-auto shrink-0 text-[10px] text-[var(--text-muted)]">{entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : entry.event.age ?? '—'}</time>
        </div>
        {entry.target ? <button className="text-[var(--accent)] hover:underline max-w-full truncate mt-1 font-mono text-left" title={entry.objectLabel} onClick={() => {
          useResourceStore.getState().selectItem(entry.target!);
          useUiStore.setState({ inspectorCollapsed: false, rightTab: 'events' });
        }}>{entry.objectLabel}</button> : <div title={entry.objectLabel} className="text-[var(--text-secondary)] truncate mt-1 font-mono">{entry.objectLabel} · not loaded</div>}
        <p className="mt-0.5 text-[var(--text-secondary)] line-clamp-2 break-words" title={entry.message}>{entry.message}</p>
      </li>)}</ol>}
      {total > entries.length && <p className="px-3 py-1.5 text-[10px] text-[var(--text-muted)]">Latest {entries.length} of {total} events</p>}
      <p className="px-3 py-1.5 text-[10px] text-[var(--text-muted)]">Loaded snapshot · click a resource for its events</p>
    </div>}
  </aside>;
});
