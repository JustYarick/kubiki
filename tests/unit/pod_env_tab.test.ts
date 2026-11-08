import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
    const originalGetItem = globalThis.localStorage?.getItem;
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
      if (originalGetItem) {
        (globalThis as any).localStorage.getItem = originalGetItem;
      }
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

    const originalGetItem = globalThis.localStorage?.getItem;
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
      if (originalGetItem) {
        (globalThis as any).localStorage.getItem = originalGetItem;
      }
    }
  });
});
