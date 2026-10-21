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

interface ResourceDetailsRouterProps {
  item: ResourceItem;
  onNavigate: (item: ResourceItem) => void;
  onLogs: (container?: string) => void;
  onShell: (container?: string) => void;
}

export function ResourceDetailsRouter({ item, onNavigate, onLogs, onShell }: ResourceDetailsRouterProps) {
  if (gitOpsFamily(item)) return <GitOpsDetails key={item.uid} item={item} onNavigate={onNavigate} />;
  if (presentationFor(item)) return <ExtendedResourceDetails item={item} onNavigate={onNavigate} />;
  if (resourceBucket(item).startsWith('custom:')) return <GenericResourceDetails item={item} onNavigate={onNavigate} />;
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

    default:
      return <GenericResourceDetails item={item} onNavigate={onNavigate} />;
  }
}
