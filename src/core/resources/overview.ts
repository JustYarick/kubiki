import { inNamespaceScope } from './namespace_scope';
import type { ResourceItem, ResourceKind } from '../../types/k8s';
import type { WatchState } from '../../providers/watch_types';
import { RESOURCE_TYPES } from './resource_types';
import { resourceIssues } from './diagnostics';
import { eventDetails } from './resource_events';
import { fastCompare } from './resource_sort';

export interface OverviewInput {
  resources: Record<ResourceKind, Map<string, ResourceItem>>;
  availableKinds?: readonly string[] | null;
  namespace: string;
  context: string | null;
  syncMode: string;
  loading: boolean;
  connected: boolean;
  watchStates: Partial<Record<ResourceKind, WatchState>>;
  loadErrors: Partial<Record<ResourceKind, { message: string }>>;
  onDemand?: boolean;
}
export function buildOverview(input: OverviewInput) {
  const { namespace, context, resources, watchStates, loadErrors } = input;
  const inventory = RESOURCE_TYPES.filter(type => (!input.availableKinds || input.availableKinds.includes(type.kind)) && (namespace === 'all' || type.namespaced)).map(type => {
    const kind = type.kind as ResourceKind;
    const watch = watchStates[kind];
    const tracked = input.syncMode === 'watch' || input.onDemand;
    const covered = !tracked || !!watch && watch.query.context === context && (!type.namespaced || watch.query.namespace === null || watch.query.namespace === namespace);
    const items = covered ? [...resources[kind].values()].filter(item => inNamespaceScope(namespace, item.namespace)) : [];
    const hasSnapshot = tracked ? covered && watch?.hasSnapshot === true : items.length > 0 || input.connected && !input.loading && !loadErrors[kind];
    const state = tracked && !watch ? 'not loaded' : watch?.phase === 'stopped' ? hasSnapshot ? 'cached' : 'not loaded' : !covered ? 'loading' : loadErrors[kind] ? hasSnapshot ? 'stale' : 'unavailable'
      : !hasSnapshot ? input.loading || input.syncMode === 'watch' && (!watch || ['connecting', 'syncing'].includes(watch.phase)) ? 'loading' : 'unavailable'
      : !input.connected || input.syncMode === 'watch' && watch?.phase !== 'live' ? 'stale' : 'ready';
    return { kind, items: hasSnapshot ? items : [], count: hasSnapshot ? items.length : null, state, message: loadErrors[kind]?.message };
  });
  const row = (kind: ResourceKind) => inventory.find(entry => entry.kind === kind);
  const pods = row('Pod')?.items ?? [];
  const phases = { Running: 0, Pending: 0, Succeeded: 0, Failed: 0, Terminating: 0, Unknown: 0 };
  for (const pod of pods) {
    const rawPhase = pod.raw?.status?.phase ?? pod.status;
    const phase = pod.raw?.metadata?.deletionTimestamp ? 'Terminating' : ['Completed', 'Complete'].includes(rawPhase) ? 'Succeeded' : rawPhase;
    phases[Object.prototype.hasOwnProperty.call(phases, phase) ? phase as keyof typeof phases : 'Unknown']++;
  }
  const issues = inventory.filter(entry => entry.kind !== 'Event').flatMap(entry => entry.items.flatMap(item => {
    const found = resourceIssues(item);
    return found.length ? [{ item, issues: found, severity: found.some(issue => issue.severity === 'error') ? 'error' : 'warning' }] : [];
  })).sort((a, b) => Number(b.severity === 'error') - Number(a.severity === 'error') || fastCompare(a.item.name, b.item.name));
  const workloadKinds: ResourceKind[] = ['Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob'];
  const workloads = workloadKinds.map(row);
  return {
    inventory, row, phases, issues,
    total: inventory.filter(entry => entry.kind !== 'Event').reduce((sum, entry) => sum + (entry.count ?? 0), 0),
    incomplete: inventory.filter(entry => !['ready', 'not loaded', 'cached'].includes(entry.state)),
    workloads: workloads.every(entry => entry?.count !== null) ? workloads.reduce((sum, entry) => sum + (entry?.count ?? 0), 0) : null,
    restarts: row('Pod')?.count === null ? null : pods.reduce((sum, pod) => {
      const status = pod.raw?.status ?? {};
      const containers = [...(status.containerStatuses ?? []), ...(status.initContainerStatuses ?? []), ...(status.ephemeralContainerStatuses ?? [])];
      return sum + (containers.length ? containers.reduce((total, container) => total + (container.restartCount ?? 0), 0) : pod.restarts ?? 0);
    }, 0),
    readyNodes: (row('Node')?.items ?? []).filter(node => (node.raw?.status?.conditions ?? []).find((condition: any) => condition.type === 'Ready')?.status === 'True' || !node.raw?.status?.conditions?.some((condition: any) => condition.type === 'Ready') && node.status === 'Ready').length,
    warningEvents: (row('Event')?.items ?? []).filter(event => eventDetails(event).warning).length,
  };
}
