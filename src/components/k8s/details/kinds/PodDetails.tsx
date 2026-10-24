import { Layers, HardDrive, ShieldCheck, Box } from 'lucide-react';
import type { ResourceItem } from '../../../../types/k8s';
import { podContainers } from '../../../../core/resources/containers';
import { ownerMatches } from '../../../../core/resources/owner_references';
import { useResourceStore } from '../../../../state/resource_store';
import { ProblemsBanner } from '../blocks/ProblemsBanner';
import { MetricsGaugeBar } from '../blocks/MetricsGaugeBar';
import { ContainerCard } from '../blocks/ContainerCard';
import { ConditionsTable } from '../blocks/ConditionsTable';
import { MetadataBlock } from '../blocks/MetadataBlock';
import { DetailsSection } from '../DetailsSection';

interface PodDetailsProps {
  item: ResourceItem;
  onNavigate: (item: ResourceItem) => void;
  onLogs: (container?: string) => void;
  onShell: (container?: string) => void;
}

export function PodDetails({ item, onNavigate, onLogs, onShell }: PodDetailsProps) {
  const resources = useResourceStore((s) => s.resources);
  const raw = item.raw ?? {};
  const spec = raw.spec ?? item.spec ?? {};
  const status = raw.status ?? item.statusRaw ?? {};

  const containers = podContainers(item);
  const appContainers = containers.filter((c) => c.role === 'application' || c.role === 'sidecar');
  const initContainers = containers.filter((c) => c.role === 'init');
  const ephemeralContainers = containers.filter((c) => c.role === 'ephemeral');

  const volumes: any[] = spec.volumes ?? [];
  const tolerations: any[] = spec.tolerations ?? [];
  const nodeSelector: Record<string, string> = spec.nodeSelector ?? {};

  // Lens-matching metadata properties
  const nodeName = spec.nodeName || item.node;
  const linkedNode = nodeName ? [...resources.Node.values()].find((n) => n.name === nodeName) : undefined;
  const qosClass = status.qosClass || spec.qosClass || item.qosClass || 'Unknown';
  const ownerRef = raw.metadata?.ownerReferences?.[0];
  const linkedOwner = ownerRef
    ? [...(resources[ownerRef.kind]?.values() ?? [])].find(
        (r) => ownerMatches(ownerRef, r) && (!item.namespace || r.namespace === item.namespace)
      )
    : undefined;
  const saName = spec.serviceAccountName || spec.serviceAccount;
  const linkedSa = saName
    ? [...resources.ServiceAccount.values()].find(
        (sa) => sa.name === saName && (!item.namespace || sa.namespace === item.namespace)
      )
    : undefined;

  // Helpers to find linked resources
  const findPvc = (claimName: string) =>
    [...resources.PersistentVolumeClaim.values()].find(
      (p) => p.name === claimName && (!item.namespace || p.namespace === item.namespace)
    );

  const findSecret = (secretName: string) =>
    [...resources.Secret.values()].find(
      (s) => s.name === secretName && (!item.namespace || s.namespace === item.namespace)
    );

  const findConfigMap = (cmName: string) =>
    [...resources.ConfigMap.values()].find(
      (c) => c.name === cmName && (!item.namespace || c.namespace === item.namespace)
    );

  return (
    <div className="details-stack">
      {/* 1. "What's wrong" diagnostic banner */}
      <ProblemsBanner item={item} />

      {/* 2. Pod Summary (Lens feature parity) */}
      <DetailsSection title="Pod summary">
        <dl className="details-properties">
          <dt>Node</dt>
          <dd>
            {linkedNode ? (
              <button
                type="button"
                className="details-link font-mono"
                onClick={() => onNavigate(linkedNode)}
              >
                {nodeName}
              </button>
            ) : (
              <span className="font-mono text-[var(--text-secondary)]">{nodeName || '—'}</span>
            )}
          </dd>

          <dt>QoS Class</dt>
          <dd>
            <span className="px-1.5 py-0.5 rounded text-[10.5px] font-mono font-medium bg-[var(--bg-secondary)] border border-[var(--border-subtle)] text-[var(--text-primary)]">
              {qosClass}
            </span>
          </dd>

          {ownerRef && (
            <>
              <dt>Controlled by</dt>
              <dd>
                {linkedOwner ? (
                  <button
                    type="button"
                    className="details-link font-mono"
                    onClick={() => onNavigate(linkedOwner)}
                  >
                    {ownerRef.kind}/{ownerRef.name}
                  </button>
                ) : (
                  <span className="font-mono text-[var(--text-secondary)]">
                    {ownerRef.kind}/{ownerRef.name}
                  </span>
                )}
              </dd>
            </>
          )}

          <dt>Pod IP</dt>
          <dd className="font-mono text-[var(--text-primary)]">{status.podIP || item.ip || '—'}</dd>

          {status.hostIP && (
            <>
              <dt>Host IP</dt>
              <dd className="font-mono text-[var(--text-secondary)]">{status.hostIP}</dd>
            </>
          )}

          {saName && (
            <>
              <dt>Service account</dt>
              <dd>
                {linkedSa ? (
                  <button
                    type="button"
                    className="details-link font-mono"
                    onClick={() => onNavigate(linkedSa)}
                  >
                    {saName}
                  </button>
                ) : (
                  <span className="font-mono text-[var(--text-secondary)]">{saName}</span>
                )}
              </dd>
            </>
          )}
        </dl>
      </DetailsSection>

      {/* 3. CPU & Memory Gauge */}
      <MetricsGaugeBar item={item} />

      {/* 3. Containers */}
      <section aria-label="Containers" className="details-section">
        <div className="details-section-heading bg-[var(--bg-secondary)] border-b border-[var(--border-default)] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Box size="calc(13px * var(--ui-factor))" className="text-[var(--accent)]" />
            <span className="text-xs font-semibold text-[var(--text-primary)]">
              Containers ({appContainers.length})
            </span>
          </div>
        </div>
        <div className="p-2 space-y-2.5">
          {appContainers.map((c) => {
            const containerSpec = (spec.containers ?? []).find((s: any) => s.name === c.name) ?? {};
            const containerStatus = (status.containerStatuses ?? []).find((s: any) => s.name === c.name) ?? {};
            return (
              <ContainerCard
                key={c.name}
                container={c}
                spec={containerSpec}
                status={containerStatus}
                onLogs={() => onLogs(c.name)}
                onShell={() => onShell(c.name)}
              />
            );
          })}
        </div>
      </section>

      {/* 4. Init Containers (if present) */}
      {initContainers.length > 0 && (
        <section aria-label="Init Containers" className="details-section">
          <div className="details-section-heading bg-[var(--bg-secondary)] border-b border-[var(--border-default)] flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Layers size="calc(13px * var(--ui-factor))" className="text-amber-400" />
              <span className="text-xs font-semibold text-[var(--text-primary)]">
                Init Containers ({initContainers.length})
              </span>
            </div>
          </div>
          <div className="p-2 space-y-2.5">
            {initContainers.map((c) => {
              const containerSpec = (spec.initContainers ?? []).find((s: any) => s.name === c.name) ?? {};
              const containerStatus = (status.initContainerStatuses ?? []).find((s: any) => s.name === c.name) ?? {};
              return (
                <ContainerCard
                  key={c.name}
                  container={c}
                  spec={containerSpec}
                  status={containerStatus}
                  onLogs={() => onLogs(c.name)}
                  onShell={() => onShell(c.name)}
                />
              );
            })}
          </div>
        </section>
      )}

      {/* 5. Ephemeral Containers (if present) */}
      {ephemeralContainers.length > 0 && (
        <section aria-label="Ephemeral Containers" className="details-section">
          <div className="details-section-heading bg-[var(--bg-secondary)] border-b border-[var(--border-default)] flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Layers size="calc(13px * var(--ui-factor))" className="text-purple-400" />
              <span className="text-xs font-semibold text-[var(--text-primary)]">
                Ephemeral Containers ({ephemeralContainers.length})
              </span>
            </div>
          </div>
          <div className="p-2 space-y-2.5">
            {ephemeralContainers.map((c) => {
              const containerSpec = (spec.ephemeralContainers ?? []).find((s: any) => s.name === c.name) ?? {};
              const containerStatus = (status.ephemeralContainerStatuses ?? []).find((s: any) => s.name === c.name) ?? {};
              return (
                <ContainerCard
                  key={c.name}
                  container={c}
                  spec={containerSpec}
                  status={containerStatus}
                  onLogs={() => onLogs(c.name)}
                  onShell={() => onShell(c.name)}
                />
              );
            })}
          </div>
        </section>
      )}

      {/* 6. Volumes & Storage */}
      {volumes.length > 0 && (
        <section aria-label="Pod Volumes" className="details-section">
          <div className="details-section-heading bg-[var(--bg-secondary)] border-b border-[var(--border-default)] flex items-center justify-between">
            <div className="flex items-center gap-2">
              <HardDrive size="calc(13px * var(--ui-factor))" className="text-[var(--accent)]" />
              <span className="text-xs font-semibold text-[var(--text-primary)]">Volumes ({volumes.length})</span>
            </div>
          </div>
          <div className="p-2 divide-y divide-[var(--border-subtle)]">
            {volumes.map((v, i) => {
              const keys = Object.keys(v).filter((k) => k !== 'name');
              const volType = keys[0] ?? 'unknown';
              const volData = v[volType];

              let linkedTarget: ResourceItem | undefined;
              let targetName = '';

              if (volType === 'persistentVolumeClaim') {
                targetName = volData?.claimName;
                linkedTarget = findPvc(targetName);
              } else if (volType === 'secret') {
                targetName = volData?.secretName;
                linkedTarget = findSecret(targetName);
              } else if (volType === 'configMap') {
                targetName = volData?.name;
                linkedTarget = findConfigMap(targetName);
              }

              return (
                <div key={i} className="py-2 text-xs flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <span className="font-mono font-medium text-[var(--text-primary)]">{v.name}</span>
                    <span className="ml-2 text-[length:calc(10px*var(--ui-factor))] px-1.5 py-0.5 rounded bg-[var(--bg-secondary)] text-[var(--text-muted)] font-mono">
                      {volType}
                    </span>
                  </div>
                  {targetName ? (
                    linkedTarget ? (
                      <button
                        type="button"
                        onClick={() => onNavigate(linkedTarget!)}
                        className="font-mono text-[length:calc(11px*var(--ui-factor))] text-[var(--accent)] hover:underline truncate"
                      >
                        {targetName}
                      </button>
                    ) : (
                      <span className="font-mono text-[length:calc(11px*var(--ui-factor))] text-[var(--text-secondary)] truncate">
                        {targetName}
                      </span>
                    )
                  ) : (
                    <span className="text-[length:calc(10px*var(--ui-factor))] text-[var(--text-muted)] truncate max-w-[200px]">
                      {typeof volData === 'object' ? JSON.stringify(volData) : String(volData ?? '')}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* 7. Tolerations & Node Selector */}
      {(tolerations.length > 0 || Object.keys(nodeSelector).length > 0) && (
        <section aria-label="Scheduling constraints" className="details-section">
          <div className="details-section-heading bg-[var(--bg-secondary)] border-b border-[var(--border-default)] flex items-center gap-2">
            <ShieldCheck size="calc(13px * var(--ui-factor))" className="text-[var(--accent)]" />
            <span className="text-xs font-semibold text-[var(--text-primary)]">Scheduling & Tolerations</span>
          </div>
          <div className="p-2 space-y-2 text-xs">
            {Object.keys(nodeSelector).length > 0 && (
              <div>
                <span className="text-[var(--text-muted)] block mb-1">Node Selector:</span>
                <div className="flex flex-wrap gap-1">
                  {Object.entries(nodeSelector).map(([k, v]) => (
                    <span key={k} className="font-mono text-[length:calc(10.5px*var(--ui-factor))] px-1.5 py-0.5 rounded bg-[var(--bg-secondary)] border border-[var(--border-subtle)] text-[var(--text-primary)]">
                      {k}: {v}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {tolerations.length > 0 && (
              <div className="mt-2">
                <span className="text-[var(--text-muted)] block mb-1">Tolerations ({tolerations.length}):</span>
                <div className="space-y-1">
                  {tolerations.slice(0, 8).map((t, i) => (
                    <div key={i} className="font-mono text-[length:calc(10.5px*var(--ui-factor))] px-2 py-1 rounded bg-[var(--bg-secondary)] text-[var(--text-secondary)] flex justify-between">
                      <span>{t.key || '*'}{t.operator === 'Equal' ? `=${t.value}` : ` ${t.operator || 'Exists'}`}</span>
                      <span className="text-[var(--text-muted)]">{t.effect || 'All effects'}</span>
                    </div>
                  ))}
                  {tolerations.length > 8 && (
                    <div className="text-[length:calc(10px*var(--ui-factor))] text-[var(--text-muted)] text-center">
                      +{tolerations.length - 8} more tolerations
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </section>
      )}

      {/* 8. Conditions */}
      <ConditionsTable conditions={status.conditions} />

      {/* 9. Metadata & Finalizers */}
      <MetadataBlock item={item} onNavigate={onNavigate} />
    </div>
  );
}
