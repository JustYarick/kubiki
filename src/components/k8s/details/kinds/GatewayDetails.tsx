import { Route, Waypoints } from 'lucide-react';
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

interface GatewayDetailsProps {
  item: ResourceItem;
  onNavigate: (item: ResourceItem) => void;
}

const ROUTES = ['HTTPRoute', 'GRPCRoute', 'TCPRoute', 'UDPRoute', 'TLSRoute'];

function isRoute(kind: string): boolean {
  return ROUTES.includes(kind) || kind.endsWith('Route');
}

/** Gateway API: gateways, classes, routes and the policies around them. */
export function GatewayDetails({ item, onNavigate }: GatewayDetailsProps) {
  const resources = useResourceStore(state => state.resources);
  const raw = item.raw ?? {};
  const spec = raw.spec ?? {};
  const status = raw.status ?? {};

  if (item.kind === 'GatewayClass') {
    return <GatewayClassDetails item={item} onNavigate={onNavigate} />;
  }

  if (item.kind === 'ReferenceGrant') {
    const from: any[] = spec.from ?? [];
    const to: any[] = spec.to ?? [];
    return (
      <div className="details-stack">
        <ProblemsBanner item={item} />
        <KindSummary
          title={summaryTitle(item.kind)}
          icon={Waypoints}
          tiles={[
            { label: 'Allowed sources', value: from.length || '—' },
            { label: 'Allowed targets', value: to.length || '—', tone: 'muted' },
          ]}
          rows={[{ label: 'Scope', value: item.namespace ?? 'cluster' }]}
        />
        <DetailsSection title={`Allowed sources (${from.length})`}>
          <DetailTable
            columns={['Group', 'Kind', 'Namespace']}
            rows={from.map(entry => [entry.group ?? '—', entry.kind ?? '—', entry.namespace ?? '—'])}
            empty="This grant does not allow any source."
          />
        </DetailsSection>
        <DetailsSection title={`Allowed targets (${to.length})`}>
          <DetailTable
            columns={['Group', 'Kind', 'Name']}
            rows={to.map(entry => [entry.group ?? '—', entry.kind ?? '—', entry.name ?? '—'])}
            empty="This grant does not allow any target."
          />
        </DetailsSection>
        <UsedByList item={item} onNavigate={onNavigate} />
        <MetadataBlock item={item} onNavigate={onNavigate} />
      </div>
    );
  }

  if (item.kind === 'BackendTLSPolicy') {
    const targetRefs: any[] = spec.targetRefs ?? [];
    const validation = spec.validation ?? {};
    return (
      <div className="details-stack">
        <ProblemsBanner item={item} />
        <KindSummary
          title={summaryTitle(item.kind)}
          icon={Waypoints}
          tiles={[
            { label: 'Targets', value: targetRefs.length || '—' },
            { label: 'Hostname', value: validation.hostname ?? '—', tone: 'muted' },
          ]}
          rows={[{ label: 'Well-known CA', value: validation.wellKnownCACertificates ?? '—' }]}
        />
        <DetailsSection title={`Target services (${targetRefs.length})`}>
          <DetailTable
            columns={['Group', 'Kind', 'Name']}
            rows={targetRefs.map(ref => [ref.group ?? '—', ref.kind ?? 'Service', ref.name ?? '—'])}
            empty="This policy does not target any service."
          />
        </DetailsSection>
        <DetailsSection title="Certificate validation">
          <DetailTable
            columns={['CA reference', 'Kind', 'Name']}
            rows={(validation.caCertificateRefs ?? []).map((ref: any) => [ref.group ?? '—', ref.kind ?? '—', ref.name ?? '—'])}
            empty="No explicit certificate authority reference. The well-known CA of the cluster is used."
          />
        </DetailsSection>
        <UsedByList item={item} onNavigate={onNavigate} />
        <ConditionsTable conditions={status.conditions} />
        <MetadataBlock item={item} onNavigate={onNavigate} />
      </div>
    );
  }

  if (isRoute(item.kind)) {
    const parentRefs: any[] = spec.parentRefs ?? [];
    const hostnames: string[] = spec.hostnames ?? [];
    const rules: any[] = spec.rules ?? [];
    const backendRows = rules.flatMap((rule: any, ruleIndex: number) =>
      (rule.backendRefs ?? []).map((backend: any) => [
        `Rule ${ruleIndex + 1}`,
        backend.group ?? '—',
        backend.kind ?? 'Service',
        backend.name ?? '—',
        backend.port ?? '—',
        backend.weight ?? '—',
      ]));

    return (
      <div className="details-stack">
        <ProblemsBanner item={item} />
        <KindSummary
          title={summaryTitle(item.kind)}
          icon={Route}
          tiles={[
            { label: 'Hostnames', value: hostnames.length ? hostnames.join(', ') : 'All hosts', tone: 'info' },
            { label: 'Parent gateways', value: parentRefs.length || '—' },
            { label: 'Rules', value: rules.length || '—', tone: 'muted' },
            { label: 'Backends', value: backendRows.length || '—', tone: 'muted' },
          ]}
          rows={[{ label: 'Accepted', value: status.parents?.length ? status.parents.filter((parent: any) => parent.conditions?.some((condition: any) => condition.type === 'Accepted' && condition.status === 'True')).length : '—' }]}
        />
        <DetailsSection title={`Parent gateways (${parentRefs.length})`}>
          <DetailTable
            columns={['Gateway', 'Section', 'Port', 'Accepted']}
            rows={parentRefs.map((ref) => {
              const parent = resourceByRef(resources, { kind: ref.kind ?? 'Gateway', name: ref.name, namespace: ref.namespace ?? item.namespace });
              const attached = status.parents?.find((entry: any) => entry.parentRef?.name === ref.name);
              const accepted = attached?.conditions?.some((condition: any) => condition.type === 'Accepted' && condition.status === 'True');
              return [
                parent
                  ? <button key={parent.uid} type="button" className="details-link" onClick={() => onNavigate(parent)}>{ref.name}</button>
                  : ref.name ?? '—',
                ref.sectionName ?? '—',
                ref.port ?? '—',
                accepted === undefined ? '—' : accepted ? 'Accepted' : 'Not accepted',
              ];
            })}
            empty="This route is not attached to a gateway."
          />
        </DetailsSection>
        <DetailsSection title={`Backend references (${backendRows.length})`}>
          <DetailTable
            columns={['Rule', 'Group', 'Kind', 'Name', 'Port', 'Weight']}
            rows={backendRows}
            empty="This route does not define any backend."
          />
        </DetailsSection>
        <UsedByList item={item} onNavigate={onNavigate} />
        <ConditionsTable conditions={status.conditions} />
        <MetadataBlock item={item} onNavigate={onNavigate} />
      </div>
    );
  }

  // Gateway
  const listeners: any[] = spec.listeners ?? [];
  const statusListeners: any[] = status.listeners ?? [];
  const addresses: any[] = status.addresses ?? [];
  const gatewayClass = spec.gatewayClassName
    ? resourceByRef(resources, { kind: 'GatewayClass', name: spec.gatewayClassName })
    : undefined;

  return (
    <div className="details-stack">
      <ProblemsBanner item={item} />
      <KindSummary
        title={summaryTitle(item.kind)}
        icon={Waypoints}
        tiles={[
          { label: 'Listeners', value: listeners.length },
          { label: 'Ready listeners', value: statusListeners.filter(listener => listener.conditions?.some((condition: any) => condition.type === 'Ready' && condition.status === 'True')).length, tone: 'ok' },
          { label: 'Addresses', value: addresses.length || '—', tone: 'muted' },
          { label: 'Class', value: spec.gatewayClassName ?? '—', tone: 'info' },
        ]}
        rows={[
          {
            label: 'Gateway class',
            value: gatewayClass
              ? <button type="button" className="details-link" onClick={() => onNavigate(gatewayClass)}>{gatewayClass.name}</button>
              : <span>{spec.gatewayClassName ?? '—'}</span>,
          },
          {
            label: 'Addresses',
            value: addresses.length
              ? addresses.map((address: any) => address.value ?? address.type).join(', ')
              : 'Pending assignment',
          },
        ]}
      />

      <DetailsSection title={`Listeners (${listeners.length})`}>
        <DetailTable
          columns={['Name', 'Port', 'Protocol', 'Hostname', 'TLS', 'Attached routes']}
          rows={listeners.map(listener => {
            const statusListener = statusListeners.find(entry => entry.name === listener.name);
            const attached = statusListener?.attachedRoutes ?? 0;
            return [
              listener.name ?? '—',
              listener.port ?? '—',
              listener.protocol ?? '—',
              listener.hostname ?? 'All hosts',
              listener.tls?.mode ?? (listener.protocol?.startsWith('HTTPS') || listener.protocol === 'TLS' ? 'Terminate' : '—'),
              attached,
            ];
          })}
          empty="This gateway does not define any listener."
        />
      </DetailsSection>

      <UsedByList item={item} onNavigate={onNavigate} />
      <ConditionsTable conditions={status.conditions} />
      <MetadataBlock item={item} onNavigate={onNavigate} />
    </div>
  );
}

function GatewayClassDetails({ item, onNavigate }: GatewayDetailsProps) {
  const raw = item.raw ?? {};
  const spec = raw.spec ?? {};
  const status = raw.status ?? {};
  const parameters = spec.parametersRef ?? {};
  return (
    <div className="details-stack">
      <ProblemsBanner item={item} />
      <KindSummary
        title={summaryTitle(item.kind)}
        icon={Waypoints}
        tiles={[
          { label: 'Controller', value: spec.controllerName ?? '—', tone: 'info' },
          { label: 'Parameters', value: parameters.kind ?? '—', tone: 'muted' },
        ]}
        rows={[{ label: 'Parameter reference', value: parameters.name ? `${parameters.kind}/${parameters.name}` : '—' }]}
      />
      <UsedByList item={item} onNavigate={onNavigate} />
      <ConditionsTable conditions={status.conditions} />
      <MetadataBlock item={item} onNavigate={onNavigate} />
    </div>
  );
}
