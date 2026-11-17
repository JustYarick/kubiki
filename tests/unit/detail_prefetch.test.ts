import { expect, it, vi } from 'vitest';
import { InitialSyncQueue } from '../../src/providers/initial_sync_queue';
import { queuedRead } from '../../src/providers/read_queue';
import { extractForwardRefs, prefetchDetailDependencies } from '../../src/providers/detail_prefetch';
import { useDetailCache, detailReadKey } from '../../src/state/detail_cache';
import { mapK8sResource } from '../../src/core/utils/k8s_mapper';

it('prioritizes high/normal reads ahead of low background reads without starvation', async () => {
  const queue = new InitialSyncQueue(4);
  const started: string[] = [];
  let releaseLow!: () => void;
  const lowGate = new Promise<void>(r => { releaseLow = r; });

  const low1 = queue.run(async () => { started.push('low1'); await lowGate; }, new AbortController().signal, 'low');
  const low2 = queue.run(async () => { started.push('low2'); await lowGate; }, new AbortController().signal, 'low');
  const low3 = queue.run(async () => { started.push('low3'); await lowGate; }, new AbortController().signal, 'low');
  const low4 = queue.run(async () => { started.push('low4'); }, new AbortController().signal, 'low');
  // low4 must wait because lowCap reserves 1 of 4 slots for interactive reads.
  expect(started).toEqual(['low1', 'low2', 'low3']);

  const high1 = queue.run(async () => { started.push('high1'); }, new AbortController().signal, 'high');
  expect(started).toEqual(['low1', 'low2', 'low3', 'high1']);

  releaseLow();
  await Promise.all([low1, low2, low3, low4, high1]);
  expect(started).toContain('low4');
});

it('extracts Pod direct forward references and marks Secrets metadataOnly by default', () => {
  const pod = mapK8sResource({
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: 'web-0',
      namespace: 'prod',
      uid: 'pod-0',
      ownerReferences: [{ apiVersion: 'apps/v1', kind: 'ReplicaSet', name: 'web-rs', uid: 'rs-0' }],
    },
    spec: {
      nodeName: 'worker-a',
      serviceAccountName: 'web-sa',
      volumes: [
        { name: 'cfg', configMap: { name: 'app-config' } },
        { name: 'tls', secret: { secretName: 'tls-cert' } },
        { name: 'data', persistentVolumeClaim: { claimName: 'app-pvc' } },
      ],
      containers: [{ name: 'web', image: 'nginx:1.27' }],
    },
  }, 'Pod');

  const refs = extractForwardRefs(pod, false);
  expect(refs).toEqual(expect.arrayContaining([
    { kind: 'ReplicaSet', name: 'web-rs', namespace: 'prod', metadataOnly: false },
    { kind: 'Node', name: 'worker-a', namespace: undefined, metadataOnly: false },
    { kind: 'ServiceAccount', name: 'web-sa', namespace: 'prod', metadataOnly: false },
    { kind: 'ConfigMap', name: 'app-config', namespace: 'prod', metadataOnly: false },
    { kind: 'Secret', name: 'tls-cert', namespace: 'prod', metadataOnly: true },
    { kind: 'PersistentVolumeClaim', name: 'app-pvc', namespace: 'prod', metadataOnly: false },
  ]));
});

it('stores bounded detail cache entries per context and clears on context switch', () => {
  useDetailCache.getState().clear('ctx-a');
  const node = mapK8sResource({ apiVersion: 'v1', kind: 'Node', metadata: { name: 'worker-1', uid: 'node-1' } }, 'Node');
  useDetailCache.getState().upsert('ctx-a', node);
  expect(useDetailCache.getState().byKind.Node?.get('node-1')?.name).toBe('worker-1');

  const other = mapK8sResource({ apiVersion: 'v1', kind: 'Node', metadata: { name: 'worker-2', uid: 'node-2' } }, 'Node');
  useDetailCache.getState().upsert('ctx-b', other);
  expect(useDetailCache.getState().context).toBe('ctx-b');
  expect(useDetailCache.getState().byKind.Node?.has('node-1')).toBe(false);
  expect(useDetailCache.getState().byKind.Node?.get('node-2')?.name).toBe('worker-2');
  useDetailCache.getState().clear();
});

it('runs search lane requests concurrently without stalling at default table queue limit', async () => {
  let active = 0;
  let maxActive = 0;
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });

  const jobs = Array.from({ length: 12 }, () =>
    queuedRead(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await gate;
      active--;
    }, undefined, 'low', 'search'),
  );
  for (let i = 0; i < 15; i++) await Promise.resolve();
  expect(maxActive).toBe(12);
  release();
  await Promise.all(jobs);
});

it('hydrates metadata-only Secrets on Environment access and reuses full empty Secrets', async () => {
  const { k8s, K8sProvider } = await import('../../src/providers/k8s_provider');
  const { useResourceStore } = await import('../../src/state/resource_store');
  const previous = useResourceStore.getState();
  useResourceStore.setState({ resources: { ...previous.resources, Secret: new Map() }, watchStates: {} });
  useDetailCache.getState().clear();
  const reads: Record<string, unknown>[] = [];
  const provider = new K8sProvider({ native: false, request: async <T>(_command: string, _path: string, args: Record<string, unknown>) => {
    if (args.kind === 'Secret') reads.push(args);
    // Both metadata-only and full empty Secret responses have kind Secret and no data.
    return { apiVersion: 'v1', kind: args.kind, metadata: { name: args.name, namespace: args.namespace, uid: args.kind === 'Secret' ? 'secret' : 'dependency' } } as T;
  } });
  const read = vi.spyOn(k8s, 'getResource').mockImplementation(provider.getResource.bind(provider));
  const events = vi.spyOn(k8s, 'getResources').mockResolvedValue([]);
  const pod = mapK8sResource({ apiVersion: 'v1', kind: 'Pod', metadata: { uid: 'pod', name: 'web', namespace: 'prod' },
    spec: { containers: [{ name: 'web', envFrom: [{ secretRef: { name: 'config' } }] }] } }, 'Pod');
  try {
    const signal = new AbortController().signal;
    await prefetchDetailDependencies('test', pod, signal);
    expect(reads).toHaveLength(1);
    expect(useDetailCache.getState().byKind.Secret?.get('secret')?.readProjection).toBe('metadata');
    await prefetchDetailDependencies('test', pod, signal, { includeSecretPayloads: true });
    expect(reads).toHaveLength(2);
    expect(reads[1].metadataOnly).toBeUndefined();
    expect(useDetailCache.getState().byKind.Secret?.get('secret')?.readProjection).toBeUndefined();
    await prefetchDetailDependencies('test', pod, signal, { includeSecretPayloads: true });
    expect(reads).toHaveLength(2);
  } finally {
    read.mockRestore(); events.mockRestore();
    useDetailCache.getState().clear(); useResourceStore.setState(previous);
  }
});


it('keeps Secret existence separate from contents and distinguishes 404 from denied reads', async () => {
  const { k8s, K8sProvider } = await import('../../src/providers/k8s_provider');
  const { useResourceStore } = await import('../../src/state/resource_store');
  const { requestError } = await import('../../src/providers/errors');
  const previous = useResourceStore.getState();
  useResourceStore.setState({ resources: { ...previous.resources, Secret: new Map() }, watchStates: {} });
  const pod = mapK8sResource({ apiVersion: 'v1', kind: 'Pod', metadata: { uid: 'pod', name: 'web', namespace: 'prod' }, spec: { containers: [{ name: 'web', envFrom: [{ secretRef: { name: 'config' } }] }] } }, 'Pod');
  let mode: 'metadata' | 'missing' | 'denied' = 'metadata';
  const provider = new K8sProvider({ native: false, request: async <T>(_command: string, _path: string, args: Record<string, unknown>) => {
    if (mode === 'missing') throw requestError('not_found', 'Not found', { operation: 'get' }, 404);
    if (mode === 'denied' || !args.metadataOnly) throw requestError('forbidden', 'Forbidden', { operation: 'get' }, 403);
    return { apiVersion: 'v1', kind: 'Secret', metadata: { name: 'config', namespace: 'prod', uid: 'secret' } } as T;
  } });
  const read = vi.spyOn(k8s, 'getResource').mockImplementation(provider.getResource.bind(provider));
  const events = vi.spyOn(k8s, 'getResources').mockResolvedValue([]);
  try {
    useDetailCache.getState().clear('test');
    await prefetchDetailDependencies('test', pod, new AbortController().signal, { includeSecretPayloads: true });
    expect(useDetailCache.getState().byKind.Secret?.get('secret')?.readProjection).toBe('metadata');
    for (const [next, expected] of [['missing', 'notFound'], ['denied', 'unavailable']] as const) {
      mode = next; useDetailCache.getState().clear('test');
      await prefetchDetailDependencies('test', pod, new AbortController().signal);
      expect(useDetailCache.getState().readStates.get(detailReadKey('Secret', 'config', 'prod'))).toBe(expected);
      expect(useDetailCache.getState().byKind.Secret).toBeUndefined();
    }
    useDetailCache.getState().clear('other');
    expect(useDetailCache.getState().readStates.size).toBe(0);
  } finally { read.mockRestore(); events.mockRestore(); useDetailCache.getState().clear(); useResourceStore.setState(previous); }
});
