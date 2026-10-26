import { beforeAll, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { buildMockResources, MOCK_NAMESPACES } from '../../src/providers/mock/mock_resources';
import { PRODUCTION_WORKLOADS } from '../../src/providers/mock/mock_cluster_profile';
import { buildMockMetrics } from '../../src/providers/mock/mock_metrics';
import { demoHelmContent, demoHelmPage } from '../../src/providers/mock/mock_helm';
import { findWorkloadPods } from '../../src/core/resources/workload_pods';
import type { ResourceItem } from '../../src/types/k8s';

describe('production-sized demo cluster', () => {
  let resources: ReturnType<typeof buildMockResources>;
  let generated: ResourceItem[];
  beforeAll(() => {
    resources = buildMockResources();
    generated = Object.values(resources).flat().filter(item => item.uid.startsWith('production-'));
  });

  it('provides 8000+ pods, broad inventory, unique identities and complete namespace discovery', () => {
    expect(resources.Pod.length).toBeGreaterThan(8000);
    expect(resources.Node.length).toBeGreaterThan(180);
    expect(resources.Namespace.map(item => item.name).sort()).toEqual([...MOCK_NAMESPACES].sort());
    for (const kind of ['Deployment', 'ReplicaSet', 'Service', 'ConfigMap', 'Secret', 'ServiceAccount', 'RoleBinding', 'EndpointSlice', 'PodDisruptionBudget', 'HorizontalPodAutoscaler']) {
      expect(resources[kind].length, kind).toBeGreaterThanOrEqual(600);
    }
    expect(resources.PersistentVolumeClaim.length).toBeGreaterThan(360);
    expect(resources.Event.length).toBeGreaterThan(1000);
    const all = Object.values(resources).flat();
    expect(new Set(all.map(item => item.uid)).size).toBe(all.length);
    expect(new Set(all.map(item => `${item.apiVersion}/${item.kind}/${item.namespace}/${item.name}`)).size).toBe(all.length);
    expect(all.every(item => !item.namespace || MOCK_NAMESPACES.includes(item.namespace))).toBe(true);
  });

  it('connects every generated owner, scheduled node and storage claim without overfilling nodes', () => {
    const byUid = new Map(Object.values(resources).flat().map(item => [item.uid, item]));
    const nodes = new Map(resources.Node.map(item => [item.name, item]));
    const scheduled = new Map<string, number>();
    const pvcs = new Map(resources.PersistentVolumeClaim.map(item => [`${item.namespace}/${item.name}`, item]));
    const pvs = new Map(resources.PersistentVolume.map(item => [item.name, item]));
    for (const item of generated) {
      for (const owner of item.raw!.metadata.ownerReferences ?? []) {
        const target = byUid.get(owner.uid);
        if (!target || target.name !== owner.name || target.kind !== owner.kind || target.namespace !== item.namespace) throw new Error(`Broken owner: ${item.kind}/${item.name}`);
      }
      if (item.kind !== 'Pod') continue;
      if (item.node !== '-') {
        if (!nodes.has(item.node!)) throw new Error(`Missing node for ${item.name}`);
        scheduled.set(item.node!, (scheduled.get(item.node!) ?? 0) + 1);
      }
      for (const volume of item.raw!.spec.volumes ?? []) {
        if (!volume.persistentVolumeClaim) continue;
        const claim = pvcs.get(`${item.namespace}/${volume.persistentVolumeClaim.claimName}`);
        const pv = pvs.get(claim?.raw?.spec.volumeName);
        if (pv?.raw?.spec.claimRef.name !== claim?.name || pv?.raw?.spec.claimRef.namespace !== item.namespace) throw new Error(`Broken volume: ${item.name}`);
      }
    }
    expect(Math.max(...scheduled.values())).toBeLessThanOrEqual(110);
    const statuses = new Set(resources.Pod.map(item => item.status));
    for (const state of ['Running', 'Pending', 'CrashLoopBackOff', 'ImagePullBackOff', 'Terminating', 'Completed', 'Error']) expect(statuses.has(state), state).toBe(true);
  });

  it('resolves workloads through ReplicaSets and matches readiness, service endpoints and configuration', () => {
    const maps = Object.fromEntries(Object.entries(resources).map(([kind, items]) => [kind, new Map(items.map(item => [item.uid, item]))]));
    const byName = new Map(generated.map(item => [`${item.kind}/${item.namespace}/${item.name}`, item]));
    for (const app of PRODUCTION_WORKLOADS.filter((_, index) => index % 13 === 0 || index < 12)) {
      const workload = byName.get(`${app.kind}/${app.namespace}/${app.name}`)!;
      const pods = findWorkloadPods(workload, maps);
      expect(pods.length).toBe(app.replicas);
      const ready = pods.filter(pod => pod.status === 'Running').length;
      expect(workload.ready).toBe(`${ready}/${app.replicas}`);
      const service = byName.get(`Service/${app.namespace}/${app.name}`)!;
      expect(pods.every(pod => pod.labels?.app === service.raw!.spec.selector.app)).toBe(true);
      const endpoints = byName.get(`EndpointSlice/${app.namespace}/${app.name}-001`)!;
      expect(endpoints.raw!.endpoints.map((endpoint: any) => endpoint.targetRef.uid).sort()).toEqual(pods.filter(pod => pod.status === 'Running').map(pod => pod.uid).sort());
      for (const pod of pods) for (const container of pod.raw!.spec.containers) for (const ref of container.envFrom ?? []) {
        const kind = ref.configMapRef ? 'ConfigMap' : 'Secret';
        expect(byName.has(`${kind}/${app.namespace}/${(ref.configMapRef ?? ref.secretRef).name}`)).toBe(true);
      }
    }
  });

  it('keeps YAML lazy and exposes the same metadata, spec and status in details', () => {
    const item = generated.find(item => item.kind === 'Pod' && item.status === 'Running')!;
    expect(Object.getOwnPropertyDescriptor(item, 'rawYaml')?.get).toBeTypeOf('function');
    expect(parse(item.rawYaml!)).toEqual(item.raw);
    expect(item.metadata).toBe(item.raw!.metadata);
    expect(item.spec).toBe(item.raw!.spec);
    expect(item.statusRaw).toBe(item.raw!.status);
  });

  it('paginates Helm releases and links their manifests to the resource inventory', () => {
    const releases = [];
    for (let offset = 0; ; offset += 100) {
      const page = demoHelmPage('kubiki-demo', null, offset);
      releases.push(...page.items);
      if (!page.has_more) break;
    }
    expect(releases).toHaveLength(728);
    const app = PRODUCTION_WORKLOADS[0];
    expect(demoHelmPage('kubiki-demo', app.namespace, 0).items).toHaveLength(12);
    const workload = resources.Deployment.find(item => item.namespace === app.namespace && item.name === app.name)!;
    expect(workload.raw!.metadata.annotations['meta.helm.sh/release-name']).toBe(app.release);
    expect(parse(demoHelmContent(app.release, app.namespace, 2, 'manifest'))).toMatchObject({ metadata: { name: workload.name, namespace: workload.namespace }, spec: { replicas: workload.replicas } });
  });

  it('reports consistent scoped pod metrics and node usage below capacity', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1800000000000);
    try {
      const all = buildMockMetrics(resources, 'kubiki-demo', null);
      const namespace = PRODUCTION_WORKLOADS[0].namespace;
      const scoped = buildMockMetrics(resources, 'kubiki-demo', namespace);
      expect(scoped.pods.items).toEqual(all.pods.items!.filter(item => item.namespace === namespace));
      expect(scoped.nodes.items).toBeNull();
      const nodes = new Map(resources.Node.map(item => [item.name, item]));
      for (const node of all.nodes.items!) {
        const capacity = Number(nodes.get(node.name)!.raw!.status.capacity.cpu);
        if (parseInt(node.cpu) > capacity * 1000) throw new Error(`CPU usage exceeds capacity: ${node.name}`);
      }
    } finally { clock.mockRestore(); }
  });
});
