import type { ResourceQuery } from '../core/resources/resource_types';
import type { K8sErrorPayload } from './errors';
import type { ResourceItem } from '../types/k8s';

export type WatchPhase = 'connecting' | 'syncing' | 'live' | 'reconnecting' | 'failed' | 'stopped';
export type WatchDelta = { type: 'Applied'; payload: { data: Record<string, any> } }
  | { type: 'Deleted'; payload: { uid: string } }
  | { type: 'Restarted'; payload: { items: Record<string, any>[] } };
export interface WatchMessage {
  sequence: number;
  event: { type: 'Delta'; payload: WatchDelta } | { type: 'Status'; payload: { phase: WatchPhase; error: K8sErrorPayload | null } };
}
export interface WatchBatch { subscription_id: string; query: ResourceQuery; messages: WatchMessage[] }
export interface WatchState { phase: WatchPhase; hasSnapshot: boolean; updatedAt?: number }
export interface WatchCommit {
  snapshot?: ResourceItem[];
  changes: Array<{ type: 'apply'; item: ResourceItem } | { type: 'delete'; uid: string }>;
  state: WatchState;
  error?: K8sErrorPayload;
}
export interface ResourceWatchProvider {
  watchResources(query: ResourceQuery, onBatch: (batch: WatchBatch) => void, signal: AbortSignal): Promise<() => void>;
}

export function sameQuery(a: ResourceQuery, b: ResourceQuery): boolean {
  return a.context === b.context && a.group === b.group && a.version === b.version && a.kind === b.kind && a.namespace === b.namespace;
}
