import { memoryText, quantity } from '../../../../core/resources/quantities';
import { Database } from 'lucide-react';
import type { ResourceItem } from '../../../../types/k8s';
import { useResourceStore } from '../../../../state/resource_store';
import { ProblemsBanner } from '../blocks/ProblemsBanner';
import { UsedByList } from '../blocks/UsedByList';
import { ConditionsTable } from '../blocks/ConditionsTable';
import { MetadataBlock } from '../blocks/MetadataBlock';
import { DetailsSection } from '../DetailsSection';

interface PvDetailsProps {
  item: ResourceItem;
  onNavigate: (item: ResourceItem) => void;
}

export function PvDetails({ item, onNavigate }: PvDetailsProps) {
  const resources = useResourceStore((s) => s.resources);
  const raw = item.raw ?? {};
  const spec = raw.spec ?? item.spec ?? {};
  const status = raw.status ?? item.statusRaw ?? {};

  const phase: string = status.phase ?? item.status ?? 'Unknown';
  const accessModes: string[] = spec.accessModes ?? (item.accessModes ? [item.accessModes] : []);
  const storageClassName: string = spec.storageClassName ?? item.storageClass;
  const reclaimPolicy: string = spec.persistentVolumeReclaimPolicy ?? 'Retain';
  const volumeMode: string = spec.volumeMode ?? 'Filesystem';

  // Capacity in PV is defined in spec.capacity.storage
  const capacityStorage = spec.capacity?.storage ?? status.capacity?.storage;

  // Claim reference (PVC)
  const claimRef = spec.claimRef;
  const claimNamespace = claimRef?.namespace;
  const claimName = claimRef?.name;

  // Find linked PVC and StorageClass
  const linkedPvc = claimName
    ? [...(resources.PersistentVolumeClaim?.values() ?? [])].find(
        (pvc) => pvc.name === claimName && (!claimNamespace || pvc.namespace === claimNamespace)
      )
    : undefined;

  const linkedSc = storageClassName
    ? [...(resources.StorageClass?.values() ?? [])].find((sc) => sc.name === storageClassName)
    : undefined;

  // Identify volume source / CSI
  const csi = spec.csi;
  const nfs = spec.nfs;
  const hostPath = spec.hostPath;
  const local = spec.local;

  return (
    <div className="details-stack">
      {/* 1. Diagnostic Banner */}
      <ProblemsBanner item={item} />

      {/* 2. Persistent Volume Overview */}
      <section aria-label="Persistent Volume capacity and status" className="details-section">
        <div className="details-section-heading bg-[var(--bg-secondary)] border-b border-[var(--border-default)] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Database size="calc(13px * var(--ui-factor))" className="text-[var(--accent)]" />
            <span className="text-xs font-semibold text-[var(--text-primary)]">Persistent Volume & Capacity</span>
          </div>
          <span
            className={`px-1.5 py-0.5 rounded text-[length:calc(10px*var(--ui-factor))] font-mono font-medium ${
              phase === 'Bound'
                ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                : phase === 'Available'
                  ? 'bg-blue-500/10 text-blue-400 border border-blue-500/20'
                  : 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
            }`}
          >
            {phase}
          </span>
        </div>
        <div className="p-2">
          <dl className="details-properties">
            <dt className="text-[var(--text-secondary)]">Capacity</dt>
            <dd className="font-mono text-emerald-400 font-semibold">
              {capacityStorage ? memoryText(quantity(capacityStorage)) : '—'}
            </dd>

            <dt className="text-[var(--text-secondary)]">Reclaim Policy</dt>
            <dd className="font-mono text-[var(--text-primary)]">{reclaimPolicy}</dd>

            <dt className="text-[var(--text-secondary)]">Access Modes</dt>
            <dd className="font-mono text-[var(--text-primary)]">
              {accessModes.length > 0 ? accessModes.join(', ') : '—'}
            </dd>

            <dt className="text-[var(--text-secondary)]">Storage Class</dt>
            <dd className="font-mono text-[var(--text-primary)]">
              {linkedSc ? (
                <button
                  type="button"
                  onClick={() => onNavigate(linkedSc)}
                  className="text-[var(--accent)] hover:underline text-left truncate"
                >
                  {storageClassName}
                </button>
              ) : (
                storageClassName || '—'
              )}
            </dd>

            <dt className="text-[var(--text-secondary)]">Claim</dt>
            <dd className="font-mono text-[var(--text-primary)]">
              {claimName ? (
                linkedPvc ? (
                  <button
                    type="button"
                    onClick={() => onNavigate(linkedPvc)}
                    className="text-[var(--accent)] hover:underline text-left truncate"
                  >
                    {claimNamespace ? `${claimNamespace}/${claimName}` : claimName}
                  </button>
                ) : (
                  <span>{claimNamespace ? `${claimNamespace}/${claimName}` : claimName}</span>
                )
              ) : (
                <span className="text-[var(--text-muted)]">Available (unbound)</span>
              )}
            </dd>

            <dt className="text-[var(--text-secondary)]">Volume Mode</dt>
            <dd className="font-mono text-[var(--text-primary)]">{volumeMode}</dd>
          </dl>
        </div>
      </section>

      {/* 3. Volume Source / Driver details */}
      {(csi || nfs || hostPath || local) && (
        <DetailsSection title="Volume Source">
          <dl className="details-properties">
            {csi && (
              <>
                <dt>CSI Driver</dt>
                <dd className="font-mono">{csi.driver ?? '—'}</dd>
                <dt>Volume Handle</dt>
                <dd className="font-mono text-xs break-all">{csi.volumeHandle ?? '—'}</dd>
                {csi.fsType && (
                  <>
                    <dt>FS Type</dt>
                    <dd className="font-mono">{csi.fsType}</dd>
                  </>
                )}
              </>
            )}
            {nfs && (
              <>
                <dt>NFS Server</dt>
                <dd className="font-mono">{nfs.server ?? '—'}</dd>
                <dt>NFS Path</dt>
                <dd className="font-mono">{nfs.path ?? '—'}</dd>
              </>
            )}
            {hostPath && (
              <>
                <dt>Host Path</dt>
                <dd className="font-mono">{hostPath.path ?? '—'}</dd>
              </>
            )}
            {local && (
              <>
                <dt>Local Path</dt>
                <dd className="font-mono">{local.path ?? '—'}</dd>
              </>
            )}
          </dl>
        </DetailsSection>
      )}

      {/* 4. Conditions */}
      <ConditionsTable conditions={status.conditions} />

      {/* 5. Used By / Dependents */}
      <UsedByList item={item} onNavigate={onNavigate} />

      {/* 6. Metadata */}
      <MetadataBlock item={item} onNavigate={onNavigate} />
    </div>
  );
}
