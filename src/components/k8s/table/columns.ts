import type { ResourceItem, ResourceKind } from '../../../types/k8s';
import { presentationFor, fieldText, fieldValue } from '../../../core/resources/resource_presentations';
import { resourceType, apiVersionFor as typeApiVersion } from '../../../core/resources/resource_types';
import { memoryText, quantity } from '../../../core/resources/quantities';
import type { WorkloadPodActivity } from '../../../core/resources/workload_pod_activity';

export interface ColumnDef {
  id: string;
  label: string;
  align?: 'right';
  mono?: boolean;
  /** Default pixel width for table-layout:fixed (resizable by the user). */
  size?: number;
  /** Tooltip shown on the cell — explains where the value comes from. */
  hint?: string;
  get: (i: ResourceItem) => string | undefined;
  podActivity?: (i: ResourceItem) => WorkloadPodActivity | undefined;
}

export const DEFAULT_COL_SIZE: Record<string, number> = {
  __index: 38,
  containers: 112, name: 240, namespace: 130, ready: 66, restarts: 84, status: 132, ip: 112, node: 96, age: 64,
  ports: 132, type: 112, clusterIP: 120, image: 220, keys: 74, volume: 132, claim: 168,
  storageclass: 132, reclaim: 92, roles: 152, version: 98, cpu: 112, mem: 172, pods: 130, replicas: 125,
  provisioner: 184, hosts: 220, class: 100, capacity: 90, group: 110,
  controlledBy: 140, qos: 80, duration: 80, suspend: 80, active: 64, lastSchedule: 100, externalIP: 140,
  selector: 150, address: 140, size: 80, taints: 64, nodeSelector: 140,
};

export const MIN_COL = 56;
export const MAX_COL = 520;

export const BASE_COLUMNS: ColumnDef[] = [
  { id: 'name', label: 'Name', mono: true, get: (i) => i.name },
  { id: 'namespace', label: 'Namespace', get: (i) => i.namespace },
];

export const columnsFor = (kind: ResourceKind, options?: { podsByNode?: Map<string, number>; podActivity?: Map<string, WorkloadPodActivity> }): ColumnDef[] => {
  const workloadPods: ColumnDef = {
    id: 'pods', label: 'Pods', hint: 'Ready / total existing Pods, including pending and terminating Pods',
    get: item => {
      const activity = options?.podActivity?.get(item.uid);
      return activity ? `${activity.ready}/${activity.total}` : undefined;
    },
    podActivity: item => options?.podActivity?.get(item.uid),
  };
  const presentation = presentationFor({ kind, apiVersion: typeApiVersion(resourceType(kind)) });
  if (presentation) return [BASE_COLUMNS[0], ...(resourceType(kind).namespaced ? [BASE_COLUMNS[1]] : []), ...presentation.fields.map((field, index) => ({ id: `field-${index}`, label: field.label, get: (item: ResourceItem) => fieldText(fieldValue(item.raw, field.path)) })), { id: 'status', label: 'Status', get: item => item.status }, { id: 'age', label: 'Age', get: item => item.age }];
  switch (kind) {
    case 'Pod':
      return [
        BASE_COLUMNS[0],
        { id: 'status', label: 'Status', get: (i) => i.status },
        { id: 'ready', label: 'Ready', align: 'right', mono: true, get: (i) => i.ready },
        { id: 'restarts', label: 'Restarts', align: 'right', mono: true, get: (i) => (i.restarts === undefined ? undefined : String(i.restarts)) },
        BASE_COLUMNS[1],
        { id: 'containers', label: 'Containers', get: (i) => String(i.containers?.length ?? 0) },
        { id: 'ip', label: 'IP', mono: true, get: (i) => i.ip },
        { id: 'node', label: 'Node', mono: true, get: (i) => i.node },
        { id: 'age', label: 'Age', align: 'right', get: (i) => i.age },
      ];
    case 'Deployment':
    case 'StatefulSet':
    case 'ReplicationController':
      return [
        ...BASE_COLUMNS,
        workloadPods,
        { id: 'status', label: 'Conditions', get: (i) => i.status },
        { id: 'image', label: 'Image', mono: true, get: (i) => i.image ?? undefined },
        { id: 'age', label: 'Age', align: 'right', get: (i) => i.age },
      ];
    case 'DaemonSet':
      return [
        ...BASE_COLUMNS,
        workloadPods,
        { id: 'nodeSelector', label: 'Node Selector', mono: true, get: (i) => i.selectorText || '—' },
        { id: 'status', label: 'Conditions', get: (i) => i.status },
        { id: 'image', label: 'Image', mono: true, get: (i) => i.image ?? undefined },
        { id: 'age', label: 'Age', align: 'right', get: (i) => i.age },
      ];
    case 'ReplicaSet':
      return [
        ...BASE_COLUMNS,
        workloadPods,
        { id: 'controlledBy', label: 'Controlled By', mono: true, get: (i) => i.controlledBy },
        { id: 'status', label: 'Conditions', get: (i) => i.status },
        { id: 'age', label: 'Age', align: 'right', get: (i) => i.age },
      ];
    case 'Job':
      return [
        ...BASE_COLUMNS,
        { id: 'ready', label: 'Completions', align: 'right', mono: true, get: (i) => i.ready },
        { id: 'duration', label: 'Duration', align: 'right', mono: true, get: (i) => i.duration || '—' },
        { id: 'status', label: 'Conditions', get: (i) => i.status },
        { id: 'image', label: 'Image', mono: true, get: (i) => i.image ?? undefined },
        { id: 'age', label: 'Age', align: 'right', get: (i) => i.age },
      ];
    case 'CronJob':
      return [
        ...BASE_COLUMNS,
        { id: 'ready', label: 'Schedule', mono: true, get: (i) => i.ready },
        { id: 'suspend', label: 'Suspend', get: (i) => i.status },
        { id: 'active', label: 'Active', align: 'right', mono: true, get: (i) => (i.activeJobs === undefined ? '0' : String(i.activeJobs)) },
        { id: 'lastSchedule', label: 'Last Schedule', align: 'right', get: (i) => i.lastScheduleTime || '—' },
        { id: 'age', label: 'Age', align: 'right', get: (i) => i.age },
      ];
    case 'Service':
      return [
        ...BASE_COLUMNS,
        { id: 'status', label: 'Type', get: (i) => i.serviceType },
        { id: 'clusterIP', label: 'Cluster IP', mono: true, get: (i) => i.clusterIP },
        { id: 'externalIP', label: 'External IP', mono: true, get: (i) => i.externalIP || '—' },
        { id: 'ports', label: 'Ports', mono: true, get: (i) => i.ports },
        { id: 'selector', label: 'Selector', mono: true, get: (i) => i.selectorText || '—' },
        { id: 'age', label: 'Age', align: 'right', get: (i) => i.age },
      ];
    case 'Ingress':
      return [
        ...BASE_COLUMNS,
        { id: 'hosts', label: 'Hosts', get: (i) => i.ingressHosts },
        { id: 'address', label: 'Address', mono: true, get: (i) => i.loadBalancer || '—' },
        { id: 'class', label: 'Class', get: (i) => i.ingressClass },
        { id: 'age', label: 'Age', align: 'right', get: (i) => i.age },
      ];
    case 'ConfigMap':
      return [
        ...BASE_COLUMNS,
        { id: 'keys', label: 'Keys', align: 'right', mono: true, get: (i) => (i.dataKeys === undefined ? undefined : String(i.dataKeys)) },
        { id: 'size', label: 'Size', align: 'right', mono: true, get: (i) => (i.sizeBytes ? memoryText(i.sizeBytes) : '—') },
        { id: 'age', label: 'Age', align: 'right', get: (i) => i.age },
      ];
    case 'Secret':
      return [
        ...BASE_COLUMNS,
        { id: 'type', label: 'Type', get: (i) => i.secretType },
        { id: 'keys', label: 'Keys', align: 'right', mono: true, get: (i) => (i.dataKeys === undefined ? undefined : String(i.dataKeys)) },
        { id: 'size', label: 'Size', align: 'right', mono: true, get: (i) => (i.sizeBytes ? memoryText(i.sizeBytes) : '—') },
        { id: 'age', label: 'Age', align: 'right', get: (i) => i.age },
      ];
    case 'PersistentVolumeClaim':
      return [
        ...BASE_COLUMNS,
        { id: 'status', label: 'Status', get: (i) => i.status },
        { id: 'capacity', label: 'Capacity', align: 'right', mono: true, get: (i) => memoryText(quantity(i.capacity)) },
        { id: 'volume', label: 'Volume', mono: true, get: (i) => i.volume },
        { id: 'storageclass', label: 'Storage class', get: (i) => i.storageClass },
        { id: 'age', label: 'Age', align: 'right', get: (i) => i.age },
      ];
    case 'PersistentVolume':
      return [
        ...BASE_COLUMNS.slice(0, 1),
        { id: 'status', label: 'Status', get: (i) => i.status },
        { id: 'claim', label: 'Claim', mono: true, get: (i) => i.volume },
        { id: 'capacity', label: 'Capacity', align: 'right', mono: true, get: (i) => memoryText(quantity(i.capacity)) },
        { id: 'storageclass', label: 'Storage class', get: (i) => i.storageClass },
        { id: 'reclaim', label: 'Reclaim', get: (i) => i.reclaimPolicy },
        { id: 'age', label: 'Age', align: 'right', get: (i) => i.age },
      ];
    case 'StorageClass':
      return [
        ...BASE_COLUMNS.slice(0, 1),
        { id: 'provisioner', label: 'Provisioner', get: (i) => i.provisioner },
        { id: 'reclaim', label: 'Reclaim', get: (i) => i.reclaimPolicy },
        { id: 'age', label: 'Age', align: 'right', get: (i) => i.age },
      ];
    case 'Node':
      return [
        ...BASE_COLUMNS.slice(0, 1),
        { id: 'status', label: 'Status', get: (i) => i.status },
        { id: 'roles', label: 'Roles', get: (i) => i.nodeRoles },
        { id: 'version', label: 'Version', mono: true, get: (i) => i.nodeVersion },
        { id: 'ip', label: 'Internal IP', mono: true, get: (i) => i.nodeIp || i.ip },
        { id: 'cpu', label: 'CPU cores', get: (i) => i.nodeCpu },
        { id: 'mem', label: 'Memory', get: (i) => { const bytes = quantity(i.nodeMem); return bytes === null ? i.nodeMem : memoryText(bytes); } },
        { id: 'pods', label: 'Pods', hint: 'Pods running on the node · cluster-wide, not affected by the namespace selection', get: (i) => {
          if (i.nodePods?.includes('/')) return i.nodePods.split('/')[0].trim();
          const running = options?.podsByNode?.get(i.name);
          if (running !== undefined) return String(running);
          return i.nodePods ?? '0';
        } },
        { id: 'taints', label: 'Taints', align: 'right', mono: true, get: (i) => {
          const rawTaints = (i.raw as any)?.spec?.taints;
          const count = Array.isArray(rawTaints) ? rawTaints.length : (i.taintsCount ?? 0);
          return String(count);
        } },
        { id: 'age', label: 'Age', align: 'right', get: (i) => i.age },
      ];
    case 'Namespace':
      return [
        ...BASE_COLUMNS.slice(0, 1),
        { id: 'status', label: 'Status', get: (i) => i.status },
        { id: 'age', label: 'Age', align: 'right', get: (i) => i.age },
      ];
    case 'CustomResourceDefinition':
      return [
        { id: 'name', label: 'Resource', get: (i) => i.name },
        { id: 'group', label: 'Group', get: (i) => (i.raw as any)?.spec?.group ?? i.spec?.group },
        { id: 'version', label: 'Version', get: (i) => {
          const spec = (i.raw as any)?.spec ?? i.spec;
          const versions = Array.isArray(spec?.versions) ? spec.versions : [];
          const pref = versions.find((v: any) => v.storage) ?? versions.find((v: any) => v.served !== false) ?? versions[0];
          return pref?.name ?? spec?.version ?? '—';
        } },
        { id: 'scope', label: 'Scope', get: (i) => (i.raw as any)?.spec?.scope ?? i.spec?.scope ?? 'Namespaced' },
        { id: 'status', label: 'Status', get: (i) => i.status },
        { id: 'age', label: 'Age', align: 'right', get: (i) => i.age },
      ];
    default:
      return [...BASE_COLUMNS, { id: 'status', label: 'Status', get: (i) => i.status }, { id: 'age', label: 'Age', align: 'right', get: (i) => i.age }];
  }
};
