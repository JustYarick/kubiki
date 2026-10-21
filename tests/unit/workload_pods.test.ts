import { describe, it, expect } from 'vitest';
import { findWorkloadPods, preferredWorkloadPod } from '../../src/core/resources/workload_pods';
import type { ResourceItem } from '../../src/types/k8s';

describe('workload_pods resolution', () => {
  const pod1: ResourceItem = {
    apiVersion: 'v1',
    kind: 'Pod',
    name: 'web-rs1-abc',
    namespace: 'prod',
    uid: 'pod-1',
    status: 'Running',
    raw: {
      metadata: {
        name: 'web-rs1-abc',
        namespace: 'prod',
        uid: 'pod-1',
        ownerReferences: [{ kind: 'ReplicaSet', name: 'web-rs1', uid: 'rs-1' }],
      },
    },
  };

  const pod2: ResourceItem = {
    apiVersion: 'v1',
    kind: 'Pod',
    name: 'web-rs1-def',
    namespace: 'prod',
    uid: 'pod-2',
    status: 'Pending',
    raw: {
      metadata: {
        name: 'web-rs1-def',
        namespace: 'prod',
        uid: 'pod-2',
        ownerReferences: [{ kind: 'ReplicaSet', name: 'web-rs1', uid: 'rs-1' }],
      },
    },
  };

  const rs1: ResourceItem = {
    apiVersion: 'apps/v1',
    kind: 'ReplicaSet',
    name: 'web-rs1',
    namespace: 'prod',
    uid: 'rs-1',
    raw: {
      metadata: {
        name: 'web-rs1',
        namespace: 'prod',
        uid: 'rs-1',
        ownerReferences: [{ kind: 'Deployment', name: 'web', uid: 'dep-1' }],
      },
    },
  };

  const deployment: ResourceItem = {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    name: 'web',
    namespace: 'prod',
    uid: 'dep-1',
    raw: {
      metadata: {
        name: 'web',
        namespace: 'prod',
        uid: 'dep-1',
      },
    },
  };

  it('resolves Deployment child pods via ReplicaSet owner references', () => {
    const resources = {
      Pod: new Map([['pod-1', pod1], ['pod-2', pod2]]),
      ReplicaSet: new Map([['rs-1', rs1]]),
    };
    const pods = findWorkloadPods(deployment, resources);
    expect(pods.map((p) => p.name)).toEqual(['web-rs1-abc', 'web-rs1-def']);
  });

  it('resolves preferred pod (prefers Running over Pending)', () => {
    const pods = [pod2, pod1];
    const preferred = preferredWorkloadPod(pods);
    expect(preferred?.name).toBe('web-rs1-abc');
  });

  it('resolves Job pods directly by owner reference', () => {
    const jobPod: ResourceItem = {
      apiVersion: 'v1',
      kind: 'Pod',
      name: 'backup-xyz',
      namespace: 'prod',
      uid: 'pod-job',
      raw: {
        metadata: {
          name: 'backup-xyz',
          namespace: 'prod',
          ownerReferences: [{ kind: 'Job', name: 'backup', uid: 'job-1' }],
        },
      },
    };
    const job: ResourceItem = {
      apiVersion: 'batch/v1',
      kind: 'Job',
      name: 'backup',
      namespace: 'prod',
      uid: 'job-1',
      raw: { metadata: { name: 'backup', uid: 'job-1' } },
    };
    const resources = {
      Pod: new Map([['pod-job', jobPod]]),
    };
    const pods = findWorkloadPods(job, resources);
    expect(pods.map((p) => p.name)).toEqual(['backup-xyz']);
  });
});
