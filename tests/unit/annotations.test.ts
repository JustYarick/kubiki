import { describe, expect, it } from 'vitest';
import { annotationFields, lastAppliedSummary, parseAnnotationValue } from '../../src/core/resources/annotations';

describe('Annotation presentation', () => {
  it('retains the exact original JSON for copy while exposing structured fields', () => {
    const source = '{ "network": { "ip": "10.42.0.2" }, "ports": [80, 443] }';
    const value = parseAnnotationValue(source);
    expect(value.source).toBe(source);
    expect(annotationFields(value.structured!).fields).toEqual([
      { path: 'network.ip', value: '10.42.0.2' }, { path: 'ports[0]', value: '80' }, { path: 'ports[1]', value: '443' },
    ]);
  });
  it('shows ordinary strings, invalid JSON and multiline text without dropping information', () => {
    for (const source of ['42', 'true', '{invalid JSON', 'first line\nsecond line', '']) {
      expect(parseAnnotationValue(source)).toEqual({ source });
    }
  });
  it('handles null, booleans, zero and empty collections without object coercion', () => {
    const value = parseAnnotationValue({ replicas: 0, enabled: false, note: null, empty: {}, items: [] });
    expect(annotationFields(value.structured!).fields.map((row) => row.value)).toEqual(['0', 'false', 'null', '{}', '[]']);
    expect(value.source).not.toContain('[object Object]');
  });
  it('summarizes last-applied manifests without showing their entire configuration by default', () => {
    expect(lastAppliedSummary({ kind: 'Deployment', apiVersion: 'apps/v1', metadata: { name: 'web', namespace: 'backend' }, spec: { replicas: 0, template: { spec: { containers: [{ name: 'web', image: 'nginx:1.27' }] } } }, data: { password: 'hidden-from-summary' } })).toEqual([
      { path: 'Kind', value: 'Deployment' }, { path: 'API version', value: 'apps/v1' }, { path: 'Name', value: 'web' }, { path: 'Namespace', value: 'backend' }, { path: 'Replicas', value: '0' }, { path: 'Images', value: 'nginx:1.27' },
    ]);
  });
  it('limits structured previews and retains complete source for large annotations', () => {
    const value = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`key${index}`, index]));
    expect(annotationFields(value).fields).toHaveLength(80);
    expect(annotationFields(value).truncated).toBe(true);
    const source = JSON.stringify({ payload: 'x'.repeat(130 * 1024) });
    expect(parseAnnotationValue(source)).toEqual({ source });
  });
});
