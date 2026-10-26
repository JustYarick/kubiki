import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { KubeContextInfo } from '../../src/types/k8s';

const backing = new Map<string, string>();
const storage = {
  getItem: (key: string) => backing.get(key) ?? null,
  setItem: (key: string, value: string) => { backing.set(key, value); },
  removeItem: (key: string) => { backing.delete(key); },
};
const contexts: KubeContextInfo[] = [
  { name: 'dev', cluster: 'dev', user: 'dev', is_current: true },
  { name: 'prod', cluster: 'prod', user: 'prod', is_current: false },
];
const key = 'kubiki.cluster.last-context.v1';

beforeEach(() => { backing.clear(); vi.resetModules(); vi.stubGlobal('localStorage', storage); });
afterEach(() => vi.unstubAllGlobals());

it('restores the last cluster after a new application session instead of kubeconfig current-context', async () => {
  const first = (await import('../../src/state/cluster_store')).useClusterStore;
  first.getState().setContexts(contexts);
  first.getState().selectContext('prod');
  first.getState().selectNamespace('backend');
  vi.resetModules();
  const second = (await import('../../src/state/cluster_store')).useClusterStore;
  second.getState().setContexts(contexts);
  expect(second.getState().currentContext).toBe('prod');
  expect(second.getState().contexts.find(context => context.is_current)?.name).toBe('prod');
  second.getState().selectContext(second.getState().currentContext!);
  expect(second.getState().selectedNamespace).toBe('backend');
  expect(contexts[0].is_current).toBe(true);
});

it('falls back to kubeconfig current-context, then the first context, when the saved cluster was removed', async () => {
  backing.set(key, JSON.stringify('removed'));
  const { useClusterStore: store } = await import('../../src/state/cluster_store');
  store.getState().setContexts(contexts);
  expect(store.getState().currentContext).toBe('dev');
  store.setState({ currentContext: null });
  store.getState().setContexts(contexts.map(context => ({ ...context, is_current: false })));
  expect(store.getState().currentContext).toBe('dev');
  store.getState().setContexts([]);
  expect(store.getState().currentContext).toBeNull();
});

it('refreshing the list preserves the currently selected cluster', async () => {
  const { useClusterStore: store } = await import('../../src/state/cluster_store');
  store.getState().setContexts(contexts);
  store.getState().selectContext('prod');
  store.getState().setContexts(contexts);
  expect(store.getState().currentContext).toBe('prod');
});

it('turning cluster memory off deletes the selection and uses kubeconfig on the next launch', async () => {
  const { useClusterStore: store } = await import('../../src/state/cluster_store');
  store.getState().setContexts(contexts);
  store.getState().selectContext('prod');
  store.getState().setRememberLastContext(false);
  expect(backing.has(key)).toBe(false);
  expect(store.getState().currentContext).toBe('prod');
  store.getState().selectContext('dev');
  expect(backing.has(key)).toBe(false);
  vi.resetModules();
  const restored = (await import('../../src/state/cluster_store')).useClusterStore;
  restored.getState().setContexts(contexts);
  expect(restored.getState().rememberLastContext).toBe(false);
  expect(restored.getState().currentContext).toBe('dev');
});

it('ignores corrupt stored selections and works when browser storage is unavailable', async () => {
  backing.set(key, '{bad JSON');
  const { useClusterStore: store } = await import('../../src/state/cluster_store');
  store.getState().setContexts(contexts);
  expect(store.getState().currentContext).toBe('dev');
  vi.stubGlobal('localStorage', { getItem() { throw new Error('unavailable'); }, setItem() { throw new Error('unavailable'); }, removeItem() { throw new Error('unavailable'); } });
  expect(() => {
    store.getState().selectContext('prod');
    store.getState().setRememberLastContext(false);
    store.getState().setContexts(contexts);
  }).not.toThrow();
  expect(store.getState().currentContext).toBe('prod');
});
