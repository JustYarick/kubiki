import { performResourceAction, restartManifest } from '../../providers/resource_actions';
import { resourceBucket } from '../../core/resources/custom_resource_types';
import React, { Suspense, lazy, useMemo, useState, useEffect } from 'react';
import { ArrowLeft, ArrowRight, Boxes, ChevronDown, ChevronRight, Loader2, X } from 'lucide-react';
import { useResourceStore } from '../../state/resource_store';
import { useClusterStore } from '../../state/cluster_store';
import type { RightTab } from '../../state/ui_store';
import { useUiStore } from '../../state/ui_store';
import { useDockStore } from '../../state/dock_store';
import { useTopologyGraph } from '../../providers/use_topology_graph';
import { relatedResourceKinds } from '../../core/resources/resource_demand';
import { useHelmGraph } from '../../providers/use_helm_graph';
import { resourceKey, resourceRef } from '../../core/resources/identity';
import type { ResourceRelation } from '../../core/resources/relationships';
import { resourceEvents } from '../../core/resources/resource_events';
import { podContainers } from '../../core/resources/containers';
import { findWorkloadPods, preferredWorkloadPod } from '../../core/resources/workload_pods';
import { NamespaceScopeNotice } from '../k8s/NamespaceScopeNotice';
import { ResourceWarnings } from '../k8s/ResourceWarnings';
import { ResourceKindBadge } from '../k8s/ResourceKindBadge';
import { IconButton, Button } from '../ui/Button';
import { SearchInput } from '../ui/Input';
import { PFDialog } from '../dialogs/PFDialog';
import { toast } from '../../state/notifications_store';
import { parse } from 'yaml';
import { cx } from '../../core/utils/cx';
import { mapK8sResource } from '../../core/utils/k8s_mapper';
import { FullManifest } from '../../views/FullManifest';
import { k8s } from '../../providers/k8s_provider';
import type { ResourceItem } from '../../types/k8s';
import { DetailsPanel } from '../k8s/details/DetailsPanel';
import { ResourceLoading } from '../ui/ResourceLoading';
import { ResourceDetailsRouter } from '../k8s/details/ResourceDetailsRouter';
import { PodEnvironmentTab } from '../k8s/details/PodEnvironmentTab';
import { retainResourceKinds } from '../../state/resource_requirements';

const YamlEditor = lazy(() => import('../../views/YamlEditor').then((m) => ({ default: m.YamlEditor })));
const HelmReleaseDetails = lazy(() => import('../../views/HelmView').then(m => ({ default: m.HelmReleaseDetails })));

export const InspectorPanel: React.FC = () => {
  const selected = useResourceStore((s) => s.selectedItem);
  const history = useResourceStore((s) => s.selectionHistory);
  const resources = useResourceStore((s) => s.resources);
  const item = selected ? resources[resourceBucket(selected)]?.get(selected.uid) : undefined;
  const backTarget = [...history].reverse().map(previous => resources[resourceBucket(previous)]?.get(previous.uid)).find(previous => previous && (previous.uid !== item?.uid || item && resourceBucket(previous) !== resourceBucket(item)));
  const close = () => useUiStore.setState({ inspectorCollapsed: true });

  return (
    <ResourceDetails
      inspector
      item={item}
      onClose={close}
      onNavigate={(next) => useResourceStore.getState().selectItem(next, { history: true })}
      backTarget={backTarget}
      onBack={backTarget ? () => useResourceStore.getState().goBack() : undefined}
    />
  );
};

export interface ResourceDetailsProps {
  item?: ResourceItem;
  onClose?: () => void;
  onNavigate: (item: ResourceItem) => void;
  onBack?: () => void;
  backTarget?: ResourceItem;
  inspector?: boolean;
}

export function ResourceDetails(props: ResourceDetailsProps) {
  if (props.item && resourceBucket(props.item) === 'HelmRelease') return <Suspense fallback={<ResourceLoading label="Loading release details…" />}>
    <HelmReleaseDetails {...props} item={props.item} />
  </Suspense>;
  return <KubernetesResourceDetails {...props} />;
}

function getResourceKindRank(kind?: string): number {
  if (!kind) return 999;
  if (['HelmRelease', 'Kustomization', 'Application', 'ApplicationSet', 'GitRepository', 'HelmRepository', 'OCIRepository'].includes(kind)) return 10;
  if (['Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob', 'Rollout'].includes(kind)) return 20;
  if (['Ingress', 'Gateway', 'HTTPRoute', 'GRPCRoute', 'TCPRoute', 'TLSRoute', 'VirtualService'].includes(kind)) return 30;
  if (['Service', 'NetworkPolicy'].includes(kind)) return 40;
  if (['ConfigMap', 'Secret', 'PersistentVolumeClaim', 'PersistentVolume', 'StorageClass'].includes(kind)) return 50;
  if (['ServiceAccount', 'Role', 'ClusterRole', 'RoleBinding', 'ClusterRoleBinding'].includes(kind)) return 60;
  if (['ReplicaSet'].includes(kind)) return 70;
  if (['Pod'].includes(kind)) return 80;
  if (['EndpointSlice', 'Endpoints'].includes(kind)) return 90;
  if (['Event', 'Node', 'Lease'].includes(kind)) return 100;
  return 65;
}

export interface RelatedItemEntry {
  id: string;
  target?: ResourceItem;
  missing?: ResourceRelation['missing'];
  label: string;
  outgoing: boolean;
  kind: string;
  name: string;
  namespace?: string;
}

function RelatedRow({
  entry,
  onNavigate,
  nested = false,
  isCompact = false,
}: {
  entry: RelatedItemEntry;
  onNavigate: (item: ResourceItem) => void;
  nested?: boolean;
  isCompact?: boolean;
}) {
  const target = entry.target;
  return (
    <button
      key={entry.id}
      type="button"
      disabled={!target}
      onClick={() => target && onNavigate(target)}
      title={`${entry.kind}/${entry.name} (${entry.label})`}
      className={cx(
        'w-full flex items-center gap-1.5 border-b border-[var(--border-subtle)] last:border-b-0 text-left hover:bg-[var(--bg-hover)] disabled:opacity-60 transition-colors cursor-pointer disabled:cursor-not-allowed select-none group',
        isCompact ? 'py-1 min-h-[var(--row-h-compact)]' : 'py-1.5 min-h-[var(--row-h-md)]',
        nested ? 'pl-6 pr-2.5' : 'px-2.5'
      )}
    >
      {entry.outgoing ? (
        <ArrowRight size="calc(11px * var(--ui-factor))" className="shrink-0 text-[var(--text-muted)] group-hover:text-[var(--accent)] transition-colors" />
      ) : (
        <ArrowLeft size="calc(11px * var(--ui-factor))" className="shrink-0 text-[var(--text-muted)] group-hover:text-[var(--accent)] transition-colors" />
      )}
      <ResourceKindBadge kind={entry.kind} apiVersion={target?.apiVersion} />
      <div className="flex items-center gap-1.5 min-w-0 flex-1">
        {target && <ResourceWarnings item={target} />}
        <span className="font-mono text-[length:var(--font-size-sm)] text-[var(--text-primary)] truncate group-hover:text-[var(--accent)] transition-colors" title={entry.name}>
          {entry.name}
        </span>
        <span className="text-[length:var(--font-size-2xs)] text-[var(--text-muted)] truncate shrink-0">
          {entry.namespace ?? 'cluster'}{!target && ' · not loaded'}
        </span>
      </div>
      <span className="text-[length:var(--font-size-2xs)] text-[var(--text-muted)] font-mono shrink-0">
        {entry.label}
      </span>
    </button>
  );
}

function KubernetesResourceDetails({
  item,
  onClose,
  onNavigate,
  onBack,
  backTarget,
  inspector = false,
}: ResourceDetailsProps) {
  const [pfOpen, setPfOpen] = useState(false);
  const inspectorTab = useUiStore((s) => s.rightTab);
  const density = useUiStore((s) => s.density);
  const isCompact = density === 'compact';
  const [localTab, setLocalTab] = useState<RightTab>('overview');
  const rightTab = inspector ? inspectorTab : localTab;
  const helm = useHelmGraph(item?.namespace, rightTab === 'related');
  const setTab = inspector ? useUiStore.getState().setRightTab : setLocalTab;
  const resources = useResourceStore((s) => s.resources);
  const [relatedQuery, setRelatedQuery] = useState('');
  const [relatedLimits, setRelatedLimits] = useState<Record<string, number>>({});

  const [expandedKinds, setExpandedKinds] = useState<Set<string>>(new Set());

  useEffect(() => {
    setRelatedQuery('');
    setRelatedLimits({});
    setExpandedKinds(new Set());
  }, [item?.uid]);

  const { graph, loading: relatedLoading, notice: relatedError } = useTopologyGraph(resources, 'related', item, 3, !!item && rightTab === 'related');

  const toggleKindGroup = (kind: string) => {
    setExpandedKinds((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  };

  const childPods = useMemo(
    () => (item ? findWorkloadPods(item, { Pod: resources.Pod, ReplicaSet: resources.ReplicaSet, Job: resources.Job }) : []),
    [item, resources.Pod, resources.ReplicaSet, resources.Job]
  );
  const currentContext = useClusterStore((s) => s.currentContext);
  const selectedNamespace = useClusterStore((s) => s.selectedNamespace);
  useEffect(() => {
    if (!inspector && item && currentContext && rightTab === 'related') {
      return retainResourceKinds(currentContext, relatedResourceKinds(item), item.namespace ?? (item.kind === 'Namespace' ? item.name : undefined) ?? selectedNamespace);
    }
  }, [inspector, item, currentContext, rightTab, selectedNamespace]);

  const resolvedRelated = useMemo(() => {
    if (!item) return [];
    const key = resourceKey(item);
    const seenKeys = new Set<string>([key]);
    const entries: RelatedItemEntry[] = [];

    const addEntry = (entry: RelatedItemEntry) => {
      const entryKey = entry.target
        ? resourceKey(entry.target)
        : resourceKey({ kind: entry.kind, name: entry.name, namespace: entry.namespace, apiVersion: entry.missing?.apiVersion ?? '' });
      if (seenKeys.has(entryKey)) return;
      seenKeys.add(entryKey);
      entries.push(entry);
    };

    // 1. Direct & multi-hop relations from topology graph
    const relations = graph?.relations ?? [];
    for (const edge of relations) {
      const isSource = edge.source === key;
      const isTarget = edge.target === key;
      if (isSource || isTarget || edge.type === 'owns' || edge.type === 'manages') {
        const outgoing = isSource;
        const targetKey = outgoing ? edge.target : edge.source;
        const target = edge.missing ? undefined : graph?.items.get(targetKey);
        const kind = target?.kind ?? edge.missing?.kind ?? 'Resource';
        const name = target?.name ?? edge.missing?.name ?? '';
        const namespace = target?.namespace ?? edge.missing?.namespace;
        addEntry({
          id: edge.id,
          target,
          missing: edge.missing,
          label: !isSource && !isTarget && edge.type === 'owns' ? 'root controller' : edge.label,
          outgoing,
          kind,
          name,
          namespace,
        });
      }
    }

    return entries;
  }, [item, graph]);

  const filteredRelated = useMemo(() => {
    const q = relatedQuery.trim().toLowerCase();
    if (!q) return resolvedRelated;
    return resolvedRelated.filter((entry) =>
      [entry.name, entry.kind, entry.namespace, entry.label]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(q)
    );
  }, [resolvedRelated, relatedQuery]);

  const groupedRelated = useMemo(() => {
    const map = new Map<string, RelatedItemEntry[]>();
    for (const entry of filteredRelated) {
      const list = map.get(entry.kind) ?? [];
      list.push(entry);
      map.set(entry.kind, list);
    }
    const groups: Array<{ kind: string; rank: number; items: RelatedItemEntry[] }> = [];
    for (const [kind, items] of map.entries()) {
      groups.push({
        kind,
        rank: getResourceKindRank(kind),
        items: items.sort((a, b) => a.name.localeCompare(b.name)),
      });
    }
    return groups.sort((a, b) => a.rank - b.rank || a.kind.localeCompare(b.kind));
  }, [filteredRelated]);

  if (!item) {
    return (
      <div className="h-full flex flex-col bg-[var(--bg-canvas)]">
        <div className="h-10 flex items-center px-3 gap-2 border-b border-[var(--border-default)]">
          <Boxes size="calc(14px * var(--ui-factor))" />
          <span className="flex-1 font-medium text-xs">Resource details</span>
          {onClose && <IconButton icon={X} size="sm" onClick={onClose} aria-label="Close details" />}
        </div>
        <div className="flex-1 flex items-center justify-center p-8 text-center text-[var(--text-secondary)]">
          <div>
            <Boxes size="calc(30px * var(--ui-factor))" className="mx-auto mb-3 opacity-50" />
            <p className="text-sm font-medium">Select a resource to inspect</p>
            <p className="mt-1 text-[length:calc(11px*var(--ui-factor))] text-[var(--text-muted)]">
              Click a table row or a topology node. Details and related resources appear here.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const activePod = item.kind === 'Pod' ? item : preferredWorkloadPod(childPods);
  const containers = podContainers(activePod ?? item).map((c) => c.name);

  const logs = (container?: string) => {
    if (item.kind === 'Pod') {
      return useDockStore.getState().openLogs(item.name, item.namespace, container, containers);
    }
    if (!activePod) {
      toast.info(`No active pods found for ${item.kind}/${item.name}`);
      return '';
    }
    return useDockStore.getState().openLogs(activePod.name, activePod.namespace, container, containers);
  };

  const shell = (container?: string) => {
    if (item.kind === 'Node') {
      return useDockStore.getState().openNodeShell(item.name);
    }
    if (item.kind === 'Pod') {
      return useDockStore.getState().openTerminal(item.name, item.namespace, container, containers);
    }
    if (!activePod) {
      toast.info(`No active pods found for ${item.kind}/${item.name}`);
      return '';
    }
    return useDockStore.getState().openTerminal(activePod.name, activePod.namespace, container, containers);
  };

  const navigate = (next: ResourceItem) => {
    setTab('overview');
    onNavigate(next);
  };

  const doDelete = async () => {
    try {
      if (k8s.demo) {
        useResourceStore.getState().deleteItem(item.kind, item.uid);
        toast.success(`Deleted ${item.kind}/${item.name} (demo)`);
        onClose?.();
      } else {
        if (!currentContext) {
          toast.error('No active cluster context');
          return;
        }
        await k8s.deleteResource(
          currentContext,
          item.kind,
          item.name,
          item.namespace,
          item.uid,
          item.raw?.metadata?.resourceVersion ?? '',
          item.apiVersion
        );
        onClose?.();
      }
    } catch (err: any) {
      if (err?.code === 'cancelled') toast.info('Delete cancelled');
      else toast.error('Failed to delete resource', String(err?.message || err));
    }
  };

  const doRestart = async () => {
    if (!currentContext && !k8s.demo) {
      toast.error('No active cluster context');
      return;
    }
    const rawCopy = restartManifest(item);

    try {
      if (k8s.demo) {
        useResourceStore.getState().updateItem(item.kind, item.uid, { ...item, raw: rawCopy });
        toast.success(`Rollout restart triggered for ${item.kind}/${item.name} (demo)`);
      } else {
        await performResourceAction(currentContext!, item, { type: 'restart' });
      }
    } catch (err: any) {
      if (err?.code === 'cancelled') toast.info('Restart cancelled');
      else toast.error('Failed to trigger rollout restart', String(err?.message || err));
    }
  };

  const doToggleCordon = async () => {
    if (!currentContext && !k8s.demo) {
      toast.error('No active cluster context');
      return;
    }
    const nextUnschedulable = !item.raw?.spec?.unschedulable;
    const rawCopy = JSON.parse(JSON.stringify(item.raw ?? {}));
    rawCopy.spec = rawCopy.spec ?? {};
    rawCopy.spec.unschedulable = nextUnschedulable;

    try {
      if (k8s.demo) {
        useResourceStore.getState().updateItem('Node', item.uid, { ...item, raw: rawCopy });
        toast.success(`Node ${item.name} ${nextUnschedulable ? 'cordoned' : 'uncordoned'} (demo)`);
        return 'success';
      } else {
        await performResourceAction(currentContext!, item, { type: 'cordon', unschedulable: nextUnschedulable });
        return 'success';
      }
    } catch (err: any) {
      if (err?.code === 'cancelled') {
        toast.info('Cordon cancelled');
        return 'cancelled';
      } else {
        toast.error('Failed to update cordon state', String(err?.message || err));
        return 'failed';
      }
    }
  };

  const doDrain = async () => {
    if (!currentContext && !k8s.demo) {
      toast.error('No active cluster context');
      return;
    }
    if (k8s.demo) {
      const allPods = [...(useResourceStore.getState().resources.Pod?.values() ?? [])];
      const nodePods = allPods.filter(
        (p) => (p.raw?.spec?.nodeName === item.name || p.node === item.name) &&
          !p.raw?.metadata?.ownerReferences?.some((o: any) => o.kind === 'DaemonSet')
      );
      if (nodePods.length === 0) {
        toast.success(`Node ${item.name} cordoned; no non-daemonset pods to drain`);
        return;
      }
      for (const pod of nodePods) {
        useResourceStore.getState().deleteItem('Pod', pod.uid);
      }
      toast.success(`Drained ${nodePods.length} pod(s) from node ${item.name} (demo)`);
      return;
    }
    try {
      const primary = resourceRef(currentContext!, item);
      await k8s.applyBatch(primary, [{
        operation: 'drain',
        resource: primary,
        resource_version: item.raw?.metadata?.resourceVersion ?? '',
        critical: true,
      }]);
    } catch (err: any) {
      if (err?.code === 'cancelled') {
        toast.info('Drain cancelled');
        return;
      }
      toast.error(`Drain failed for ${item.name}`, String(err?.message || err));
    }
  };

  const attach = (container?: string) => {
    const target = activePod ?? item;
    useDockStore.getState().openAttachTerminal(target.name, target.namespace, container, containers);
  };

  return (
      <DetailsPanel
        item={item}
        inspector={inspector}
        onClose={onClose}
        onBack={onBack}
        backTarget={backTarget}
        onNavigate={navigate}
        onLogs={() => logs()}
        onShell={() => shell()}
        onAttach={item.kind === 'Pod' ? () => attach() : undefined}
        onRestart={['Deployment', 'StatefulSet', 'DaemonSet'].includes(item.kind) ? () => { void doRestart(); } : undefined}
        onDelete={() => { void doDelete(); }}
        onCordon={item.kind === 'Node' ? doToggleCordon : undefined}
        onDrain={item.kind === 'Node' ? () => void doDrain() : undefined}
        onPorts={() => setPfOpen(true)}
        rightTab={rightTab}
        setTab={setTab}
        tabs={item.kind === 'Pod' ? [
          { id: 'overview', label: 'Overview' },
          { id: 'env', label: 'Environment' },
          { id: 'related', label: 'Related' },
          { id: 'events', label: 'Events' },
          { id: 'yaml', label: 'YAML' },
        ] : undefined}
        busy={rightTab === 'related' && (helm.loading || relatedLoading)}
        busyLabel="Loading resource relationships…"
        footer={
          <>
            <PFDialog key={`pf-${item.uid}`} item={pfOpen ? item : null} onClose={() => setPfOpen(false)} />
          </>
        }
      >
        {rightTab === 'yaml' ? (
          <Suspense fallback={<div className="p-4 text-[var(--text-muted)] flex gap-2"><Loader2 size="calc(13px * var(--ui-factor))" /> Loading editor…</div>}>
            <FullManifest item={item}>{(item) => (
            <YamlEditor
              key={item.uid}
              item={item}
              onApply={async (yaml) => {
                try {
                  if (k8s.demo) {
                    useResourceStore.getState().updateItem(item.kind, item.uid, { ...mapK8sResource(parse(yaml), item.kind), uid: item.uid });
                    toast.success('Manifest saved in demo memory');
                  } else {
                    const currentContext = useClusterStore.getState().currentContext;
                    if (!currentContext) {
                      throw new Error('No active cluster context');
                    }
                    await k8s.applyManifest(currentContext, yaml, item);
                  }
                } catch (err: any) {
                  if (err?.code === 'cancelled') {
                    toast.info('Apply cancelled');
                  } else {
                    toast.error('Apply failed', String(err?.message || err));
                  }
                  throw err;
                }
              }}
            />
            )}</FullManifest>
          </Suspense>
        ) : rightTab === 'related' ? (
          <div className="details-scroll details-body">
            <NamespaceScopeNotice namespace={item.namespace ?? (item.kind === 'Namespace' ? item.name : undefined)} />
            {helm.error && <p className="text-xs text-[var(--status-warn)] mb-2">Helm relationships unavailable: {helm.error}</p>}
            <Card
              title="Resource relationships"
              headerRight={
                <span className="text-[length:calc(10px*var(--ui-factor))] text-[var(--text-muted)] font-mono font-normal">
                  {filteredRelated.length} matching · {resolvedRelated.length} relationships
                </span>
              }
            >
              <SearchInput
                value={relatedQuery}
                onChange={(value) => {
                  setRelatedQuery(value);
                  setRelatedLimits({});
                }}
                placeholder="Filter related resources…"
                className="mb-2 w-full"
              />
              {(helm.loading || relatedLoading) && !resolvedRelated.length && <ResourceLoading label="Loading resource relationships…" />}
              {relatedError && <p role="alert" className="text-xs text-[var(--status-danger)]">{relatedError}</p>}
              {!helm.loading && !relatedLoading && !relatedError && !resolvedRelated.length && <p className="text-[var(--text-secondary)] text-xs py-2">No relationships found in loaded resources.</p>}
              {groupedRelated.length > 0 && (
                <div className="rounded border border-[var(--border-subtle)] overflow-hidden bg-[var(--bg-canvas)]/30">
                  {groupedRelated.map((group) => {
                    const relatedLimit = relatedLimits[group.kind] ?? 50;
                    if (group.items.length === 1) {
                      return (
                        <RelatedRow
                          key={group.items[0].id}
                          entry={group.items[0]}
                          onNavigate={navigate}
                          isCompact={isCompact}
                        />
                      );
                    }
                    const isExpanded = expandedKinds.has(group.kind) || relatedQuery.trim().length > 0;
                    return (
                      <React.Fragment key={group.kind}>
                        <button
                          type="button"
                          aria-expanded={isExpanded}
                          onClick={() => toggleKindGroup(group.kind)}
                          className={cx(
                            "w-full flex items-center gap-1.5 px-2.5 border-b border-[var(--border-subtle)] last:border-b-0 text-left hover:bg-[var(--bg-hover)] transition-colors select-none cursor-pointer",
                            isCompact ? "py-1 min-h-[var(--row-h-compact)]" : "py-1.5 min-h-[var(--row-h-md)]"
                          )}
                        >
                          {isExpanded ? (
                            <ChevronDown size="calc(12px * var(--ui-factor))" className="shrink-0 text-[var(--text-muted)]" />
                          ) : (
                            <ChevronRight size="calc(12px * var(--ui-factor))" className="shrink-0 text-[var(--text-muted)]" />
                          )}
                          <div className="flex-1 min-w-0 flex items-center gap-1.5">
                            <ResourceKindBadge kind={group.kind} />
                            <span className="text-[length:var(--font-size-sm)] font-medium text-[var(--text-primary)]">
                              {group.kind}s
                            </span>
                            <span className="text-[length:var(--font-size-xs)] text-[var(--text-muted)] font-mono">
                              ({group.items.length})
                            </span>
                          </div>
                          <span className="text-[length:var(--font-size-2xs)] text-[var(--text-muted)] shrink-0 font-mono">
                            {isExpanded ? 'collapse' : 'expand'}
                          </span>
                        </button>
                        {isExpanded &&
                          group.items.slice(0, relatedLimit).map((entry) => (
                            <RelatedRow
                              key={entry.id}
                              entry={entry}
                              onNavigate={navigate}
                              nested
                              isCompact={isCompact}
                            />
                          ))}
                        {isExpanded && group.items.length > relatedLimit && (
                          <div className="p-1.5 border-b border-[var(--border-subtle)] last:border-b-0">
                            <Button size="sm" className="ml-5 text-xs" onClick={() => setRelatedLimits(limits => ({ ...limits, [group.kind]: relatedLimit + 50 }))}>
                              Show next 50
                            </Button>
                          </div>
                        )}
                      </React.Fragment>
                    );
                  })}
                </div>
              )}
              {!!resolvedRelated.length && !filteredRelated.length && (
                <p className="text-xs text-[var(--text-muted)] py-2">No related resources match this filter.</p>
              )}
            </Card>
          </div>
        ) : rightTab === 'events' ? (
          <ResourceEvents key={item.uid} item={item} />
        ) : rightTab === 'env' && item.kind === 'Pod' ? (
          <PodEnvironmentTab key={item.uid} item={item} onNavigate={navigate} />
        ) : (
          <div className="details-scroll details-body kubiki-scrollbar">
            <ResourceDetailsRouter key={item.uid} item={item} onNavigate={navigate} onLogs={logs} onShell={shell} />
          </div>
        )}
      </DetailsPanel>
  );
}

function ResourceEvents({ item }: { item: ResourceItem }) {
  const events = useResourceStore((s) => s.resources.Event);
  const error = useResourceStore((s) => s.loadErrors.Event);
  const watchState = useResourceStore((s) => s.watchStates.Event);
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(50);
  const related = useMemo(() => resourceEvents(events.values(), item), [events, item]);
  const filtered = related.filter((entry) =>
    [entry.reason, entry.message, entry.warning ? 'Warning' : 'Normal', entry.reporter]
      .join(' ')
      .toLowerCase()
      .includes(query.toLowerCase())
  );

  return (
    <div className="details-scroll details-body">
      <NamespaceScopeNotice namespace={item.namespace} />
      <Card title="Resource events">
        <p className="text-xs text-[var(--text-muted)] mb-3">
          Notifications for {item.kind}/{item.name} only. Newest first; events for child resources are shown on those objects.
        </p>
        {error && <p role="status" className="text-[var(--status-warn)] text-xs mb-2">{error.message} Loaded events may be incomplete or stale.</p>}
        {watchState && watchState.phase !== 'live' && (
          <p role="status" className="text-xs text-[var(--text-muted)] mb-2">
            Event watch: {watchState.phase}. {watchState.hasSnapshot ? 'Showing the last loaded snapshot.' : 'Waiting for an event snapshot.'}
          </p>
        )}
        <SearchInput
          value={query}
          onChange={(value) => {
            setQuery(value);
            setLimit(50);
          }}
          placeholder="Filter events by reason, message or type…"
          className="w-full mb-2"
        />
        <div className="text-xs text-[var(--text-muted)] mb-2">
          {filtered.length} matching · {related.length} events · {related.filter((entry) => entry.warning).length} warnings
        </div>
        {!related.length && (
          <p className="text-xs text-[var(--text-muted)]">No events for this object in the loaded snapshot. Events are retained temporarily by Kubernetes.</p>
        )}
        {!!related.length && !filtered.length && <p className="text-xs text-[var(--text-muted)]">No events match this filter.</p>}
        {filtered.slice(0, limit).map((entry) => (
          <article key={entry.event.uid} aria-label={entry.reason} className="py-3 border-b border-[var(--border-default)]">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className={entry.warning ? 'text-[var(--status-warn)]' : 'text-[var(--status-ok)]'}>
                {entry.warning ? 'Warning' : 'Normal'}
              </span>
              <strong className="break-all">{entry.reason}</strong>
              <span className="text-[var(--text-muted)]">×{entry.count}</span>
            </div>
            <p className="text-xs text-[var(--text-secondary)] mt-1 whitespace-pre-wrap break-words">{entry.message}</p>
            <div className="flex flex-wrap gap-x-2 mt-2 text-[length:calc(11px*var(--ui-factor))] text-[var(--text-muted)]">
              {entry.timestamp ? (
                <time dateTime={entry.timestamp} title={entry.timestamp}>
                  {new Date(entry.time).toLocaleString()}
                </time>
              ) : (
                <span>Time unavailable</span>
              )}
              {entry.reporter && <span className="break-all">{entry.reporter}</span>}
            </div>
          </article>
        ))}
        {filtered.length > limit && (
          <Button size="sm" className="mt-3" onClick={() => setLimit((value) => value + 50)}>
            Show next 50
          </Button>
        )}
      </Card>
    </div>
  );
}

function Card({ title, headerRight, children }: { title: string; headerRight?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section aria-label={title} className="details-section">
      <div className="details-section-heading flex items-center justify-between gap-2 text-[length:calc(11px*var(--ui-factor))] font-medium text-[var(--text-secondary)] bg-[var(--bg-secondary)]">
        <span>{title}</span>
        {headerRight}
      </div>
      <div className="details-section-body">{children}</div>
    </section>
  );
}
