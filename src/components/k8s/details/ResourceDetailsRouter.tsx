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


const DETAIL_RENDERERS: Record<string, import('react').ComponentType<ResourceDetailsRouterProps>> = {
  Pod: PodDetails,
  Deployment: WorkloadDetails,
  StatefulSet: WorkloadDetails,
  DaemonSet: WorkloadDetails,
  ReplicaSet: WorkloadDetails,
  ReplicationController: WorkloadDetails,
  Service: ServiceDetails,
  Ingress: IngressDetails,
  Secret: SecretDetails,
  ConfigMap: ConfigMapDetails,
  Node: NodeDetails,
  PersistentVolumeClaim: PvcDetails,
  PersistentVolume: PvDetails,
  Job: JobDetails,
  CronJob: JobDetails,
  HorizontalPodAutoscaler: ScalingDetails,
  VerticalPodAutoscaler: ScalingDetails,
  PodDisruptionBudget: BudgetDetails,
  ResourceQuota: QuotaDetails,
  LimitRange: LimitRangeDetails,
  NetworkPolicy: NetworkPolicyDetails,
  Endpoints: EndpointDetails,
  EndpointSlice: EndpointDetails,
  IngressClass: IngressClassDetails,
  PriorityClass: PriorityClassDetails,
  RuntimeClass: RuntimeClassDetails,
  Lease: LeaseDetails,
  MutatingWebhookConfiguration: WebhookConfigurationDetails,
  ValidatingWebhookConfiguration: WebhookConfigurationDetails,
  ValidatingAdmissionPolicy: AdmissionPolicyDetails,
  MutatingAdmissionPolicy: AdmissionPolicyDetails,
  ValidatingAdmissionPolicyBinding: AdmissionPolicyBindingDetails,
  MutatingAdmissionPolicyBinding: AdmissionPolicyBindingDetails,
  DeviceClass: DeviceClassDetails,
  ResourceClaim: ResourceClaimDetails,
  ResourceClaimTemplate: ResourceClaimTemplateDetails,
  ResourceSlice: ResourceSliceDetails,
};

export function ResourceDetailsRouter({ item, onNavigate, onLogs, onShell }: ResourceDetailsRouterProps) {
  if (gitOpsFamily(item)) return <GitOpsDetails key={item.uid} item={item} onNavigate={onNavigate} />;
  const builtin = !resourceBucket(item).startsWith('custom:');
  const Renderer = builtin ? DETAIL_RENDERERS[item.kind] : item.apiVersion.startsWith('autoscaling.k8s.io/') && item.kind === 'VerticalPodAutoscaler' ? ScalingDetails : undefined;
  if (Renderer) return <Renderer item={item} onNavigate={onNavigate} onLogs={onLogs} onShell={onShell} />;
  if (item.apiVersion.startsWith('gateway.networking.k8s.io/') && GATEWAY_API_KINDS.has(item.kind)) return <GatewayDetails key={item.uid} item={item} onNavigate={onNavigate} />;
  if (presentationFor(item)) return <ExtendedResourceDetails item={item} onNavigate={onNavigate} />;
  if (resourceBucket(item).startsWith('custom:')) return <GenericResourceDetails item={item} onNavigate={onNavigate} />;
  return <GenericResourceDetails item={item} onNavigate={onNavigate} />;
}
