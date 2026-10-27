import { cycleColumnFilter, columnFilterCount, EMPTY_COLUMN_FILTER } from '../core/resources/column_filters';
import { useResourceActions } from '../components/k8s/useResourceActions';
import { useResourceColumns } from '../components/k8s/table/useResourceColumns';
import { useResourceTableModel } from '../components/k8s/table/useResourceTableModel';
import { useColumnLayout } from '../components/k8s/table/useColumnLayout';
import { CellValue } from '../components/k8s/table/CellValue';
import { NewResourceDialog } from '../components/dialogs/NewResourceDialog';
import { mapK8sResource } from '../core/utils/k8s_mapper';
import { useShallow } from 'zustand/react/shallow';
import { useTableView } from '../state/table_view_store';
import { resourceIcon } from '../core/resource_icons';
import { syncResourceSnapshot } from '../providers/snapshot_sync';
import { ResourceLoading } from '../components/ui/ResourceLoading';
import { useVirtualizer } from '@tanstack/react-virtual';
import { resourceType } from '../core/resources/resource_types';
import { customResourcePlacement, customResourceType, type CustomResourceType } from '../core/resources/custom_resource_types';
import { useCustomResources } from '../providers/use_custom_resources';
import { defaultNamespace } from '../core/resources/namespace_scope';
import React, { useEffect, useMemo, useState, useRef } from 'react';
import {
  ArrowDown,
  ArrowRightLeft,
  ArrowUp,
  Boxes,
  Braces,
  ChevronDown,
  Copy,
  FileText,
  Filter,
  Maximize2,
  Minimize2,
  Plus,
  RefreshCw,
  RotateCw,
  RotateCcw,
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
import { findWorkloadPods, preferredWorkloadPod } from '../core/resources/workload_pods';
import { gitOpsFamily } from '../core/resources/gitops';
import { useResourceStore } from '../state/resource_store';
import { useClusterStore } from '../state/cluster_store';
import { useUiStore } from '../state/ui_store';
import { useWorkspaceStore } from '../state/workspace_store';
import { useDockStore } from '../state/dock_store';
import { k8s } from '../providers/k8s_provider';
import { SIDEBAR_TREE, defaultKindFor, kindsFor } from '../core/perspectives';
import { ColumnFilterPopup } from '../components/k8s/ColumnFilterPopup';
import { IconButton, Tooltip } from '../components/ui/Button';
import { Popover, MenuList, FixedMenu, type MenuItem } from '../components/ui/Dropdown';
import { SearchInput } from '../components/ui/Input';
import { Button } from '../components/ui/Button';
import { PFDialog } from '../components/dialogs/PFDialog';
import { ScaleDialog } from '../components/dialogs/ActionDialogs';
import { toast } from '../state/notifications_store';
import type { ResourceItem, ResourceKind } from '../types/k8s';
import { RequestErrorNotice } from '../components/k8s/RequestErrorNotice';
import { uiFactor, uiPixels } from '../core/appearance';
import { resourceTabId } from '../core/resources/identity';
import { podContainers } from '../core/resources/containers';
import { refreshResourceWatches } from '../state/resource_watch';
import { cx } from '../core/utils/cx';

/* ------------------------------------------------------------------ */
/* Column model                                                        */
/* ------------------------------------------------------------------ */


/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

interface ResourceViewProps {
  viewId?: string;
  explicitKind?: ResourceKind;
  customType?: CustomResourceType;
}

const EMPTY_RESOURCE_MAP = new Map<string, ResourceItem>();

export const ResourceView: React.FC<ResourceViewProps> = ({ explicitKind, customType }) => {
  const activeKind = useResourceStore(s => s.activeKind);
  const effectiveKind = explicitKind || activeKind;
  const needsPods = effectiveKind === 'Pod' || effectiveKind === 'Node' || effectiveKind === 'Service';
  const needsStorageClass = effectiveKind === 'StorageClass' || effectiveKind === 'PersistentVolumeClaim';
  const resources = useResourceStore(useShallow(s => ({
    [effectiveKind]: s.resources[effectiveKind],
    Pod: needsPods ? s.resources.Pod : EMPTY_RESOURCE_MAP,
    StorageClass: needsStorageClass ? s.resources.StorageClass : EMPTY_RESOURCE_MAP,
  })));
  const {
    setActiveKind, selectItem, selectedItem,
    applyDelta,
  } = useResourceStore(useShallow(s => ({ setActiveKind: s.setActiveKind, selectItem: s.selectItem, selectedItem: s.selectedItem, applyDelta: s.applyDelta })));
  const { selectedNamespace, selectNamespace, isConnected, isLoading } = useClusterStore();
  const {
    density, uiScale, hiddenColumns, setHiddenColumns,
    columnOrder, setColumnOrder, resetColumnOrder,
    setRightTab, activePerspective, inspectorCollapsed, toggleInspector,
  } = useUiStore();
  const { openYamlEditor, openResourceDetail, openLogsTab, openTerminalTab, toggleSplit } = useWorkspaceStore();

  const {
    searchQuery, searchRegex, setSearchQuery, setSearchRegex,
    sorts, setSorts, columnFilters, setColumnFilters,
  } = useTableView(`kind:${effectiveKind}`);
  const displayKind = customType?.kind ?? effectiveKind;
  const listLabel = customType ? `${customResourcePlacement(customType)?.label ?? customType.kind} · ${customType.group}` : SIDEBAR_TREE.flatMap(category => category.groups.flatMap(group => group.kinds)).find(entry => entry.kind === effectiveKind)?.label ?? `${effectiveKind}s`;
  const custom = useCustomResources(customType);
  const podsByNode = useMemo(() => {
    const map = new Map<string, number>();
    if (effectiveKind !== 'Node') return map;
    const podMap = resources.Pod;
    if (!podMap) return map;
    for (const pod of podMap.values()) {
      const nodeName = pod.node || (pod.raw as any)?.spec?.nodeName;
      if (nodeName) map.set(nodeName, (map.get(nodeName) ?? 0) + 1);
    }
    return map;
  }, [effectiveKind, resources.Pod]);

  const tableColumns = useResourceColumns(effectiveKind, customType, podsByNode);
  const tableRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const currentContext = useClusterStore((s) => s.currentContext);
  const watchState = useResourceStore((s) => s.watchStates[effectiveKind]);
  const loadError = useResourceStore((s) => s.loadErrors[effectiveKind]);
  const kindLoading = useResourceStore(state => state.loadingKinds[effectiveKind]);
  const syncMode = useResourceStore(state => state.syncMode);

  const [menu, setMenu] = useState<{ item: ResourceItem; x: number; y: number } | null>(null);
  const [headerMenu, setHeaderMenu] = useState<{ colId: string; x: number; y: number } | null>(null);
  const [filterMenu, setFilterMenu] = useState<{ colId: string; x: number; y: number } | null>(null);
  const [draggingColumn, setDraggingColumn] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [pfFor, setPfFor] = useState<ResourceItem | null>(null);
  const [scaleFor, setScaleFor] = useState<ResourceItem | null>(null);

  const [newOpen, setNewOpen] = useState(false);
  const canCreate = !!currentContext && (k8s.demo || '__TAURI_INTERNALS__' in window);
  useEffect(() => setNewOpen(false), [currentContext, selectedNamespace, effectiveKind]);
  const [spinning, setSpinning] = useState(false);
  useEffect(() => setSpinning(false), [currentContext, selectedNamespace, effectiveKind]);

  /* JetBrains DataGrip Multi-selection and Keyboard state */
  const [selectedUids, setSelectedUids] = useState<Set<string>>(new Set());
  const [focusedIndex, setFocusedIndex] = useState<number>(0);
  const [lastSelectedIndex, setLastSelectedIndex] = useState<number | null>(null);

  const perspective = kindsFor(activePerspective);
  const noKinds = !explicitKind && perspective.length === 0;

  useEffect(() => {
    const dk = defaultKindFor(activePerspective);
    if (!explicitKind && dk && !perspective.includes(activeKind)) {
      setActiveKind(dk);
      setSearchQuery('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePerspective, explicitKind]);

  useEffect(() => {
    setSelectedUids(new Set());
    setFocusedIndex(0);
  }, [effectiveKind, currentContext]);

  const { allItems, rows, columnValues, statusValues } = useResourceTableModel({ resources, effectiveKind, tableColumns, selectedNamespace, searchQuery, searchRegex, columnFilters, sorts, hiddenColumns, columnOrder, isConnected, isLoading, activeFilterColumnId: filterMenu?.colId ?? null });
  useEffect(() => {
    if (!statusValues.length) return;
    setSorts(previous => {
      const current = previous.find(key => key.columnId === 'status');
      if (!current?.statusFirst || statusValues.includes(current.statusFirst)) return previous;
      return previous.map(key => key === current ? { ...key, statusFirst: statusValues[0] } : key);
    });
  }, [statusValues]);
  const pending = !loadError && (customType ? custom.loading : syncMode === 'watch' ? !watchState ? isLoading : ['connecting', 'syncing'].includes(watchState.phase) : kindLoading ?? isLoading);
  const initialLoading = pending && !allItems.length;
  useEffect(() => { setFocusedIndex(0); setLastSelectedIndex(null); }, [selectedNamespace, searchQuery, columnFilters, sorts]);

  const virtualized = rows.list.length > 200;
  const rowHeight = Math.ceil(Math.max((density === 'compact' ? 25 : 30) * uiFactor(uiScale), (11.5 * 1.45 + 8) * uiFactor(uiScale) + 1));
  const rowVirtualizer = useVirtualizer({ count: rows.list.length, getScrollElement: () => tableRef.current, estimateSize: () => rowHeight, overscan: 12,
    enabled: virtualized, getItemKey: index => rows.list[index]?.uid ?? index });
  const virtualRows = rowVirtualizer.getVirtualItems();
  const renderedRows = virtualized ? virtualRows.map(row => ({ item: rows.list[row.index], index: row.index })) : rows.list.map((item, index) => ({ item, index }));
  useEffect(() => { if (virtualized && rows.list.length) rowVirtualizer.scrollToIndex(Math.min(focusedIndex, rows.list.length - 1), { align: 'auto' }); }, [focusedIndex, virtualized, rows.list.length]);

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
  const { widthFor, moveColumn, resetColumn, resetWidths, startColResize, resizeColumnWithKeyboard } = useColumnLayout({ effectiveKind, columns: rows.cols, uiScale, tableRef, paneRef });

  /* ------------------- Sorting & filtering ------------------- */

  /**
   * Sort cycle for a column header.
   *
   * The first click adds the column to the hierarchy (outermost grouping),
   * the next clicks switch the direction and finally remove it. The Status
   * column cycles through the statuses that are really present in the data.
   */
  const cycleSort = (colId: string) => {
    setSorts((previous) => {
      const index = previous.findIndex((key) => key.columnId === colId);
      if (colId === 'status') {
        const choices = statusValues.length ? statusValues : ['—'];
        if (index === -1) return [...previous, { columnId: colId, direction: 'asc', statusFirst: choices[0] }];
        const current = previous[index];
        const next = choices[(choices.indexOf(current.statusFirst ?? choices[0]) + 1) % choices.length];
        const copy = [...previous];
        copy[index] = { ...current, statusFirst: next };
        return copy;
      }
      if (index === -1) return [...previous, { columnId: colId, direction: 'desc' }];
      const current = previous[index];
      if (current.direction === 'desc') {
        const copy = [...previous];
        copy[index] = { ...current, direction: 'asc' };
        return copy;
      }
      return previous.filter((_, position) => position !== index);
    });
  };

  const sortPriority = (colId: string): number => sorts.findIndex((key) => key.columnId === colId);

  const toggleFilterValue = (colId: string, value: string) => {
    setColumnFilters((previous) => {
      const next = cycleColumnFilter(previous[colId] ?? EMPTY_COLUMN_FILTER, value);
      const updated = { ...previous };
      if (columnFilterCount(next)) updated[colId] = next;
      else delete updated[colId];
      return updated;
    });
  };

  const clearFilterColumn = (colId: string) => {
    setColumnFilters((previous) => {
      const updated = { ...previous };
      delete updated[colId];
      return updated;
    });
  };

  const resetAll = () => {
    setSorts([]);
    setColumnFilters({});
    setSearchQuery('');
  };

  const activeFilterCount = Object.values(columnFilters).reduce((sum, values) => sum + columnFilterCount(values), 0);

  const buildHeaderMenu = (colId: string): MenuItem[] => {
    const col = tableColumns.find((c) => c.id === colId);
    const index = rows.cols.findIndex((c) => c.id === colId);
    const canMoveLeft = index > 0;
    const canMoveRight = index >= 0 && index < rows.cols.length - 1;
    return [
      { id: 'asc', label: 'Sort ascending', icon: ArrowUp, kbd: sortPriority(colId) >= 0 && sorts[sortPriority(colId)]?.direction === 'asc' ? '✓' : undefined, onSelect: () => cycleSort(colId) },
      { id: 'desc', label: 'Sort descending', icon: ArrowDown, kbd: sortPriority(colId) >= 0 && sorts[sortPriority(colId)]?.direction === 'desc' ? '✓' : undefined, onSelect: () => cycleSort(colId) },
      ...(sortPriority(colId) >= 0 ? [{ id: 'sort-clear', label: 'Remove from sorting', onSelect: () => setSorts((previous) => previous.filter((key) => key.columnId !== colId)) } as MenuItem] : []),
      { id: 'sep-h1', label: '', separator: true, onSelect: () => {} },
      { id: 'move-left', label: 'Move column left', icon: ArrowRightLeft, disabled: !canMoveLeft, onSelect: () => moveColumn(colId, -1) },
      { id: 'move-right', label: 'Move column right', icon: ArrowRightLeft, disabled: !canMoveRight, onSelect: () => moveColumn(colId, 1) },
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

  const { doDelete, doScale, doRestart, doToggleCordon, doDrain, doEvictPod, doToggleCronJobSuspend, doTriggerCronJob, doArgoSync, doArgoRefresh, doShare } = useResourceActions(currentContext, refresh);

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
      opItems.push({ id: 'restart', label: 'Restart rollout', icon: RotateCw, onSelect: () => { void doRestart(item); } });
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
          onSelect: () => { void doDrain(item); },
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
      dangerItems.push({ id: 'evict', label: 'Evict Pod…', icon: Trash2, danger: true, onSelect: () => { void doEvictPod(item); } });
    }
    dangerItems.push({ id: 'delete', disabled: !!customType, label: k8s.demo ? 'Delete (demo)…' : 'Delete…', icon: Trash2, danger: true, kbd: '⌫', onSelect: () => { void doDelete(item); } });

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

  const KindIcon = resourceIcon(effectiveKind);
  const rowH = density === 'compact' ? 'h-[calc(25px*var(--ui-factor))]' : 'h-[calc(30px*var(--ui-factor))]';
  const hiddenForKind = new Set(hiddenColumns[effectiveKind] ?? []);
  const activeFilters = activeFilterCount + sorts.length;

  return (
    <div ref={paneRef} className="flex-1 flex flex-col min-h-0 min-w-0 relative bg-[var(--bg-canvas)]">
      {/* JetBrains DataGrip-Grade Toolbar */}
      <div className="h-9 shrink-0 flex items-center gap-2 pl-3 border-b border-[var(--border-default)] bg-[var(--bg-canvas)] workspace-toolbar-safe">
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
                  { id: 'issues', label: 'Sort: issues first', checked: sorts.some((key) => key.columnId === '__issues'), onSelect: () => setSorts((previous) => previous.some((key) => key.columnId === '__issues') ? previous.filter((key) => key.columnId !== '__issues') : [...previous, { columnId: '__issues', direction: 'desc' }]) },
                  { id: 'reset', label: 'Reset visibility', onSelect: () => setHiddenColumns(effectiveKind, []) },
                  { id: 'reset-widths', label: 'Reset column widths', onSelect: resetWidths },
                  { id: 'reset-order', label: 'Reset column order', disabled: !(columnOrder[effectiveKind]?.length), onSelect: () => { resetColumnOrder(effectiveKind); toast.info('Column order reset', effectiveKind); } },
                ]}
                onSelect={(item) => { item.onSelect?.(); close(); }}
              />
              <div className="px-2.5 pb-1 pt-1.5 text-[length:calc(10px*var(--ui-factor))] text-[var(--text-muted)] leading-relaxed">
                Drag headers to reorder · drag borders to resize · right-click a header to filter
              </div>
            </>
          )}
        </Popover>

        <Tooltip label="Refresh list" delay={400}>
          <IconButton icon={RefreshCw} size="sm" onClick={refresh} className={cx(spinning && 'animate-[spin_0.7s_linear_infinite]')} aria-label="Refresh" />
        </Tooltip>

        <Button variant="primary" size="sm" disabled={!canCreate} title={canCreate ? `Create ${displayKind}` : 'Open the desktop application to create resources'} onClick={() => setNewOpen(true)}>
          <Plus size="calc(13px * var(--ui-factor))" />
          New
        </Button>
      </div>

      <div className="resource-search-row border-b border-[var(--border-default)] workspace-toolbar-safe" data-testid="resource-search-toolbar">
        <SearchInput
          value={searchQuery}
          onChange={setSearchQuery}
          isRegex={searchRegex}
          onToggleRegex={setSearchRegex}
          placeholder={`Filter ${displayKind.toLowerCase()}s…`}
          className="resource-search-field"
        />
        {activeFilters > 0 && (
          <Button
            size="sm"
            variant="ghost"
            onClick={resetAll}
            aria-label="Reset all filters and sorting"
            title="Reset all filters and sorting"
            className="!h-[calc(24px*var(--ui-factor))] shrink-0 gap-1.5 text-[var(--text-secondary)]"
          >
            <RotateCcw size="calc(12px * var(--ui-factor))" />
            <span>Reset</span>
            <span className="font-mono text-[length:calc(10px*var(--ui-factor))] tabular-nums text-[var(--accent)]">{activeFilters}</span>
          </Button>
        )}
        <span className="shrink-0 text-[length:calc(10px*var(--ui-factor))] text-[var(--text-muted)] hidden lg:inline">
          Click a header to sort · right-click to filter
        </span>
      </div>

      {/* JetBrains DataGrip Data Table */}
      <div ref={tableRef} tabIndex={0} aria-label={`${displayKind} resource table`} aria-busy={pending || spinning} className="flex-1 overflow-auto kubiki-scrollbar min-h-0 select-none resource-table-scroll" data-testid="resource-table">
        {k8s.supportsResourceWatch && !customType && resourceType(effectiveKind).watch === false && <p className="px-3 py-1 text-xs text-[var(--text-secondary)]">This API supports snapshots only · refreshed every 30 seconds</p>}
        {loadError && <RequestErrorNotice error={loadError} onRetry={() => void refresh()} retainedData={allItems.length > 0 || watchState?.hasSnapshot === true} />}
        {initialLoading && <ResourceLoading label={`Loading ${displayKind} resources…`} description={watchState ? 'Waiting for the first complete snapshot from Kubernetes.' : 'Waiting for Kubernetes to respond.'} />}
        {!initialLoading && (pending || spinning) && <div className="resource-loading-overlay"><ResourceLoading compact label={`Refreshing ${displayKind} resources…`} /></div>}
        {watchState?.phase === 'reconnecting' && !loadError && <ResourceLoading compact label="Reconnecting… Showing the last complete snapshot." />}
        {rows.list.length === 0 ? !initialLoading && !loadError && (
          <EmptyState
            kind={displayKind}
            iconKind={effectiveKind}
            filtered={(selectedNamespace !== 'all' && allItems.length > 0) || !!searchQuery || activeFilterCount > 0 || sorts.length > 0}
            onClear={() => { selectNamespace('all'); resetAll(); }}
            isNew={canCreate && allItems.length === 0 && !loadError}
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
                <th aria-label="Row numbers" className="datagrip-th select-none text-center p-0" style={{ width: uiPixels(widthFor('__index')) }}>
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
                    onDoubleClick={(e) => { e.stopPropagation(); resetColumn('__index'); }}
                    onClick={(e) => e.stopPropagation()}
                    className="absolute right-0 top-0 h-full w-[calc(6px*var(--ui-factor))] cursor-col-resize touch-none hover:bg-[var(--accent)]/50 active:bg-[var(--accent)]" />
                </th>

                {rows.cols.map((c) => {
                  const priority = sortPriority(c.id);
                  const key = priority >= 0 ? sorts[priority] : undefined;
                  const filterValues = columnFilters[c.id] ?? EMPTY_COLUMN_FILTER;
                  const filtered = columnFilterCount(filterValues) > 0;
                  return (
                    <th
                      key={c.id}
                      aria-label={c.label}
                      aria-sort={key ? (key.statusFirst !== undefined ? 'other' : key.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
                      tabIndex={0}
                      draggable
                      onDragStart={(event) => {
                        const target = event.target as HTMLElement;
                        if (target.closest('[role="separator"]') || target.closest('[data-column-caret]')) {
                          event.preventDefault();
                          return;
                        }
                        event.dataTransfer.effectAllowed = 'move';
                        event.dataTransfer.setData('text/plain', c.id);
                        setDraggingColumn(c.id);
                      }}
                      onDragOver={(event) => {
                        if (!draggingColumn) return;
                        event.preventDefault();
                        event.dataTransfer.dropEffect = 'move';
                        setDropTarget(c.id);
                      }}
                      onDragLeave={() => setDropTarget((current) => (current === c.id ? null : current))}
                      onDrop={(event) => {
                        event.preventDefault();
                        const source = draggingColumn;
                        setDraggingColumn(null);
                        setDropTarget(null);
                        if (!source || source === c.id) return;
                        const order = rows.cols.map((column) => column.id);
                        const from = order.indexOf(source);
                        const to = order.indexOf(c.id);
                        if (from === -1 || to === -1) return;
                        const next = [...order];
                        next.splice(to, 0, ...next.splice(from, 1));
                        setColumnOrder(effectiveKind, next);
                      }}
                      onDragEnd={() => { setDraggingColumn(null); setDropTarget(null); }}
                      onKeyDown={event => {
                        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); cycleSort(c.id); }
                        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                          event.preventDefault();
                          const rect = event.currentTarget.getBoundingClientRect();
                          setFilterMenu({ colId: c.id, x: rect.left, y: rect.bottom });
                        }
                      }}
                      title={key?.statusFirst ? `${key.statusFirst} first` : c.hint}
                      style={{ width: uiPixels(widthFor(c.id)) }}
                      onClick={event => {
                        if ((event.target as HTMLElement).closest('[data-column-caret]')) return;
                        cycleSort(c.id);
                      }}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        setFilterMenu({ colId: c.id, x: event.clientX, y: event.clientY });
                      }}
                      className={cx(
                        'datagrip-th select-none relative font-medium cursor-pointer hover:text-[var(--text-primary)] transition-colors',
                        c.align === 'right' ? 'text-right pl-[calc(22px*var(--ui-factor))] pr-2.5' : 'text-left pl-2.5 pr-[calc(24px*var(--ui-factor))]',
                        draggingColumn === c.id && 'opacity-50',
                        dropTarget === c.id && draggingColumn && draggingColumn !== c.id && 'ring-1 ring-inset ring-[var(--accent)]',
                      )}
                    >
                      <span className="inline-flex items-center gap-1 min-w-0 max-w-full">
                        <span className="truncate">{c.label}</span>
                        {key && (
                          <span className="shrink-0 inline-flex items-center gap-0.5 text-[var(--accent)]" title={key.statusFirst ? `${key.statusFirst} first` : key.direction === 'asc' ? 'Sorted ascending' : 'Sorted descending'}>
                            <span className="font-mono text-[length:calc(9px*var(--ui-factor))] tabular-nums">{priority + 1}</span>
                            {key.statusFirst !== undefined
                              ? <span className="truncate max-w-[calc(80px*var(--ui-factor))] text-[length:calc(10px*var(--ui-factor))]">{key.statusFirst} ↑</span>
                              : key.direction === 'asc' ? <ArrowUp size="calc(10px * var(--ui-factor))" /> : <ArrowDown size="calc(10px * var(--ui-factor))" />}
                          </span>
                        )}
                        {filtered && (
                          <span className="shrink-0 inline-flex items-center gap-0.5 text-[var(--accent)]" title={`Include: ${filterValues.include.join(', ') || 'any'}; exclude: ${filterValues.exclude.join(', ') || 'none'}`}>
                            <Filter size="calc(10px * var(--ui-factor))" />
                            <span className="font-mono text-[length:calc(9px*var(--ui-factor))] tabular-nums">{columnFilterCount(filterValues)}</span>
                          </span>
                        )}
                      </span>
                      <button
                        type="button"
                        data-column-caret
                        aria-label={`${c.label} column actions`}
                        aria-haspopup="menu"
                        onClick={(event) => {
                          event.stopPropagation();
                          event.preventDefault();
                          const rect = event.currentTarget.getBoundingClientRect();
                          setHeaderMenu({ colId: c.id, x: rect.left, y: rect.bottom });
                        }}
                        className={cx(
                          'absolute top-1/2 -translate-y-1/2 rounded-[calc(3px*var(--ui-factor))] text-[var(--text-muted)] opacity-60 hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] hover:opacity-100 focus-visible:opacity-100 transition-opacity',
                          // The caret sits on the opposite edge from the label so it never
                          // merges with right-aligned headers; it uses the empty side.
                          c.align === 'right'
                            ? 'left-[calc(0px*var(--ui-factor))] p-[calc(1px*var(--ui-factor))]'
                            : 'right-[calc(7px*var(--ui-factor))] p-[calc(2px*var(--ui-factor))]'
                        )}
                      >
                        <ChevronDown size="calc(10px * var(--ui-factor))" />
                      </button>
                      {/* Drag handle for resizing column */}
                      <span
                        role="separator" aria-label={`Resize ${c.label} column`} tabIndex={0} aria-valuenow={widthFor(c.id)} onKeyDown={(e) => resizeColumnWithKeyboard(e, c.id)} aria-orientation="vertical"
                        title="Drag or use arrow keys to resize · Home to reset"
                        draggable={false}
                        onDragStart={(e) => { e.preventDefault(); e.stopPropagation(); }}
                        onPointerDown={(e) => startColResize(e, c.id)}
                        onDoubleClick={(e) => {
                          e.stopPropagation();
                          resetColumn(c.id);
                        }}
                        onClick={(e) => e.stopPropagation()}
                        className="absolute right-0 top-0 h-full w-[calc(6px*var(--ui-factor))] cursor-col-resize touch-none hover:bg-[var(--accent)]/50 active:bg-[var(--accent)] transition-colors z-10"
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
                          'datagrip-cell select-none px-2.5',
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

      {/* Column actions menu */}
      {headerMenu && (
        <FixedMenu rect={{ x: headerMenu.x, y: headerMenu.y }} items={buildHeaderMenu(headerMenu.colId)} onClose={() => setHeaderMenu(null)} />
      )}

      {/* Column filter popup — right-click on a header */}
      {filterMenu && (
        <ColumnFilterPopup
          rect={{ x: filterMenu.x, y: filterMenu.y }}
          columnLabel={tableColumns.find((column) => column.id === filterMenu.colId)?.label ?? filterMenu.colId}
          values={columnValues.get(filterMenu.colId) ?? new Map()}
          selected={columnFilters[filterMenu.colId] ?? EMPTY_COLUMN_FILTER}
          quick={filterMenu.colId === 'status' ? [...(columnValues.get('status')?.keys() ?? [])].filter((status) => status !== '—').slice(0, 6) : undefined}
          onToggle={(value) => toggleFilterValue(filterMenu.colId, value)}
          onClear={() => clearFilterColumn(filterMenu.colId)}
          onClose={() => setFilterMenu(null)}
        />
      )}

      {/* Action Dialogs */}
      <PFDialog item={pfFor} onClose={() => setPfFor(null)} />
      <ScaleDialog item={scaleFor} onClose={() => setScaleFor(null)} onApply={(n) => scaleFor && doScale(scaleFor, n)} />
      <NewResourceDialog
        open={newOpen}
        type={customType ?? resourceType(effectiveKind)}
        context={currentContext}
        defaultNs={defaultNamespace(selectedNamespace)}
        onClose={() => setNewOpen(false)}
        onCreate={async (object, yaml) => {
          if (!currentContext || useClusterStore.getState().currentContext !== currentContext) throw new Error('The selected context changed. Reopen the creation dialog.');
          if (k8s.demo) {
            const item = mapK8sResource({ ...object, metadata: { ...object.metadata, uid: `new-${crypto.randomUUID()}`, creationTimestamp: new Date().toISOString() } }, object.kind as ResourceKind);
            applyDelta({ type: 'Applied', payload: { gvk: effectiveKind, data: item } });
            toast.success(`${displayKind} created (demo)`, object.metadata.name);
            setNewOpen(false);
            openYamlTab(item);
            return;
          }
          await k8s.applyManifest(currentContext, yaml);
          toast.success(`${displayKind} created`, object.metadata.name);
          if (useClusterStore.getState().currentContext === currentContext) {
            setNewOpen(false);
            await refresh();
          }
        }}
      />
    </div>
  );
};

function EmptyState({ kind, iconKind, filtered, onClear, isNew, onNew }: { kind: string; iconKind: string; filtered: boolean; onClear: () => void; isNew: boolean; onNew: () => void }) {
  const Icon = resourceIcon(iconKind);
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
