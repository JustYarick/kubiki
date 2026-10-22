import { ListChecks, Webhook } from 'lucide-react';
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

interface AdmissionDetailsProps {
  item: ResourceItem;
  onNavigate: (item: ResourceItem) => void;
}

function ruleSummary(rules: any[] | undefined): string {
  if (!rules?.length) return 'All resources';
  return rules.map(rule => {
    const groups = rule.apiGroups?.length ? rule.apiGroups.join(', ') : '*';
    const versions = rule.apiVersions?.length ? rule.apiVersions.join(', ') : '*';
    const resources = rule.resources?.length ? rule.resources.join(', ') : '*';
    const operations = rule.operations?.length ? rule.operations.join('/') : '*';
    return `${groups}/${versions} ${resources} · ${operations}`;
  }).join(' | ');
}

function clientTarget(clientConfig: any): string {
  if (!clientConfig) return '—';
  if (clientConfig.service) return `Service ${clientConfig.service.namespace}/${clientConfig.service.name}${clientConfig.service.path ?? ''}`;
  if (clientConfig.url) return clientConfig.url;
  return '—';
}

/** Mutating and validating webhook configurations. */
export function WebhookConfigurationDetails({ item, onNavigate }: AdmissionDetailsProps) {
  const webhooks: any[] = item.raw?.webhooks ?? [];
  const policies = [...new Set(webhooks.map(webhook => webhook.failurePolicy ?? 'Fail'))];

  return (
    <div className="details-stack">
      <ProblemsBanner item={item} />

      <KindSummary
        title={summaryTitle(item.kind)}
        icon={Webhook}
        tiles={[
          { label: 'Webhooks', value: webhooks.length },
          { label: 'Failure policy', value: policies.join(', ') || '—', tone: policies.includes('Fail') ? 'warn' : 'ok' },
          { label: 'Timeout', value: webhooks[0]?.timeoutSeconds ? `${webhooks[0].timeoutSeconds}s` : 'Default (10s)', tone: 'muted' },
        ]}
        rows={[{ label: 'Scope', value: 'Cluster wide' }]}
      />

      <DetailsSection title={`Webhooks (${webhooks.length})`}>
        <DetailTable
          columns={['Name', 'Target', 'Rules', 'Failure policy', 'Side effects', 'Timeout']}
          rows={webhooks.map(webhook => [
            webhook.name ?? '—',
            clientTarget(webhook.clientConfig),
            ruleSummary(webhook.rules),
            webhook.failurePolicy ?? 'Fail',
            webhook.sideEffects ?? 'Unknown',
            webhook.timeoutSeconds ? `${webhook.timeoutSeconds}s` : '10s',
          ])}
          empty="This configuration does not register any webhook."
        />
      </DetailsSection>

      <UsedByList item={item} onNavigate={onNavigate} />
      <MetadataBlock item={item} onNavigate={onNavigate} />
    </div>
  );
}

/** Validating and mutating admission policies. */
export function AdmissionPolicyDetails({ item, onNavigate }: AdmissionDetailsProps) {
  const raw = item.raw ?? {};
  const spec = raw.spec ?? {};
  const constraints = spec.matchConstraints ?? {};
  const resourceRules: any[] = constraints.resourceRules ?? [];
  const validations: any[] = spec.validations ?? [];
  const variables: any[] = spec.variables ?? [];
  const auditAnnotations: any[] = spec.auditAnnotations ?? [];

  return (
    <div className="details-stack">
      <ProblemsBanner item={item} />

      <KindSummary
        title={summaryTitle(item.kind)}
        icon={ListChecks}
        tiles={[
          { label: 'Failure policy', value: spec.failurePolicy ?? 'Fail', tone: spec.failurePolicy === 'Ignore' ? 'ok' : 'warn' },
          { label: 'Match policy', value: constraints.matchPolicy ?? 'Equivalent', tone: 'muted' },
          { label: 'Validations', value: validations.length || '—' },
          { label: 'Variables', value: variables.length || '—', tone: 'muted' },
        ]}
        rows={[
          { label: 'Reinvocation policy', value: spec.reinvocationPolicy ?? 'Never' },
          { label: 'Namespace selector', value: constraints.namespaceSelector ? Object.entries(constraints.namespaceSelector.matchLabels ?? {}).map(([key, value]) => `${key}=${value}`).join(', ') : 'All namespaces' },
        ]}
      />

      <DetailsSection title={`Match constraints (${resourceRules.length})`}>
        <DetailTable
          columns={['API groups', 'API versions', 'Resources', 'Operations', 'Scope']}
          rows={resourceRules.map(rule => [
            rule.apiGroups?.join(', ') ?? '*',
            rule.apiVersions?.join(', ') ?? '*',
            rule.resources?.join(', ') ?? '*',
            rule.operations?.join(', ') ?? '*',
            rule.scope ?? 'Cluster',
          ])}
          empty="The policy matches every resource of the cluster."
        />
      </DetailsSection>

      {!!validations.length && (
        <DetailsSection title={`Validations (${validations.length})`}>
          <DetailTable
            columns={['Expression', 'Message', 'Reason']}
            rows={validations.map(validation => [
              validation.expression ?? '—',
              validation.message ?? '—',
              validation.reason ?? '—',
            ])}
          />
        </DetailsSection>
      )}

      {!!variables.length && (
        <DetailsSection title={`Variables (${variables.length})`}>
          <DetailTable
            columns={['Name', 'Expression']}
            rows={variables.map(variable => [variable.name ?? '—', variable.expression ?? '—'])}
          />
        </DetailsSection>
      )}

      {!!auditAnnotations.length && (
        <DetailsSection title={`Audit annotations (${auditAnnotations.length})`}>
          <DetailTable
            columns={['Key', 'Value']}
            rows={auditAnnotations.map(annotation => [annotation.key ?? '—', annotation.value ?? '—'])}
          />
        </DetailsSection>
      )}

      <UsedByList item={item} onNavigate={onNavigate} />
      <ConditionsTable conditions={raw.status?.conditions} />
      <MetadataBlock item={item} onNavigate={onNavigate} />
    </div>
  );
}

/** Bindings that attach a policy to the matching resources. */
export function AdmissionPolicyBindingDetails({ item, onNavigate }: AdmissionDetailsProps) {
  const resources = useResourceStore(state => state.resources);
  const raw = item.raw ?? {};
  const spec = raw.spec ?? {};
  const matchResources = spec.matchResources ?? {};
  const resourceRules: any[] = matchResources.resourceRules ?? [];
  const policyName = spec.policyName;
  const policy = policyName
    ? resourceByRef(resources, { kind: item.kind.replace('Binding', ''), name: policyName })
    : undefined;

  return (
    <div className="details-stack">
      <ProblemsBanner item={item} />

      <KindSummary
        title={summaryTitle(item.kind)}
        icon={ListChecks}
        tiles={[
          { label: 'Validation actions', value: spec.validationActions ?? 'Deny' },
          { label: 'Match rules', value: resourceRules.length || '—', tone: 'muted' },
        ]}
        rows={[
          {
            label: 'Policy',
            value: policyName
              ? policy
                ? <button type="button" className="details-link" onClick={() => onNavigate(policy)}>{policyName}</button>
                : <span>{policyName}</span>
              : '—',
          },
          { label: 'Parameters', value: spec.paramRef ? `${spec.paramRef.kind}/${spec.paramRef.name}` : '—' },
          { label: 'Match policy', value: matchResources.matchPolicy ?? 'Equivalent' },
        ]}
      />

      <DetailsSection title={`Match resources (${resourceRules.length})`}>
        <DetailTable
          columns={['API groups', 'API versions', 'Resources', 'Operations', 'Scope']}
          rows={resourceRules.map(rule => [
            rule.apiGroups?.join(', ') ?? '*',
            rule.apiVersions?.join(', ') ?? '*',
            rule.resources?.join(', ') ?? '*',
            rule.operations?.join(', ') ?? '*',
            rule.scope ?? 'Cluster',
          ])}
          empty="The binding matches every resource of the cluster."
        />
      </DetailsSection>

      <UsedByList item={item} onNavigate={onNavigate} />
      <ConditionsTable conditions={raw.status?.conditions} />
      <MetadataBlock item={item} onNavigate={onNavigate} />
    </div>
  );
}
