import { afterEach, describe, expect, it } from 'vitest';
import { parseApiResources } from '../../src/providers/api_discovery';
import { RESOURCE_TYPES, resourceType, setDiscoveredResourceTypes } from '../../src/core/resources/resource_types';
import { gitOpsFamily, gitOpsReferences, resourceStatus, resolveGitOpsReference } from '../../src/core/resources/gitops';
import { fieldValue } from '../../src/core/resources/resource_presentations';
import { mapK8sResource } from '../../src/core/utils/k8s_mapper';
import { parseCustomResources } from '../../src/providers/custom_resources';
import { useResourceStore } from '../../src/state/resource_store';
import { buildResourceGraph } from '../../src/core/resources/relationships';

afterEach(() => { setDiscoveredResourceTypes([]); useResourceStore.getState().reset(); });
it('discovers supported collections with and without shortnames and uses the served API version', () => {
  const types = parseApiResources('pods po v1 true Pod get,list,watch\nhorizontalpodautoscalers hpa autoscaling/v1 true HorizontalPodAutoscaler get,list\nendpointslices discovery.k8s.io/v1 true EndpointSlice get,list\nwidgets example.com/v1 true Widget list');
  expect(types.map(type => type.kind)).toEqual(['Pod', 'HorizontalPodAutoscaler', 'EndpointSlice']);
  setDiscoveredResourceTypes(types);
  expect(resourceType('HorizontalPodAutoscaler')?.version).toBe('v1');
  expect(RESOURCE_TYPES.find(type => type.kind === 'HorizontalPodAutoscaler')?.version).toBe('v2');
  expect(() => parseApiResources({ items: [] })).toThrow();
  expect(() => parseApiResources('pods example.com/v1 true Pod list')).toThrow();
});
it('validates native discovery identities and preserves watch capabilities and served versions', () => {
  const pod = { kind: 'Pod', plural: 'pods', group: '', version: 'v1', namespaced: true, watch: false };
  expect(parseApiResources([pod])).toEqual([expect.objectContaining(pod)]);
  for (const patch of [{ group: 'example.org' }, { namespaced: false }, { version: 'invalid' }, { watch: 'false' }]) {
    expect(() => parseApiResources([{ ...pod, ...patch }])).toThrow('Invalid Kubernetes API discovery response');
  }
  expect(() => parseApiResources([])).toThrow('did not return any supported collections');
});
it('reads label keys containing dots without treating them as nested paths', () => {
  expect(fieldValue({ metadata: { labels: { 'kubernetes.io/service-name': 'web' } } }, 'metadata.labels[kubernetes.io/service-name]')).toBe('web');
});
it('keeps native and custom manifests lazy, cached, and unchanged', () => {
  const raw = { apiVersion: 'v1', kind: 'ConfigMap', metadata: { uid: 'cm', name: 'settings', namespace: 'backend' }, data: { key: 'value' } };
  const items = [mapK8sResource(raw, 'ConfigMap'), ...parseCustomResources({ items: [{ ...raw, kind: 'Widget', apiVersion: 'example.com/v1' }] })];
  for (const item of items) { expect(Object.getOwnPropertyDescriptor(item, 'rawYaml')?.get).toBeTypeOf('function'); expect(item.rawYaml).toContain('key: value'); expect(item.rawYaml).toBe(item.rawYaml); }
});
it('resolves Flux inventory and Argo project references, keeping Flux Helm separate from Helm releases', () => {
  const [flux] = parseCustomResources({ items: [{ apiVersion: 'kustomize.toolkit.fluxcd.io/v1', kind: 'Kustomization', metadata: { uid: 'flux', name: 'web', namespace: 'backend' }, spec: { sourceRef: { kind: 'GitRepository', name: 'repo' } }, status: { inventory: { entries: [{ id: 'backend_web_apps_Deployment', v: 'v1' }] }, conditions: [{ type: 'Ready', status: 'True' }] } }] });
  const deployment = mapK8sResource({ apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'web', namespace: 'backend', uid: 'dep' } }, 'Deployment');
  const refs = gitOpsReferences(flux);
  expect(resolveGitOpsReference(refs.managed[0], [deployment])).toBe(deployment);
  useResourceStore.getState().setResourcesForKind('Deployment', [deployment]);
  useResourceStore.getState().setResourcesForKind('custom:kustomize.toolkit.fluxcd.io/Kustomization', [flux]);
  expect(buildResourceGraph(useResourceStore.getState().resources).relations.some(edge => edge.type === 'manages' && !edge.missing)).toBe(true);
  expect(gitOpsFamily({ kind: 'HelmRelease', apiVersion: 'helm.toolkit.fluxcd.io/v2' })).toBe('flux');
  expect(gitOpsFamily({ kind: 'HelmRelease', apiVersion: 'helm.sh/v1' })).toBeUndefined();
  expect(gitOpsReferences({ ...flux, kind: 'Application', apiVersion: 'argoproj.io/v1alpha1', raw: { spec: { project: 'default' }, status: { resources: [{ kind: 'Deployment', name: 'web', namespace: 'backend', group: 'apps' }] } } }).sources[0]).toMatchObject({ kind: 'AppProject', name: 'default' });
});
describe('controller status', () => {
  it.each([
    [{ spec: { suspend: true } }, 'Suspended'],
    [{ status: { conditions: [{ type: 'Ready', status: 'False', reason: 'DependencyNotReady' }] } }, 'DependencyNotReady'],
    [{ status: { conditions: [{ type: 'Ready', status: 'True' }] } }, 'Ready'],
    [{ status: { health: { status: 'Degraded' }, sync: { status: 'OutOfSync' } } }, 'Degraded'],
  ])('reports %j as %s', (raw, expected) => expect(resourceStatus(raw)).toBe(expected));
});
it('keeps related navigation local, refreshes back targets and resets a new table selection', () => {
  const pod = (uid: string) => mapK8sResource({ apiVersion: 'v1', kind: 'Pod', metadata: { uid, name: uid, namespace: 'backend' } }, 'Pod');
  const a = pod('a'), b = pod('b'), c = pod('c'); const store = useResourceStore.getState();
  store.setResourcesForKind('Pod', [a, b, c]); store.selectItem(a); store.selectItem(b, { history: true });
  const refreshed = { ...a, status: 'Running' }; store.setResourcesForKind('Pod', [refreshed, b, c]); store.goBack();
  expect(useResourceStore.getState().selectedItem).toBe(refreshed);
  store.selectItem(b, { history: true }); store.selectItem(c);
  expect(useResourceStore.getState().selectionHistory).toEqual([]);
  store.selectItem(a, { origin: 'graph-a' }); store.selectItem(b, { origin: 'graph-a' });
  expect(useResourceStore.getState().selectionHistory).toHaveLength(1);
  store.selectItem(c, { origin: 'graph-b' }); expect(useResourceStore.getState().selectionHistory).toHaveLength(0);
});
