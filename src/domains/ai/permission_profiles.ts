import type { AgentPolicy, ResourceRule } from './types';
export const PERMISSION_PROFILES = ['diagnostic', 'metadata', 'workloads', 'network', 'storage', 'limited actions'] as const;
export type PermissionProfile = typeof PERMISSION_PROFILES[number];
export function permissionProfile(policy: AgentPolicy, profile: PermissionProfile): AgentPolicy {
  const base: AgentPolicy = { ...policy, schemaVersion: 1, ruleResolution: 'first_match', resources: true, events: true, logs: false, secrets: 'none', configMaps: 'metadata', customResources: 'metadata', workloadConfiguration: false, annotations: false, clusterResources: false, writes: [], rules: [] };
  if (profile === 'limited actions') return { ...base, writes: ['scale', 'restart'] };
  const rule = (group: string, kind: string, read: ResourceRule['read'] = 'content'): ResourceRule => ({ group, kind, namespace: '*', name: '*', read, writes: [] });
  if (profile === 'metadata') return { ...base, rules: [rule('*', '*', 'metadata')] };
  const kinds: Record<string, Array<[string, string]>> = {
    workloads: [['apps', 'Deployment'], ['apps', 'StatefulSet'], ['apps', 'DaemonSet'], ['apps', 'ReplicaSet'], ['batch', 'Job'], ['batch', 'CronJob'], ['', 'Pod'], ['', 'Event']],
    network: [['', 'Service'], ['', 'Pod'], ['', 'Event'], ['discovery.k8s.io', 'EndpointSlice'], ['networking.k8s.io', 'Ingress'], ['networking.k8s.io', 'NetworkPolicy'], ['gateway.networking.k8s.io', 'Gateway'], ['gateway.networking.k8s.io', 'HTTPRoute']],
    storage: [['', 'PersistentVolumeClaim'], ['', 'PersistentVolume'], ['storage.k8s.io', 'StorageClass'], ['', 'Event']],
  };
  if (kinds[profile]) return { ...base, clusterResources: profile === 'storage', rules: [...kinds[profile].map(([group, kind]) => rule(group, kind)), rule('*', '*', 'none')] };
  return base;
}
