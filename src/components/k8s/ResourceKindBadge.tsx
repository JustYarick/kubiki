import { Boxes } from 'lucide-react';
import { KIND_ICONS, kindTone } from '../../core/perspectives';
import { parseApiVersion } from '../../core/resources/resource_types';
import { cx } from '../../core/utils/cx';
import type { ResourceKind } from '../../types/k8s';

/**
 * The badge color comes from the shared group palette — the same kind always
 * shows the same color in the sidebar, in tables, in the topology and here.
 */
export function ResourceKindBadge({ kind, apiVersion }: { kind: string; apiVersion?: string }) {
  const Icon = KIND_ICONS[kind as ResourceKind] ?? Boxes;
  const group = apiVersion ? parseApiVersion(apiVersion).group : undefined;
  const tone = kindTone(kind, group || undefined);
  return (
    <span
      data-resource-kind={kind}
      style={{ color: tone.color, backgroundColor: tone.bg, borderColor: tone.border }}
      className={cx(
        'inline-flex max-w-full items-center gap-1 rounded border px-1.5 py-0.5 text-[length:calc(10px*var(--ui-factor))] font-medium leading-none shrink-0',
      )}
      title={kind}
    >
      <Icon size="calc(11px * var(--ui-factor))" strokeWidth={1.8} className="shrink-0" />
      <span className="truncate">{kind}</span>
    </span>
  );
}
