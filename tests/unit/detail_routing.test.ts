import { expect, it } from 'vitest';
import { ResourceDetailsRouter } from '../../src/components/k8s/details/ResourceDetailsRouter';
import { GenericResourceDetails } from '../../src/components/k8s/details/kinds/GenericResourceDetails';
import { PodDetails } from '../../src/components/k8s/details/kinds/PodDetails';
import { GatewayDetails } from '../../src/components/k8s/details/kinds/GatewayDetails';

it.each([
  ['Pod', 'example.org/v1', GenericResourceDetails],
  ['Gateway', 'example.org/v1', GenericResourceDetails],
  ['Pod', 'v1', PodDetails],
  ['Gateway', 'gateway.networking.k8s.io/v1', GatewayDetails],
] as const)('routes %s from %s by API group, without relying on function names', (kind, apiVersion, expected) => {
  const view = ResourceDetailsRouter({ item: { uid: 'resource', name: 'example', namespace: 'default', kind, apiVersion }, onNavigate() {}, onLogs() {}, onShell() {} });
  expect(view.type).toBe(expected);
});
