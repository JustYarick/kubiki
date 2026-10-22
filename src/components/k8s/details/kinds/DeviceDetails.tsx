import { CircuitBoard, Cpu } from 'lucide-react';
import type { ResourceItem } from '../../../../types/k8s';
import { useResourceStore } from '../../../../state/resource_store';
import { resourceByRef } from '../../../../core/resources/detail_links';
import { summaryTitle } from '../../../../core/resources/kind_labels';
import { DetailsSection } from '../DetailsSection';
import { KindSummary } from '../blocks/KindSummary';
import { DetailTable } from '../blocks/DetailTable';
import { ProblemsBanner } from '../blocks/ProblemsBanner';
import { UsedByList } from '../blocks/UsedByList';
import { ConditionsTable } from '../blocks/ConditionsTable';
import { MetadataBlock } from '../blocks/MetadataBlock';

interface DeviceDetailsProps {
  item: ResourceItem;
  onNavigate: (item: ResourceItem) => void;
}

/** Device classes: the selectors a driver exposes. */
export function DeviceClassDetails({ item, onNavigate }: DeviceDetailsProps) {
  const raw = item.raw ?? {};
  const spec = raw.spec ?? {};
  const selectors: any[] = spec.selectors ?? [];
  const configs: any[] = spec.config ?? [];

  return (
    <div className="details-stack">
      <ProblemsBanner item={item} />
      <KindSummary
        title={summaryTitle(item.kind)}
        icon={CircuitBoard}
        tiles={[
          { label: 'Selectors', value: selectors.length || '—' },
          { label: 'Config extensions', value: configs.length || '—', tone: 'muted' },
        ]}
        rows={[{ label: 'Driver', value: raw.status?.drivers?.join(', ') || 'Reported by the driver' }]}
      />
      <DetailsSection title={`Device selectors (${selectors.length})`}>
        <DetailTable
          columns={['Cell', 'Operator', 'Values']}
          rows={selectors.map(selector => [
            selector.cell?.id ?? '—',
            selector.cell?.operator ?? '—',
            (selector.cell?.values ?? []).join(', ') || '—',
          ])}
          empty="This device class does not define selectors."
        />
      </DetailsSection>
      <UsedByList item={item} onNavigate={onNavigate} />
      <ConditionsTable conditions={raw.status?.conditions} />
      <MetadataBlock item={item} onNavigate={onNavigate} />
    </div>
  );
}

/** Resource claims: the devices a pod asks for and the allocation it received. */
export function ResourceClaimDetails({ item, onNavigate }: DeviceDetailsProps) {
  const resources = useResourceStore(state => state.resources);
  const raw = item.raw ?? {};
  const spec = raw.spec ?? {};
  const status = raw.status ?? {};
  const devices: any[] = spec.devices ?? [];
  const allocation = status.allocation ?? {};
  const allocatedDevices: any[] = allocation.devices ?? [];
  const reservedFor: any[] = status.reservedFor ?? [];

  const classEntries = devices.map(device => {
    const target = device.deviceClassName
      ? resourceByRef(resources, { kind: 'DeviceClass', name: device.deviceClassName })
      : undefined;
    return { device, target };
  });

  return (
    <div className="details-stack">
      <ProblemsBanner item={item} />
      <KindSummary
        title={summaryTitle(item.kind)}
        icon={Cpu}
        tiles={[
          { label: 'Requested devices', value: devices.length || '—' },
          { label: 'Allocated', value: allocatedDevices.length || '—', tone: allocatedDevices.length ? 'ok' : 'muted' },
          { label: 'Ready', value: allocation.readyCount ?? '—', tone: 'muted' },
          { label: 'Reserved for', value: reservedFor.length || '—', tone: 'muted' },
        ]}
        rows={[
          { label: 'Allocation mode', value: devices[0]?.allocationMode ?? '—' },
          { label: 'Controller', value: allocation.controller ?? '—' },
          { label: 'Node', value: allocation.nodeName ?? '—' },
        ]}
      />

      <DetailsSection title={`Requested devices (${devices.length})`}>
        <DetailTable
          columns={['Device class', 'Requests', 'Admin access']}
          rows={classEntries.map(({ device, target }) => [
            device.deviceClassName
              ? target
                ? <button key={target.uid} type="button" className="details-link" onClick={() => onNavigate(target)}>{device.deviceClassName}</button>
                : device.deviceClassName
              : '—',
            Object.entries(device.requests ?? {}).map(([key, value]) => `${key}=${value}`).join(', ') || '—',
            device.adminAccess === true ? 'Yes' : 'No',
          ])}
          empty="This claim does not request any device."
        />
      </DetailsSection>

      {!!allocatedDevices.length && (
        <DetailsSection title={`Allocated devices (${allocatedDevices.length})`}>
          <DetailTable
            columns={['Device', 'Driver', 'Pool']}
            rows={allocatedDevices.map((device: any) => [
              device.deviceName ?? '—',
              device.driver ?? '—',
              device.pool?.name ?? '—',
            ])}
          />
        </DetailsSection>
      )}

      {!!reservedFor.length && (
        <DetailsSection title={`Reserved for (${reservedFor.length})`}>
          <DetailTable
            columns={['Consumer', 'Resource']}
            rows={reservedFor.map((entry: any) => [entry.name ?? '—', entry.resource ?? '—'])}
          />
        </DetailsSection>
      )}

      <UsedByList item={item} onNavigate={onNavigate} />
      <ConditionsTable conditions={status.conditions} />
      <MetadataBlock item={item} onNavigate={onNavigate} />
    </div>
  );
}

/** Resource claim templates: the spec a claim is created from. */
export function ResourceClaimTemplateDetails({ item, onNavigate }: DeviceDetailsProps) {
  const raw = item.raw ?? {};
  const spec = raw.spec ?? {};
  const devices: any[] = spec.spec?.devices ?? [];
  return (
    <div className="details-stack">
      <ProblemsBanner item={item} />
      <KindSummary
        title={summaryTitle(item.kind)}
        icon={Cpu}
        tiles={[
          { label: 'Device classes', value: devices.length || '—' },
          { label: 'Allocation mode', value: devices[0]?.allocationMode ?? '—', tone: 'muted' },
        ]}
        rows={[{ label: 'Template name', value: raw.spec?.metadata?.name ?? item.name }]}
      />
      <DetailsSection title={`Device requests (${devices.length})`}>
        <DetailTable
          columns={['Device class', 'Requests', 'Admin access']}
          rows={devices.map((device: any) => [
            device.deviceClassName ?? '—',
            Object.entries(device.requests ?? {}).map(([key, value]) => `${key}=${value}`).join(', ') || '—',
            device.adminAccess === true ? 'Yes' : 'No',
          ])}
          empty="This template does not request any device."
        />
      </DetailsSection>
      <UsedByList item={item} onNavigate={onNavigate} />
      <MetadataBlock item={item} onNavigate={onNavigate} />
    </div>
  );
}

/** Resource slices: the devices a driver published for a pool. */
export function ResourceSliceDetails({ item, onNavigate }: DeviceDetailsProps) {
  const raw = item.raw ?? {};
  const spec = raw.spec ?? {};
  const devices: any[] = spec.devices ?? [];
  const pool = spec.pool ?? {};
  return (
    <div className="details-stack">
      <ProblemsBanner item={item} />
      <KindSummary
        title={summaryTitle(item.kind)}
        icon={CircuitBoard}
        tiles={[
          { label: 'Devices', value: devices.length },
          { label: 'Driver', value: spec.driver ?? '—', tone: 'info' },
          { label: 'Pool', value: pool.name ?? '—', tone: 'muted' },
          { label: 'Slice count', value: pool.resourceSliceCount ?? '—', tone: 'muted' },
        ]}
        rows={[
          { label: 'Node', value: spec.nodeName ?? 'All nodes' },
          { label: 'Node selector', value: spec.nodeSelector ? Object.entries(spec.nodeSelector).map(([key, value]) => `${key}=${value}`).join(', ') : '—' },
        ]}
      />
      <DetailsSection title={`Devices (${devices.length})`}>
        <DetailTable
          columns={['Device', 'Attributes', 'Capacity']}
          rows={devices.map((device: any) => [
            device.name ?? '—',
            Object.entries(device.basic?.attributes ?? {}).map(([key, value]) => `${key}=${value}`).join(', ') || '—',
            Object.entries(device.basic?.capacity ?? {}).map(([key, value]) => `${key}=${value}`).join(', ') || '—',
          ])}
          empty="This slice does not publish any device."
        />
      </DetailsSection>
      <UsedByList item={item} onNavigate={onNavigate} />
      <MetadataBlock item={item} onNavigate={onNavigate} />
    </div>
  );
}
