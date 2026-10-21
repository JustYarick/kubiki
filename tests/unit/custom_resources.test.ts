import { describe, expect, it } from 'vitest';
import { customColumnValue, customResourceType, resourceBucket } from '../../src/core/resources/custom_resource_types';
import { parseCustomResources } from '../../src/providers/custom_resources';
import type { ResourceItem } from '../../src/types/k8s';

const crd: ResourceItem = { uid: 'crd-1', name: 'certificates.security.example', kind: 'CustomResourceDefinition', apiVersion: 'apiextensions.k8s.io/v1', raw: { spec: { group: 'security.example', scope: 'Namespaced', names: { kind: 'Certificate', plural: 'certificates' }, versions: [
  { name: 'v1alpha1', served: false, storage: false },
  { name: 'v1', served: true, storage: true, additionalPrinterColumns: [{ name: 'Ready', type: 'string', jsonPath: '.status.conditions[?(@.type=="Ready")].status' }, { name: 'Issuer', type: 'string', jsonPath: '.spec.issuerRef.name' }] },
] } } };
describe('Custom resource discovery and parsing', () => {
  it('discovers a served version and printer columns and isolates identical Kind names across API groups', () => {
    expect(customResourceType(crd)).toMatchObject({ kind: 'Certificate', group: 'security.example', key: 'custom:security.example/Certificate', version: 'v1', namespaced: true, columns: [{ name: 'Ready' }, { name: 'Issuer' }] });
    expect(resourceBucket({ kind: 'Certificate', apiVersion: 'security.example/v1' })).not.toBe(resourceBucket({ kind: 'Certificate', apiVersion: 'another.example/v1' }));
    expect(resourceBucket({ kind: 'Pod', apiVersion: 'custom.example/v1' })).toBe('custom:custom.example/Pod');
    expect(resourceBucket({ kind: 'Pod', apiVersion: 'v1' })).toBe('Pod');
    expect(customResourceType({ ...crd, raw: { spec: {} } })).toBeUndefined();
  });
  it('reads safe CRD JSONPaths, including conditions, list indices, wildcard values and false/zero', () => {
    const raw = { spec: { issuerRef: { name: 'root' }, targets: [{ port: 0 }, { port: 443 }], enabled: false }, status: { conditions: [{ type: 'Synced', status: 'False' }, { type: 'Ready', status: 'True' }] } };
    expect(customColumnValue(raw, '.status.conditions[?(@.type=="Ready")].status')).toBe('True');
    expect(customColumnValue(raw, '.spec.issuerRef.name')).toBe('root');
    expect(customColumnValue(raw, '.spec.targets[0].port')).toBe('0');
    expect(customColumnValue(raw, '.spec.targets[*].port')).toBe('0, 443');
    expect(customColumnValue(raw, '.spec.enabled')).toBe('false');
    expect(customColumnValue(raw, '.spec.missing')).toBeUndefined();
    expect(customColumnValue(raw, '.spec.targets.map(alert)')).toBeUndefined();
  });
  it('preserves manifests and condition-derived statuses without fabricating healthy defaults', () => {
    const raw = { apiVersion: 'security.example/v1', kind: 'Certificate', metadata: { uid: 'cert-1', name: 'tls', namespace: 'backend' }, spec: { issuerRef: { name: 'root' } }, status: { conditions: [{ type: 'Ready', status: 'False', reason: 'Issuing' }] } };
    expect(parseCustomResources({ items: [raw] })[0]).toMatchObject({ kind: 'Certificate', status: 'Issuing', raw, spec: raw.spec });
    expect(parseCustomResources({ items: [{ ...raw, status: {} }] })[0].status).toBeUndefined();
    expect(() => parseCustomResources({ items: [{}] })).toThrow('Invalid custom resource');
  });
  it('correctly parses buckets.source.toolkit.fluxcd.io CRD and extracts custom printer values', () => {
    const fluxBucketCrd: ResourceItem = {
      uid: 'crd-flux-bucket',
      name: 'buckets.source.toolkit.fluxcd.io',
      kind: 'CustomResourceDefinition',
      apiVersion: 'apiextensions.k8s.io/v1',
      raw: {
        metadata: { name: 'buckets.source.toolkit.fluxcd.io' },
        spec: {
          group: 'source.toolkit.fluxcd.io',
          scope: 'Namespaced',
          names: { kind: 'Bucket', plural: 'buckets', singular: 'bucket', shortNames: ['bkt'] },
          versions: [
            {
              name: 'v1beta2',
              served: true,
              storage: true,
              additionalPrinterColumns: [
                { name: 'Endpoint', type: 'string', jsonPath: '.spec.endpoint' },
                { name: 'Age', type: 'date', jsonPath: '.metadata.creationTimestamp' },
                { name: 'Ready', type: 'string', jsonPath: '.status.conditions[?(@.type=="Ready")].status' },
                { name: 'Status', type: 'string', jsonPath: '.status.conditions[?(@.type=="Ready")].message' },
              ],
            },
            { name: 'v1beta1', served: true, storage: false },
          ],
        },
      },
    };
    const parsed = customResourceType(fluxBucketCrd);
    expect(parsed).toBeDefined();
    expect(parsed).toMatchObject({
      name: 'buckets.source.toolkit.fluxcd.io',
      group: 'source.toolkit.fluxcd.io',
      kind: 'Bucket',
      plural: 'buckets',
      singular: 'bucket',
      shortNames: ['bkt'],
      version: 'v1beta2',
      namespaced: true,
      key: 'custom:source.toolkit.fluxcd.io/Bucket',
    });
    expect(parsed?.columns).toHaveLength(4);
    expect(parsed?.columns.map(c => c.name)).toEqual(['Endpoint', 'Age', 'Ready', 'Status']);

    const bucketItem = {
      apiVersion: 'source.toolkit.fluxcd.io/v1beta2',
      kind: 'Bucket',
      metadata: { name: 'assets-bucket', namespace: 'flux-system' },
      spec: { endpoint: 's3.eu-west-1.amazonaws.com', bucketName: 'prod-assets', interval: '5m' },
      status: { conditions: [{ type: 'Ready', status: 'True', message: 'Stored revision: b2941c' }] },
    };
    expect(customColumnValue(bucketItem, '.spec.endpoint')).toBe('s3.eu-west-1.amazonaws.com');
    expect(customColumnValue(bucketItem, '.status.conditions[?(@.type=="Ready")].status')).toBe('True');
    expect(customColumnValue(bucketItem, '.status.conditions[?(@.type=="Ready")].message')).toBe('Stored revision: b2941c');
    expect(resourceBucket(bucketItem)).toBe('custom:source.toolkit.fluxcd.io/Bucket');
  });
  it('handles legacy v1beta1 CRDs with spec.version instead of spec.versions', () => {
    const legacyCrd: ResourceItem = {
      uid: 'crd-legacy',
      name: 'widgets.legacy.example.com',
      kind: 'CustomResourceDefinition',
      apiVersion: 'apiextensions.k8s.io/v1beta1',
      raw: {
        spec: {
          group: 'legacy.example.com',
          scope: 'Cluster',
          names: { kind: 'Widget', plural: 'widgets' },
          version: 'v1beta1',
          additionalPrinterColumns: [{ name: 'Phase', type: 'string', jsonPath: '.status.phase' }],
        },
      },
    };
    const parsed = customResourceType(legacyCrd);
    expect(parsed).toMatchObject({
      name: 'widgets.legacy.example.com',
      group: 'legacy.example.com',
      kind: 'Widget',
      plural: 'widgets',
      version: 'v1beta1',
      namespaced: false,
      key: 'custom:legacy.example.com/Widget',
    });
    expect(parsed?.columns).toHaveLength(1);
    expect(parsed?.columns[0].name).toBe('Phase');
  });
});
