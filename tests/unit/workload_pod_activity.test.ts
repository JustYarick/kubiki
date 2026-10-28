import { expect, it } from 'vitest';
import { workloadPodActivity } from '../../src/core/resources/workload_pod_activity';
import { mapK8sResource } from '../../src/core/utils/k8s_mapper';
import { columnsFor } from '../../src/components/k8s/table/columns';
import type { ResourceItem } from '../../src/types/k8s';

function resource(kind: string, name: string, uid = name, namespace = 'backend', extra = {}): ResourceItem {
  return mapK8sResource({ apiVersion: kind === 'Pod' ? 'v1' : 'apps/v1', kind, metadata: { name, uid, namespace }, ...extra }, kind);
}
const owner = (item: ResourceItem) => ({ apiVersion: item.apiVersion, kind: item.kind, name: item.name, uid: item.uid });
function pod(name: string, parent: ResourceItem, phase = 'Running', terminating = false) {
  return resource('Pod', name, name, parent.namespace, {
    metadata: { name, uid: name, namespace: parent.namespace, ownerReferences: [owner(parent)], ...(terminating ? { deletionTimestamp: '2026-10-28T10:00:00Z' } : {}) },
    status: { phase, conditions: [{ type: 'Ready', status: phase === 'Running' ? 'True' : 'False' }] },
  });
}

it('counts ready / actual Deployment Pods across old and new ReplicaSets', () => {
  const deployment = resource('Deployment', 'web', 'dep', 'backend', { spec: { replicas: 2 }, status: { readyReplicas: 2 } });
  const sets = ['old', 'new'].map(name => resource('ReplicaSet', name, name, 'backend', {
    metadata: { name, uid: name, namespace: 'backend', ownerReferences: [owner(deployment)] },
  }));
  const pods = [pod('old-ready', sets[0]), pod('old-ending', sets[0], 'Running', true), pod('new-starting', sets[1], 'Pending')];
  const activity = workloadPodActivity([deployment], pods, sets);
  expect(activity.get(deployment.uid)).toEqual({ ready: 1, total: 3, pending: 1, terminating: 1 });
  const column = columnsFor('Deployment', { podActivity: activity }).find(column => column.id === 'pods')!;
  expect(column.get(deployment)).toBe('1/3');
  expect(column.podActivity?.(deployment)).toEqual({ ready: 1, total: 3, pending: 1, terminating: 1 });
  expect(workloadPodActivity([deployment], [pods[0], pod('new-starting', sets[1])], sets).get(deployment.uid))
    .toEqual({ ready: 2, total: 2, pending: 0, terminating: 0 });
});

it.each(['StatefulSet', 'DaemonSet', 'ReplicaSet', 'ReplicationController'])('counts direct %s owners and does not count a terminating Pending Pod twice', kind => {
  const workload = resource(kind, 'web');
  const pods = [pod('ready', workload), pod('starting', workload, 'Pending'), pod('ending', workload, 'Pending', true)];
  expect(workloadPodActivity([workload], pods).get(workload.uid)).toEqual({ ready: 1, total: 3, pending: 1, terminating: 1 });
});

it('rejects owners with stale UIDs, foreign namespaces, API groups or kinds even when names match', () => {
  const workload = resource('StatefulSet', 'web');
  const foreign = [
    { ...workload, uid: 'old' },
    { ...workload, namespace: 'other' },
    { ...workload, kind: 'Deployment' },
    { ...workload, apiVersion: 'example.com/v1' },
  ];
  expect(workloadPodActivity([workload], foreign.map((parent, index) => pod(`foreign-${index}`, parent, 'Pending'))).get(workload.uid)?.total).toBe(0);
});

it('does not attribute a recreated ReplicaSet or its Deployment to a stale owner reference', () => {
  const deployment = resource('Deployment', 'web');
  const rs = resource('ReplicaSet', 'web-rs', 'new-rs', 'backend', {
    metadata: { name: 'web-rs', uid: 'new-rs', namespace: 'backend', ownerReferences: [owner({ ...deployment, uid: 'old-deployment' })] },
  });
  expect(workloadPodActivity([deployment], [pod('current-rs-pod', rs, 'Pending'), pod('old-rs-pod', { ...rs, uid: 'old-rs' }, 'Pending')], [rs]).get(deployment.uid)?.total).toBe(0);
});

it('follows rollout readiness and excludes terminating Pods while keeping them in the total', () => {
  const workload = resource('StatefulSet', 'web', 'web', 'backend', { spec: { replicas: 2 }, status: { readyReplicas: 2 } });
  const old = [pod('old-one', workload), pod('old-two', workload)];
  const pending = [pod('new-one', workload, 'Pending'), pod('new-two', workload, 'Pending')];
  const ready = [pod('new-one', workload), pod('new-two', workload)];
  const terminating = [pod('old-one', workload, 'Running', true), pod('old-two', workload, 'Running', true)];
  const stages = [old, [...old, ...pending], [...old, ...ready], [...terminating, ...ready], ready, []];
  expect(stages.map(pods => columnsFor('StatefulSet', { podActivity: workloadPodActivity([workload], pods) }).find(column => column.id === 'pods')!.get(workload)))
    .toEqual(['2/2', '2/4', '4/4', '2/4', '2/2', '0/0']);
  expect(columnsFor('StatefulSet').find(column => column.id === 'pods')!.get(workload)).toBeUndefined();
});

it('uses Pod readiness gates and excludes terminating Pods even while their Ready condition remains True', () => {
  const workload = resource('Deployment', 'web');
  const notReady = pod('not-ready', workload);
  notReady.raw!.status = { phase: 'Running', conditions: [{ type: 'Ready', status: 'False' }], containerStatuses: [{ ready: true }] };
  const ending = pod('ending-ready', workload, 'Running', true);
  const ended = pod('completed', workload, 'Succeeded');
  expect(workloadPodActivity([workload], [notReady, ending, ended]).get(workload.uid)).toEqual({ ready: 0, total: 3, pending: 0, terminating: 1 });
  ending.raw!.status.conditions[0].status = 'False';
  expect(workloadPodActivity([workload], [notReady, ending, ended]).get(workload.uid)?.ready).toBe(0);
});

it.each(['deletionTimestamp', 'mapped status'])('excludes termination marked by %s when readiness falls back to container statuses', marker => {
  const workload = resource('StatefulSet', 'web');
  const ending = pod('ending', workload, 'Running', marker === 'deletionTimestamp');
  ending.raw!.status = { phase: 'Running', containerStatuses: [{ ready: true }] };
  ending.status = marker === 'mapped status' ? 'Terminating' : 'Running';
  expect(workloadPodActivity([workload], [ending]).get(workload.uid)).toEqual({ ready: 0, total: 1, pending: 0, terminating: 1 });
});
