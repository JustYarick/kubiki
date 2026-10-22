import { RESOURCE_TYPES } from './resources/resource_types';
import {
  Anchor,
  GitBranch,
  Bell,
  Boxes,
  CalendarClock,
  CircuitBoard,
  CircleDot,
  Clock,
  Cpu,
  Database,
  FileCode,
  Flag,
  Globe,
  HardDrive,
  Key,
  Layers,
  ListChecks,
  Network,
  Puzzle,
  Route,
  Ruler,
  Scale,
  Server,
  ShieldBan,
  ShieldCheck,
  Timer,
  TrendingUp,
  Waypoints,
  Webhook,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ResourceKind } from '../types/k8s';
import type { HelmSection } from '../providers/helm_types';
import { GROUP_BASE, NEUTRAL_TONE, familyBase, groupTone, lookupTone, registerTone, shade, toneOf, type GroupId, type Tone } from './palette';

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
  /** Top-level group the kind belongs to — decides its base hue. */
  group: GroupId;
  /** Resolved color of this kind: a shade of the group hue. */
  tone: Tone;
  /** API group of a dynamically discovered kind — decides the hue of its family. */
  apiGroup?: string;
  /** Plain kind name of a dynamically discovered kind (its `kind` is a bucket key). */
  nativeKind?: string;
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
  HorizontalPodAutoscaler: TrendingUp,
  VerticalPodAutoscaler: TrendingUp,
  PodDisruptionBudget: ShieldCheck,
  ResourceQuota: Scale,
  LimitRange: Ruler,
  PriorityClass: Flag,
  RuntimeClass: Timer,
  Lease: CalendarClock,
  IngressClass: Layers,
  Endpoints: Network,
  EndpointSlice: Network,
  NetworkPolicy: ShieldBan,
  MutatingWebhookConfiguration: Webhook,
  ValidatingWebhookConfiguration: Webhook,
  ValidatingAdmissionPolicy: ListChecks,
  MutatingAdmissionPolicy: ListChecks,
  ValidatingAdmissionPolicyBinding: ListChecks,
  MutatingAdmissionPolicyBinding: ListChecks,
  DeviceClass: CircuitBoard,
  ResourceClaim: Cpu,
  ResourceClaimTemplate: Cpu,
  ResourceSlice: CircuitBoard,
  Gateway: Waypoints,
  GatewayClass: Waypoints,
  HTTPRoute: Route,
  GRPCRoute: Route,
  TCPRoute: Route,
  UDPRoute: Route,
  TLSRoute: Route,
  ListenerSet: Route,
  ReferenceGrant: Waypoints,
  BackendTLSPolicy: ShieldCheck,
};

const k = (kind: ResourceKind, label: string, group: GroupId): KindEntry => ({ kind, label, icon: KIND_ICONS[kind] ?? Boxes, group, tone: groupTone(group) });

/** Lens ordering and one level from category to resource; only CRD API groups add a level. */
export const SIDEBAR_TREE: TreeCategory[] = [
  { id: 'nodes', label: 'Nodes', icon: Server, directKind: 'Node', groups: [{ id: 'nodes', kinds: [k('Node', 'Nodes', 'nodes')] }] },
  { id: 'workloads', label: 'Workloads', icon: Boxes, groups: [{ id: 'workloads', kinds: [
    k('Pod', 'Pods', 'workloads'),
    k('Deployment', 'Deployments', 'workloads'),
    k('DaemonSet', 'DaemonSets', 'workloads'),
    k('StatefulSet', 'StatefulSets', 'workloads'),
    k('ReplicaSet', 'ReplicaSets', 'workloads'),
    k('ReplicationController', 'Replication Controllers', 'workloads'),
    k('Job', 'Jobs', 'workloads'), k('CronJob', 'CronJobs', 'workloads'),
  ] }] },
  { id: 'config', label: 'Config', icon: FileCode, groups: [{ id: 'config', kinds: [
    k('ConfigMap', 'ConfigMaps', 'config'), k('Secret', 'Secrets', 'config'),
    k('ResourceQuota', 'Resource Quotas', 'config'), k('LimitRange', 'Limit Ranges', 'config'),
    k('HorizontalPodAutoscaler', 'Horizontal Pod Autoscalers', 'config'), k('PodDisruptionBudget', 'Pod Disruption Budgets', 'config'),
    k('PriorityClass', 'Priority Classes', 'config'), k('RuntimeClass', 'Runtime Classes', 'config'), k('Lease', 'Leases', 'config'),
    k('MutatingWebhookConfiguration', 'Mutating Webhook Configurations', 'config'), k('ValidatingWebhookConfiguration', 'Validating Webhook Configurations', 'config'),
  ] }] },
  { id: 'network', label: 'Network', icon: Network, groups: [{ id: 'network', kinds: [k('Service', 'Services', 'network'), k('Ingress', 'Ingresses', 'network'), k('IngressClass', 'Ingress Classes', 'network'), k('Endpoints', 'Endpoints', 'network'), k('EndpointSlice', 'Endpoint Slices', 'network'), k('NetworkPolicy', 'Network Policies', 'network')] }] },
  { id: 'storage', label: 'Storage', icon: Database, groups: [{ id: 'storage', kinds: [
    k('PersistentVolumeClaim', 'Persistent Volume Claims', 'storage'),
    k('PersistentVolume', 'Persistent Volumes', 'storage'),
    k('StorageClass', 'Storage Classes', 'storage'),
  ] }] },
  { id: 'namespaces', label: 'Namespaces', icon: Globe, directKind: 'Namespace', groups: [{ id: 'namespaces', kinds: [k('Namespace', 'Namespaces', 'namespaces')] }] },
  { id: 'events', label: 'Events', icon: Bell, directKind: 'Event', groups: [{ id: 'events', kinds: [k('Event', 'Events', 'events')] }] },
  { id: 'helm', label: 'Helm', icon: Anchor, groups: [{ id: 'helm', kinds: [], helmViews: ['releases', 'repositories'] }] },
  { id: 'access', label: 'Access Control', icon: ShieldCheck, groups: [{ id: 'access', kinds: [
    k('ServiceAccount', 'Service Accounts', 'access'),
    k('ClusterRole', 'Cluster Roles', 'access'),
    k('Role', 'Roles', 'access'),
    k('ClusterRoleBinding', 'Cluster Role Bindings', 'access'),
    k('RoleBinding', 'Role Bindings', 'access'),
  ] }] },
  { id: 'admission', label: 'Admission Policies', icon: ShieldCheck, groups: [{ id: 'admission', kinds: RESOURCE_TYPES.filter(type => type.kind.includes('AdmissionPolicy')).map(type => k(type.kind, type.kind.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/Policy$/, 'Policies') + (type.kind.endsWith('Policy') ? '' : 's'), 'admission')) }] },
  { id: 'gateway', label: 'Gateway API', icon: Network, groups: [] },
  { id: 'devices', label: 'Device Resources', icon: Server, groups: [{ id: 'devices', kinds: RESOURCE_TYPES.filter(type => type.group === 'resource.k8s.io').map(type => k(type.kind, type.kind.replace(/([a-z])([A-Z])/g, '$1 $2') + (type.kind.endsWith('Class') ? 'es' : 's'), 'devices')) }] },
  { id: 'flux', label: 'Flux', icon: GitBranch, groups: [] },
  { id: 'argocd', label: 'Argo CD', icon: Boxes, groups: [] },
  { id: 'crd', label: 'Custom Resources', icon: Puzzle, groups: [{ id: 'crd', kinds: [k('CustomResourceDefinition', 'Definitions', 'crd')] }] },
];

export const PERSPECTIVES: TreeCategory[] = SIDEBAR_TREE;

/**
 * Assign shades to the kinds of every category and publish them in the shared
 * registry: kinds that share a base hue are shaded along their own ramp, so a
 * group reads as one family while its members stay distinguishable.
 */
export function assignCategoryTones(categories: TreeCategory[]): void {
  for (const category of categories) {
    const entries = category.groups.flatMap((group) => group.kinds);
    const byBase = new Map<string, KindEntry[]>();
    for (const entry of entries) {
      const base = entry.apiGroup ? familyBase(entry.apiGroup) : GROUP_BASE[entry.group];
      const bucket = byBase.get(base);
      if (bucket) bucket.push(entry);
      else byBase.set(base, [entry]);
    }
    for (const [base, bucket] of byBase) {
      bucket.forEach((entry, index) => {
        entry.tone = toneOf(shade(base, index, bucket.length));
        registerTone(entry.apiGroup && entry.nativeKind ? `${entry.apiGroup}/${entry.nativeKind}` : String(entry.kind), entry.tone);
      });
    }
  }
}

assignCategoryTones(SIDEBAR_TREE);

/** Color of a kind anywhere in the app — the sidebar, badges, tables and details share it. */
export function kindTone(kind: string, apiGroup?: string): Tone {
  if (kind.startsWith('custom:')) {
    const [group, nativeKind] = kind.slice('custom:'.length).split('/');
    const scoped = group && nativeKind ? lookupTone(`${group}/${nativeKind}`) : undefined;
    if (scoped) return scoped;
  }
  if (apiGroup) {
    const scoped = lookupTone(`${apiGroup}/${kind}`);
    if (scoped) return scoped;
  }
  return lookupTone(kind) ?? NEUTRAL_TONE;
}

export const perspectiveById = (id: Perspective): TreeCategory | undefined => PERSPECTIVES.find((p) => p.id === id);

/** Default kind when focusing a category — first kind of the first group. */
export const defaultKindFor = (perspective: Perspective): ResourceKind | null =>
  perspective === 'cluster' ? 'Node' : PERSPECTIVES.find((p) => p.id === perspective)?.groups.flatMap((g) => g.kinds)[0]?.kind ?? null;

/** All kinds belonging to a category (for command palette navigation). */
export const kindsFor = (perspective: Perspective): ResourceKind[] =>
  perspective === 'cluster' ? ['Node', 'Namespace', 'Event'] : PERSPECTIVES.find((p) => p.id === perspective)?.groups.flatMap((g) => g.kinds.map((x) => x.kind)) ?? [];
