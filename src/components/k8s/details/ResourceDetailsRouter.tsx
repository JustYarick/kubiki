import { gitOpsFamily } from '../../../core/resources/gitops';
import { GitOpsDetails } from './kinds/GitOpsDetails';
import { presentationFor } from '../../../core/resources/resource_presentations';
import { ExtendedResourceDetails } from './kinds/ExtendedResourceDetails';
import { resourceBucket } from '../../../core/resources/custom_resource_types';
import type { ResourceItem } from '../../../types/k8s';
import { PodDetails } from './kinds/PodDetails';
import { WorkloadDetails } from './kinds/WorkloadDetails';
import { ServiceDetails } from './kinds/ServiceDetails';
import { IngressDetails } from './kinds/IngressDetails';
import { SecretDetails } from './kinds/SecretDetails';
import { ConfigMapDetails } from './kinds/ConfigMapDetails';
import { NodeDetails } from './kinds/NodeDetails';
import { PvcDetails } from './kinds/PvcDetails';
import { PvDetails } from './kinds/PvDetails';
import { JobDetails } from './kinds/JobDetails';
import { GenericResourceDetails } from './kinds/GenericResourceDetails';
import { ScalingDetails } from './kinds/ScalingDetails';
import { BudgetDetails } from './kinds/BudgetDetails';
import { LimitRangeDetails, QuotaDetails } from './kinds/QuotaDetails';
import { NetworkPolicyDetails } from './kinds/NetworkPolicyDetails';
import { EndpointDetails } from './kinds/EndpointDetails';
import {
  IngressClassDetails,
  LeaseDetails,
  PriorityClassDetails,
  RuntimeClassDetails,
} from './kinds/SchedulingDetails';
import {
  AdmissionPolicyBindingDetails,
  AdmissionPolicyDetails,
  WebhookConfigurationDetails,
} from './kinds/AdmissionDetails';
import {
  DeviceClassDetails,
  ResourceClaimDetails,
  ResourceClaimTemplateDetails,
  ResourceSliceDetails,
} from './kinds/DeviceDetails';
import { GatewayDetails } from './kinds/GatewayDetails';

interface ResourceDetailsRouterProps {
  item: ResourceItem;
  onNavigate: (item: ResourceItem) => void;
  onLogs: (container?: string) => void;
  onShell: (container?: string) => void;
}

const GATEWAY_API_KINDS = new Set([
  'Gateway', 'GatewayClass', 'HTTPRoute', 'GRPCRoute', 'TCPRoute', 'UDPRoute', 'TLSRoute',
  'ListenerSet', 'ReferenceGrant', 'BackendTLSPolicy',
]);

export function ResourceDetailsRouter({ item, onNavigate, onLogs, onShell }: ResourceDetailsRouterProps) {
  if (gitOpsFamily(item)) return <GitOpsDetails key={item.uid} item={item} onNavigate={onNavigate} />;
  switch (item.kind) {
    case 'Pod':
      return <PodDetails item={item} onNavigate={onNavigate} onLogs={onLogs} onShell={onShell} />;

    case 'Deployment':
    case 'StatefulSet':
    case 'DaemonSet':
    case 'ReplicaSet':
    case 'ReplicationController':
      return <WorkloadDetails item={item} onNavigate={onNavigate} onLogs={onLogs} onShell={onShell} />;

    case 'Service':
      return <ServiceDetails item={item} onNavigate={onNavigate} />;

    case 'Ingress':
      return <IngressDetails item={item} onNavigate={onNavigate} />;

    case 'Secret':
      return <SecretDetails item={item} onNavigate={onNavigate} />;

    case 'ConfigMap':
      return <ConfigMapDetails item={item} onNavigate={onNavigate} />;

    case 'Node':
      return <NodeDetails item={item} onNavigate={onNavigate} />;

    case 'PersistentVolumeClaim':
      return <PvcDetails item={item} onNavigate={onNavigate} />;

    case 'PersistentVolume':
      return <PvDetails item={item} onNavigate={onNavigate} />;

    case 'Job':
    case 'CronJob':
      return <JobDetails item={item} onNavigate={onNavigate} onLogs={onLogs} onShell={onShell} />;

    /* Autoscaling */
    case 'HorizontalPodAutoscaler':
    case 'VerticalPodAutoscaler':
      return <ScalingDetails item={item} onNavigate={onNavigate} />;

    /* Availability */
    case 'PodDisruptionBudget':
      return <BudgetDetails item={item} onNavigate={onNavigate} />;

    /* Quotas and limits */
    case 'ResourceQuota':
      return <QuotaDetails item={item} onNavigate={onNavigate} />;

    case 'LimitRange':
      return <LimitRangeDetails item={item} onNavigate={onNavigate} />;

    /* Network */
    case 'NetworkPolicy':
      return <NetworkPolicyDetails item={item} onNavigate={onNavigate} />;

    case 'Endpoints':
    case 'EndpointSlice':
      return <EndpointDetails item={item} onNavigate={onNavigate} />;

    case 'IngressClass':
      return <IngressClassDetails item={item} onNavigate={onNavigate} />;

    /* Scheduling */
    case 'PriorityClass':
      return <PriorityClassDetails item={item} onNavigate={onNavigate} />;

    case 'RuntimeClass':
      return <RuntimeClassDetails item={item} onNavigate={onNavigate} />;

    case 'Lease':
      return <LeaseDetails item={item} onNavigate={onNavigate} />;

    /* Admission control */
    case 'MutatingWebhookConfiguration':
    case 'ValidatingWebhookConfiguration':
      return <WebhookConfigurationDetails item={item} onNavigate={onNavigate} />;

    case 'ValidatingAdmissionPolicy':
    case 'MutatingAdmissionPolicy':
      return <AdmissionPolicyDetails item={item} onNavigate={onNavigate} />;

    case 'ValidatingAdmissionPolicyBinding':
    case 'MutatingAdmissionPolicyBinding':
      return <AdmissionPolicyBindingDetails item={item} onNavigate={onNavigate} />;

    /* Dynamic resource allocation */
    case 'DeviceClass':
      return <DeviceClassDetails item={item} onNavigate={onNavigate} />;

    case 'ResourceClaim':
      return <ResourceClaimDetails item={item} onNavigate={onNavigate} />;

    case 'ResourceClaimTemplate':
      return <ResourceClaimTemplateDetails item={item} onNavigate={onNavigate} />;

    case 'ResourceSlice':
      return <ResourceSliceDetails item={item} onNavigate={onNavigate} />;

    default:
      break;
  }
  if (GATEWAY_API_KINDS.has(item.kind)) return <GatewayDetails key={item.uid} item={item} onNavigate={onNavigate} />;
  if (presentationFor(item)) return <ExtendedResourceDetails item={item} onNavigate={onNavigate} />;
  if (resourceBucket(item).startsWith('custom:')) return <GenericResourceDetails item={item} onNavigate={onNavigate} />;
  return <GenericResourceDetails item={item} onNavigate={onNavigate} />;
}
