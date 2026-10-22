import type { ResourceWatchProvider } from './watch_types';
import type { KubeContextInfo, ResourceItem, ResourceKind } from '../types/k8s';
import type { ResourceRef } from '../core/resources/resource_types';
import type { BatchResult, BatchStep } from './mutations';

/** The transport must reject with K8sRequestError; reads never substitute demo data. */
export interface KubernetesProvider extends ResourceWatchProvider {
  readonly supportsResourceWatch: boolean;
  resetResourceWatches(): Promise<void>;
  readonly demo: boolean;
  getContexts(): Promise<KubeContextInfo[]>;
  pingCluster(context: string): Promise<{ status: string; version?: string }>;
  getNamespaces(context: string): Promise<string[]>;
  getApiResources(context: string): Promise<import('../core/resources/resource_types').ResourceType[]>;
  getResources(context: string, kind: ResourceKind, namespace?: string, signal?: AbortSignal): Promise<ResourceItem[]>;
  getCustomResources(context: string, name: string, uid: string, namespace: string | null, signal?: AbortSignal): Promise<import('./custom_resources').CustomResourceInstance[]>;
  getLogs(context: string, name: string, namespace: string, container?: string): Promise<string>;
  getOverviewMetrics(context: string, namespace: string | null, signal?: AbortSignal): Promise<import('./overview_metrics').OverviewMetrics>;
  getHelmReleases(context: string, namespace: string | null, offset?: number, signal?: AbortSignal): Promise<import('./helm_types').HelmReleasePage>;
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
