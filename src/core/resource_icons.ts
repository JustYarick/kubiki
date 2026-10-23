import {
  Anchor, AppWindow, Bell, BellRing, Blocks, Boxes, Braces, Cable, CalendarClock, CircuitBoard,
  CircleDot, ClipboardCheck, ContactRound, Container, Copy, Cpu, Cylinder, Database, FileBox,
  FileCode, FileCode2, FileStack, Flag, FolderKanban, GitBranch, Globe, HardDrive,
  Images, Key, Layers, Layers2, LibraryBig, LifeBuoy, ListChecks, ListFilter, ListTodo, LockKeyhole,
  Network, Package, PackageCheck, PanelsTopLeft, RadioTower, Rocket, Route, Ruler,
  Scale, Send, Server, ServerCog, ShieldBan, ShieldCheck, ShieldPlus, Timer,
  TrendingUp, UserRoundCheck, UserRoundPlus, WandSparkles, Waves, Waypoints, Webhook, Workflow,
  type LucideIcon,
} from 'lucide-react';
import { RESOURCE_TYPES } from './resources/resource_types';

/** Semantic Lucide outline icons. Shared by navigation, badges, tables and details. */
export const CATEGORY_ICONS = {
  nodes: Server, workloads: Boxes, config: FileCode, network: Network,
  storage: Database, namespaces: Globe, events: Bell, helm: Anchor,
  access: ShieldCheck, admission: ClipboardCheck, gateway: Waypoints,
  devices: Cpu, flux: Waves, argocd: Workflow, crd: Blocks,
} satisfies Record<string, LucideIcon>;

export const KIND_ICONS: Record<string, LucideIcon> = {
  Pod: CircleDot,
  Deployment: Rocket,
  ReplicaSet: Copy,
  ReplicationController: Layers2,
  StatefulSet: Database,
  DaemonSet: ServerCog,
  Job: ListTodo,
  CronJob: CalendarClock,
  Service: Network,
  Ingress: Route,
  ConfigMap: FileCode,
  Secret: Key,
  PersistentVolumeClaim: HardDrive,
  PersistentVolume: Cylinder,
  StorageClass: Layers,
  Node: Server,
  Namespace: Globe,
  Event: Bell,
  CustomResourceDefinition: FileCode2,
  ServiceAccount: ContactRound,
  Role: UserRoundCheck,
  RoleBinding: UserRoundPlus,
  ClusterRole: ShieldCheck,
  ClusterRoleBinding: ShieldPlus,
  HelmRelease: Anchor,
  HorizontalPodAutoscaler: TrendingUp,
  VerticalPodAutoscaler: TrendingUp,
  PodDisruptionBudget: LifeBuoy,
  ResourceQuota: Scale,
  LimitRange: Ruler,
  PriorityClass: Flag,
  RuntimeClass: Container,
  Lease: Timer,
  IngressClass: Layers,
  Endpoints: CircleDot,
  EndpointSlice: CircuitBoard,
  NetworkPolicy: ShieldBan,
  MutatingWebhookConfiguration: Webhook,
  ValidatingWebhookConfiguration: Webhook,
  ValidatingAdmissionPolicy: ClipboardCheck,
  MutatingAdmissionPolicy: ListChecks,
  ValidatingAdmissionPolicyBinding: ShieldPlus,
  MutatingAdmissionPolicyBinding: FileStack,
  DeviceClass: Cpu,
  ResourceClaim: CircuitBoard,
  ResourceClaimTemplate: FileStack,
  ResourceSlice: Layers2,
  Gateway: Waypoints,
  GatewayClass: Layers,
  HTTPRoute: Route,
  GRPCRoute: Braces,
  TCPRoute: Cable,
  UDPRoute: Send,
  TLSRoute: LockKeyhole,
  ListenerSet: RadioTower,
  ReferenceGrant: ShieldPlus,
  BackendTLSPolicy: ShieldCheck,
};

// API groups keep native Helm releases and the Flux CRD visually distinct.
const customIcons: Record<string, Record<string, LucideIcon>> = {
  'source.toolkit.fluxcd.io': {
    GitRepository: GitBranch, OCIRepository: Container, HelmRepository: LibraryBig,
    HelmChart: Package, Bucket: Cylinder,
  },
  'kustomize.toolkit.fluxcd.io': { Kustomization: Layers2 },
  'helm.toolkit.fluxcd.io': { HelmRelease: PackageCheck },
  'image.toolkit.fluxcd.io': {
    ImageRepository: Images, ImagePolicy: ListFilter, ImageUpdateAutomation: WandSparkles,
  },
  'notification.toolkit.fluxcd.io': { Alert: BellRing, Provider: RadioTower, Receiver: Webhook },
  'argoproj.io': { Application: AppWindow, ApplicationSet: PanelsTopLeft, AppProject: FolderKanban },
};

/** Accepts either a custom bucket key, a Kind + API version, or a Kind + API group. */
export function resourceIcon(kind: string, apiVersionOrGroup?: string): LucideIcon {
  let group = apiVersionOrGroup?.split('/')[0];
  if (kind.startsWith('custom:')) [group, kind] = kind.slice('custom:'.length).split('/');
  // Core API versions contain no slash; their group is empty.
  if (group && /^v\d+(?:(?:alpha|beta)\d+)?$/.test(group)) group = '';
  if (group && customIcons[group]?.[kind]) return customIcons[group][kind];
  if (group === undefined || group === 'helm.sh' && kind === 'HelmRelease' || RESOURCE_TYPES.some(type => type.kind === kind && type.group === group) || group === 'gateway.networking.k8s.io' || group === 'autoscaling.k8s.io' && kind === 'VerticalPodAutoscaler') {
    return KIND_ICONS[kind] ?? FileBox;
  }
  if (group?.endsWith('.toolkit.fluxcd.io') || group === 'fluxcd.io') return CATEGORY_ICONS.flux;
  if (group === 'argoproj.io') return CATEGORY_ICONS.argocd;
  return FileBox;
}
