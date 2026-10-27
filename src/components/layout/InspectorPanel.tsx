import { performResourceAction, restartManifest } from '../../providers/resource_actions';
import { resourceBucket } from '../../core/resources/custom_resource_types';
import React, { Suspense, lazy, useMemo, useState, useEffect } from 'react';
import { ArrowLeft, ArrowRight, Boxes, Loader2, X } from 'lucide-react';
import { useResourceStore } from '../../state/resource_store';
import { useClusterStore } from '../../state/cluster_store';
import type { RightTab } from '../../state/ui_store';
import { useUiStore } from '../../state/ui_store';
import { useDockStore } from '../../state/dock_store';
import { useTopologyGraph } from '../../providers/use_topology_graph';
import { relatedResourceKinds } from '../../core/resources/resource_demand';
import { useHelmGraph } from '../../providers/use_helm_graph';
import { resourceKey, resourceRef } from '../../core/resources/identity';
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
import { mapK8sResource } from '../../core/utils/k8s_mapper';
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
  const [localTab, setLocalTab] = useState<RightTab>('overview');
  const rightTab = inspector ? inspectorTab : localTab;
  const helm = useHelmGraph(item?.namespace, rightTab === 'related');
  const setTab = inspector ? useUiStore.getState().setRightTab : setLocalTab;
  const resources = useResourceStore((s) => s.resources);
  const [relatedQuery, setRelatedQuery] = useState('');
  const [relatedLimit, setRelatedLimit] = useState(50);

  useEffect(() => {
    setRelatedQuery('');
    setRelatedLimit(50);
  }, [item?.uid]);

  const { graph, loading: relatedLoading, notice: relatedError } = useTopologyGraph(resources, 'related', item, 1, !!item && rightTab === 'related');
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

  const key = resourceKey(item);
  const related = graph?.relations.filter((edge) => edge.source === key || edge.target === key) ?? [];
  const filteredRelated = related.filter((edge) => {
    const target = graph?.items.get(edge.source === key ? edge.target : edge.source);
    return [target?.name ?? edge.missing?.name, target?.kind ?? edge.missing?.kind, target?.namespace ?? edge.missing?.namespace, edge.type]
      .join(' ')
      .toLowerCase()
      .includes(relatedQuery.toLowerCase());
  });

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
        toast.success(`Deleted ${item.kind}/${item.name}`);
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
        toast.success(`Rollout restart triggered for ${item.kind}/${item.name}`);
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
        toast.success(`Node ${item.name} ${nextUnschedulable ? 'cordoned' : 'uncordoned'}`);
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
      const result = await k8s.applyBatch(primary, [{
        operation: 'drain',
        resource: primary,
        resource_version: item.raw?.metadata?.resourceVersion ?? '',
        critical: true,
      }]);
      if (result.stopped) {
        toast.error(`Drain failed for ${item.name}`, 'The node could not be cordoned. Nothing was evicted.');
        return;
      }
      const evicted = result.steps.filter((step) => step.action === 'EVICT' && step.ok).length;
      const failed = result.steps.filter((step) => step.action === 'EVICT' && !step.ok).length;
      const summary = `Drained node ${item.name}: ${evicted} pod(s) evicted${failed > 0 ? `, ${failed} failed` : ''}`;
      if (failed > 0) toast.warn('Drain completed with eviction failures', summary);
      else toast.success('Drain complete', summary);
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
    useDockStore.getState().openTerminal(target.name, target.namespace, container, containers);
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
                      toast.error('No active cluster context');
                      return;
                    }
                    const output = await k8s.applyManifest(currentContext, yaml, item);
                    toast.success(output || 'Manifest applied', `${item.kind}/${item.name}`);
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
          </Suspense>
        ) : rightTab === 'related' ? (
          <div className="details-scroll details-body">
            <NamespaceScopeNotice namespace={item.namespace ?? (item.kind === 'Namespace' ? item.name : undefined)} />
            {helm.error && <p className="text-xs text-[var(--status-warn)] mb-2">Helm relationships unavailable: {helm.error}</p>}
            <Card title="Resource relationships">
              <p className="text-[length:calc(11px*var(--ui-factor))] text-[var(--text-muted)] mb-2">
                Resolved from owner references, selectors and explicit API references. Unloaded targets may require additional permissions.
              </p>
              <SearchInput
                value={relatedQuery}
                onChange={(value) => {
                  setRelatedQuery(value);
                  setRelatedLimit(50);
                }}
                placeholder="Filter related resources…"
                className="mb-2 w-full"
              />
              <div className="text-[length:calc(10px*var(--ui-factor))] text-[var(--text-muted)] mb-2">
                {filteredRelated.length} matching · {related.length} relationships
              </div>
              {(helm.loading || relatedLoading) && !related.length && <ResourceLoading label="Loading resource relationships…" />}
              {relatedError && <p role="alert" className="text-xs text-[var(--status-danger)]">{relatedError}</p>}
              {!helm.loading && !relatedLoading && !relatedError && !related.length && <p className="text-[var(--text-secondary)] text-xs">No relationships found in loaded resources.</p>}
              {filteredRelated.slice(0, relatedLimit).map((edge) => {
                const outgoing = edge.source === key;
                const target = edge.missing ? undefined : graph?.items.get(outgoing ? edge.target : edge.source);
                return (
                  <button
                    key={edge.id}
                    disabled={!target}
                    onClick={() => target && navigate(target)}
                    className="w-full flex items-center gap-2 px-2 py-2 border-b border-[var(--border-subtle)] text-left hover:bg-[var(--bg-hover)] disabled:opacity-60"
                  >
                    {outgoing ? <ArrowRight size="calc(12px * var(--ui-factor))" /> : <ArrowLeft size="calc(12px * var(--ui-factor))" />}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start gap-2 text-xs font-mono break-all">
                        {target && <ResourceWarnings item={target} />}
                        <span>{target?.name ?? edge.missing?.name}</span>
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5 mt-1.5 text-[length:calc(10px*var(--ui-factor))] text-[var(--text-secondary)]">
                        <ResourceKindBadge kind={target?.kind ?? edge.missing?.kind ?? 'Resource'} apiVersion={target?.apiVersion} />
                        <span>{target?.namespace ?? edge.missing?.namespace ?? 'cluster'}{!target && ' · not loaded'}</span>
                      </div>
                    </div>
                    <span className="text-[length:calc(10px*var(--ui-factor))] text-[var(--text-secondary)]">{edge.label}</span>
                  </button>
                );
              })}
              {filteredRelated.length > relatedLimit && (
                <Button size="sm" className="mt-3" onClick={() => setRelatedLimit((limit) => limit + 50)}>
                  Show next 50
                </Button>
              )}
              {!!related.length && !filteredRelated.length && (
                <p className="text-xs text-[var(--text-muted)]">No related resources match this filter.</p>
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

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section aria-label={title} className="details-section">
      <div className="details-section-heading text-[length:calc(11px*var(--ui-factor))] font-medium text-[var(--text-secondary)] bg-[var(--bg-secondary)]">
        {title}
      </div>
      <div className="details-section-body">{children}</div>
    </section>
  );
}
