import type { ResourceWatchProvider } from './watch_types';
import type { ReadPriority } from './initial_sync_queue';
import type { ReadLane } from './read_queue';
import type { KubeContextInfo, ResourceItem, ResourceKind } from '../types/k8s';
import type { ResourceRef } from '../core/resources/resource_types';
import type { BatchResult, BatchStep } from './mutations';

export interface ReadResourceOptions {
  metadataOnly?: boolean;
  labelSelector?: string;
  fieldSelector?: string;
  limit?: number;
  projection?: 'search';
  priority?: ReadPriority;
  lane?: ReadLane;
}

/** The transport must reject with K8sRequestError; reads never substitute demo data. */
export interface KubernetesProvider extends ResourceWatchProvider {
  readonly supportsResourceWatch: boolean;
  resetResourceWatches(): Promise<void>;
  readonly demo: boolean;
  getContexts(): Promise<KubeContextInfo[]>;
  getKubeconfigPath(): Promise<string>;
  setKubeconfigPath(path: string | null): Promise<KubeContextInfo[]>;
  pingCluster(context: string): Promise<{ status: string; version?: string }>;
  getNamespaces(context: string): Promise<string[]>;
  getApiResources(context: string): Promise<import('../core/resources/resource_types').ResourceType[]>;
  getResources(context: string, kind: ResourceKind, namespace?: string, signal?: AbortSignal, options?: ReadResourceOptions): Promise<ResourceItem[]>;
  getResource?(context: string, kind: ResourceKind, name: string, namespace?: string, options?: { metadataOnly?: boolean; priority?: ReadPriority }, signal?: AbortSignal): Promise<ResourceItem>;
  getResourceCounts?(context: string, kinds: ResourceKind[], namespace?: string, signal?: AbortSignal): Promise<Partial<Record<ResourceKind, number>>>;
  getCustomResources(context: string, name: string, uid: string, namespace: string | null, signal?: AbortSignal, options?: ReadResourceOptions): Promise<import('./custom_resources').CustomResourceInstance[]>;
  getCustomResource?(context: string, crdName: string, uid: string, namespace: string | null, name: string, options?: { metadataOnly?: boolean; priority?: ReadPriority }, signal?: AbortSignal): Promise<import('./custom_resources').CustomResourceInstance>;
  getCustomSearchInventory?(context: string, namespace: string | null, signal?: AbortSignal): Promise<{ items: import('./custom_resources').CustomResourceInstance[]; errors: string[] }>;
  getPodMetric?(context: string, namespace: string, name: string, signal?: AbortSignal): Promise<import('./overview_metrics').PodMetric>;
  getLogs(context: string, name: string, namespace: string, container?: string): Promise<string>;
  getOverviewMetrics(context: string, namespace: string | null, signal?: AbortSignal): Promise<import('./overview_metrics').OverviewMetrics>;
  getHelmInventory(context: string, namespace: string | null, signal?: AbortSignal): Promise<import('./helm_types').HelmRelease[]>;
  getHelmHistory(context: string, namespace: string, name: string, signal?: AbortSignal): Promise<import('./helm_types').HelmHistory[]>;
  getHelmContent(context: string, namespace: string, name: string, revision: number, document: import('./helm_types').HelmDocument, signal?: AbortSignal): Promise<string>;
  getHelmRepositories(signal?: AbortSignal): Promise<import('./helm_types').HelmRepo[]>;
  updateSecretData(request: import('./secret_data').SecretDataRequest): Promise<Record<string, any>>;
  scaleWorkload(context: string, kind: string, name: string, namespace: string, replicas: number, uid: string, resourceVersion: string): Promise<boolean>;
  applyManifest(context: string, manifest: string, item?: ResourceItem): Promise<string>;
  deleteResource(context: string, kind: string, name: string, namespace: string | undefined, uid: string, resourceVersion: string, apiVersion?: string): Promise<string>;
  evictPod(context: string, name: string, namespace: string, uid: string, resourceVersion: string): Promise<string>;
  /** One user action, one confirmation, for every step in the batch. */
  applyBatch(primary: ResourceRef, steps: BatchStep[]): Promise<BatchResult>;
}
