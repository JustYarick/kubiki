import { useMemo } from 'react';
import { Activity, AlertTriangle, Clock } from 'lucide-react';
import type { ResourceItem } from '../../../../types/k8s';
import { quantity, cpuText, memoryText } from '../../../../core/resources/quantities';
import { podBudget } from '../../../../core/resources/telemetry';
import { useClusterStore } from '../../../../state/cluster_store';
import { useOverviewMetrics } from '../../../../providers/use_overview_metrics';
import { cx } from '../../../../core/utils/cx';

interface MetricsGaugeBarProps {
  item: ResourceItem;
}

export function MetricsGaugeBar({ item }: MetricsGaugeBarProps) {
  const context = useClusterStore((s) => s.currentContext);
  const namespace = item.namespace ?? null;

  // Poll metrics for context and namespace, capturing error and loading states
  const { data, loading, error } = useOverviewMetrics(context, namespace, () => undefined);

  // Extract requests & limits using domain podBudget calculator for consistent budgets
  const { cpuReq, cpuLim, memReq, memLim } = useMemo(() => {
    if (item.kind === 'Node') {
      const raw = item.raw ?? {};
      const allocatable = raw.status?.allocatable ?? {};
      const capacity = raw.status?.capacity ?? {};
      return {
        cpuReq: quantity(allocatable.cpu) ?? quantity(capacity.cpu),
        cpuLim: quantity(capacity.cpu),
        memReq: quantity(allocatable.memory) ?? quantity(capacity.memory),
        memLim: quantity(capacity.memory),
      };
    }

    const targetPod = item.kind === 'Pod'
      ? item
      : item.raw?.spec?.template
        ? { ...item, kind: 'Pod' as const, raw: { ...item.raw, spec: item.raw?.spec?.template?.spec } }
        : null;

    if (targetPod) {
      const cpu = podBudget(targetPod, 'cpu');
      const mem = podBudget(targetPod, 'memory');
      return {
        cpuReq: cpu.request,
        cpuLim: cpu.limit,
        memReq: mem.request,
        memLim: mem.limit,
      };
    }

    return { cpuReq: null, cpuLim: null, memReq: null, memLim: null };
  }, [item]);

  // Extract real-time metrics and check freshness against recreation and age
  const { currentCpu, currentMem, isStale, staleReason } = useMemo(() => {
    const now = Date.now();
    if (!data) return { currentCpu: null, currentMem: null, isStale: false, staleReason: null };

    let metricTimestamp: number | null = null;
    let cpu: number | null = null;
    let mem: number | null = null;

    if (item.kind === 'Pod' && data.pods?.items) {
      const match = data.pods.items.find(
        (p) => p.name === item.name && (!item.namespace || p.namespace === item.namespace)
      );
      if (match) {
        metricTimestamp = Date.parse(match.timestamp);
        let cSum = 0;
        let mSum = 0;
        for (const c of match.containers) {
          const qCpu = quantity(c.cpu);
          const qMem = quantity(c.memory);
          if (qCpu !== null) cSum += qCpu;
          if (qMem !== null) mSum += qMem;
        }
        cpu = cSum;
        mem = mSum;
      }
    } else if (item.kind === 'Node' && data.nodes?.items) {
      const match = data.nodes.items.find((n) => n.name === item.name);
      if (match) {
        metricTimestamp = Date.parse(match.timestamp);
        cpu = quantity(match.cpu);
        mem = quantity(match.memory);
      }
    }

    let stale = false;
    let reason: string | null = null;

    if (error) {
      stale = true;
      reason = error;
    } else if (metricTimestamp !== null) {
      if (item.creationTimestamp && Date.parse(item.creationTimestamp) > metricTimestamp) {
        stale = true;
        reason = 'Pod was recreated after this sample was taken';
        cpu = null;
        mem = null;
      } else if (now - metricTimestamp > 120_000) {
        stale = true;
        reason = 'Sample is older than 2 minutes';
      }
    }

    return { currentCpu: cpu, currentMem: mem, isStale: stale, staleReason: reason };
  }, [data, error, item]);

  // If no limits, requests, and no live metrics available: don't show empty box
  if (cpuReq === null && cpuLim === null && memReq === null && memLim === null && currentCpu === null && currentMem === null && !loading) {
    return null;
  }

  const memLimitRatio = currentMem !== null && memLim !== null && memLim > 0 ? currentMem / memLim : null;
  // Never raise OOM risk on stale metrics or unbounded limits
  const isOomRisk = !isStale && memLimitRatio !== null && memLimitRatio >= 0.85;

  return (
    <section aria-label="Resource metrics" className="details-section">
      <div className="details-section-heading text-[length:calc(11px*var(--ui-factor))] font-medium text-[var(--text-secondary)] bg-[var(--bg-secondary)] flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-[var(--text-primary)]">
          <Activity size="calc(13px * var(--ui-factor))" className="text-[var(--accent)]" />
          Metrics · Usage vs Request vs Limit
        </span>
        <div className="flex items-center gap-2">
          {isStale && (
            <span
              className="flex items-center gap-1 text-[length:calc(10px*var(--ui-factor))] text-amber-400 font-medium bg-amber-500/10 px-2 py-0.5 rounded"
              title={staleReason ?? 'Outdated metrics'}
            >
              <Clock size="calc(12px * var(--ui-factor))" />
              Stale{staleReason ? ` (${staleReason})` : ''}
            </span>
          )}
          {isOomRisk && (
            <span className="flex items-center gap-1 text-[length:calc(10px*var(--ui-factor))] text-rose-400 font-semibold uppercase tracking-wider bg-rose-500/10 px-2 py-0.5 rounded">
              <AlertTriangle size="calc(12px * var(--ui-factor))" />
              OOM Risk ({Math.round(memLimitRatio * 100)}% of limit)
            </span>
          )}
        </div>
      </div>

      <div className="p-2 details-metrics-grid bg-[var(--bg-canvas)]">
        {/* CPU Bar */}
        <div className="flex flex-col gap-1.5 p-2 rounded bg-[var(--bg-secondary)]/50 border border-[var(--border-subtle)]">
          <div className="flex items-center justify-between text-xs font-medium">
            <span className="text-[var(--text-secondary)]">CPU</span>
            <span className="font-mono text-[var(--text-primary)]">
              {currentCpu !== null ? cpuText(currentCpu) : '—'}{' '}
              <span className="text-[var(--text-muted)] text-[10px]">
                (req: {cpuText(cpuReq)} | lim: {cpuText(cpuLim)})
              </span>
            </span>
          </div>

          <div className="w-full h-2 rounded-full bg-[var(--bg-canvas)] border border-[var(--border-subtle)] overflow-hidden relative flex">
            {currentCpu !== null && (cpuLim !== null || cpuReq !== null) && (
              <div
                style={{
                  width: `${Math.min(100, Math.round((currentCpu / (cpuLim || (cpuReq ? cpuReq * 1.5 : 1))) * 100))}%`,
                }}
                className={cx('h-full transition-all duration-500', isStale ? 'bg-amber-500/60' : 'bg-blue-500')}
              />
            )}
          </div>
          <div className="flex justify-between text-[length:calc(10px*var(--ui-factor))] text-[var(--text-muted)] font-mono">
            <span>Usage: {cpuText(currentCpu)}</span>
            <span>Limit: {cpuText(cpuLim)}</span>
          </div>
        </div>

        {/* Memory Bar */}
        <div className="flex flex-col gap-1.5 p-2 rounded bg-[var(--bg-secondary)]/50 border border-[var(--border-subtle)]">
          <div className="flex items-center justify-between text-xs font-medium">
            <span className="text-[var(--text-secondary)]">Memory</span>
            <span className="font-mono text-[var(--text-primary)]">
              {currentMem !== null ? memoryText(currentMem) : '—'}{' '}
              <span className="text-[var(--text-muted)] text-[10px]">
                (req: {memoryText(memReq)} | lim: {memoryText(memLim)})
              </span>
            </span>
          </div>

          <div className="w-full h-2 rounded-full bg-[var(--bg-canvas)] border border-[var(--border-subtle)] overflow-hidden relative flex">
            {currentMem !== null && (memLim !== null || memReq !== null) && (
              <div
                style={{
                  width: `${Math.min(100, Math.round((currentMem / (memLim || (memReq ? memReq * 1.5 : 1))) * 100))}%`,
                }}
                className={cx(
                  'h-full transition-all duration-500',
                  isStale ? 'bg-amber-500/60' : isOomRisk ? 'bg-rose-500' : 'bg-emerald-500'
                )}
              />
            )}
          </div>
          <div className="flex justify-between text-[length:calc(10px*var(--ui-factor))] text-[var(--text-muted)] font-mono">
            <span>Usage: {memoryText(currentMem)}</span>
            <span>Limit: {memoryText(memLim)}</span>
          </div>
        </div>
      </div>
    </section>
  );
}
