import type { ResourceItem } from '../../types/k8s';
import type { ResourceIssue } from './diagnostics';

/** Every observed status is a valid preference; sorting never filters other rows out. */
export function compareStatusFirst(left: string | undefined, right: string | undefined, preferred: string): number {
  return Number((right || '—') === preferred) - Number((left || '—') === preferred)
    || (left || '—').localeCompare(right || '—');
}

export function issuePriority(issues: readonly ResourceIssue[]): number {
  return issues.some((issue) => issue.severity === 'error') ? 2 : issues.length ? 1 : 0;
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
  return a.name.localeCompare(b.name) || a.uid.localeCompare(b.uid);
}
