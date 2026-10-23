import { expect, it } from 'vitest';
import { DEFAULT_TOPOLOGY_HIDDEN_KINDS } from '../../src/core/resources/topology_visibility';
import { useUiStore } from '../../src/state/ui_store';

it('keeps the service structure visible and hides secondary resources by default', () => {
  const hidden = DEFAULT_TOPOLOGY_HIDDEN_KINDS;
  for (const kind of ['PodDisruptionBudget', 'NetworkPolicy', 'HorizontalPodAutoscaler', 'ServiceAccount', 'Role', 'RoleBinding', 'ClusterRole', 'ClusterRoleBinding', 'Endpoints', 'EndpointSlice', 'ResourceQuota', 'LimitRange', 'Lease', 'ReplicationController', 'ValidatingWebhookConfiguration', 'IngressClass', 'PriorityClass', 'RuntimeClass', 'DeviceClass', 'ResourceClaim']) {
    expect(hidden.has(kind), `${kind} should be hidden by default`).toBe(true);
  }
  for (const kind of ['Pod', 'Deployment', 'ReplicaSet', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob', 'Service', 'Ingress', 'ConfigMap', 'Secret', 'PersistentVolumeClaim', 'HelmRelease', 'Namespace', 'Node']) {
    expect(hidden.has(kind), `${kind} should be visible by default`).toBe(false);
  }
});

it('persists the user choice of hidden kinds and restores the default set', () => {
  useUiStore.getState().setTopologyHiddenKinds(new Set(['ResourceQuota']));
  expect(useUiStore.getState().topologyHiddenKinds.has('ResourceQuota')).toBe(true);
  useUiStore.getState().setTopologyHiddenKinds(new Set(DEFAULT_TOPOLOGY_HIDDEN_KINDS));
  expect(useUiStore.getState().topologyHiddenKinds.has('PodDisruptionBudget')).toBe(true);
  expect(useUiStore.getState().topologyHiddenKinds.size).toBe(DEFAULT_TOPOLOGY_HIDDEN_KINDS.size);
});
