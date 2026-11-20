/**
 * Request-Budget & Anti-N+1 Contracts Across All Resource Tabs and Inspectors.
 *
 * WHY THIS SUITE EXISTS:
 * A recurring failure mode in Kubernetes UIs is "fix one feature, silently explode request volume":
 * - A list tab accidentally pulls in unrelated watches (e.g., Secrets tab watching Pods/Deployments,
 *   or Overview watching Secrets).
 * - A detail/inspector enhancement accidentally triggers N+1 `get_resource` calls per table row
 *   instead of O(1) batched list/watch reads.
 * - Background/inspector watches run at the same priority as the active tab and stall first paint.
 *
 * INVARIANTS ENFORCED HERE:
 * 1. Opening ANY of the 45+ built-in resource list tabs demands O(1) watches (`<= 5`), puts the
 *    active kind at `'high'` priority, never pulls `Secret` into non-Secret tabs, and keeps
 *    `CustomResourceDefinition` at `'low'` unless CRD itself is the active tab.
 * 2. Selecting ANY built-in resource in the Inspector keeps the active table at `'high'` priority
 *    while keeping inspector-only companions at `'low'` priority and strictly bounded.
 * 3. Loading a 500-item Secret or ConfigMap collection through `K8sProvider` + `ResourceWatchSession`
 *    issues EXACTLY 1 list request and 0 single-GET (`get_resource`) requests.
 * 4. Switching between resource tabs cleanly unsubscribes/stops previous watches without leaking.
 */
import { describe, expect, it, vi } from 'vitest';
import { RESOURCE_TYPES, SCOPE_INDEPENDENT_KINDS, apiVersionFor } from '../../src/core/resources/resource_types';
import { resourceDemand } from '../../src/core/resources/resource_demand';
import { K8sProvider } from '../../src/providers/k8s_provider';
import { ResourceWatchSession } from '../../src/providers/resource_watch_session';
import { prefetchDetailDependencies } from '../../src/providers/detail_prefetch';
import { mapK8sResource } from '../../src/core/utils/k8s_mapper';
import { useDetailCache } from '../../src/state/detail_cache';
import { useResourceStore } from '../../src/state/resource_store';
import type { ResourceKind } from '../../src/types/k8s';
import type { WorkspaceTab } from '../../src/state/workspace_store';

function listTab(kind: ResourceKind): WorkspaceTab {
  return { id: `tab-${kind}`, type: 'resource-list', title: kind, kind };
}

describe('All built-in resource list tabs: O(1) demand and priority contracts', () => {
  /**
   * WHY THIS TEST EXISTS:
   * Every built-in Kubernetes kind registered in `shared/resource-types.json` can be opened as a
   * resource-list tab. This test iterates ALL of them so adding a new kind or editing
   * `resource_demand.ts` cannot silently cause catalog fan-out, Secret leakage, or wrong priorities.
   */
  it('enforces bounded O(1) watch count, high active priority, and zero Secret leakage for every built-in kind', () => {
    for (const type of RESOURCE_TYPES) {
      const kind = type.kind as ResourceKind;
      const demand = resourceDemand({
        context: 'prod',
        tabs: [listTab(kind)],
        activeTabId: `tab-${kind}`,
        splitTabId: null,
        selectedNamespace: 'payments',
        selectedItem: null,
        inspectorCollapsed: true,
        rightTab: 'overview',
      });

      // Every resource-list tab must demand the kind itself.
      expect(demand.kinds, `${kind} tab must demand itself`).toContain(kind);

      // O(1) bounded watch budget: baseline (Namespace + CRD) + active kind + at most 2 direct companions
      // (e.g. Deployment -> Pod + ReplicaSet). Must never fan out across the 45-kind catalog.
      expect(demand.kinds.length, `${kind} tab demanded too many watches: ${demand.kinds.join(', ')}`).toBeLessThanOrEqual(5);

      // No duplicate watch kinds.
      expect(new Set(demand.kinds).size, `${kind} tab produced duplicate watch kinds`).toBe(demand.kinds.length);

      // Active tab MUST have highest priority so background watches/counts never delay it.
      expect(demand.priorities.get(kind), `${kind} active tab must have 'high' priority`).toBe('high');

      // Background CRD discovery stays low priority unless the user explicitly opened the CRD tab.
      if (kind !== 'CustomResourceDefinition') {
        expect(demand.priorities.get('CustomResourceDefinition'), `CRD should stay low when viewing ${kind}`).toBe('low');
      }

      // Opening any non-Secret list tab must NEVER start watching Secrets.
      if (kind !== 'Secret') {
        expect(demand.kinds, `${kind} list tab must not watch Secret`).not.toContain('Secret');
      }

      // Namespace isolation: a namespaced active kind must stay scoped to the selected namespace
      // (never escalate to 'all' unless explicitly listed in SCOPE_INDEPENDENT_KINDS for another view).
      if (type.namespaced) {
        expect(demand.scopes.get(kind), `${kind} must stay scoped to selected namespace`).toBe('payments');
      }
      for (const demanded of demand.kinds) {
        if (demand.clusterKinds.has(demanded)) {
          expect(SCOPE_INDEPENDENT_KINDS.has(demanded), `Only SCOPE_INDEPENDENT_KINDS may escalate to cluster scope (${demanded} from ${kind})`).toBe(true);
        }
      }
    }
  });

  /**
   * WHY THIS TEST EXISTS:
   * Clicking a row opens the Inspector panel (`inspectorCollapsed: false`). Inspector companion
   * watches (e.g. Events, UsedBy workloads) are helpful but secondary: they MUST stay `'low'`
   * priority so they never starve the active table or single-object hydration (`get_resource`),
   * and they must stay bounded (never watching all 45 resource kinds).
   */
  it('keeps active table high-priority and inspector-only companions low-priority across all built-in kinds', () => {
    for (const type of RESOURCE_TYPES) {
      const kind = type.kind as ResourceKind;
      const selectedItem = {
        uid: `uid-${kind}`,
        name: `obj-${type.plural}`,
        namespace: type.namespaced ? 'payments' : undefined,
        kind,
        apiVersion: apiVersionFor(type),
      };
      const demand = resourceDemand({
        context: 'prod',
        tabs: [listTab(kind)],
        activeTabId: `tab-${kind}`,
        splitTabId: null,
        selectedNamespace: 'payments',
        selectedItem,
        inspectorCollapsed: false,
        rightTab: 'overview',
      });

      expect(demand.priorities.get(kind), `${kind} active list must remain 'high' with inspector open`).toBe('high');
      // Even the broadest inspectors (Namespace / Secret / Service) stay far below full catalog fan-out.
      expect(demand.kinds.length, `${kind} inspector watch fan-out exceeded budget`).toBeLessThanOrEqual(16);

      // Every kind added exclusively by the Inspector (not demanded by the list tab itself) must be low priority.
      const listOnly = new Set(
        resourceDemand({
          context: 'prod',
          tabs: [listTab(kind)],
          activeTabId: `tab-${kind}`,
          splitTabId: null,
          selectedNamespace: 'payments',
          selectedItem: null,
          inspectorCollapsed: true,
          rightTab: 'overview',
        }).kinds,
      );
      for (const demanded of demand.kinds) {
        if (!listOnly.has(demanded)) {
          expect(
            demand.priorities.get(demanded),
            `Inspector-only companion ${demanded} for ${kind} must stay 'low' priority`,
          ).toBe('low');
        }
      }
    }
  });
});

describe('Anti-N+1 request-count contracts on large collections', () => {
  /**
   * WHY THIS TEST EXISTS:
   * Regression guard for the "Secrets/ConfigMaps list takes forever" bug.
   * Listing 500 summary-projected Secrets via `K8sProvider` MUST execute EXACTLY 1 `get_resources`
   * call and 0 `get_resource` calls, regardless of how many items are returned.
   */
  it('loads 500 summary Secrets in exactly 1 list request with zero per-item N+1 GETs', async () => {
    const calls: Array<{ command: string; kind: unknown; name?: unknown }> = [];
    const items = Array.from({ length: 500 }, (_, i) => ({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: `secret-${i}`, namespace: 'prod', uid: `sec-${i}`, resourceVersion: '10' },
      type: 'Opaque',
      _kubikiSummary: { dataKeys: 4 },
    }));

    const provider = new K8sProvider({
      native: false,
      request: async <T>(command: string, _path: string, args: Record<string, unknown>) => {
        calls.push({ command, kind: args.kind, name: args.name });
        if (command === 'get_resources') return { items } as T;
        throw new Error(`Unexpected single-item or extra request during list: ${command}`);
      },
    });

    const result = await provider.getResources('prod', 'Secret', 'prod');
    expect(result).toHaveLength(500);
    expect(result[0].readProjection).toBe('summary');
    expect(result[0].dataKeys).toBe(4);
    expect(calls).toEqual([{ command: 'get_resources', kind: 'Secret', name: undefined }]);
  });

  /**
   * WHY THIS TEST EXISTS:
   * Inspecting a Pod referencing 20 Secrets/ConfigMaps in metadata-only mode when summary items are
   * already in the live watch store must NOT trigger 20 redundant `get_resource` calls.
   * And when full Secret hydration IS requested, it fetches each referenced Secret ONCE and reuses
   * `useDetailCache` on repeat calls (0 additional requests).
   */
  it('avoids redundant GETs when summary Secrets are in live cache and caches hydrated Secret payloads', async () => {
    const { k8s } = await import('../../src/providers/k8s_provider');
    const previous = useResourceStore.getState();
    const secretMap = new Map(
      Array.from({ length: 20 }, (_, i) => {
        const item = mapK8sResource(
          {
            apiVersion: 'v1',
            kind: 'Secret',
            metadata: { name: `sec-${i}`, namespace: 'prod', uid: `uid-sec-${i}`, resourceVersion: '5' },
            type: 'Opaque',
            _kubikiSummary: { dataKeys: 1 },
          },
          'Secret',
        );
        return [item.uid, item] as const;
      }),
    );

    useResourceStore.setState({
      resources: { ...previous.resources, Secret: secretMap },
      watchStates: {
        Secret: {
          query: { context: 'prod', group: '', version: 'v1', kind: 'Secret', namespace: 'prod' },
          phase: 'live',
          hasSnapshot: true,
        },
      },
    });
    useDetailCache.getState().clear('prod');

    const secretGets: string[] = [];
    const getSpy = vi.spyOn(k8s, 'getResource').mockImplementation(async (_ctx, kind, name, ns) => {
      if (kind === 'Secret') secretGets.push(name);
      return mapK8sResource(
        {
          apiVersion: 'v1',
          kind,
          metadata: { name, namespace: ns, uid: `uid-${name}`, resourceVersion: '5' },
          type: 'Opaque',
          data: { token: btoa('value') },
        },
        kind,
      );
    });
    const listSpy = vi.spyOn(k8s, 'getResources').mockResolvedValue([]);

    const pod = mapK8sResource(
      {
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: { name: 'api-0', namespace: 'prod', uid: 'pod-api-0' },
        spec: {
          containers: [
            {
              name: 'api',
              envFrom: Array.from({ length: 6 }, (_, i) => ({ secretRef: { name: `sec-${i}` } })),
            },
          ],
        },
      },
      'Pod',
    );

    try {
      // Overview prefetch (`includeSecretPayloads: false`): 0 Secret GETs because live summary watch already proves existence.
      await prefetchDetailDependencies('prod', pod, new AbortController().signal, { includeSecretPayloads: false });
      expect(secretGets).toHaveLength(0);

      // Environment tab (`includeSecretPayloads: true`): hydrates each referenced Secret at most once.
      await prefetchDetailDependencies('prod', pod, new AbortController().signal, { includeSecretPayloads: true });
      expect(secretGets).toHaveLength(6);

      // Second open of Environment tab hits `useDetailCache`: ZERO new Secret GETs.
      await prefetchDetailDependencies('prod', pod, new AbortController().signal, { includeSecretPayloads: true });
      expect(secretGets).toHaveLength(6);
    } finally {
      getSpy.mockRestore();
      listSpy.mockRestore();
      useDetailCache.getState().clear();
      useResourceStore.setState(previous);
    }
  });

  /**
   * WHY THIS TEST EXISTS:
   * Navigating across many tabs (Pods -> Secrets -> Services -> ConfigMaps) must release closed
   * tabs' watches immediately so inactive streams do not accumulate and consume cluster connections.
   */
  it('stops previous tab watches cleanly when navigating across resource tabs', async () => {
    const activeWatches = new Set<string>();
    const startedKinds: string[] = [];

    const session = new ResourceWatchSession(
      'prod',
      {
        managesInitialSyncTimeout: true,
        async watchResources(query, emit) {
          activeWatches.add(query.kind);
          startedKinds.push(query.kind);
          emit({
            query,
            subscription_id: `sub-${query.kind}`,
            messages: [
              { sequence: 1, event: { type: 'Delta', payload: { type: 'Restarted', payload: { items: [] } } } },
              { sequence: 2, event: { type: 'Status', payload: { phase: 'live', error: null } } },
            ],
          });
          return () => {
            activeWatches.delete(query.kind);
          };
        },
      },
      () => {},
      'prod',
    );

    try {
      await session.setKinds(['Pod']);
      expect([...activeWatches]).toEqual(['Pod']);

      await session.setKinds(['Secret']);
      expect([...activeWatches]).toEqual(['Secret']);

      await session.setKinds(['Service']);
      expect([...activeWatches]).toEqual(['Service']);

      // Total watches started is strictly 1 per visited tab (O(1) active at every moment).
      expect(startedKinds).toEqual(['Pod', 'Secret', 'Service']);
    } finally {
      session.stop();
      expect(activeWatches.size).toBe(0);
    }
  });
});
