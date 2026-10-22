import { Network } from 'lucide-react';
import type { ResourceItem } from '../../../../types/k8s';
import { useResourceStore } from '../../../../state/resource_store';
import { serviceForEndpointSlice, serviceForEndpoints } from '../../../../core/resources/detail_links';
import { summaryTitle } from '../../../../core/resources/kind_labels';
import { DetailsSection } from '../DetailsSection';
import { KindSummary } from '../blocks/KindSummary';
import { DetailTable } from '../blocks/DetailTable';
import { ProblemsBanner } from '../blocks/ProblemsBanner';
import { UsedByList } from '../blocks/UsedByList';
import { MetadataBlock } from '../blocks/MetadataBlock';

interface EndpointDetailsProps {
  item: ResourceItem;
  onNavigate: (item: ResourceItem) => void;
}

/** Endpoint slices and legacy endpoints: the addresses behind a Service. */
export function EndpointDetails({ item, onNavigate }: EndpointDetailsProps) {
  const resources = useResourceStore(state => state.resources);
  const raw = item.raw ?? {};
  const isSlice = item.kind === 'EndpointSlice';

  if (!isSlice) {
    const subsets: any[] = raw.subsets ?? [];
    const addresses = subsets.flatMap(subset => subset.addresses ?? []);
    const ports = subsets.flatMap(subset => subset.ports ?? []);
    const service = serviceForEndpoints(resources, item);
    return (
      <div className="details-stack">
        <ProblemsBanner item={item} />
        <KindSummary
          title={summaryTitle(item.kind)}
          icon={Network}
          tiles={[
            { label: 'Addresses', value: addresses.length },
            { label: 'Not ready', value: subsets.reduce((total, subset) => total + (subset.notReadyAddresses?.length ?? 0), 0), tone: 'muted' },
            { label: 'Ports', value: ports.length, tone: 'muted' },
          ]}
          rows={[
            {
              label: 'Service',
              value: service
                ? <button type="button" className="details-link" onClick={() => onNavigate(service)}>Service/{service.name}</button>
                : <span>Not loaded</span>,
            },
          ]}
        />
        <DetailsSection title={`Subsets (${subsets.length})`}>
          {subsets.length === 0 && <p className="details-caption">This Endpoints object has no subsets. The Service has no ready backends.</p>}
          {subsets.map((subset, index) => (
            <div key={index} className="details-subset">
              <div className="details-subset-heading">Subset {index + 1}</div>
              <DetailTable
                columns={['Address', 'Ready', 'Target']}
                rows={(subset.addresses ?? []).map((address: any) => [
                  address.ip ?? '—',
                  'Ready',
                  address.targetRef?.name ?? '—',
                ])}
                empty="No addresses in this subset."
              />
              {(subset.notReadyAddresses ?? []).length > 0 && (
                <DetailTable
                  columns={['Not ready address', 'Target']}
                  rows={(subset.notReadyAddresses ?? []).map((address: any) => [address.ip ?? '—', address.targetRef?.name ?? '—'])}
                />
              )}
              {!!subset.ports?.length && (
                <DetailTable
                  columns={['Port name', 'Port', 'Protocol']}
                  rows={subset.ports.map((port: any) => [port.name ?? '—', port.port ?? '—', port.protocol ?? 'TCP'])}
                />
              )}
            </div>
          ))}
        </DetailsSection>
        <UsedByList item={item} onNavigate={onNavigate} />
        <MetadataBlock item={item} onNavigate={onNavigate} />
      </div>
    );
  }

  const endpoints: any[] = raw.endpoints ?? [];
  const ports: any[] = raw.ports ?? [];
  const ready = endpoints.filter(endpoint => endpoint.conditions?.ready === true).length;
  const terminating = endpoints.filter(endpoint => endpoint.conditions?.terminating === true).length;
  const service = serviceForEndpointSlice(resources, item);

  return (
    <div className="details-stack">
      <ProblemsBanner item={item} />
      <KindSummary
        title={summaryTitle(item.kind)}
        icon={Network}
        tiles={[
          { label: 'Address type', value: raw.addressType ?? 'IPv4' },
          { label: 'Endpoints', value: endpoints.length },
          { label: 'Ready', value: ready, tone: 'ok' },
          { label: 'Terminating', value: terminating, tone: terminating ? 'warn' : 'muted' },
        ]}
        rows={[
          {
            label: 'Service',
            value: service
              ? <button type="button" className="details-link" onClick={() => onNavigate(service)}>Service/{service.name}</button>
              : <span>{item.labels?.['kubernetes.io/service-name'] ?? 'Not loaded'}</span>,
          },
          { label: 'Node', value: item.labels?.['kubernetes.io/node-name'] ?? '—' },
        ]}
      />

      <DetailsSection title={`Ports (${ports.length})`}>
        <DetailTable
          columns={['Name', 'Port', 'Protocol', 'App protocol']}
          rows={ports.map(port => [port.name ?? '—', port.port ?? '—', port.protocol ?? 'TCP', port.appProtocol ?? '—'])}
          empty="This endpoint slice does not expose ports."
        />
      </DetailsSection>

      <DetailsSection title={`Endpoints (${endpoints.length})`}>
        <DetailTable
          columns={['Addresses', 'Ready', 'Target', 'Node']}
          rows={endpoints.map((endpoint) => [
            (endpoint.addresses ?? []).join(', ') || '—',
            endpoint.conditions?.ready === true ? 'Ready' : endpoint.conditions?.serving === true ? 'Serving' : 'Not ready',
            endpoint.targetRef?.name ?? '—',
            endpoint.nodeName ?? '—',
          ])}
          empty="This endpoint slice has no endpoints."
        />
      </DetailsSection>

      <UsedByList item={item} onNavigate={onNavigate} />
      <MetadataBlock item={item} onNavigate={onNavigate} />
    </div>
  );
}
