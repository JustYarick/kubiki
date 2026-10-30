import { useMemo, useState } from 'react';
import { Cpu, MemoryStick, RefreshCw } from 'lucide-react';
import type { ResourceItem } from '../../../../types/k8s';
import { useClusterStore } from '../../../../state/cluster_store';
import { useOverviewMetrics } from '../../../../providers/use_overview_metrics';
import { quantity, cpuText, memoryText } from '../../../../core/resources/quantities';
import { HistoryChart } from '../../ResourceTelemetry';
import { DetailsSection } from '../DetailsSection';
import { Button } from '../../../ui/Button';
import { Select } from '../../../ui/Select';
import '../../../../views/overview.css';

export function NodePerformanceBlock({ item }: { item: ResourceItem }) {
  const context = useClusterStore(state => state.currentContext);
  const [paused, setPaused] = useState(false);
  const [range, setRange] = useState(15);
  const [fixed, setFixed] = useState(false);
  // Shares the cluster read with Overview; a node is never reduced to the selected namespace.
  const metrics = useOverviewMetrics(context, null, paused);
  const sample = metrics.data?.nodes.items?.find(node => node.name === item.name);
  const created = Date.parse(item.raw?.metadata?.creationTimestamp ?? '') || 0;
  const history = useMemo(() => (Object.prototype.hasOwnProperty.call(metrics.nodeHistory, item.name) ? metrics.nodeHistory[item.name] : []).filter(point => point.at >= created), [metrics.nodeHistory, item.name, created]);
  const timestamp = sample ? Date.parse(sample.timestamp) : null;
  const stale = timestamp !== null && (Date.now() - timestamp > 120000 || timestamp - Date.now() > 30000 || timestamp < created);
  const error = metrics.error ?? metrics.data?.nodes.error?.message;
  const raw = item.raw?.status ?? {};
  return <DetailsSection title="Node performance" label="Node performance"><div className="flex flex-wrap items-center gap-1.5 mb-2">
    <Select aria-label="Node metrics history range" className="ide-select" value={range} onChange={event => setRange(Number(event.target.value))}><option value={5}>5 min</option><option value={15}>15 min</option><option value={30}>30 min</option></Select>
    <Button size="sm" aria-pressed={fixed} onClick={() => setFixed(value => !value)}>Fixed scale</Button>
    <Button size="sm" aria-pressed={paused} onClick={() => setPaused(value => !value)}>{paused ? 'Resume node metrics' : 'Pause node metrics'}</Button>
    <Button size="sm" aria-label="Refresh node metrics" disabled={paused || metrics.loading} onClick={metrics.refresh}><RefreshCw size={12} aria-hidden="true" /></Button>
  </div>
    {(error || stale || !sample && !metrics.loading) && <p role="status" className="telemetry-notice">{error ?? (stale ? 'Node metrics are stale; showing the last observation.' : 'No metrics for this node. Check Metrics Server and permission to read nodes.metrics.k8s.io.')}</p>}
    <div className="telemetry-metrics">{(['cpu', 'memory'] as const).map(dimension => {
      const value = sample && timestamp !== null && timestamp >= created ? quantity(sample[dimension]) : null;
      const allocatable = quantity(raw.allocatable?.[dimension]);
      const capacity = quantity(raw.capacity?.[dimension]);
      const percent = value !== null && allocatable !== null && allocatable > 0 ? value / allocatable * 100 : null;
      const format = dimension === 'cpu' ? cpuText : memoryText;
      return <section key={dimension} aria-label={`Node ${dimension === 'cpu' ? 'CPU' : 'RAM'} performance`} className="telemetry-metric" style={{ '--telemetry-color': `var(--chart-${dimension})` } as React.CSSProperties}>
        <div className="telemetry-metric-heading"><h3>{dimension === 'cpu' ? <Cpu size={14} aria-hidden="true" /> : <MemoryStick size={14} aria-hidden="true" />}{dimension === 'cpu' ? 'CPU' : 'RAM'}</h3><span className="telemetry-value">{format(value)}</span><span className="telemetry-utilization">{percent === null ? 'Utilization unavailable' : `${percent.toFixed(1)}% of allocatable`}</span></div>
        <p className="details-caption">Allocatable {format(allocatable)} · Capacity {format(capacity)}</p>
        <HistoryChart history={history} dimension={dimension} minutes={range} reference={fixed ? allocatable : null} />
      </section>;
    })}</div>
    <p className="telemetry-footnote">{metrics.loading ? 'Refreshing…' : paused ? 'Paused' : 'Metrics API · 15s sampling'} · {sample ? `Source ${new Date(sample.timestamp).toLocaleTimeString()} · CPU averaging window ${sample.window}` : 'Waiting for the first measurement'} · {history.length} samples</p>
    <p className="details-caption">Live CPU and memory usage includes node system processes. Disk/network rates and historical data from before this session require an additional telemetry source.</p>
  </DetailsSection>;
}
