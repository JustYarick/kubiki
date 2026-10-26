import { describe, expect, it, vi } from 'vitest';
import { K8sProvider } from '../../src/providers/k8s_provider';
import type { KubernetesReadTransport } from '../../src/providers/read_transport';
import { buildMockResources } from '../../src/providers/mock/mock_resources';
import { customResourceType, resourceBucket } from '../../src/core/resources/custom_resource_types';

describe('demo cluster availability', () => {
  const transport = (request: ReturnType<typeof vi.fn>) => ({ native: false, request } as KubernetesReadTransport);
  it.each([
    { developerMode: false, hasContexts: false, demo: true },
    { developerMode: false, hasContexts: true, demo: false },
    { developerMode: true, hasContexts: false, demo: true },
    { developerMode: true, hasContexts: true, demo: true },
  ])('developer mode $developerMode, kubeconfig contexts $hasContexts: demo $demo', async ({ developerMode, hasContexts, demo }) => {
    const contexts = hasContexts ? [{ name: 'prod', is_current: true }, { name: 'stage', is_current: false }] : [];
    const request = vi.fn().mockResolvedValue(contexts);
    const provider = new K8sProvider(transport(request), developerMode);
    const listed = await provider.getContexts();
    expect(listed.filter(item => item.name === 'kubiki-demo')).toHaveLength(demo ? 1 : 0);
    expect(listed.filter(item => item.name !== 'kubiki-demo')).toEqual(contexts);
    if (demo) expect(listed.at(-1)?.is_current).toBe(!hasContexts);
  });
  it('updates the list when the Developer mode setting changes without rereading kubeconfig', async () => {
    const request = vi.fn().mockResolvedValue([{ name: 'prod', is_current: true }]);
    const provider = new K8sProvider(transport(request));
    expect(await provider.getContexts()).toHaveLength(1);
    expect(provider.setDeveloperMode(true)?.map(item => item.name)).toEqual(['prod', 'kubiki-demo']);
    provider.activateContext('kubiki-demo');
    expect(provider.demo).toBe(true);
    request.mockClear();
    expect(await provider.getNamespaces('kubiki-demo')).toContain('argocd');
    expect(request).not.toHaveBeenCalled();
    expect(provider.setDeveloperMode(false)?.map(item => item.name)).toEqual(['prod']);
    provider.activateContext('prod');
    expect(provider.demo).toBe(false);
    request.mockResolvedValue(['real']);
    expect(await provider.getNamespaces('prod')).toEqual(['real']);
  });
  it.each([false, true])('offers fallback for absent kubeconfig when Developer mode is %s', async enabled => {
    const request = vi.fn().mockRejectedValue(new Error('Kubeconfig file not found at /missing/config'));
    const provider = new K8sProvider(transport(request), enabled);
    expect(await provider.getContexts()).toEqual([expect.objectContaining({ name: 'kubiki-demo', is_current: true })]);
    expect(provider.setDeveloperMode(false)).toEqual([expect.objectContaining({ name: 'kubiki-demo' })]);
  });
  it('preserves bridge, permission and malformed configuration errors outside Developer mode', async () => {
    for (const message of ['Bridge unavailable', 'Failed to read kubeconfig: permission denied', 'Failed to parse kubeconfig: invalid YAML']) {
      const request = vi.fn().mockRejectedValue(new Error(message));
      await expect(new K8sProvider(transport(request)).getContexts()).rejects.toThrow(message);
    }
  });
  it('does not replace a real kubeconfig context named kubiki-demo with mocks', async () => {
    const contexts = [{ name: 'kubiki-demo', is_current: true }];
    const request = vi.fn().mockResolvedValue(contexts);
    const provider = new K8sProvider(transport(request), true);
    expect(await provider.getContexts()).toEqual(contexts);
    provider.activateContext('kubiki-demo');expect(provider.demo).toBe(false);
  });
  it('provides inspectable Flux, Argo CD, Helm hook and correlated event fixtures', () => {
    const resources = buildMockResources();
    const definitions = resources.CustomResourceDefinition.map(customResourceType).filter(Boolean);
    const applications = definitions.find(type => type!.kind === 'Application')!;
    expect(resources[resourceBucket({ kind: applications.kind, apiVersion: `${applications.group}/${applications.version}` })]).toHaveLength(6);
    expect(resources.Job.some(item => item.name === 'loki-migrate' && item.raw?.status?.conditions[0].reason === 'BackoffLimitExceeded')).toBe(true);
    expect(resources.Event.some(item => item.raw?.involvedObject?.uid === 'demo-loki-migrate')).toBe(true);
  });
});
