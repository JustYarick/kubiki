import { describe, expect, it } from 'vitest';
import { resourceIssues } from '../../src/core/resources/diagnostics';
import { mapK8sResource } from '../../src/core/utils/k8s_mapper';
import type { ResourceKind } from '../../src/types/k8s';

const now = Date.parse('2026-10-20T12:00:00Z');
const resource = (kind: ResourceKind, spec: object = {}, status: object = {}, metadata: object = {}) => mapK8sResource({ apiVersion: 'v1', metadata: { uid: `${kind}-uid`, name: 'example', namespace: 'default', creationTimestamp: '2026-10-20T11:30:00Z', ...metadata }, spec, status }, kind);

describe('Resource diagnostics', () => {
  it('reports the real container failure reason and message even when the Pod phase is Running', () => {
    const pod = resource('Pod', { containers: [{ name: 'app' }] }, { phase: 'Running', containerStatuses: [{ name: 'app', ready: false, state: { waiting: { reason: 'CrashLoopBackOff', message: 'Back-off restarting failed container app' } } }] });
    expect(resourceIssues(pod, { now })).toContainEqual({ id: 'container:app', severity: 'error', summary: 'Container app: CrashLoopBackOff', message: 'Back-off restarting failed container app' });
  });
  it('reports failing init containers, not completed initialization', () => {
    const pod = resource('Pod', {}, { phase: 'Pending', initContainerStatuses: [{ name: 'init', state: { waiting: { reason: 'ImagePullBackOff', message: 'registry denied' } } }] });
    expect(resourceIssues(pod, { now }).find((issue) => issue.id === 'container:init')?.message).toBe('registry denied');
    const starting = resource('Pod', {}, { phase: 'Pending', initContainerStatuses: [{ name: 'init', state: { terminated: { exitCode: 0, reason: 'Completed' } } }] }, { creationTimestamp: '2026-10-20T11:59:50Z' });
    expect(resourceIssues(starting, { now })).toEqual([]);
  });
  it('uses the scheduler message for unschedulable Pods', () => {
    const pod = resource('Pod', {}, { phase: 'Pending', conditions: [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable', message: '0/3 nodes are available: Insufficient memory' }] });
    expect(resourceIssues(pod, { now })[0].message).toContain('Insufficient memory');
  });
  it('does not flag a normal startup, a ready Pod with old restarts, or a completed Pod', () => {
    const starting = resource('Pod', {}, { phase: 'Pending' }, { creationTimestamp: '2026-10-20T11:59:30Z' });
    const ready = resource('Pod', { containers: [{ name: 'app' }] }, { phase: 'Running', containerStatuses: [{ name: 'app', ready: true, restartCount: 7, state: { running: {} } }] });
    const completed = resource('Pod', {}, { phase: 'Succeeded', containerStatuses: [{ name: 'app', state: { terminated: { exitCode: 0, reason: 'Completed' } } }] });
    for (const item of [starting, ready, completed]) expect(resourceIssues(item, { now })).toEqual([]);
  });
  it('flags incomplete workloads and preserves controller failure messages', () => {
    for (const kind of ['Deployment', 'ReplicaSet', 'StatefulSet'] as const) {
      expect(resourceIssues(resource(kind, { replicas: 3 }, { readyReplicas: 1 }), { now }).some((issue) => issue.summary === '1/3 replicas are ready')).toBe(true);
    }
    const deployment = resource('Deployment', { replicas: 3 }, { conditions: [{ type: 'Progressing', status: 'False', reason: 'ProgressDeadlineExceeded', message: 'ReplicaSet timed out progressing' }] });
    expect(resourceIssues(deployment, { now })[0].message).toBe('ReplicaSet timed out progressing');
    const daemonSet = resource('DaemonSet', {}, { desiredNumberScheduled: 4, numberReady: 2 });
    expect(resourceIssues(daemonSet, { now })[0].summary).toBe('2/4 replicas are ready');
  });
  it('does not flag intentional scale-to-zero, even with an old unavailable condition', () => {
    const idle = resource('Deployment', { replicas: 0 }, { readyReplicas: 0, conditions: [{ type: 'Available', status: 'False', reason: 'MinimumReplicasUnavailable' }] });
    expect(resourceIssues(idle, { now })).toEqual([]);
  });
  it('ignores stale generation-scoped conditions', () => {
    const crd = resource('CustomResourceDefinition', {}, { conditions: [{ type: 'Established', status: 'False', observedGeneration: 1, reason: 'OldError' }] }, { generation: 2 });
    expect(resourceIssues(crd, { now })).toEqual([]);
  });
  it('reports Node readiness and pressure with their declared polarity', () => {
    const node = resource('Node', {}, { conditions: [{ type: 'Ready', status: 'Unknown', reason: 'NodeStatusUnknown', message: 'Kubelet stopped posting node status' }, { type: 'MemoryPressure', status: 'True', reason: 'KubeletHasInsufficientMemory' }] });
    const issues = resourceIssues(node, { now });
    expect(issues).toHaveLength(2);
    expect(issues[0].message).toBe('Kubelet stopped posting node status');
    expect(resourceIssues(resource('Node', { unschedulable: true }, { conditions: [{ type: 'Ready', status: 'True' }, { type: 'MemoryPressure', status: 'False' }] }), { now })).toEqual([]);
  });
  it('reports failed Jobs but does not flag completed Jobs that previously retried', () => {
    const failed = resource('Job', {}, { failed: 1, conditions: [{ type: 'Failed', status: 'True', reason: 'BackoffLimitExceeded', message: 'Job has reached the specified backoff limit' }] });
    expect(resourceIssues(failed, { now })[0].message).toContain('backoff limit');
    const completed = resource('Job', { completions: 1 }, { failed: 2, succeeded: 1, conditions: [{ type: 'Complete', status: 'True' }] });
    expect(resourceIssues(completed, { now })).toEqual([]);
  });
  it('reports lost volumes and accounts for delayed WaitForFirstConsumer binding', () => {
    expect(resourceIssues(resource('PersistentVolumeClaim', {}, { phase: 'Lost' }), { now })[0].severity).toBe('error');
    const claim = resource('PersistentVolumeClaim', { storageClassName: 'local' }, { phase: 'Pending' });
    const storageClass = resource('StorageClass'); storageClass.raw!.volumeBindingMode = 'WaitForFirstConsumer';
    expect(resourceIssues(claim, { now, storageClass })).toEqual([]);
    expect(resourceIssues(claim, { now })[0].id).toBe('volume-pending');
  });
  it('reports missing Service selector matches only when Pod snapshots are known to be loaded', () => {
    const service = resource('Service', { selector: { app: 'web' } });
    expect(resourceIssues(service, { now, pods: [], podsLoaded: false })).toEqual([]);
    expect(resourceIssues(service, { now, pods: [], podsLoaded: true })[0].summary).toBe('Selector matches no loaded Pods');
    const pod = resource('Pod', {}, {}, { labels: { app: 'web' } });
    expect(resourceIssues(service, { now, pods: [pod], podsLoaded: true })).toEqual([]);
    expect(resourceIssues(resource('Service', {}), { now, pods: [], podsLoaded: true })).toEqual([]);
  });
  it('does not invent problems for plain ConfigMap/Secret/StorageClass resources', () => {
    for (const kind of ['ConfigMap', 'Secret', 'StorageClass'] as const) expect(resourceIssues(resource(kind), { now })).toEqual([]);
  });
});
