import { describe, it, expect } from 'vitest';
import { resolveContainerEnv } from '../../src/core/resources/pod_env';
import type { ResourceItem } from '../../src/types/k8s';

describe('resolveContainerEnv', () => {
  it('resolves direct env and configMapKeyRef with drift detection', () => {
    const podStarted = '2026-10-27T10:00:00Z';
    const cmUpdated = '2026-10-27T10:30:00Z'; // 30m after pod start

    const pod: ResourceItem = {
      uid: 'pod-1',
      name: 'my-pod',
      namespace: 'default',
      kind: 'Pod',
      apiVersion: 'v1',
      raw: {
        metadata: { name: 'my-pod', namespace: 'default' },
        spec: {
          containers: [
            {
              name: 'web',
              env: [
                { name: 'PORT', value: '8080' },
                {
                  name: 'LOG_LEVEL',
                  valueFrom: {
                    configMapKeyRef: { name: 'app-config', key: 'LOG_LEVEL' },
                  },
                },
              ],
            },
          ],
        },
        status: {
          containerStatuses: [
            {
              name: 'web',
              state: {
                running: { startedAt: podStarted },
              },
            },
          ],
        },
      },
    };

    const configMap: ResourceItem = {
      uid: 'cm-1',
      name: 'app-config',
      namespace: 'default',
      kind: 'ConfigMap',
      apiVersion: 'v1',
      raw: {
        metadata: {
          name: 'app-config',
          namespace: 'default',
          creationTimestamp: cmUpdated,
        },
        data: {
          LOG_LEVEL: 'Debug',
        },
      },
    };

    const result = resolveContainerEnv(pod, 'web', {
      ConfigMap: new Map([['cm-1', configMap]]),
    });

    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]).toEqual({
      name: 'LOG_LEVEL',
      value: 'Debug',
      sourceType: 'configMap',
      sourceName: 'app-config',
      sourceKey: 'LOG_LEVEL',
      isSecret: false,
      drift: {
        clusterValue: 'Debug',
        reason: 'ConfigMap/app-config updated after Pod started',
      },
    });
    expect(result.entries[1]).toEqual({
      name: 'PORT',
      value: '8080',
      sourceType: 'direct',
      isSecret: false,
    });
    expect(result.hasDrift).toBe(true);
    expect(result.driftCount).toBe(1);
  });

  it('resolves envFrom and decodes Secret data properly', () => {
    const pod: ResourceItem = {
      uid: 'pod-2',
      name: 'backend-pod',
      namespace: 'prod',
      kind: 'Pod',
      apiVersion: 'v1',
      raw: {
        metadata: { name: 'backend-pod', namespace: 'prod' },
        spec: {
          containers: [
            {
              name: 'api',
              envFrom: [
                {
                  secretRef: { name: 'db-credentials' },
                  prefix: 'DB_',
                },
              ],
            },
          ],
        },
      },
    };

    const secret: ResourceItem = {
      uid: 'sec-1',
      name: 'db-credentials',
      namespace: 'prod',
      kind: 'Secret',
      apiVersion: 'v1',
      raw: {
        metadata: { name: 'db-credentials', namespace: 'prod' },
        data: {
          PASSWORD: btoa('supersecret123'),
        },
      },
    };

    const result = resolveContainerEnv(pod, 'api', {
      Secret: new Map([['sec-1', secret]]),
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      name: 'DB_PASSWORD',
      value: 'supersecret123',
      sourceType: 'secret',
      sourceName: 'db-credentials',
      isSecret: true,
    });
  });
});
