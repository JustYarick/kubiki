import { syncResourceSnapshot } from '../providers/snapshot_sync';
import { ResourceLoading } from '../components/ui/ResourceLoading';
import { useVirtualizer } from '@tanstack/react-virtual';
import { presentationFor, fieldText, fieldValue } from '../core/resources/resource_presentations';
import { resourceType, apiVersionFor as typeApiVersion } from '../core/resources/resource_types';
import { customResourcePlacement, customColumnValue, customResourceType, type CustomResourceType } from '../core/resources/custom_resource_types';
import { useCustomResources } from '../providers/use_custom_resources';
import { defaultNamespace } from '../core/resources/namespace_scope';
import { inNamespaceScope } from '../core/resources/namespace_scope';
import { memoryText, quantity } from '../core/resources/quantities';
import React, { useEffect, useLayoutEffect, useMemo, useState, useRef } from 'react';
import {
  ArrowDown,
  ArrowRightLeft,
  ArrowUp,
  Boxes,
  Braces,
  Copy,
  FileText,
  Maximize2,
  Minimize2,
  Plus,
  RefreshCw,
  RotateCw,
  SlidersHorizontal,
  Terminal,
  Trash2,
  XCircle,
  ExternalLink,
  Columns2,
  CheckSquare,
  Square,
  MinusSquare,
  Pause,
  Play,
  Share2,
  ShieldAlert,
} from 'lucide-react';
import { stringify } from 'yaml';
import { findWorkloadPods, preferredWorkloadPod } from '../core/resources/workload_pods';
import { gitOpsFamily } from '../core/resources/gitops';
import { useResourceStore } from '../state/resource_store';
import { useClusterStore } from '../state/cluster_store';
import { useUiStore } from '../state/ui_store';
import { useWorkspaceStore } from '../state/workspace_store';
import { useDockStore } from '../state/dock_store';
import { k8s } from '../providers/k8s_provider';
import { SIDEBAR_TREE, KIND_ICONS, defaultKindFor, kindsFor } from '../core/perspectives';
import { ResourceWarnings } from '../components/k8s/ResourceWarnings';
import { StatusBadge } from '../components/k8s/StatusBadge';
import { IconButton, Tooltip } from '../components/ui/Button';
import { Popover, MenuList, FixedMenu, type MenuItem } from '../components/ui/Dropdown';
import { SearchInput, Input, Label } from '../components/ui/Input';
import { Modal } from '../components/ui/Modal';
import { Button } from '../components/ui/Button';
import { PFDialog } from '../components/dialogs/PFDialog';
import { ScaleDialog, ConfirmDialog, RestartDialog, DeleteResourceDialog } from '../components/dialogs/ActionDialogs';
import { toast } from '../state/notifications_store';
import type { ResourceItem, ResourceKind } from '../types/k8s';
import { RequestErrorNotice } from '../components/k8s/RequestErrorNotice';
import { uiFactor, uiPixels } from '../core/appearance';
import { resourceTabId } from '../core/resources/identity';
import { resourceIssues } from '../core/resources/diagnostics';
import { compareCreation, compareStatusFirst, issuePriority } from '../core/resources/resource_sort';
import { ContainerIndicators } from '../components/k8s/ContainerSelect';
import { podContainers } from '../core/resources/containers';
import { refreshResourceWatches } from '../state/resource_watch';
import { cx } from '../core/utils/cx';
import { fitTableColumns } from '../core/resources/table_fit';

/* ------------------------------------------------------------------ */
/* Column model                                                        */
/* ------------------------------------------------------------------ */

interface ColumnDef {
  id: string;
  label: string;
  align?: 'right';
  mono?: boolean;
  /** Default pixel width for table-layout:fixed (resizable by the user). */
  size?: number;
  get: (i: ResourceItem) => string | undefined;
}

const DEFAULT_COL_SIZE: Record<string, number> = {
  __index: 38,
  containers: 112, name: 240, namespace: 130, ready: 66, restarts: 84, status: 132, ip: 112, node: 96, age: 64,
  ports: 132, type: 112, clusterIP: 120, image: 220, keys: 74, volume: 132, claim: 168,
  storageclass: 132, reclaim: 92, roles: 152, version: 98, cpu: 112, mem: 172, pods: 130, replicas: 125,
  provisioner: 184, hosts: 220, class: 100, capacity: 90, group: 110,
  controlledBy: 140, qos: 80, duration: 80, suspend: 80, active: 64, lastSchedule: 100, externalIP: 140,
  selector: 150, address: 140, size: 80, taints: 64, nodeSelector: 140,
};

const MIN_COL = 56;
const MAX_COL = 520;

const BASE_COLUMNS: ColumnDef[] = [
  { id: 'name', label: 'Name', mono: true, get: (i) => i.name },
  { id: 'namespace', label: 'Namespace', get: (i) => i.namespace },
];

const columnsFor = (kind: ResourceKind, options?: { podsByNode?: Map<string, number> }): ColumnDef[] => {
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
        { id: 'pods', label: 'Pods', get: (i) => i.ready },
        { id: 'status', label: 'Conditions', get: (i) => i.status },
        { id: 'image', label: 'Image', mono: true, get: (i) => i.image ?? undefined },
        { id: 'age', label: 'Age', align: 'right', get: (i) => i.age },
      ];
    case 'DaemonSet':
      return [
        ...BASE_COLUMNS,
        { id: 'pods', label: 'Pods', get: (i) => i.ready },
        { id: 'nodeSelector', label: 'Node Selector', mono: true, get: (i) => i.selectorText || '—' },
        { id: 'status', label: 'Conditions', get: (i) => i.status },
        { id: 'image', label: 'Image', mono: true, get: (i) => i.image ?? undefined },
        { id: 'age', label: 'Age', align: 'right', get: (i) => i.age },
      ];
    case 'ReplicaSet':
      return [
        ...BASE_COLUMNS,
        { id: 'pods', label: 'Pods', get: (i) => i.ready },
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
        { id: 'ports', label: 'Ports', mono: true, get: (i) => i.ready },
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
        { id: 'capacity', label: 'Capacity', align: 'right', mono: true, get: (i) => memoryText(quantity(i.ready)) },
        { id: 'volume', label: 'Volume', mono: true, get: (i) => i.volume },
        { id: 'storageclass', label: 'Storage class', get: (i) => i.storageClass },
        { id: 'age', label: 'Age', align: 'right', get: (i) => i.age },
      ];
    case 'PersistentVolume':
      return [
        ...BASE_COLUMNS.slice(0, 1),
        { id: 'status', label: 'Status', get: (i) => i.status },
        { id: 'claim', label: 'Claim', mono: true, get: (i) => i.volume },
        { id: 'capacity', label: 'Capacity', align: 'right', mono: true, get: (i) => memoryText(quantity(i.ready)) },
        { id: 'storageclass', label: 'Storage class', get: (i) => i.storageClass },
        { id: 'reclaim', label: 'Reclaim', get: (i) => i.reclaimPolicy },
        { id: 'age', label: 'Age', align: 'right', get: (i) => i.age },
      ];
    case 'StorageClass':
      return [
        ...BASE_COLUMNS.slice(0, 1),
        { id: 'provisioner', label: 'Provisioner', get: (i) => i.ready },
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
        { id: 'mem', label: 'Memory (used / total)', get: (i) => { const bytes = quantity(i.nodeMem); return bytes === null ? i.nodeMem : memoryText(bytes); } },
        { id: 'pods', label: 'Pods', get: (i) => {
          if (i.nodePods?.includes('/')) return i.nodePods;
          const running = options?.podsByNode?.get(i.name);
          const allocatable = (i.raw as any)?.status?.allocatable?.pods || (i.raw as any)?.status?.capacity?.pods || i.nodePods;
          if (running !== undefined && allocatable) return `${running} / ${allocatable}`;
          if (running !== undefined) return String(running);
          return i.nodePods || (allocatable ? `0 / ${allocatable}` : '—');
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

const apiVersionFor = (kind: ResourceKind): string => typeApiVersion(resourceType(kind));

const templateFor = (kind: ResourceKind, name: string, ns: string): string => {
  const head = [`apiVersion: ${apiVersionFor(kind)}`, `kind: ${kind}`, 'metadata:', `  name: ${name}`, ...(ns ? [`  namespace: ${ns}`] : []), 'spec:'];
  if (['Deployment', 'StatefulSet'].includes(kind))
    return [...head, '  replicas: 1', '  selector:', '    matchLabels:', `      app: ${name}`, '  template:', '    metadata:', '      labels:', `        app: ${name}`, '    spec:', '      containers:', '      - name: app', '        image: nginx:1.27-alpine', '        ports:', '        - containerPort: 80'].join('\n') + '\n';
  if (kind === 'Service')
    return [...head, '  type: ClusterIP', '  selector:', `    app: ${name}`, '  ports:', '  - port: 80', '    targetPort: 8080'].join('\n') + '\n';
  return [...head, '  # edit me…'].join('\n') + '\n';
};

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

interface ResourceViewProps {
  explicitKind?: ResourceKind;
  customType?: CustomResourceType;
}

export const ResourceView: React.FC<ResourceViewProps> = ({ explicitKind, customType }) => {
  const {
    resources, activeKind, setActiveKind, setSearchQuery, searchQuery, searchRegex, setSearchRegex, selectItem, selectedItem,
    updateItem, deleteItem, applyDelta,
  } = useResourceStore();
  const { selectedNamespace, selectNamespace, isConnected, isLoading } = useClusterStore();
  const {
    density, uiScale, hiddenColumns, setHiddenColumns, columnWidths, setColumnWidth, resetColumnWidths,
    setRightTab, activePerspective, inspectorCollapsed, toggleInspector,
  } = useUiStore();
  const { openYamlEditor, openResourceDetail, openLogsTab, openTerminalTab, toggleSplit } = useWorkspaceStore();

  const effectiveKind = explicitKind || activeKind;
  const displayKind = customType?.kind ?? effectiveKind;
  const listLabel = customType ? `${customResourcePlacement(customType)?.label ?? customType.kind} · ${customType.group}` : SIDEBAR_TREE.flatMap(category => category.groups.flatMap(group => group.kinds)).find(entry => entry.kind === effectiveKind)?.label ?? `${effectiveKind}s`;
  const custom = useCustomResources(customType);
  const podsByNode = useMemo(() => {
    const map = new Map<string, number>();
    const podMap = resources.Pod;
    if (!podMap) return map;
    for (const pod of podMap.values()) {
      const nodeName = pod.node || (pod.raw as any)?.spec?.nodeName;
      if (nodeName) map.set(nodeName, (map.get(nodeName) ?? 0) + 1);
    }
    return map;
  }, [resources.Pod]);

  const tableColumns = useMemo<ColumnDef[]>(() => {
    if (!customType) return columnsFor(effectiveKind, { podsByNode });
    const printers = customType.columns.filter(column => column.name.toLowerCase() !== 'age').map((column, index) => ({
      id: /^(status|phase)$/i.test(column.name) ? 'status' : `printer-${index}`,
      label: column.name,
      get: (item: ResourceItem) => customColumnValue(item.raw, column.jsonPath),
    }));
    if (printers.length > 0) {
      return [
        BASE_COLUMNS[0],
        ...(customType.namespaced ? [BASE_COLUMNS[1]] : []),
        ...(printers.some(column => column.id === 'status') ? [] : [{ id: 'status', label: 'Status', get: (item: ResourceItem) => item.status }]),
        ...printers,
        { id: 'age', label: 'Age', align: 'right', get: (item: ResourceItem) => item.age },
      ];
    }
    const presentation = presentationFor({ kind: customType.kind, apiVersion: `${customType.group}/${customType.version}` });
    if (presentation && presentation.fields.length > 0) {
      return [
        BASE_COLUMNS[0],
        ...(customType.namespaced ? [BASE_COLUMNS[1]] : []),
        { id: 'status', label: 'Status', get: item => item.status },
        ...presentation.fields.map((field, index) => ({ id: `gitops-${index}`, label: field.label, get: (item: ResourceItem) => fieldText(fieldValue(item.raw, field.path)) })),
        { id: 'age', label: 'Age', align: 'right', get: (item: ResourceItem) => item.age },
      ];
    }
    return [
      BASE_COLUMNS[0],
      ...(customType.namespaced ? [BASE_COLUMNS[1]] : []),
      { id: 'status', label: 'Status', get: (item: ResourceItem) => item.status },
      { id: 'age', label: 'Age', align: 'right', get: (item: ResourceItem) => item.age },
    ];
  }, [effectiveKind, customType]);
  const tableRef = useRef<HTMLDivElement>(null);
  const resizeCleanup = useRef<() => void>(() => {});
  useEffect(() => () => resizeCleanup.current(), []);
  const paneRef = useRef<HTMLDivElement>(null);
  const [compactFilters, setCompactFilters] = useState(true);
  const currentContext = useClusterStore((s) => s.currentContext);
  const watchState = useResourceStore((s) => s.watchStates[effectiveKind]);
  const loadError = useResourceStore((s) => s.loadErrors[effectiveKind]);
  const kindLoading = useResourceStore(state => state.loadingKinds[effectiveKind]);
  const syncMode = useResourceStore(state => state.syncMode);

  const [sortId, setSortId] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<1 | -1>(1);
  const [healthFilter, setHealthFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('');
  const [statusPriority, setStatusPriority] = useState('');
  const [menu, setMenu] = useState<{ item: ResourceItem; x: number; y: number } | null>(null);
  const [headerMenu, setHeaderMenu] = useState<{ colId: string; x: number; y: number } | null>(null);
  const [pfFor, setPfFor] = useState<ResourceItem | null>(null);
  const [scaleFor, setScaleFor] = useState<ResourceItem | null>(null);
  const [restartFor, setRestartFor] = useState<ResourceItem | null>(null);
  const [confirmFor, setConfirmFor] = useState<ResourceItem | null>(null);
  const [drainFor, setDrainFor] = useState<ResourceItem | null>(null);
  const [evictFor, setEvictFor] = useState<ResourceItem | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [spinning, setSpinning] = useState(false);
  useEffect(() => setSpinning(false), [currentContext, selectedNamespace, effectiveKind]);

  /* JetBrains DataGrip Multi-selection and Keyboard state */
  const [selectedUids, setSelectedUids] = useState<Set<string>>(new Set());
  const [focusedIndex, setFocusedIndex] = useState<number>(0);
  const [lastSelectedIndex, setLastSelectedIndex] = useState<number | null>(null);

  const perspective = kindsFor(activePerspective);
  const noKinds = !explicitKind && perspective.length === 0;
  useEffect(() => {
    const pane = paneRef.current;
    if (!pane) return;
    const update = () => setCompactFilters(pane.clientWidth / uiFactor(uiScale) < 760);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(pane);
    return () => observer.disconnect();
  }, [uiScale, noKinds]);

  useEffect(() => {
    const dk = defaultKindFor(activePerspective);
    if (!explicitKind && dk && !perspective.includes(activeKind)) {
      setActiveKind(dk);
      setSearchQuery('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePerspective, explicitKind]);

  useEffect(() => {
    setSearchQuery('');
    setSortId(null);
    setHealthFilter('all');
    setStatusFilter('');
    setStatusPriority('');
    setSelectedUids(new Set());
    setFocusedIndex(0);

  }, [effectiveKind, currentContext, setSearchQuery]);

  const kindResources = resources[effectiveKind];
  const allItems = useMemo(() => Array.from(kindResources?.values() ?? []), [kindResources]);
  const pending = !loadError && (customType ? custom.loading : syncMode === 'watch' ? !watchState ? isLoading : ['connecting', 'syncing'].includes(watchState.phase) : kindLoading ?? isLoading);
  const initialLoading = pending && !allItems.length;
  const statuses = useMemo(() => [...new Set(allItems.filter(item => inNamespaceScope(selectedNamespace, item.namespace)).map(item => tableColumns.find(column => column.id === 'status')?.get(item) || '—'))].sort(), [allItems, tableColumns, selectedNamespace]);
  const podsCurrent = useResourceStore((s) => s.syncMode !== 'watch' || s.watchStates.Pod?.phase === 'live');
  const podError = useResourceStore((state) => state.loadErrors.Pod);
  const issueRanks = useMemo(() => {
    const ranks = new Map<string, number>();
    if (healthFilter !== 'issues' && sortId !== '__issues') return ranks;
    const podsByNamespace = new Map<string | undefined, ResourceItem[]>();
    if (effectiveKind === 'Service') for (const pod of resources.Pod.values()) {
      if (!podsByNamespace.has(pod.namespace)) podsByNamespace.set(pod.namespace, []);
      podsByNamespace.get(pod.namespace)!.push(pod);
    }
    const storageClasses = new Map([...resources.StorageClass.values()].map((entry) => [entry.name, entry]));
    const now = Date.now();
    for (const item of allItems) {
      const storageClassName = item.spec?.storageClassName ?? item.storageClass;
      ranks.set(item.uid, issuePriority(resourceIssues(item, {
        now, pods: podsByNamespace.get(item.namespace) ?? [], podsLoaded: isConnected && !isLoading && podsCurrent && !podError,
        storageClass: typeof storageClassName === 'string' ? storageClasses.get(storageClassName) : undefined,
      })));
    }
    return ranks;
  }, [allItems, effectiveKind, healthFilter, sortId, resources.Pod, resources.StorageClass, isConnected, isLoading, podsCurrent, podError]);

  const rows = useMemo(() => {
    let list = allItems;
    if (selectedNamespace !== 'all') list = list.filter((i) => inNamespaceScope(selectedNamespace, i.namespace));
    const q = searchQuery.trim();
    if (q) {
      if (searchRegex) {
        try {
          const rx = new RegExp(q, 'i');
          list = list.filter((i) => rx.test(i.name) || (i.namespace && rx.test(i.namespace)));
        } catch {
          list = [];
        }
      } else {
        const qLower = q.toLowerCase();
        list = list.filter((i) => {
          if (i.name.toLowerCase().includes(qLower) || (i.namespace ?? '').toLowerCase().includes(qLower)) return true;
          if (effectiveKind === 'CustomResourceDefinition') {
            const spec = (i.raw as any)?.spec ?? i.spec;
            if (spec?.group && String(spec.group).toLowerCase().includes(qLower)) return true;
            if (spec?.names?.kind && String(spec.names.kind).toLowerCase().includes(qLower)) return true;
            if (spec?.names?.plural && String(spec.names.plural).toLowerCase().includes(qLower)) return true;
            if (spec?.names?.singular && String(spec.names.singular).toLowerCase().includes(qLower)) return true;
            if (Array.isArray(spec?.names?.shortNames) && spec.names.shortNames.some((s: string) => String(s).toLowerCase().includes(qLower))) return true;
          }
          return false;
        });
      }
    }
    if (healthFilter === 'issues') list = list.filter((item) => (issueRanks.get(item.uid) ?? 0) > 0);
    if (statusFilter) list = list.filter(item => (tableColumns.find(column => column.id === 'status')?.get(item) || '—') === statusFilter);

    const hidden = new Set(hiddenColumns[effectiveKind] ?? []);
    const cols = tableColumns.filter((c) => c.id === 'name' || !hidden.has(c.id));
    if (sortId === '__issues') {
      list = [...list].sort((a, b) => (issueRanks.get(b.uid) ?? 0) - (issueRanks.get(a.uid) ?? 0) || a.name.localeCompare(b.name) || a.uid.localeCompare(b.uid));
    } else if (sortId === '__created' || sortId === 'age') {
      list = [...list].sort((a, b) => compareCreation(a, b, sortId === 'age' ? sortDir === 1 ? -1 : 1 : sortDir));
    } else if (sortId === 'status' && statusPriority) {
      const column = tableColumns.find(column => column.id === 'status');
      list = [...list].sort((a, b) => compareStatusFirst(column?.get(a), column?.get(b), statusPriority) || a.name.localeCompare(b.name) || a.uid.localeCompare(b.uid));
    } else if (sortId) {
      const col = cols.find((c) => c.id === sortId);
      if (col) {
        list = [...list].sort((a, b) => {
          const av = col.get(a) ?? '';
          const bv = col.get(b) ?? '';
          const an = parseFloat(av);
          const bn = parseFloat(bv);
          const numeric = !Number.isNaN(an) && !Number.isNaN(bn) && /^[\d.]/.test(av) && /^[\d.]/.test(bv);
          const cmp = numeric ? (an === bn ? 0 : an < bn ? -1 : 1) : av.localeCompare(bv);
          return cmp * sortDir || (a.namespace && b.namespace && a.namespace !== b.namespace ? a.namespace.localeCompare(b.namespace) : 0) || a.name.localeCompare(b.name);
        });
      }
    } else {
      list = [...list].sort((a, b) => (a.namespace && b.namespace && a.namespace !== b.namespace ? a.namespace.localeCompare(b.namespace) : 0) || a.name.localeCompare(b.name) || a.uid.localeCompare(b.uid));
    }
    return { list, cols };
  }, [allItems, selectedNamespace, searchQuery, searchRegex, effectiveKind, sortId, sortDir, hiddenColumns, healthFilter, statusFilter, statusPriority, issueRanks, tableColumns]);
  useEffect(() => { setFocusedIndex(0); setLastSelectedIndex(null); }, [selectedNamespace, searchQuery, healthFilter, statusFilter, statusPriority, sortId, sortDir]);
  const order = sortId === '__issues' ? 'issues' : sortId === '__created' ? sortDir === -1 ? 'newest' : 'oldest' : sortId === 'name' ? sortDir === 1 ? 'name-asc' : 'name-desc' : sortId ? 'column' : 'default';

  const virtualized = rows.list.length > 200;
  const rowHeight = Math.ceil(Math.max((density === 'compact' ? 25 : 30) * uiFactor(uiScale), (11.5 * 1.45 + 8) * uiFactor(uiScale) + 1));
  const rowVirtualizer = useVirtualizer({ count: rows.list.length, getScrollElement: () => tableRef.current, estimateSize: () => rowHeight, overscan: 12,
    enabled: virtualized, getItemKey: index => rows.list[index]?.uid ?? index });
  const virtualRows = rowVirtualizer.getVirtualItems();
  const renderedRows = virtualized ? virtualRows.map(row => ({ item: rows.list[row.index], index: row.index })) : rows.list.map((item, index) => ({ item, index }));
  useEffect(() => { if (virtualized && rows.list.length) rowVirtualizer.scrollToIndex(Math.min(focusedIndex, rows.list.length - 1), { align: 'auto' }); }, [focusedIndex, virtualized, rows.list.length]);

  const resizeColumnWithKeyboard = (event: React.KeyboardEvent, id: string) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const width = event.key === 'Home' ? DEFAULT_COL_SIZE[id] ?? 120
      : widthFor(id) + (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 40 : 10);
    setColumnWidth(effectiveKind, id, Math.max(id === '__index' ? 28 : MIN_COL, Math.min(MAX_COL, (tableRef.current?.clientWidth ?? MAX_COL * uiFactor(uiScale)) / uiFactor(uiScale), width)));
  };

  /* ------------------- Keyboard Navigation ------------------- */
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!tableRef.current?.contains(e.target as Node)) return;
      if ((e.target as HTMLElement).closest('[role="dialog"], [role="menu"], [contenteditable="true"]')) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'BUTTON' || (e.target as HTMLElement).closest('[role="separator"]')) return;
      if (rows.list.length === 0) return;

      if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
        e.preventDefault();
        const item = rows.list[focusedIndex];
        const rect = tableRef.current?.querySelector(`[data-row-index="${focusedIndex}"]`)?.getBoundingClientRect();
        if (item && rect) setMenu({ item, x: rect.left + 60, y: rect.top + rect.height / 2 });
      } else if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        const index = e.key === 'Home' ? 0 : rows.list.length - 1;
        setFocusedIndex(index);
        if (virtualized) rowVirtualizer.scrollToIndex(index, { align: 'auto' });
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setFocusedIndex((prev) => Math.min(rows.list.length - 1, prev + 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setFocusedIndex((prev) => Math.max(0, prev - 1));
      } else if (e.key === ' ') {
        e.preventDefault();
        const cur = rows.list[focusedIndex];
        if (cur) toggleSelectRow(cur.uid, e.shiftKey, focusedIndex);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const cur = rows.list[focusedIndex];
        if (cur) openDetails(cur);
      } else if (e.key.toLowerCase() === 'y' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        const cur = rows.list[focusedIndex];
        if (cur) openYamlTab(cur);
      } else if (e.key.toLowerCase() === 'l' && !e.ctrlKey && !e.metaKey && effectiveKind === 'Pod') {
        e.preventDefault();
        const cur = rows.list[focusedIndex];
        if (cur) openLogsTab(cur);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [rows.list, focusedIndex, effectiveKind]);

  /* ------------------- Selection Helpers ------------------- */
  const toggleSelectRow = (uid: string, shiftKey = false, idx?: number) => {
    setSelectedUids((prev) => {
      const next = new Set(prev);
      if (shiftKey && lastSelectedIndex !== null && idx !== undefined) {
        const start = Math.min(lastSelectedIndex, idx);
        const end = Math.max(lastSelectedIndex, idx);
        for (let i = start; i <= end; i++) {
          if (rows.list[i]) next.add(rows.list[i].uid);
        }
      } else {
        if (next.has(uid)) next.delete(uid);
        else next.add(uid);
        if (idx !== undefined) setLastSelectedIndex(idx);
      }
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedUids.size === rows.list.length) {
      setSelectedUids(new Set());
    } else {
      setSelectedUids(new Set(rows.list.map((r) => r.uid)));
    }
  };

  /* ------------------- Column widths (Lens-style) ------------------- */
  const [autoWidths, setAutoWidths] = useState<Record<string, number>>({});
  const visibleColumnIds = ['__index', ...rows.cols.map(column => column.id)];
  const columnsSignature = visibleColumnIds.join('|');
  const fitColumns = (force = false) => {
    const pane = paneRef.current; if (!pane?.clientWidth) return;
    const stored = useUiStore.getState().columnWidths;
    const manual = Object.fromEntries(visibleColumnIds.filter(id => Number.isFinite(stored[`${effectiveKind}:${id}`])).map(id => [id, stored[`${effectiveKind}:${id}`]]));
    if (!force && Object.keys(manual).length) return;
    const available = Math.max(300, pane.clientWidth / uiFactor(uiScale) - 2);
    setAutoWidths(fitTableColumns(visibleColumnIds, available, DEFAULT_COL_SIZE, manual));
  };
  const fitRef = useRef(fitColumns); fitRef.current = fitColumns;
  useLayoutEffect(() => {
    fitRef.current(true);
    if (!paneRef.current) return;
    const observer = new ResizeObserver(() => fitRef.current()); observer.observe(paneRef.current);
    return () => observer.disconnect();
  }, [effectiveKind, columnsSignature, uiScale]);
  const resetWidths = () => { resetColumnWidths(effectiveKind); fitRef.current(true); };
  const widthFor = (colId: string): number =>
    Math.max(colId === '__index' ? 28 : MIN_COL, Math.min(MAX_COL, columnWidths[`${effectiveKind}:${colId}`] ?? autoWidths[colId] ?? DEFAULT_COL_SIZE[colId] ?? 120));

  const startColResize = (e: React.PointerEvent, colId: string) => {
    e.preventDefault();
    e.stopPropagation();
    resizeCleanup.current();
    const pane = tableRef.current;
    if (!pane) return;
    const bounds = pane.getBoundingClientRect();
    const guide = document.createElement('div');
    guide.dataset.testid = 'column-resize-guide';
    guide.setAttribute('aria-hidden', 'true');
    Object.assign(guide.style, {
      position: 'fixed',
      width: '2px',
      background: 'var(--accent)',
      top: `${bounds.top}px`,
      height: `${pane.clientHeight}px`,
      pointerEvents: 'none',
      zIndex: '65',
    });
    document.body.append(guide);

    const scale = uiFactor(useUiStore.getState().uiScale);
    const th = (e.currentTarget as HTMLElement).closest('th');
    const headerLeft = th?.getBoundingClientRect().left ?? bounds.left;
    const startW = widthFor(colId);
    const startX = e.clientX;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    guide.style.left = `${Math.min(bounds.right - 2, headerLeft + startW * scale)}px`;
    el.style.background = 'var(--accent)';

    let finalW = startW;
    const minW = colId === '__index' ? 28 : MIN_COL;
    const maxW = MAX_COL;

    const move = (ev: PointerEvent) => {
      const currentScale = uiFactor(useUiStore.getState().uiScale);
      const delta = (ev.clientX - startX) / currentScale;
      finalW = Math.round(Math.max(minW, Math.min(maxW, startW + delta)));
      guide.style.left = `${Math.max(bounds.left + minW * currentScale, headerLeft + finalW * currentScale)}px`;
    };

    const up = () => {
      guide.remove();
      el.style.background = '';
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.removeEventListener('lostpointercapture', up);
      setColumnWidth(effectiveKind, colId, finalW);
    };

    resizeCleanup.current = up;
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('lostpointercapture', up);
  };

  const buildHeaderMenu = (colId: string): MenuItem[] => {
    const col = tableColumns.find((c) => c.id === colId);
    return [
      ...(colId === 'status' ? statuses.map(status => ({ id: `status-${status}`, label: `Show ${status} first`, checked: sortId === 'status' && statusPriority === status, onSelect: () => { setStatusPriority(status); setSortId('status'); setSortDir(1); } })) : []),
      ...(colId === 'status' ? [{ id: 'status-separator', label: '', separator: true }] : []),
      { id: 'asc', label: 'Sort ascending', icon: ArrowUp, kbd: sortId === colId && sortDir === 1 && !(colId === 'status' && statusPriority) ? '✓' : undefined, onSelect: () => { setStatusPriority(''); setSortId(colId); setSortDir(1); } },
      { id: 'desc', label: 'Sort descending', icon: ArrowDown, kbd: sortId === colId && sortDir === -1 && !(colId === 'status' && statusPriority) ? '✓' : undefined, onSelect: () => { setStatusPriority(''); setSortId(colId); setSortDir(-1); } },
      ...(sortId === colId ? [{ id: 'sort-clear', label: 'Clear sorting', onSelect: () => setSortId(null) } as MenuItem] : []),
      { id: 'sep-h1', label: '', separator: true, onSelect: () => {} },
      {
        id: 'hide',
        label: `Hide “${col?.label ?? colId}”`,
        icon: XCircle,
        disabled: colId === 'name',
        onSelect: () => {
          const cur = new Set(hiddenColumns[effectiveKind] ?? []);
          cur.add(colId);
          setHiddenColumns(effectiveKind, Array.from(cur));
          toast.info('Column hidden', `Restore via the Columns menu in the toolbar`);
        },
      },
      { id: 'sep-h2', label: '', separator: true, onSelect: () => {} },
      { id: 'reset-widths', label: 'Reset column widths', onSelect: () => { resetWidths(); toast.info('Column widths reset', effectiveKind); } },
    ];
  };

  /* --------------------------- Actions --------------------------- */
  const openYaml = (item: ResourceItem) => {
    selectItem(item);
    setRightTab('yaml');
    if (inspectorCollapsed) toggleInspector();
  };

  const openYamlTab = (item: ResourceItem) => {
    openYamlEditor(item);
  };

  const openDetails = (item: ResourceItem) => {
    selectItem(item);
    setRightTab('overview');
    if (inspectorCollapsed) toggleInspector();
  };

  const refresh = async () => {
    if (!currentContext) return;
    if (customType) { custom.refresh(); return; }
    setSpinning(true);
    try {
      if (await refreshResourceWatches(effectiveKind)) return;
      await syncResourceSnapshot(currentContext, effectiveKind, selectedNamespace);
    } catch (error) {
      toast.error('Refresh failed', String(error));
    } finally { setSpinning(false); }
  };

  const doDelete = async (item: ResourceItem) => {
    try {
      if (k8s.demo) {
        deleteItem(item.kind, item.uid);
        toast.warn('Deleted from demo memory', `${item.kind}/${item.name}`);
      } else {
        if (!currentContext) return;
        await k8s.deleteResource(
          currentContext,
          item.kind,
          item.name,
          item.namespace,
          item.uid,
          item.raw?.metadata?.resourceVersion ?? '',
          item.apiVersion
        );
        deleteItem(item.kind, item.uid);
        toast.success('Resource deleted', `${item.kind}/${item.name}`);
        await refresh();
      }
    } catch (err: any) {
      if (err?.code === 'cancelled') {
        toast.info('Delete cancelled');
      } else {
        toast.error('Delete failed', String(err?.message || err));
      }
    }
  };

  const doScale = async (item: ResourceItem, replicas: number) => {
    if (!currentContext || !['Deployment', 'StatefulSet', 'ReplicaSet'].includes(item.kind)) return;
    try {
      await k8s.scaleWorkload(currentContext, item.kind, item.name, item.namespace || 'default', replicas, item.uid, item.raw?.metadata?.resourceVersion ?? '');
      if (useClusterStore.getState().currentContext !== currentContext) return;
      if (k8s.demo) updateItem(item.kind, item.uid, { replicas });
      else await refresh();
      toast.success(`Desired replicas updated to ${replicas}`, `${item.kind}/${item.name}`);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'cancelled') toast.info('Scale cancelled');
      else toast.error('Scale failed', String(error));
    }
  };

  const doRestart = async (item: ResourceItem) => {
    if (!currentContext && !k8s.demo) {
      toast.error('No active cluster context');
      return;
    }
    const raw = JSON.parse(JSON.stringify(item.raw ?? {}));
    raw.spec = raw.spec ?? {};
    raw.spec.template = raw.spec.template ?? {};
    raw.spec.template.metadata = raw.spec.template.metadata ?? {};
    raw.spec.template.metadata.annotations = raw.spec.template.metadata.annotations ?? {};
    raw.spec.template.metadata.annotations['kubectl.kubernetes.io/restartedAt'] = new Date().toISOString();

    try {
      if (k8s.demo) {
        updateItem(item.kind, item.uid, { ...item, raw });
        toast.success(`Rollout restart triggered for ${item.kind}/${item.name} (demo)`);
      } else {
        await k8s.applyManifest(currentContext!, stringify(raw), item);
        await refresh();
        toast.success(`Rollout restart triggered for ${item.kind}/${item.name}`);
      }
    } catch (err: any) {
      if (err?.code === 'cancelled') {
        toast.info('Restart cancelled');
      } else {
        toast.error('Restart failed', String(err?.message || err));
      }
    }
  };

  const doToggleCordon = async (node: ResourceItem): Promise<'success' | 'cancelled' | 'failed'> => {
    if (!currentContext && !k8s.demo) {
      toast.error('No active cluster context');
      return 'failed';
    }
    const currentlyUnschedulable = node.raw?.spec?.unschedulable === true;
    const nextUnschedulable = !currentlyUnschedulable;
    const raw = JSON.parse(JSON.stringify(node.raw ?? {}));
    raw.spec = raw.spec ?? {};
    raw.spec.unschedulable = nextUnschedulable;

    try {
      if (k8s.demo) {
        updateItem('Node', node.uid, { ...node, raw });
        toast.success(`Node ${node.name} ${nextUnschedulable ? 'cordoned' : 'uncordoned'} (demo)`);
        return 'success';
      } else {
        await k8s.applyManifest(currentContext!, stringify(raw), node);
        await refresh();
        toast.success(`Node ${node.name} ${nextUnschedulable ? 'cordoned' : 'uncordoned'}`);
        return 'success';
      }
    } catch (err: any) {
      if (err?.code === 'cancelled') {
        toast.info(`Cordon cancelled`);
        return 'cancelled';
      } else {
        toast.error(`Failed to update cordon state`, String(err?.message || err));
        return 'failed';
      }
    }
  };

  const doDrain = async (node: ResourceItem) => {
    if (!currentContext && !k8s.demo) {
      toast.error('No active cluster context');
      return;
    }
    if (!node.raw?.spec?.unschedulable) {
      const outcome = await doToggleCordon(node);
      if (outcome !== 'success') {
        return;
      }
    }
    const allPods = [...(useResourceStore.getState().resources.Pod?.values() ?? [])];
    const nodePods = allPods.filter(
      (p) => (p.raw?.spec?.nodeName === node.name || p.node === node.name) &&
        !p.raw?.metadata?.ownerReferences?.some((o: any) => o.kind === 'DaemonSet')
    );

    if (nodePods.length === 0) {
      toast.success(`Node ${node.name} cordoned; no non-daemonset pods to drain`);
      return;
    }

    let evicted = 0;
    let failed = 0;
    for (const pod of nodePods) {
      try {
        if (k8s.demo) {
          useResourceStore.getState().deleteItem('Pod', pod.uid);
          evicted++;
        } else {
          await k8s.evictPod(currentContext!, pod.name, pod.namespace ?? 'default', pod.uid, pod.raw?.metadata?.resourceVersion ?? '');
          evicted++;
        }
      } catch (err: any) {
        if (err?.code === 'cancelled') {
          toast.info(`Drain cancelled. ${evicted} pod(s) evicted.`);
          if (!k8s.demo && evicted > 0) await refresh();
          return;
        }
        failed++;
        toast.error(`Eviction failed for pod ${pod.name}`, String(err?.message || err));
      }
    }
    if (evicted > 0 || failed === 0) {
      if (!k8s.demo) await refresh();
      toast.success(`Drained ${evicted} pod(s) from node ${node.name}${failed > 0 ? ` (${failed} failed)` : ''}`);
    }
  };

  const doEvictPod = async (pod: ResourceItem) => {
    if (!currentContext && !k8s.demo) {
      toast.error('No active cluster context');
      return;
    }
    try {
      if (k8s.demo) {
        useResourceStore.getState().deleteItem('Pod', pod.uid);
        toast.success(`Pod ${pod.name} evicted (demo)`);
      } else {
        await k8s.evictPod(currentContext!, pod.name, pod.namespace ?? 'default', pod.uid, pod.raw?.metadata?.resourceVersion ?? '');
        await refresh();
        toast.success(`Pod ${pod.name} evicted`);
      }
    } catch (err: any) {
      if (err?.code === 'cancelled') toast.info('Evict cancelled');
      else toast.error('Evict failed', String(err?.message || err));
    }
  };

  const doToggleCronJobSuspend = async (cronJob: ResourceItem) => {
    if (!currentContext && !k8s.demo) {
      toast.error('No active cluster context');
      return;
    }
    const currentSuspended = cronJob.raw?.spec?.suspend === true;
    const nextSuspended = !currentSuspended;
    const raw = JSON.parse(JSON.stringify(cronJob.raw ?? {}));
    raw.spec = raw.spec ?? {};
    raw.spec.suspend = nextSuspended;

    try {
      if (k8s.demo) {
        updateItem('CronJob', cronJob.uid, { ...cronJob, raw });
        toast.success(`CronJob ${cronJob.name} ${nextSuspended ? 'suspended' : 'resumed'} (demo)`);
      } else {
        await k8s.applyManifest(currentContext!, stringify(raw), cronJob);
        await refresh();
        toast.success(`CronJob ${cronJob.name} ${nextSuspended ? 'suspended' : 'resumed'}`);
      }
    } catch (err: any) {
      if (err?.code === 'cancelled') toast.info('Suspend/resume cancelled');
      else toast.error('Failed to update CronJob suspend state', String(err?.message || err));
    }
  };

  const doTriggerCronJob = async (cronJob: ResourceItem) => {
    if (!currentContext && !k8s.demo) {
      toast.error('No active cluster context');
      return;
    }
    const spec = cronJob.raw?.spec ?? cronJob.spec ?? {};
    const manualJobName = `${cronJob.name}-manual-${Math.floor(Date.now() / 1000).toString().slice(-4)}`;
    const jobManifest = {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: {
        name: manualJobName,
        namespace: cronJob.namespace,
        annotations: {
          'cronjob.kubernetes.io/instantiate': 'manual',
        },
      },
      spec: spec.jobTemplate?.spec ?? {},
    };
    try {
      if (k8s.demo) {
        toast.success(`Job ${manualJobName} triggered from CronJob (demo)`);
      } else {
        await k8s.applyManifest(currentContext!, stringify(jobManifest));
        await refresh();
        toast.success(`Spawned Job ${manualJobName}`);
      }
    } catch (err: any) {
      if (err?.code === 'cancelled') toast.info('Run Now cancelled');
      else toast.error('Failed to trigger job', String(err?.message || err));
    }
  };

  const doArgoSync = async (app: ResourceItem) => {
    if (!currentContext && !k8s.demo) {
      toast.error('No active cluster context');
      return;
    }
    const raw = JSON.parse(JSON.stringify(app.raw ?? {}));
    raw.operation = {
      sync: {
        prune: true,
      },
    };
    try {
      if (k8s.demo) {
        updateItem(app.kind, app.uid, { ...app, raw });
        toast.success(`Sync requested for Argo CD app ${app.name} (demo)`);
      } else {
        await k8s.applyManifest(currentContext!, stringify(raw), app);
        await refresh();
        toast.success(`Sync requested for Argo CD app ${app.name}`);
      }
    } catch (err: any) {
      if (err?.code === 'cancelled') toast.info('Sync cancelled');
      else toast.error('Sync failed', String(err?.message || err));
    }
  };

  const doArgoRefresh = async (app: ResourceItem, hard = false) => {
    if (!currentContext && !k8s.demo) {
      toast.error('No active cluster context');
      return;
    }
    const raw = JSON.parse(JSON.stringify(app.raw ?? {}));
    raw.metadata = raw.metadata ?? {};
    raw.metadata.annotations = raw.metadata.annotations ?? {};
    raw.metadata.annotations['argocd.argoproj.io/refresh'] = hard ? 'hard' : 'normal';
    try {
      if (k8s.demo) {
        updateItem(app.kind, app.uid, { ...app, raw });
        toast.success(`${hard ? 'Hard refresh' : 'Refresh'} requested for ${app.name} (demo)`);
      } else {
        await k8s.applyManifest(currentContext!, stringify(raw), app);
        await refresh();
        toast.success(`${hard ? 'Hard refresh' : 'Refresh'} requested for ${app.name}`);
      }
    } catch (err: any) {
      if (err?.code === 'cancelled') toast.info('Refresh cancelled');
      else toast.error('Refresh failed', String(err?.message || err));
    }
  };

  const doShare = (item: ResourceItem) => {
    const cmd = `kubectl get ${item.kind.toLowerCase()} ${item.name}${item.namespace ? ` -n ${item.namespace}` : ''}`;
    navigator.clipboard.writeText(cmd)
      .then(() => toast.success(`Copied resource kubectl command`))
      .catch(() => toast.error('Clipboard unavailable'));
  };

  const buildRowMenu = (item: ResourceItem): MenuItem[] => {
    const crdType = item.kind === 'CustomResourceDefinition' ? customResourceType(item) : undefined;
    const items: MenuItem[] = [
      ...(crdType ? [{
        id: 'open-crd-resources',
        label: `View ${crdType.plural} (${crdType.name})`,
        icon: Boxes,
        onSelect: () => useWorkspaceStore.getState().openResourceList(crdType.key),
      }] : []),
      { id: 'hdr-nav', label: 'View & Inspect', header: true },
      { id: 'open', label: 'View in Inspector', kbd: '⏎', onSelect: () => openDetails(item) },
      { id: 'open-yaml-side', label: 'Inspect YAML (Side Panel)', onSelect: () => openYaml(item) },
      { id: 'open-tab', label: 'Open in Dedicated Tab', icon: ExternalLink, onSelect: () => openResourceDetail(item) },
      { id: 'yaml-tab', label: 'Open YAML Editor Tab', kbd: 'Y', icon: Braces, onSelect: () => openYamlTab(item) },
      {
        id: 'split-right',
        label: 'Open YAML in Split Right',
        icon: Columns2,
        onSelect: () => {
          openYamlTab(item);
          toggleSplit(resourceTabId('yaml', currentContext, item));
        },
      },
    ];

    // Observability & Terminal Actions
    const obsItems: MenuItem[] = [];
    if (!customType && item.kind === 'Pod') {
      obsItems.push(
        {
          id: 'dock-logs',
          label: 'Stream Logs in Bottom Drawer',
          icon: FileText,
          onSelect: () => useDockStore.getState().openLogs(item.name, item.namespace, undefined, podContainers(item).map((c) => c.name)),
        },
        { id: 'logs', label: 'Stream Logs in Full Tab', icon: ExternalLink, onSelect: () => openLogsTab(item) },
        {
          id: 'dock-terminal',
          label: 'Terminal in Bottom Drawer',
          icon: Terminal,
          onSelect: () => useDockStore.getState().openTerminal(item.name, item.namespace, undefined, podContainers(item).map((c) => c.name)),
        },
        {
          id: 'dock-attach',
          label: 'Attach in Bottom Drawer',
          icon: Play,
          onSelect: () => useDockStore.getState().openTerminal(item.name, item.namespace, undefined, podContainers(item).map((c) => c.name)),
        },
        { id: 'terminal', label: 'Terminal in Full Tab', icon: ExternalLink, onSelect: () => openTerminalTab(item) },
        { id: 'pf', label: 'Port-forward…', icon: ArrowRightLeft, onSelect: () => setPfFor(item) },
      );
    } else if (!customType && ['Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet', 'Job'].includes(item.kind)) {
      obsItems.push(
        {
          id: 'dock-logs',
          label: 'Stream Logs in Bottom Drawer',
          icon: FileText,
          onSelect: () => {
            const childPods = findWorkloadPods(item, useResourceStore.getState().resources);
            const activePod = preferredWorkloadPod(childPods);
            if (!activePod) {
              toast.info(`No active pods found for ${item.kind}/${item.name}`);
              return;
            }
            useDockStore.getState().openLogs(activePod.name, activePod.namespace, undefined, podContainers(activePod).map((c) => c.name));
          },
        },
        {
          id: 'logs',
          label: 'Logs in Full Tab',
          icon: ExternalLink,
          onSelect: () => openLogsTab(item),
        },
      );
    } else if (!customType && item.kind === 'Node') {
      obsItems.push({
        id: 'dock-node-shell',
        label: 'Node Shell in Bottom Drawer',
        icon: Terminal,
        onSelect: () => useDockStore.getState().openNodeShell(item.name),
      });
    } else if (!customType && item.kind === 'Service') {
      obsItems.push({ id: 'pf', label: 'Port-forward…', icon: ArrowRightLeft, onSelect: () => setPfFor(item) });
    }

    if (obsItems.length > 0) {
      items.push(
        { id: 'sep-obs', label: '', separator: true },
        { id: 'hdr-obs', label: 'Logs & Shell', header: true },
        ...obsItems
      );
    }

    // Operations & Lifecycle Actions
    const opItems: MenuItem[] = [];
    if (!customType && ['Deployment', 'StatefulSet'].includes(item.kind)) {
      opItems.push({ id: 'scale', label: 'Scale replicas…', icon: Maximize2, onSelect: () => setScaleFor(item) });
    }
    if (!customType && ['Deployment', 'StatefulSet', 'DaemonSet'].includes(item.kind)) {
      opItems.push({ id: 'restart', label: 'Restart rollout', icon: RotateCw, onSelect: () => setRestartFor(item) });
    }
    if (!customType && item.kind === 'ReplicaSet') {
      opItems.push({ id: 'scale', label: 'Scale replicas…', icon: Maximize2, onSelect: () => setScaleFor(item) });
    }
    if (!customType && item.kind === 'CronJob') {
      const isSuspended = item.raw?.spec?.suspend === true;
      opItems.push(
        { id: 'trigger', label: 'Trigger (Run Now)', icon: Play, onSelect: () => doTriggerCronJob(item) },
        { id: 'suspend', label: isSuspended ? 'Resume CronJob' : 'Suspend CronJob', icon: isSuspended ? Play : Pause, onSelect: () => doToggleCronJobSuspend(item) },
      );
    }
    if (!customType && item.kind === 'Job') {
      opItems.push({ id: 'rerun', label: 'Rerun job (demo)', disabled: !k8s.demo, icon: RefreshCw, onSelect: () => toast.success('Job re-run queued (demo)', item.name) });
    }
    if (!customType && item.kind === 'Node') {
      const isUnschedulable = item.raw?.spec?.unschedulable === true;
      opItems.push(
        {
          id: 'cordon',
          label: isUnschedulable ? 'Uncordon Node' : 'Cordon Node',
          icon: isUnschedulable ? Play : Pause,
          onSelect: () => doToggleCordon(item),
        },
        {
          id: 'drain',
          label: 'Drain Node…',
          icon: ShieldAlert,
          danger: true,
          onSelect: () => setDrainFor(item),
        },
      );
    }
    if (gitOpsFamily(item) === 'argocd' && item.kind === 'Application') {
      opItems.push(
        { id: 'argo-sync', label: 'Sync Application…', icon: RotateCw, onSelect: () => doArgoSync(item) },
        { id: 'argo-refresh', label: 'Refresh (Normal)', icon: RefreshCw, onSelect: () => doArgoRefresh(item, false) },
        { id: 'argo-refresh-hard', label: 'Hard Refresh', icon: RefreshCw, onSelect: () => doArgoRefresh(item, true) },
        {
          id: 'argo-dashboard',
          label: 'Open Argo CD Dashboard',
          icon: ExternalLink,
          onSelect: () => {
            const argocdServer = [...(useResourceStore.getState().resources.Service?.values() ?? [])].find(
              (s) => s.name === 'argocd-server'
            );
            if (argocdServer) {
              setPfFor(argocdServer);
            } else {
              toast.info('argocd-server Service not found. Use port-forward on the argocd-server service to open UI.');
            }
          },
        }
      );
    }

    if (opItems.length > 0) {
      items.push(
        { id: 'sep-op', label: '', separator: true },
        { id: 'hdr-op', label: 'Operations', header: true },
        ...opItems
      );
    }

    // Common & Share
    items.push(
      { id: 'sep-share', label: '', separator: true },
      { id: 'share', label: 'Share resource (kubectl get)', icon: Share2, onSelect: () => doShare(item) },
      { id: 'copyName', label: 'Copy name', icon: Copy, onSelect: () => { navigator.clipboard.writeText(item.name).then(() => toast.success('Name copied')).catch(() => toast.error('Clipboard unavailable')); } },
    );

    // Danger zone
    const dangerItems: MenuItem[] = [];
    if (!customType && item.kind === 'Pod') {
      dangerItems.push({ id: 'evict', label: 'Evict Pod…', icon: Trash2, danger: true, onSelect: () => setEvictFor(item) });
    }
    dangerItems.push({ id: 'delete', disabled: !!customType, label: k8s.demo ? 'Delete (demo)…' : 'Delete…', icon: Trash2, danger: true, kbd: '⌫', onSelect: () => setConfirmFor(item) });

    items.push(
      { id: 'sep-danger', label: '', separator: true },
      ...dangerItems
    );

    return items;
  };

  /* --------------------------- Render --------------------------- */
  if (noKinds && !explicitKind) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center max-w-sm">
          <Boxes size="calc(40px * var(--ui-factor))" strokeWidth={1.2} className="mx-auto text-[var(--text-muted)] mb-3" />
          <div className="text-sm font-medium text-[var(--text-primary)]">Nothing here yet</div>
          <p className="text-xs text-[var(--text-secondary)] mt-1 leading-relaxed">
            Choose a resource from the Explorer tree.
          </p>
        </div>
      </div>
    );
  }

  const KindIcon = KIND_ICONS[effectiveKind] || Boxes;
  const rowH = density === 'compact' ? 'h-[calc(25px*var(--ui-factor))]' : 'h-[calc(30px*var(--ui-factor))]';
  const hiddenForKind = new Set(hiddenColumns[effectiveKind] ?? []);
  const activeFilters = Number(healthFilter !== 'all') + Number(Boolean(statusFilter)) + Number(order !== 'default');
  const filterControls = (
        <div className={cx('resource-filter-controls', compactFilters && 'resource-filter-controls-popup')}>
          <label className="resource-filter-field">{compactFilters && <span>Health</span>}<select aria-label="Resource health filter" className="ide-select max-w-full" value={healthFilter} onChange={(event) => setHealthFilter(event.target.value)}>
            <option value="all">All resources</option><option value="issues">With issues only</option>
          </select></label>
          {(statuses.length > 1 || statusFilter) && <label className="resource-filter-field">{compactFilters && <span>Status</span>}<select aria-label="Resource status filter" className="ide-select max-w-full" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
            <option value="">All statuses</option>
            {(statusFilter && !statuses.includes(statusFilter) ? [...statuses, statusFilter] : statuses).map((status) => <option key={status} value={status}>{status}</option>)}
          </select></label>}
          <label className="resource-filter-field">{compactFilters && <span>Order</span>}<select aria-label="Resource order" className="ide-select max-w-full" value={order} onChange={(event) => {
            const value = event.target.value;
            setSortId(value === 'issues' ? '__issues' : ['newest', 'oldest'].includes(value) ? '__created' : value.startsWith('name-') ? 'name' : null);
            setSortDir(value === 'newest' || value === 'name-desc' ? -1 : 1);
          }}>
            <option value="default">Sort: default</option><option value="issues">Issues first</option><option value="newest">Newest first</option><option value="oldest">Oldest first</option>
            <option value="name-asc">Name: A–Z</option><option value="name-desc">Name: Z–A</option>
            {order === 'column' && <option value="column">Sort: {tableColumns.find((column) => column.id === sortId)?.label}</option>}
          </select></label>
          {compactFilters && <Button size="sm" onClick={() => { setHealthFilter('all'); setStatusFilter(''); setSortId(null); }}>Reset filters and order</Button>}
        </div>
  );

  return (
    <div ref={paneRef} className="flex-1 flex flex-col min-h-0 min-w-0 relative bg-[var(--bg-canvas)]">
      {/* JetBrains DataGrip-Grade Toolbar */}
      <div className="h-9 shrink-0 flex items-center gap-2 px-3 border-b border-[var(--border-default)] bg-[var(--bg-canvas)]">
        <KindIcon size="calc(15px * var(--ui-factor))" strokeWidth={1.75} className="text-blue-400 shrink-0" />
        <span title={listLabel} className="truncate text-[length:calc(13px*var(--ui-factor))] font-semibold text-[var(--text-primary)]">{listLabel}</span>

        {selectedUids.size > 0 && (
          <span className="text-[length:calc(11px*var(--ui-factor))] font-mono text-[var(--accent)] px-2 py-[1px] rounded bg-[var(--accent-subtle)] font-medium">
            {selectedUids.size} selected
          </span>
        )}

        <div className="flex-1" />

        <Tooltip label={density === 'compact' ? 'Comfortable rows' : 'Compact rows'} delay={400}>
          <IconButton
            icon={density === 'compact' ? Minimize2 : Maximize2}
            size="sm"
            onClick={() => useUiStore.getState().setDensity(density === 'compact' ? 'comfortable' : 'compact')}
            aria-label="Toggle density"
          />
        </Tooltip>

        {/* Columns */}
        <Popover
          width={220}
          trigger={({ open }) => (
            <span className="inline-flex items-center" role="button" aria-label="Columns">
              <IconButton icon={SlidersHorizontal} size="sm" active={open} tooltip="Configure Columns" aria-label="Columns" />
            </span>
          )}
        >
          {(close) => (
            <>
              <div className="px-2.5 pt-1 pb-1.5 text-[length:calc(10px*var(--ui-factor))] font-semibold uppercase tracking-[0.06em] text-[var(--text-muted)]">
                Columns · {displayKind}
              </div>
              <MenuList
                items={tableColumns.map((c) => ({
                  id: c.id,
                  label: c.label,
                  checked: c.id === 'name' || !hiddenForKind.has(c.id),
                  disabled: c.id === 'name',
                  onSelect: () => {
                    const cur = new Set(hiddenColumns[effectiveKind] ?? []);
                    if (cur.has(c.id)) cur.delete(c.id);
                    else {
                      if (c.id === 'name') return;
                      cur.add(c.id);
                    }
                    setHiddenColumns(effectiveKind, Array.from(cur));
                  },
                }))}
                onSelect={(item) => item.onSelect?.()}
              />
              <div className="my-1 h-px bg-[var(--border-subtle)]" />
              <MenuList
                items={[
                  { id: 'reset', label: 'Reset visibility', onSelect: () => setHiddenColumns(effectiveKind, []) },
                  { id: 'reset-widths', label: 'Reset column widths', onSelect: resetWidths },
                ]}
                onSelect={(item) => { item.onSelect?.(); close(); }}
              />
              <div className="px-2.5 pb-1 pt-1.5 text-[length:calc(10px*var(--ui-factor))] text-[var(--text-muted)] leading-relaxed">
                Drag column borders to resize · right-click headers to sort or hide
              </div>
            </>
          )}
        </Popover>

        <Tooltip label="Refresh list" delay={400}>
          <IconButton icon={RefreshCw} size="sm" onClick={refresh} className={cx(spinning && 'animate-[spin_0.7s_linear_infinite]')} aria-label="Refresh" />
        </Tooltip>

        <Button variant="primary" size="sm" disabled={!!customType || !k8s.demo} title={k8s.demo ? "Create demo resource" : "Live creation is not connected yet"} onClick={() => setNewOpen(true)}>
          <Plus size="calc(13px * var(--ui-factor))" />
          New
        </Button>
      </div>

      <div className="resource-search-row border-b border-[var(--border-default)]" data-testid="resource-search-toolbar">
        <SearchInput
          value={searchQuery}
          onChange={setSearchQuery}
          isRegex={searchRegex}
          onToggleRegex={setSearchRegex}
          placeholder={`Filter ${displayKind.toLowerCase()}s…`}
          className="resource-search-field"
        />
        {compactFilters ? <Popover align="end" width={280} trigger={({ open }) => <button aria-label="Resource filters and sorting" aria-expanded={open} className={cx('resource-filter-trigger', open && 'border-[var(--accent)]')}>
          <SlidersHorizontal size="calc(13px * var(--ui-factor))" /><span>Filters</span>{activeFilters > 0 && <span className="text-[var(--accent)]">{activeFilters}</span>}
        </button>}>{() => <div role="group" aria-label="Resource filter options" className="p-3">{filterControls}</div>}</Popover> : filterControls}
      </div>

      {/* JetBrains DataGrip Data Table */}
      <div ref={tableRef} tabIndex={0} aria-label={`${displayKind} resource table`} aria-busy={pending || spinning} className="flex-1 overflow-auto kubiki-scrollbar min-h-0 select-text" data-testid="resource-table">
        {k8s.supportsResourceWatch && !customType && resourceType(effectiveKind).watch === false && <p className="px-3 py-1 text-xs text-[var(--text-secondary)]">This API supports snapshots only · refreshed every 30 seconds</p>}
        {loadError && <RequestErrorNotice error={loadError} onRetry={() => void refresh()} retainedData={allItems.length > 0 || watchState?.hasSnapshot === true} />}
        {initialLoading && <ResourceLoading label={`Loading ${displayKind} resources…`} description={watchState ? 'Waiting for the first complete snapshot from Kubernetes.' : 'Waiting for Kubernetes to respond.'} />}
        {!initialLoading && (pending || spinning) && <div className="resource-loading-overlay"><ResourceLoading compact label={`Refreshing ${displayKind} resources…`} /></div>}
        {watchState?.phase === 'reconnecting' && !loadError && <ResourceLoading compact label="Reconnecting… Showing the last complete snapshot." />}
        {rows.list.length === 0 ? !initialLoading && !loadError && (
          <EmptyState
            kind={displayKind}
            filtered={(selectedNamespace !== 'all' && allItems.length > 0) || !!searchQuery || healthFilter !== 'all' || !!statusFilter}
            onClear={() => { selectNamespace('all'); setSearchQuery(''); setHealthFilter('all'); setStatusFilter(''); }}
            isNew={!customType && k8s.demo && allItems.length === 0 && !loadError}
            onNew={() => setNewOpen(true)}
          />
        ) : (
          <table
            style={{ minWidth: uiPixels(widthFor('__index') + rows.cols.reduce((sum, col) => sum + widthFor(col.id), 0)) }}
            aria-rowcount={rows.list.length + 1}
            className="datagrip-grid table-fixed w-full min-w-full"
            onClick={() => tableRef.current?.focus({ preventScroll: true })}
          >
            <colgroup>
              <col style={{ width: uiPixels(widthFor('__index')) }} />
              {rows.cols.map((c) => (
                <col key={c.id} style={{ width: uiPixels(widthFor(c.id)) }} />
              ))}
            </colgroup>
            <thead>
              <tr>
                {/* Index & Selection Column */}
                <th aria-label="Row numbers" className="datagrip-th text-center p-0" style={{ width: uiPixels(widthFor('__index')) }}>
                  <div
                    onClick={toggleSelectAll}
                    className="w-full h-full flex items-center justify-center cursor-pointer text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                    title={selectedUids.size === rows.list.length ? 'Deselect all' : 'Select all'}
                  >
                    {selectedUids.size === 0 ? (
                      <Square size="calc(12px * var(--ui-factor))" />
                    ) : selectedUids.size === rows.list.length ? (
                      <CheckSquare size="calc(12px * var(--ui-factor))" className="text-[var(--accent)]" />
                    ) : (
                      <MinusSquare size="calc(12px * var(--ui-factor))" className="text-[var(--accent)]" />
                    )}
                  </div>
                  <span role="separator" aria-label="Resize row numbers column" tabIndex={0} aria-valuenow={widthFor('__index')} onKeyDown={(e) => resizeColumnWithKeyboard(e, '__index')} aria-orientation="vertical" title="Drag or use arrow keys to resize · Home to reset"
                    onPointerDown={(e) => startColResize(e, '__index')}
                    onDoubleClick={(e) => { e.stopPropagation(); setColumnWidth(effectiveKind, '__index', DEFAULT_COL_SIZE.__index); fitColumns(true); }}
                    onClick={(e) => e.stopPropagation()}
                    className="absolute right-0 top-0 h-full w-[calc(6px*var(--ui-factor))] cursor-col-resize touch-none hover:bg-[var(--accent)]/50 active:bg-[var(--accent)]" />
                </th>

                {rows.cols.map((c) => {
                  const active = sortId === c.id;
                  return (
                    <th
                      key={c.id}
                      aria-label={c.label}
                      aria-sort={active ? c.id === 'status' && statusPriority ? 'other' : sortDir === 1 ? 'ascending' : 'descending' : 'none'}
                      tabIndex={c.id === 'status' ? 0 : undefined}
                      onKeyDown={event => { if (c.id === 'status' && ['Enter', ' '].includes(event.key)) { event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect(); setHeaderMenu({ colId: c.id, x: rect.left, y: rect.bottom }); } }}
                      title={c.id === 'status' ? statusPriority && active ? `${statusPriority} first · choose another status` : 'Choose which status to show first' : undefined}
                      style={{ width: uiPixels(widthFor(c.id)) }}
                      onClick={event => {
                        if (c.id === 'status') { const rect = event.currentTarget.getBoundingClientRect(); setHeaderMenu({ colId: c.id, x: rect.left, y: rect.bottom }); return; }
                        if (active && sortDir === -1) { setSortId(null); }
                        else if (active) { setSortDir(-1); }
                        else { setSortId(c.id); setSortDir(1); }
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setHeaderMenu({ colId: c.id, x: e.clientX, y: e.clientY });
                      }}
                      className={cx(
                        'datagrip-th relative text-left font-medium cursor-pointer hover:text-[var(--text-primary)] transition-colors',
                        c.align === 'right' && 'text-right'
                      )}
                    >
                      <span className="inline-flex items-center gap-1">
                        {c.label}
                        {active && c.id === 'status' && statusPriority ? <span className="truncate text-[var(--accent)] text-[length:calc(10px*var(--ui-factor))]">{statusPriority} ↑</span> : active && (sortDir === 1 ? <ArrowUp size="calc(10px * var(--ui-factor))" className="text-[var(--accent)]" /> : <ArrowDown size="calc(10px * var(--ui-factor))" className="text-[var(--accent)]" />)}
                      </span>
                      {/* Drag handle for resizing column */}
                      <span
                        role="separator" aria-label={`Resize ${c.label} column`} tabIndex={0} aria-valuenow={widthFor(c.id)} onKeyDown={(e) => resizeColumnWithKeyboard(e, c.id)} aria-orientation="vertical"
                        title="Drag or use arrow keys to resize · Home to reset"
                        onPointerDown={(e) => startColResize(e, c.id)}
                        onDoubleClick={(e) => {
                          e.stopPropagation();
                          setColumnWidth(effectiveKind, c.id, DEFAULT_COL_SIZE[c.id] ?? 120);
                          fitColumns(true);
                        }}
                        onClick={(e) => e.stopPropagation()}
                        className="absolute right-0 top-0 h-full w-[calc(6px*var(--ui-factor))] cursor-col-resize touch-none hover:bg-[var(--accent)]/50 active:bg-[var(--accent)] transition-colors"
                      />
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {virtualized && (virtualRows[0]?.start ?? 0) > 0 && <tr aria-hidden="true" data-virtual-spacer><td colSpan={rows.cols.length + 1} style={{ height: virtualRows[0].start, padding: 0, border: 0 }} /></tr>}
              {renderedRows.map(({ item, index: idx }) => {
                const isSelected = selectedUids.has(item.uid);
                const isFocused = idx === focusedIndex;
                const isRowActive = selectedItem?.uid === item.uid;

                return (
                  <tr
                    key={item.uid}
                    data-index={idx} data-row-index={idx} data-resource-uid={item.uid} aria-rowindex={idx + 2}
                    ref={virtualized ? rowVirtualizer.measureElement : undefined}
                    style={virtualized ? { height: rowHeight } : undefined}
                    onClick={(e) => {
                      setFocusedIndex(idx);
                      if (e.shiftKey) {
                        toggleSelectRow(item.uid, true, idx);
                      } else if (e.metaKey || e.ctrlKey) {
                        toggleSelectRow(item.uid, false, idx);
                      } else {
                        openDetails(item);
                      }
                    }}
                    onDoubleClick={() => {
                      if (effectiveKind === 'CustomResourceDefinition') {
                        const crdType = customResourceType(item);
                        if (crdType) {
                          useWorkspaceStore.getState().openResourceList(crdType.key);
                          return;
                        }
                      }
                      openYamlTab(item);
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      selectItem(item);
                      setMenu({ item, x: e.clientX, y: e.clientY });
                    }}
                    className={cx(
                      'datagrip-row group/row transition-colors cursor-default',
                      rowH,
                      idx % 2 === 1 && 'bg-[var(--bg-stripe)]',
                      isSelected && 'selected',
                      isFocused && 'focused',
                      isRowActive && !isSelected && 'bg-[var(--bg-elevated)]/60'
                    )}
                  >
                    <td className="datagrip-cell text-center p-0 text-[length:calc(10px*var(--ui-factor))] font-mono text-[var(--text-muted)] select-none">
                      {isSelected ? <CheckSquare size="calc(12px * var(--ui-factor))" className="inline-block text-[var(--accent)]" /> : idx + 1}
                    </td>

                    {rows.cols.map((c) => (
                      <td
                        key={c.id}
                        className={cx(
                          'datagrip-cell px-2.5',
                          c.align === 'right' && 'text-right',
                          c.mono && 'font-mono text-[length:calc(11px*var(--ui-factor))]'
                        )}
                      >
                        <CellValue col={c} item={item} />
                      </td>
                    ))}

                  </tr>
                );
              })}
              {virtualized && virtualRows.length > 0 && <tr aria-hidden="true" data-virtual-spacer><td colSpan={rows.cols.length + 1} style={{ height: Math.max(0, rowVirtualizer.getTotalSize() - virtualRows[virtualRows.length - 1].end), padding: 0, border: 0 }} /></tr>}
            </tbody>
          </table>
        )}
      </div>

      {/* Row context menu */}
      {menu && <FixedMenu rect={{ x: menu.x, y: menu.y }} items={buildRowMenu(menu.item)} onClose={() => setMenu(null)} />}

      {/* Column header context menu */}
      {headerMenu && (
        <FixedMenu rect={{ x: headerMenu.x, y: headerMenu.y }} items={buildHeaderMenu(headerMenu.colId)} onClose={() => setHeaderMenu(null)} />
      )}

      {/* Action Dialogs */}
      <PFDialog item={pfFor} onClose={() => setPfFor(null)} />
      <ScaleDialog item={scaleFor} onClose={() => setScaleFor(null)} onApply={(n) => scaleFor && doScale(scaleFor, n)} />
      <RestartDialog item={restartFor} onClose={() => setRestartFor(null)} onConfirm={() => restartFor && doRestart(restartFor)} />
      <DeleteResourceDialog
        item={confirmFor}
        onClose={() => setConfirmFor(null)}
        onConfirm={() => confirmFor && doDelete(confirmFor)}
      />
      <ConfirmDialog
        open={!!drainFor}
        title={`Drain node ${drainFor?.name ?? ''}`}
        confirmLabel="Drain Node"
        onClose={() => setDrainFor(null)}
        onConfirm={() => drainFor && doDrain(drainFor)}
        message={
          <div>
            Cordon <strong className="font-mono text-[var(--text-primary)]">{drainFor?.name}</strong> and evict non-daemonset pods running on it?
          </div>
        }
      />
      <ConfirmDialog
        open={!!evictFor}
        title={`Evict pod ${evictFor?.name ?? ''}`}
        confirmLabel="Evict Pod"
        onClose={() => setEvictFor(null)}
        onConfirm={() => evictFor && doEvictPod(evictFor)}
        message={
          <div>
            Evict pod <strong className="font-mono text-[var(--text-primary)]">{evictFor?.name}</strong> from namespace <span className="font-mono">{evictFor?.namespace}</span>? This operation honors PodDisruptionBudgets.
          </div>
        }
      />
      <NewResourceDialog
        open={newOpen}
        kind={effectiveKind}
        defaultNs={defaultNamespace(selectedNamespace)}
        onClose={() => setNewOpen(false)}
        onCreate={(name, ns, yaml) => {
          if (!k8s.demo) return;
          const item: ResourceItem = {
            uid: `new-${crypto.randomUUID()}`,
            name,
            namespace: ns || undefined,
            kind: effectiveKind,
            apiVersion: apiVersionFor(effectiveKind),
            status: 'Active',
            age: '0s',
            rawYaml: yaml,
          };
          applyDelta({ type: 'Applied', payload: { gvk: effectiveKind, data: item } });
          toast.success(`${effectiveKind} created (demo)`, name);
          setNewOpen(false);
          openYamlTab(item);
        }}
      />
    </div>
  );
};

function CellValue({
  col,
  item,
}: {
  col: ColumnDef;
  item: ResourceItem;
}) {
  const v = col.get(item);
  if (v === undefined || v === '') return <span className="text-[var(--text-disabled)]">—</span>;

  if (col.id === 'name') {
    if (item.kind === 'CustomResourceDefinition') {
      const crdType = customResourceType(item);
      if (crdType) {
        return (
          <span className="inline-flex min-w-0 items-center gap-2 max-w-full align-middle">
            <ResourceWarnings item={item} />
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                useWorkspaceStore.getState().openResourceList(crdType.key);
              }}
              className="min-w-0 truncate text-[var(--accent)] hover:underline text-left font-mono text-[length:calc(11.5px*var(--ui-factor))] font-medium cursor-pointer"
              title={`View ${crdType.plural} (${v})`}
            >
              {v}
            </button>
          </span>
        );
      }
    }
    return <span className="inline-flex min-w-0 items-center gap-2 max-w-full align-middle"><ResourceWarnings item={item} /><span className="min-w-0 truncate text-[var(--text-primary)] font-mono text-[length:calc(11.5px*var(--ui-factor))] font-medium" title={v}>{v}</span></span>;
  }
  if (col.id === 'namespace') return <span className="text-[var(--text-secondary)]">{v}</span>;
  if (col.id === 'status' || col.id === 'conditions') return <StatusBadge status={v} />;

  if (col.id === 'pods') {
    const m = /^(\d+)\/(\d+)$/.exec(v);
    if (m) {
      const readyNum = Number(m[1]);
      const desiredNum = Number(m[2]) || 1;
      const pct = Math.min(100, Math.round((readyNum / desiredNum) * 100));
      const isOk = readyNum === desiredNum && readyNum > 0;
      const isZero = readyNum === 0;

      return (
        <div className="flex items-center gap-2">
          <div className="w-14 h-1.5 rounded-full bg-[var(--bg-surface)] overflow-hidden border border-[var(--border-subtle)] flex">
            <div
              style={{ width: `${pct}%` }}
              className={cx(
                'h-full transition-all duration-300',
                isOk ? 'bg-[var(--status-ok)]' : isZero ? 'bg-[var(--status-danger)]' : 'bg-[var(--status-warn)]'
              )}
            />
          </div>
          <span
            className={cx(
              'font-mono text-[length:calc(11px*var(--ui-factor))] font-semibold tabular-nums',
              isOk ? 'text-[var(--status-ok)]' : isZero ? 'text-[var(--status-danger)]' : 'text-[var(--status-warn)]'
            )}
          >
            {v}
          </span>
        </div>
      );
    }
    return <span className="font-mono text-[length:calc(11px*var(--ui-factor))]">{v}</span>;
  }

  if (col.id === 'replicas') return <span className="font-mono text-[length:calc(11px*var(--ui-factor))] tabular-nums text-[var(--text-primary)]">{v}</span>;

  if (col.id === 'containers') return <ContainerIndicators containers={item.containers ?? podContainers(item)} />;
  if (col.id === 'ready') {
    const m = /^(\d+)\/(\d+)$/.exec(v);
    const danger = m && m[1] !== m[2] && m[1] === '0';
    return <span className={cx('font-mono text-[length:calc(11px*var(--ui-factor))]', danger ? 'text-[var(--status-danger)]' : m && m[1] === m[2] ? 'text-[var(--status-ok)]' : 'text-[var(--text-primary)]')}>{v}</span>;
  }
  if (col.id === 'restarts') {
    const n = Number(v);
    return <span className={cx('font-mono text-[length:calc(11px*var(--ui-factor))]', n > 10 ? 'text-[var(--status-danger)]' : n > 0 ? 'text-[var(--status-warn)]' : 'text-[var(--text-secondary)]')}>{v}</span>;
  }
  if (col.id === 'age') return <span className="text-[var(--text-secondary)]">{v}</span>;
  return <span className="text-[var(--text-secondary)]">{v}</span>;
}

function EmptyState({ kind, filtered, onClear, isNew, onNew }: { kind: string; filtered: boolean; onClear: () => void; isNew: boolean; onNew: () => void }) {
  const Icon = KIND_ICONS[kind as ResourceKind] ?? Boxes;
  return (
    <div className="h-full min-h-[calc(220px*var(--ui-factor))] flex items-center justify-center">
      <div className="text-center max-w-sm px-6">
        <Icon size="calc(36px * var(--ui-factor))" strokeWidth={1.2} className="mx-auto text-[var(--text-muted)] mb-3" />
        <div className="text-sm font-medium text-[var(--text-primary)]">
          {filtered ? `No ${kind.toLowerCase()}s match your filters` : `No ${kind.toLowerCase()}s found`}
        </div>
        <p className="text-xs text-[var(--text-secondary)] mt-1.5 leading-relaxed">
          {filtered ? 'Try a different namespace or clear the search query.' : 'The cluster reports zero objects of this kind.'}
        </p>
        <div className="flex items-center justify-center gap-2 mt-4">
          {filtered && (
            <Button size="sm" onClick={onClear}>
              <XCircle size="calc(12px * var(--ui-factor))" /> Clear filters
            </Button>
          )}
          {isNew && (
            <Button size="sm" variant="primary" onClick={onNew}>
              <Plus size="calc(12px * var(--ui-factor))" /> Create {kind}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function NewResourceDialog({
  open, kind, defaultNs, onClose, onCreate,
}: {
  open: boolean;
  kind: ResourceKind;
  defaultNs: string;
  onClose: () => void;
  onCreate: (name: string, ns: string, yaml: string) => void;
}) {
  const [name, setName] = useState('');
  const [ns, setNs] = useState(defaultNs);
  const [yaml, setYaml] = useState('');

  useEffect(() => {
    if (open) {
      setName(`my-${kind.toLowerCase()}`);
      setNs(defaultNs);
      setYaml(templateFor(kind, `my-${kind.toLowerCase()}`, defaultNs));
    }
  }, [open, kind, defaultNs]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={560}
      title={`New ${kind}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!/^[a-z0-9][a-z0-9-]*$/.test(name)} onClick={() => onCreate(name, ns, yaml)}>
            Create (demo)
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <Label>Name (DNS-1123)</Label>
            <Input value={name} onChange={(e) => { setName(e.target.value); setYaml(templateFor(kind, e.target.value || '…', ns)); }} />
            {!/^[a-z0-9][a-z0-9-]*$/.test(name) && <span className="text-[length:calc(10px*var(--ui-factor))] text-[var(--status-danger)]">lowercase letters, digits and “-” only</span>}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Namespace</Label>
            <Input value={ns} onChange={(e) => { setNs(e.target.value); setYaml(templateFor(kind, name, e.target.value)); }} />
          </div>
        </div>
        <div className="flex flex-col gap-1.5 flex-1 min-h-0">
          <Label>Manifest</Label>
          <textarea
            value={yaml}
            onChange={(e) => setYaml(e.target.value)}
            spellCheck={false}
            className="flex-1 min-h-[calc(220px*var(--ui-factor))] resize-none bg-[var(--bg-canvas)] border border-[var(--border-default)] rounded-[calc(6px*var(--ui-factor))] p-3 font-mono text-[length:calc(11.5px*var(--ui-factor))] text-[var(--text-primary)] outline-none focus:border-[var(--accent)] transition-colors kubiki-scrollbar"
          />
        </div>
        <p className="text-[length:calc(11px*var(--ui-factor))] text-[var(--text-muted)]">
          Demo mode — manifest will be stored in local memory store.
        </p>
      </div>
    </Modal>
  );
}
