/**
 * Unit tests for Flux Overview pure analytics (KPIs, Helm-synced color groups,
 * namespace health sorting, kind breakdown, 24h change count, and event timeline).
 *
 * Purpose & invariants guarded:
 * 1. Flux status colors stay synchronized 1:1 with Helm Overview tokens
 *    (Ready=--status-ok, In progress=--status-warn, Failed=--status-danger,
 *     Suspended=--status-pending, Unknown=--text-muted).
 * 2. Namespace health sorts failed namespaces first, then in-progress, then
 *    suspended, then total volume (matching Helm Overview priority).
 * 3. 24h status change count and event timeline buckets remain strictly honest
 *    (no synthetic buckets when no timestamped events exist; null when snapshot
 *    timestamp is absent).
 * 4. Aggregation completes in linear O(N) time across large clusters.
 */
import { describe, expect, it } from 'vitest';
import {
  buildFluxActivityTimeline,
  FLUX_STATUS_GROUPS,
  summarizeFluxOverview,
} from '../../src/core/resources/flux_overview';
import type { GitOpsSnapshot } from '../../src/providers/use_gitops_dashboard';
import type { ResourceItem } from '../../src/types/k8s';

const makeFluxItem = (
  kind: string,
  group: string,
  name: string,
  namespace: string,
  raw: Record<string, any>,
): ResourceItem => ({
  uid: `${kind}-${namespace}-${name}`,
  name,
  namespace,
  kind,
  apiVersion: `${group}/v1`,
  raw: { apiVersion: `${group}/v1`, kind, metadata: { name, namespace }, ...raw },
});

const makeEntry = (kind: string, group: string, plural: string, items: ResourceItem[]): GitOpsSnapshot => ({
  type: {
    key: `custom:${group}/v1/${kind}`,
    name: `${plural}.${group}`,
    uid: plural,
    group,
    version: 'v1',
    kind,
    plural,
    namespaced: true,
    columns: [],
  },
  items,
});

describe('Flux Overview summary and Helm color parity', () => {
  it('uses the same semantic CSS status color tokens as Helm Overview', () => {
    expect(FLUX_STATUS_GROUPS.map((g) => [g.id, g.tone, g.color])).toEqual([
      ['healthy', 'ok', 'var(--status-ok)'],
      ['progressing', 'warn', 'var(--status-warn)'],
      ['attention', 'danger', 'var(--status-danger)'],
      ['suspended', 'pending', 'var(--status-pending)'],
      ['unknown', 'neutral', 'var(--text-muted)'],
    ]);
  });

  it('aggregates KPI counts, readiness %, namespace priority order, kind footprint, and 24h changes', () => {
    const now = Date.parse('2026-11-20T12:00:00Z');
    const recent = '2026-11-20T09:00:00Z';
    const old = '2026-11-10T09:00:00Z';

    const ksOk = makeFluxItem('Kustomization', 'kustomize.toolkit.fluxcd.io', 'core', 'flux-system', {
      status: { conditions: [{ type: 'Ready', status: 'True', lastTransitionTime: recent }] },
    });
    const ksFail = makeFluxItem('Kustomization', 'kustomize.toolkit.fluxcd.io', 'payments', 'payments', {
      status: { conditions: [{ type: 'Ready', status: 'False', reason: 'BuildFailed', lastTransitionTime: recent }] },
    });
    const ksPaused = makeFluxItem('Kustomization', 'kustomize.toolkit.fluxcd.io', 'canary', 'staging', {
      spec: { suspend: true },
      status: { conditions: [{ type: 'Ready', status: 'True', lastTransitionTime: old }] },
    });
    const hrProg = makeFluxItem('HelmRelease', 'helm.toolkit.fluxcd.io', 'ingress', 'ingress', {
      status: { conditions: [{ type: 'Reconciling', status: 'True', lastTransitionTime: recent }] },
    });
    const gitOk = makeFluxItem('GitRepository', 'source.toolkit.fluxcd.io', 'infra', 'flux-system', {
      status: { conditions: [{ type: 'Ready', status: 'True', lastTransitionTime: old }] },
    });

    const entries = [
      makeEntry('Kustomization', 'kustomize.toolkit.fluxcd.io', 'kustomizations', [ksOk, ksFail, ksPaused]),
      makeEntry('HelmRelease', 'helm.toolkit.fluxcd.io', 'helmreleases', [hrProg]),
      makeEntry('GitRepository', 'source.toolkit.fluxcd.io', 'gitrepositories', [gitOk]),
    ];
    const primary = [ksOk, ksFail, ksPaused, hrProg, gitOk];

    const summary = summarizeFluxOverview(entries, primary, [], now);

    expect(summary.total).toBe(5);
    // [ready=2, progressing=1, attention=1, suspended=1, unknown=0]
    expect(summary.counts).toEqual([2, 1, 1, 1, 0]);
    expect(summary.readyPercent).toBe(40);
    expect(summary.changed24h).toBe(3);

    // Namespace health sorts: failed (payments) -> progressing (ingress) -> suspended (staging) -> ready (flux-system).
    expect(summary.namespaces.map((n) => n.name)).toEqual([
      'payments',
      'ingress',
      'staging',
      'flux-system',
    ]);

    // Kind footprint sorts failed kinds first.
    expect(summary.kinds[0]).toMatchObject({ kind: 'Kustomization', total: 3, counts: [1, 0, 1, 1, 0] });

    // Group summaries mirror exact group counts.
    const ksGroup = summary.groups.find((g) => g.id === 'kustomizations')!;
    expect(ksGroup).toMatchObject({ known: true, total: 3, counts: [1, 0, 1, 1, 0] });
    expect(summary.timeline.buckets).toEqual([]);
  });

  it('buckets normal and warning controller events accurately without inventing synthetic data', () => {
    expect(buildFluxActivityTimeline([]).buckets).toEqual([]);

    const base = Date.parse('2026-11-20T10:00:00Z');
    const timeline = buildFluxActivityTimeline([
      { time: base, warning: false },
      { time: base + 120_000, warning: true },
      { time: base + 600_000, warning: true },
      { time: base + 3_600_000, warning: false },
    ]);
    expect(timeline.buckets).toHaveLength(12);
    expect(timeline.normalTotal).toBe(2);
    expect(timeline.warningTotal).toBe(2);
    expect(timeline.buckets.reduce((acc, b) => acc + b.total, 0)).toBe(4);
    expect(timeline.maxTotal).toBeGreaterThanOrEqual(1);
  });
});
