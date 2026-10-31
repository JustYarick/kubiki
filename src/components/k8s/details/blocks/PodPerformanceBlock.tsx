import { useState } from 'react';
import { Cpu, MemoryStick, RefreshCw } from 'lucide-react';
import type { ResourceItem } from '../../../../types/k8s';
import type { usePodMetrics } from '../../../../providers/use_pod_metrics';
import { podBudget } from '../../../../core/resources/telemetry';
import { cpuText, memoryText } from '../../../../core/resources/quantities';
import { HistoryChart } from '../../ResourceTelemetry';
import { DetailsSection } from '../DetailsSection';
import { Button } from '../../../ui/Button';
import { Select } from '../../../ui/Select';
import '../../../../views/overview.css';

export function PodPerformanceBlock({ item, metrics, paused, onPausedChange }: { item: ResourceItem; metrics: ReturnType<typeof usePodMetrics>; paused: boolean; onPausedChange: (paused: boolean) => void }) {
  const [range, setRange] = useState(15);
  const [fixed, setFixed] = useState(false);
  const hasMetrics = Boolean(metrics.sample || metrics.history.length > 0);
  return <DetailsSection title="Pod performance" label="Pod performance">
    <div className="flex flex-wrap items-center gap-1.5 mb-2">
      {hasMetrics && <>
        <Select aria-label="Pod metrics history range" className="ide-select" value={range} onChange={event => setRange(Number(event.target.value))}><option value={5}>5 min</option><option value={15}>15 min</option><option value={30}>30 min</option></Select>
        <Button size="sm" aria-pressed={fixed} onClick={() => setFixed(value => !value)}>Fixed scale</Button>
      </>}
      <Button size="sm" aria-pressed={paused} onClick={() => onPausedChange(!paused)}>{paused ? 'Resume pod metrics' : 'Pause pod metrics'}</Button>
      <Button size="sm" aria-label="Refresh pod metrics" disabled={paused || metrics.loading || !metrics.namespace} onClick={metrics.refresh}><RefreshCw size={12} aria-hidden="true" /></Button>
    </div>
    {(metrics.error || metrics.stale || (!hasMetrics && !metrics.loading)) && <p role="status" className="telemetry-notice">{metrics.error ?? (metrics.stale ? 'Pod metrics are stale; showing the last observation.' : 'No metrics for this Pod. Pending or recently started Pods may not have samples yet. Check Metrics Server and permission to read pods.metrics.k8s.io.')}</p>}
    {hasMetrics && <div className="telemetry-metrics">{(['cpu', 'memory'] as const).map(dimension => {
      const budget = podBudget(item, dimension);
      const value = metrics.usage[dimension];
      const format = dimension === 'cpu' ? cpuText : memoryText;
      const percent = value !== null && budget.limit !== null && budget.limit > 0 ? value / budget.limit * 100 : null;
      return <section key={dimension} aria-label={`Pod ${dimension === 'cpu' ? 'CPU' : 'RAM'} performance`} className="telemetry-metric" style={{ '--telemetry-color': `var(--chart-${dimension})` } as React.CSSProperties}>
        <div className="telemetry-metric-heading"><h3>{dimension === 'cpu' ? <Cpu size={14} aria-hidden="true" /> : <MemoryStick size={14} aria-hidden="true" />}{dimension === 'cpu' ? 'CPU' : 'RAM'}</h3><span className="telemetry-value">{format(value)}</span><span className="telemetry-utilization">{percent === null ? 'Usage / limit unavailable' : `${percent.toFixed(1)}% of limit`}</span></div>
        <p className="details-caption">Requests {format(budget.request)} · Limit {budget.limit === null ? 'Unbounded / unavailable' : format(budget.limit)}</p>
        <HistoryChart history={metrics.history} dimension={dimension} minutes={range} reference={fixed ? budget.limit : null} />
      </section>;
    })}</div>}
    <p className="telemetry-footnote">{metrics.loading ? 'Refreshing…' : paused ? 'Paused' : 'Metrics API · 15s sampling'} · {metrics.sample ? `Source ${new Date(metrics.sample.timestamp).toLocaleTimeString()} · CPU averaging window ${metrics.sample.window} · ${metrics.sample.containers.length} measured containers` : 'Waiting for the first measurement'} · {metrics.history.length} samples</p>
  </DetailsSection>;
}
