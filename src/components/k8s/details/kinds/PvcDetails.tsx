import { memoryText, quantity } from '../../../../core/resources/quantities';
import { HardDrive } from 'lucide-react';
import type { ResourceItem } from '../../../../types/k8s';
import { useResourceStore } from '../../../../state/resource_store';
import { ProblemsBanner } from '../blocks/ProblemsBanner';
import { UsedByList } from '../blocks/UsedByList';
import { ConditionsTable } from '../blocks/ConditionsTable';
import { MetadataBlock } from '../blocks/MetadataBlock';

interface PvcDetailsProps {
  item: ResourceItem;
  onNavigate: (item: ResourceItem) => void;
}

export function PvcDetails({ item, onNavigate }: PvcDetailsProps) {
  const resources = useResourceStore((s) => s.resources);
  const raw = item.raw ?? {};
  const spec = raw.spec ?? item.spec ?? {};
  const status = raw.status ?? item.statusRaw ?? {};

  const phase: string = status.phase ?? item.status ?? 'Unknown';
  const accessModes: string[] = spec.accessModes ?? (item.accessModes ? [item.accessModes] : []);
  const storageClassName: string = spec.storageClassName ?? item.storageClass;
  const volumeName: string = spec.volumeName ?? item.volume;

  const requestedStorage = spec.resources?.requests?.storage;
  const actualCapacity = status.capacity?.storage;

  // Find linked PV and StorageClass
  const linkedPv = volumeName ? [...resources.PersistentVolume.values()].find((pv) => pv.name === volumeName) : undefined;
  const linkedSc = storageClassName ? [...resources.StorageClass.values()].find((sc) => sc.name === storageClassName) : undefined;

  return (
    <div className="details-stack">
      {/* 1. "What's wrong" diagnostic banner */}
      <ProblemsBanner item={item} />

      {/* 2. Storage & Claim Details */}
      <section aria-label="Storage claim details" className="details-section">
        <div className="details-section-heading bg-[var(--bg-secondary)] border-b border-[var(--border-default)] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <HardDrive size="calc(13px * var(--ui-factor))" className="text-[var(--accent)]" />
            <span className="text-xs font-semibold text-[var(--text-primary)]">Storage Claim & Capacity</span>
          </div>
          <span className={`px-1.5 py-0.5 rounded text-[length:calc(10px*var(--ui-factor))] font-mono font-medium ${
            phase === 'Bound' ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
          }`}>
            {phase}
          </span>
        </div>
        <div className="p-2">
          <dl className="details-properties">
            <dt className="text-[var(--text-secondary)]">Capacity</dt>
            <dd className="font-mono text-emerald-400 font-semibold">
              {memoryText(quantity(actualCapacity ?? requestedStorage))}
            </dd>

            {requestedStorage && requestedStorage !== actualCapacity && (
              <>
                <dt className="text-[var(--text-secondary)]">Requested Storage</dt>
                <dd className="font-mono text-[var(--text-primary)]">{memoryText(quantity(requestedStorage))}</dd>
              </>
            )}

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
                storageClassName || 'default'
              )}
            </dd>

            <dt className="text-[var(--text-secondary)]">Persistent Volume</dt>
            <dd className="font-mono text-[var(--text-primary)]">
              {linkedPv ? (
                <button
                  type="button"
                  onClick={() => onNavigate(linkedPv)}
                  className="text-[var(--accent)] hover:underline text-left truncate"
                >
                  {volumeName}
                </button>
              ) : (
                volumeName || '— (unbound)'
              )}
            </dd>

            <dt className="text-[var(--text-secondary)]">Volume Mode</dt>
            <dd className="font-mono text-[var(--text-primary)]">{spec.volumeMode ?? 'Filesystem'}</dd>
          </dl>
        </div>
      </section>

      {/* 3. Used By (Pods that mount this claim) */}
      <UsedByList item={item} onNavigate={onNavigate} />

      {/* 4. Conditions */}
      <ConditionsTable conditions={status.conditions} />

      {/* 5. Metadata */}
      <MetadataBlock item={item} onNavigate={onNavigate} />
    </div>
  );
}
