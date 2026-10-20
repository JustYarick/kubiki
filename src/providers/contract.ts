import type { KubeContextInfo, ResourceItem, ResourceKind } from '../types/k8s';

/** The transport must reject with K8sRequestError; reads never substitute demo data. */
export interface KubernetesProvider {
  readonly demo: boolean;
  getContexts(): Promise<KubeContextInfo[]>;
  pingCluster(context: string): Promise<{ status: string; version?: string }>;
  getNamespaces(context: string): Promise<string[]>;
  getResources(context: string, kind: ResourceKind, namespace?: string): Promise<ResourceItem[]>;
  getLogs(context: string, name: string, namespace: string, container?: string): Promise<string>;
  scaleWorkload(context: string, kind: string, name: string, namespace: string, replicas: number): Promise<boolean>;
}
