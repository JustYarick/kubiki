import { useMemo, useState } from 'react';
import { Box, Layers } from 'lucide-react';
import type { ResourceItem } from '../../../../types/k8s';
import { useResourceStore } from '../../../../state/resource_store';
import { Button } from '../../../ui/Button';
import { Input } from '../../../ui/Input';
import { cpuText, memoryText, quantity } from '../../../../core/resources/quantities';

interface NodePodsBlockProps {
  item: ResourceItem;
  onNavigate: (item: ResourceItem) => void;
}

export function NodePodsBlock({ item, onNavigate }: NodePodsBlockProps) {
  const podMap = useResourceStore((s) => s.resources.Pod);
  const [filter, setFilter] = useState('');
  const [limit, setLimit] = useState(25);

  const raw = item.raw ?? {};
  const status = raw.status ?? item.statusRaw ?? {};
  const allocatable = status.allocatable ?? {};
  const capacity = status.capacity ?? {};

  // Find all pods scheduled on this node (using memoization for fast performance in 10,000+ pod clusters)
  const podsOnNode = useMemo(() => {
    if (!podMap) return [];
    const list: ResourceItem[] = [];
    const nodeName = item.name;
    for (const pod of podMap.values()) {
      if (pod.node === nodeName || (pod.raw as any)?.spec?.nodeName === nodeName) {
        list.push(pod);
      }
    }
    return list;
  }, [podMap, item.name]);

  // Compute resource allocation
  const allocation = useMemo(() => {
    let cpuReqBytes = 0;
    let cpuLimBytes = 0;
    let memReqBytes = 0;
    let memLimBytes = 0;

    for (const pod of podsOnNode) {
      if (pod.status === 'Succeeded' || pod.status === 'Failed') continue;
      const containers = (pod.raw as any)?.spec?.containers ?? [];
      for (const c of containers) {
        const req = c.resources?.requests;
        const lim = c.resources?.limits;
        if (req?.cpu) cpuReqBytes += quantity(req.cpu) ?? 0;
        if (lim?.cpu) cpuLimBytes += quantity(lim.cpu) ?? 0;
        if (req?.memory) memReqBytes += quantity(req.memory) ?? 0;
        if (lim?.memory) memLimBytes += quantity(lim.memory) ?? 0;
      }
    }

    const allocCpu = quantity(allocatable.cpu ?? capacity.cpu) ?? 0;
    const allocMem = quantity(allocatable.memory ?? capacity.memory) ?? 0;

    return {
      cpuReq: cpuReqBytes,
      cpuLim: cpuLimBytes,
      memReq: memReqBytes,
      memLim: memLimBytes,
      cpuReqPercent: allocCpu > 0 ? Math.round((cpuReqBytes / allocCpu) * 100) : 0,
      cpuLimPercent: allocCpu > 0 ? Math.round((cpuLimBytes / allocCpu) * 100) : 0,
      memReqPercent: allocMem > 0 ? Math.round((memReqBytes / allocMem) * 100) : 0,
      memLimPercent: allocMem > 0 ? Math.round((memLimBytes / allocMem) * 100) : 0,
    };
  }, [podsOnNode, allocatable, capacity]);

  // Filter pods
  const filteredPods = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return podsOnNode;
    return podsOnNode.filter(
      (p) => p.name.toLowerCase().includes(q) || (p.namespace && p.namespace.toLowerCase().includes(q))
    );
  }, [podsOnNode, filter]);

  const displayedPods = filteredPods.slice(0, limit);

  return (
    <div className="details-stack">
      {/* Allocated Resources Breakdown (Lens feature) */}
      <section aria-label="Allocated Resources" className="details-section">
        <div className="details-section-heading bg-[var(--bg-secondary)] border-b border-[var(--border-default)] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Layers size="calc(13px * var(--ui-factor))" className="text-[var(--accent)]" />
            <span className="text-xs font-semibold text-[var(--text-primary)]">Allocated Resources</span>
          </div>
          <span className="text-[length:calc(10px*var(--ui-factor))] text-[var(--text-muted)] font-mono">
            {podsOnNode.length} non-terminated pods
          </span>
        </div>
        <div className="p-2 grid gap-2.5" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, calc(260px * var(--ui-factor))), 1fr))' }}>
          <div className="p-2 rounded bg-[var(--bg-secondary)] border border-[var(--border-subtle)] text-xs">
            <div className="flex justify-between items-center mb-1">
              <span className="text-[var(--text-secondary)]">CPU Requests</span>
              <span className="font-mono font-semibold text-[var(--text-primary)]">
                {cpuText(allocation.cpuReq)} ({allocation.cpuReqPercent}%)
              </span>
            </div>
            <div className="w-full bg-[var(--bg-surface)] h-1.5 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full ${allocation.cpuReqPercent > 90 ? 'bg-red-400' : allocation.cpuReqPercent > 70 ? 'bg-amber-400' : 'bg-emerald-400'}`}
                style={{ width: `${Math.min(100, allocation.cpuReqPercent)}%` }}
              />
            </div>
            <div className="flex justify-between text-[10px] text-[var(--text-muted)] mt-1">
              <span>Limits: {cpuText(allocation.cpuLim)}</span>
              <span>{allocation.cpuLimPercent}%</span>
            </div>
          </div>

          <div className="p-2 rounded bg-[var(--bg-secondary)] border border-[var(--border-subtle)] text-xs">
            <div className="flex justify-between items-center mb-1">
              <span className="text-[var(--text-secondary)]">Memory Requests</span>
              <span className="font-mono font-semibold text-[var(--text-primary)]">
                {memoryText(allocation.memReq)} ({allocation.memReqPercent}%)
              </span>
            </div>
            <div className="w-full bg-[var(--bg-surface)] h-1.5 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full ${allocation.memReqPercent > 90 ? 'bg-red-400' : allocation.memReqPercent > 70 ? 'bg-amber-400' : 'bg-emerald-400'}`}
                style={{ width: `${Math.min(100, allocation.memReqPercent)}%` }}
              />
            </div>
            <div className="flex justify-between text-[10px] text-[var(--text-muted)] mt-1">
              <span>Limits: {memoryText(allocation.memLim)}</span>
              <span>{allocation.memLimPercent}%</span>
            </div>
          </div>
        </div>
      </section>

      {/* Pods Running on Node (Lens feature, large-scale friendly) */}
      <section aria-label="Pods on this node" className="details-section">
        <div className="details-section-heading bg-[var(--bg-secondary)] border-b border-[var(--border-default)] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Box size="calc(13px * var(--ui-factor))" className="text-[var(--accent)]" />
            <span className="text-xs font-semibold text-[var(--text-primary)]">
              Pods on this node ({podsOnNode.length})
            </span>
          </div>
          {podsOnNode.length > 5 && (
            <div className="w-48">
              <Input
                placeholder="Filter pods…"
                value={filter}
                onChange={(e) => {
                  setFilter(e.target.value);
                  setLimit(25);
                }}
                className="!py-0.5 !px-2 !text-[11px] !h-6"
              />
            </div>
          )}
        </div>

        <div className="p-2">
          {displayedPods.length === 0 ? (
            <div className="text-xs text-[var(--text-muted)] p-2 text-center">
              {filter ? 'No pods match filter.' : 'No pods currently running on this node.'}
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <div className="max-h-[360px] overflow-y-auto kubiki-scrollbar pr-1 space-y-1.5">
                {displayedPods.map((pod) => (
                  <div
                    key={pod.uid}
                    className="flex items-center justify-between gap-2 p-1.5 rounded bg-[var(--bg-secondary)] border border-[var(--border-subtle)] text-xs hover:border-[var(--border-default)] transition-colors"
                  >
                    <div className="min-w-0 flex-1 flex flex-col">
                      <button
                        type="button"
                        className="details-link font-medium text-left truncate"
                        onClick={() => onNavigate(pod)}
                        title={pod.name}
                      >
                        {pod.name}
                      </button>
                      <span className="text-[10px] text-[var(--text-muted)] truncate">
                        {pod.namespace || 'default'} · {pod.ready || '—'} ready
                        {pod.restarts ? ` · ${pod.restarts} restarts` : ''}
                      </span>
                    </div>

                    <span
                      className={`px-1.5 py-0.5 rounded text-[10px] font-mono shrink-0 ${
                        pod.status === 'Running' || pod.status === 'Completed'
                          ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                          : 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                      }`}
                    >
                      {pod.status || 'Unknown'}
                    </span>
                  </div>
                ))}
              </div>

              {filteredPods.length > limit && (
                <div className="pt-1 text-center border-t border-[var(--border-subtle)]">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setLimit((l) => l + 25)}
                    className="w-full justify-center !py-1 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                  >
                    Show next 25 pods ({filteredPods.length - limit} remaining)
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
