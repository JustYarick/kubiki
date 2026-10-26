import { describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import { newResourceTemplate, updateNewResourceIdentity, validateNewResource } from '../../src/core/resources/new_resource';
import { resourceType } from '../../src/core/resources/resource_types';

const deployment = resourceType('Deployment');
const original = newResourceTemplate(deployment, 'web', 'team');
describe('new resource manifests', () => {
  it('retains edited spec and comments when changing identity', () => {
    const manifest = original.replace('replicas: 1', 'replicas: 4 # edited');
    const updated = updateNewResourceIdentity(manifest, 'web.v2', 'other', true);
    expect(updated).toContain('replicas: 4 # edited');
    expect(validateNewResource(updated, deployment).metadata).toEqual({ name: 'web.v2', namespace: 'other' });
  });
  it('omits namespace and spec for Namespace creation', () => {
    const type = resourceType('Namespace');
    expect(validateNewResource(newResourceTemplate(type, 'team', 'ignored'), type)).toEqual({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'team' } });
  });
  it('supports discovery-provided custom API versions', () => {
    const type = { group: 'example.io', version: 'v1beta1', kind: 'Widget', namespaced: true };
    expect(validateNewResource(newResourceTemplate(type, 'widget', 'team'), type).apiVersion).toBe('example.io/v1beta1');
  });
  it.each([
    ['trailing dash', (o: any) => { o.metadata.name = 'web-'; }],
    ['missing namespace', (o: any) => { delete o.metadata.namespace; }],
    ['combined namespace scope', (o: any) => { o.metadata.namespace = '["a","b"]'; }],
    ['all namespace', (o: any) => { o.metadata.namespace = 'all'; }],
    ['wrong kind', (o: any) => { o.kind = 'Pod'; }],
    ['wrong API version', (o: any) => { o.apiVersion = 'v1'; }],
    ['existing resource UID', (o: any) => { o.metadata.uid = 'existing'; }],
    ['existing resource version', (o: any) => { o.metadata.resourceVersion = '12'; }],
    ['server status', (o: any) => { o.status = {}; }],
  ])('rejects %s before submission', (_name, edit) => {
    const object = parse(original);edit(object);
    expect(() => validateNewResource(stringify(object), deployment)).toThrow();
  });
  it('rejects multiple documents, duplicate keys and malformed YAML', () => {
    for (const yaml of [original + '\n---\n' + original, original + '\nspec: {}', 'metadata: [']) expect(() => validateNewResource(yaml, deployment)).toThrow();
  });
  it('rejects namespace on cluster-scoped objects', () => {
    expect(() => validateNewResource('apiVersion: v1\nkind: Namespace\nmetadata:\n  name: team\n  namespace: other', resourceType('Namespace'))).toThrow('cluster-scoped');
  });
});
