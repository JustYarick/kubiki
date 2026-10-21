import { RESOURCE_TYPES } from './resources/resource_types';
import {
  Anchor,
  GitBranch,
  Bell,
  Boxes,
  CircleDot,
  Clock,
  Database,
  FileCode,
  Globe,
  HardDrive,
  Key,
  Layers,
  Network,
  Puzzle,
  Server,
  ShieldCheck,
  Timer,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ResourceKind } from '../types/k8s';
import type { HelmSection } from '../providers/helm_types';

export const HELM_VIEWS: Record<HelmSection, string> = { releases: 'Releases', repositories: 'Repositories' };

export type Perspective =
  | 'workloads'
  | 'config'
  | 'network'
  | 'storage'
  | 'access'
  | 'helm'
  | 'crd'
  | 'cluster'
  | 'nodes'
  | 'namespaces'
  | 'events' | 'admission' | 'devices' | 'gateway' | 'flux' | 'argocd';

export interface KindEntry {
  kind: ResourceKind;
  label: string;
  icon: LucideIcon;
  hue: string;
  keywords?: string;
}

/** A navigational group one level below a category (Lens has “Workloads → Workloads / Jobs”). */
export interface TreeGroup {
  id: string;
  label?: string;
  kinds: KindEntry[];
  helmViews?: HelmSection[];
  /** Rendered as a muted disabled row instead of clickable kinds. */
  placeholder?: string;
}

/** Top-level sidebar category (analogous to Lens: Workloads, Configuration, …). */
export interface TreeCategory {
  id: Perspective;
  label: string;
  icon: LucideIcon;
  groups: TreeGroup[];
  directKind?: ResourceKind;
}

export const KIND_ICONS: Record<ResourceKind, LucideIcon> = {
  Pod: CircleDot,
  Deployment: Boxes,
  ReplicaSet: Boxes,
  StatefulSet: Database,
  DaemonSet: Server,
  Job: Clock,
  CronJob: Timer,
  Service: Network,
  Ingress: Layers,
  ConfigMap: FileCode,
  Secret: Key,
  PersistentVolumeClaim: HardDrive,
  PersistentVolume: HardDrive,
  StorageClass: Layers,
  Node: Server,
  Namespace: Globe,
  Event: Bell,
  CustomResourceDefinition: Puzzle,
  ServiceAccount: Key,
  Role: ShieldCheck,
  RoleBinding: ShieldCheck,
  ClusterRole: ShieldCheck,
  ClusterRoleBinding: ShieldCheck,
  HelmRelease: Anchor,
};

const k = (kind: ResourceKind, label: string, hue: string): KindEntry => ({ kind, label, icon: KIND_ICONS[kind] ?? Boxes, hue });

/** Lens ordering and one level from category to resource; only CRD API groups add a level. */
export const SIDEBAR_TREE: TreeCategory[] = [
  { id: 'nodes', label: 'Nodes', icon: Server, directKind: 'Node', groups: [{ id: 'nodes', kinds: [k('Node', 'Nodes', 'text-[var(--status-info)]')] }] },
  { id: 'workloads', label: 'Workloads', icon: Boxes, groups: [{ id: 'workloads', kinds: [
    k('Pod', 'Pods', 'text-[var(--status-ok)]'),
    k('Deployment', 'Deployments', 'text-[var(--status-info)]'),
    k('DaemonSet', 'DaemonSets', 'text-purple-400'),
    k('StatefulSet', 'StatefulSets', 'text-violet-400'),
    k('ReplicaSet', 'ReplicaSets', 'text-[var(--status-info)]'),
    k('ReplicationController', 'Replication Controllers', 'text-blue-400'),
    k('Job', 'Jobs', 'text-amber-400'), k('CronJob', 'CronJobs', 'text-cyan-400'),
  ] }] },
  { id: 'config', label: 'Config', icon: FileCode, groups: [{ id: 'config', kinds: [
    k('ConfigMap', 'ConfigMaps', 'text-sky-400'), k('Secret', 'Secrets', 'text-amber-400'),
    k('ResourceQuota', 'Resource Quotas', 'text-violet-400'), k('LimitRange', 'Limit Ranges', 'text-violet-400'),
    k('HorizontalPodAutoscaler', 'Horizontal Pod Autoscalers', 'text-sky-400'), k('PodDisruptionBudget', 'Pod Disruption Budgets', 'text-amber-400'),
    k('PriorityClass', 'Priority Classes', 'text-cyan-400'), k('RuntimeClass', 'Runtime Classes', 'text-cyan-400'), k('Lease', 'Leases', 'text-cyan-400'),
    k('MutatingWebhookConfiguration', 'Mutating Webhook Configurations', 'text-violet-400'), k('ValidatingWebhookConfiguration', 'Validating Webhook Configurations', 'text-violet-400'),
  ] }] },
  { id: 'network', label: 'Network', icon: Network, groups: [{ id: 'network', kinds: [k('Service', 'Services', 'text-[var(--status-info)]'), k('Ingress', 'Ingresses', 'text-indigo-400'), k('IngressClass', 'Ingress Classes', 'text-indigo-400'), k('Endpoints', 'Endpoints', 'text-cyan-400'), k('EndpointSlice', 'Endpoint Slices', 'text-cyan-400'), k('NetworkPolicy', 'Network Policies', 'text-sky-400')] }] },
  { id: 'storage', label: 'Storage', icon: Database, groups: [{ id: 'storage', kinds: [
    k('PersistentVolumeClaim', 'Persistent Volume Claims', 'text-amber-400'),
    k('PersistentVolume', 'Persistent Volumes', 'text-[var(--text-secondary)]'),
    k('StorageClass', 'Storage Classes', 'text-sky-400'),
  ] }] },
  { id: 'namespaces', label: 'Namespaces', icon: Globe, directKind: 'Namespace', groups: [{ id: 'namespaces', kinds: [k('Namespace', 'Namespaces', 'text-emerald-400')] }] },
  { id: 'events', label: 'Events', icon: Bell, directKind: 'Event', groups: [{ id: 'events', kinds: [k('Event', 'Events', 'text-[var(--text-secondary)]')] }] },
  { id: 'helm', label: 'Helm', icon: Anchor, groups: [{ id: 'helm', kinds: [], helmViews: ['releases', 'repositories'] }] },
  { id: 'access', label: 'Access Control', icon: ShieldCheck, groups: [{ id: 'access', kinds: [
    k('ServiceAccount', 'Service Accounts', 'text-amber-400'),
    k('ClusterRole', 'Cluster Roles', 'text-indigo-400'),
    k('Role', 'Roles', 'text-violet-400'),
    k('ClusterRoleBinding', 'Cluster Role Bindings', 'text-purple-400'),
    k('RoleBinding', 'Role Bindings', 'text-fuchsia-400'),
  ] }] },
  { id: 'admission', label: 'Admission Policies', icon: ShieldCheck, groups: [{ id: 'admission', kinds: RESOURCE_TYPES.filter(type => type.kind.includes('AdmissionPolicy')).map(type => k(type.kind, type.kind.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/Policy$/, 'Policies') + (type.kind.endsWith('Policy') ? '' : 's'), 'text-violet-400')) }] },
  { id: 'gateway', label: 'Gateway API', icon: Network, groups: [] },
  { id: 'devices', label: 'Device Resources', icon: Server, groups: [{ id: 'devices', kinds: RESOURCE_TYPES.filter(type => type.group === 'resource.k8s.io').map(type => k(type.kind, type.kind.replace(/([a-z])([A-Z])/g, '$1 $2') + (type.kind.endsWith('Class') ? 'es' : 's'), 'text-sky-400')) }] },
  { id: 'flux', label: 'Flux', icon: GitBranch, groups: [] },
  { id: 'argocd', label: 'Argo CD', icon: Boxes, groups: [] },
  { id: 'crd', label: 'Custom Resources', icon: Puzzle, groups: [{ id: 'crd', kinds: [k('CustomResourceDefinition', 'Definitions', 'text-violet-400')] }] },
];

export const PERSPECTIVES: TreeCategory[] = SIDEBAR_TREE;

export const perspectiveById = (id: Perspective): TreeCategory | undefined => PERSPECTIVES.find((p) => p.id === id);

/** Default kind when focusing a category — first kind of the first group. */
export const defaultKindFor = (perspective: Perspective): ResourceKind | null =>
  perspective === 'cluster' ? 'Node' : PERSPECTIVES.find((p) => p.id === perspective)?.groups.flatMap((g) => g.kinds)[0]?.kind ?? null;

/** All kinds belonging to a category (for command palette navigation). */
export const kindsFor = (perspective: Perspective): ResourceKind[] =>
  perspective === 'cluster' ? ['Node', 'Namespace', 'Event'] : PERSPECTIVES.find((p) => p.id === perspective)?.groups.flatMap((g) => g.kinds.map((x) => x.kind)) ?? [];
