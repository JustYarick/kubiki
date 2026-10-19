import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowDown,
  ArrowRightLeft,
  ArrowUp,
  Boxes,
  Braces,
  ChevronDown,
  Copy,
  FileText,
  Layers,
  Maximize2,
  Minimize2,
  MoreVertical,
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
import type { LucideIcon } from 'lucide-react';
import { useResourceStore } from '../state/resource_store';
import { useClusterStore } from '../state/cluster_store';
import { useUiStore } from '../state/ui_store';
import { useWorkspaceStore } from '../state/workspace_store';
import { useDockStore } from '../state/dock_store';
import { KIND_ICONS, defaultKindFor, kindsFor } from '../core/perspectives';
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
        { id: 'replicas', label: 'Scaling', align: 'right', mono: true, get: (i) => String(i.replicas ?? i.ready?.split('/')[1] ?? 1) },
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
  if (['Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob'].includes(kind)) return 'apps/v1';
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
  const { selectedNamespace, selectNamespace, availableNamespaces } = useClusterStore();
  const {
    density, hiddenColumns, setHiddenColumns, columnWidths, setColumnWidth, resetColumnWidths,
    setRightTab, activePerspective, inspectorCollapsed, toggleInspector,
  } = useUiStore();
  const { openYamlEditor, openResourceDetail, openLogsTab, toggleSplit } = useWorkspaceStore();

  const effectiveKind = explicitKind || activeKind;

  const [sortId, setSortId] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<1 | -1>(1);
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
    setSelectedUids(new Set());
    setFocusedIndex(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveKind]);

  const allItems = useMemo(() => Array.from(resources[effectiveKind]?.values() ?? []), [resources, effectiveKind]);

  const rows = useMemo(() => {
    let list = allItems;
    if (selectedNamespace !== 'all') list = list.filter((i) => !i.namespace || i.namespace === selectedNamespace);
    const q = searchQuery.trim().toLowerCase();
    if (q) list = list.filter((i) => (i.name + ' ' + (i.namespace ?? '') + ' ' + (i.status ?? '')).toLowerCase().includes(q));

    const hidden = new Set(hiddenColumns[effectiveKind] ?? []);
    const cols = columnsFor(effectiveKind).filter((c) => !hidden.has(c.id));
    if (sortId) {
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
  }, [allItems, selectedNamespace, searchQuery, effectiveKind, sortId, sortDir, hiddenColumns]);

  const isClusterScoped = effectiveKind === 'Node' || effectiveKind === 'Namespace' || effectiveKind === 'PersistentVolume' || effectiveKind === 'StorageClass' || effectiveKind === 'CustomResourceDefinition';

  /* ------------------- Keyboard Navigation ------------------- */
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
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
      } else if (e.key.toLowerCase() === 'l' && effectiveKind === 'Pod') {
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
      const w = Math.min(MAX_COL, Math.max(MIN_COL, startW + ev.clientX - startX));
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

  const refresh = () => {
    setSpinning(true);
    setTimeout(() => setSpinning(false), 550);
    toast.info('List refreshed', `${effectiveKind}: ${allItems.length} items (mock)`);
  };

  const doDelete = (item: ResourceItem) => {
    deleteItem(item.kind, item.uid);
    toast.warn('Deleted (demo)', `${item.kind}/${item.name}`);
  };

  const doScale = (item: ResourceItem, replicas: number) => {
    updateItem(item.kind, item.uid, { replicas, ready: `${replicas}/${replicas}` });
    toast.success(`Scaled to ${replicas}`, `${item.kind}/${item.name}`);
  };

  const doRestart = (item: ResourceItem) => {
    const n = Number(item.ready?.split('/')[1] ?? item.replicas ?? 1);
    updateItem(item.kind, item.uid, { status: 'Running', ready: `${n}/${n}` });
    toast.success('Rollout restarted (demo)', `${item.kind}/${item.name}`);
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
          toggleSplit(`yaml-${item.kind}-${item.name}`);
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
    if (['Deployment', 'StatefulSet', 'DaemonSet'].includes(item.kind)) {
      items.push(
        {
          id: 'dock-logs',
          label: 'View Logs in Bottom Drawer',
          icon: FileText,
          onSelect: () => useDockStore.getState().openLogs(item.name, item.namespace),
        },
        { id: 'scale', label: 'Scale Replicas…', icon: Maximize2, onSelect: () => setScaleFor(item) },
        { id: 'restart', label: 'Restart Rollout', icon: RotateCw, onSelect: () => setRestartFor(item) },
      );
    }
    if (['Service', 'Ingress'].includes(item.kind)) {
      items.push({ id: 'pf', label: 'Port-forward…', icon: ArrowRightLeft, onSelect: () => setPfFor(item) });
    }
    if (item.kind === 'Job') {
      items.push({ id: 'rerun', label: 'Rerun job', icon: RefreshCw, onSelect: () => toast.success('Job re-run queued (demo)', item.name) });
    }

    items.push(
      { id: 'sep1', label: '', separator: true, onSelect: () => {} },
      { id: 'copyName', label: 'Copy name', icon: Copy, onSelect: () => { navigator.clipboard.writeText(item.name).then(() => toast.success('Name copied')); } },
      { id: 'sep2', label: '', separator: true, onSelect: () => {} },
      { id: 'delete', label: 'Delete…', icon: Trash2, danger: true, kbd: '⌫', onSelect: () => setConfirmFor(item) },
    );
    return items;
  };

  const quickActionsFor = (item: ResourceItem): Array<{ icon: LucideIcon; label: string; onClick: (e: React.MouseEvent) => void; danger?: boolean }> => {
    const list: Array<{ icon: LucideIcon; label: string; onClick: (e: React.MouseEvent) => void; danger?: boolean }> = [];
    if (item.kind === 'Pod') {
      list.push(
        {
          icon: FileText,
          label: 'Logs',
          onClick: () => useDockStore.getState().openLogs(item.name, item.namespace, item.containers?.[0]?.name, item.containers?.map((c) => c.name)),
        },
        {
          icon: Terminal,
          label: 'Terminal',
          onClick: () => useDockStore.getState().openTerminal(item.name, item.namespace, item.containers?.[0]?.name, item.containers?.map((c) => c.name)),
        },
      );
    }
    if (['Deployment', 'StatefulSet', 'DaemonSet'].includes(item.kind)) {
      list.push(
        {
          icon: FileText,
          label: 'Logs',
          onClick: () => useDockStore.getState().openLogs(item.name, item.namespace),
        },
        {
          icon: Maximize2,
          label: 'Scale…',
          onClick: () => setScaleFor(item),
        },
      );
    }
    if (['Pod', 'Service', 'Ingress'].includes(item.kind)) {
      list.push({ icon: ArrowRightLeft, label: 'Port-forward', onClick: () => setPfFor(item) });
    }
    list.push({ icon: Braces, label: 'Edit YAML', onClick: () => openYamlTab(item) });
    list.push({ icon: MoreIcon, label: 'More actions', onClick: () => setMenu({ item, x: 0, y: 0 }) });
    return list;
  };

  /* --------------------------- Render --------------------------- */
  if (noKinds) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center max-w-sm">
          <Boxes size={40} strokeWidth={1.2} className="mx-auto text-[var(--text-muted)] mb-3" />
          <div className="text-sm font-medium text-[var(--text-primary)]">Nothing here yet</div>
          <p className="text-xs text-[var(--text-secondary)] mt-1 leading-relaxed">
            This perspective is a stub in the current milestone — Helm releases arrive in phase UI-8.
          </p>
        </div>
      </div>
    );
  }

  const KindIcon = KIND_ICONS[effectiveKind] || Boxes;
  const rowH = density === 'compact' ? 'h-[25px]' : 'h-[30px]';
  const hiddenForKind = new Set(hiddenColumns[effectiveKind] ?? []);

  return (
    <div className="flex-1 flex flex-col min-h-0 min-w-0 relative bg-[var(--bg-canvas)]">
      {/* JetBrains DataGrip-Grade Toolbar */}
      <div className="h-9 shrink-0 flex items-center gap-2 px-3 border-b border-[var(--border-default)] bg-[var(--bg-canvas)]">
        <KindIcon size={15} strokeWidth={1.75} className="text-blue-400 shrink-0" />
        <span className="text-[13px] font-semibold text-[var(--text-primary)]">{effectiveKind}s</span>
        <span className="text-[11px] font-mono text-[var(--text-muted)] px-1.5 py-[1px] rounded-full bg-[var(--bg-surface)]/70">
          {rows.list.length}{selectedNamespace !== 'all' && <span className="opacity-70"> of {allItems.length}</span>}
        </span>

        {selectedUids.size > 0 && (
          <span className="text-[11px] font-mono text-[var(--accent)] px-2 py-[1px] rounded bg-[var(--accent-subtle)] font-medium">
            {selectedUids.size} selected
          </span>
        )}

        <div className="flex-1" />

        <SearchInput
          value={searchQuery}
          onChange={setSearchQuery}
          placeholder={`Filter ${effectiveKind.toLowerCase()}s…`}
          className="w-[200px]"
        />

        {/* Namespace quick filter */}
        {!isClusterScoped && (
          <Popover
            width={200}
            trigger={({ open }) => (
              <button
                className={cx(
                  'flex items-center gap-1 h-[25px] px-2 rounded-[4px] border text-[11px] font-mono transition-colors max-w-[150px]',
                  open ? 'border-[var(--accent)] text-[var(--text-primary)]' : 'border-[var(--border-default)] text-[var(--text-secondary)] hover:border-[var(--border-strong)]'
                )}
                title="Namespace filter"
              >
                <Layers size={11} className="text-violet-400 shrink-0" />
                <span className="truncate">{selectedNamespace === 'all' ? 'all-namespaces' : selectedNamespace}</span>
                <ChevronDown size={11} className="opacity-60" />
              </button>
            )}
          >
            {(close) => (
              <MenuList
                items={[
                  { id: 'all', label: 'All Namespaces', checked: selectedNamespace === 'all', onSelect: () => selectNamespace('all') },
                  ...availableNamespaces.map((ns) => ({
                    id: ns,
                    label: ns,
                    checked: selectedNamespace === ns,
                    onSelect: () => selectNamespace(ns),
                  })),
                ]}
                onSelect={(item) => { item.onSelect?.(); close(); }}
              />
            )}
          </Popover>
        )}

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
              <div className="px-2.5 pt-1 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--text-muted)]">
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
              <div className="px-2.5 pb-1 pt-1.5 text-[10px] text-[var(--text-muted)] leading-relaxed">
                Drag column borders to resize · right-click headers to sort or hide
              </div>
            </>
          )}
        </Popover>

        <Tooltip label="Refresh list" delay={400}>
          <IconButton icon={RefreshCw} size="sm" onClick={refresh} className={cx(spinning && 'animate-[spin_0.7s_linear_infinite]')} aria-label="Refresh" />
        </Tooltip>

        <Button variant="primary" size="sm" onClick={() => setNewOpen(true)}>
          <Plus size={13} />
          New
        </Button>
      </div>

      {/* JetBrains DataGrip Data Table */}
      <div className="flex-1 overflow-auto kubiki-scrollbar min-h-0 select-text" data-testid="resource-table">
        {rows.list.length === 0 ? (
          <EmptyState
            kind={effectiveKind}
            filtered={(selectedNamespace !== 'all' && allItems.length > 0) || !!searchQuery}
            onClear={() => { selectNamespace('all'); setSearchQuery(''); }}
            isNew={allItems.length === 0}
            onNew={() => setNewOpen(true)}
          />
        ) : (
          <table className="datagrip-grid w-full table-fixed">
            <thead>
              <tr>
                {/* Index & Selection Column */}
                <th className="datagrip-th w-[38px] text-center p-0">
                  <div
                    onClick={toggleSelectAll}
                    className="w-full h-full flex items-center justify-center cursor-pointer text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                    title={selectedUids.size === rows.list.length ? 'Deselect all' : 'Select all'}
                  >
                    {selectedUids.size === 0 ? (
                      <Square size={12} />
                    ) : selectedUids.size === rows.list.length ? (
                      <CheckSquare size={12} className="text-[var(--accent)]" />
                    ) : (
                      <MinusSquare size={12} className="text-[var(--accent)]" />
                    )}
                  </div>
                </th>

                {rows.cols.map((c) => {
                  const active = sortId === c.id;
                  return (
                    <th
                      key={c.id}
                      style={{ width: widthFor(c.id) }}
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
                        {active && (sortDir === 1 ? <ArrowUp size={10} className="text-[var(--accent)]" /> : <ArrowDown size={10} className="text-[var(--accent)]" />)}
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
                        className="absolute right-0 top-0 h-full w-[6px] cursor-col-resize hover:bg-[var(--accent)]/50 active:bg-[var(--accent)] transition-colors"
                      />
                    </th>
                  );
                })}
                <th className="datagrip-th w-[120px] p-0" />
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
                    {/* Checkbox & Row number */}
                    <td className="datagrip-cell text-center p-0 text-[10px] font-mono text-[var(--text-muted)] select-none">
                      <div
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleSelectRow(item.uid, e.shiftKey, idx);
                        }}
                        className="w-full h-full flex items-center justify-center cursor-pointer"
                      >
                        {isSelected ? (
                          <CheckSquare size={12} className="text-[var(--accent)]" />
                        ) : (
                          <span className="group-hover/row:hidden">{idx + 1}</span>
                        )}
                        {!isSelected && (
                          <Square size={12} className="hidden group-hover/row:inline-block opacity-60" />
                        )}
                      </div>
                    </td>

                    {rows.cols.map((c) => (
                      <td
                        key={c.id}
                        className={cx(
                          'datagrip-cell px-2.5',
                          c.align === 'right' && 'text-right',
                          c.mono && 'font-mono text-[11px]'
                        )}
                      >
                        <CellValue col={c} item={item} onScale={(rep) => doScale(item, rep)} />
                      </td>
                    ))}

                    {/* Quick Row Actions on hover */}
                    <td className="datagrip-cell relative p-0">
                      <div className="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center gap-0.5 opacity-0 group-hover/row:opacity-100 transition-opacity bg-[var(--bg-secondary)]/90 px-1 py-0.5 rounded border border-[var(--border-subtle)] shadow-2xs">
                        {quickActionsFor(item).map((a, aIdx) => (
                          <button
                            key={aIdx}
                            title={a.label}
                            type="button"
                            className="p-[3px] rounded-[3px] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] cursor-pointer"
                            onClick={(e) => {
                              e.stopPropagation();
                              a.onClick(e);
                            }}
                          >
                            <a.icon size={13} strokeWidth={1.75} />
                          </button>
                        ))}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* JetBrains Floating Batch Action Bar */}
      {selectedUids.size > 0 && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-30 flex items-center gap-2 px-3.5 py-1.5 rounded-[6px] bg-[var(--bg-surface)] border border-[var(--border-strong)] shadow-dialog text-xs select-none kub-pop">
          <span className="font-semibold text-[var(--text-primary)]">
            {selectedUids.size} {selectedUids.size === 1 ? effectiveKind : `${effectiveKind}s`} selected
          </span>
          <div className="h-4 w-px bg-[var(--border-default)] mx-1" />
          {['Deployment', 'StatefulSet', 'DaemonSet'].includes(effectiveKind) && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                selectedUids.forEach((uid) => {
                  const item = rows.list.find((r) => r.uid === uid);
                  if (item) doRestart(item);
                });
                toast.success(`Rollout restart triggered for ${selectedUids.size} workloads`);
              }}
            >
              <RotateCw size={11} /> Restart Rollout
            </Button>
          )}
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              const names = rows.list.filter((r) => selectedUids.has(r.uid)).map((r) => r.name).join('\n');
              navigator.clipboard.writeText(names);
              toast.success(`Copied ${selectedUids.size} names`);
            }}
          >
            <Copy size={11} /> Copy Names
          </Button>
          <Button
            size="sm"
            variant="danger"
            onClick={() => {
              selectedUids.forEach((uid) => {
                deleteItem(effectiveKind, uid);
              });
              toast.warn(`Deleted ${selectedUids.size} resources`);
              setSelectedUids(new Set());
            }}
          >
            <Trash2 size={11} /> Delete ({selectedUids.size})
          </Button>
          <Button size="sm" onClick={() => setSelectedUids(new Set())}>
            Deselect
          </Button>
        </div>
      )}

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
          const item: ResourceItem = {
            uid: `new-${Date.now().toString(36)}`,
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

const MoreIcon = MoreVertical;

function CellValue({
  col,
  item,
  onScale,
}: {
  col: ColumnDef;
  item: ResourceItem;
  onScale?: (replicas: number) => void;
}) {
  const v = col.get(item);
  if (v === undefined || v === '') return <span className="text-[var(--text-disabled)]">—</span>;

  if (col.id === 'name') return <span className="text-[var(--text-primary)] font-mono text-[11.5px] font-medium">{v}</span>;
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
              'font-mono text-[11px] font-semibold tabular-nums',
              isOk ? 'text-[var(--status-ok)]' : isZero ? 'text-[var(--status-danger)]' : 'text-[var(--status-warn)]'
            )}
          >
            {v}
          </span>
        </div>
      );
    }
    return <span className="font-mono text-[11px]">{v}</span>;
  }

  if (col.id === 'replicas') {
    const curReplicas = Number(v) || item.replicas || 1;
    return (
      <div className="inline-flex items-center gap-1 font-mono">
        <button
          onClick={(e) => {
            e.stopPropagation();
            onScale?.(Math.max(0, curReplicas - 1));
          }}
          className="w-4 h-4 rounded flex items-center justify-center bg-[var(--bg-surface)] hover:bg-[var(--bg-elevated)] text-[var(--text-muted)] hover:text-white transition-colors text-[10px]"
          title="Scale down by 1"
        >
          -
        </button>
        <span className="w-5 text-center font-bold text-[var(--text-primary)] tabular-nums">{curReplicas}</span>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onScale?.(curReplicas + 1);
          }}
          className="w-4 h-4 rounded flex items-center justify-center bg-[var(--bg-surface)] hover:bg-[var(--bg-elevated)] text-[var(--text-muted)] hover:text-white transition-colors text-[10px]"
          title="Scale up by 1"
        >
          +
        </button>
      </div>
    );
  }

  if (col.id === 'ready') {
    const m = /^(\d+)\/(\d+)$/.exec(v);
    const danger = m && m[1] !== m[2] && m[1] === '0';
    return <span className={cx('font-mono text-[11px]', danger ? 'text-[var(--status-danger)]' : m && m[1] === m[2] ? 'text-[var(--status-ok)]' : 'text-[var(--text-primary)]')}>{v}</span>;
  }
  if (col.id === 'restarts') {
    const n = Number(v);
    return <span className={cx('font-mono text-[11px]', n > 10 ? 'text-[var(--status-danger)]' : n > 0 ? 'text-[var(--status-warn)]' : 'text-[var(--text-secondary)]')}>{v}</span>;
  }
  if (col.id === 'age') return <span className="text-[var(--text-secondary)]">{v}</span>;
  return <span className="text-[var(--text-secondary)]">{v}</span>;
}

function EmptyState({ kind, filtered, onClear, isNew, onNew }: { kind: string; filtered: boolean; onClear: () => void; isNew: boolean; onNew: () => void }) {
  const Icon = KIND_ICONS[kind as ResourceKind] ?? Boxes;
  return (
    <div className="h-full min-h-[220px] flex items-center justify-center">
      <div className="text-center max-w-sm px-6">
        <Icon size={36} strokeWidth={1.2} className="mx-auto text-[var(--text-muted)] mb-3" />
        <div className="text-sm font-medium text-[var(--text-primary)]">
          {filtered ? `No ${kind.toLowerCase()}s match your filters` : `No ${kind.toLowerCase()}s found`}
        </div>
        <p className="text-xs text-[var(--text-secondary)] mt-1.5 leading-relaxed">
          {filtered ? 'Try a different namespace or clear the search query.' : 'The cluster reports zero objects of this kind.'}
        </p>
        <div className="flex items-center justify-center gap-2 mt-4">
          {filtered && (
            <Button size="sm" onClick={onClear}>
              <XCircle size={12} /> Clear filters
            </Button>
          )}
          {isNew && (
            <Button size="sm" variant="primary" onClick={onNew}>
              <Plus size={12} /> Create {kind}
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
            {!/^[a-z0-9][a-z0-9-]*$/.test(name) && <span className="text-[10px] text-[var(--status-danger)]">lowercase letters, digits and “-” only</span>}
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
            className="flex-1 min-h-[220px] resize-none bg-[var(--bg-canvas)] border border-[var(--border-default)] rounded-[6px] p-3 font-mono text-[11.5px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)] transition-colors kubiki-scrollbar"
          />
        </div>
        <p className="text-[11px] text-[var(--text-muted)]">
          Demo mode — manifest will be stored in local memory store.
        </p>
      </div>
    </Modal>
  );
}
