import { useCallback } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { SortKey } from '../core/resources/resource_sort';
import type { ColumnFilters } from '../core/resources/column_filters';

export interface TableView {
  searchQuery: string;
  searchRegex: boolean;
  sorts: SortKey[];
  columnFilters: ColumnFilters;
}

const EMPTY: TableView = {
  searchQuery: '',
  searchRegex: false,
  sorts: [],
  columnFilters: {},
};

interface TableViews {
  views: Record<string, TableView>;
  update: (id: string, patch: Partial<TableView>) => void;
  clear: (id: string) => void;
  resetAll: () => void;
}

/** Table controls belong to their workspace tab / resource kind and persist across reloads and tab reopening. */
export const useTableViewStore = create<TableViews>()(
  persist(
    (set) => ({
      views: {},
      update: (id, patch) =>
        set((state) => ({
          views: {
            ...state.views,
            [id]: { ...EMPTY, ...state.views[id], ...patch },
          },
        })),
      clear: (id) =>
        set((state) => {
          const views = { ...state.views };
          delete views[id];
          return { views };
        }),
      resetAll: () => set({ views: {} }),
    }),
    {
      name: 'kubiki.table_views.v1',
    }
  )
);

export function useTableView(id: string) {
  const state = useTableViewStore((s) => s.views[id] ?? EMPTY);
  const setSearchQuery = useCallback(
    (searchQuery: string) => useTableViewStore.getState().update(id, { searchQuery }),
    [id]
  );
  const setSearchRegex = useCallback(
    (searchRegex: boolean) => useTableViewStore.getState().update(id, { searchRegex }),
    [id]
  );
  const setSorts = useCallback(
    (sorts: SortKey[] | ((prev: SortKey[]) => SortKey[])) => {
      const current = useTableViewStore.getState().views[id]?.sorts ?? EMPTY.sorts;
      const next = typeof sorts === 'function' ? sorts(current) : sorts;
      useTableViewStore.getState().update(id, { sorts: next });
    },
    [id]
  );
  const setColumnFilters = useCallback(
    (columnFilters: ColumnFilters | ((prev: ColumnFilters) => ColumnFilters)) => {
      const current = useTableViewStore.getState().views[id]?.columnFilters ?? EMPTY.columnFilters;
      const next = typeof columnFilters === 'function' ? columnFilters(current) : columnFilters;
      useTableViewStore.getState().update(id, { columnFilters: next });
    },
    [id]
  );

  return {
    ...state,
    setSearchQuery,
    setSearchRegex,
    setSorts,
    setColumnFilters,
  };
}
