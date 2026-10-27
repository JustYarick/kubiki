import { useMemo } from 'react';
import type { ResourceItem, ResourceKind } from '../../../types/k8s';
import { useResourceStore } from '../../../state/resource_store';
import { inNamespaceScope } from '../../../core/resources/namespace_scope';
import { resourceIssues } from '../../../core/resources/diagnostics';
import { compareCreation, compareRows, fastCompare, issuePriority, statusChoices, type SortKey } from '../../../core/resources/resource_sort';
import type { ColumnDef } from './columns';

interface TableModelOptions {
  resources: Record<string, Map<string, ResourceItem>>;
  effectiveKind: ResourceKind;
  tableColumns: ColumnDef[];
  selectedNamespace: string;
  searchQuery: string;
  searchRegex: boolean;
  columnFilters: Record<string, string[]>;
  sorts: SortKey[];
  hiddenColumns: Record<string, string[]>;
  columnOrder: Record<string, string[]>;
  isConnected: boolean;
  isLoading: boolean;
  activeFilterColumnId?: string | null;
}
export function useResourceTableModel({ resources, effectiveKind, tableColumns, selectedNamespace, searchQuery, searchRegex, columnFilters, sorts, hiddenColumns, columnOrder, isConnected, isLoading, activeFilterColumnId }: TableModelOptions) {
  const kindResources = resources[effectiveKind];
  const allItems = useMemo(() => Array.from(kindResources?.values() ?? []), [kindResources]);
  const namespaceScopedItems = useMemo(
    () => (selectedNamespace === 'all' ? allItems : allItems.filter((item) => inNamespaceScope(selectedNamespace, item.namespace))),
    [allItems, selectedNamespace]
  );
  const podsCurrent = useResourceStore((s) => s.syncMode !== 'watch' || s.watchStates.Pod?.phase === 'live');
  const podError = useResourceStore((state) => state.loadErrors.Pod);
  const issueRanks = useMemo(() => {
    const ranks = new Map<string, number>();
    if (!sorts.some((key) => key.columnId === '__issues')) return ranks;
    const podsByNamespace = new Map<string | undefined, ResourceItem[]>();
    if (effectiveKind === 'Service') for (const pod of resources.Pod.values()) {
      if (!podsByNamespace.has(pod.namespace)) podsByNamespace.set(pod.namespace, []);
      podsByNamespace.get(pod.namespace)!.push(pod);
    }
    const storageClasses = new Map([...resources.StorageClass.values()].map((entry) => [entry.name, entry]));
    const now = Date.now();
    for (const item of allItems) {
      const storageClassName = item.spec?.storageClassName ?? item.storageClass;
      ranks.set(item.uid, issuePriority(resourceIssues(item, {
        now, pods: podsByNamespace.get(item.namespace) ?? [], podsLoaded: isConnected && !isLoading && podsCurrent && !podError,
        storageClass: typeof storageClassName === 'string' ? storageClasses.get(storageClassName) : undefined,
      })));
    }
    return ranks;
  }, [allItems, effectiveKind, sorts, resources.Pod, resources.StorageClass, isConnected, isLoading, podsCurrent, podError]);

  /** Values of one column with their occurrence counts — the filter popup lists them. */
  const columnValues = useMemo(() => {
    const map = new Map<string, Map<string, number>>();
    // Count values over the namespace + search scoped set so the popup only offers
    // values that are actually present in the current result set (not stale ones).
    let list = namespaceScopedItems;
    const q = searchQuery.trim();
    if (q) {
      if (searchRegex) {
        try {
          const rx = new RegExp(q, 'i');
          list = list.filter((item) => rx.test(item.name) || (item.namespace && rx.test(item.namespace)));
        } catch {
          list = [];
        }
      } else {
        const qLower = q.toLowerCase();
        list = list.filter((item) => item.name.toLowerCase().includes(qLower) || (item.namespace ?? '').toLowerCase().includes(qLower));
      }
    }
    const activeFilters = Object.entries(columnFilters).filter(([, values]) => values.length > 0);
    const columnsToCount = activeFilterColumnId === undefined
      ? tableColumns
      : tableColumns.filter((c) => c.id === 'status' || c.id === activeFilterColumnId);
    for (const column of columnsToCount) {
      const counts = new Map<string, number>();
      // Apply every other column's filter so the offered values match the rows the
      // user can actually reach — but skip this column's own filter, otherwise its
      // remaining values would disappear as soon as one value is selected.
      let candidates = list;
      for (const [colId, values] of activeFilters) {
        if (colId === column.id) continue;
        const filterColumn = tableColumns.find((c) => c.id === colId);
        if (!filterColumn) continue;
        const allowed = new Set(values);
        candidates = candidates.filter((item) => allowed.has(filterColumn.get(item) ?? '—'));
      }
      for (const item of candidates) {
        const value = column.get(item);
        if (value === undefined || value === '') continue;
        counts.set(value, (counts.get(value) ?? 0) + 1);
      }
      map.set(column.id, counts);
    }
    return map;
  }, [namespaceScopedItems, tableColumns, searchQuery, searchRegex, columnFilters, activeFilterColumnId]);

  const statusValues = useMemo(() => {
    const column = tableColumns.find((c) => c.id === 'status');
    if (!column) return [];
    return statusChoices([...(columnValues.get('status')?.keys() ?? [])]);
  }, [tableColumns, columnValues]);

  const rows = useMemo(() => {
    let list = namespaceScopedItems;
    const q = searchQuery.trim();
    if (q) {
      if (searchRegex) {
        try {
          const rx = new RegExp(q, 'i');
          list = list.filter((i) => rx.test(i.name) || (i.namespace && rx.test(i.namespace)));
        } catch {
          list = [];
        }
      } else {
        const qLower = q.toLowerCase();
        list = list.filter((i) => {
          if (i.name.toLowerCase().includes(qLower) || (i.namespace ?? '').toLowerCase().includes(qLower)) return true;
          if (effectiveKind === 'CustomResourceDefinition') {
            const spec = (i.raw as any)?.spec ?? i.spec;
            if (spec?.group && String(spec.group).toLowerCase().includes(qLower)) return true;
            if (spec?.names?.kind && String(spec.names.kind).toLowerCase().includes(qLower)) return true;
            if (spec?.names?.plural && String(spec.names.plural).toLowerCase().includes(qLower)) return true;
            if (spec?.names?.singular && String(spec.names.singular).toLowerCase().includes(qLower)) return true;
            if (Array.isArray(spec?.names?.shortNames) && spec.names.shortNames.some((s: string) => String(s).toLowerCase().includes(qLower))) return true;
          }
          return false;
        });
      }
    }
    // Column filters: OR inside one column, AND across columns.
    const activeFilters = Object.entries(columnFilters).filter(([, values]) => values.length > 0);
    for (const [columnId, values] of activeFilters) {
      const column = tableColumns.find((c) => c.id === columnId);
      if (!column) continue;
      const allowed = new Set(values);
      list = list.filter((item) => allowed.has(column.get(item) ?? '—'));
    }

    const hidden = new Set(hiddenColumns[effectiveKind] ?? []);
    const visible = tableColumns.filter((c) => c.id === 'name' || !hidden.has(c.id));
    // Saved order wins; columns the user has never moved keep their natural place.
    const saved = columnOrder[effectiveKind] ?? [];
    const cols = visible.length
      ? [...visible].sort((a, b) => {
          const ai = saved.indexOf(a.id);
          const bi = saved.indexOf(b.id);
          if (ai === -1 && bi === -1) return 0;
          if (ai === -1) return 1;
          if (bi === -1) return -1;
          return ai - bi;
        })
      : visible;
    if (sorts.length) {
      const value = (key: SortKey, item: ResourceItem): string | undefined =>
        tableColumns.find((column) => column.id === key.columnId)?.get(item);
      // Keys are evaluated in click order: the first key groups the rows, later keys order each group.
      list = [...list].sort((a, b) => {
        for (const key of sorts) {
          if (key.columnId === '__issues') {
            const diff = (issueRanks.get(b.uid) ?? 0) - (issueRanks.get(a.uid) ?? 0);
            if (diff !== 0) return diff;
            continue;
          }
          if (key.columnId === '__created' || key.columnId === 'age') {
            const diff = compareCreation(a, b, key.direction === 'asc' ? 1 : -1);
            if (diff !== 0) return diff;
            continue;
          }
          const diff = compareRows(a, b, [key], value);
          if (diff !== 0) return diff;
        }
        return (a.namespace && b.namespace && a.namespace !== b.namespace ? fastCompare(a.namespace, b.namespace) : 0) || fastCompare(a.name, b.name) || fastCompare(a.uid, b.uid);
      });
    } else {
      list = [...list].sort((a, b) => (a.namespace && b.namespace && a.namespace !== b.namespace ? fastCompare(a.namespace, b.namespace) : 0) || fastCompare(a.name, b.name) || fastCompare(a.uid, b.uid));
    }
    return { list, cols };
  }, [namespaceScopedItems, searchQuery, searchRegex, effectiveKind, sorts, hiddenColumns, columnFilters, issueRanks, tableColumns, columnOrder]);
  return { allItems, rows, columnValues, statusValues };
}
