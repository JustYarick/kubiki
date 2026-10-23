import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/* cluster_store touches localStorage lazily and tolerates its absence (Node). */
const backing = new Map<string, string>();
const storage = {
  getItem: (key: string) => backing.get(key) ?? null,
  setItem: (key: string, value: string) => { backing.set(key, value); },
  removeItem: (key: string) => { backing.delete(key); },
};

function installedScopes(): Record<string, string> {
  const raw = backing.get('kubiki.namespace.scopes.v1');
  return raw ? JSON.parse(raw) as Record<string, string> : {};
}

beforeEach(() => {
  backing.clear();
  vi.resetModules();
  (globalThis as { localStorage?: unknown }).localStorage = storage;
});

afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe('cluster store namespace scope memory', () => {
  it('remembers the scope of each context when remembering is enabled', async () => {
    const { useClusterStore } = await import('../../src/state/cluster_store');
    useClusterStore.getState().setRememberNamespaceScope(true);

    useClusterStore.getState().selectContext('dev');
    useClusterStore.getState().selectNamespace('backend');
    expect(useClusterStore.getState().selectedNamespace).toBe('backend');
    expect(Object.keys(installedScopes())).toContain('dev');

    useClusterStore.getState().selectContext('prod');
    useClusterStore.getState().selectNamespace('frontend');

    useClusterStore.getState().selectContext('dev');
    expect(useClusterStore.getState().selectedNamespace).toBe('backend');
    useClusterStore.getState().selectContext('prod');
    expect(useClusterStore.getState().selectedNamespace).toBe('frontend');
  });

  it('falls back to all namespaces and clears stored scopes when remembering is off', async () => {
    const { useClusterStore } = await import('../../src/state/cluster_store');
    useClusterStore.getState().setRememberNamespaceScope(true);
    useClusterStore.getState().selectContext('dev');
    useClusterStore.getState().selectNamespace('backend');

    useClusterStore.getState().setRememberNamespaceScope(false);
    expect(installedScopes()).toEqual({});

    useClusterStore.getState().selectContext('prod');
    useClusterStore.getState().selectNamespace('frontend');
    useClusterStore.getState().selectContext('dev');
    expect(useClusterStore.getState().selectedNamespace).toBe('all');
  });

  it('keeps working without localStorage', async () => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
    const { useClusterStore } = await import('../../src/state/cluster_store');
    expect(useClusterStore.getState().rememberNamespaceScope).toBe(true);
    useClusterStore.getState().selectContext('dev');
    useClusterStore.getState().selectNamespace('backend');
    useClusterStore.getState().setRememberNamespaceScope(false);
    expect(useClusterStore.getState().selectedNamespace).toBe('backend');
  });
});
