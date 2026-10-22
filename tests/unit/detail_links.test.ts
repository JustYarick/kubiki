import { describe, it, expect } from 'vitest';
import {
  ownerWorkload,
  podsForSelector,
  resourceByRef,
  serviceForEndpointSlice,
  workloadsForPods,
} from '../../src/core/resources/detail_links';
import type { ResourceItem } from '../../src/types/k8s';

const item = (kind: string, name: string, extra: Record<string, any> = {}): ResourceItem => ({
  uid: `${kind}/${name}`, kind, name, apiVersion: 'v1', raw: {}, ...extra,
});

const resources = {
  Pod: new Map([
    ['Pod/web-1', item('Pod', 'web-1', { namespace: 'backend', labels: { app: 'web' } })],
    ['Pod/api-1', item('Pod', 'api-1', { namespace: 'backend', labels: { app: 'api' } })],
  ]),
  ReplicaSet: new Map([
    ['ReplicaSet/web-abc', item('ReplicaSet', 'web-abc', {
      namespace: 'backend',
      raw: { metadata: { ownerReferences: [{ kind: 'Deployment', name: 'web', uid: 'Deployment/web' }] } },
    })],
  ]),
  Deployment: new Map([
    ['Deployment/web', item('Deployment', 'web', { namespace: 'backend', apiVersion: 'apps/v1' })],
  ]),
  Service: new Map([
    ['Service/web-service', item('Service', 'web-service', { namespace: 'backend' })],
  ]),
};

describe('detail links', () => {
  it('resolves a reference by kind, name and namespace', () => {
    expect(resourceByRef(resources, { kind: 'Deployment', name: 'web', namespace: 'backend' })?.name).toBe('web');
    expect(resourceByRef(resources, { kind: 'Deployment', name: 'web', namespace: 'other' })).toBeUndefined();
    expect(resourceByRef(resources, { name: 'web' }, { kinds: ['Deployment'] })?.kind).toBe('Deployment');
  });

  it('matches pods by label selector inside a namespace', () => {
    expect(podsForSelector(resources, { matchLabels: { app: 'web' } }, 'backend').map(pod => pod.name)).toEqual(['web-1']);
    expect(podsForSelector(resources, { matchLabels: { app: 'web' } }, 'other')).toEqual([]);
    expect(podsForSelector(resources, {}, 'backend')).toHaveLength(2);
  });

  it('resolves the workload behind a pod through the replica set', () => {
    const pod = { ...item('Pod', 'web-1', { namespace: 'backend' }), raw: { metadata: { ownerReferences: [{ kind: 'ReplicaSet', name: 'web-abc', uid: 'ReplicaSet/web-abc' }] } } };
    expect(ownerWorkload(resources, pod)?.name).toBe('web');
    expect(workloadsForPods(resources, [pod]).map(workload => workload.kind)).toEqual(['Deployment']);
  });

  it('finds the service that owns an endpoint slice', () => {
    const slice = item('EndpointSlice', 'web-slice', { namespace: 'backend', labels: { 'kubernetes.io/service-name': 'web-service' } });
    expect(serviceForEndpointSlice(resources, slice)?.name).toBe('web-service');
  });
});
