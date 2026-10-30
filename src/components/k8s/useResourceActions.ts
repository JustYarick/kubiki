import type { ResourceItem } from '../../types/k8s';
import { k8s } from '../../providers/k8s_provider';
import { performResourceAction, restartManifest } from '../../providers/resource_actions';
import { resourceRef } from '../../core/resources/identity';
import { useResourceStore } from '../../state/resource_store';
import { useClusterStore } from '../../state/cluster_store';
import { toast } from '../../state/notifications_store';

/** UI orchestration for common actions; mutation payloads belong to the provider/core. */
export function useResourceActions(currentContext: string | null, refresh: () => Promise<void>) {
  const refreshAfterWrite = async () => {
    try { await refresh(); }
    catch { toast.warn('Change saved; view refresh failed', 'Refresh the resource list to load the current state.'); }
  };
  const updateItem = useResourceStore(s => s.updateItem);
  const deleteItem = useResourceStore(s => s.deleteItem);
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
        await refreshAfterWrite();
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
      else await refreshAfterWrite();
      if (k8s.demo) toast.success(`Desired replicas updated to ${replicas} (demo)`, `${item.kind}/${item.name}`);
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
    const raw = restartManifest(item);

    try {
      if (k8s.demo) {
        updateItem(item.kind, item.uid, { ...item, raw });
        toast.success(`Rollout restart triggered for ${item.kind}/${item.name} (demo)`);
      } else {
        await performResourceAction(currentContext!, item, { type: 'restart' });
        await refreshAfterWrite();
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
        await performResourceAction(currentContext!, node, { type: 'cordon', unschedulable: nextUnschedulable });
        await refreshAfterWrite();
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
    if (k8s.demo) {
      const allPods = [...(useResourceStore.getState().resources.Pod?.values() ?? [])];
      const nodePods = allPods.filter(
        (p) => (p.raw?.spec?.nodeName === node.name || p.node === node.name) &&
          !p.raw?.metadata?.ownerReferences?.some((o: any) => o.kind === 'DaemonSet')
      );
      if (nodePods.length === 0) {
        toast.success(`Node ${node.name} cordoned; no non-daemonset pods to drain`);
        return;
      }
      for (const pod of nodePods) {
        useResourceStore.getState().deleteItem('Pod', pod.uid);
      }
      toast.success(`Drained ${nodePods.length} pod(s) from node ${node.name} (demo)`);
      return;
    }
    try {
      const primary = resourceRef(currentContext!, node);
      await k8s.applyBatch(primary, [{
        operation: 'drain',
        resource: primary,
        resource_version: node.raw?.metadata?.resourceVersion ?? '',
        critical: true,
      }]);
      await refreshAfterWrite();
    } catch (err: any) {
      if (err?.code === 'cancelled') {
        toast.info('Drain cancelled');
        return;
      }
      toast.error(`Drain failed for ${node.name}`, String(err?.message || err));
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
        await refreshAfterWrite();
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
        await performResourceAction(currentContext!, cronJob, { type: 'suspend', suspend: nextSuspended });
        await refreshAfterWrite();
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
    const manualJobName = `${cronJob.name}-manual-${Math.floor(Date.now() / 1000).toString().slice(-4)}`;
    try {
      if (k8s.demo) {
        toast.success(`Job ${manualJobName} triggered from CronJob (demo)`);
      } else {
        await performResourceAction(currentContext!, cronJob, { type: 'run_cron_job', name: manualJobName });
        await refreshAfterWrite();
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
        await performResourceAction(currentContext!, app, { type: 'argo_sync' });
        await refreshAfterWrite();
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
        await performResourceAction(currentContext!, app, { type: 'argo_refresh', hard });
        await refreshAfterWrite();
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

  return { doDelete, doScale, doRestart, doToggleCordon, doDrain, doEvictPod, doToggleCronJobSuspend, doTriggerCronJob, doArgoSync, doArgoRefresh, doShare };
}
