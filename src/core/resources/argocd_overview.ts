import type { GitOpsSnapshot } from '../../providers/use_gitops_dashboard';
import type { ResourceItem } from '../../types/k8s';
import { argoHealth, argoSync, deliveryState, deliveryTimestamp } from './delivery';
import { buildFluxActivityTimeline, type FluxActivityTimeline } from './flux_overview';

/**
 * Argo CD Health & Sync palettes synchronized 1:1 with Helm and Flux Overviews:
 * - Healthy / Synced -> --status-ok (green)
 * - Progressing / OutOfSync -> --status-warn (amber)
 * - Degraded / Missing -> --status-danger (coral red)
 * - Suspended -> --status-pending (blue)
 * - Unknown -> --text-muted (neutral)
 */
export const ARGO_SYNC_GROUPS = [
  { id: 'Synced', label: 'Synced', tone: 'ok', color: 'var(--status-ok)' },
  { id: 'OutOfSync', label: 'Out of sync', tone: 'warn', color: 'var(--status-warn)' },
  { id: 'Unknown', label: 'Unknown', tone: 'neutral', color: 'var(--text-muted)' },
] as const;

export const ARGO_HEALTH_GROUPS = [
  { id: 'Healthy', label: 'Healthy', tone: 'ok', color: 'var(--status-ok)' },
  { id: 'Progressing', label: 'Progressing', tone: 'warn', color: 'var(--status-warn)' },
  { id: 'Degraded', label: 'Degraded', tone: 'danger', color: 'var(--status-danger)' },
  { id: 'Missing', label: 'Missing', tone: 'danger', color: 'color-mix(in srgb, var(--status-danger) 72%, var(--status-warn))' },
  { id: 'Suspended', label: 'Suspended', tone: 'pending', color: 'var(--status-pending)' },
  { id: 'Unknown', label: 'Unknown', tone: 'neutral', color: 'var(--text-muted)' },
] as const;

export type ArgoSyncCounts = [number, number, number];
export type ArgoHealthCounts = [number, number, number, number, number, number];
/** Compact 4-slot status bar counts: [healthy+synced, out-of-sync/progressing, degraded/missing/failed, suspended/unknown]. */
export type ArgoCombinedCounts = [number, number, number, number];

export const ARGO_COMBINED_COLORS = [
  'var(--status-ok)',
  'var(--status-warn)',
  'var(--status-danger)',
  'var(--status-pending)',
] as const;

export const ARGO_COMBINED_LABELS = [
  'Healthy & Synced',
  'Out of sync / Progressing',
  'Degraded / Missing',
  'Suspended / Unknown',
] as const;

export interface ArgoBucketSummary {
  name: string;
  total: number;
  degraded: number;
  outOfSync: number;
  progressing: number;
  healthySynced: number;
  counts: ArgoCombinedCounts;
}

export interface ArgoOverviewSummary {
  total: number;
  syncCounts: ArgoSyncCounts;
  healthCounts: ArgoHealthCounts;
  syncedPercent: number;
  healthyPercent: number;
  degradedTotal: number;
  projects: ArgoBucketSummary[];
  destinations: ArgoBucketSummary[];
  projectResourceCount: number;
  applicationSetCount: number;
  changed24h: number | null;
  timeline: FluxActivityTimeline;
}

const DAY_MS = 86_400_000;

export function argoSyncIndex(status: string): 0 | 1 | 2 {
  if (status === 'Synced') return 0;
  if (status === 'OutOfSync') return 1;
  return 2;
}

export function argoHealthIndex(status: string): 0 | 1 | 2 | 3 | 4 | 5 {
  switch (status) {
    case 'Healthy': return 0;
    case 'Progressing': return 1;
    case 'Degraded': return 2;
    case 'Missing': return 3;
    case 'Suspended': return 4;
    default: return 5;
  }
}

export function argoProjectOf(item: ResourceItem): string {
  const project = item.raw?.spec?.project;
  return typeof project === 'string' && project.trim() ? project.trim() : 'default';
}

export function argoDestinationNamespaceOf(item: ResourceItem): string {
  const dest = item.raw?.spec?.destination?.namespace;
  return typeof dest === 'string' && dest.trim() ? dest.trim() : 'cluster-scoped';
}

function combinedBucketIndex(item: ResourceItem, syncStatus: string, healthStatus: string): 0 | 1 | 2 | 3 {
  if (healthStatus === 'Degraded' || healthStatus === 'Missing' || ['Failed', 'Error'].includes(item.raw?.status?.operationState?.phase)) {
    return 2;
  }
  if (syncStatus === 'OutOfSync' || healthStatus === 'Progressing' || deliveryState(item) === 'progressing') {
    return 1;
  }
  if (healthStatus === 'Healthy' && syncStatus === 'Synced') {
    return 0;
  }
  return 3;
}

function recordBucket(
  map: Map<string, ArgoBucketSummary>,
  name: string,
  combinedIdx: 0 | 1 | 2 | 3,
  syncStatus: string,
  healthStatus: string,
) {
  let entry = map.get(name);
  if (!entry) {
    entry = { name, total: 0, degraded: 0, outOfSync: 0, progressing: 0, healthySynced: 0, counts: [0, 0, 0, 0] };
    map.set(name, entry);
  }
  entry.total += 1;
  entry.counts[combinedIdx] += 1;
  if (combinedIdx === 2) entry.degraded += 1;
  if (syncStatus === 'OutOfSync') entry.outOfSync += 1;
  if (healthStatus === 'Progressing') entry.progressing += 1;
  if (combinedIdx === 0) entry.healthySynced += 1;
}

function sortBuckets(entries: Iterable<ArgoBucketSummary>): ArgoBucketSummary[] {
  return [...entries].sort(
    (a, b) =>
      b.degraded - a.degraded
      || b.outOfSync - a.outOfSync
      || b.progressing - a.progressing
      || b.total - a.total
      || a.name.localeCompare(b.name),
  );
}

/**
 * Single-pass O(N) summary of Argo CD Application sync/health axes, AppProject
 * footprint, destination namespace health, 24h sync changes, and controller events.
 */
export function summarizeArgoOverview(
  entries: readonly GitOpsSnapshot[],
  applications: readonly ResourceItem[],
  activity: readonly { time: number; warning: boolean }[],
  updated?: number,
): ArgoOverviewSummary {
  const syncCounts: ArgoSyncCounts = [0, 0, 0];
  const healthCounts: ArgoHealthCounts = [0, 0, 0, 0, 0, 0];
  const projectMap = new Map<string, ArgoBucketSummary>();
  const destinationMap = new Map<string, ArgoBucketSummary>();
  let changed24h = 0;

  for (const app of applications) {
    const syncStatus = argoSync(app);
    const healthStatus = argoHealth(app);
    syncCounts[argoSyncIndex(syncStatus)] += 1;
    healthCounts[argoHealthIndex(healthStatus)] += 1;

    const combinedIdx = combinedBucketIndex(app, syncStatus, healthStatus);
    recordBucket(projectMap, argoProjectOf(app), combinedIdx, syncStatus, healthStatus);
    recordBucket(destinationMap, argoDestinationNamespaceOf(app), combinedIdx, syncStatus, healthStatus);

    if (updated) {
      const stamp = deliveryTimestamp(app);
      if (stamp) {
        const ts = Date.parse(stamp.at);
        if (Number.isFinite(ts) && ts <= updated + 60_000 && ts >= updated - DAY_MS) {
          changed24h += 1;
        }
      }
    }
  }

  let projectResourceCount = 0;
  let applicationSetCount = 0;
  for (const entry of entries) {
    if (entry.type.kind === 'AppProject' && entry.items) projectResourceCount += entry.items.length;
    if (entry.type.kind === 'ApplicationSet' && entry.items) applicationSetCount += entry.items.length;
  }

  const total = applications.length;
  return {
    total,
    syncCounts,
    healthCounts,
    syncedPercent: total ? Math.round((syncCounts[0] / total) * 100) : 0,
    healthyPercent: total ? Math.round((healthCounts[0] / total) * 100) : 0,
    degradedTotal: healthCounts[2] + healthCounts[3],
    projects: sortBuckets(projectMap.values()),
    destinations: sortBuckets(destinationMap.values()),
    projectResourceCount: Math.max(projectResourceCount, projectMap.size),
    applicationSetCount,
    changed24h: updated ? changed24h : null,
    timeline: buildFluxActivityTimeline(activity),
  };
}
