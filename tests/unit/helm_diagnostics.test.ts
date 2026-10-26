import { expect, it } from 'vitest';
import { fluxReleaseOwner, helmOperation, parseReleaseManifest, releaseHealth } from '../../src/core/resources/helm_diagnostics';
import type { HelmRelease } from '../../src/providers/helm_types';
import type { ResourceItem } from '../../src/types/k8s';
import { deliveryActivity } from '../../src/core/resources/delivery_activity';
import { argoHealth, argoSync, deliveryTimestamp } from '../../src/core/resources/delivery';

const release: HelmRelease = { name: 'redis', namespace: 'storage', chart: 'redis-1', revision: '2', app_version: '1', updated: '2026-10-20T10:00:00Z', status: 'pending-upgrade' };
it('times pending operations but never infers uninstall start time from an old deployment', () => {
  const now = Date.parse('2026-10-20T11:00:00Z');
  expect(helmOperation(release, [], now)).toMatchObject({ longRunning: true, pending: true });
  expect(helmOperation({ ...release, status: 'uninstalling' }, [], now)).toMatchObject({ longRunning: false, started: 0, pending: true });
  expect(helmOperation({ ...release, updated: 'invalid' }, [], now)).toMatchObject({ longRunning: false, started: 0 });
});
it('matches Flux ownership using explicit release and storage namespaces, avoiding cross namespace guesses', () => {
  const item: ResourceItem = { kind: 'HelmRelease', apiVersion: 'helm.toolkit.fluxcd.io/v2', uid: 'owner', name: 'cache', namespace: 'flux-system', raw: { spec: { targetNamespace: 'backend', storageNamespace: 'storage', releaseName: 'redis' } } };
  expect(fluxReleaseOwner(release, [item])).toBe(item);
  expect(fluxReleaseOwner({ ...release, namespace: 'backend' }, [item])).toBeUndefined();
  expect(fluxReleaseOwner(release, [{ ...item, apiVersion: 'other.io/v1' }])).toBeUndefined();
});
it('reads multiple rendered documents and treats unloaded objects as unknown', () => {
  const items = parseReleaseManifest('apiVersion: v1\nkind: Namespace\nmetadata:\n  name: backend\n---\napiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: redis\n', 'backend');
  expect(items[0].namespace).toBeUndefined();expect(items[1].namespace).toBe('backend');
  const rows = releaseHealth(items, []);expect(rows.map(row => row.label)).toEqual(['Not loaded', 'Not loaded']);expect(rows[1].issues).toEqual([]);
  expect(() => parseReleaseManifest('broken: yes', 'backend')).toThrow('identity');
});
it('correlates controller events by UID, namespace and API group', () => {
  const item: ResourceItem = { kind: 'Application', apiVersion: 'argoproj.io/v1alpha1', name: 'web', namespace: 'argocd', uid: 'new', raw: { status: { health: { status: 'Healthy' }, sync: { status: 'OutOfSync' }, reconciledAt: '2026-10-20T10:00:00Z' } } };
  const event = (uid: string, namespace = 'argocd', apiVersion = item.apiVersion): ResourceItem => ({ kind: 'Event', apiVersion: 'v1', uid: `event-${uid}`, name: 'event', namespace, raw: { type: 'Warning', reason: 'SyncFailed', message: 'Hook failed', involvedObject: { kind: item.kind, apiVersion, name: 'web', namespace, uid } } });
  expect(deliveryActivity([event('old'), event('new', 'other'), event('new', 'argocd', 'other.io/v1'), event('new')], [item])).toHaveLength(1);
  expect(argoHealth(item)).toBe('Healthy');expect(argoSync(item)).toBe('OutOfSync');expect(deliveryTimestamp(item)?.label).toBe('Last checked');
});
