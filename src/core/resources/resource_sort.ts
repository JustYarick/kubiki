import type { ResourceItem } from '../../types/k8s';
import type { ResourceIssue } from './diagnostics';

/**
 * Multi-column sorting.
 *
 * The first clicked column is the outer grouping: clicking Status and then
 * Ready splits the rows into status groups and orders each group by Ready.
 * Status sorts by a preferred status that cycles through the values present in
 * the data; every other column cycles descending → ascending → removed.
 */

export interface SortKey {
  columnId: string;
  direction: 'asc' | 'desc';
  /** Preferred status for the Status column — the status that comes first. */
  statusFirst?: string;
}

/** Canonical severity order used to rank the remaining statuses. */
const STATUS_SEVERITY = ['Running', 'Ready', 'Succeeded', 'Completed', 'Pending', 'Terminating', 'Error', 'Failed', 'CrashLoopBackOff', 'Unknown'];

export function statusRank(status: string | undefined): number {
  const value = status || '—';
  const index = STATUS_SEVERITY.indexOf(value);
  return index === -1 ? STATUS_SEVERITY.length : index;
}

/** Statuses present in the data, ordered by severity. */
export function statusChoices(values: readonly (string | undefined)[]): string[] {
  const unique = new Map<string, number>();
  for (const value of values) {
    const status = value || '—';
    if (!unique.has(status)) unique.set(status, statusRank(status));
  }
  return [...unique.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).map(([status]) => status);
}

/** Rank of a status inside the sort: the preferred one first, the rest by severity. */
export function statusOrder(status: string | undefined, preferred: string | undefined): number {
  const value = status || '—';
  if (preferred && value === preferred) return -1;
  return statusRank(value);
}

export function issuePriority(issues: readonly ResourceIssue[]): number {
  return issues.some((issue) => issue.severity === 'error') ? 2 : issues.length ? 1 : 0;
}

export function fastCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Unknown timestamps always go last; compare actual instants, never the formatted age text. */
export function compareCreation(a: ResourceItem, b: ResourceItem, direction: 1 | -1): number {
  const time = (item: ResourceItem) => {
    const value = item.creationTimestamp ?? item.raw?.metadata?.creationTimestamp ?? item.metadata?.creationTimestamp;
    return typeof value === 'string' ? Date.parse(value) : NaN;
  };
  const left = time(a); const right = time(b);
  if (Number.isNaN(left) || Number.isNaN(right)) {
    if (Number.isNaN(left) !== Number.isNaN(right)) return Number.isNaN(left) ? 1 : -1;
  } else if (left !== right) return (left - right) * direction;
  return fastCompare(a.name, b.name) || fastCompare(a.uid, b.uid);
}

/** Compare two cell values: numbers numerically, everything else as text. */
export function compareValues(left: string, right: string): number {
  const numeric = /^-?\d+(\.\d+)?$/.test(left) && /^-?\d+(\.\d+)?$/.test(right);
  if (numeric) {
    const a = Number(left); const b = Number(right);
    return a === b ? 0 : a < b ? -1 : 1;
  }
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * Compare two rows through the sort hierarchy.
 *
 * Keys are evaluated in click order: the first key groups the rows, later keys
 * order each group.
 */
export function compareRows(
  a: ResourceItem,
  b: ResourceItem,
  keys: readonly SortKey[],
  value: (key: SortKey, item: ResourceItem) => string | undefined,
): number {
  for (const key of keys) {
    const left = value(key, a);
    const right = value(key, b);
    if (key.statusFirst !== undefined) {
      const order = statusOrder(left, key.statusFirst) - statusOrder(right, key.statusFirst);
      if (order !== 0) return order;
      continue;
    }
    if (left === right) continue;
    const cmp = compareValues(left ?? '', right ?? '');
    if (cmp !== 0) return key.direction === 'asc' ? cmp : -cmp;
  }
  return 0;
}
