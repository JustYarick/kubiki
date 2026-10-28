import { ContainerIndicators } from '../ContainerSelect';
import { podContainers } from '../../../core/resources/containers';
import type { ResourceItem } from '../../../types/k8s';
import type { ColumnDef } from './columns';
import { resourceIcon } from '../../../core/resource_icons';
import { kindTone } from '../../../core/perspectives';
import { parseApiVersion } from '../../../core/resources/resource_types';
import { customResourceType } from '../../../core/resources/custom_resource_types';
import { useWorkspaceStore } from '../../../state/workspace_store';
import { ResourceWarnings } from '../ResourceWarnings';
import { StatusBadge } from '../StatusBadge';
import { cx } from '../../../core/utils/cx';

/** Kind icon colored by the shared group palette — the same color as in the sidebar. */
function KindIcon({ item }: { item: ResourceItem }) {
  const Icon = resourceIcon(item.kind, item.apiVersion);
  const tone = kindTone(item.kind, item.apiVersion ? parseApiVersion(item.apiVersion).group : undefined);
  return <Icon size="calc(12px * var(--ui-factor))" className="shrink-0" style={{ color: tone.color }} aria-hidden="true" />;
}

export function CellValue({
  col,
  item,
}: {
  col: ColumnDef;
  item: ResourceItem;
}) {
  const v = col.get(item);
  if (v === undefined || v === '') return <span className="text-[var(--text-disabled)]">—</span>;
  if (col.hint && col.id !== 'name' && !col.podActivity) return <span title={col.hint} className="block truncate">{v}</span>;
  if (col.id === 'name') {
    if (item.kind === 'CustomResourceDefinition') {
      const crdType = customResourceType(item);
      if (crdType) {
        return (
          <span className="inline-flex min-w-0 items-center gap-2 max-w-full align-middle">
            <ResourceWarnings item={item} />
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                useWorkspaceStore.getState().openResourceList(crdType.key);
              }}
              className="min-w-0 truncate text-[var(--accent)] hover:underline text-left font-mono text-[length:calc(11.5px*var(--ui-factor))] font-medium cursor-pointer"
              title={`View ${crdType.plural} (${v})`}
            >
              {v}
            </button>
          </span>
        );
      }
    }
    return <span className="inline-flex min-w-0 items-center gap-2 max-w-full align-middle"><KindIcon item={item} /><ResourceWarnings item={item} /><span className="min-w-0 truncate text-[var(--text-primary)] font-mono text-[length:calc(11.5px*var(--ui-factor))] font-medium" title={v}>{v}</span></span>;
  }
  if (col.id === 'namespace') return <span className="text-[var(--text-secondary)]">{v}</span>;
  if (col.id === 'status' || col.id === 'conditions') return <StatusBadge status={v} />;

  if (col.id === 'pods') {
    const m = /^(\d+)\/(\d+)$/.exec(v);
    if (m) {
      const readyNum = Number(m[1]);
      const totalNum = Number(m[2]);
      const pct = totalNum > 0 ? Math.min(100, Math.round((readyNum / totalNum) * 100)) : 0;
      const isOk = readyNum === totalNum && totalNum > 0;
      const isZero = readyNum === 0 && totalNum > 0;
      const activity = col.podActivity?.(item);
      const hint = `${readyNum} ready / ${totalNum} total${activity ? ` · ${activity.pending} pending · ${activity.terminating} terminating` : ''}`;

      return (
        <div role="img" className="flex items-center gap-2 whitespace-nowrap" title={hint} aria-label={hint}>
          <div className="w-14 shrink-0 h-1.5 rounded-full bg-[var(--bg-surface)] overflow-hidden border border-[var(--border-subtle)] flex" aria-hidden="true">
            <div
              style={{ width: `${pct}%` }}
              className={cx(
                'h-full transition-all duration-300',
                isOk ? 'bg-[var(--status-ok)]' : isZero ? 'bg-[var(--status-danger)]' : 'bg-[var(--status-warn)]'
              )}
            />
          </div>
          <span
            className={cx(
              'font-mono text-[length:calc(11px*var(--ui-factor))] font-semibold tabular-nums',
              isOk ? 'text-[var(--status-ok)]' : isZero ? 'text-[var(--status-danger)]' : totalNum === 0 ? 'text-[var(--text-secondary)]' : 'text-[var(--status-warn)]'
            )}
          >
            {v}
          </span>
        </div>
      );
    }
    return <span className="font-mono text-[length:calc(11px*var(--ui-factor))]">{v}</span>;
  }

  if (col.id === 'replicas') return <span className="font-mono text-[length:calc(11px*var(--ui-factor))] tabular-nums text-[var(--text-primary)]">{v}</span>;

  if (col.id === 'containers') return <ContainerIndicators containers={item.containers ?? podContainers(item)} />;
  if (col.id === 'ready') {
    const m = /^(\d+)\/(\d+)$/.exec(v);
    const danger = m && m[1] !== m[2] && m[1] === '0';
    return <span className={cx('font-mono text-[length:calc(11px*var(--ui-factor))]', danger ? 'text-[var(--status-danger)]' : m && m[1] === m[2] ? 'text-[var(--status-ok)]' : 'text-[var(--text-primary)]')}>{v}</span>;
  }
  if (col.id === 'restarts') {
    const n = Number(v);
    return <span className={cx('font-mono text-[length:calc(11px*var(--ui-factor))]', n > 10 ? 'text-[var(--status-danger)]' : n > 0 ? 'text-[var(--status-warn)]' : 'text-[var(--text-secondary)]')}>{v}</span>;
  }
  if (col.id === 'age') return <span className="text-[var(--text-secondary)]">{v}</span>;
  return <span className="text-[var(--text-secondary)]">{v}</span>;
}
