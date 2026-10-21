import { useMemo, useState } from 'react';
import { ArrowRight, Link2, RotateCw } from 'lucide-react';
import type { ResourceItem } from '../../../../types/k8s';
import { useResourceStore } from '../../../../state/resource_store';
import { useClusterStore } from '../../../../state/cluster_store';
import { k8s } from '../../../../providers/k8s_provider';
import { stringify } from 'yaml';
import { resourceConsumers } from '../../../../core/resources/consumers';
import { ResourceKindBadge } from '../../ResourceKindBadge';
import { Button } from '../../../ui/Button';
import { ConfirmDialog } from '../../../dialogs/ActionDialogs';
import { toast } from '../../../../state/notifications_store';

interface UsedByListProps {
  item: ResourceItem;
  onNavigate: (item: ResourceItem) => void;
}

export function UsedByList({ item, onNavigate }: UsedByListProps) {
  const resources = useResourceStore((s) => s.resources);
  const consumers = useMemo(() => resourceConsumers(resources, item), [resources, item]);
  const isBinding = item.kind === 'RoleBinding' || item.kind === 'ClusterRoleBinding';
  const [limit, setLimit] = useState(100);

  if (consumers.length === 0) {
    return (
      <section aria-label="Used by" className="details-section">
        <div className="details-section-heading text-[length:calc(11px*var(--ui-factor))] font-medium text-[var(--text-secondary)] bg-[var(--bg-secondary)] flex items-center justify-between">
          <span className="flex items-center gap-1.5">
            <Link2 size="calc(12px * var(--ui-factor))" />
            Used by (0 consumers)
          </span>
        </div>
        <div className="p-2 text-xs text-[var(--text-muted)]">
          {isBinding
            ? `No supported subjects are declared in this ${item.kind}.`
            : `No references to this ${item.kind} were found in the loaded resources. References outside the loaded scope may still exist.`}
        </div>
      </section>
    );
  }

  const [confirmRestart, setConfirmRestart] = useState(false);
  const restartable = useMemo(
    () => consumers.filter((c) => c.resource && ['Deployment', 'StatefulSet', 'DaemonSet'].includes(c.resource.kind)),
    [consumers]
  );

  const doRestartConsumers = async () => {
    const currentContext = useClusterStore.getState().currentContext;
    if (!currentContext && !k8s.demo) {
      toast.error('No active cluster context');
      return;
    }
    const timestamp = new Date().toISOString();
    let count = 0;
    for (const consumer of restartable) {
      const res = consumer.resource!;
      const raw = JSON.parse(JSON.stringify(res.raw ?? {}));
      raw.spec = raw.spec ?? {};
      raw.spec.template = raw.spec.template ?? {};
      raw.spec.template.metadata = raw.spec.template.metadata ?? {};
      raw.spec.template.metadata.annotations = raw.spec.template.metadata.annotations ?? {};
      raw.spec.template.metadata.annotations['kubectl.kubernetes.io/restartedAt'] = timestamp;

      try {
        if (k8s.demo) {
          useResourceStore.getState().updateItem(res.kind, res.uid, { ...res, raw });
          count++;
        } else {
          await k8s.applyManifest(currentContext!, stringify(raw), res);
          count++;
        }
      } catch (err: any) {
        if (err?.code === 'cancelled') {
          toast.info(`Restart cancelled for ${res.name}`);
          break;
        } else {
          toast.error(`Failed to restart ${res.name}`, String(err?.message || err));
        }
      }
    }
    if (count > 0) {
      toast.success(`Rollout restart triggered for ${count} workload(s)`);
    }
  };

  const restartConsumers = () => {
    if (restartable.length === 0) {
      toast.info('No consuming Deployments, StatefulSets or DaemonSets found to restart');
      return;
    }
    setConfirmRestart(true);
  };

  return (
    <section aria-label="Used by" className="details-section">
      <div className="details-section-heading text-[length:calc(11px*var(--ui-factor))] font-medium text-[var(--text-secondary)] bg-[var(--bg-secondary)] flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-[var(--text-primary)]">
          <Link2 size="calc(12px * var(--ui-factor))" className="text-[var(--accent)]" />
          Used by ({consumers.length} {consumers.length === 1 ? 'consumer' : 'consumers'})
        </span>
        {item.kind === 'ConfigMap' && (
          <Button size="sm" onClick={restartConsumers} title="Trigger rollout restart on consuming workloads">
            <RotateCw size="calc(11px * var(--ui-factor))" />
            Restart consumers
          </Button>
        )}
      </div>

      <div className="p-2 space-y-1 bg-[var(--bg-canvas)]">
        <div className="text-[length:calc(10.5px*var(--ui-factor))] text-[var(--text-muted)] px-1 mb-1">
          {isBinding
            ? 'Subjects granted access by this binding. Users and groups are identities; ServiceAccounts open when loaded.'
            : item.kind === 'Namespace' ? 'Loaded resources in this namespace:'
              : `Resources that reference this ${item.kind} (modifying or deleting may affect them):`}
        </div>
        {consumers.slice(0, limit).map((consumer) => {
          const content = <>
            <ResourceKindBadge kind={consumer.kind} />
            <span className="details-resource-name" title={consumer.name}>
              {consumer.name}
            </span>
            <span className="details-resource-namespace">
              {consumer.namespace || (consumer.kind === 'User' || consumer.kind === 'Group' ? 'Identity' : 'cluster')}
            </span>
            {consumer.resource
              ? <ArrowRight aria-hidden="true" size="calc(11px * var(--ui-factor))" className="text-[var(--text-muted)] shrink-0" />
              : consumer.kind === 'ServiceAccount' && <span className="text-[var(--text-muted)] text-xs">Not loaded</span>}
          </>;
          return consumer.resource ? (
            <button
              type="button"
              key={consumer.key}
              onClick={() => onNavigate(consumer.resource!)}
              className="details-resource-row"
            >{content}</button>
          ) : (
            <div key={consumer.key} className="details-resource-row">{content}</div>
          );
        })}
        {consumers.length > limit && <Button size="sm" onClick={() => setLimit(value => value + 100)}>Show next 100</Button>}
      </div>

      <ConfirmDialog
        open={confirmRestart}
        title="Restart consuming workloads"
        confirmLabel="Restart"
        onClose={() => setConfirmRestart(false)}
        onConfirm={doRestartConsumers}
        message={
          <div>
            Trigger rolling restart for <strong className="font-mono text-[var(--text-primary)]">{restartable.length}</strong> consuming workload(s)?
            <ul className="mt-2 text-xs list-disc pl-4 font-mono space-y-0.5">
              {restartable.map((c) => (
                <li key={c.key}>{c.kind}/{c.name}</li>
              ))}
            </ul>
          </div>
        }
      />
    </section>
  );
}
