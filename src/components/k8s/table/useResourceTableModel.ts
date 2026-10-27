import { useMemo } from 'react';
import type { ResourceItem, ResourceKind } from '../../../types/k8s';
import { useResourceStore } from '../../../state/resource_store';
import { inNamespaceScope } from '../../../core/resources/namespace_scope';
import { resourceIssues } from '../../../core/resources/diagnostics';
import { compareValues, statusOrder, fastCompare, issuePriority, statusChoices, type SortKey } from '../../../core/resources/resource_sort';
import { matchesColumnFilter, columnFilterCount, type ColumnFilters } from '../../../core/resources/column_filters';
import type { ColumnDef } from './columns';

interface TableModelOptions {
  resources: Record<string, Map<string, ResourceItem>>;
  effectiveKind: ResourceKind;
  tableColumns: ColumnDef[];
  selectedNamespace: string;
  searchQuery: string;
  searchRegex: boolean;
  columnFilters: ColumnFilters;
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
    if (!activeFilterColumnId) return map;
    const targetColumn = tableColumns.find((c) => c.id === activeFilterColumnId);
    if (!targetColumn) return map;

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
    const activeFilters = Object.entries(columnFilters).filter(([, filter]) => columnFilterCount(filter) > 0);
    const counts = new Map<string, number>();
    // Apply every other column's filter so the offered values match the rows the
    // user can actually reach — but skip this column's own filter, otherwise its
    // remaining values would disappear as soon as one value is selected.
    let candidates = list;
    for (const [colId, values] of activeFilters) {
      if (colId === targetColumn.id) continue;
      const filterColumn = tableColumns.find((c) => c.id === colId);
      if (!filterColumn) continue;
      candidates = candidates.filter((item) => matchesColumnFilter(filterColumn.get(item), values));
    }
    for (const item of candidates) {
      const value = targetColumn.get(item);
      const normalized = value == null || value === '' ? '—' : value;
      counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
    }
    map.set(targetColumn.id, counts);
    return map;
  }, [namespaceScopedItems, tableColumns, searchQuery, searchRegex, columnFilters, activeFilterColumnId]);

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
    const activeFilters = Object.entries(columnFilters).filter(([, filter]) => columnFilterCount(filter) > 0);
    for (const [columnId, values] of activeFilters) {
      const column = tableColumns.find((c) => c.id === columnId);
      if (!column) continue;
      list = list.filter((item) => matchesColumnFilter(column.get(item), values));
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
      // Pre-resolve columns for each sort key once before iterating rows
      const resolvedSorts = sorts.map((key) => {
        const column = tableColumns.find((c) => c.id === key.columnId);
        return { key, column };
      });

      // Pre-extract sort values for each row (Schwartzian transform)
      interface RowSortEntry {
        item: ResourceItem;
        sortValues: Array<number | string>;
        namespace: string;
        name: string;
        uid: string;
      }

      const entries: RowSortEntry[] = list.map((item) => {
        const sortValues: Array<number | string> = [];
        for (const { key, column } of resolvedSorts) {
          if (key.columnId === '__issues') {
            sortValues.push(issueRanks.get(item.uid) ?? 0);
          } else if (key.columnId === '__created' || key.columnId === 'age') {
            const rawTime = item.creationTimestamp ?? item.raw?.metadata?.creationTimestamp ?? item.metadata?.creationTimestamp;
            const parsed = typeof rawTime === 'string' ? Date.parse(rawTime) : NaN;
            sortValues.push(parsed);
          } else if (key.statusFirst !== undefined) {
            const val = column?.get(item);
            sortValues.push(statusOrder(val, key.statusFirst));
          } else {
            sortValues.push(column?.get(item) ?? '');
          }
        }
        return {
          item,
          sortValues,
          namespace: item.namespace ?? '',
          name: item.name,
          uid: item.uid,
        };
      });

      entries.sort((a, b) => {
        for (let i = 0; i < resolvedSorts.length; i++) {
          const { key } = resolvedSorts[i];
          const valA = a.sortValues[i];
          const valB = b.sortValues[i];

          if (key.columnId === '__issues') {
            const diff = (valB as number) - (valA as number);
            if (diff !== 0) return diff;
            continue;
          }
          if (key.columnId === '__created' || key.columnId === 'age') {
            const left = valA as number;
            const right = valB as number;
            const dir = key.direction === 'asc' ? 1 : -1;
            if (Number.isNaN(left) || Number.isNaN(right)) {
              if (Number.isNaN(left) !== Number.isNaN(right)) return Number.isNaN(left) ? 1 : -1;
            } else if (left !== right) {
              return (left - right) * dir;
            }
            continue;
          }
          if (key.statusFirst !== undefined) {
            const order = (valA as number) - (valB as number);
            if (order !== 0) return order;
            continue;
          }
          if (valA === valB) continue;
          const cmp = compareValues(valA as string, valB as string);
          if (cmp !== 0) return key.direction === 'asc' ? cmp : -cmp;
        }
        return (a.namespace && b.namespace && a.namespace !== b.namespace ? fastCompare(a.namespace, b.namespace) : 0) || fastCompare(a.name, b.name) || fastCompare(a.uid, b.uid);
      });

      list = entries.map((e) => e.item);
    } else {
      list = [...list].sort((a, b) => (a.namespace && b.namespace && a.namespace !== b.namespace ? fastCompare(a.namespace, b.namespace) : 0) || fastCompare(a.name, b.name) || fastCompare(a.uid, b.uid));
    }
    return { list, cols };
  }, [namespaceScopedItems, searchQuery, searchRegex, effectiveKind, sorts, hiddenColumns, columnFilters, issueRanks, tableColumns, columnOrder]);
  // Sort choices follow the actual filtered rows; the filter popup intentionally
  // ignores its own column's filter to keep other choices reachable.
  const statusValues = useMemo(() => {
    const column = tableColumns.find(c => c.id === 'status');
    return column ? statusChoices(rows.list.map(item => column.get(item))) : [];
  }, [rows.list, tableColumns]);
  return { allItems, rows, columnValues, statusValues };
}
