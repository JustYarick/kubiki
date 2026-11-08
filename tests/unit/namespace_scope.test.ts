import { describe, expect, it } from 'vitest';
import { selectedFirst } from '../../src/core/utils/selected_first';
import { namespaceNames, namespaceScope, inNamespaceScope, namespaceScopeLabel, defaultNamespace } from '../../src/core/resources/namespace_scope';
import { namespaceIsOutsideScope } from '../../src/core/resources/resource_types';
import { compareRows, statusChoices, statusOrder, type SortKey } from '../../src/core/resources/resource_sort';
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
    const key: SortKey = { columnId: 'status', direction: 'asc', statusFirst: 'Running' };
    for (const preferred of statuses.map(status => status || '—')) {
      const sorted = statuses.map(status => ({ status })).sort((left, right) => compareRows(left as any, right as any, [{ ...key, statusFirst: preferred }], (_sortKey, item) => (item as any).status));
      expect(sorted[0].status || '—').toBe(preferred);
      expect(sorted).toHaveLength(statuses.length);
    }
  });
  it('orders statuses by severity and ranks the preferred one first', () => {
    expect(statusChoices(['Failed', 'Running', 'Pending'])).toEqual(['Running', 'Pending', 'Failed']);
    expect(statusOrder('Running', 'Pending')).toBeGreaterThan(statusOrder('Pending', 'Pending'));
    expect(statusOrder('Pending', 'Pending')).toBe(-1);
  });
  it('floats selected namespaces to top and sinks deselected namespaces back to natural sorted position', () => {
    const all = ['cert-manager', 'default', 'kube-node-lease', 'kube-public', 'kube-system', 'monitoring'];

    // Initially none selected
    let selected: string[] = [];
    let choices = selectedFirst(all, (ns: string) => selected.includes(ns));
    expect(choices).toEqual(all);

    // Select 'monitoring': floats to top
    selected = ['monitoring'];
    choices = selectedFirst(all, (ns: string) => selected.includes(ns));
    expect(choices[0]).toBe('monitoring');
    expect(choices.slice(1)).toEqual(['cert-manager', 'default', 'kube-node-lease', 'kube-public', 'kube-system']);

    // Select 'default' as well: both float to top preserving relative order
    selected = ['default', 'monitoring'];
    choices = selectedFirst(all, (ns: string) => selected.includes(ns));
    expect(choices.slice(0, 2)).toEqual(['default', 'monitoring']);
    expect(choices.slice(2)).toEqual(['cert-manager', 'kube-node-lease', 'kube-public', 'kube-system']);

    // Deselect 'monitoring': sinks back down to the end of the alphabetical list
    selected = ['default'];
    choices = selectedFirst(all, (ns: string) => selected.includes(ns));
    expect(choices[0]).toBe('default');
    expect(choices[choices.length - 1]).toBe('monitoring');
  });
});
