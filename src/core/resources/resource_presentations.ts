import type { ResourceItem } from '../../types/k8s';
import { RESOURCE_TYPES, parseApiVersion } from './resource_types';
import { gitOpsFamily } from './gitops';

export interface ResourceField { label: string; path: string }
export interface ResourcePresentation { fields: ResourceField[]; sections?: ResourceField[] }
const fields = (...entries: [string, string][]): ResourceField[] => entries.map(([label, path]) => ({ label, path }));
export const RESOURCE_PRESENTATIONS: Record<string, ResourcePresentation> = {
  HorizontalPodAutoscaler: { fields: fields(['Target', 'spec.scaleTargetRef.name'], ['Min Pods', 'spec.minReplicas'], ['Max Pods', 'spec.maxReplicas'], ['Current replicas', 'status.currentReplicas'], ['Desired replicas', 'status.desiredReplicas']), sections: fields(['Scaling behavior', 'spec.behavior']) },
  PodDisruptionBudget: { fields: fields(['Min available', 'spec.minAvailable'], ['Max unavailable', 'spec.maxUnavailable'], ['Healthy', 'status.currentHealthy'], ['Desired healthy', 'status.desiredHealthy'], ['Disruptions allowed', 'status.disruptionsAllowed']), sections: fields(['Pod selector', 'spec.selector'], ['Disrupted Pods', 'status.disruptedPods']) },
  ResourceQuota: { fields: fields(['Scopes', 'spec.scopes']), sections: fields(['Hard limits', 'spec.hard'], ['Usage', 'status.used'], ['Scope selector', 'spec.scopeSelector']) },
  LimitRange: { fields: [], sections: fields(['Container and Pod limits', 'spec.limits']) },
  NetworkPolicy: { fields: fields(['Policy types', 'spec.policyTypes']), sections: fields(['Pod selector', 'spec.podSelector'], ['Ingress rules', 'spec.ingress'], ['Egress rules', 'spec.egress']) },
  EndpointSlice: { fields: fields(['Address type', 'addressType'], ['Service', 'metadata.labels[kubernetes.io/service-name]']), sections: fields(['Ports', 'ports'], ['Endpoints', 'endpoints']) },
  Endpoints: { fields: [], sections: fields(['Endpoint subsets', 'subsets']) },
  IngressClass: { fields: fields(['Controller', 'spec.controller']), sections: fields(['Parameters', 'spec.parameters']) },
  PriorityClass: { fields: fields(['Value', 'value'], ['Global default', 'globalDefault'], ['Preemption policy', 'preemptionPolicy'], ['Description', 'description']) },
  RuntimeClass: { fields: fields(['Handler', 'handler']), sections: fields(['Overhead', 'overhead'], ['Scheduling', 'scheduling']) },
  Lease: { fields: fields(['Holder', 'spec.holderIdentity'], ['Duration (seconds)', 'spec.leaseDurationSeconds'], ['Acquired', 'spec.acquireTime'], ['Renewed', 'spec.renewTime'], ['Transitions', 'spec.leaseTransitions']) },
  MutatingWebhookConfiguration: { fields: [], sections: fields(['Mutating webhooks', 'webhooks']) },
  ValidatingWebhookConfiguration: { fields: [], sections: fields(['Validating webhooks', 'webhooks']) },
  ValidatingAdmissionPolicy: { fields: fields(['Failure policy', 'spec.failurePolicy']), sections: fields(['Match constraints', 'spec.matchConstraints'], ['Validations', 'spec.validations'], ['Variables', 'spec.variables'], ['Audit annotations', 'spec.auditAnnotations']) },
  MutatingAdmissionPolicy: { fields: fields(['Failure policy', 'spec.failurePolicy'], ['Reinvocation policy', 'spec.reinvocationPolicy']), sections: fields(['Match constraints', 'spec.matchConstraints'], ['Mutations', 'spec.mutations']) },
  ValidatingAdmissionPolicyBinding: { fields: fields(['Policy', 'spec.policyName'], ['Validation actions', 'spec.validationActions']), sections: fields(['Match resources', 'spec.matchResources'], ['Parameters', 'spec.paramRef']) },
  MutatingAdmissionPolicyBinding: { fields: fields(['Policy', 'spec.policyName']), sections: fields(['Match resources', 'spec.matchResources'], ['Parameters', 'spec.paramRef']) },
  DeviceClass: { fields: [], sections: fields(['Device selectors', 'spec.selectors'], ['Configuration', 'spec.config']) },
  ResourceClaim: { fields: [], sections: fields(['Device requests', 'spec.devices'], ['Allocation', 'status.allocation'], ['Reserved for', 'status.reservedFor']) },
  ResourceClaimTemplate: { fields: [], sections: fields(['Claim template', 'spec.spec']) },
  ResourceSlice: { fields: fields(['Driver', 'spec.driver'], ['Node', 'spec.nodeName'], ['Pool', 'spec.pool.name']), sections: fields(['Devices', 'spec.devices'], ['Node selector', 'spec.nodeSelector']) },
};

export function fieldValue(raw: unknown, path: string): unknown {
  return (path.match(/[^.[\]]+|\[[^\]]+\]/g) ?? []).reduce<any>((value, key) => value?.[key.startsWith('[') ? key.slice(1, -1) : key], raw);
}
export function fieldText(value: unknown): string | undefined {
  if (value == null) return;
  if (Array.isArray(value)) return value.every(entry => entry == null || typeof entry !== 'object') ? value.join(', ') : `${value.length} entries`;
  if (typeof value === 'object') return `${Object.keys(value).length} fields`;
  return String(value);
}
export function presentationFor(item: Pick<ResourceItem, 'kind' | 'apiVersion'>): ResourcePresentation | undefined {
  const group = parseApiVersion(item.apiVersion).group;
  if (group === 'autoscaling.k8s.io' && item.kind === 'VerticalPodAutoscaler') return { fields: fields(['Target', 'spec.targetRef.name'], ['Update mode', 'spec.updatePolicy.updateMode']), sections: fields(['Update policy', 'spec.updatePolicy'], ['Resource policy', 'spec.resourcePolicy'], ['Container recommendations', 'status.recommendation.containerRecommendations']) };
  if (group === 'gateway.networking.k8s.io') {
    if (item.kind === 'GatewayClass') return { fields: fields(['Controller', 'spec.controllerName'], ['Description', 'spec.description']), sections: fields(['Parameters reference', 'spec.parametersRef']) };
    if (item.kind === 'Gateway' || item.kind === 'ListenerSet') return { fields: fields(['Class', 'spec.gatewayClassName'], ['Parent Gateway', 'spec.parentRef.name'], ['Addresses', 'status.addresses']), sections: fields(['Listeners', 'spec.listeners'], ['Listener status', 'status.listeners'], ['Allowed listeners', 'spec.allowedListeners']) };
    if (item.kind.endsWith('Route')) return { fields: fields(['Hostnames', 'spec.hostnames'], ['Parent Gateways', 'spec.parentRefs']), sections: fields(['Parent references', 'spec.parentRefs'], ['Rules and backends', 'spec.rules'], ['Parent attachment status', 'status.parents']) };
    if (item.kind === 'ReferenceGrant') return { fields: [], sections: fields(['Allowed source namespaces and kinds', 'spec.from'], ['Allowed targets', 'spec.to']) };
    if (item.kind === 'BackendTLSPolicy') return { fields: fields(['Hostname', 'spec.validation.hostname'], ['Well-known CA certificates', 'spec.validation.wellKnownCACertificates']), sections: fields(['Target Services', 'spec.targetRefs'], ['TLS validation', 'spec.validation'], ['Policy status', 'status.ancestors']) };
  }
  const family = gitOpsFamily(item);
  if (family === 'argocd' && item.kind === 'AppProject') return { fields: fields(['Description', 'spec.description']), sections: fields(['Allowed repositories', 'spec.sourceRepos'], ['Destinations', 'spec.destinations'], ['Cluster resource allowlist', 'spec.clusterResourceWhitelist'], ['Namespace resource allowlist', 'spec.namespaceResourceWhitelist'], ['Roles', 'spec.roles'], ['Sync windows', 'spec.syncWindows']) };
  if (family === 'argocd' && item.kind === 'ApplicationSet') return { fields: fields(['Strategy', 'spec.strategy.type']), sections: fields(['Generators', 'spec.generators'], ['Application template', 'spec.template'], ['Sync policy', 'spec.syncPolicy'], ['Strategy', 'spec.strategy']) };
  if (family === 'argocd') return { fields: fields(['Health', 'status.health.status'], ['Sync', 'status.sync.status'], ['Project', 'spec.project'], ['Revision', 'status.sync.revision'], ['Destination namespace', 'spec.destination.namespace']), sections: fields(['Sources', 'spec.sources'], ['Source', 'spec.source'], ['Destination', 'spec.destination'], ['Sync policy', 'spec.syncPolicy']) };
  if (family === 'flux') {
    const common = fields(['Suspended', 'spec.suspend'], ['Interval', 'spec.interval']);
    const sourceSections = fields(['Revision selector', 'spec.ref'], ['Source reference', 'spec.sourceRef'], ['Artifact', 'status.artifact']);
    if (['GitRepository', 'OCIRepository', 'HelmRepository', 'Bucket', 'HelmChart', 'ExternalArtifact'].includes(item.kind)) return {
      fields: [...common, ...fields(['Repository', 'spec.url'], ['Provider', 'spec.provider'], ['Bucket', 'spec.bucketName'], ['Endpoint', 'spec.endpoint'], ['Chart', 'spec.chart'], ['Version', 'spec.version'], ['Revision', 'status.artifact.revision'], ['Credentials Secret', 'spec.secretRef.name'])],
      sections: [...sourceSections, ...fields(['Verification', 'spec.verify'], ['Included sources', 'spec.include'], ['Artifact source', 'spec.sourceRef'])],
    };
    if (item.kind === 'Kustomization') return {
      fields: [...common, ...fields(['Path', 'spec.path'], ['Source', 'spec.sourceRef.name'], ['Prune', 'spec.prune'], ['Wait for health', 'spec.wait'], ['Target namespace', 'spec.targetNamespace'], ['Applied revision', 'status.lastAppliedRevision'], ['Attempted revision', 'status.lastAttemptedRevision'])],
      sections: fields(['Source reference', 'spec.sourceRef'], ['Dependencies', 'spec.dependsOn'], ['Health checks', 'spec.healthChecks'], ['Post-build substitution', 'spec.postBuild'], ['Patches', 'spec.patches'], ['Decryption', 'spec.decryption']),
    };
    if (item.kind === 'HelmRelease') return {
      fields: [...common, ...fields(['Release name', 'spec.releaseName'], ['Target namespace', 'spec.targetNamespace'], ['Chart source', 'spec.chart.spec.sourceRef.name'], ['Chart reference', 'spec.chartRef.name'], ['Attempted revision', 'status.lastAttemptedRevision'], ['Failures', 'status.failures'])],
      sections: fields(['Chart', 'spec.chart'], ['Chart reference', 'spec.chartRef'], ['Dependencies', 'spec.dependsOn'], ['Values', 'spec.values'], ['Values references', 'spec.valuesFrom'], ['Install policy', 'spec.install'], ['Upgrade policy', 'spec.upgrade'], ['Drift detection', 'spec.driftDetection'], ['Release history', 'status.history']),
    };
    if (item.kind.startsWith('Image')) return {
      fields: [...common, ...fields(['Image', 'spec.image'], ['Repository reference', 'spec.imageRepositoryRef.name'], ['Latest image', 'status.latestImage'], ['Latest tag', 'status.latestRef.tag'], ['Last pushed commit', 'status.lastPushCommit'], ['Source', 'spec.sourceRef.name'])],
      sections: fields(['Image policy', 'spec.policy'], ['Tag filters', 'spec.filterTags'], ['Update strategy', 'spec.update'], ['Git settings', 'spec.git'], ['Last scan', 'status.lastScanResult'], ['Latest image reference', 'status.latestRef']),
    };
    return {
      fields: [...common, ...fields(['Type', 'spec.type'], ['Provider', 'spec.providerRef.name'], ['Address', 'spec.address'], ['Credential Secret', 'spec.secretRef.name'])],
      sections: fields(['Event sources', 'spec.eventSources'], ['Event metadata', 'spec.eventMetadata'], ['Event filters', 'spec.exclusionList'], ['Events', 'spec.events'], ['Resources', 'spec.resources']),
    };
  }
  return RESOURCE_TYPES.some(type => type.kind === item.kind && type.group === parseApiVersion(item.apiVersion).group) ? RESOURCE_PRESENTATIONS[item.kind] : undefined;
}
