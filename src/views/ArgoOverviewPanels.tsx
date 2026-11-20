import { useId, useState } from 'react';
import {
  ArrowRight,
  CheckCircle2,
  FolderGit2,
  GitCompareArrows,
  Layers,
  TriangleAlert,
} from 'lucide-react';
import { OverviewSection } from '../components/k8s/OverviewSection';
import {
  ARGO_COMBINED_COLORS,
  ARGO_COMBINED_LABELS,
  ARGO_HEALTH_GROUPS,
  ARGO_SYNC_GROUPS,
  type ArgoBucketSummary,
  type ArgoCombinedCounts,
  type ArgoOverviewSummary,
} from '../core/resources/argocd_overview';

const BREAKDOWN_LIMIT = 6;

function SegmentedBar({
  counts,
  colors,
  labels,
  total,
  ariaLabel,
}: {
  counts: readonly number[];
  colors: readonly string[];
  labels: readonly string[];
  total: number;
  ariaLabel?: string;
}) {
  return (
    <div
      className="flux-status-bar"
      role={ariaLabel ? 'img' : undefined}
      aria-label={ariaLabel}
      aria-hidden={ariaLabel ? undefined : true}
    >
      {counts.map((count, index) =>
        count > 0 ? (
          <span
            key={labels[index]}
            style={{ flexGrow: count, flexBasis: 0, background: colors[index] }}
            title={`${labels[index]}: ${count} / ${total}`}
          />
        ) : null,
      )}
    </div>
  );
}

/**
 * Helm/Flux-aligned top summary card for Argo CD:
 * - 4 KPI tiles (Applications, Synced, Out of sync, Degraded / Missing)
 * - Dual independent Sync & Health status bars with clickable filter buttons
 * - 3-column facts footer (Projects, Destination namespaces, Synced in 24h)
 */
export function ArgoSummaryCard({
  summary,
  known,
  partial,
  sync,
  health,
  onChangeSync,
  onChangeHealth,
  onOpenApplications,
}: {
  summary: ArgoOverviewSummary;
  known: boolean;
  partial: boolean;
  sync: string;
  health: string;
  onChangeSync: (value: string) => void;
  onChangeHealth: (value: string) => void;
  onOpenApplications: () => void;
}) {
  const val = (n: number) => (known ? n.toLocaleString() : '—');
  const degradedTarget = summary.healthCounts[2] > 0 || summary.healthCounts[3] === 0 ? 'Degraded' : 'Missing';

  return (
    <section aria-label="Argo CD summary" className="flux-cluster-summary">
      <div className="flux-kpis">
        <button
          type="button"
          className="flux-kpi"
          aria-label={`${val(summary.total)} Applications`}
          onClick={onOpenApplications}
        >
          <div className="flux-kpi-label">
            <Layers size={14} aria-hidden="true" />
            <span>Applications</span>
            <ArrowRight size={12} className="ml-auto opacity-60" aria-hidden="true" />
          </div>
          <div className="flux-kpi-value">{val(summary.total)}</div>
          <div className="flux-kpi-detail">
            {partial ? 'In accessible scope' : 'Click to open Applications list'}
          </div>
        </button>

        <button
          type="button"
          className="flux-kpi"
          data-tone={known && summary.syncCounts[0] ? 'ok' : undefined}
          aria-pressed={sync === 'Synced'}
          aria-label={`Synced applications: ${val(summary.syncCounts[0])}`}
          onClick={() => onChangeSync(sync === 'Synced' ? 'all' : 'Synced')}
        >
          <div className="flux-kpi-label">
            <CheckCircle2 size={14} aria-hidden="true" />
            <span>Synced</span>
          </div>
          <div className="flux-kpi-value">{val(summary.syncCounts[0])}</div>
          <div className="flux-kpi-detail">
            {known && summary.total ? `${summary.syncedPercent}% in sync with Git` : 'Matches desired Git revision'}
          </div>
        </button>

        <button
          type="button"
          className="flux-kpi"
          data-tone={known && summary.syncCounts[1] ? 'warn' : undefined}
          aria-pressed={sync === 'OutOfSync'}
          aria-label={`Out of sync applications: ${val(summary.syncCounts[1])}`}
          onClick={() => onChangeSync(sync === 'OutOfSync' ? 'all' : 'OutOfSync')}
        >
          <div className="flux-kpi-label">
            <GitCompareArrows size={14} aria-hidden="true" />
            <span>Out of sync</span>
          </div>
          <div className="flux-kpi-value">{val(summary.syncCounts[1])}</div>
          <div className="flux-kpi-detail">Live cluster state differs from Git</div>
        </button>

        <button
          type="button"
          className="flux-kpi"
          data-tone={known && summary.degradedTotal ? 'danger' : undefined}
          aria-pressed={health === 'Degraded' || health === 'Missing'}
          aria-label={`Degraded or missing applications: ${val(summary.degradedTotal)}`}
          onClick={() => onChangeHealth(health === degradedTarget ? 'all' : degradedTarget)}
        >
          <div className="flux-kpi-label">
            <TriangleAlert size={14} aria-hidden="true" />
            <span>Degraded</span>
          </div>
          <div className="flux-kpi-value">{val(summary.degradedTotal)}</div>
          <div className="flux-kpi-detail">Degraded or Missing workloads</div>
        </button>
      </div>

      <div className="argo-axes-wrap">
        <div className="argo-axis-block" role="group" aria-label="Application sync">
          <div className="argo-axis-header">
            <span className="argo-axis-title">Sync</span>
            <SegmentedBar
              counts={summary.syncCounts}
              colors={ARGO_SYNC_GROUPS.map((g) => g.color)}
              labels={ARGO_SYNC_GROUPS.map((g) => g.label)}
              total={summary.total}
              ariaLabel={
                known
                  ? `Sync status: ${ARGO_SYNC_GROUPS.map((g, i) => `${summary.syncCounts[i]} ${g.label.toLowerCase()}`).join(', ')}`
                  : 'Sync status unavailable'
              }
            />
          </div>
          <div className="flux-status-legend">
            {ARGO_SYNC_GROUPS.map((group, index) => (
              <button
                key={group.id}
                type="button"
                data-status={group.id}
                aria-label={`Sync ${group.id}: ${known ? summary.syncCounts[index] : 'unavailable'}`}
                aria-pressed={sync === group.id}
                onClick={() => onChangeSync(sync === group.id ? 'all' : group.id)}
              >
                <span className="flux-status-dot" style={{ background: group.color }} aria-hidden="true" />
                {group.label}
                <strong>{val(summary.syncCounts[index])}</strong>
              </button>
            ))}
          </div>
        </div>

        <div className="argo-axis-block" role="group" aria-label="Application health">
          <div className="argo-axis-header">
            <span className="argo-axis-title">Health</span>
            <SegmentedBar
              counts={summary.healthCounts}
              colors={ARGO_HEALTH_GROUPS.map((g) => g.color)}
              labels={ARGO_HEALTH_GROUPS.map((g) => g.label)}
              total={summary.total}
              ariaLabel={
                known
                  ? `Health status: ${ARGO_HEALTH_GROUPS.map((g, i) => `${summary.healthCounts[i]} ${g.label.toLowerCase()}`).join(', ')}`
                  : 'Health status unavailable'
              }
            />
          </div>
          <div className="flux-status-legend">
            {ARGO_HEALTH_GROUPS.map((group, index) => (
              <button
                key={group.id}
                type="button"
                data-status={group.id}
                aria-label={`Health ${group.id}: ${known ? summary.healthCounts[index] : 'unavailable'}`}
                aria-pressed={health === group.id}
                onClick={() => onChangeHealth(health === group.id ? 'all' : group.id)}
              >
                <span className="flux-status-dot" style={{ background: group.color }} aria-hidden="true" />
                {group.label}
                <strong>{val(summary.healthCounts[index])}</strong>
              </button>
            ))}
          </div>
        </div>
      </div>

      <dl className="flux-inventory-facts">
        <div>
          <dt>AppProjects</dt>
          <dd>{val(summary.projectResourceCount)}</dd>
        </div>
        <div>
          <dt>Destination namespaces</dt>
          <dd>{val(summary.destinations.length)}</dd>
        </div>
        <div>
          <dt>Sync activity in 24h</dt>
          <dd>{known && summary.changed24h !== null ? summary.changed24h.toLocaleString() : '—'}</dd>
        </div>
      </dl>
    </section>
  );
}

function MiniDonut({
  percent,
  sublabel,
  title,
  counts,
  colors,
  total,
}: {
  percent: number;
  sublabel: string;
  title: string;
  counts: readonly number[];
  colors: readonly string[];
  total: number;
}) {
  const id = useId();
  let offset = 0;
  return (
    <svg viewBox="0 0 140 140" className="flux-donut argo-mini-donut" role="img" aria-labelledby={id}>
      <title id={id}>{title}</title>
      <circle cx="70" cy="70" r="54" fill="none" stroke="var(--border-subtle)" strokeWidth="12" />
      {counts.map((count, index) => {
        const fraction = total ? count / total : 0;
        const start = offset;
        offset += fraction * 100;
        return count > 0 ? (
          <circle
            key={index}
            cx="70"
            cy="70"
            r="54"
            pathLength="100"
            fill="none"
            stroke={colors[index]}
            strokeWidth="12"
            strokeDasharray={`${fraction * 100} ${100 - fraction * 100}`}
            strokeDashoffset={-start}
            transform="rotate(-90 70 70)"
          />
        ) : null;
      })}
      <text x="70" y="68" textAnchor="middle" className="flux-donut-value">
        {total ? `${percent}%` : '—'}
      </text>
      <text x="70" y="88" textAnchor="middle" className="flux-donut-sub">
        {sublabel}
      </text>
    </svg>
  );
}

function bucketToneAndLabel(bucket: ArgoBucketSummary): { tone: 'danger' | 'warn' | 'ok' | 'pending'; label: string } {
  if (bucket.degraded) return { tone: 'danger', label: `${bucket.degraded} degraded` };
  if (bucket.outOfSync) return { tone: 'warn', label: `${bucket.outOfSync} out of sync` };
  if (bucket.progressing) return { tone: 'warn', label: `${bucket.progressing} progressing` };
  if (bucket.healthySynced === bucket.total) return { tone: 'ok', label: `${bucket.healthySynced} healthy & synced` };
  return { tone: 'pending', label: `${bucket.healthySynced} / ${bucket.total} synced` };
}

/** 2-column visual analytics row for Argo CD: Dual Sync/Health donuts + Projects & Destination Namespaces. */
export function ArgoAnalyticsGrid({
  summary,
  known,
  projectFilter,
  destinationFilter,
  onSelectProject,
  onSelectDestination,
}: {
  summary: ArgoOverviewSummary;
  known: boolean;
  projectFilter: string;
  destinationFilter: string;
  onSelectProject: (project: string) => void;
  onSelectDestination: (destination: string) => void;
}) {
  const [showAllDest, setShowAllDest] = useState(false);

  if (!known || summary.total === 0) return null;

  const visibleDestinations = showAllDest ? summary.destinations : summary.destinations.slice(0, BREAKDOWN_LIMIT);

  return (
    <div className="flux-analytics-grid">
      <OverviewSection
        label="Argo CD health and sync distribution"
        title="Sync & health overview"
        description="Independent Git sync and workload health ratios by project"
        actions={
          <span className="flux-section-count">
            {summary.projects.length} project{summary.projects.length === 1 ? '' : 's'}
          </span>
        }
      >
        <div className="argo-donuts-wrap">
          <div className="argo-donut-card">
            <MiniDonut
              percent={summary.syncedPercent}
              sublabel="synced"
              title={`Sync ratio: ${summary.syncedPercent}% (${summary.syncCounts[0]} of ${summary.total} synced)`}
              counts={summary.syncCounts}
              colors={ARGO_SYNC_GROUPS.map((g) => g.color)}
              total={summary.total}
            />
            <span className="argo-donut-caption">
              {summary.syncCounts[0]} / {summary.total} Synced
            </span>
          </div>
          <div className="argo-donut-card">
            <MiniDonut
              percent={summary.healthyPercent}
              sublabel="healthy"
              title={`Health ratio: ${summary.healthyPercent}% (${summary.healthCounts[0]} of ${summary.total} healthy)`}
              counts={summary.healthCounts}
              colors={ARGO_HEALTH_GROUPS.map((g) => g.color)}
              total={summary.total}
            />
            <span className="argo-donut-caption">
              {summary.healthCounts[0]} / {summary.total} Healthy
            </span>
          </div>
        </div>

        <div className="flux-table-columns flux-ns-columns" aria-hidden="true">
          <span>Project</span>
          <span>Status</span>
          <span>Apps</span>
        </div>
        <div>
          {summary.projects.slice(0, BREAKDOWN_LIMIT).map((proj) => {
            const { tone, label } = bucketToneAndLabel(proj);
            return (
              <button
                key={proj.name}
                type="button"
                className="flux-ns-row"
                aria-pressed={projectFilter === proj.name}
                aria-label={`Project ${proj.name}: ${proj.total} applications, ${proj.degraded} degraded, ${proj.outOfSync} out of sync`}
                onClick={() => onSelectProject(projectFilter === proj.name ? 'all' : proj.name)}
              >
                <span className="flux-ns-name">
                  <span title={proj.name} className="inline-flex items-center gap-1.5">
                    <FolderGit2 size={12} className="shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
                    <span className="truncate">{proj.name}</span>
                  </span>
                  <small data-tone={tone}>{label}</small>
                </span>
                <SegmentedBar
                  counts={proj.counts as ArgoCombinedCounts}
                  colors={ARGO_COMBINED_COLORS}
                  labels={ARGO_COMBINED_LABELS}
                  total={proj.total}
                />
                <strong>{proj.total}</strong>
                <ArrowRight size={13} className="flux-row-arrow" aria-hidden="true" />
              </button>
            );
          })}
        </div>
        <div className="flux-card-footer">
          <span>
            {summary.projects.length > BREAKDOWN_LIMIT
              ? `Top ${BREAKDOWN_LIMIT} of ${summary.projects.length} projects`
              : `${summary.projects.length} project${summary.projects.length === 1 ? '' : 's'}`}
          </span>
          <span className="text-[var(--text-muted)]">Click project to filter</span>
        </div>
      </OverviewSection>

      <OverviewSection
        label="Argo CD destination namespaces"
        title="Destination namespaces"
        description="Target namespace health · degraded & drifted apps first"
        actions={
          <span className="flux-section-count">
            {summary.destinations.length} namespace{summary.destinations.length === 1 ? '' : 's'}
          </span>
        }
      >
        <div className="flux-table-columns flux-ns-columns" aria-hidden="true">
          <span>Namespace</span>
          <span>App status</span>
          <span>Apps</span>
        </div>
        <div>
          {visibleDestinations.map((dest) => {
            const { tone, label } = bucketToneAndLabel(dest);
            return (
              <button
                key={dest.name}
                type="button"
                className="flux-ns-row"
                aria-pressed={destinationFilter === dest.name}
                aria-label={`Destination ${dest.name}: ${dest.total} applications, ${dest.degraded} degraded, ${dest.outOfSync} out of sync`}
                onClick={() => onSelectDestination(destinationFilter === dest.name ? 'all' : dest.name)}
              >
                <span className="flux-ns-name">
                  <span title={dest.name}>{dest.name}</span>
                  <small data-tone={tone}>{label}</small>
                </span>
                <SegmentedBar
                  counts={dest.counts as ArgoCombinedCounts}
                  colors={ARGO_COMBINED_COLORS}
                  labels={ARGO_COMBINED_LABELS}
                  total={dest.total}
                />
                <strong>{dest.total}</strong>
                <ArrowRight size={13} className="flux-row-arrow" aria-hidden="true" />
              </button>
            );
          })}
        </div>
        <div className="flux-card-footer">
          <span>
            {summary.destinations.length > BREAKDOWN_LIMIT && !showAllDest
              ? `Top ${BREAKDOWN_LIMIT} of ${summary.destinations.length} namespaces`
              : `${summary.destinations.length} destination namespace${summary.destinations.length === 1 ? '' : 's'}`}
          </span>
          {summary.destinations.length > BREAKDOWN_LIMIT ? (
            <button
              type="button"
              className="flux-section-link"
              onClick={() => setShowAllDest((v) => !v)}
            >
              {showAllDest ? 'Show fewer' : `Show all ${summary.destinations.length} namespaces`}
            </button>
          ) : (
            <span className="text-[var(--text-muted)]">Click row to filter</span>
          )}
        </div>
      </OverviewSection>
    </div>
  );
}
