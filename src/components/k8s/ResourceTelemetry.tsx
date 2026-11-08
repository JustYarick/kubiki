import { Select } from '../ui/Select';
import { OverviewSection } from './OverviewSection';
import { Popover } from '../ui/Dropdown';
import { IconButton, Button } from '../ui/Button';
import { CheckboxRow } from '../ui/Checkbox';
import { Fragment, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Cpu, MemoryStick, RefreshCw, ChevronDown, ArrowUpRight, Settings2 } from 'lucide-react';
import type { ResourceItem } from '../../types/k8s';
import { useOverviewMetrics } from '../../providers/use_overview_metrics';
import { buildTelemetry, type Dimension, type HistoryPoint, type UsageRow } from '../../core/resources/telemetry';
import { fastCompare } from '../../core/resources/resource_sort';
import { cpuText, memoryText } from '../../core/resources/quantities';
import { useWorkspaceStore } from '../../state/workspace_store';
import { k8s } from '../../providers/k8s_provider';

const labels = { cpu: 'CPU', memory: 'RAM' };
const colors = { cpu: 'var(--chart-cpu)', memory: 'var(--chart-memory)' };
const format = (dimension: Dimension, value: number | null) => dimension === 'cpu' ? cpuText(value) : memoryText(value);
export function ResourceTelemetry({ context, namespace, pods, nodes, children }: { context: string; namespace: string | null; pods: ResourceItem[] | null; nodes: ResourceItem[] | null; children?: ReactNode }) {
  const [paused, setPaused] = useState(false);
  const [fixedScale, setFixedScale] = useState(false);
  const state = useOverviewMetrics(context, namespace, paused);
  const telemetry = useMemo(() => buildTelemetry(state.data, pods, nodes, namespace), [state.data, pods, nodes, namespace, state.loading]);
  const [range, setRange] = useState(15);
  const [mode, setMode] = useState<'pods' | 'nodes'>('pods');
  const [sort, setSort] = useState<Dimension>('cpu');
  const [limit, setLimit] = useState(5);
  const [selected, setSelected] = useState<string>();
  const rankingMode = namespace ? 'pods' : mode;
  const rows = useMemo(() => [...(rankingMode === 'pods' ? telemetry.podRows : telemetry.nodeRows)].sort((a, b) => b[sort] - a[sort] || fastCompare(a.name, b.name)), [rankingMode, telemetry, sort]);
  const maxima = useMemo(() => rows.reduce((max, row) => ({ cpu: Math.max(max.cpu, row.cpu), memory: Math.max(max.memory, row.memory) }), { cpu: 0, memory: 0 }), [rows]);
  const selection = rows.find(row => `${row.namespace ?? ''}/${row.name}` === selected);
  const errors = [state.error, state.data?.nodes.error?.message, state.data?.pods.error?.message].filter(Boolean);
  return <section aria-label="CPU and RAM telemetry" className="telemetry-section">
    <OverviewSection label="Compute and memory" title="Compute & memory" description={namespace ? `Pod usage · ${telemetry.coverage}` : `Node usage, including system processes · ${telemetry.coverage}`} actions={<>
      <Select aria-label="Metrics history range" className="ide-select" value={range} onChange={event => setRange(Number(event.target.value))}><option value={5}>Last 5 min</option><option value={15}>Last 15 min</option><option value={30}>Last 30 min</option></Select>
      <Button size="sm" variant="ghost" aria-label="Refresh metrics" title="Refresh CPU/RAM metrics" disabled={state.loading || paused} onClick={state.refresh}><RefreshCw size={14} className={state.loading ? 'animate-spin' : undefined} /></Button>
      <Popover width={250} align="end" trigger={() => <IconButton icon={Settings2} aria-label="Metrics display options" aria-haspopup="dialog" />}>
        {() => <div role="dialog" aria-label="Metrics display options" className="telemetry-options">
          <CheckboxRow label="Fixed scale" checked={fixedScale} onChange={event => setFixedScale(event.target.checked)} />
          <Button size="sm" aria-pressed={paused} onClick={() => setPaused(value => !value)}>{paused ? 'Resume metrics' : 'Pause metrics'}</Button>
        </div>}
      </Popover>
    </>}>
    {(errors.length > 0 || telemetry.stale) && <div role="status" className="telemetry-notice"><strong>{state.data ? 'Metrics incomplete or stale' : 'Usage metrics unavailable'}</strong><span>{errors.length ? errors.join(' · ') : 'The source sample is older than 2 minutes or its clock is ahead.'}</span>{!state.data && <span>Check that Metrics Server is available and your account can read metrics.k8s.io.</span>}</div>}
    <div className="telemetry-metrics">{(['cpu', 'memory'] as const).map(dimension => {
      const budget = telemetry.budgets[dimension];
      const reference = namespace ? budget.limit : budget.allocatable;
      const usage = telemetry[dimension];
      const percent = telemetry.complete && usage !== null && reference !== null && reference > 0 ? usage / reference * 100 : null;
      return <section key={dimension} aria-label={`${labels[dimension]} usage`} className="telemetry-metric" style={{ '--telemetry-color': colors[dimension] } as React.CSSProperties}>
        <div className="telemetry-metric-heading">
          <h3>{dimension === 'cpu' ? <Cpu size={14} aria-hidden="true" /> : <MemoryStick size={14} aria-hidden="true" />}{labels[dimension]}</h3>
          <span className="telemetry-value" data-testid={`metric-${dimension}-usage`}>{format(dimension, usage)}</span>
          <span className="telemetry-utilization">{namespace ? telemetry.coverage : percent === null ? 'Utilization unavailable' : `${percent.toFixed(1)}% of allocatable`}</span>
        </div>
        {!namespace && <div className="telemetry-usage-track" role={percent === null ? undefined : 'meter'} aria-label={`${labels[dimension]} utilization`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent === null ? undefined : Math.min(100, Math.max(0, percent))} aria-valuetext={percent === null ? undefined : `${percent.toFixed(1)}% of allocatable`}>
          {percent !== null && <span style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />}
        </div>}
        <HistoryChart history={state.history} dimension={dimension} minutes={range} reference={fixedScale ? reference : null} />
      </section>;
    })}</div>
    <div className="telemetry-footnote"><span>{k8s.demo ? 'Demo metrics' : 'Metrics API'} · {paused ? 'Paused' : '15s sampling'}</span><span>{telemetry.newest ? `Source ${new Date(telemetry.newest).toLocaleTimeString()}` : 'Waiting for the first measurement'} · {state.history.length} samples</span></div>
    </OverviewSection>
    {children}
    <OverviewSection className="telemetry-ranking" label="Resource consumers" title="Resource consumers" description="Highest measured usage · select a resource to inspect its containers" actions={<><div role="group" aria-label="Consumer kind" className="telemetry-segment"><button aria-label="Rank Pods" aria-pressed={rankingMode === 'pods'} onClick={() => { setMode('pods');setLimit(5);setSelected(undefined); }}>Pods</button>{!namespace && <button aria-label="Rank Nodes" aria-pressed={rankingMode === 'nodes'} onClick={() => { setMode('nodes');setLimit(5);setSelected(undefined); }}>Nodes</button>}</div><div role="group" aria-label="Sort consumers" className="telemetry-segment"><button aria-pressed={sort === 'cpu'} onClick={() => setSort('cpu')}>CPU</button><button aria-pressed={sort === 'memory'} onClick={() => setSort('memory')}>RAM</button></div></>}>
      {rows.length ? <><div className="telemetry-table-scroll kubiki-scrollbar"><table className="telemetry-table"><thead><tr><th>{rankingMode === 'pods' ? 'Pod / namespace' : 'Node'}</th><th>CPU usage</th><th>RAM usage</th></tr></thead><tbody>{rows.slice(0, limit).map(row => <Fragment key={`${row.namespace}/${row.name}`}><tr tabIndex={0} aria-selected={selection === row} onClick={() => setSelected(`${row.namespace ?? ''}/${row.name}`)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault();setSelected(`${row.namespace ?? ''}/${row.name}`); } }}><td><span className="telemetry-consumer-name">{row.name}</span><small>{row.namespace ?? 'Cluster node'} · {row.containers.length ? `${row.containers.length} containers` : row.window}</small></td>{(['cpu', 'memory'] as const).map(dimension => {
        const ratio = maxima[dimension] > 0 ? row[dimension] / maxima[dimension] * 100 : 0;
        return <td key={dimension}><span className="telemetry-consumer-value" style={{ color: colors[dimension] }}>{format(dimension, row[dimension])}</span><div className="telemetry-mini-track" aria-hidden="true"><div style={{ width: `${ratio}%`, background: colors[dimension] }} /></div></td>;
      })}</tr>{selection === row && <tr><td colSpan={3}><ConsumerDetails row={row} /></td></tr>}</Fragment>)}</tbody></table></div>{rows.length > limit && <button className="telemetry-more" onClick={() => setLimit(value => value + 20)}>Show next 20 <ChevronDown size={13} /></button>}</> : <p className="telemetry-empty">{state.loading ? 'Collecting resource usage…' : 'No current usage samples in this scope. Pending or recently started Pods may not have metrics yet.'}</p>}
    </OverviewSection>
  </section>;
}
export function HistoryChart({ history, dimension, minutes, reference }: { history: HistoryPoint[]; dimension: Dimension; minutes: number; reference: number | null }) {
  const id = useId().replace(/:/g, '');const [hover, setHover] = useState<number>();
  const svgRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ width: 520, height: 150 });
  useLayoutEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const measure = () => {
      const rect = svg.getBoundingClientRect();
      if (rect.width <= 24 || rect.height <= 32) return;
      setSize(previous => previous.width === rect.width && previous.height === rect.height ? previous : { width: rect.width, height: rect.height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(svg);
    return () => observer.disconnect();
  }, []);
  const leftEdge = 12;
  const rightEdge = size.width - 12;
  const baseline = size.height - 20;
  const end = history[history.length - 1]?.at ?? Date.now();const duration = Math.min(minutes * 60000, Math.max(15000, end - (history[0]?.at ?? end)));const start = end - duration;
  const points = history.filter(point => point.at >= start && point[dimension] !== null);
  const maximum = reference !== null && reference > 0 ? reference : Math.max(dimension === 'cpu' ? 0.1 : 1024 ** 2, ...points.map(point => point[dimension]!)) * 1.2;
  const values = points.map(point => point[dimension]!);
  const average = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const x = (at: number) => leftEdge + (at - start) / (end - start) * (rightEdge - leftEdge);
  const y = (value: number) => baseline - Math.min(1, value / maximum) * (baseline - 12);
  // Connect observed values across pauses; only actual samples enter history or tooltips.
  const initial = points.length === 1;
  const left = !points.length || initial ? leftEdge : x(points[0].at);
  const right = !points.length || initial ? rightEdge : x(points[points.length - 1].at);
  const path = initial ? `M${left.toFixed(1)},${y(points[0][dimension]!).toFixed(1)} L${right.toFixed(1)},${y(points[0][dimension]!).toFixed(1)}` : points.map((point, i) => `${i ? 'L' : 'M'}${x(point.at).toFixed(1)},${y(point[dimension]!).toFixed(1)}`).join(' ');
  const selected = hover === undefined ? undefined : points[hover];
  return <div className="telemetry-chart">
    <svg ref={svgRef} viewBox={`0 0 ${size.width} ${size.height}`} preserveAspectRatio="xMidYMid meet" role="img" tabIndex={0} aria-describedby={`history-help-${id}`} onFocus={() => { if (points.length) setHover(points.length - 1); }} onBlur={() => setHover(undefined)} onKeyDown={event => {
      if (!points.length || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      setHover(index => event.key === 'Home' ? 0 : event.key === 'End' ? points.length - 1 : Math.min(points.length - 1, Math.max(0, (index ?? points.length - 1) + (event.key === 'ArrowRight' ? 1 : -1))));
    }} aria-label={`${labels[dimension]} usage history`} data-samples={points.length} onPointerLeave={event => { if (document.activeElement !== event.currentTarget) setHover(undefined); }} onPointerMove={event => {
      const rect = event.currentTarget.getBoundingClientRect();
      const localX = (event.clientX - rect.left) / rect.width * size.width;
      const at = start + Math.min(1, Math.max(0, (localX - leftEdge) / (rightEdge - leftEdge))) * (end - start);
      if (points.length) setHover(points.reduce((closest, point, index) => Math.abs(point.at - at) < Math.abs(points[closest].at - at) ? index : closest, 0));
    }}>
      <defs><linearGradient id={`area-${id}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--telemetry-color)" stopOpacity=".12" /><stop offset="100%" stopColor="var(--telemetry-color)" stopOpacity="0" /></linearGradient></defs>
      <line x1={leftEdge} x2={rightEdge} y1={baseline} y2={baseline} className="telemetry-chart-grid" />
      {points.length > 0 && <g><path d={`${path} L${right},${baseline} L${left},${baseline} Z`} fill={`url(#area-${id})`} /><path d={path} className="telemetry-chart-line" />{initial && <circle className="telemetry-chart-sample" cx={x(points[0].at)} cy={y(points[0][dimension]!)} r="2.5" fill="var(--telemetry-color)" />}</g>}
      {selected && <g><line x1={x(selected.at)} x2={x(selected.at)} y1="12" y2={baseline} className="telemetry-chart-cursor" /><circle className="telemetry-chart-hover-point" cx={x(selected.at)} cy={y(selected[dimension]!)} r="4.5" fill="var(--telemetry-color)" stroke="var(--bg-secondary)" strokeWidth="2" /></g>}
    </svg>
    <div className="telemetry-chart-times"><span>−{duration < 60000 ? `${Math.round(duration / 1000)}s` : `${Number((duration / 60000).toFixed(1))}m`}</span>{reference !== null && reference > 0 && <span title="Values above the fixed scale are clipped">Fixed scale</span>}<span>{history.length ? new Date(end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'now'}</span></div>
    {points.length < 2 && <div className="telemetry-chart-collecting">{points.length ? 'First measurement · next sample ~15s' : 'Waiting for metrics'}</div>}
    {selected && <output aria-live="polite" className="telemetry-chart-tooltip">{new Date(selected.at).toLocaleTimeString()} · {format(dimension, selected[dimension])}</output>}
    <p id={`history-help-${id}`} className="sr-only">{labels[dimension]} history: minimum {format(dimension, values.length ? Math.min(...values) : null)}, average {format(dimension, average)}, maximum {format(dimension, values.length ? Math.max(...values) : null)}. {reference !== null && reference > 0 ? 'Fixed to budget · values above budget are clipped' : 'Auto scale'} · ← → inspect samples · Home / End</p>
  </div>;
}
function ConsumerDetails({ row }: { row: UsageRow }) {
  return <div className="telemetry-consumer-details"><div className="flex flex-wrap items-center gap-2"><h3 className="font-mono text-xs break-all flex-1">{row.name}</h3>{row.item && <button className="telemetry-details-link" onClick={() => useWorkspaceStore.getState().openResourceDetail(row.item!)}>Open resource <ArrowUpRight size={13} /></button>}</div><p className="text-xs text-[var(--text-muted)] mt-1">Sample {new Date(row.timestamp).toLocaleTimeString()} · CPU averaged over {row.window}</p>{row.containers.length > 0 && <div className="telemetry-container-grid">{row.containers.map(container => <div key={container.name}><strong className="font-mono break-all">{container.name}</strong><span style={{ color: colors.cpu }}>{cpuText(container.cpu)}</span><span style={{ color: colors.memory }}>{memoryText(container.memory)}</span></div>)}</div>}</div>;
}
