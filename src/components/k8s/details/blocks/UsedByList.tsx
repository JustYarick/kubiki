import { restartManifest, resourceActionStep } from '../../../../providers/resource_actions';
import { useMemo, useState } from 'react';
import { ArrowRight, Link2, RotateCw } from 'lucide-react';
import type { ResourceItem } from '../../../../types/k8s';
import { useResourceStore } from '../../../../state/resource_store';
import { useClusterStore } from '../../../../state/cluster_store';
import { k8s } from '../../../../providers/k8s_provider';
import { resourceConsumers } from '../../../../core/resources/consumers';
import { resourceRef } from '../../../../core/resources/identity';
import { ResourceKindBadge } from '../../ResourceKindBadge';
import { Button } from '../../../ui/Button';
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
  const restartable = useMemo(
    () => consumers.filter((c) => c.resource && ['Deployment', 'StatefulSet', 'DaemonSet'].includes(c.resource.kind)),
    [consumers]
  );

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

  const doRestartConsumers = async () => {
    const currentContext = useClusterStore.getState().currentContext;
    if (!currentContext && !k8s.demo) {
      toast.error('No active cluster context');
      return;
    }
    const timestamp = new Date().toISOString();
    const restarted = restartable.map((consumer) => {
      const res = consumer.resource!;
      const raw = restartManifest(res, timestamp);
      return { res, raw };
    });

    if (k8s.demo) {
      for (const { res, raw } of restarted) useResourceStore.getState().updateItem(res.kind, res.uid, { ...res, raw });
      toast.success(`Rollout restart triggered for ${restarted.length} workload(s) (demo)`);
      return;
    }

    try {
      await k8s.applyBatch(resourceRef(currentContext!, item), restarted.map(({ res }) => resourceActionStep(currentContext!, res, { type: 'restart' })));
    } catch (err: any) {
      if (err?.code === 'cancelled') toast.info('Restart consumers cancelled');
      else toast.error('Failed to restart consumers', String(err?.message || err));
    }
  };

  const restartConsumers = () => {
    if (restartable.length === 0) {
      toast.info('No consuming Deployments, StatefulSets or DaemonSets found to restart');
      return;
    }
    void doRestartConsumers();
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
            <ResourceKindBadge kind={consumer.kind} apiVersion={consumer.resource?.apiVersion} />
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

    </section>
  );
}
