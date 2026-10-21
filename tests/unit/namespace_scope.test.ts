import { describe, expect, it } from 'vitest';
import { namespaceNames, namespaceScope, inNamespaceScope, namespaceScopeLabel, defaultNamespace } from '../../src/core/resources/namespace_scope';
import { namespaceIsOutsideScope } from '../../src/core/resources/resource_types';
import { compareStatusFirst } from '../../src/core/resources/resource_sort';
import { useClusterStore } from '../../src/state/cluster_store';

describe('Global namespace selection', () => {
  it('canonicalizes selections, keeps single/all compatible and includes cluster-scoped objects', () => {
    const scope = namespaceScope(['beta', 'alpha', 'beta']);
    expect(scope).toBe('["alpha","beta"]');
    expect(namespaceNames(scope)).toEqual(['alpha', 'beta']);
    expect(namespaceScope(['alpha'])).toBe('alpha');
    expect(namespaceScope(null)).toBe('all');
    expect(inNamespaceScope(scope, 'alpha')).toBe(true);
    expect(inNamespaceScope(scope, 'outside')).toBe(false);
    expect(inNamespaceScope(scope, undefined)).toBe(true);
    expect(inNamespaceScope('all', 'outside')).toBe(true);
    expect(namespaceScopeLabel(scope)).toBe('alpha, beta');
    expect(defaultNamespace(scope)).toBe('alpha');
    expect(namespaceIsOutsideScope('beta', scope, 'watch')).toBe(false);
    expect(namespaceIsOutsideScope('outside', scope, 'watch')).toBe(true);
  });
  it('resets namespace selection on cluster switches', () => {
    const store = useClusterStore.getState();
    store.selectNamespace(namespaceScope(['alpha', 'beta']));
    store.selectContext('another');
    expect(useClusterStore.getState().selectedNamespace).toBe('all');
  });
  it('prioritizes any observed status while preserving every row, including unfamiliar statuses', () => {
    const statuses = ['Running', 'Pending', 'Completed', 'CrashLoopBackOff', 'Failed', undefined, 'OperatorReconciling'];
    for (const preferred of statuses.map(status => status || '—')) {
      const sorted = statuses.map(status => ({ status })).sort((left, right) => compareStatusFirst(left.status, right.status, preferred));
      expect(sorted[0].status || '—').toBe(preferred);
      expect(sorted).toHaveLength(statuses.length);
    }
  });
});
