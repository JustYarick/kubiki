import type { GitOpsSnapshot } from '../../providers/use_gitops_dashboard';
import type { ResourceItem } from '../../types/k8s';
import { deliveryState, deliveryTimestamp, fluxCategory, type DeliveryState } from './delivery';

/**
 * Flux status groups synchronized 1:1 with Helm Overview's semantic color tokens:
 * - Ready -> --status-ok (green, matching Helm Deployed)
 * - In progress -> --status-warn (amber, matching Helm In progress)
 * - Failed -> --status-danger (red, matching Helm Failed)
 * - Suspended -> --status-pending (blue, intentionally paused)
 * - Unknown -> --text-muted (neutral)
 */
export const FLUX_STATUS_GROUPS = [
  { id: 'healthy', label: 'Ready', tone: 'ok', color: 'var(--status-ok)' },
  { id: 'progressing', label: 'In progress', tone: 'warn', color: 'var(--status-warn)' },
  { id: 'attention', label: 'Failed', tone: 'danger', color: 'var(--status-danger)' },
  { id: 'suspended', label: 'Suspended', tone: 'pending', color: 'var(--status-pending)' },
  { id: 'unknown', label: 'Unknown', tone: 'neutral', color: 'var(--text-muted)' },
] as const;

export type FluxStatusCounts = [number, number, number, number, number];

export function emptyFluxCounts(): FluxStatusCounts {
  return [0, 0, 0, 0, 0];
}

export function fluxStateIndex(state: DeliveryState): 0 | 1 | 2 | 3 | 4 {
  switch (state) {
    case 'healthy': return 0;
    case 'progressing': return 1;
    case 'attention': return 2;
    case 'suspended': return 3;
    case 'unknown': return 4;
  }
}

export interface FluxNamespaceSummary {
  name: string;
  total: number;
  counts: FluxStatusCounts;
}

export interface FluxKindSummary {
  kind: string;
  key: string;
  total: number;
  known: boolean;
  counts: FluxStatusCounts;
}

export interface FluxGroupSummary {
  id: 'kustomizations' | 'helmreleases' | 'sources';
  label: string;
  known: boolean;
  discovered: boolean;
  total: number;
  counts: FluxStatusCounts;
}

export interface FluxEventBucket {
  start: number;
  end: number;
  normal: number;
  warning: number;
  total: number;
}

export interface FluxActivityTimeline {
  buckets: FluxEventBucket[];
  maxTotal: number;
  normalTotal: number;
  warningTotal: number;
  spanStart: number;
  spanEnd: number;
}

export interface FluxOverviewSummary {
  total: number;
  counts: FluxStatusCounts;
  readyPercent: number;
  namespaces: FluxNamespaceSummary[];
  kinds: FluxKindSummary[];
  groups: FluxGroupSummary[];
  changed24h: number | null;
  timeline: FluxActivityTimeline;
}

const TIMELINE_BUCKETS = 12;
const DAY_MS = 86_400_000;

/** Build evenly-spaced buckets over observed controller event timestamps without synthesizing data. */
export function buildFluxActivityTimeline(
  activity: readonly { time: number; warning: boolean }[],
): FluxActivityTimeline {
  let minTime = Infinity;
  let maxTime = -Infinity;
  let normalTotal = 0;
  let warningTotal = 0;

  for (const entry of activity) {
    if (entry.warning) warningTotal += 1;
    else normalTotal += 1;
    if (entry.time > 0 && Number.isFinite(entry.time)) {
      if (entry.time < minTime) minTime = entry.time;
      if (entry.time > maxTime) maxTime = entry.time;
    }
  }

  if (!Number.isFinite(minTime) || !Number.isFinite(maxTime)) {
    return { buckets: [], maxTotal: 0, normalTotal, warningTotal, spanStart: 0, spanEnd: 0 };
  }

  // Ensure a readable window even when all events share a single timestamp.
  const spanEnd = maxTime;
  const spanStart = maxTime === minTime ? maxTime - 3_600_000 : minTime;
  const step = Math.max(1, (spanEnd - spanStart) / TIMELINE_BUCKETS);

  const buckets: FluxEventBucket[] = Array.from({ length: TIMELINE_BUCKETS }, (_, i) => ({
    start: Math.round(spanStart + i * step),
    end: Math.round(spanStart + (i + 1) * step),
    normal: 0,
    warning: 0,
    total: 0,
  }));

  for (const entry of activity) {
    if (!(entry.time > 0 && Number.isFinite(entry.time))) continue;
    const rawIndex = Math.floor((entry.time - spanStart) / step);
    const index = Math.max(0, Math.min(TIMELINE_BUCKETS - 1, rawIndex));
    const bucket = buckets[index];
    if (entry.warning) bucket.warning += 1;
    else bucket.normal += 1;
    bucket.total += 1;
  }

  let maxTotal = 0;
  for (const bucket of buckets) {
    if (bucket.total > maxTotal) maxTotal = bucket.total;
  }

  return { buckets, maxTotal, normalTotal, warningTotal, spanStart, spanEnd };
}

/**
 * Single-pass O(N) summary of Flux reconciliation state, namespace health,
 * resource kind footprint, and controller event activity.
 */
export function summarizeFluxOverview(
  entries: readonly GitOpsSnapshot[],
  primaryItems: readonly ResourceItem[],
  activity: readonly { time: number; warning: boolean }[],
  updated?: number,
): FluxOverviewSummary {
  const counts = emptyFluxCounts();
  const namespaceMap = new Map<string, FluxNamespaceSummary>();
  let changed24h = 0;

  for (const item of primaryItems) {
    const stateIdx = fluxStateIndex(deliveryState(item));
    counts[stateIdx] += 1;

    const ns = item.namespace || 'cluster';
    let nsSummary = namespaceMap.get(ns);
    if (!nsSummary) {
      nsSummary = { name: ns, total: 0, counts: emptyFluxCounts() };
      namespaceMap.set(ns, nsSummary);
    }
    nsSummary.total += 1;
    nsSummary.counts[stateIdx] += 1;

    if (updated) {
      const stamp = deliveryTimestamp(item);
      if (stamp) {
        const ts = Date.parse(stamp.at);
        if (Number.isFinite(ts) && ts <= updated + 60_000 && ts >= updated - DAY_MS) {
          changed24h += 1;
        }
      }
    }
  }

  const groupBuckets: Record<'kustomizations' | 'helmreleases' | 'sources', {
    label: string;
    entries: GitOpsSnapshot[];
  }> = {
    kustomizations: { label: 'Kustomizations', entries: [] },
    helmreleases: { label: 'HelmReleases', entries: [] },
    sources: { label: 'Sources', entries: [] },
  };

  const kinds: FluxKindSummary[] = [];

  for (const entry of entries) {
    const category = fluxCategory({
      kind: entry.type.kind,
      apiVersion: `${entry.type.group}/${entry.type.version}`,
    });
    if (category === 'kustomizations' || category === 'helmreleases' || category === 'sources') {
      groupBuckets[category].entries.push(entry);
    }

    const items = entry.items ?? [];
    const kindCounts = emptyFluxCounts();
    for (const item of items) {
      kindCounts[fluxStateIndex(deliveryState(item))] += 1;
    }
    kinds.push({
      kind: entry.type.kind,
      key: entry.type.key,
      total: items.length,
      known: entry.items !== undefined && !entry.error,
      counts: kindCounts,
    });
  }

  const groups: FluxGroupSummary[] = (['kustomizations', 'helmreleases', 'sources'] as const).map((id) => {
    const bucket = groupBuckets[id];
    const groupCounts = emptyFluxCounts();
    let total = 0;
    for (const entry of bucket.entries) {
      for (const item of entry.items ?? []) {
        groupCounts[fluxStateIndex(deliveryState(item))] += 1;
        total += 1;
      }
    }
    const known = bucket.entries.length > 0 && bucket.entries.every((e) => e.items !== undefined && !e.error);
    return {
      id,
      label: bucket.label,
      known,
      discovered: bucket.entries.length > 0,
      total,
      counts: groupCounts,
    };
  });

  const namespaces = [...namespaceMap.values()].sort(
    (a, b) =>
      b.counts[2] - a.counts[2]
      || b.counts[1] - a.counts[1]
      || b.counts[3] - a.counts[3]
      || b.total - a.total
      || a.name.localeCompare(b.name),
  );

  kinds.sort(
    (a, b) =>
      b.counts[2] - a.counts[2]
      || b.total - a.total
      || a.kind.localeCompare(b.kind),
  );

  const total = primaryItems.length;
  const readyPercent = total ? Math.round((counts[0] / total) * 100) : 0;

  return {
    total,
    counts,
    readyPercent,
    namespaces,
    kinds,
    groups,
    changed24h: updated ? changed24h : null,
    timeline: buildFluxActivityTimeline(activity),
  };
}
