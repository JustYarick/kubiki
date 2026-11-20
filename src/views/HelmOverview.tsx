import { useMemo, type ReactNode } from 'react';
import { ArrowRight, CheckCircle2, Clock3, Layers3, LayoutDashboard, Package, TriangleAlert, type LucideIcon } from 'lucide-react';
import { OverviewSection } from '../components/k8s/OverviewSection';
import { helmStatusTone, helmUpdatedAt, type HelmRelease } from '../providers/helm_types';
import type { ColumnFilters } from '../core/resources/column_filters';
import './overview.css';
import './helm-overview.css';

interface Props {
  context: string;
  releases: readonly HelmRelease[] | null;
  updated?: number;
  loading: boolean;
  partial: boolean;
  stale: boolean;
  fromCache?: boolean;
  actions: ReactNode;
  onBrowse: (filters?: ColumnFilters) => void;
  onInspect: (release: HelmRelease) => void;
}

const countFilter = (column: string, values: string[]): ColumnFilters => ({ [column]: { include: values, exclude: [] } });
const pendingStatuses = ['pending-install', 'pending-upgrade', 'pending-rollback', 'uninstalling'];
const progressing = (status: string) => status.startsWith('pending-') || status === 'uninstalling';
const statusGroup = (status: string) => status === 'deployed' ? 0 : progressing(status) ? 1 : status === 'failed' ? 2 : 3;
const BREAKDOWN_LIMIT = 6;
const groups = [
  { label: 'Deployed', tone: 'ok', color: 'var(--status-ok)' },
  { label: 'In progress', tone: 'warn', color: 'var(--status-warn)' },
  { label: 'Failed', tone: 'danger', color: 'var(--status-danger)' },
  { label: 'Other', tone: 'neutral', color: 'var(--text-muted)' },
] as const;

export function HelmOverview({ context, releases, updated, loading, partial, stale, fromCache = false, actions, onBrowse, onInspect }: Props) {
  const summary = useMemo(() => {
    const namespaces = new Map<string, { name: string; total: number; counts: number[] }>();
    const charts = new Map<string, number>();
    const counts = [0, 0, 0, 0];
    const statuses: string[][] = [[], [], [], []];
    let changed = 0;
    for (const release of releases ?? []) {
      const index = statusGroup(release.status);
      counts[index]++;
      if (!statuses[index].includes(release.status)) statuses[index].push(release.status);
      const namespace = namespaces.get(release.namespace) ?? { name: release.namespace, total: 0, counts: [0, 0, 0, 0] };
      namespace.total++; namespace.counts[index]++;
      namespaces.set(release.namespace, namespace);
      charts.set(release.chart, (charts.get(release.chart) ?? 0) + 1);
      const time = helmUpdatedAt(release.updated);
      if (updated && time > 0 && time <= updated && time >= updated - 86400000) changed++;
    }
    const recent = [...(releases ?? [])].sort((a, b) => helmUpdatedAt(b.updated) - helmUpdatedAt(a.updated) || a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name)).slice(0, 8);
    return {
      namespaces: [...namespaces.values()].sort((a, b) => b.counts[2] - a.counts[2] || b.counts[1] - a.counts[1] || b.total - a.total || a.name.localeCompare(b.name)),
      charts: [...charts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
      counts, statuses, recent, changed,
    };
  }, [releases, updated]);

  const total = releases?.length ?? 0;
  const known = releases !== null;
  const value = (count: number) => known ? count.toLocaleString() : '—';
  const deployedPercent = total ? Math.round(summary.counts[0] / total * 100) : 0;
  const pending = summary.statuses[1].length ? summary.statuses[1] : pendingStatuses;
  const readState = stale && known
    ? 'Last available snapshot'
    : fromCache && loading && known
      ? 'Cached · updating…'
      : partial
        ? 'Partial inventory'
        : loading
          ? 'Refreshing inventory'
          : updated
            ? 'Updated'
            : 'Inventory unavailable';
  const topChartCount = summary.charts[0]?.[1] ?? 1;

  return <div className="overview-page helm-overview-page kubiki-scrollbar">
    <header className="helm-dashboard-heading">
      <div className="helm-dashboard-title">
        <h1><LayoutDashboard size={16} aria-hidden="true" />Helm Overview</h1>
        <div className="helm-dashboard-eyebrow">
          <span className="helm-cluster-name" title={context}>{context}</span>
          <span>All namespaces</span>
        </div>
      </div>
      <div className="helm-dashboard-controls">
        <div className="helm-snapshot" data-warning={partial || stale || (fromCache && loading && known)} role="status">
          <span className="helm-status-dot" aria-hidden="true" />
          <span>{readState}</span>
          {updated && (!loading || fromCache) ? <time dateTime={new Date(updated).toISOString()} title={new Date(updated).toLocaleString()}>{new Date(updated).toLocaleTimeString()}</time> : null}
        </div>
        <div className="helm-dashboard-actions">{actions}</div>
      </div>
    </header>

    <section aria-label="Helm summary" className="helm-cluster-summary">
      <div className="helm-kpis">
        <Metric icon={Package} label="Releases" value={value(total)} detail={partial ? 'In accessible namespaces' : 'Across the cluster'} onClick={() => onBrowse()} />
        <Metric icon={CheckCircle2} label="Deployed" value={value(summary.counts[0])} detail={total ? `${deployedPercent}% of releases` : 'Completed Helm operations'} tone={summary.counts[0] ? 'ok' : undefined} onClick={() => onBrowse(countFilter('status', ['deployed']))} />
        <Metric icon={Clock3} label="In progress" value={value(summary.counts[1])} detail="Install · upgrade · rollback · uninstall" tone={summary.counts[1] ? 'warn' : undefined} onClick={() => onBrowse(countFilter('status', pending))} />
        <Metric icon={TriangleAlert} label="Failed" value={value(summary.counts[2])} detail="Latest Helm operation failed" tone={summary.counts[2] ? 'danger' : undefined} onClick={() => onBrowse(countFilter('status', ['failed']))} />
      </div>
      <section aria-label="Helm release status" className="helm-status-distribution">
        <StatusBar counts={summary.counts} total={total} label={known ? `${total} releases: ${groups.map((group, index) => `${summary.counts[index]} ${group.label.toLowerCase()}`).join(', ')}` : 'Release status unavailable'} />
        <div className="helm-status-caption">
          <div className="helm-status-legend">
            {groups.map((group, index) => <button key={group.label} disabled={!summary.counts[index]} onClick={() => onBrowse(countFilter('status', summary.statuses[index]))} title={summary.statuses[index].join(', ')}>
              <span className="helm-status-dot" style={{ background: group.color }} aria-hidden="true" />{group.label}<strong>{value(summary.counts[index])}</strong>
            </button>)}
          </div>
          <span className="helm-status-note">Helm operation status · workload health is separate</span>
        </div>
      </section>
      <dl className="helm-inventory-facts">
        <div><dt>Namespaces with releases</dt><dd>{value(summary.namespaces.length)}</dd></div>
        <div><dt>Installed chart versions</dt><dd>{value(summary.charts.length)}</dd></div>
        <div><dt>Releases updated in 24h</dt><dd>{updated ? value(summary.changed) : '—'}</dd></div>
      </dl>
    </section>

    {!known ? <div className="helm-dashboard-empty"><Package size={26} aria-hidden="true" /><h2>{loading ? 'Reading Helm inventory…' : 'Helm inventory unavailable'}</h2><p>{loading ? 'Collecting release state across all namespaces.' : 'Retry the inventory read to see release counts and status.'}</p></div> : total === 0 ? <div className="helm-dashboard-empty"><Package size={26} aria-hidden="true" /><h2>{partial ? 'No releases in accessible namespaces' : 'No Helm releases yet'}</h2><p>{partial ? 'Some namespaces could not be read. Their releases are not included.' : 'Installed releases and their status will appear here.'}</p></div> : <>
      <div className="helm-overview-grid">
        <OverviewSection label="Helm namespaces" title="Namespace health" description="Status by namespace · failed operations first" actions={<span className="helm-section-count">{summary.namespaces.length} namespaces</span>}>
          <div className="helm-namespace-columns" aria-hidden="true"><span>Namespace</span><span>Release status</span><span>Releases</span></div>
          <div className="helm-namespace-list">
            {summary.namespaces.slice(0, BREAKDOWN_LIMIT).map(namespace => <button key={namespace.name} className="helm-namespace-row" aria-label={`${namespace.name}: ${namespace.total} releases, ${namespace.counts[2]} failed, ${namespace.counts[1]} in progress`} onClick={() => onBrowse(countFilter('namespace', [namespace.name]))}>
              <span className="helm-namespace-name"><span title={namespace.name}>{namespace.name}</span><small data-tone={namespace.counts[2] ? 'danger' : namespace.counts[1] ? 'warn' : 'neutral'}>{namespace.counts[2] ? `${namespace.counts[2]} failed` : namespace.counts[1] ? `${namespace.counts[1]} in progress` : `${namespace.counts[0]} deployed`}</small></span>
              <StatusBar counts={namespace.counts} total={namespace.total} />
              <strong>{namespace.total}</strong><ArrowRight size={13} className="helm-row-arrow" aria-hidden="true" />
            </button>)}
          </div>
          <div className="helm-card-footer">
            <span>{summary.namespaces.length > BREAKDOWN_LIMIT ? `Top ${BREAKDOWN_LIMIT} of ${summary.namespaces.length} namespaces` : `${summary.namespaces.length} namespace${summary.namespaces.length === 1 ? '' : 's'}`}</span>
            {summary.namespaces.length > BREAKDOWN_LIMIT && <button className="helm-section-link" onClick={() => onBrowse()}>View all {summary.namespaces.length} namespaces in releases<ArrowRight size={12} aria-hidden="true" /></button>}
          </div>
        </OverviewSection>

        <OverviewSection label="Helm charts" title="Chart footprint" description={`${summary.charts.length} installed chart version${summary.charts.length === 1 ? '' : 's'}`} actions={<Layers3 size={15} className="helm-section-icon" aria-hidden="true" />}>
          <div className="helm-chart-columns" aria-hidden="true"><span>Chart version</span><span>Share</span><span>Releases</span></div>
          <div className="helm-chart-list">
            {summary.charts.slice(0, BREAKDOWN_LIMIT).map(([chart, count]) => {
              const share = total ? count / total * 100 : 0;
              const shareLabel = share > 0 && share < 1 ? '<1%' : `${Math.round(share)}%`;
              return <button key={chart} className="helm-chart-row" onClick={() => onBrowse(countFilter('chart', [chart]))}>
                <span className="helm-chart-identity">
                  <Package size={13} aria-hidden="true" />
                  <span className="helm-chart-text">
                    <span className="helm-chart-name" title={chart}>{chart || 'Unknown chart'}</span>
                    <small>{shareLabel} of releases</small>
                  </span>
                </span>
                <span className="helm-chart-track" aria-hidden="true"><span style={{ width: `${Math.max(5, Math.round(count / topChartCount * 100))}%` }} /></span>
                <strong>{count}</strong><ArrowRight size={13} className="helm-row-arrow" aria-hidden="true" />
              </button>;
            })}
          </div>
          <div className="helm-card-footer">
            <span>Releases per chart version{summary.charts.length > BREAKDOWN_LIMIT ? ` · top ${BREAKDOWN_LIMIT} of ${summary.charts.length}` : ''}</span>
            <span className="helm-card-hint">Click row to filter</span>
          </div>
        </OverviewSection>
      </div>

      <OverviewSection label="Helm recent updates" title="Latest release changes" description="Most recent revision of each release" className="helm-changes-section" actions={<button className="helm-section-link" onClick={() => onBrowse()}>View all releases<ArrowRight size={12} aria-hidden="true" /></button>}>
        <div className="helm-changes-columns" aria-hidden="true"><span>Release</span><span>Namespace</span><span>Chart</span><span>Status</span><span>Rev</span><span>Updated</span><span /></div>
        {summary.recent.map(release => {
          const time = helmUpdatedAt(release.updated);
          return <button key={`${release.namespace}/${release.name}`} className="helm-change-row" aria-label={`Inspect ${release.name} in ${release.namespace}`} onClick={() => onInspect(release)}>
            <span className="helm-change-identity"><strong title={release.name}>{release.name}</strong><small className="helm-change-ns-compact">{release.namespace}</small></span>
            <span className="helm-change-namespace" title={release.namespace}>{release.namespace}</span>
            <span className="helm-change-chart" title={release.chart}>{release.chart}</span>
            <span className={`helm-change-status ${helmStatusTone(release.status)}`}><span className="helm-status-dot" aria-hidden="true" />{release.status}</span>
            <span className="helm-change-revision">r{release.revision}</span>
            <span className="helm-change-time">{time ? <time dateTime={new Date(time).toISOString()} title={new Date(time).toLocaleString()}>{new Date(time).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time> : 'Unknown'}</span>
            <ArrowRight size={13} className="helm-row-arrow" aria-hidden="true" />
          </button>;
        })}
      </OverviewSection>
    </>}
  </div>;
}

function Metric({ icon: Icon, label, value, detail, tone, onClick }: { icon: LucideIcon; label: string; value: string; detail: string; tone?: string; onClick: () => void }) {
  return <button className="helm-kpi" aria-label={`${label}: ${value}`} onClick={onClick} data-tone={tone}>
    <div className="helm-kpi-label"><Icon size={14} aria-hidden="true" /><span>{label}</span><ArrowRight size={12} aria-hidden="true" /></div>
    <div className="helm-kpi-value">{value}</div>
    <div className="helm-kpi-detail">{detail}</div>
  </button>;
}

function StatusBar({ counts, total, label }: { counts: number[]; total: number; label?: string }) {
  return <div className="helm-status-bar" role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
    {counts.map((count, index) => count > 0 && <span key={groups[index].label} style={{ flexGrow: count, flexBasis: 0, background: groups[index].color }} title={`${groups[index].label}: ${count} / ${total}`} />)}
  </div>;
}
