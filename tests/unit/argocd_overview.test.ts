/**
 * Unit tests for Argo CD Overview pure analytics (Sync & Health axes,
 * Helm/Flux-synced color tokens, project and destination namespace sorting,
 * and 24h sync change counts).
 *
 * Purpose & invariants guarded:
 * 1. Argo CD Sync and Health palettes match Helm and Flux semantic tokens
 *    (Synced/Healthy=--status-ok, OutOfSync/Progressing=--status-warn,
 *     Degraded/Missing=--status-danger, Suspended=--status-pending, Unknown=--text-muted).
 * 2. Projects and destination namespaces sort degraded/missing first, then
 *    out-of-sync, then progressing, then total count.
 * 3. Independent Sync and Health counts stay separate so a Healthy+OutOfSync
 *    application is counted accurately on both axes without masking drift.
 */
import { describe, expect, it } from 'vitest';
import {
  ARGO_HEALTH_GROUPS,
  ARGO_SYNC_GROUPS,
  summarizeArgoOverview,
} from '../../src/core/resources/argocd_overview';
import type { GitOpsSnapshot } from '../../src/providers/use_gitops_dashboard';
import type { ResourceItem } from '../../src/types/k8s';

const makeApp = (
  name: string,
  spec: Record<string, any>,
  status: Record<string, any>,
): ResourceItem => ({
  uid: `app-${name}`,
  name,
  namespace: 'argocd',
  kind: 'Application',
  apiVersion: 'argoproj.io/v1alpha1',
  raw: { apiVersion: 'argoproj.io/v1alpha1', kind: 'Application', metadata: { name, namespace: 'argocd' }, spec, status },
});

const appEntry = (items: ResourceItem[]): GitOpsSnapshot => ({
  type: {
    key: 'custom:argoproj.io/v1alpha1/Application',
    name: 'applications.argoproj.io',
    uid: 'applications',
    group: 'argoproj.io',
    version: 'v1alpha1',
    kind: 'Application',
    plural: 'applications',
    namespaced: true,
    columns: [],
  },
  items,
});

describe('Argo CD Overview summary and Helm/Flux color parity', () => {
  it('uses Helm/Flux-aligned semantic status tokens for Sync and Health', () => {
    expect(ARGO_SYNC_GROUPS.map((g) => [g.id, g.color])).toEqual([
      ['Synced', 'var(--status-ok)'],
      ['OutOfSync', 'var(--status-warn)'],
      ['Unknown', 'var(--text-muted)'],
    ]);
    expect(ARGO_HEALTH_GROUPS.slice(0, 3).map((g) => [g.id, g.color])).toEqual([
      ['Healthy', 'var(--status-ok)'],
      ['Progressing', 'var(--status-warn)'],
      ['Degraded', 'var(--status-danger)'],
    ]);
  });

  it('aggregates independent Sync/Health ratios, sorts projects & destinations worst-first, and counts 24h activity', () => {
    const now = Date.parse('2026-11-20T12:00:00Z');
    const recent = '2026-11-20T11:00:00Z';
    const stale = '2026-11-01T11:00:00Z';

    const okApp = makeApp(
      'web',
      { project: 'core', destination: { namespace: 'frontend' } },
      { health: { status: 'Healthy' }, sync: { status: 'Synced' }, operationState: { finishedAt: stale } },
    );
    const driftedApp = makeApp(
      'checkout',
      { project: 'commerce', destination: { namespace: 'checkout' } },
      { health: { status: 'Healthy' }, sync: { status: 'OutOfSync' }, operationState: { finishedAt: recent } },
    );
    const degradedApp = makeApp(
      'billing',
      { project: 'payments', destination: { namespace: 'payments' } },
      { health: { status: 'Degraded' }, sync: { status: 'Synced' }, operationState: { finishedAt: recent } },
    );
    const apps = [okApp, driftedApp, degradedApp];
    const summary = summarizeArgoOverview([appEntry(apps)], apps, [], now);

    expect(summary.total).toBe(3);
    // Sync: [Synced=2, OutOfSync=1, Unknown=0]
    expect(summary.syncCounts).toEqual([2, 1, 0]);
    expect(summary.syncedPercent).toBe(67);
    // Health: [Healthy=2, Progressing=0, Degraded=1, Missing=0, Suspended=0, Unknown=0]
    expect(summary.healthCounts).toEqual([2, 0, 1, 0, 0, 0]);
    expect(summary.healthyPercent).toBe(67);
    expect(summary.degradedTotal).toBe(1);
    expect(summary.changed24h).toBe(2);

    // Projects and destinations prioritize degraded -> outOfSync -> healthy.
    expect(summary.projects.map((p) => p.name)).toEqual(['payments', 'commerce', 'core']);
    expect(summary.destinations.map((d) => d.name)).toEqual(['payments', 'checkout', 'frontend']);
  });
});
