import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { PodEnvironmentTab } from '../../src/components/k8s/details/PodEnvironmentTab';
import type { ResourceItem } from '../../src/types/k8s';

describe('PodEnvironmentTab', () => {
  beforeAll(() => {
    (globalThis as any).window = {
      innerHeight: 800,
      innerWidth: 1200,
      clearTimeout: () => {},
      setTimeout: () => 1,
    };
  });

  afterAll(() => {
    delete (globalThis as any).window;
  });
  const podItem: ResourceItem = {
    uid: 'pod-123',
    name: 'test-pod',
    namespace: 'default',
    kind: 'Pod',
    apiVersion: 'v1',
    raw: {
      metadata: { name: 'test-pod', namespace: 'default' },
      spec: {
        containers: [
          {
            name: 'app',
            env: [
              { name: 'ENV_VAR_1', value: 'value-1' },
              {
                name: 'ENV_VAR_2',
                valueFrom: {
                  configMapKeyRef: { name: 'my-cm', key: 'VAR_KEY' },
                },
              },
            ],
          },
        ],
      },
    },
  };

  it('renders Value as the compact column header and not the verbose Resolved Value', () => {
    const html = renderToString(React.createElement(PodEnvironmentTab, { item: podItem }));
    expect(html).toContain('>Value<');
    expect(html).toContain('title="Resolved value (current source) · Click to copy"');
    expect(html).not.toContain('Resolved Value (current source)');
  });

  it('does not render an Actions column', () => {
    const html = renderToString(React.createElement(PodEnvironmentTab, { item: podItem }));
    expect(html).not.toContain('>Actions<');
  });

  it('renders names and values as clickable to copy', () => {
    const html = renderToString(React.createElement(PodEnvironmentTab, { item: podItem }));
    expect(html).toContain('title="Click to copy name"');
    expect(html).toContain('title="Click to copy value"');
  });

  it('renders Hide Source button when source is visible by default, without redundant eye icon in header', () => {
    const html = renderToString(React.createElement(PodEnvironmentTab, { item: podItem }));
    expect(html).toContain('Hide Source');
    expect(html).toContain('>Source<');
    expect(html).not.toContain('aria-label="Hide Source column"');
    expect(html).toContain('ConfigMap:');
  });

  it('hides Source column when show_source is false in localStorage', () => {
    const originalStorage = (globalThis as any).localStorage;
    const mockStorage = {
      getItem: (key: string) => (key === 'kubiki.pod_env.show_source' ? 'false' : null),
      setItem: () => {},
      removeItem: () => {},
    };
    (globalThis as any).localStorage = mockStorage;

    try {
      const html = renderToString(React.createElement(PodEnvironmentTab, { item: podItem }));
      expect(html).toContain('Show Source');
      expect(html).not.toContain('>Source<');
      expect(html).not.toContain('ConfigMap:');
      // In 2-column mode with +- equal values, columns are 50% / 50%
      expect(html).toContain('style="width:50%"');
    } finally {
      if (originalStorage === undefined) delete (globalThis as any).localStorage;
      else (globalThis as any).localStorage = originalStorage;
    }
  });

  it('compresses Name column to give space to Value when a value is large in 2-column mode', () => {
    const podWithLargeVal: ResourceItem = {
      uid: 'pod-large',
      name: 'large-pod',
      namespace: 'default',
      kind: 'Pod',
      apiVersion: 'v1',
      raw: {
        metadata: { name: 'large-pod', namespace: 'default' },
        spec: {
          containers: [
            {
              name: 'app',
              env: [
                { name: 'PORT', value: '8080' },
                { name: 'JWT_KEY', value: 'x'.repeat(160) },
              ],
            },
          ],
        },
      },
    };

    const originalStorage = (globalThis as any).localStorage;
    (globalThis as any).localStorage = {
      getItem: (key: string) => (key === 'kubiki.pod_env.show_source' ? 'false' : null),
      setItem: () => {},
      removeItem: () => {},
    };

    try {
      const html = renderToString(React.createElement(PodEnvironmentTab, { item: podWithLargeVal }));
      // Name is compressed from 50% down to 32%, Value gets 68%
      expect(html).toContain('style="width:32%"');
      expect(html).toContain('style="width:68%"');
    } finally {
      if (originalStorage === undefined) delete (globalThis as any).localStorage;
      else (globalThis as any).localStorage = originalStorage;
    }
  });

  it('omits volume-only Secrets from Environment and surfaces unavailable env Secret states in place', async () => {
    const actualCache = await vi.importActual<typeof import('../../src/state/detail_cache')>('../../src/state/detail_cache');
    const volumeSecret: ResourceItem = {
      uid: 'sec-vol',
      name: 'chaos-mesh-webhook-certs',
      namespace: 'chaos-mesh',
      kind: 'Secret',
      apiVersion: 'v1',
      readProjection: 'metadata',
      raw: { metadata: { uid: 'sec-vol', name: 'chaos-mesh-webhook-certs', namespace: 'chaos-mesh' } },
    };
    const bulkSecret: ResourceItem = {
      uid: 'sec-bulk',
      name: 'bulk-secret',
      namespace: 'prod',
      kind: 'Secret',
      apiVersion: 'v1',
      readProjection: 'metadata',
      raw: { metadata: { uid: 'sec-bulk', name: 'bulk-secret', namespace: 'prod' } },
    };
    const merged = {
      Secret: new Map<string, ResourceItem>([
        ['sec-vol', volumeSecret],
        ['sec-bulk', bulkSecret],
      ]),
    } as any;
    const reads = new Map<string, 'notFound' | 'unavailable'>([
      [actualCache.detailReadKey('Secret', 'missing-secret', 'prod'), 'notFound'],
      [actualCache.detailReadKey('Secret', 'denied-secret', 'prod'), 'unavailable'],
    ]);

    vi.resetModules();
    vi.doMock('../../src/state/detail_cache', () => ({
      ...actualCache,
      useMergedDetailResources: () => merged,
      useDetailReadStates: () => reads,
    }));

    try {
      const { PodEnvironmentTab: MockedEnvTab } = await import('../../src/components/k8s/details/PodEnvironmentTab');
      const volumeOnlyPod: ResourceItem = {
        uid: 'pod-vol',
        name: 'chaos-pod',
        namespace: 'chaos-mesh',
        kind: 'Pod',
        apiVersion: 'v1',
        raw: {
          metadata: { name: 'chaos-pod', namespace: 'chaos-mesh' },
          spec: {
            volumes: [{ name: 'certs', secret: { secretName: 'chaos-mesh-webhook-certs' } }],
            containers: [{ name: 'app', env: [{ name: 'BURST', value: '50' }] }],
          },
        },
      };
      const volHtml = renderToString(React.createElement(MockedEnvTab, { item: volumeOnlyPod }));
      expect(volHtml).not.toContain('chaos-mesh-webhook-certs');
      expect(volHtml).not.toContain('Unavailable envFrom Secrets');

      const envSecretPod: ResourceItem = {
        uid: 'pod-env-sec',
        name: 'api-pod',
        namespace: 'prod',
        kind: 'Pod',
        apiVersion: 'v1',
        raw: {
          metadata: { name: 'api-pod', namespace: 'prod' },
          spec: {
            containers: [{
              name: 'app',
              envFrom: [{ secretRef: { name: 'bulk-secret' } }],
              env: [
                { name: 'API_TOKEN', valueFrom: { secretKeyRef: { name: 'missing-secret', key: 'token' } } },
                { name: 'DENIED_KEY', valueFrom: { secretKeyRef: { name: 'denied-secret', key: 'pw' } } },
              ],
            }],
          },
        },
      };
      const envHtml = renderToString(React.createElement(MockedEnvTab, { item: envSecretPod }));
      expect(envHtml).toContain('bulk-secret');
      expect(envHtml).toContain('Exists · contents unavailable');
      expect(envHtml).toContain('Not found');
      expect(envHtml).toContain('Existence unknown · access unavailable');
      expect(envHtml).not.toContain('••••••••••••');
    } finally {
      vi.doUnmock('../../src/state/detail_cache');
      vi.resetModules();
    }
  });
});
