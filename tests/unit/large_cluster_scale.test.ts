/**
 * Large-Cluster Scale & Algorithmic Complexity (Big-O) Guardrails.
 *
 * WHY THIS SUITE EXISTS:
 * Unit tests with 2–5 mock objects never notice O(N²) loops. On real production clusters with
 * 2,000–5,000 Pods, 1,000+ ReplicaSets, 2,000+ Secrets, and 3,000+ Events, a single nested `.find()`
 * or `.some()` inside a per-item loop executes millions of iterations and freezes the UI.
 *
 * HOW WE PREVENT FLAKINESS:
 * Instead of fragile microsecond timing ratios that break on noisy CI machines, each test combines:
 * 1. **Deterministic property-access counters (`Object.defineProperty`)**: mathematically verifies
 *    O(1) reads per object rather than O(N) scans per object (0% CPU/scheduling flakiness!).
 * 2. **Production-scale workloads (thousands of objects per kind)** with generous upper-bound
 *    wall-clock ceilings (`< 1500ms`) so catastrophic regressions fail loudly while normal runs
 *    finish in 5–50ms.
 */
import { describe, expect, it } from 'vitest';
import { mapK8sResourceList } from '../../src/core/utils/k8s_mapper';
import { findWorkloadPods } from '../../src/core/resources/workload_pods';
import { workloadPodActivity } from '../../src/core/resources/workload_pod_activity';
import { buildResourceGraph, buildRelatedGraph } from '../../src/core/resources/relationships';
import { resourceConsumers } from '../../src/core/resources/consumers';
import { releaseDiagnosticObjects, releaseHealth } from '../../src/core/resources/helm_diagnostics';
import { deliveryActivity } from '../../src/core/resources/delivery_activity';
import { searchDocument, searchResources } from '../../src/core/resource_search';
import { useResourceStore } from '../../src/state/resource_store';
import type { ResourceItem } from '../../src/types/k8s';

type ResourceBuckets = ReturnType<typeof useResourceStore.getState>['resources'];

function emptyBuckets(): ResourceBuckets {
  return Object.fromEntries(
    Object.keys(useResourceStore.getState().resources).map((kind) => [kind, new Map<string, ResourceItem>()]),
  ) as ResourceBuckets;
}

describe('Large-cluster Big-O complexity guardrails (thousands of objects per kind)', () => {
  /**
   * WHY THIS TEST EXISTS:
   * Regression guard for `workload_pods.ts` O(Pods × ReplicaSets) and O(Pods × Jobs) bugs.
   * Previously, `findWorkloadPods` scanned the entire ReplicaSet array inside `hasUnresolvedReplicaSetOwner`
   * and `ownedReplicaSets.some(...)` for EVERY Pod — causing 3,000,000+ iterations on 3,000 Pods × 1,000 RS.
   *
   * INVARIANT:
   * Resolving pods for a Deployment across 3,000 Pods and 1,000 ReplicaSets MUST touch each
   * ReplicaSet's `name` at most O(1) times (<= 6 reads per RS, NOT 3,000 reads per RS!).
   */
  it('findWorkloadPods stays O(Pods + ReplicaSets) with 3,000 Pods and 1,000 ReplicaSets', () => {
    const DEPLOY_UID = 'dep-target';
    const deployment: ResourceItem = {
      uid: DEPLOY_UID,
      name: 'checkout',
      namespace: 'prod',
      kind: 'Deployment',
      apiVersion: 'apps/v1',
      spec: { selector: { matchLabels: { app: 'checkout' } } },
      raw: { metadata: { name: 'checkout', namespace: 'prod', uid: DEPLOY_UID }, spec: { selector: { matchLabels: { app: 'checkout' } } } },
    };

    const RS_COUNT = 1000;
    const POD_COUNT = 3000;
    let rsNameReads = 0;

    const replicaSets = new Map<string, ResourceItem>();
    for (let i = 0; i < RS_COUNT; i++) {
      const ownedByTarget = i < 5;
      const rsName = `rs-${i}`;
      const rs: ResourceItem = {
        uid: `rs-uid-${i}`,
        name: rsName,
        namespace: 'prod',
        kind: 'ReplicaSet',
        apiVersion: 'apps/v1',
        raw: {
          metadata: {
            name: rsName,
            namespace: 'prod',
            uid: `rs-uid-${i}`,
            ownerReferences: [
              {
                kind: 'Deployment',
                apiVersion: 'apps/v1',
                name: ownedByTarget ? 'checkout' : `other-dep-${i}`,
                uid: ownedByTarget ? DEPLOY_UID : `other-dep-uid-${i}`,
              },
            ],
          },
        },
      };
      // Deterministic complexity probe: O(P × R) would read `rs.name` millions of times!
      Object.defineProperty(rs, 'name', {
        enumerable: true,
        get() {
          rsNameReads++;
          return rsName;
        },
      });
      replicaSets.set(rs.uid, rs);
    }

    const pods = new Map<string, ResourceItem>();
    for (let i = 0; i < POD_COUNT; i++) {
      const rsIdx = i % RS_COUNT;
      pods.set(`pod-uid-${i}`, {
        uid: `pod-uid-${i}`,
        name: `pod-${i}`,
        namespace: 'prod',
        kind: 'Pod',
        apiVersion: 'v1',
        labels: { app: rsIdx < 5 ? 'checkout' : `other-${rsIdx}` },
        raw: {
          metadata: {
            name: `pod-${i}`,
            namespace: 'prod',
            uid: `pod-uid-${i}`,
            ownerReferences: [{ kind: 'ReplicaSet', apiVersion: 'apps/v1', name: `rs-${rsIdx}`, uid: `rs-uid-${rsIdx}` }],
          },
        },
      });
    }

    const start = performance.now();
    const matched = findWorkloadPods(deployment, { Pod: pods, ReplicaSet: replicaSets });
    const elapsedMs = performance.now() - start;

    // 5 owned ReplicaSets × (3000 / 1000) = 15 Pods.
    expect(matched).toHaveLength(15);
    // O(P + R) bound: each of the 1,000 RS is indexed once (<= 6 reads/RS). O(P × R) would exceed 1,000,000 reads!
    expect(rsNameReads, 'Quadratic scan detected in findWorkloadPods!').toBeLessThan(RS_COUNT * 6);
    expect(elapsedMs).toBeLessThan(1000);
  });

  /**
   * WHY THIS TEST EXISTS:
   * Regression guard for `workload_pods.ts` CronJob -> Job -> Pod resolution with hundreds of
   * historical Jobs and thousands of Pods.
   *
   * INVARIANT:
   * Complexity MUST stay O(Pods + Jobs), touching each Job's `name` at most O(1) times.
   */
  it('findWorkloadPods for CronJob stays O(Pods + Jobs) with 3,000 Pods and 600 Jobs', () => {
    const CRON_UID = 'cron-nightly';
    const cronJob: ResourceItem = {
      uid: CRON_UID,
      name: 'nightly-sync',
      namespace: 'batch',
      kind: 'CronJob',
      apiVersion: 'batch/v1',
    };

    const JOB_COUNT = 600;
    const POD_COUNT = 3000;
    let jobNameReads = 0;

    const jobs = new Map<string, ResourceItem>();
    for (let i = 0; i < JOB_COUNT; i++) {
      const owned = i < 20;
      const jobName = `job-${i}`;
      const job: ResourceItem = {
        uid: `job-uid-${i}`,
        name: jobName,
        namespace: 'batch',
        kind: 'Job',
        apiVersion: 'batch/v1',
        raw: {
          metadata: {
            name: jobName,
            namespace: 'batch',
            uid: `job-uid-${i}`,
            ownerReferences: owned ? [{ kind: 'CronJob', apiVersion: 'batch/v1', name: 'nightly-sync', uid: CRON_UID }] : [],
          },
        },
      };
      Object.defineProperty(job, 'name', {
        enumerable: true,
        get() {
          jobNameReads++;
          return jobName;
        },
      });
      jobs.set(job.uid, job);
    }

    const pods = new Map<string, ResourceItem>();
    for (let i = 0; i < POD_COUNT; i++) {
      const jobIdx = i % JOB_COUNT;
      pods.set(`pod-${i}`, {
        uid: `pod-${i}`,
        name: `pod-${i}`,
        namespace: 'batch',
        kind: 'Pod',
        apiVersion: 'v1',
        raw: {
          metadata: {
            name: `pod-${i}`,
            namespace: 'batch',
            uid: `pod-${i}`,
            ownerReferences: [{ kind: 'Job', apiVersion: 'batch/v1', name: `job-${jobIdx}`, uid: `job-uid-${jobIdx}` }],
          },
        },
      });
    }

    const matched = findWorkloadPods(cronJob, { Pod: pods, Job: jobs });
    expect(matched).toHaveLength(100);
    // O(P + J): <= 6 reads per Job vs 60,000+ reads under nested `.some()`.
    expect(jobNameReads, 'Quadratic scan detected in CronJob findWorkloadPods!').toBeLessThan(JOB_COUNT * 6);
  });

  /**
   * WHY THIS TEST EXISTS:
   * Regression guard for `relationships.ts` O(GitOps × N) bug where resolving every Flux reference
   * ran `all.find(candidate => candidate.kind === ref.kind && gitOpsFamily(candidate) === 'flux')`.
   *
   * INVARIANT:
   * Building a graph with 2,000 Pods + 300 Flux HelmReleases/Kustomizations MUST NOT scan `all`
   * per Flux object. Each Pod's `kind` is read O(1) times (<= 20), NEVER O(GitOps) times (~300+).
   */
  it('buildResourceGraph stays O(N) with 2,000 Pods and 300 Flux GitOps objects (zero scan growth per Flux item)', () => {
    const measurePodKindReadsPerPod = (podCount: number, fluxCount: number) => {
      const resources = emptyBuckets();
      let podKindReads = 0;

      for (let i = 0; i < podCount; i++) {
        const pod: ResourceItem = {
          uid: `pod-${i}`,
          name: `pod-${i}`,
          namespace: 'prod',
          kind: 'Pod',
          apiVersion: 'v1',
          labels: { app: `svc-${i % 50}` },
          raw: { metadata: { name: `pod-${i}`, namespace: 'prod', uid: `pod-${i}` }, spec: { containers: [] } },
        };
        Object.defineProperty(pod, 'kind', {
          enumerable: true,
          get() {
            podKindReads++;
            return 'Pod';
          },
        });
        resources.Pod.set(pod.uid, pod);
      }

      const fluxRepoBucket = new Map<string, ResourceItem>();
      fluxRepoBucket.set('repo-0', {
        uid: 'repo-0',
        name: 'charts',
        namespace: 'flux-system',
        kind: 'HelmRepository',
        apiVersion: 'source.toolkit.fluxcd.io/v1',
        raw: { metadata: { name: 'charts', namespace: 'flux-system', uid: 'repo-0' }, spec: { type: 'oci', url: 'oci://example.io/charts' } },
      });
      resources['custom:source.toolkit.fluxcd.io/HelmRepository'] = fluxRepoBucket;

      const fluxHrBucket = new Map<string, ResourceItem>();
      for (let i = 0; i < fluxCount; i++) {
        fluxHrBucket.set(`hr-${i}`, {
          uid: `hr-${i}`,
          name: `release-${i}`,
          namespace: 'prod',
          kind: 'HelmRelease',
          apiVersion: 'helm.toolkit.fluxcd.io/v2',
          raw: {
            metadata: { name: `release-${i}`, namespace: 'prod', uid: `hr-${i}` },
            spec: {
              chart: { spec: { chart: 'app', sourceRef: { kind: 'HelmRepository', name: 'charts', namespace: 'flux-system' } } },
            },
          },
        });
      }
      resources['custom:helm.toolkit.fluxcd.io/HelmRelease'] = fluxHrBucket;

      const start = performance.now();
      const graph = buildResourceGraph(resources);
      const elapsedMs = performance.now() - start;
      return { graph, elapsedMs, readsPerPod: podKindReads / podCount };
    };

    const small = measurePodKindReadsPerPod(2000, 10);
    const large = measurePodKindReadsPerPod(2000, 300);

    expect(large.graph.items.size).toBe(2000 + 300 + 1);
    expect(large.graph.relations.length).toBeGreaterThanOrEqual(300);
    // INVARIANT: Adding 290 more Flux objects must cause ZERO extra scans of existing Pods.
    // Under the old `all.find(...)` bug, `large.readsPerPod - small.readsPerPod` was ~290!
    expect(
      large.readsPerPod - small.readsPerPod,
      'Quadratic Flux all.find() scan regressed in buildResourceGraph!',
    ).toBeLessThanOrEqual(1);
    expect(large.elapsedMs).toBeLessThan(1500);
  });

  /**
   * WHY THIS TEST EXISTS:
   * Regression guard for `helm_diagnostics.ts` `releaseDiagnosticObjects` fixed-point `while (changed)`
   * loop over all loaded cluster objects. With a 4-hop ownership chain (Deployment -> RS -> Pod -> Sub)
   * across 3,000 objects, the old loop rescanned all 3,000 objects on every hop.
   *
   * INVARIANT:
   * `releaseDiagnosticObjects` MUST index `ownerReferences` in ONE single O(N) pass and traverse
   * descendants via BFS, touching each unrelated object's `raw` at most twice (never once per depth hop).
   */
  it('releaseDiagnosticObjects discovers deep descendants in a single O(N) pass across 3,000 objects', () => {
    const release = {
      name: 'payments',
      namespace: 'prod',
      revision: '4',
      updated: '2026-11-20T10:00:00Z',
      status: 'deployed',
      chart: 'payments-1.0.0',
      app_version: '1.0.0',
    };

    const dep: ResourceItem = {
      uid: 'dep-1',
      name: 'payments-api',
      namespace: 'prod',
      kind: 'Deployment',
      apiVersion: 'apps/v1',
      raw: {
        metadata: {
          name: 'payments-api',
          namespace: 'prod',
          uid: 'dep-1',
          labels: { 'app.kubernetes.io/managed-by': 'Helm' },
          annotations: { 'meta.helm.sh/release-name': 'payments', 'meta.helm.sh/release-namespace': 'prod' },
        },
      },
    };
    const rs: ResourceItem = {
      uid: 'rs-1',
      name: 'payments-api-rs',
      namespace: 'prod',
      kind: 'ReplicaSet',
      apiVersion: 'apps/v1',
      raw: { metadata: { name: 'payments-api-rs', namespace: 'prod', uid: 'rs-1', ownerReferences: [{ uid: 'dep-1' }] } },
    };
    const pod: ResourceItem = {
      uid: 'pod-1',
      name: 'payments-api-pod',
      namespace: 'prod',
      kind: 'Pod',
      apiVersion: 'v1',
      raw: { metadata: { name: 'payments-api-pod', namespace: 'prod', uid: 'pod-1', ownerReferences: [{ uid: 'rs-1' }] } },
    };
    const child: ResourceItem = {
      uid: 'claim-1',
      name: 'payments-api-claim',
      namespace: 'prod',
      kind: 'ResourceClaim',
      apiVersion: 'resource.k8s.io/v1',
      raw: { metadata: { name: 'payments-api-claim', namespace: 'prod', uid: 'claim-1', ownerReferences: [{ uid: 'pod-1' }] } },
    };

    const NOISE_COUNT = 3000;
    let noiseRawReads = 0;
    const loaded: ResourceItem[] = [dep, rs, pod, child];
    for (let i = 0; i < NOISE_COUNT; i++) {
      const rawObj = { metadata: { name: `noise-${i}`, namespace: 'prod', uid: `noise-${i}`, ownerReferences: [] } };
      const noise: ResourceItem = {
        uid: `noise-${i}`,
        name: `noise-${i}`,
        namespace: 'prod',
        kind: 'Pod',
        apiVersion: 'v1',
        raw: rawObj,
      };
      Object.defineProperty(noise, 'raw', {
        enumerable: true,
        get() {
          noiseRawReads++;
          return rawObj;
        },
      });
      loaded.push(noise);
    }

    const start = performance.now();
    const discovered = releaseDiagnosticObjects(release, [], loaded);
    const elapsedMs = performance.now() - start;

    expect(discovered.map((d) => d.uid).sort()).toEqual(['claim-1', 'dep-1', 'pod-1', 'rs-1']);
    // 1 read in `releaseObjects` + 1 read building `childrenByOwnerUid` = 2 reads per unrelated object.
    // The old `while (changed)` fixed-point loop did 1 + 4 = 5+ reads per unrelated object!
    expect(noiseRawReads / NOISE_COUNT, 'Multi-pass fixed-point rescan regressed in releaseDiagnosticObjects!').toBeLessThanOrEqual(2.5);
    expect(elapsedMs).toBeLessThan(500);
  });

  /**
   * WHY THIS TEST EXISTS:
   * End-to-end scale check on all remaining high-volume read/index paths on a synthetic production
   * cluster: mapping 3,000 Pods + 2,000 summary Secrets, computing `workloadPodActivity` for 500
   * Deployments × 1,000 RS × 3,000 Pods, `resourceConsumers` + `buildRelatedGraph` for a Secret,
   * `deliveryActivity` across 3,000 Events, `releaseHealth`, and full-text `searchResources` over
   * 5,000 documents.
   */
  it('handles production-scale mapping, workload activity, consumers, events, and search within budget', () => {
    const start = performance.now();

    // 1. Map 3,000 Pods + 2,000 summary Secrets.
    const rawPods = {
      items: Array.from({ length: 3000 }, (_, i) => ({
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: {
          name: `pod-${i}`,
          namespace: `ns-${i % 10}`,
          uid: `p-${i}`,
          labels: { app: `app-${i % 500}` },
          ownerReferences: [{ apiVersion: 'apps/v1', kind: 'ReplicaSet', name: `rs-${i % 1000}`, uid: `rs-${i % 1000}` }],
          creationTimestamp: '2026-11-20T00:00:00Z',
        },
        spec: {
          nodeName: `node-${i % 20}`,
          containers: [{ name: 'app', image: 'nginx:1.27', envFrom: i < 5 ? [{ secretRef: { name: 'shared-secret' } }] : undefined }],
        },
        status: { phase: 'Running', containerStatuses: [{ name: 'app', ready: true, restartCount: 0 }] },
      })),
    };
    const mappedPods = mapK8sResourceList(rawPods, 'Pod');
    expect(mappedPods).toHaveLength(3000);

    const rawSecrets = {
      items: Array.from({ length: 2000 }, (_, i) => ({
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: { name: i === 0 ? 'shared-secret' : `secret-${i}`, namespace: 'ns-0', uid: `s-${i}`, resourceVersion: '1' },
        type: 'Opaque',
        _kubikiSummary: { dataKeys: 3 },
      })),
    };
    const mappedSecrets = mapK8sResourceList(rawSecrets, 'Secret');
    expect(mappedSecrets).toHaveLength(2000);
    expect(mappedSecrets[0].readProjection).toBe('summary');

    // 2. Workload Pod Activity across 500 Deployments × 1,000 RS × 3,000 Pods.
    const deployments: ResourceItem[] = Array.from({ length: 500 }, (_, i) => ({
      uid: `dep-${i}`,
      name: `app-${i}`,
      namespace: `ns-${i % 10}`,
      kind: 'Deployment',
      apiVersion: 'apps/v1',
    }));
    const replicaSets: ResourceItem[] = Array.from({ length: 1000 }, (_, i) => ({
      uid: `rs-${i}`,
      name: `rs-${i}`,
      namespace: `ns-${i % 10}`,
      kind: 'ReplicaSet',
      apiVersion: 'apps/v1',
      raw: {
        metadata: {
          name: `rs-${i}`,
          namespace: `ns-${i % 10}`,
          uid: `rs-${i}`,
          ownerReferences: [{ apiVersion: 'apps/v1', kind: 'Deployment', name: `app-${i % 500}`, uid: `dep-${i % 500}` }],
        },
      },
    }));
    const activity = workloadPodActivity(deployments, mappedPods, replicaSets);
    expect(activity.size).toBe(500);
    expect(activity.get('dep-0')?.total).toBe(6);

    // 3. Consumers & Related graph for a single Secret inside the 5,000-object cluster.
    const buckets = emptyBuckets();
    for (const pod of mappedPods) buckets.Pod.set(pod.uid, pod);
    for (const secret of mappedSecrets) buckets.Secret.set(secret.uid, secret);
    const sharedSecret = mappedSecrets[0];
    const consumers = resourceConsumers(buckets, sharedSecret);
    expect(consumers.length).toBeGreaterThan(0);
    const related = buildRelatedGraph(buckets, sharedSecret);
    expect(related.items.size).toBeGreaterThan(1);

    // 4. Delivery events matching across 3,000 Events (exercises O(1) `eventReference`).
    const events: ResourceItem[] = Array.from({ length: 3000 }, (_, i) => ({
      uid: `ev-${i}`,
      name: `ev-${i}`,
      namespace: `ns-${i % 10}`,
      kind: 'Event',
      apiVersion: 'v1',
      raw: {
        type: i % 5 === 0 ? 'Warning' : 'Normal',
        reason: 'Scheduled',
        message: `Event ${i}`,
        lastTimestamp: '2026-11-20T10:00:00Z',
        involvedObject: { kind: 'Pod', name: `pod-${i}`, namespace: `ns-${i % 10}`, uid: `p-${i}` },
      },
    }));
    const matchedEvents = deliveryActivity(events, mappedPods.slice(0, 10));
    expect(matchedEvents).toHaveLength(10);

    // 5. Release health mapping across 100 expected rendered objects vs 3,000 loaded objects.
    const health = releaseHealth(mappedPods.slice(0, 100), mappedPods);
    expect(health).toHaveLength(100);

    // 6. Search across 5,000 documents (3,000 Pods + 2,000 Secrets).
    const docs = [...mappedPods, ...mappedSecrets].map(searchDocument);
    const search = searchResources(docs, { query: 'kind:Secret shared-secret', regex: false, caseSensitive: false });
    expect(search.hits).toHaveLength(1);

    const elapsedMs = performance.now() - start;
    expect(elapsedMs, `Large-cluster pipeline took ${elapsedMs.toFixed(1)}ms`).toBeLessThan(2500);
  });
});
