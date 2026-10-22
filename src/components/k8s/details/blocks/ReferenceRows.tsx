import type { ResourceItem } from '../../../../types/k8s';
import { ResourceKindBadge } from '../../ResourceKindBadge';

export interface ReferenceEntry {
  kind: string;
  name: string;
  namespace?: string;
  /** Loaded object: the row becomes a navigation target. */
  item?: ResourceItem;
  /** Shown instead of the namespace when the target is not loaded. */
  note?: string;
}

export interface ReferenceRowsProps {
  entries: ReferenceEntry[];
  onNavigate?: (item: ResourceItem) => void;
  empty?: React.ReactNode;
}

/**
 * Reference list shared by details panels.
 *
 * Every row carries the kind badge, the name and the namespace, and becomes a
 * link as soon as the referenced object is part of the loaded snapshot.
 */
export function ReferenceRows({ entries, onNavigate, empty }: ReferenceRowsProps) {
  if (!entries.length) return empty ? <p className="details-caption">{empty}</p> : null;
  return (
    <div className="details-reference-rows">
      {entries.map((entry) => {
        const key = `${entry.kind}/${entry.namespace ?? 'cluster'}/${entry.name}`;
        const target = entry.item;
        const content = (
          <>
            <ResourceKindBadge kind={entry.kind} apiVersion={entry.item?.apiVersion} />
            <span className="details-resource-name" title={entry.name}>{entry.name}</span>
            <span className="details-resource-namespace">{entry.namespace ?? 'cluster'}</span>
          </>
        );
        if (target && onNavigate) {
          return (
            <button
              key={key}
              type="button"
              className="details-resource-row details-link"
              onClick={() => onNavigate(target)}
              title={`Open ${entry.kind}/${entry.name}`}
            >
              {content}
            </button>
          );
        }
        return (
          <div key={key} className="details-resource-row" title={`${entry.kind}/${entry.name} is not loaded`}>
            {content}
            {entry.note && <span className="details-resource-note">{entry.note}</span>}
          </div>
        );
      })}
    </div>
  );
}
