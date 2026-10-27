import { describe, it, expect, beforeEach } from 'vitest';
import { useTableViewStore } from '../../src/state/table_view_store';
import { useUiStore } from '../../src/state/ui_store';

describe('useTableViewStore', () => {
  beforeEach(() => {
    useTableViewStore.getState().resetAll();
  });

  it('stores and updates search query, sorts and column filters per resource kind', () => {
    const store = useTableViewStore.getState();
    store.update('kind:Pod', {
      searchQuery: 'nginx',
      sorts: [{ colId: 'name', desc: true }],
      columnFilters: { status: { include: new Set(['Running']), exclude: new Set() } },
    });

    const podView = useTableViewStore.getState().views['kind:Pod'];
    expect(podView).toBeDefined();
    expect(podView?.searchQuery).toBe('nginx');
    expect(podView?.sorts).toEqual([{ colId: 'name', desc: true }]);
    expect(podView?.columnFilters.status?.include?.has('Running')).toBe(true);

    // Other kinds remain unconfigured
    expect(useTableViewStore.getState().views['kind:Service']).toBeUndefined();
  });

  it('clears view by id and resets all views', () => {
    const store = useTableViewStore.getState();
    store.update('kind:Pod', { searchQuery: 'pod-search' });
    store.update('kind:Service', { searchQuery: 'svc-search' });

    expect(Object.keys(useTableViewStore.getState().views)).toHaveLength(2);

    store.clear('kind:Pod');
    expect(useTableViewStore.getState().views['kind:Pod']).toBeUndefined();
    expect(useTableViewStore.getState().views['kind:Service']).toBeDefined();

    store.resetAll();
    expect(Object.keys(useTableViewStore.getState().views)).toHaveLength(0);
  });
});

describe('useUiStore table layouts', () => {
  it('resets hidden columns, column widths, and column order via resetAllTableLayouts', () => {
    const ui = useUiStore.getState();
    ui.setHiddenColumns('Pod', ['age']);
    ui.setColumnOrder('Pod', ['age', 'name', 'status']);
    ui.setColumnWidth('Pod', 'name', 250);

    expect(useUiStore.getState().hiddenColumns.Pod).toEqual(['age']);
    expect(useUiStore.getState().columnOrder.Pod).toEqual(['age', 'name', 'status']);
    expect(useUiStore.getState().columnWidths['Pod:name']).toBe(250);

    ui.resetAllTableLayouts();

    expect(useUiStore.getState().hiddenColumns).toEqual({});
    expect(useUiStore.getState().columnOrder).toEqual({});
    expect(useUiStore.getState().columnWidths).toEqual({});
  });
});
