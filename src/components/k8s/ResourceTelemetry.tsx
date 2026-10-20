import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Activity, Cpu, MemoryStick, RefreshCw, ChevronDown, ArrowUpRight } from 'lucide-react';
import type { ResourceItem } from '../../types/k8s';
import { useOverviewMetrics } from '../../providers/use_overview_metrics';
import { buildTelemetry, podBudget, type Dimension, type HistoryPoint, type UsageRow } from '../../core/resources/telemetry';
import { cpuText, memoryText, quantity } from '../../core/resources/quantities';
import { useWorkspaceStore } from '../../state/workspace_store';
import { k8s } from '../../providers/k8s_provider';

const labels = { cpu: 'CPU', memory: 'RAM' };
const colors = { cpu: '#7e9fff', memory: '#b39aff' };
const format = (dimension: Dimension, value: number | null) => dimension === 'cpu' ? cpuText(value) : memoryText(value);
export function ResourceTelemetry({ context, namespace, pods, nodes }: { context: string; namespace: string | null; pods: ResourceItem[] | null; nodes: ResourceItem[] | null }) {
  const state = useOverviewMetrics(context, namespace, data => buildTelemetry(data, pods, nodes, namespace).point);
  const telemetry = useMemo(() => buildTelemetry(state.data, pods, nodes, namespace), [state.data, pods, nodes, namespace, state.loading]);
  const [range, setRange] = useState(15);
  const [mode, setMode] = useState<'pods' | 'nodes'>('pods');
  const [sort, setSort] = useState<Dimension>('cpu');
  const [limit, setLimit] = useState(10);
  const [selected, setSelected] = useState<string>();
  const rankingMode = namespace ? 'pods' : mode;
  const rows = useMemo(() => [...(rankingMode === 'pods' ? telemetry.podRows : telemetry.nodeRows)].sort((a, b) => b[sort] - a[sort] || a.name.localeCompare(b.name)), [rankingMode, telemetry, sort]);
  const selection = rows.find(row => `${row.namespace ?? ''}/${row.name}` === selected);
  const errors = [state.error, state.data?.nodes.error?.message, state.data?.pods.error?.message].filter(Boolean);
  return <section aria-label="CPU and RAM telemetry" className="telemetry-section space-y-3">
    <div className="flex items-center flex-wrap gap-2 text-xs"><Activity size={14} className="text-[var(--accent)]" /><h2 className="font-semibold mr-auto">Compute & memory</h2><span className="telemetry-source">{k8s.demo ? 'Simulated demo metrics' : 'Metrics API'} · 15s sampling</span><select aria-label="Metrics history range" className="ide-select" value={range} onChange={event => setRange(Number(event.target.value))}><option value={5}>Last 5 min</option><option value={15}>Last 15 min</option><option value={30}>Last 30 min</option></select><button aria-label="Refresh metrics" title="Refresh CPU/RAM metrics" disabled={state.loading} onClick={state.refresh} className="telemetry-icon-button"><RefreshCw size={14} className={state.loading ? 'animate-spin' : ''} /></button></div>
    {(errors.length > 0 || telemetry.stale) && <div role="status" className="telemetry-notice"><strong>{state.data ? 'Metrics incomplete or stale' : 'Usage metrics unavailable'}</strong><span>{errors.length ? errors.join(' · ') : 'The source sample is older than 2 minutes or its clock is ahead.'}</span>{!state.data && <span>Check that Metrics Server is available and your account can read metrics.k8s.io.</span>}</div>}
    <div className="telemetry-hero-grid">{(['cpu', 'memory'] as const).map(dimension => {
      const budget = telemetry.budgets[dimension];
      const reference = namespace ? budget.limit : budget.allocatable;
      const usage = telemetry[dimension];
      const percent = telemetry.complete && usage !== null && reference !== null && reference > 0 ? usage / reference * 100 : null;
      return <section key={dimension} aria-label={`${labels[dimension]} usage`} className="telemetry-card" style={{ '--telemetry-color': colors[dimension] } as React.CSSProperties}>
        <div className="telemetry-card-heading"><span className="telemetry-chip">{dimension === 'cpu' ? <Cpu size={16} /> : <MemoryStick size={16} />}</span><h3>{dimension === 'cpu' ? 'CPU utilization' : 'Memory working set'}</h3><span className={`telemetry-badge ${telemetry.stale || state.error ? 'is-stale' : ''}`}>{state.loading ? 'Refreshing' : telemetry.stale || state.error ? 'Stale' : usage === null ? 'No sample' : telemetry.complete ? 'Live' : 'Partial'}</span></div>
        <div className="telemetry-current"><div><div className="telemetry-value" data-testid={`metric-${dimension}-usage`}><AnimatedValue value={usage} dimension={dimension} /></div><p>{namespace ? 'Pod usage' : 'Node usage · includes system processes'}</p><span className="telemetry-coverage">{telemetry.coverage}</span></div><Gauge percent={percent} label={namespace ? 'of limits' : 'allocatable'} /></div>
        <HistoryChart history={state.history} dimension={dimension} minutes={range} />
        <div className="telemetry-budget-grid"><Budget label="Requests" value={format(dimension, budget.request)} percent={!namespace && budget.request !== null && budget.allocatable ? budget.request / budget.allocatable * 100 : null} /><Budget label="Limits" value={budget.unbounded ? `Unbounded · ${budget.unbounded} Pods` : format(dimension, budget.limit)} percent={!namespace && budget.limit !== null && budget.allocatable ? budget.limit / budget.allocatable * 100 : null} /><Budget label={namespace ? 'Measured usage' : 'Allocatable'} value={format(dimension, namespace ? usage : budget.allocatable)} percent={null} /></div>
        {!namespace && <div className="telemetry-capacity"><span>Physical capacity <b>{format(dimension, budget.capacity)}</b></span><span>Allocatable − usage{!telemetry.complete ? ' (unknown)' : ''} <b>{format(dimension, telemetry.complete && usage !== null && budget.allocatable !== null ? Math.max(0, budget.allocatable - usage) : null)}</b></span></div>}
      </section>;
    })}</div>
    <div className="telemetry-footnote"><span>CPU: average over the API sample window · RAM: working set, not requests.</span><span>{telemetry.newest ? `Source ${new Date(telemetry.newest).toLocaleTimeString()}` : 'Waiting for the first measurement'} · {state.history.length} samples</span></div>
    <section className="telemetry-ranking" aria-label="Resource consumers">
      <div className="telemetry-ranking-header"><div><h2>Resource consumers</h2><p>Measured usage, configured requests and limits</p></div><div role="group" aria-label="Consumer kind" className="telemetry-segment"><button aria-label="Rank Pods" aria-pressed={rankingMode === 'pods'} onClick={() => { setMode('pods');setLimit(10);setSelected(undefined); }}>Pods</button>{!namespace && <button aria-label="Rank Nodes" aria-pressed={rankingMode === 'nodes'} onClick={() => { setMode('nodes');setLimit(10);setSelected(undefined); }}>Nodes</button>}</div><div role="group" aria-label="Sort consumers" className="telemetry-segment"><button aria-pressed={sort === 'cpu'} onClick={() => setSort('cpu')}>CPU</button><button aria-pressed={sort === 'memory'} onClick={() => setSort('memory')}>RAM</button></div></div>
      {rows.length ? <><div className="telemetry-table-scroll kubiki-scrollbar"><table className="telemetry-table"><thead><tr><th>{rankingMode === 'pods' ? 'Pod / namespace' : 'Node'}</th><th>CPU <small>usage / requests / limits</small></th><th>RAM <small>usage / requests / limits</small></th></tr></thead><tbody>{rows.slice(0, limit).map(row => <tr key={`${row.namespace}/${row.name}`} tabIndex={0} aria-selected={selection === row} onClick={() => setSelected(`${row.namespace ?? ''}/${row.name}`)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault();setSelected(`${row.namespace ?? ''}/${row.name}`); } }}><td><span className="telemetry-consumer-name">{row.name}</span><small>{row.namespace ?? 'Cluster node'} · {row.containers.length ? `${row.containers.length} containers` : row.window}</small></td>{(['cpu', 'memory'] as const).map(dimension => {
        const config = row.item && rankingMode === 'pods' ? podBudget(row.item, dimension) : undefined;
        const denominator = rankingMode === 'nodes' && row.item ? quantity(row.item.raw?.status?.allocatable?.[dimension]) : config?.limit;
        const ratio = denominator && denominator > 0 ? row[dimension] / denominator * 100 : null;
        return <td key={dimension}><span className="telemetry-consumer-value" style={{ color: colors[dimension] }}>{format(dimension, row[dimension])}</span><small>{rankingMode === 'nodes' ? `of ${format(dimension, denominator ?? null)} allocatable` : `${format(dimension, config?.request ?? null)} / ${config && config.limit === null ? 'unbounded' : format(dimension, config?.limit ?? null)}`}</small><div className="telemetry-mini-track"><div style={{ width: `${ratio === null ? 0 : Math.min(100, ratio)}%`, background: ratio !== null && ratio > 90 ? 'var(--status-warn)' : colors[dimension] }} /></div></td>;
      })}</tr>)}</tbody></table></div>{rows.length > limit && <button className="telemetry-more" onClick={() => setLimit(value => value + 20)}>Show next 20 <ChevronDown size={13} /></button>}</> : <p className="telemetry-empty">{state.loading ? 'Collecting resource usage…' : 'No current usage samples in this scope. Pending or recently started Pods may not have metrics yet.'}</p>}
      {selection && <ConsumerDetails key={`${context}/${namespace}/${selected}`} row={selection} />}
    </section>
  </section>;
}
function Budget({ label, value, percent }: { label: string; value: string; percent: number | null }) {
  return <div title={label === 'Requests' ? 'Configured effective requests, including pending Pods' : label === 'Limits' ? 'Configured limits can exceed allocatable. Missing limits are unbounded.' : undefined}><span>{label}</span><strong>{value}</strong>{percent !== null && <small style={{ color: percent > 100 ? 'var(--status-warn)' : undefined }}>{percent.toFixed(1)}% of allocatable</small>}</div>;
}
function AnimatedValue({ value, dimension }: { value: number | null; dimension: Dimension }) {
  const [display, setDisplay] = useState(value);const current = useRef(value);
  useEffect(() => {
    const from = current.current;
    if (value === null || from === null || window.matchMedia('(prefers-reduced-motion: reduce)').matches) { current.current = value;setDisplay(value);return; }
    let frame: number;const start = performance.now();
    const tick = (now: number) => { const progress = Math.min(1, (now - start) / 180);const next = from + (value - from) * (1 - (1 - progress) ** 3);current.current = next;setDisplay(next);if (progress < 1) frame = requestAnimationFrame(tick); };
    frame = requestAnimationFrame(tick);return () => cancelAnimationFrame(frame);
  }, [value]);
  return <>{format(dimension, display)}</>;
}
function Gauge({ percent, label }: { percent: number | null; label: string }) {
  const radius = 34;const circumference = 2 * Math.PI * radius;
  return <div className="telemetry-gauge"><svg viewBox="0 0 84 84" role="img" aria-label={percent === null ? 'Utilization unavailable' : `${percent.toFixed(1)}% ${label}`}><circle cx="42" cy="42" r={radius} className="telemetry-gauge-track" /><circle cx="42" cy="42" r={radius} className="telemetry-gauge-fill" strokeDasharray={circumference} strokeDashoffset={circumference * (1 - Math.min(100, Math.max(0, percent ?? 0)) / 100)} /></svg><div><strong>{percent === null ? '—' : `${Math.round(percent)}%`}</strong><span>{label}</span></div></div>;
}
function HistoryChart({ history, dimension, minutes }: { history: HistoryPoint[]; dimension: Dimension; minutes: number }) {
  const id = useId().replace(/:/g, '');const [hover, setHover] = useState<number>();
  const end = history[history.length - 1]?.at ?? Date.now();const duration = Math.min(minutes * 60000, Math.max(15000, end - (history[0]?.at ?? end)));const start = end - duration;
  const points = history.filter(point => point.at >= start && point[dimension] !== null);
  const maximum = Math.max(dimension === 'cpu' ? 0.1 : 1024 ** 2, ...points.map(point => point[dimension]!)) * 1.2;
  const x = (at: number) => 12 + (at - start) / (end - start) * 496;
  const y = (value: number) => 120 - value / maximum * 104;
  const segments: HistoryPoint[][] = [];
  for (const point of points) { const last = segments[segments.length - 1];if (!last || point.at - last[last.length - 1].at > 45000) segments.push([point]);else last.push(point); }
  const selected = hover === undefined ? undefined : points[hover];
  return <div className="telemetry-chart">
    <div className="telemetry-chart-scale"><span>{format(dimension, maximum)}</span><span>0</span></div>
    <svg viewBox="0 0 520 150" role="img" aria-label={`${labels[dimension]} usage history`} data-samples={points.length} onPointerLeave={() => setHover(undefined)} onPointerMove={event => {
      const rect = event.currentTarget.getBoundingClientRect();const at = start + Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)) * (end - start);
      if (points.length) setHover(points.reduce((closest, point, index) => Math.abs(point.at - at) < Math.abs(points[closest].at - at) ? index : closest, 0));
    }}>
      <defs><linearGradient id={`area-${id}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--telemetry-color)" stopOpacity=".26" /><stop offset="100%" stopColor="var(--telemetry-color)" stopOpacity="0" /></linearGradient></defs>
      {[16, 51, 86, 120].map(position => <line key={position} x1="12" x2="508" y1={position} y2={position} className="telemetry-chart-grid" />)}
      {segments.map((segment, index) => {
        const path = segment.map((point, i) => `${i ? 'L' : 'M'}${x(point.at).toFixed(1)},${y(point[dimension]!).toFixed(1)}`).join(' ');
        return <g key={segment[0].at}><path d={`${path} L${x(segment[segment.length - 1].at)},120 L${x(segment[0].at)},120 Z`} fill={`url(#area-${id})`} /><path d={path} className="telemetry-chart-line" />{index === segments.length - 1 && <circle cx={x(segment[segment.length - 1].at)} cy={y(segment[segment.length - 1][dimension]!)} r="3.5" fill="var(--telemetry-color)" />}</g>;
      })}
      {selected && <g><line x1={x(selected.at)} x2={x(selected.at)} y1="12" y2="120" className="telemetry-chart-cursor" /><circle cx={x(selected.at)} cy={y(selected[dimension]!)} r="4.5" fill="var(--telemetry-color)" stroke="var(--bg-secondary)" strokeWidth="2" /></g>}
      <text x="12" y="145">−{duration < 60000 ? `${Math.round(duration / 1000)}s` : `${Number((duration / 60000).toFixed(1))}m`}</text><text x="508" y="145" textAnchor="end">{history.length ? new Date(end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'now'}</text>
    </svg>
    {points.length < 2 && <div className="telemetry-chart-collecting">{points.length ? 'Collecting history · next sample ~15s' : 'Waiting for metrics'}</div>}
    {selected && <output className="telemetry-chart-tooltip">{new Date(selected.at).toLocaleTimeString()} · {format(dimension, selected[dimension])}</output>}
  </div>;
}
function ConsumerDetails({ row }: { row: UsageRow }) {
  return <div className="telemetry-consumer-details"><div className="flex flex-wrap items-center gap-2"><h3 className="font-mono text-xs break-all flex-1">{row.name}</h3>{row.item && <button className="telemetry-details-link" onClick={() => useWorkspaceStore.getState().openResourceDetail(row.item!)}>Open resource <ArrowUpRight size={13} /></button>}</div><p className="text-xs text-[var(--text-muted)] mt-1">Sample {new Date(row.timestamp).toLocaleTimeString()} · CPU averaged over {row.window}</p>{row.containers.length > 0 && <div className="telemetry-container-grid">{row.containers.map(container => <div key={container.name}><strong className="font-mono break-all">{container.name}</strong><span style={{ color: colors.cpu }}>{cpuText(container.cpu)}</span><span style={{ color: colors.memory }}>{memoryText(container.memory)}</span></div>)}</div>}</div>;
}
