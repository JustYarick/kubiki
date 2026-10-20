import type { ResourceWatchProvider } from './watch_types';
import type { KubeContextInfo, ResourceItem, ResourceKind } from '../types/k8s';

/** The transport must reject with K8sRequestError; reads never substitute demo data. */
export interface KubernetesProvider extends ResourceWatchProvider {
  readonly supportsResourceWatch: boolean;
  resetResourceWatches(): Promise<void>;
  readonly demo: boolean;
  getContexts(): Promise<KubeContextInfo[]>;
  pingCluster(context: string): Promise<{ status: string; version?: string }>;
  getNamespaces(context: string): Promise<string[]>;
  getResources(context: string, kind: ResourceKind, namespace?: string): Promise<ResourceItem[]>;
  getLogs(context: string, name: string, namespace: string, container?: string): Promise<string>;
  updateSecretData(request: import('./secret_data').SecretDataRequest): Promise<Record<string, any>>;
  scaleWorkload(context: string, kind: string, name: string, namespace: string, replicas: number): Promise<boolean>;
}
