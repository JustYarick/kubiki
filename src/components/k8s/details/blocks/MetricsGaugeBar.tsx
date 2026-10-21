import { useMemo } from 'react';
import { Activity, AlertTriangle } from 'lucide-react';
import type { ResourceItem } from '../../../../types/k8s';
import { quantity, cpuText, memoryText } from '../../../../core/resources/quantities';
import { useClusterStore } from '../../../../state/cluster_store';
import { useOverviewMetrics } from '../../../../providers/use_overview_metrics';
import { cx } from '../../../../core/utils/cx';

interface MetricsGaugeBarProps {
  item: ResourceItem;
}

export function MetricsGaugeBar({ item }: MetricsGaugeBarProps) {
  const context = useClusterStore((s) => s.currentContext);
  const namespace = item.namespace ?? null;

  // Poll metrics for context and namespace
  const { data } = useOverviewMetrics(context, namespace, () => undefined);

  // Extract requests & limits from spec
  const { cpuReq, cpuLim, memReq, memLim } = useMemo(() => {
    const raw = item.raw ?? {};
    const containers: any[] = raw.spec?.containers ?? (raw.spec?.template?.spec?.containers ?? []);
    let cpuReqSum = 0;
    let cpuLimSum = 0;
    let memReqSum = 0;
    let memLimSum = 0;
    let hasCpuReq = false;
    let hasCpuLim = false;
    let hasMemReq = false;
    let hasMemLim = false;

    for (const c of containers) {
      const req = c.resources?.requests;
      const lim = c.resources?.limits;
      if (req?.cpu) { const q = quantity(req.cpu); if (q !== null) { cpuReqSum += q; hasCpuReq = true; } }
      if (lim?.cpu) { const q = quantity(lim.cpu); if (q !== null) { cpuLimSum += q; hasCpuLim = true; } }
      if (req?.memory) { const q = quantity(req.memory); if (q !== null) { memReqSum += q; hasMemReq = true; } }
      if (lim?.memory) { const q = quantity(lim.memory); if (q !== null) { memLimSum += q; hasMemLim = true; } }
    }

    return {
      cpuReq: hasCpuReq ? cpuReqSum : null,
      cpuLim: hasCpuLim ? cpuLimSum : null,
      memReq: hasMemReq ? memReqSum : null,
      memLim: hasMemLim ? memLimSum : null,
    };
  }, [item]);

  // Extract real-time metrics for Pod or Node if present
  const { currentCpu, currentMem } = useMemo(() => {
    if (!data) return { currentCpu: null, currentMem: null };

    if (item.kind === 'Pod' && data.pods?.items) {
      const match = data.pods.items.find(
        (p) => p.name === item.name && (!item.namespace || p.namespace === item.namespace)
      );
      if (match) {
        let cpu = 0;
        let mem = 0;
        for (const c of match.containers) {
          const qCpu = quantity(c.cpu);
          const qMem = quantity(c.memory);
          if (qCpu !== null) cpu += qCpu;
          if (qMem !== null) mem += qMem;
        }
        return { currentCpu: cpu, currentMem: mem };
      }
    }

    if (item.kind === 'Node' && data.nodes?.items) {
      const match = data.nodes.items.find((n) => n.name === item.name);
      if (match) {
        return { currentCpu: quantity(match.cpu), currentMem: quantity(match.memory) };
      }
    }

    return { currentCpu: null, currentMem: null };
  }, [data, item]);

  // If no limits, requests, and no live metrics available: don't show empty box
  if (cpuReq === null && cpuLim === null && memReq === null && memLim === null && currentCpu === null && currentMem === null) {
    return null;
  }

  const memLimitRatio = currentMem !== null && memLim !== null && memLim > 0 ? currentMem / memLim : null;
  const isOomRisk = memLimitRatio !== null && memLimitRatio >= 0.85;

  return (
    <section aria-label="Resource metrics" className="details-section">
      <div className="details-section-heading text-[length:calc(11px*var(--ui-factor))] font-medium text-[var(--text-secondary)] bg-[var(--bg-secondary)] flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-[var(--text-primary)]">
          <Activity size="calc(13px * var(--ui-factor))" className="text-[var(--accent)]" />
          Metrics · Usage vs Request vs Limit
        </span>
        {isOomRisk && (
          <span className="flex items-center gap-1 text-[length:calc(10px*var(--ui-factor))] text-rose-400 font-semibold uppercase tracking-wider bg-rose-500/10 px-2 py-0.5 rounded">
            <AlertTriangle size="calc(12px * var(--ui-factor))" />
            OOM Risk ({Math.round(memLimitRatio * 100)}% of limit)
          </span>
        )}
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
                className="h-full bg-blue-500 transition-all duration-500"
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
                  isOomRisk ? 'bg-rose-500' : 'bg-emerald-500'
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
