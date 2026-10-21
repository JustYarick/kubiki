import { expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import { cleanYaml, restoreServerFields, sameYaml } from '../../src/core/resources/yaml_document';

const full = stringify({ apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'web', resourceVersion: '12', managedFields: [{ manager: 'kubectl' }] }, spec: { replicas: 1 }, status: { readyReplicas: 1 } });

it('projects clean YAML without mutating the full manifest and restores its server fields', () => {
  const clean = cleanYaml(full);
  expect(parse(clean).status).toBeUndefined();
  expect(parse(clean).metadata.managedFields).toBeUndefined();
  expect(parse(clean).metadata.resourceVersion).toBe('12');
  expect(sameYaml(restoreServerFields(clean, full), full)).toBe(true);
});

it('preserves real edits across repeated view switches without introducing false edits', () => {
  const edited = parse(cleanYaml(full)); edited.spec.replicas = 3;
  let draft = stringify(edited);
  for (let index = 0; index < 3; index++) {
    const restored = restoreServerFields(draft, full);
    expect(parse(restored).spec.replicas).toBe(3);
    expect(parse(restored).status.readyReplicas).toBe(1);
    draft = cleanYaml(restored);
  }
  expect(sameYaml(draft, cleanYaml(full))).toBe(false);
  expect(sameYaml(cleanYaml(restoreServerFields(cleanYaml(full), full)), cleanYaml(full))).toBe(true);
});

it('compares mapping contents independently of formatting and key order, retaining sequence order', () => {
  expect(sameYaml('a: 1\nb: [2, 3]\n', 'b:\n - 2\n - 3\na: 1')).toBe(true);
  expect(sameYaml('b: [2, 3]', 'b: [3, 2]')).toBe(false);
  expect(sameYaml('key: [', 'key: value')).toBe(false);
});
