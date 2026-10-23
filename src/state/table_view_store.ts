import { useCallback } from 'react';
import { create } from 'zustand';

interface TableView { searchQuery: string; searchRegex: boolean }
const EMPTY: TableView = { searchQuery: '', searchRegex: false };
interface TableViews {
  views: Record<string, TableView>;
  update: (id: string, patch: Partial<TableView>) => void;
  clear: (id: string) => void;
}
/** Table controls belong to their workspace tab, independently of the shared resource cache. */
export const useTableViewStore = create<TableViews>((set) => ({
  views: {},
  update: (id, patch) => set(state => ({ views: { ...state.views, [id]: { ...EMPTY, ...state.views[id], ...patch } } })),
  clear: (id) => set(state => { const views = { ...state.views }; delete views[id]; return { views }; }),
}));
export function useTableView(id: string) {
  const state = useTableViewStore(s => s.views[id] ?? EMPTY);
  const setSearchQuery = useCallback((searchQuery: string) => useTableViewStore.getState().update(id, { searchQuery }), [id]);
  const setSearchRegex = useCallback((searchRegex: boolean) => useTableViewStore.getState().update(id, { searchRegex }), [id]);
  return { ...state, setSearchQuery, setSearchRegex };
}
