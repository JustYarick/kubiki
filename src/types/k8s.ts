export interface KubeContextInfo {
  name: string;
  cluster: string;
  user: string;
  namespace?: string | null;
  is_current: boolean;
}

export type ResourceKind =
  | 'Pod'
  | 'Deployment'
  | 'StatefulSet'
  | 'DaemonSet'
  | 'Job'
  | 'CronJob'
  | 'Service'
  | 'Ingress'
  | 'ConfigMap'
  | 'Secret'
  | 'PersistentVolumeClaim'
  | 'PersistentVolume'
  | 'StorageClass'
  | 'Node'
  | 'Namespace'
  | 'Event'
  | 'CustomResourceDefinition';

export interface ResourceItem {
  uid: string;
  name: string;
  namespace?: string;
  kind: ResourceKind;
  apiVersion: string;
  creationTimestamp?: string;
  status?: string;
  ready?: string;
  restarts?: number;
  cpu?: string;
  memory?: string;
  ip?: string;
  node?: string;
  age?: string;
  rawYaml?: string;
  metadata?: Record<string, unknown>;
  spec?: Record<string, unknown>;
  statusRaw?: Record<string, unknown>;
}

export interface ResourceDeltaPayload {
  type: 'Applied' | 'Deleted' | 'Restarted';
  payload: {
    gvk?: string;
    uid?: string;
    name?: string;
    namespace?: string | null;
    data?: ResourceItem;
    items?: ResourceItem[];
  };
}
