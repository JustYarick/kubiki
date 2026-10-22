import { ShieldBan } from 'lucide-react';
import type { ResourceItem } from '../../../../types/k8s';
import { useResourceStore } from '../../../../state/resource_store';
import { podsForSelector } from '../../../../core/resources/detail_links';
import { summaryTitle } from '../../../../core/resources/kind_labels';
import { DetailsSection } from '../DetailsSection';
import { KindSummary } from '../blocks/KindSummary';
import { DetailTable } from '../blocks/DetailTable';
import { ProblemsBanner } from '../blocks/ProblemsBanner';
import { UsedByList } from '../blocks/UsedByList';
import { ConditionsTable } from '../blocks/ConditionsTable';
import { MetadataBlock } from '../blocks/MetadataBlock';

interface NetworkPolicyDetailsProps {
  item: ResourceItem;
  onNavigate: (item: ResourceItem) => void;
}

function peerLabel(peer: any): string {
  if (!peer) return '—';
  if (peer.ipBlock) return `${peer.ipBlock.cidr ?? ''}${peer.ipBlock.except?.length ? ` (except ${peer.ipBlock.except.join(', ')})` : ''}`;
  if (peer.namespaceSelector) return 'namespace selector';
  if (peer.podSelector) return 'pod selector';
  return '—';
}

function portsLabel(ports: any[] | undefined): string {
  if (!ports?.length) return 'All ports';
  return ports.map(port => `${port.protocol ?? 'TCP'}/${port.port ?? '*'}`).join(', ');
}

/** Network policies: traffic rules and the pods they apply to. */
export function NetworkPolicyDetails({ item, onNavigate }: NetworkPolicyDetailsProps) {
  const resources = useResourceStore(state => state.resources);
  const raw = item.raw ?? {};
  const spec = raw.spec ?? {};
  const status = raw.status ?? item.statusRaw ?? {};
  const ingress: any[] = spec.ingress ?? [];
  const egress: any[] = spec.egress ?? [];
  const selector = spec.podSelector;
  const pods = podsForSelector(resources, selector, item.namespace);

  return (
    <div className="details-stack">
      <ProblemsBanner item={item} />

      <KindSummary
        title={summaryTitle(item.kind)}
        icon={ShieldBan}
        tiles={[
          { label: 'Policy types', value: spec.policyTypes?.join(', ') || 'Ingress' },
          { label: 'Ingress rules', value: ingress.length },
          { label: 'Egress rules', value: egress.length },
          { label: 'Selected pods', value: pods.length, tone: 'muted' },
        ]}
        rows={[
          {
            label: 'Pod selector',
            value: selector
              ? Object.entries(selector.matchLabels ?? {}).map(([key, value]) => `${key}=${value}`).join(', ') || 'All pods in namespace'
              : 'All pods in namespace',
          },
          { label: 'Ingress action', value: 'Deny all traffic not matched by a rule' },
        ]}
      />

      <DetailsSection title={`Selected pods (${pods.length})`} label="Pods selected by this policy">
        <DetailTable
          columns={['Pod', 'Status', 'Node']}
          rows={pods.map(pod => [
            <button key={pod.uid} type="button" className="details-link" onClick={() => onNavigate(pod)}>{pod.name}</button>,
            pod.status ?? '—',
            pod.node ?? pod.raw?.spec?.nodeName ?? '—',
          ])}
          empty="No pod in this namespace matches the pod selector of this policy."
        />
      </DetailsSection>

      <DetailsSection title={`Ingress rules (${ingress.length})`}>
        <DetailTable
          columns={['From', 'Ports']}
          rows={ingress.map(rule => [
            rule.from?.length ? rule.from.map(peerLabel).join(', ') : 'All sources',
            portsLabel(rule.ports),
          ])}
          empty="No ingress rules. All ingress traffic to the selected pods is denied."
        />
      </DetailsSection>

      <DetailsSection title={`Egress rules (${egress.length})`}>
        <DetailTable
          columns={['To', 'Ports']}
          rows={egress.map(rule => [
            rule.to?.length ? rule.to.map(peerLabel).join(', ') : 'All destinations',
            portsLabel(rule.ports),
          ])}
          empty="No egress rules. All egress traffic of the selected pods is denied."
        />
      </DetailsSection>

      <UsedByList item={item} onNavigate={onNavigate} />
      <ConditionsTable conditions={status.conditions} />
      <MetadataBlock item={item} onNavigate={onNavigate} />
    </div>
  );
}
