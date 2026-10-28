export interface ColumnFilter { include: string[]; exclude: string[] }
export type ColumnFilters = Record<string, ColumnFilter>;
export const EMPTY_COLUMN_FILTER: ColumnFilter = { include: [], exclude: [] };

/** Include values are OR'ed; exclusions always veto a value. */
export function matchesColumnFilter(value: string | undefined, filter: ColumnFilter): boolean {
  const normalized = value == null || value === '' ? '—' : value;
  return !filter.exclude.includes(normalized) && (!filter.include.length || filter.include.includes(normalized));
}

export function cycleColumnFilter(filter: ColumnFilter, value: string): ColumnFilter {
  if (filter.include.includes(value)) return { include: filter.include.filter(entry => entry !== value), exclude: [...filter.exclude, value] };
  if (filter.exclude.includes(value)) return { ...filter, exclude: filter.exclude.filter(entry => entry !== value) };
  return { ...filter, include: [...filter.include, value] };
}

export function columnFilterCount(filter: ColumnFilter): number { return filter.include.length + filter.exclude.length; }
