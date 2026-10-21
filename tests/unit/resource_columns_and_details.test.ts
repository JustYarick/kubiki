import { describe, it, expect } from 'vitest';
import { mapK8sResource, formatDuration } from '../../src/core/utils/k8s_mapper';

describe('Resource columns mapping and Lens parity', () => {
  it('maps Deployment with clean Pods ready/desired and real Condition status without duplicate replicas', () => {
    const raw = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'web', namespace: 'default', uid: 'dep-1' },
      spec: {
        replicas: 3,
        selector: { matchLabels: { app: 'web' } },
        template: { spec: { containers: [{ name: 'nginx', image: 'nginx:1.27' }] } },
      },
      status: {
        readyReplicas: 3,
        availableReplicas: 3,
        conditions: [{ type: 'Available', status: 'True', reason: 'MinimumReplicasAvailable' }],
      },
    };

    const item = mapK8sResource(raw, 'Deployment');
    expect(item.ready).toBe('3/3');
    expect(item.replicas).toBe(3);
    expect(item.status).toBe('Available');
    expect(item.selectorText).toBe('app=web');
  });

  it('maps Deployment in rollout progress to Progressing status', () => {
    const raw = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'api', namespace: 'default', uid: 'dep-2' },
      spec: { replicas: 3 },
      status: {
        readyReplicas: 1,
        conditions: [{ type: 'Available', status: 'False' }],
      },
    };

    const item = mapK8sResource(raw, 'Deployment');
    expect(item.ready).toBe('1/3');
    expect(item.status).toBe('Progressing');
  });

  it('maps Pod with controlledBy and qosClass', () => {
    const raw = {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: {
        name: 'web-rs-1234',
        namespace: 'prod',
        ownerReferences: [{ kind: 'ReplicaSet', name: 'web-rs' }],
      },
      spec: { nodeName: 'node-worker-1', containers: [{ name: 'app', image: 'node:20' }] },
      status: { phase: 'Running', qosClass: 'Burstable', podIP: '10.244.1.15' },
    };

    const item = mapK8sResource(raw, 'Pod');
    expect(item.controlledBy).toBe('ReplicaSet/web-rs');
    expect(item.qosClass).toBe('Burstable');
    expect(item.node).toBe('node-worker-1');
    expect(item.ip).toBe('10.244.1.15');
  });

  it('calculates duration for Job runs correctly', () => {
    const raw = {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: { name: 'db-migration', namespace: 'default' },
      spec: { completions: 1 },
      status: {
        succeeded: 1,
        startTime: '2026-10-21T10:00:00Z',
        completionTime: '2026-10-21T10:02:45Z',
      },
    };

    const item = mapK8sResource(raw, 'Job');
    expect(item.status).toBe('Completed');
    expect(item.ready).toBe('1/1');
    expect(item.duration).toBe('2m 45s');
  });

  it('formats formatDuration properly across seconds, minutes, and hours', () => {
    expect(formatDuration(42)).toBe('42s');
    expect(formatDuration(90)).toBe('1m 30s');
    expect(formatDuration(120)).toBe('2m');
    expect(formatDuration(3665)).toBe('1h 1m');
  });

  it('maps CronJob active jobs and schedule', () => {
    const raw = {
      apiVersion: 'batch/v1',
      kind: 'CronJob',
      metadata: { name: 'nightly-backup', namespace: 'default' },
      spec: { schedule: '0 2 * * *', suspend: false },
      status: {
        active: [{ name: 'nightly-backup-1234' }],
        lastScheduleTime: new Date(Date.now() - 3600000).toISOString(),
      },
    };

    const item = mapK8sResource(raw, 'CronJob');
    expect(item.status).toBe('Active');
    expect(item.ready).toBe('0 2 * * *');
    expect(item.activeJobs).toBe(1);
    expect(item.lastScheduleTime).toBe('1h');
  });

  it('maps Service with externalIP and selectorText', () => {
    const raw = {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: 'lb-service', namespace: 'ingress' },
      spec: {
        type: 'LoadBalancer',
        clusterIP: '10.96.0.100',
        selector: { app: 'gateway', tier: 'frontend' },
      },
      status: {
        loadBalancer: {
          ingress: [{ ip: '198.51.100.25' }],
        },
      },
    };

    const item = mapK8sResource(raw, 'Service');
    expect(item.serviceType).toBe('LoadBalancer');
    expect(item.externalIP).toBe('198.51.100.25');
    expect(item.selectorText).toBe('app=gateway, tier=frontend');
  });

  it('maps Node with taints count, allocatable pods and internal IP', () => {
    const raw = {
      apiVersion: 'v1',
      kind: 'Node',
      metadata: { name: 'k8s-node-1', labels: { 'node-role.kubernetes.io/control-plane': '' } },
      spec: {
        taints: [
          { key: 'node-role.kubernetes.io/control-plane', effect: 'NoSchedule' },
          { key: 'dedicated', value: 'system', effect: 'NoSchedule' },
        ],
      },
      status: {
        allocatable: { pods: '110' },
        addresses: [{ type: 'InternalIP', address: '192.168.1.10' }],
        conditions: [{ type: 'Ready', status: 'True' }],
      },
    };

    const item = mapK8sResource(raw, 'Node');
    expect(item.status).toBe('Ready');
    expect(item.taintsCount).toBe(2);
    expect(item.nodePods).toBe('110');
    expect(item.nodeIp).toBe('192.168.1.10');
    expect(item.nodeRoles).toBe('control-plane');
  });

  it('calculates sizeBytes for Secret and ConfigMap payloads', () => {
    const secret = mapK8sResource({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: 'app-secret', namespace: 'default' },
      data: { token: btoa('secret-token-payload-xyz') },
    }, 'Secret');

    expect(secret.sizeBytes).toBeGreaterThan(0);

    const cm = mapK8sResource({
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: 'app-cfg', namespace: 'default' },
      data: { 'app.conf': 'server { listen 80; }' },
    }, 'ConfigMap');

    expect(cm.sizeBytes).toBeGreaterThan(0);
  });
});
