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
  | 'ReplicaSet'
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
  | 'CustomResourceDefinition'
  | 'ServiceAccount'
  | 'Role'
  | 'RoleBinding'
  | 'ClusterRole'
  | 'ClusterRoleBinding';

export interface ResourceContainer {
  role?: 'application' | 'sidecar' | 'init' | 'ephemeral';
  state?: 'running' | 'waiting' | 'terminated' | 'unknown';
  reason?: string;
  message?: string;
  exitCode?: number;
  name: string;
  image: string;
  ready: boolean;
  restarts: number;
  port: string;
}

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
  raw?: Record<string, any>;
  /* enrichments for the detail view (mock / future core) */
  labels?: Record<string, string>;
  containers?: ResourceContainer[];
  image?: string;
  dataKeys?: number;
  secretType?: string;
  serviceType?: string;
  clusterIP?: string;
  volume?: string;
  storageClass?: string;
  accessModes?: string;
  reclaimPolicy?: string;
  nodeRoles?: string;
  nodeVersion?: string;
  nodeCpu?: string;
  nodeMem?: string;
  nodePods?: string;
  nodeIp?: string;
  nodeOs?: string;
  ingressHosts?: string;
  ingressClass?: string;
  replicas?: number;
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
