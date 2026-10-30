import { parseDocument } from 'yaml';
import type { ResourceRef } from '../core/resources/resource_types';
import { useNotifications } from '../state/notifications_store';
import type { BatchResult, ChangeRequest, DeleteRequest } from './mutations';
import type { ResourceAction } from './resource_actions';

interface Feedback { title: string; detail?: string; type?: 'success' | 'warn' | 'error' }
function target(resource: ResourceRef) {
  return `${resource.kind} ${resource.namespace ? `${resource.namespace}/` : ''}${resource.name} · Cluster: ${resource.context}`;
}
function actionFeedback(action: ResourceAction): Feedback {
  switch (action.type) {
    case 'restart': return { title: 'Rollout restart requested', detail: 'The Pod template was saved. Kubernetes will perform the rollout.' };
    case 'cordon': return { title: action.unschedulable ? 'Node cordoned' : 'Node uncordoned' };
    case 'suspend': return { title: action.suspend ? 'CronJob suspended' : 'CronJob resumed' };
    case 'config_map_data': return { title: 'ConfigMap data saved' };
    case 'rollback': return { title: 'Deployment rollback saved', detail: 'The previous Pod template was saved. Kubernetes will perform the rollout.' };
    case 'run_cron_job': return { title: 'Job created', detail: `Job: ${action.name}` };
    case 'argo_sync': return { title: 'Argo CD sync requested', detail: 'Waiting for the controller to report the result.' };
    case 'argo_refresh': return { title: action.hard ? 'Argo CD hard refresh requested' : 'Argo CD refresh requested' };
    case 'flux_retry': return { title: 'Flux Helm retry requested', detail: 'Waiting for the controller to report the result.' };
  }
}
function batchFeedback(result: unknown, drain: boolean): Feedback {
  const batch = result as BatchResult | undefined;
  if (!batch || !Number.isInteger(batch.succeeded) || !Number.isInteger(batch.failed) || typeof batch.stopped !== 'boolean') {
    return { title: 'Operation returned an incomplete result', detail: 'Refresh the resources to verify which changes were saved.', type: 'warn' };
  }
  const detail = `${batch.succeeded} succeeded, ${batch.failed} failed${batch.stopped ? ' · execution stopped early' : ''}.`;
  if (batch.failed || batch.stopped) return { title: drain ? 'Drain incomplete' : 'Changes incomplete', detail, type: batch.succeeded ? 'warn' : 'error' };
  return { title: drain ? 'Drain completed' : 'Changes saved', detail };
}
function manifestTarget(request: Extract<ChangeRequest, { operation: 'manifest' }>): string {
  if (request.target) return target(request.target.resource);
  // Only read identity scalars. Never include manifest contents or expand YAML aliases.
  try {
    const document = parseDocument(request.manifest);
    const kind = document.get('kind');
    const name = document.getIn(['metadata', 'name']);
    const namespace = document.getIn(['metadata', 'namespace']);
    if (typeof kind === 'string' && typeof name === 'string') return `${kind} ${typeof namespace === 'string' ? `${namespace}/` : ''}${name} · Cluster: ${request.context}`;
  } catch { /* A successful backend response must not become a UI failure. */ }
  return `Cluster: ${request.context}`;
}

/** One receipt for every successful write IPC, independent of the originating UI. */
export function notifyMutationCompleted(command: 'mutate_resource' | 'delete_resource', request: ChangeRequest | DeleteRequest, result: unknown): void {
  let feedback: Feedback;
  let description: string;
  if (command === 'delete_resource') {
    const deletion = request as DeleteRequest;
    feedback = { title: 'Resource deletion accepted', detail: 'The API accepted deletion. Finalizers and graceful termination may keep the resource visible until cleanup finishes.' };
    description = target(deletion.resource);
  } else {
    const change = request as ChangeRequest;
    switch (change.operation) {
      case 'action': feedback = actionFeedback(change.action); description = target(change.resource); break;
      case 'manifest': feedback = { title: change.target ? 'Manifest saved' : 'Resource created' }; description = manifestTarget(change); break;
      case 'scale': feedback = { title: `Desired replicas saved: ${change.replicas}` }; description = target(change.resource); break;
      case 'evict': feedback = { title: 'Pod eviction accepted', detail: 'Kubernetes will terminate the Pod according to its grace period.' }; description = target(change.resource); break;
      case 'secret': feedback = { title: 'Secret data saved' }; description = target(change.request.resource); break;
      case 'remove_finalizer': {
        const response = result as { metadata?: { finalizers?: unknown } } | undefined;
        const returned = Array.isArray(response?.metadata?.finalizers) && response.metadata.finalizers.includes(change.finalizer);
        feedback = returned ? { title: 'Finalizer returned after removal', detail: 'A controller re-added it. Refresh the resource to check its state.', type: 'warn' } : { title: 'Finalizer removed' };
        description = target(change.resource); break;
      }
      case 'batch': feedback = batchFeedback(result, change.steps.some(step => step.operation === 'drain')); description = target(change.primary); break;
      case 'node_debug': {
        const reused = (result as { reused?: boolean } | undefined)?.reused;
        feedback = { title: reused ? 'Node debug session ready' : 'Node debug Pod ready' }; description = target(change.request.resource); break;
      }
      case 'helm': {
        const helm = change.request;
        const titles = { install: 'Helm release installed', upgrade: 'Helm release upgraded', rollback: 'Helm release rolled back', uninstall: 'Helm release uninstalled', repository_set: 'Helm repository saved', repository_remove: 'Helm repository removed', repository_update: 'Helm repository cache updated' };
        feedback = { title: titles[helm.operation] };
        description = 'context' in helm ? `${helm.namespace}/${helm.name} · Cluster: ${helm.context}` : helm.name || 'All repositories'; break;
      }
    }
  }
  useNotifications.getState().push({
    type: feedback.type ?? 'success', title: feedback.title,
    description: [description, feedback.detail].filter(Boolean).join('\n'),
    persistent: feedback.type === 'warn',
  });
}
