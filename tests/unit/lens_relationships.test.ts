import { beforeEach, describe, expect, it } from 'vitest';
import { useResourceStore } from '../../src/state/resource_store';
import { mapK8sResource } from '../../src/core/utils/k8s_mapper';
import { parseCustomResources } from '../../src/providers/custom_resources';
import { resourceIssues } from '../../src/core/resources/diagnostics';
import { buildResourceGraph } from '../../src/core/resources/relationships';
import { buildTopology } from '../../src/core/resources/topology';
import { resourceConsumers } from '../../src/core/resources/consumers';
import { resourceBucket, customResourcePlacement } from '../../src/core/resources/custom_resource_types';
import { resourceKey } from '../../src/core/resources/identity';
import { RESOURCE_TYPES } from '../../src/core/resources/resource_types';
import { SIDEBAR_TREE } from '../../src/core/perspectives';
import type { ResourceItem } from '../../src/types/k8s';

beforeEach(() => useResourceStore.getState().reset());
function item(kind: string, name: string, spec: any = {}, namespace: string | null = 'team', group?: string, extra: any = {}): ResourceItem {
  const type = RESOURCE_TYPES.find(type => type.kind === kind);
  const apiVersion = group ? `${group}/v1` : type?.group ? `${type.group}/${type.version}` : 'v1';
  const raw = { apiVersion, kind, metadata: { uid: `${group ?? ''}/${kind}/${namespace ?? ''}/${name}`, name, namespace: namespace ?? undefined }, spec, ...extra };
  const value = group ? parseCustomResources({ items: [raw] })[0] : mapK8sResource(raw, kind);
  const store = useResourceStore.getState(); const key = resourceBucket(value);
  store.setResourcesForKind(key, [...(store.resources[key]?.values() ?? []), value]);
  return value;
}
function connects(source: ResourceItem, target: ResourceItem) {
  const graph = buildResourceGraph(useResourceStore.getState().resources);
  expect(graph.relations.some(edge => edge.source === resourceKey(source) && edge.target === resourceKey(target) && !edge.missing), `${source.kind}/${source.name} → ${target.kind}/${target.name}`).toBe(true);
}
function disconnected(source: ResourceItem, target: ResourceItem) {
  const graph = buildResourceGraph(useResourceStore.getState().resources);
  expect(graph.relations.some(edge => edge.source === resourceKey(source) && edge.target === resourceKey(target) && !edge.missing)).toBe(false);
}
it('has one destination per supported builtin collection and excludes the removed system APIs', () => {
  const destinations = SIDEBAR_TREE.flatMap(category => category.groups.flatMap(group => group.kinds.map(entry => entry.kind)));
  expect(destinations).toHaveLength(45); expect(new Set(destinations).size).toBe(45);
  expect([...destinations].sort()).toEqual(RESOURCE_TYPES.map(type => type.kind).sort());
  for (const removed of ['PodTemplate', 'ControllerRevision', 'FlowSchema', 'ComponentStatus', 'StorageVersion', 'CSIDriver', 'PodGroup']) expect(destinations).not.toContain(removed);
  expect(customResourcePlacement({ group: 'autoscaling.k8s.io', kind: 'VerticalPodAutoscaler' })?.category).toBe('config');
  expect(customResourcePlacement({ group: 'gateway.networking.k8s.io', kind: 'HTTPRoute' })?.category).toBe('gateway');
  expect(customResourcePlacement({ group: 'other.example', kind: 'HTTPRoute' })).toBeUndefined();
});
it('resolves PriorityClass, RuntimeClass, DRA claims and device classes with cluster-scoped dependencies in diagrams', () => {
  const priority = item('PriorityClass', 'critical', {}, null); const runtime = item('RuntimeClass', 'sandbox', {}, null);
  const deviceClass = item('DeviceClass', 'gpu', {}, null);
  const template = item('ResourceClaimTemplate', 'gpu-template', { spec: { devices: { requests: [{ name: 'gpu', exactly: { deviceClassName: 'gpu' } }] } } });
  const claim = item('ResourceClaim', 'gpu-claim', { devices: { requests: [{ name: 'gpu', firstAvailable: [{ deviceClassName: 'gpu' }] }] } });
  const pod = item('Pod', 'web', { priorityClassName: 'critical', runtimeClassName: 'sandbox', resourceClaims: [{ name: 'direct', resourceClaimName: 'gpu-claim' }, { name: 'generated', resourceClaimTemplateName: 'gpu-template' }], containers: [] });
  for (const ref of [priority, runtime, template, claim]) connects(pod, ref);
  connects(claim, deviceClass); connects(template, deviceClass);
  const graph = buildTopology(useResourceStore.getState().resources, 'namespace:team');
  for (const target of [priority, runtime, deviceClass]) expect(graph.items.has(resourceKey(target))).toBe(true);
  expect(resourceConsumers(useResourceStore.getState().resources, deviceClass).map(ref => ref.resource?.uid)).toEqual(expect.arrayContaining([claim.uid, template.uid]));
});
describe('selectors', () => {
  it('selects matching Pods for PDB and NetworkPolicy without crossing namespaces', () => {
    const a = item('Pod', 'a', {}, 'team', undefined, { metadata: { uid: 'a', name: 'a', namespace: 'team', labels: { app: 'web', tier: 'frontend' } } });
    const b = item('Pod', 'b', {}, 'other', undefined, { metadata: { uid: 'b', name: 'b', namespace: 'other', labels: { app: 'web' } } });
    const pdb = item('PodDisruptionBudget', 'budget', { selector: { matchLabels: { app: 'web' }, matchExpressions: [{ key: 'tier', operator: 'In', values: ['frontend'] }] } });
    const network = item('NetworkPolicy', 'deny', { podSelector: { matchLabels: {} }, policyTypes: ['Ingress'] });
    connects(pdb, a); connects(network, a); disconnected(pdb, b); disconnected(network, b);
    const custom = item('Service', 'fake', { selector: { app: 'web' } }, 'team', 'other.example'); disconnected(custom, a);
  });
});
it('resolves Gateway parents, cross-namespace backends, TLS Secrets and classes without mixing API groups', () => {
  const cls = item('GatewayClass', 'public', { controllerName: 'example/controller' }, null, 'gateway.networking.k8s.io');
  const secret = item('Secret', 'tls'); const service = item('Service', 'web', {}, 'other');
  const gateway = item('Gateway', 'edge', { gatewayClassName: 'public', listeners: [{ tls: { certificateRefs: [{ name: 'tls' }] } }] }, 'team', 'gateway.networking.k8s.io');
  const route = item('HTTPRoute', 'route', { parentRefs: [{ name: 'edge' }], rules: [{ backendRefs: [{ name: 'web', namespace: 'other' }] }] }, 'team', 'gateway.networking.k8s.io');
  const impostor = item('HTTPRoute', 'impostor', { parentRefs: [{ name: 'edge' }], rules: [{ backendRefs: [{ name: 'web', namespace: 'other' }] }] }, 'team', 'other.example');
  connects(gateway, cls); connects(gateway, secret); connects(route, gateway); connects(route, service); disconnected(impostor, service);
  expect(resourceConsumers(useResourceStore.getState().resources, service).map(ref => ref.resource?.uid)).toContain(route.uid);
  const graph = buildTopology(useResourceStore.getState().resources, 'namespace:team'); expect(graph.items.has(resourceKey(cls))).toBe(true);
});
it('resolves IngressClass, legacy Endpoints, webhook Services, admission bindings and VPA targets', () => {
  const cls = item('IngressClass', 'nginx', {}, null); const service = item('Service', 'web'); const pod = item('Pod', 'web');
  const ingress = item('Ingress', 'web', { ingressClassName: 'nginx', defaultBackend: { service: { name: 'web' } } });
  const endpoints = item('Endpoints', 'web', {}, 'team', undefined, { subsets: [{ addresses: [{ targetRef: { kind: 'Pod', name: 'web', uid: pod.uid } }] }] });
  const webhook = item('ValidatingWebhookConfiguration', 'validate', {}, null, undefined, { webhooks: [{ clientConfig: { service: { name: 'web', namespace: 'team' } } }] });
  const policy = item('ValidatingAdmissionPolicy', 'policy', {}, null); const binding = item('ValidatingAdmissionPolicyBinding', 'binding', { policyName: 'policy' }, null);
  const workload = item('Deployment', 'web', { replicas: 2 }); const vpa = item('VerticalPodAutoscaler', 'web', { targetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name: 'web' } }, 'team', 'autoscaling.k8s.io');
  connects(ingress, cls); connects(ingress, service); connects(service, endpoints); connects(endpoints, pod); connects(webhook, service); connects(binding, policy); connects(vpa, workload);
  const rc = item('ReplicationController', 'legacy', { replicas: 2, template: { spec: { containers: [] } } }, 'team', undefined, { status: { readyReplicas: 1 } });
  expect(rc.ready).toBe('1/2');
  expect(resourceIssues(rc).map(issue => issue.id)).toContain('replicas-ready');
  const graph = buildTopology(useResourceStore.getState().resources, 'namespace:team'); expect(graph.items.has(resourceKey(cls))).toBe(true);
});
it('does not infer Pod dependencies from arbitrary custom resource templates', () => {
  const sa = item('ServiceAccount', 'default');
  const appSet = item('ApplicationSet', 'apps', { template: { spec: { project: 'default' } } }, 'team', 'argoproj.io');
  disconnected(appSet, sa);
});
