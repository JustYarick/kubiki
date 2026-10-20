import {
  Anchor,
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
  | 'cluster';

export interface KindEntry {
  kind: ResourceKind;
  label: string;
  icon: LucideIcon;
  hue: string;
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
};

const k = (kind: ResourceKind, label: string, hue: string): KindEntry => ({ kind, label, icon: KIND_ICONS[kind], hue });

/**
 * Single, Lens-like sidebar tree: every category is always visible,
 * nested categories → groups → kinds. No perspective filtering — the
 * sidebar shows the whole cluster at once.
 */
export const SIDEBAR_TREE: TreeCategory[] = [
  {
    id: 'workloads',
    label: 'Workloads',
    icon: Boxes,
    groups: [
      {
        id: 'workloads-core',
        label: 'Pods & controllers',
        kinds: [
          k('Pod', 'Pods', 'text-[var(--status-ok)]'),
          k('Deployment', 'Deployments', 'text-[var(--status-info)]'),
          k('ReplicaSet', 'ReplicaSets', 'text-[var(--status-info)]'),
          k('StatefulSet', 'StatefulSets', 'text-violet-400'),
          k('DaemonSet', 'DaemonSets', 'text-purple-400'),
        ],
      },
      {
        id: 'workloads-jobs',
        label: 'Jobs',
        kinds: [k('Job', 'Jobs', 'text-amber-400'), k('CronJob', 'CronJobs', 'text-cyan-400')],
      },
    ],
  },
  {
    id: 'config',
    label: 'Configuration',
    icon: FileCode,
    groups: [
      { id: 'config-core', kinds: [k('ConfigMap', 'ConfigMaps', 'text-sky-400'), k('Secret', 'Secrets', 'text-amber-400')] },
    ],
  },
  {
    id: 'network',
    label: 'Network',
    icon: Network,
    groups: [
      { id: 'network-core', kinds: [k('Service', 'Services', 'text-[var(--status-info)]'), k('Ingress', 'Ingresses', 'text-indigo-400')] },
    ],
  },
  {
    id: 'storage',
    label: 'Storage',
    icon: Database,
    groups: [
      {
        id: 'storage-core',
        kinds: [
          k('PersistentVolumeClaim', 'Persistent Volume Claims', 'text-amber-400'),
          k('PersistentVolume', 'Persistent Volumes', 'text-[var(--text-secondary)]'),
          k('StorageClass', 'Storage Classes', 'text-sky-400'),
        ],
      },
    ],
  },
  {
    id: 'access',
    label: 'Access Control',
    icon: Puzzle,
    groups: [
      { id: 'access-service-accounts', label: 'Identity', kinds: [k('ServiceAccount', 'Service Accounts', 'text-amber-400')] },
      { id: 'access-namespace-rbac', label: 'Namespace RBAC', kinds: [k('Role', 'Roles', 'text-violet-400'), k('RoleBinding', 'Role Bindings', 'text-fuchsia-400')] },
      { id: 'access-cluster-rbac', label: 'Cluster RBAC', kinds: [k('ClusterRole', 'Cluster Roles', 'text-indigo-400'), k('ClusterRoleBinding', 'Cluster Role Bindings', 'text-purple-400')] },
    ],
  },
  {
    id: 'crd',
    label: 'Custom Resource Definitions',
    icon: Puzzle,
    groups: [
      { id: 'crd-core', kinds: [k('CustomResourceDefinition', 'CRDs', 'text-violet-400')] },
    ],
  },
  {
    id: 'helm',
    label: 'Helm',
    icon: Anchor,
    groups: [
      { id: 'helm-core', kinds: [], helmViews: ['releases', 'repositories'] },
    ],
  },
  {
    id: 'cluster',
    label: 'Cluster',
    icon: Globe,
    groups: [
      { id: 'cluster-core', kinds: [k('Node', 'Nodes', 'text-[var(--status-info)]'), k('Namespace', 'Namespaces', 'text-emerald-400'), k('Event', 'Events', 'text-[var(--text-secondary)]')] },
    ],
  },
];

export const PERSPECTIVES: TreeCategory[] = SIDEBAR_TREE;

export const perspectiveById = (id: Perspective): TreeCategory | undefined => PERSPECTIVES.find((p) => p.id === id);

/** Default kind when focusing a category — first kind of the first group. */
export const defaultKindFor = (perspective: Perspective): ResourceKind | null =>
  PERSPECTIVES.find((p) => p.id === perspective)?.groups.flatMap((g) => g.kinds)[0]?.kind ?? null;

/** All kinds belonging to a category (for command palette navigation). */
export const kindsFor = (perspective: Perspective): ResourceKind[] =>
  PERSPECTIVES.find((p) => p.id === perspective)?.groups.flatMap((g) => g.kinds.map((x) => x.kind)) ?? [];
