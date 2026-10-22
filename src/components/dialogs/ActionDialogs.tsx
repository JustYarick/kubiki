import { useEffect, useState } from 'react';
import { Layers, Minus, Plus, TriangleAlert } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { Input, Label } from '../ui/Input';
import { cx } from '../../core/utils/cx';
import type { ResourceItem } from '../../types/k8s';

/** Scale a workload (Deployment / StatefulSet / ReplicaSet / DaemonSet). */
export function ScaleDialog({
  item,
  onClose,
  onApply,
}: {
  item: ResourceItem | null;
  onClose: () => void;
  onApply: (replicas: number) => void;
}) {
  const current = Number(item?.ready?.split('/')[1] ?? item?.replicas ?? 1);
  const [replicas, setReplicas] = useState(current);

  useEffect(() => {
    if (item) setReplicas(Number(item.ready?.split('/')[1] ?? item.replicas ?? 1));
  }, [item?.uid]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!item) return null;
  const value = Math.max(0, Math.min(1000, replicas || 0));

  return (
    <Modal
      open
      onClose={onClose}
      width={440}
      title={
        <span className="flex items-center gap-2">
          <Layers size="calc(14px * var(--ui-factor))" className="text-[var(--accent)]" />
          <span>Scale {item.kind}</span>
        </span>
      }
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => { onApply(value); onClose(); }}>
            Scale to {value}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="rounded-[calc(6px*var(--ui-factor))] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3 flex items-center justify-between text-[length:calc(12px*var(--ui-factor))]">
          <div className="flex items-center gap-2 min-w-0">
            <span className="px-1.5 py-0.5 rounded font-mono font-medium text-[var(--text-primary)] bg-[var(--bg-secondary)] border border-[var(--border-subtle)] truncate">
              {item.name}
            </span>
            <span className="text-[var(--text-muted)] text-[length:calc(11px*var(--ui-factor))] font-mono truncate">
              {item.namespace || 'default'}
            </span>
          </div>
          <span className="text-[length:calc(11px*var(--ui-factor))] text-[var(--text-secondary)] shrink-0 font-medium">
            Current: {current}
          </span>
        </div>

        <div className="flex flex-col gap-2">
          <Label>Target Replicas</Label>
          <div className="flex items-center gap-2">
            <Button onClick={() => setReplicas(Math.max(0, replicas - 1))} className="!w-9 !px-0 justify-center">
              <Minus size="calc(13px * var(--ui-factor))" />
            </Button>
            <Input
              value={String(replicas)}
              onChange={(e) => {
                const n = Number(e.target.value.replace(/[^\d]/g, ''));
                setReplicas(Number.isNaN(n) ? 0 : n);
              }}
              className="flex-1 text-center font-mono font-medium"
            />
            <Button onClick={() => setReplicas(Math.min(1000, replicas + 1))} className="!w-9 !px-0 justify-center">
              <Plus size="calc(13px * var(--ui-factor))" />
            </Button>
          </div>
          <div className="flex gap-1.5 mt-1">
            {[0, 1, 2, 3, 5, 10].map((n) => (
              <Button
                key={n}
                size="sm"
                variant={replicas === n ? 'secondary' : 'ghost'}
                onClick={() => setReplicas(n)}
                className={cx('flex-1 !px-0 justify-center font-mono', replicas === n && '!bg-[var(--accent-subtle)] !text-[var(--accent)] !border-[var(--accent)]/40 font-semibold')}
              >
                {n}
              </Button>
            ))}
          </div>
        </div>

        {value === 0 && (
          <div className="rounded-[calc(6px*var(--ui-factor))] border border-[var(--status-warn)]/30 bg-[var(--status-warn)]/10 p-2.5 flex items-start gap-2.5 text-[length:calc(11px*var(--ui-factor))] text-[var(--status-warn)] leading-relaxed">
            <TriangleAlert size="calc(14px * var(--ui-factor))" className="shrink-0 mt-0.5" />
            <span>Scaling to 0 will remove all running pods from service and terminate active workloads.</span>
          </div>
        )}
      </div>
    </Modal>
  );
}
