import { useId, useState } from 'react';
import {
  Activity,
  ArrowRight,
  CheckCircle2,
  Clock3,
  Layers3,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import { OverviewSection } from '../components/k8s/OverviewSection';
import type { DeliveryState } from '../core/resources/delivery';
import {
  FLUX_STATUS_GROUPS,
  type FluxActivityTimeline,
  type FluxOverviewSummary,
  type FluxStatusCounts,
} from '../core/resources/flux_overview';

const BREAKDOWN_LIMIT = 6;

export function FluxStatusBar({
  counts,
  total,
  label,
}: {
  counts: FluxStatusCounts;
  total: number;
  label?: string;
}) {
  return (
    <div
      className="flux-status-bar"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {counts.map((count, index) =>
        count > 0 ? (
          <span
            key={FLUX_STATUS_GROUPS[index].id}
            style={{ flexGrow: count, flexBasis: 0, background: FLUX_STATUS_GROUPS[index].color }}
            title={`${FLUX_STATUS_GROUPS[index].label}: ${count} / ${total}`}
          />
        ) : null,
      )}
    </div>
  );
}

/** Helm-aligned top summary card: 4 KPIs, interactive status bar, and 3 cluster facts. */
export function FluxSummaryCard({
  summary,
  known,
  partial,
  stateFilter,
  onSelectState,
}: {
  summary: FluxOverviewSummary;
  known: boolean;
  partial: boolean;
  stateFilter: 'all' | DeliveryState;
  onSelectState: (next: 'all' | DeliveryState) => void;
}) {
  const val = (n: number) => (known ? n.toLocaleString() : '—');
  const toggle = (target: DeliveryState) => onSelectState(stateFilter === target ? 'all' : target);

  return (
    <section aria-label="Flux summary" className="flux-cluster-summary">
      <div className="flux-kpis">
        <FluxKpi
          icon={Layers3}
          label="Resources"
          value={val(summary.total)}
          detail={partial ? 'In accessible CRDs / scope' : 'Kustomizations · HelmReleases · Sources'}
          pressed={false}
          onClick={() => onSelectState('all')}
        />
        <FluxKpi
          icon={CheckCircle2}
          label="Ready"
          value={val(summary.counts[0])}
          detail={known && summary.total ? `${summary.readyPercent}% reconciled` : 'Reconciled successfully'}
          tone={known && summary.counts[0] ? 'ok' : undefined}
          pressed={stateFilter === 'healthy'}
          onClick={() => toggle('healthy')}
        />
        <FluxKpi
          icon={Clock3}
          label="In progress"
          value={val(summary.counts[1])}
          detail="Reconciling or awaiting generation"
          tone={known && summary.counts[1] ? 'warn' : undefined}
          pressed={stateFilter === 'progressing'}
          onClick={() => toggle('progressing')}
        />
        <FluxKpi
          icon={TriangleAlert}
          label="Failed"
          value={val(summary.counts[2])}
          detail="Stalled · Degraded · Ready=False"
          tone={known && summary.counts[2] ? 'danger' : undefined}
          pressed={stateFilter === 'attention'}
          onClick={() => toggle('attention')}
        />
      </div>

      <section aria-label="Flux reconciliation status" className="flux-status-distribution">
        <FluxStatusBar
          counts={summary.counts}
          total={summary.total}
          label={
            known
              ? `${summary.total} Flux resources: ${FLUX_STATUS_GROUPS.map((g, i) => `${summary.counts[i]} ${g.label.toLowerCase()}`).join(', ')}`
              : 'Flux reconciliation status unavailable'
          }
        />
        <div className="flux-status-caption">
          <div className="flux-status-legend">
            {FLUX_STATUS_GROUPS.map((group, index) => (
              <button
                key={group.id}
                type="button"
                disabled={!known || !summary.counts[index]}
                aria-pressed={stateFilter === group.id}
                onClick={() => toggle(group.id)}
              >
                <span className="flux-status-dot" style={{ background: group.color }} aria-hidden="true" />
                {group.label}
                <strong>{val(summary.counts[index])}</strong>
              </button>
            ))}
          </div>
          <span className="flux-status-note">Flux controller status · click a state to filter</span>
        </div>
      </section>

      <dl className="flux-inventory-facts">
        <div>
          <dt>Namespaces with Flux</dt>
          <dd>{val(summary.namespaces.length)}</dd>
        </div>
        <div>
          <dt>Suspended resources</dt>
          <dd>{val(summary.counts[3])}</dd>
        </div>
        <div>
          <dt>Status changes in 24h</dt>
          <dd>{known && summary.changed24h !== null ? summary.changed24h.toLocaleString() : '—'}</dd>
        </div>
      </dl>
    </section>
  );
}

function FluxKpi({
  icon: Icon,
  label,
  value,
  detail,
  tone,
  pressed,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  detail: string;
  tone?: 'ok' | 'warn' | 'danger' | 'pending';
  pressed: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="flux-kpi"
      aria-label={`${label}: ${value}`}
      aria-pressed={pressed}
      data-tone={tone}
      onClick={onClick}
    >
      <div className="flux-kpi-label">
        <Icon size={14} aria-hidden="true" />
        <span>{label}</span>
      </div>
      <div className="flux-kpi-value">{value}</div>
      <div className="flux-kpi-detail">{detail}</div>
    </button>
  );
}

/** 2-column visual analytics row: Reconciliation donut + kind footprint and Namespace health. */
export function FluxAnalyticsGrid({
  summary,
  known,
  stateFilter,
  namespaceFilter,
  onSelectState,
  onSelectNamespace,
  onOpenKind,
}: {
  summary: FluxOverviewSummary;
  known: boolean;
  stateFilter: 'all' | DeliveryState;
  namespaceFilter: string;
  onSelectState: (next: 'all' | DeliveryState) => void;
  onSelectNamespace: (ns: string) => void;
  onOpenKind: (kind: string) => void;
}) {
  const donutTitleId = useId();
  const [showAllNamespaces, setShowAllNamespaces] = useState(false);

  if (!known || (summary.total === 0 && summary.kinds.every((k) => k.total === 0))) {
    return null;
  }

  let offset = 0;
  const visibleNamespaces = showAllNamespaces ? summary.namespaces : summary.namespaces.slice(0, BREAKDOWN_LIMIT);
  const activeKinds = summary.kinds.filter((k) => k.total > 0);

  return (
    <div className="flux-analytics-grid">
      <OverviewSection
        label="Flux reconciliation distribution"
        title="Reconciliation health"
        description="Readiness distribution & discovered Flux resource kinds"
        actions={<span className="flux-section-count">{activeKinds.length} active kind{activeKinds.length === 1 ? '' : 's'}</span>}
      >
        <div className="flux-health-chart-wrap">
          <svg viewBox="0 0 140 140" className="flux-donut" role="img" aria-labelledby={donutTitleId}>
            <title id={donutTitleId}>
              {summary.total === 0
                ? 'No Flux reconciliation resources'
                : `${summary.readyPercent}% ready (${summary.counts[0]} of ${summary.total} resources): ${FLUX_STATUS_GROUPS.map((g, i) => `${summary.counts[i]} ${g.label.toLowerCase()}`).join(', ')}`}
            </title>
            <circle cx="70" cy="70" r="54" fill="none" stroke="var(--border-subtle)" strokeWidth="12" />
            {summary.counts.map((count, index) => {
              const fraction = summary.total ? count / summary.total : 0;
              const start = offset;
              offset += fraction * 100;
              return count > 0 ? (
                <circle
                  key={FLUX_STATUS_GROUPS[index].id}
                  cx="70"
                  cy="70"
                  r="54"
                  pathLength="100"
                  fill="none"
                  stroke={FLUX_STATUS_GROUPS[index].color}
                  strokeWidth="12"
                  strokeDasharray={`${fraction * 100} ${100 - fraction * 100}`}
                  strokeDashoffset={-start}
                  transform="rotate(-90 70 70)"
                />
              ) : null;
            })}
            <text x="70" y="68" textAnchor="middle" className="flux-donut-value">
              {summary.total ? `${summary.readyPercent}%` : '—'}
            </text>
            <text x="70" y="88" textAnchor="middle" className="flux-donut-sub">
              {summary.total} resource{summary.total === 1 ? '' : 's'}
            </text>
          </svg>

          <div className="flux-state-breakdown" role="group" aria-label="Filter by reconciliation state">
            {FLUX_STATUS_GROUPS.map((group, index) => {
              const count = summary.counts[index];
              const pct = summary.total ? Math.round((count / summary.total) * 100) : 0;
              return (
                <button
                  key={group.id}
                  type="button"
                  disabled={count === 0}
                  aria-pressed={stateFilter === group.id}
                  onClick={() => onSelectState(stateFilter === group.id ? 'all' : group.id)}
                >
                  <span className="flux-status-dot" style={{ background: group.color }} aria-hidden="true" />
                  <span className="truncate">{group.label}</span>
                  <span className="flux-state-breakdown-count">{count.toLocaleString()}</span>
                  <span className="flux-state-breakdown-pct">{pct}%</span>
                </button>
              );
            })}
          </div>
        </div>

        {activeKinds.length > 0 && (
          <div>
            {activeKinds.slice(0, BREAKDOWN_LIMIT).map((item) => (
              <button
                key={item.key}
                type="button"
                className="flux-kind-row"
                aria-label={`Open ${item.kind} list (${item.counts[0]} of ${item.total} ready)`}
                onClick={() => onOpenKind(item.kind)}
              >
                <span className="flux-kind-name">
                  <span title={item.kind}>{item.kind}</span>
                  <small>
                    {item.counts[2]
                      ? `${item.counts[2]} failed · ${item.counts[0]} ready`
                      : `${item.counts[0]} / ${item.total} ready`}
                  </small>
                </span>
                <FluxStatusBar counts={item.counts} total={item.total} />
                <strong>{item.total}</strong>
                <ArrowRight size={13} className="flux-row-arrow" aria-hidden="true" />
              </button>
            ))}
          </div>
        )}

        <div className="flux-card-footer">
          <span>
            {activeKinds.length > BREAKDOWN_LIMIT
              ? `Top ${BREAKDOWN_LIMIT} of ${activeKinds.length} Flux kinds`
              : `${activeKinds.length} Flux kind${activeKinds.length === 1 ? '' : 's'} with objects`}
          </span>
          <span className="text-[var(--text-muted)]">Click kind to open list</span>
        </div>
      </OverviewSection>

      <OverviewSection
        label="Flux namespaces"
        title="Namespace health"
        description="Status by namespace · failed reconciliations first"
        actions={
          <span className="flux-section-count">
            {summary.namespaces.length} namespace{summary.namespaces.length === 1 ? '' : 's'}
          </span>
        }
      >
        <div className="flux-table-columns flux-ns-columns" aria-hidden="true">
          <span>Namespace</span>
          <span>Flux status</span>
          <span>Resources</span>
        </div>
        <div>
          {visibleNamespaces.map((ns) => {
            const tone = ns.counts[2]
              ? 'danger'
              : ns.counts[1]
                ? 'warn'
                : ns.counts[3]
                  ? 'pending'
                  : 'ok';
            const subtitle = ns.counts[2]
              ? `${ns.counts[2]} failed`
              : ns.counts[1]
                ? `${ns.counts[1]} in progress`
                : ns.counts[3]
                  ? `${ns.counts[3]} suspended`
                  : `${ns.counts[0]} ready`;
            return (
              <button
                key={ns.name}
                type="button"
                className="flux-ns-row"
                aria-pressed={namespaceFilter === ns.name}
                aria-label={`Namespace ${ns.name}: ${ns.total} resources, ${ns.counts[2]} failed, ${ns.counts[1]} in progress`}
                onClick={() => onSelectNamespace(namespaceFilter === ns.name ? 'all' : ns.name)}
              >
                <span className="flux-ns-name">
                  <span title={ns.name}>{ns.name}</span>
                  <small data-tone={tone}>{subtitle}</small>
                </span>
                <FluxStatusBar counts={ns.counts} total={ns.total} />
                <strong>{ns.total}</strong>
                <ArrowRight size={13} className="flux-row-arrow" aria-hidden="true" />
              </button>
            );
          })}
        </div>
        <div className="flux-card-footer">
          <span>
            {summary.namespaces.length > BREAKDOWN_LIMIT && !showAllNamespaces
              ? `Top ${BREAKDOWN_LIMIT} of ${summary.namespaces.length} namespaces`
              : `${summary.namespaces.length} namespace${summary.namespaces.length === 1 ? '' : 's'}`}
          </span>
          {summary.namespaces.length > BREAKDOWN_LIMIT ? (
            <button
              type="button"
              className="flux-section-link"
              onClick={() => setShowAllNamespaces((v) => !v)}
            >
              {showAllNamespaces ? 'Show fewer' : `Show all ${summary.namespaces.length} namespaces`}
            </button>
          ) : (
            <span className="text-[var(--text-muted)]">Click row to filter</span>
          )}
        </div>
      </OverviewSection>
    </div>
  );
}

/** Stacked controller event timeline chart shown when Flux events are present. */
export function FluxEventTimelineChart({ timeline }: { timeline: FluxActivityTimeline }) {
  if (!timeline.buckets.length || timeline.maxTotal === 0) return null;
  const formatTime = (ms: number) =>
    new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  return (
    <div
      className="flux-event-chart"
      role="img"
      aria-label={`Controller event timeline: ${timeline.normalTotal} normal and ${timeline.warningTotal} warning events`}
    >
      <div className="flux-event-chart-head">
        <span className="inline-flex items-center gap-1.5">
          <Activity size={12} aria-hidden="true" />
          Event cadence
        </span>
        <span className="flux-event-chart-legend">
          <span>
            <span className="flux-status-dot" style={{ background: 'var(--status-ok)' }} aria-hidden="true" />
            Normal {timeline.normalTotal}
          </span>
          <span>
            <span className="flux-status-dot" style={{ background: 'var(--status-warn)' }} aria-hidden="true" />
            Warnings {timeline.warningTotal}
          </span>
        </span>
      </div>
      <div className="flux-event-bars" aria-hidden="true">
        {timeline.buckets.map((bucket) => {
          const totalPct = bucket.total > 0 ? Math.max(10, Math.round((bucket.total / timeline.maxTotal) * 100)) : 0;
          const warnPct = bucket.total > 0 ? Math.round((bucket.warning / bucket.total) * totalPct) : 0;
          const normPct = Math.max(0, totalPct - warnPct);
          return (
            <div
              key={bucket.start}
              className="flux-event-bar-col"
              title={`${formatTime(bucket.start)}–${formatTime(bucket.end)}: ${bucket.normal} normal, ${bucket.warning} warning`}
            >
              {bucket.warning > 0 && (
                <div className="flux-event-bar-seg is-warning" style={{ height: `${Math.max(warnPct, 8)}%` }} />
              )}
              {bucket.normal > 0 && (
                <div className="flux-event-bar-seg is-normal" style={{ height: `${Math.max(normPct, 8)}%` }} />
              )}
            </div>
          );
        })}
      </div>
      <div className="flux-event-chart-times" aria-hidden="true">
        <span>{formatTime(timeline.spanStart)}</span>
        <span>{formatTime(timeline.spanEnd)}</span>
      </div>
    </div>
  );
}
