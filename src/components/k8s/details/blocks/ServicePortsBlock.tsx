import { ArrowRightLeft, Copy, Globe, Network } from 'lucide-react';
import type { ResourceItem } from '../../../../types/k8s';
import { Button } from '../../../ui/Button';
import { toast } from '../../../../state/notifications_store';
import { useState } from 'react';
import { PFDialog } from '../../../dialogs/PFDialog';

interface ServicePortsBlockProps {
  service?: ResourceItem;
  item?: ResourceItem;
  onPortForward?: (service: ResourceItem, port?: number) => void;
}

export function ServicePortsBlock({ service, item, onPortForward }: ServicePortsBlockProps) {
  const [forwardPort, setForwardPort] = useState<number | null>(null);
  const target = (service ?? item)!;
  if (!target) return null;

  const raw = target.raw ?? {};
  const spec = raw.spec ?? target.spec ?? {};
  const ports: any[] = spec.ports ?? [];

  const dnsName = `${target.name}.${target.namespace || 'default'}.svc.cluster.local`;

  const copy = (text: string, label: string) => {
    navigator.clipboard.writeText(text).then(() => toast.success(`Copied ${label}`)).catch(() => toast.error('Clipboard unavailable'));
  };

  return (
    <section aria-label="Service routing" className="details-section">
      <div className="details-section-heading text-[length:calc(11px*var(--ui-factor))] font-medium text-[var(--text-secondary)] bg-[var(--bg-secondary)] flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-[var(--text-primary)]">
          <Network size="calc(12px * var(--ui-factor))" className="text-blue-400" />
          Service Ports & DNS
        </span>
        <span className="font-mono text-[10px] text-[var(--text-muted)] bg-[var(--bg-canvas)] px-1.5 py-0.5 rounded border border-[var(--border-subtle)]">
          {spec.type || 'ClusterIP'}
        </span>
      </div>

      <div className="p-2 bg-[var(--bg-canvas)] flex flex-col gap-3 text-xs">
        {/* DNS Address */}
        <div className="p-2 rounded bg-[var(--bg-secondary)]/50 border border-[var(--border-subtle)] flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 min-w-0">
            <Globe size="calc(13px * var(--ui-factor))" className="text-[var(--accent)] shrink-0" />
            <span className="text-[var(--text-muted)]">DNS:</span>
            <span className="font-mono text-[var(--text-primary)] truncate" title={dnsName}>
              {dnsName}
            </span>
          </div>
          <button
            type="button"
            onClick={() => copy(dnsName, 'DNS name')}
            className="text-[var(--text-muted)] hover:text-[var(--text-primary)] p-1 rounded"
            title="Copy DNS name"
          >
            <Copy size="calc(12px * var(--ui-factor))" />
          </button>
        </div>

        {/* Ports Table */}
        {ports.length === 0 ? (
          <div className="text-[var(--text-muted)]">No ports configured for this service.</div>
        ) : (
          <div className="space-y-1.5">
            <div className="text-[length:calc(10.5px*var(--ui-factor))] font-semibold text-[var(--text-muted)] uppercase tracking-wider">
              Port Mappings
            </div>
            <div className="divide-y divide-[var(--border-subtle)] border border-[var(--border-subtle)] rounded overflow-hidden">
              {ports.map((p: any, idx: number) => (
                <div key={idx} className="p-2 bg-[var(--bg-secondary)]/20 flex flex-wrap items-center justify-between gap-2 font-mono">
                  <div className="min-w-0 flex flex-wrap items-center gap-2 break-all">
                    <span className="font-semibold text-[var(--text-primary)]">{p.port}</span>
                    <span className="text-[var(--text-muted)]">→</span>
                    <span className="text-emerald-400">{p.targetPort || p.port}</span>
                    <span className="text-[10px] text-[var(--text-muted)]">({p.protocol || 'TCP'})</span>
                    {p.nodePort && (
                      <span className="text-[10px] text-amber-400 bg-amber-500/10 px-1 py-0.5 rounded">
                        NodePort: {p.nodePort}
                      </span>
                    )}
                    {p.name && (
                      <span className="text-[10px] text-[var(--text-muted)]">[{p.name}]</span>
                    )}
                  </div>

                  <Button
                    size="sm"
                    disabled={(p.protocol ?? 'TCP') !== 'TCP' || spec.type === 'ExternalName' || !Object.keys(spec.selector ?? {}).length}
                    onClick={() =>
                      onPortForward
                        ? onPortForward(target, p.port)
                        : setForwardPort(p.port)
                    }
                    title={(p.protocol ?? 'TCP') !== 'TCP' ? 'Port forwarding supports TCP only' : !Object.keys(spec.selector ?? {}).length ? 'Service port forwarding requires a Pod selector' : 'Forward this port to localhost'}
                  >
                    <ArrowRightLeft size="calc(11px * var(--ui-factor))" />
                    Port-forward
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      {forwardPort !== null && <PFDialog item={target} initialRemotePort={forwardPort} onClose={() => setForwardPort(null)} />}
    </section>
  );
}
