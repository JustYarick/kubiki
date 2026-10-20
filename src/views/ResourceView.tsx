import React, { useEffect, useMemo, useState, useRef } from 'react';
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
} from 'lucide-react';
import { useResourceStore } from '../state/resource_store';
import { useClusterStore } from '../state/cluster_store';
import { useUiStore } from '../state/ui_store';
import { useWorkspaceStore } from '../state/workspace_store';
import { useDockStore } from '../state/dock_store';
import { k8s } from '../providers/k8s_provider';
import { KIND_ICONS, defaultKindFor, kindsFor } from '../core/perspectives';
import { ResourceWarnings } from '../components/k8s/ResourceWarnings';
import { StatusBadge } from '../components/k8s/StatusBadge';
import { IconButton, Tooltip } from '../components/ui/Button';
import { Popover, MenuList, FixedMenu, type MenuItem } from '../components/ui/Dropdown';
import { SearchInput, Input, Label } from '../components/ui/Input';
import { Modal } from '../components/ui/Modal';
import { Button } from '../components/ui/Button';
import { PFDialog } from '../components/dialogs/PFDialog';
import { ScaleDialog, ConfirmDialog, RestartDialog } from '../components/dialogs/ActionDialogs';
import { toast } from '../state/notifications_store';
import type { ResourceItem, ResourceKind } from '../types/k8s';
import { RequestErrorNotice } from '../components/k8s/RequestErrorNotice';
import { uiFactor, uiPixels } from '../core/appearance';
import { resourceTabId } from '../core/resources/identity';
import { resourceIssues } from '../core/resources/diagnostics';
import { compareCreation, issuePriority } from '../core/resources/resource_sort';
import { refreshResourceWatches } from '../state/resource_watch';
import { cx } from '../core/utils/cx';

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
  name: 240, namespace: 130, ready: 66, restarts: 84, status: 132, ip: 112, node: 96, age: 64,
  ports: 132, type: 112, clusterIP: 120, image: 220, keys: 74, volume: 132, claim: 168,
  storageclass: 132, reclaim: 92, roles: 152, version: 98, cpu: 112, mem: 172, pods: 130, replicas: 125,
  provisioner: 184, hosts: 220, class: 100, capacity: 90, group: 110,
};

const MIN_COL = 56;
const MAX_COL = 520;

const BASE_COLUMNS: ColumnDef[] = [
  { id: 'name', label: 'Name', mono: true, get: (i) => i.name },
  { id: 'namespace', label: 'Namespace', get: (i) => i.namespace },
];

const columnsFor = (kind: ResourceKind): ColumnDef[] => {
  switch (kind) {
    case 'Pod':
      return [
        ...BASE_COLUMNS,
        { id: 'ready', label: 'Ready', align: 'right', mono: true, get: (i) => i.ready },
        { id: 'restarts', label: 'Restarts', align: 'right', mono: true, get: (i) => (i.restarts === undefined ? undefined : String(i.restarts)) },
        { id: 'status', label: 'Status', get: (i) => i.status },
        { id: 'ip', label: 'IP', mono: true, get: (i) => i.ip },
        { id: 'node', label: 'Node', mono: true, get: (i) => i.node },
        { id: 'age', label: 'Age', align: 'right', get: (i) => i.age },
      ];
    case 'Deployment':
    case 'StatefulSet':
    case 'DaemonSet':
      return [
        ...BASE_COLUMNS,
        { id: 'pods', label: 'Pods (Ready)', get: (i) => i.ready },
        { id: 'replicas', label: 'Replicas', align: 'right', mono: true, get: (i) => String(i.replicas ?? i.ready?.split('/')[1] ?? 1) },
        { id: 'status', label: 'Conditions', get: (i) => i.status },
        { id: 'image', label: 'Image', mono: true, get: (i) => i.image ?? undefined },
        { id: 'age', label: 'Age', align: 'right', get: (i) => i.age },
      ];
    case 'Job':
      return [
        ...BASE_COLUMNS,
        { id: 'ready', label: 'Completions', align: 'right', mono: true, get: (i) => i.ready },
        { id: 'status', label: 'Status', get: (i) => i.status },
        { id: 'image', label: 'Image', mono: true, get: (i) => i.image ?? undefined },
        { id: 'age', label: 'Age', align: 'right', get: (i) => i.age },
      ];
    case 'CronJob':
      return [
        ...BASE_COLUMNS,
        { id: 'ready', label: 'Schedule', mono: true, get: (i) => i.ready },
        { id: 'status', label: 'Status', get: (i) => i.status },
        { id: 'age', label: 'Age', align: 'right', get: (i) => i.age },
      ];
    case 'Service':
      return [
        ...BASE_COLUMNS,
        { id: 'status', label: 'Type', get: (i) => i.serviceType },
        { id: 'clusterIP', label: 'Cluster IP', mono: true, get: (i) => i.clusterIP },
        { id: 'ports', label: 'Ports', mono: true, get: (i) => i.ready },
        { id: 'age', label: 'Age', align: 'right', get: (i) => i.age },
      ];
    case 'Ingress':
      return [
        ...BASE_COLUMNS,
        { id: 'hosts', label: 'Hosts', get: (i) => i.ingressHosts },
        { id: 'class', label: 'Class', get: (i) => i.ingressClass },
        { id: 'age', label: 'Age', align: 'right', get: (i) => i.age },
      ];
    case 'ConfigMap':
      return [
        ...BASE_COLUMNS,
        { id: 'keys', label: 'Data keys', align: 'right', mono: true, get: (i) => (i.dataKeys === undefined ? undefined : String(i.dataKeys)) },
        { id: 'age', label: 'Age', align: 'right', get: (i) => i.age },
      ];
    case 'Secret':
      return [
        ...BASE_COLUMNS,
        { id: 'type', label: 'Type', get: (i) => i.secretType },
        { id: 'keys', label: 'Data keys', align: 'right', mono: true, get: (i) => (i.dataKeys === undefined ? undefined : String(i.dataKeys)) },
        { id: 'age', label: 'Age', align: 'right', get: (i) => i.age },
      ];
    case 'PersistentVolumeClaim':
      return [
        ...BASE_COLUMNS,
        { id: 'status', label: 'Status', get: (i) => i.status },
        { id: 'capacity', label: 'Capacity', align: 'right', mono: true, get: (i) => i.ready },
        { id: 'volume', label: 'Volume', mono: true, get: (i) => i.volume },
        { id: 'storageclass', label: 'Storage class', get: (i) => i.storageClass },
        { id: 'age', label: 'Age', align: 'right', get: (i) => i.age },
      ];
    case 'PersistentVolume':
      return [
        ...BASE_COLUMNS.slice(0, 1),
        { id: 'status', label: 'Status', get: (i) => i.status },
        { id: 'claim', label: 'Claim', mono: true, get: (i) => i.volume },
        { id: 'capacity', label: 'Capacity', align: 'right', mono: true, get: () => undefined },
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
        { id: 'cpu', label: 'CPU cores', get: (i) => i.nodeCpu },
        { id: 'mem', label: 'Memory (used / total)', get: (i) => i.nodeMem },
        { id: 'pods', label: 'Pods', get: (i) => i.nodePods },
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
        ...BASE_COLUMNS.slice(0, 1),
        { id: 'status', label: 'Status', get: (i) => i.status },
        { id: 'group', label: 'Scope', get: () => undefined },
        { id: 'age', label: 'Age', align: 'right', get: (i) => i.age },
      ];
    default:
      return [...BASE_COLUMNS, { id: 'status', label: 'Status', get: (i) => i.status }, { id: 'age', label: 'Age', align: 'right', get: (i) => i.age }];
  }
};

const apiVersionFor = (kind: ResourceKind): string => {
  if (['Job', 'CronJob'].includes(kind)) return 'batch/v1';
  if (['Deployment', 'ReplicaSet', 'StatefulSet', 'DaemonSet'].includes(kind)) return 'apps/v1';
  if (kind === 'Ingress') return 'networking.k8s.io/v1';
  if (kind === 'StorageClass') return 'storage.k8s.io/v1';
  if (kind === 'CustomResourceDefinition') return 'apiextensions.k8s.io/v1';
  return 'v1';
};

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
}

export const ResourceView: React.FC<ResourceViewProps> = ({ explicitKind }) => {
  const {
    resources, activeKind, setActiveKind, setSearchQuery, searchQuery, selectItem, selectedItem,
    updateItem, deleteItem, applyDelta,
  } = useResourceStore();
  const { selectedNamespace, selectNamespace, isConnected, isLoading } = useClusterStore();
  const {
    density, uiScale, hiddenColumns, setHiddenColumns, columnWidths, setColumnWidth, resetColumnWidths,
    setRightTab, activePerspective, inspectorCollapsed, toggleInspector,
  } = useUiStore();
  const { openYamlEditor, openResourceDetail, openLogsTab, toggleSplit } = useWorkspaceStore();

  const effectiveKind = explicitKind || activeKind;
  const tableRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const [compactFilters, setCompactFilters] = useState(true);
  const currentContext = useClusterStore((s) => s.currentContext);
  const watchState = useResourceStore((s) => s.watchStates[effectiveKind]);
  const loadError = useResourceStore((s) => s.loadErrors[effectiveKind]);

  const [sortId, setSortId] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<1 | -1>(1);
  const [healthFilter, setHealthFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('');
  const [menu, setMenu] = useState<{ item: ResourceItem; x: number; y: number } | null>(null);
  const [headerMenu, setHeaderMenu] = useState<{ colId: string; x: number; y: number } | null>(null);
  const [pfFor, setPfFor] = useState<ResourceItem | null>(null);
  const [scaleFor, setScaleFor] = useState<ResourceItem | null>(null);
  const [restartFor, setRestartFor] = useState<ResourceItem | null>(null);
  const [confirmFor, setConfirmFor] = useState<ResourceItem | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [spinning, setSpinning] = useState(false);

  /* JetBrains DataGrip Multi-selection and Keyboard state */
  const [selectedUids, setSelectedUids] = useState<Set<string>>(new Set());
  const [focusedIndex, setFocusedIndex] = useState<number>(0);
  const [lastSelectedIndex, setLastSelectedIndex] = useState<number | null>(null);

  const perspective = kindsFor(activePerspective);
  const noKinds = perspective.length === 0;
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
    setSelectedUids(new Set());
    setFocusedIndex(0);

  }, [effectiveKind, currentContext, setSearchQuery]);

  const kindResources = resources[effectiveKind];
  const allItems = useMemo(() => Array.from(kindResources?.values() ?? []), [kindResources]);
  const statuses = useMemo(() => [...new Set(allItems.map((item) => item.status).filter((status): status is string => Boolean(status)))].sort(), [allItems]);
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
    if (selectedNamespace !== 'all') list = list.filter((i) => !i.namespace || i.namespace === selectedNamespace);
    const q = searchQuery.trim().toLowerCase();
    if (q) list = list.filter((i) => (i.name + ' ' + (i.namespace ?? '') + ' ' + (i.status ?? '')).toLowerCase().includes(q));
    if (healthFilter === 'issues') list = list.filter((item) => (issueRanks.get(item.uid) ?? 0) > 0);
    if (statusFilter) list = list.filter((item) => item.status === statusFilter);

    const hidden = new Set(hiddenColumns[effectiveKind] ?? []);
    const cols = columnsFor(effectiveKind).filter((c) => !hidden.has(c.id));
    if (sortId === '__issues') {
      list = [...list].sort((a, b) => (issueRanks.get(b.uid) ?? 0) - (issueRanks.get(a.uid) ?? 0) || a.name.localeCompare(b.name) || a.uid.localeCompare(b.uid));
    } else if (sortId === '__created' || sortId === 'age') {
      list = [...list].sort((a, b) => compareCreation(a, b, sortId === 'age' ? sortDir === 1 ? -1 : 1 : sortDir));
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
          return cmp * sortDir;
        });
      }
    }
    return { list, cols };
  }, [allItems, selectedNamespace, searchQuery, effectiveKind, sortId, sortDir, hiddenColumns, healthFilter, statusFilter, issueRanks]);
  useEffect(() => { setFocusedIndex(0); setLastSelectedIndex(null); }, [selectedNamespace, searchQuery, healthFilter, statusFilter, sortId, sortDir]);
  const order = sortId === '__issues' ? 'issues' : sortId === '__created' ? sortDir === -1 ? 'newest' : 'oldest' : sortId === 'name' ? sortDir === 1 ? 'name-asc' : 'name-desc' : sortId ? 'column' : 'default';

  /* ------------------- Keyboard Navigation ------------------- */
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!tableRef.current?.contains(e.target as Node)) return;
      if ((e.target as HTMLElement).closest('[role="dialog"], [role="menu"], [contenteditable="true"]')) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (rows.list.length === 0) return;

      if (e.key === 'ArrowDown') {
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
  const widthFor = (colId: string): number =>
    columnWidths[`${effectiveKind}:${colId}`] ?? DEFAULT_COL_SIZE[colId] ?? 120;

  const startColResize = (e: React.PointerEvent, colId: string) => {
    e.preventDefault();
    e.stopPropagation();
    const startW = widthFor(colId);
    const startX = e.clientX;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const w = Math.min(MAX_COL, Math.max(MIN_COL, startW + (ev.clientX - startX) / uiFactor(useUiStore.getState().uiScale)));
      setColumnWidth(effectiveKind, colId, w);
    };
    const up = (ev: PointerEvent) => {
      el.releasePointerCapture(ev.pointerId);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  const buildHeaderMenu = (colId: string): MenuItem[] => {
    const col = columnsFor(effectiveKind).find((c) => c.id === colId);
    return [
      { id: 'asc', label: 'Sort ascending', icon: ArrowUp, kbd: sortId === colId && sortDir === 1 ? '✓' : undefined, onSelect: () => { setSortId(colId); setSortDir(1); } },
      { id: 'desc', label: 'Sort descending', icon: ArrowDown, kbd: sortId === colId && sortDir === -1 ? '✓' : undefined, onSelect: () => { setSortId(colId); setSortDir(-1); } },
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
      { id: 'reset-widths', label: 'Reset column widths', onSelect: () => { resetColumnWidths(effectiveKind); toast.info('Column widths reset', effectiveKind); } },
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
    setSpinning(true);
    try {
      if (await refreshResourceWatches(effectiveKind)) return;
      const items = await k8s.getResources(currentContext, effectiveKind, 'all');
      if (useClusterStore.getState().currentContext !== currentContext) return;
      useResourceStore.getState().setResourcesForKind(effectiveKind, items);
    } catch (error) {
      if (useClusterStore.getState().currentContext === currentContext) useResourceStore.getState().setLoadError(effectiveKind, error);
      toast.error('Refresh failed', String(error));
    } finally { setSpinning(false); }
  };

  const doDelete = (item: ResourceItem) => {
    if (!k8s.demo) { toast.error('Live delete is not connected yet'); return; }
    deleteItem(item.kind, item.uid);
    toast.warn('Deleted from demo memory', `${item.kind}/${item.name}`);
  };

  const doScale = async (item: ResourceItem, replicas: number) => {
    if (!currentContext || !['Deployment', 'StatefulSet'].includes(item.kind)) return;
    try {
      await k8s.scaleWorkload(currentContext, item.kind, item.name, item.namespace || 'default', replicas);
      if (useClusterStore.getState().currentContext !== currentContext) return;
      if (k8s.demo) updateItem(item.kind, item.uid, { replicas });
      else await refresh();
      toast.success(`Desired replicas updated to ${replicas}`, `${item.kind}/${item.name}`);
    } catch (error) { toast.error('Scale failed', String(error)); }
  };

  const doRestart = (item: ResourceItem) => {
    if (!k8s.demo) { toast.error('Live rollout restart is not connected yet'); return; }
    toast.info('Demo rollout restart requested', `${item.kind}/${item.name}`);
  };

  const buildRowMenu = (item: ResourceItem): MenuItem[] => {
    const items: MenuItem[] = [
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

    if (item.kind === 'Pod') {
      items.push(
        {
          id: 'dock-logs',
          label: 'Stream Logs in Bottom Drawer',
          icon: FileText,
          onSelect: () => useDockStore.getState().openLogs(item.name, item.namespace, item.containers?.[0]?.name, item.containers?.map((c) => c.name)),
        },
        {
          id: 'dock-terminal',
          label: 'Terminal in Bottom Drawer',
          icon: Terminal,
          onSelect: () => useDockStore.getState().openTerminal(item.name, item.namespace, item.containers?.[0]?.name, item.containers?.map((c) => c.name)),
        },
        { id: 'logs', label: 'Stream Logs in Full Tab', icon: ExternalLink, onSelect: () => openLogsTab(item) },
        { id: 'pf', label: 'Port-forward…', icon: ArrowRightLeft, onSelect: () => setPfFor(item) },
      );
    }
    if (item.kind === 'Node') {
      items.push({
        id: 'dock-node-shell',
        label: 'Node Shell in Bottom Drawer',
        icon: Terminal,
        onSelect: () => useDockStore.getState().openNodeShell(item.name),
      });
    }
    if (['Deployment', 'StatefulSet'].includes(item.kind)) {
      items.push({ id: 'scale', label: 'Scale replicas…', icon: Maximize2, onSelect: () => setScaleFor(item) });
    }
    if (['Deployment', 'StatefulSet', 'DaemonSet'].includes(item.kind)) {
      items.push({ id: 'restart', label: 'Restart rollout (demo)', icon: RotateCw, disabled: !k8s.demo, onSelect: () => setRestartFor(item) });
    }
    if (item.kind === 'Service') {
      items.push({ id: 'pf', label: 'Port-forward…', icon: ArrowRightLeft, onSelect: () => setPfFor(item) });
    }
    if (item.kind === 'Job') {
      items.push({ id: 'rerun', label: 'Rerun job (demo)', disabled: !k8s.demo, icon: RefreshCw, onSelect: () => toast.success('Job re-run queued (demo)', item.name) });
    }

    items.push(
      { id: 'sep1', label: '', separator: true, onSelect: () => {} },
      { id: 'copyName', label: 'Copy name', icon: Copy, onSelect: () => { navigator.clipboard.writeText(item.name).then(() => toast.success('Name copied')).catch(() => toast.error('Clipboard unavailable')); } },
      { id: 'sep2', label: '', separator: true, onSelect: () => {} },
      { id: 'delete', label: 'Delete (demo)…', disabled: !k8s.demo, icon: Trash2, danger: true, kbd: '⌫', onSelect: () => setConfirmFor(item) },
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
            This perspective is a stub in the current milestone — Helm releases arrive in phase UI-8.
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
            {order === 'column' && <option value="column">Sort: {columnsFor(effectiveKind).find((column) => column.id === sortId)?.label}</option>}
          </select></label>
          {compactFilters && <Button size="sm" onClick={() => { setHealthFilter('all'); setStatusFilter(''); setSortId(null); }}>Reset filters and order</Button>}
        </div>
  );

  return (
    <div ref={paneRef} className="flex-1 flex flex-col min-h-0 min-w-0 relative bg-[var(--bg-canvas)]">
      {/* JetBrains DataGrip-Grade Toolbar */}
      <div className="h-9 shrink-0 flex items-center gap-2 px-3 border-b border-[var(--border-default)] bg-[var(--bg-canvas)]">
        <KindIcon size="calc(15px * var(--ui-factor))" strokeWidth={1.75} className="text-blue-400 shrink-0" />
        <span className="text-[length:calc(13px*var(--ui-factor))] font-semibold text-[var(--text-primary)]">{effectiveKind}s</span>
        <span className="text-[length:calc(11px*var(--ui-factor))] font-mono text-[var(--text-muted)] px-1.5 py-[1px] rounded-full bg-[var(--bg-surface)]/70">
          {rows.list.length}{rows.list.length !== allItems.length && <span className="opacity-70"> of {allItems.length}</span>}
        </span>

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
                Columns · {effectiveKind}
              </div>
              <MenuList
                items={columnsFor(effectiveKind).map((c) => ({
                  id: c.id,
                  label: c.label,
                  checked: !hiddenForKind.has(c.id),
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
                onSelect={() => {}}
              />
              <div className="my-1 h-px bg-[var(--border-subtle)]" />
              <MenuList
                items={[
                  { id: 'reset', label: 'Reset visibility', onSelect: () => setHiddenColumns(effectiveKind, []) },
                  { id: 'reset-widths', label: 'Reset column widths', onSelect: () => resetColumnWidths(effectiveKind) },
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

        <Button variant="primary" size="sm" disabled={!k8s.demo} title={k8s.demo ? "Create demo resource" : "Live creation is not connected yet"} onClick={() => setNewOpen(true)}>
          <Plus size="calc(13px * var(--ui-factor))" />
          New
        </Button>
      </div>

      <div className="resource-search-row border-b border-[var(--border-default)]" data-testid="resource-search-toolbar">
        <SearchInput value={searchQuery} onChange={setSearchQuery} placeholder={`Filter ${effectiveKind.toLowerCase()}s…`} className="resource-search-field" />
        {compactFilters ? <Popover align="end" width={280} trigger={({ open }) => <button aria-label="Resource filters and sorting" aria-expanded={open} className={cx('resource-filter-trigger', open && 'border-[var(--accent)]')}>
          <SlidersHorizontal size="calc(13px * var(--ui-factor))" /><span>Filters</span>{activeFilters > 0 && <span className="text-[var(--accent)]">{activeFilters}</span>}
        </button>}>{() => <div role="group" aria-label="Resource filter options" className="p-3">{filterControls}</div>}</Popover> : filterControls}
      </div>

      {/* JetBrains DataGrip Data Table */}
      <div ref={tableRef} tabIndex={0} aria-label={`${effectiveKind} resource table`} className="flex-1 overflow-auto kubiki-scrollbar min-h-0 select-text" data-testid="resource-table">
        {loadError && <RequestErrorNotice error={loadError} onRetry={() => void refresh()} retainedData={allItems.length > 0 || watchState?.hasSnapshot === true} />}
        {watchState && !loadError && watchState.phase !== 'live' && <div role="status" className="px-3 py-2 text-xs text-[var(--text-secondary)]">{watchState.phase === 'reconnecting' ? 'Reconnecting' : 'Synchronizing'}…{watchState.hasSnapshot ? ' Showing the last complete snapshot.' : ' Waiting for the first complete snapshot.'}</div>}
        {rows.list.length === 0 ? !loadError && (!watchState || watchState.hasSnapshot) && (
          <EmptyState
            kind={effectiveKind}
            filtered={(selectedNamespace !== 'all' && allItems.length > 0) || !!searchQuery || healthFilter !== 'all' || !!statusFilter}
            onClear={() => { selectNamespace('all'); setSearchQuery(''); setHealthFilter('all'); setStatusFilter(''); }}
            isNew={k8s.demo && allItems.length === 0 && !loadError}
            onNew={() => setNewOpen(true)}
          />
        ) : (
          <table className="datagrip-grid w-full table-fixed" onClick={() => tableRef.current?.focus({ preventScroll: true })}>
            <thead>
              <tr>
                {/* Index & Selection Column */}
                <th className="datagrip-th w-[calc(38px*var(--ui-factor))] text-center p-0">
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
                </th>

                {rows.cols.map((c) => {
                  const active = sortId === c.id;
                  return (
                    <th
                      key={c.id}
                      style={{ width: uiPixels(widthFor(c.id)) }}
                      onClick={() => {
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
                        {active && (sortDir === 1 ? <ArrowUp size="calc(10px * var(--ui-factor))" className="text-[var(--accent)]" /> : <ArrowDown size="calc(10px * var(--ui-factor))" className="text-[var(--accent)]" />)}
                      </span>
                      {/* Drag handle for resizing column */}
                      <span
                        title="Drag to resize · double-click to reset"
                        onPointerDown={(e) => startColResize(e, c.id)}
                        onDoubleClick={(e) => {
                          e.stopPropagation();
                          setColumnWidth(effectiveKind, c.id, DEFAULT_COL_SIZE[c.id] ?? 120);
                        }}
                        onClick={(e) => e.stopPropagation()}
                        className="absolute right-0 top-0 h-full w-[calc(6px*var(--ui-factor))] cursor-col-resize hover:bg-[var(--accent)]/50 active:bg-[var(--accent)] transition-colors"
                      />
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {rows.list.map((item, idx) => {
                const isSelected = selectedUids.has(item.uid);
                const isFocused = idx === focusedIndex;
                const isRowActive = selectedItem?.uid === item.uid;

                return (
                  <tr
                    key={item.uid}
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
                    onDoubleClick={() => openYamlTab(item)}
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
      <ConfirmDialog
        open={!!confirmFor}
        title={`Delete ${confirmFor?.kind.toLowerCase() ?? ''}`}
        confirmLabel="Delete"
        onClose={() => setConfirmFor(null)}
        onConfirm={() => confirmFor && doDelete(confirmFor)}
        message={
          <>
            Delete <span className="font-mono text-[var(--text-primary)]">{confirmFor?.name}</span> from namespace{' '}
            <span className="font-mono">{confirmFor?.namespace ?? '-'}</span>? This cannot be undone.
          </>
        }
      />
      <NewResourceDialog
        open={newOpen}
        kind={effectiveKind}
        defaultNs={selectedNamespace === 'all' ? 'default' : selectedNamespace}
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

  if (col.id === 'name') return <span className="inline-flex items-center gap-2 max-w-full align-middle"><ResourceWarnings item={item} /><span className="truncate text-[var(--text-primary)] font-mono text-[length:calc(11.5px*var(--ui-factor))] font-medium" title={v}>{v}</span></span>;
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
