import { Boxes } from 'lucide-react';
import { KIND_ICONS } from '../../core/perspectives';
import { cx } from '../../core/utils/cx';
import type { ResourceKind } from '../../types/k8s';

const KIND_COLORS: Record<ResourceKind, string> = {
  Pod: 'text-emerald-300 bg-emerald-500/15 border-emerald-400/40',
  Deployment: 'text-blue-300 bg-blue-500/20 border-blue-400/45',
  ReplicaSet: 'text-indigo-300 bg-indigo-500/20 border-indigo-400/45',
  StatefulSet: 'text-violet-300 bg-violet-500/20 border-violet-400/45',
  DaemonSet: 'text-purple-300 bg-purple-500/20 border-purple-400/45',
  Job: 'text-amber-300 bg-amber-500/15 border-amber-400/40',
  CronJob: 'text-yellow-300 bg-yellow-500/15 border-yellow-400/40',
  Service: 'text-cyan-300 bg-cyan-500/15 border-cyan-400/40',
  Ingress: 'text-teal-300 bg-teal-500/15 border-teal-400/40',
  ConfigMap: 'text-orange-300 bg-orange-500/15 border-orange-400/40',
  Secret: 'text-rose-300 bg-rose-500/15 border-rose-400/40',
  PersistentVolumeClaim: 'text-pink-300 bg-pink-500/15 border-pink-400/40',
  PersistentVolume: 'text-fuchsia-300 bg-fuchsia-500/15 border-fuchsia-400/40',
  StorageClass: 'text-lime-300 bg-lime-500/15 border-lime-400/40',
  Node: 'text-sky-300 bg-sky-500/15 border-sky-400/40',
  Namespace: 'text-violet-300 bg-violet-500/15 border-violet-400/40',
  Event: 'text-amber-300 bg-amber-500/15 border-amber-400/40',
  CustomResourceDefinition: 'text-purple-300 bg-purple-500/15 border-purple-400/40',
};

/** Color supplements the kind text and icon; it never carries meaning alone. */
export function ResourceKindBadge({ kind }: { kind: string }) {
  const Icon = KIND_ICONS[kind as ResourceKind] ?? Boxes;
  return (
    <span
      data-resource-kind={kind}
      className={cx(
        'inline-flex max-w-full items-center gap-1 rounded border px-1.5 py-0.5 text-[length:calc(10px*var(--ui-factor))] font-medium leading-none shrink-0',
        KIND_COLORS[kind as ResourceKind] ?? 'text-slate-300 bg-slate-500/15 border-slate-400/40',
      )}
      title={kind}
    >
      <Icon size="calc(11px * var(--ui-factor))" strokeWidth={1.8} className="shrink-0" />
      <span className="truncate">{kind}</span>
    </span>
  );
}
