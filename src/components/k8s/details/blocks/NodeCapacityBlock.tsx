import { Cpu, HardDrive, Layers, Server, ShieldAlert, Activity } from 'lucide-react';
import type { ResourceItem } from '../../../../types/k8s';
import { useResourceStore } from '../../../../state/resource_store';
import { quantity, cpuText, memoryText } from '../../../../core/resources/quantities';

interface NodeCapacityBlockProps {
  item: ResourceItem;
}

export function NodeCapacityBlock({ item }: NodeCapacityBlockProps) {
  const resources = useResourceStore((s) => s.resources);
  const raw = item.raw ?? {};
  const status = raw.status ?? item.statusRaw ?? {};
  const spec = raw.spec ?? item.spec ?? {};

  const capacity = status.capacity ?? {};
  const allocatable = status.allocatable ?? {};
  const nodeInfo = status.nodeInfo ?? {};
  const addresses: Array<{ type: string; address: string }> = status.addresses ?? [];
  const taints: Array<{ key: string; value?: string; effect: string }> = spec.taints ?? [];

  // Find all pods scheduled on this node
  const podsOnNode = [...resources.Pod.values()].filter(
    (p) => p.node === item.name || (p.raw as any)?.spec?.nodeName === item.name
  );

  const internalIp = addresses.find((a) => a.type === 'InternalIP')?.address ?? item.nodeIp ?? item.ip;
  const externalIp = addresses.find((a) => a.type === 'ExternalIP')?.address;
  const hostname = addresses.find((a) => a.type === 'Hostname')?.address ?? item.name;

  return (
    <div className="details-stack">
      {/* Node Capacity & Allocatable */}
      <section aria-label="Node capacity and allocatable resources" className="details-section">
        <div className="details-section-heading bg-[var(--bg-secondary)] border-b border-[var(--border-default)] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Activity size="calc(13px * var(--ui-factor))" className="text-[var(--accent)]" />
            <span className="text-xs font-semibold text-[var(--text-primary)]">Capacity & Allocatable</span>
          </div>
          <span className="text-[length:calc(10px*var(--ui-factor))] text-[var(--text-muted)] font-mono">
            {podsOnNode.length} Pods / {allocatable.pods ?? capacity.pods ?? '—'} allocatable
          </span>
        </div>

        <div className="p-2 grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, calc(260px * var(--ui-factor))), 1fr))' }}>
          {/* CPU */}
          <div className="p-2.5 rounded bg-[var(--bg-secondary)] border border-[var(--border-subtle)]">
            <div className="flex items-center justify-between text-xs mb-1.5">
              <span className="flex items-center gap-1.5 font-medium text-[var(--text-primary)]">
                <Cpu size="calc(12px * var(--ui-factor))" className="text-[var(--accent)]" />
                CPU Cores
              </span>
              <span className="font-mono text-emerald-400 font-semibold">{cpuText(quantity(allocatable.cpu ?? capacity.cpu))}</span>
            </div>
            <div className="text-[length:calc(10px*var(--ui-factor))] text-[var(--text-muted)] flex justify-between">
              <span>Allocatable: <strong className="font-mono text-[var(--text-secondary)]">{cpuText(quantity(allocatable.cpu))}</strong></span>
              <span>Total: <strong className="font-mono text-[var(--text-secondary)]">{cpuText(quantity(capacity.cpu))}</strong></span>
            </div>
          </div>

          {/* Memory */}
          <div className="p-2.5 rounded bg-[var(--bg-secondary)] border border-[var(--border-subtle)]">
            <div className="flex items-center justify-between text-xs mb-1.5">
              <span className="flex items-center gap-1.5 font-medium text-[var(--text-primary)]">
                <HardDrive size="calc(12px * var(--ui-factor))" className="text-[var(--accent)]" />
                Memory
              </span>
              <span className="font-mono text-emerald-400 font-semibold">{memoryText(quantity(allocatable.memory ?? capacity.memory))}</span>
            </div>
            <div className="text-[length:calc(10px*var(--ui-factor))] text-[var(--text-muted)] flex justify-between">
              <span>Allocatable: <strong className="font-mono text-[var(--text-secondary)]">{memoryText(quantity(allocatable.memory))}</strong></span>
              <span>Total: <strong className="font-mono text-[var(--text-secondary)]">{memoryText(quantity(capacity.memory))}</strong></span>
            </div>
          </div>

          {/* Pods */}
          <div className="p-2.5 rounded bg-[var(--bg-secondary)] border border-[var(--border-subtle)]">
            <div className="flex items-center justify-between text-xs mb-1.5">
              <span className="flex items-center gap-1.5 font-medium text-[var(--text-primary)]">
                <Layers size="calc(12px * var(--ui-factor))" className="text-[var(--accent)]" />
                Pods Capacity
              </span>
              <span className="font-mono text-emerald-400 font-semibold">{podsOnNode.length} / {allocatable.pods ?? capacity.pods ?? '—'}</span>
            </div>
            <div className="text-[length:calc(10px*var(--ui-factor))] text-[var(--text-muted)] flex justify-between">
              <span>Allocatable: <strong className="font-mono text-[var(--text-secondary)]">{allocatable.pods ?? '—'}</strong></span>
              <span>Total: <strong className="font-mono text-[var(--text-secondary)]">{capacity.pods ?? '—'}</strong></span>
            </div>
          </div>
        </div>
      </section>

      {/* System Information */}
      <section aria-label="Node system information" className="details-section">
        <div className="details-section-heading bg-[var(--bg-secondary)] border-b border-[var(--border-default)] flex items-center gap-2">
          <Server size="calc(13px * var(--ui-factor))" className="text-[var(--accent)]" />
          <span className="text-xs font-semibold text-[var(--text-primary)]">System Information</span>
        </div>
        <div className="p-2">
          <dl className="details-properties">
            <dt className="text-[var(--text-secondary)]">Internal IP</dt>
            <dd className="font-mono text-[var(--text-primary)]">{internalIp ?? '—'}</dd>

            {externalIp && (
              <>
                <dt className="text-[var(--text-secondary)]">External IP</dt>
                <dd className="font-mono text-[var(--text-primary)]">{externalIp}</dd>
              </>
            )}

            <dt className="text-[var(--text-secondary)]">Hostname</dt>
            <dd className="font-mono text-[var(--text-primary)]">{hostname}</dd>

            <dt className="text-[var(--text-secondary)]">Kubelet Version</dt>
            <dd className="font-mono text-[var(--text-primary)]">{nodeInfo.kubeletVersion ?? item.nodeVersion ?? '—'}</dd>

            <dt className="text-[var(--text-secondary)]">Container Runtime</dt>
            <dd className="font-mono text-[var(--text-primary)]">{nodeInfo.containerRuntimeVersion ?? '—'}</dd>

            <dt className="text-[var(--text-secondary)]">OS Image</dt>
            <dd className="font-mono text-[var(--text-primary)]">{nodeInfo.osImage ?? item.nodeOs ?? '—'}</dd>

            <dt className="text-[var(--text-secondary)]">Kernel Version</dt>
            <dd className="font-mono text-[var(--text-primary)]">{nodeInfo.kernelVersion ?? '—'}</dd>

            <dt className="text-[var(--text-secondary)]">Architecture</dt>
            <dd className="font-mono text-[var(--text-primary)]">{nodeInfo.architecture ?? '—'}</dd>
          </dl>
        </div>
      </section>

      {/* Taints & Tolerations */}
      <section aria-label="Node taints" className="details-section">
        <div className="details-section-heading bg-[var(--bg-secondary)] border-b border-[var(--border-default)] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ShieldAlert size="calc(13px * var(--ui-factor))" className="text-amber-400" />
            <span className="text-xs font-semibold text-[var(--text-primary)]">Taints ({taints.length})</span>
          </div>
        </div>
        <div className="p-2">
          {taints.length === 0 ? (
            <div className="text-xs text-[var(--text-muted)] italic">No taints set on this node (all pods tolerated).</div>
          ) : (
            <div className="space-y-1.5">
              {taints.map((t, i) => (
                <div key={i} className="flex items-center justify-between gap-2 p-2 rounded bg-[var(--bg-secondary)] border border-[var(--border-subtle)] text-xs">
                  <div className="flex items-center gap-2 min-w-0 font-mono">
                    <span className="text-[var(--text-primary)] font-semibold">{t.key}</span>
                    {t.value !== undefined && <span className="text-[var(--text-muted)]">={t.value}</span>}
                  </div>
                  <span className="px-1.5 py-0.5 rounded text-[length:calc(10px*var(--ui-factor))] font-mono font-medium bg-amber-500/10 text-amber-400 border border-amber-500/20">
                    {t.effect}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>


    </div>
  );
}
