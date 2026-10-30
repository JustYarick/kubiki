import { expect, it } from 'vitest';
import { searchDocument, searchResources } from '../../src/core/resource_search';
import { mapK8sResource } from '../../src/core/utils/k8s_mapper';
import { loadSearchInventory } from '../../src/providers/search_inventory';

const item = (name: string, namespace = 'production', kind = 'Pod') => mapK8sResource({ apiVersion: 'v1', kind, metadata: { name, namespace, uid: `${kind}/${namespace}/${name}`, labels: { app: 'web', team: 'platform' } }, spec: { nodeName: 'worker-a', containers: [{ image: 'registry/web:v2', env: [{ name: 'PASSWORD', value: 'hidden-env-value' }] }] }, status: { phase: 'Running' } }, kind);
const docs = [item('api-web-12'), item('api-web-13', 'staging'), item('cache-1')].map(searchDocument);
const search = (query: string, regex = false, caseSensitive = false) => searchResources(docs, { query, regex, caseSensitive });
it('combines field filters, label values, negative terms and regular expressions', () => {
  expect(search('kind:Pod ns:production label:app=web name:^api-web-\\d+$ -name:13', true).hits).toEqual([docs[0].id]);
  expect(search('namespace:production image:registry/web:v2 node:worker-a -name:cache').hits).toEqual([docs[0].id]);
  expect(search('"api-web-12"').hits).toEqual([docs[0].id]);
});
it('applies regex alternation and anchors to individual fields, and supports case sensitivity', () => {
  expect(search('^(api-web-12|cache-1)$', true).total).toBe(2);
  expect(search('API-WEB', true).total).toBe(2);
  expect(search('API-WEB', true, true).total).toBe(0);
  expect(search('API-WEB', false, true).total).toBe(0);
});
it('reports invalid expressions and unmatched quotes without matching arbitrary objects', () => {
  expect(search('[' , true)).toMatchObject({ total: 0, error: expect.any(String) });
  expect(search('name:"open')).toMatchObject({ total: 0, error: expect.any(String) });
});
it('never indexes Secret values, environment values or the last-applied manifest', () => {
  const secret = item('credentials', 'production', 'Secret');
  secret.raw!.data = { password: 'hidden-secret-value' };
  secret.raw!.stringData = { password: 'hidden-plain-value' };
  secret.raw!.metadata.annotations = { 'kubectl.kubernetes.io/last-applied-configuration': 'hidden-manifest-value', owner: 'searchable-owner' };
  const secretDocument = searchDocument(secret);
  for (const query of ['hidden-secret-value', 'hidden-plain-value', 'hidden-manifest-value', 'hidden-env-value']) expect(searchResources([secretDocument], { query, regex: false, caseSensitive: false }).total).toBe(0);
  expect(searchResources([secretDocument], { query: 'annotation:owner=searchable-owner', regex: false, caseSensitive: false }).total).toBe(1);
});
it('counts all matches while bounding the returned result list', () => {
  const result = searchResources(docs, { query: '', regex: false, caseSensitive: false }, 1);
  expect(result.total).toBe(3); expect(result.hits).toHaveLength(1);
});

it('scans unopened kinds and newly discovered CRDs, removes deleted seeds, and records partial failures', async () => {
  const definition = mapK8sResource({ apiVersion: 'apiextensions.k8s.io/v1', kind: 'CustomResourceDefinition', metadata: { name: 'widgets.example.io', uid: 'new-definition' }, spec: { group: 'example.io', names: { kind: 'Widget', plural: 'widgets' }, scope: 'Namespaced', versions: [{ name: 'v1', served: true, storage: true }] } }, 'CustomResourceDefinition');
  const widget = { ...item('custom-one'), kind: 'Widget', apiVersion: 'example.io/v1' };
  const reads: string[] = [];
  const reader = {
    getResources: async (_context: string, kind: string) => { reads.push(kind); if (kind === 'Secret') throw new Error('Forbidden'); return kind === 'CustomResourceDefinition' ? [definition] : kind === 'ConfigMap' ? [item('unopened-config', 'production', 'ConfigMap')] : []; },
    getCustomResources: async (_context: string, name: string, uid: string) => { reads.push(name); expect(uid).toBe('new-definition'); return [widget]; },
    getHelmInventory: async () => [],
  };
  const result = await loadSearchInventory(reader, 'test', 'all', [item('deleted-seed')], ['Pod', 'ConfigMap', 'CustomResourceDefinition', 'Secret'], new AbortController().signal, () => {});
  expect(result.items.map(item => item.name)).toContain('unopened-config');
  expect(result.items.map(item => item.name)).toContain('custom-one');
  expect(result.items.map(item => item.name)).not.toContain('deleted-seed');
  expect(reads).toContain('widgets.example.io');
  expect(result.completed).toBe(result.total); expect(result.errors).toEqual(['Secret: Forbidden']);
});
it('cancels an inventory without publishing late reads or starting additional collections', async () => {
  const controller = new AbortController();
  let finish!: (items: ReturnType<typeof item>[]) => void;
  const snapshots: string[] = [];
  const reader = { getResources: () => new Promise<ReturnType<typeof item>[]>(resolve => { finish = resolve; }), getCustomResources: async () => [], getHelmInventory: async () => [] };
  const pending = loadSearchInventory(reader, 'test', 'all', [], ['Pod'], controller.signal, snapshot => snapshots.push(String(snapshot.items.length)));
  controller.abort(); finish([item('late')]);
  await pending;
  expect(snapshots).toEqual(['0']);
});
