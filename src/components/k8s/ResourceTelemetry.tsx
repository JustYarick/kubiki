import { OverviewSection } from './OverviewSection';
import { Popover } from '../ui/Dropdown';
import { IconButton, Button } from '../ui/Button';
import { CheckboxRow } from '../ui/Checkbox';
import { Fragment, useId, useMemo, useState } from 'react';
import { Cpu, MemoryStick, RefreshCw, ChevronDown, ArrowUpRight, Settings2 } from 'lucide-react';
import type { ResourceItem } from '../../types/k8s';
import { useOverviewMetrics } from '../../providers/use_overview_metrics';
import { buildTelemetry, podBudget, type Dimension, type HistoryPoint, type UsageRow } from '../../core/resources/telemetry';
import { cpuText, memoryText, quantity } from '../../core/resources/quantities';
import { useWorkspaceStore } from '../../state/workspace_store';
import { k8s } from '../../providers/k8s_provider';

const labels = { cpu: 'CPU', memory: 'RAM' };
const colors = { cpu: 'var(--chart-cpu)', memory: 'var(--chart-memory)' };
const format = (dimension: Dimension, value: number | null) => dimension === 'cpu' ? cpuText(value) : memoryText(value);
export function ResourceTelemetry({ context, namespace, pods, nodes }: { context: string; namespace: string | null; pods: ResourceItem[] | null; nodes: ResourceItem[] | null }) {
  const [paused, setPaused] = useState(false);
  const [fixedScale, setFixedScale] = useState(false);
  const state = useOverviewMetrics(context, namespace, data => buildTelemetry(data, pods, nodes, namespace).point, paused);
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
  return <section aria-label="CPU and RAM telemetry" className="telemetry-section">
    <OverviewSection label="Compute and memory" title="Compute & memory" description={namespace ? `Pod usage · ${telemetry.coverage}` : `Node usage, including system processes · ${telemetry.coverage}`} actions={<>
      <select aria-label="Metrics history range" className="ide-select" value={range} onChange={event => setRange(Number(event.target.value))}><option value={5}>Last 5 min</option><option value={15}>Last 15 min</option><option value={30}>Last 30 min</option></select>
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
          <span className="telemetry-utilization">{percent === null ? 'Utilization unavailable' : `${percent.toFixed(1)}% ${namespace ? 'of limits' : 'of allocatable'}`}</span>
        </div>
        <div className="telemetry-usage-track" role={percent === null ? undefined : 'meter'} aria-label={`${labels[dimension]} utilization`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent === null ? undefined : Math.min(100, Math.max(0, percent))} aria-valuetext={percent === null ? undefined : `${percent.toFixed(1)}% ${namespace ? 'of limits' : 'of allocatable'}`}>
          {percent !== null && <span style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />}
        </div>
        <dl className="telemetry-budgets">
          <Budget label="Requests" value={format(dimension, budget.request)} percent={!namespace && budget.request !== null && budget.allocatable ? budget.request / budget.allocatable * 100 : null} />
          <Budget label="Limits" value={budget.unbounded ? `Unbounded · ${budget.unbounded} Pods` : format(dimension, budget.limit)} percent={!namespace && budget.limit !== null && budget.allocatable ? budget.limit / budget.allocatable * 100 : null} />
          {!namespace && <>
            <Budget label="Allocatable" value={format(dimension, budget.allocatable)} percent={null} />
            <Budget label="Capacity" value={format(dimension, budget.capacity)} percent={null} />
            <Budget label="Available" value={format(dimension, telemetry.complete && usage !== null && budget.allocatable !== null ? Math.max(0, budget.allocatable - usage) : null)} percent={null} />
          </>}
        </dl>
        <details className="telemetry-history"><summary>{labels[dimension]} history</summary><HistoryChart history={state.history} dimension={dimension} minutes={range} reference={fixedScale ? reference : null} /></details>
      </section>;
    })}</div>
    <div className="telemetry-footnote"><span>{k8s.demo ? 'Demo metrics' : 'Metrics API'} · {paused ? 'Paused' : '15s sampling'}</span><span>{telemetry.newest ? `Source ${new Date(telemetry.newest).toLocaleTimeString()}` : 'Waiting for the first measurement'} · {state.history.length} samples</span></div>
    </OverviewSection>
    <OverviewSection className="telemetry-ranking" label="Resource consumers" title="Resource consumers" description="Measured usage, requests and limits" actions={<><div role="group" aria-label="Consumer kind" className="telemetry-segment"><button aria-label="Rank Pods" aria-pressed={rankingMode === 'pods'} onClick={() => { setMode('pods');setLimit(10);setSelected(undefined); }}>Pods</button>{!namespace && <button aria-label="Rank Nodes" aria-pressed={rankingMode === 'nodes'} onClick={() => { setMode('nodes');setLimit(10);setSelected(undefined); }}>Nodes</button>}</div><div role="group" aria-label="Sort consumers" className="telemetry-segment"><button aria-pressed={sort === 'cpu'} onClick={() => setSort('cpu')}>CPU</button><button aria-pressed={sort === 'memory'} onClick={() => setSort('memory')}>RAM</button></div></>}>
      {rows.length ? <><div className="telemetry-table-scroll kubiki-scrollbar"><table className="telemetry-table"><thead><tr><th>{rankingMode === 'pods' ? 'Pod / namespace' : 'Node'}</th><th>CPU <small>usage / requests / limits</small></th><th>RAM <small>usage / requests / limits</small></th></tr></thead><tbody>{rows.slice(0, limit).map(row => <Fragment key={`${row.namespace}/${row.name}`}><tr tabIndex={0} aria-selected={selection === row} onClick={() => setSelected(`${row.namespace ?? ''}/${row.name}`)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault();setSelected(`${row.namespace ?? ''}/${row.name}`); } }}><td><span className="telemetry-consumer-name">{row.name}</span><small>{row.namespace ?? 'Cluster node'} · {row.containers.length ? `${row.containers.length} containers` : row.window}</small></td>{(['cpu', 'memory'] as const).map(dimension => {
        const config = row.item && rankingMode === 'pods' ? podBudget(row.item, dimension) : undefined;
        const denominator = rankingMode === 'nodes' && row.item ? quantity(row.item.raw?.status?.allocatable?.[dimension]) : config?.limit;
        const ratio = denominator && denominator > 0 ? row[dimension] / denominator * 100 : null;
        return <td key={dimension}><span className="telemetry-consumer-value" style={{ color: colors[dimension] }}>{format(dimension, row[dimension])}</span><small>{rankingMode === 'nodes' ? `of ${format(dimension, denominator ?? null)} allocatable` : `${format(dimension, config?.request ?? null)} / ${config && config.limit === null ? 'unbounded' : format(dimension, config?.limit ?? null)}`}</small><div className="telemetry-mini-track"><div style={{ width: `${ratio === null ? 0 : Math.min(100, ratio)}%`, background: ratio !== null && ratio > 90 ? 'var(--status-warn)' : colors[dimension] }} /></div></td>;
      })}</tr>{selection === row && <tr><td colSpan={3}><ConsumerDetails row={row} /></td></tr>}</Fragment>)}</tbody></table></div>{rows.length > limit && <button className="telemetry-more" onClick={() => setLimit(value => value + 20)}>Show next 20 <ChevronDown size={13} /></button>}</> : <p className="telemetry-empty">{state.loading ? 'Collecting resource usage…' : 'No current usage samples in this scope. Pending or recently started Pods may not have metrics yet.'}</p>}
    </OverviewSection>
  </section>;
}
function Budget({ label, value, percent }: { label: string; value: string; percent: number | null }) {
  return <div title={label === 'Requests' ? 'Configured effective requests, including pending Pods' : label === 'Limits' ? 'Configured limits can exceed allocatable. Missing limits are unbounded.' : undefined}><dt>{label}</dt><dd>{value}</dd>{percent !== null && <small style={{ color: percent > 100 ? 'var(--status-warn)' : undefined }}>{percent.toFixed(1)}% of allocatable</small>}</div>;
}
function HistoryChart({ history, dimension, minutes, reference }: { history: HistoryPoint[]; dimension: Dimension; minutes: number; reference: number | null }) {
  const id = useId().replace(/:/g, '');const [hover, setHover] = useState<number>();
  const end = history[history.length - 1]?.at ?? Date.now();const duration = Math.min(minutes * 60000, Math.max(15000, end - (history[0]?.at ?? end)));const start = end - duration;
  const points = history.filter(point => point.at >= start && point[dimension] !== null);
  const maximum = reference !== null && reference > 0 ? reference : Math.max(dimension === 'cpu' ? 0.1 : 1024 ** 2, ...points.map(point => point[dimension]!)) * 1.2;
  const values = points.map(point => point[dimension]!);
  const average = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const x = (at: number) => 12 + (at - start) / (end - start) * 496;
  const y = (value: number) => 120 - Math.min(1, value / maximum) * 104;
  const segments: HistoryPoint[][] = [];
  for (const point of points) { const last = segments[segments.length - 1];if (!last || point.at - last[last.length - 1].at > 45000) segments.push([point]);else last.push(point); }
  const selected = hover === undefined ? undefined : points[hover];
  return <div className="telemetry-chart">
    <div className="telemetry-chart-scale"><span>{format(dimension, maximum)}</span><span>0</span></div>
    <svg viewBox="0 0 520 150" preserveAspectRatio="none" role="img" tabIndex={0} aria-describedby={`history-help-${id}`} onFocus={() => { if (points.length) setHover(points.length - 1); }} onBlur={() => setHover(undefined)} onKeyDown={event => {
      if (!points.length || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      setHover(index => event.key === 'Home' ? 0 : event.key === 'End' ? points.length - 1 : Math.min(points.length - 1, Math.max(0, (index ?? points.length - 1) + (event.key === 'ArrowRight' ? 1 : -1))));
    }} aria-label={`${labels[dimension]} usage history`} data-samples={points.length} onPointerLeave={() => setHover(undefined)} onPointerMove={event => {
      const rect = event.currentTarget.getBoundingClientRect();const at = start + Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)) * (end - start);
      if (points.length) setHover(points.reduce((closest, point, index) => Math.abs(point.at - at) < Math.abs(points[closest].at - at) ? index : closest, 0));
    }}>
      <defs><linearGradient id={`area-${id}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--telemetry-color)" stopOpacity=".10" /><stop offset="100%" stopColor="var(--telemetry-color)" stopOpacity="0" /></linearGradient></defs>
      {[16, 68, 120].map(position => <line key={position} x1="12" x2="508" y1={position} y2={position} className="telemetry-chart-grid" />)}
      {segments.map((segment, index) => {
        const path = segment.map((point, i) => `${i ? 'L' : 'M'}${x(point.at).toFixed(1)},${y(point[dimension]!).toFixed(1)}`).join(' ');
        return <g key={segment[0].at}><path d={`${path} L${x(segment[segment.length - 1].at)},120 L${x(segment[0].at)},120 Z`} fill={`url(#area-${id})`} /><path d={path} className="telemetry-chart-line" />{index === segments.length - 1 && <circle cx={x(segment[segment.length - 1].at)} cy={y(segment[segment.length - 1][dimension]!)} r="3.5" fill="var(--telemetry-color)" />}</g>;
      })}
      {selected && <g><line x1={x(selected.at)} x2={x(selected.at)} y1="12" y2="120" className="telemetry-chart-cursor" /><circle cx={x(selected.at)} cy={y(selected[dimension]!)} r="4.5" fill="var(--telemetry-color)" stroke="var(--bg-secondary)" strokeWidth="2" /></g>}
    </svg>
    <div className="telemetry-chart-times"><span>−{duration < 60000 ? `${Math.round(duration / 1000)}s` : `${Number((duration / 60000).toFixed(1))}m`}</span><span>{history.length ? new Date(end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'now'}</span></div>
    {points.length < 2 && <div className="telemetry-chart-collecting">{points.length ? 'Collecting history · next sample ~15s' : 'Waiting for metrics'}</div>}
    {selected && <output aria-live="polite" className="telemetry-chart-tooltip">{new Date(selected.at).toLocaleTimeString()} · {format(dimension, selected[dimension])}</output>}
    <p id={`history-help-${id}`} className="telemetry-history-help">{reference !== null && reference > 0 ? 'Fixed to budget · values above budget are clipped' : 'Auto scale'} · ← → inspect samples · Home / End</p>
    <div className="telemetry-history-stats" aria-label={`${labels[dimension]} history statistics`}>
      <span>Min <b>{format(dimension, values.length ? Math.min(...values) : null)}</b></span><span>Avg <b>{format(dimension, average)}</b></span><span>Max <b>{format(dimension, values.length ? Math.max(...values) : null)}</b></span><span>Last <b>{format(dimension, values[values.length - 1] ?? null)}</b></span>
    </div>
    <details className="telemetry-history-data"><summary>{labels[dimension]} sample data ({points.length})</summary><div className="max-h-48 overflow-auto kubiki-scrollbar"><table><caption className="sr-only">{labels[dimension]} history, measured samples only</caption><thead><tr><th>Time</th><th>{labels[dimension]}</th></tr></thead><tbody>{points.map(point => <tr key={point.at}><td>{new Date(point.at).toLocaleTimeString()}</td><td>{format(dimension, point[dimension])}</td></tr>)}</tbody></table></div></details>
  </div>;
}
function ConsumerDetails({ row }: { row: UsageRow }) {
  return <div className="telemetry-consumer-details"><div className="flex flex-wrap items-center gap-2"><h3 className="font-mono text-xs break-all flex-1">{row.name}</h3>{row.item && <button className="telemetry-details-link" onClick={() => useWorkspaceStore.getState().openResourceDetail(row.item!)}>Open resource <ArrowUpRight size={13} /></button>}</div><p className="text-xs text-[var(--text-muted)] mt-1">Sample {new Date(row.timestamp).toLocaleTimeString()} · CPU averaged over {row.window}</p>{row.containers.length > 0 && <div className="telemetry-container-grid">{row.containers.map(container => <div key={container.name}><strong className="font-mono break-all">{container.name}</strong><span style={{ color: colors.cpu }}>{cpuText(container.cpu)}</span><span style={{ color: colors.memory }}>{memoryText(container.memory)}</span></div>)}</div>}</div>;
}
