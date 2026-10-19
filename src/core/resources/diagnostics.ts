import type { ResourceItem } from '../../types/k8s';
import { matchesSelector } from './relationships';

export interface ResourceIssue {
  id: string;
  severity: 'warning' | 'error';
  summary: string;
  message?: string;
}

export interface DiagnosticContext {
  pods?: readonly ResourceItem[];
  podsLoaded?: boolean;
  storageClass?: ResourceItem;
  now?: number;
}

const WORKLOADS = new Set(['Deployment', 'ReplicaSet', 'StatefulSet', 'DaemonSet']);
const FAILED_STATES = new Set(['Failed', 'Error', 'CrashLoopBackOff', 'ImagePullBackOff', 'ErrImagePull', 'InvalidImageName', 'CreateContainerConfigError', 'CreateContainerError', 'RunContainerError', 'ContainerCannotRun', 'OOMKilled', 'Evicted']);
const STARTUP_STATES = new Set(['ContainerCreating', 'PodInitializing']);
const STUCK_AFTER_MS = 5 * 60 * 1000;
const record = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};

/** Diagnostics require API evidence. Missing data and intentional idle states are not failures. */
export function resourceIssues(item: ResourceItem, context: DiagnosticContext = {}): ResourceIssue[] {
  const raw = item.raw ?? {};
  const metadata = record(raw.metadata ?? item.metadata);
  const spec = record(raw.spec ?? item.spec);
  const status = record(raw.status ?? item.statusRaw);
  const conditions: Record<string, any>[] = Array.isArray(status.conditions) ? status.conditions.map(record).filter((condition) =>
    !(typeof condition.observedGeneration === 'number' && typeof metadata.generation === 'number' && condition.observedGeneration < metadata.generation)) : [];
  const issues = new Map<string, ResourceIssue>();
  const add = (id: string, severity: ResourceIssue['severity'], summary: string, message?: unknown) => {
    issues.set(id, { id, severity, summary, message: typeof message === 'string' && message && message !== summary ? message : undefined });
  };
  const fromCondition = (condition: Record<string, any>, severity: ResourceIssue['severity'] = 'warning') => {
    add(`condition:${condition.type}`, severity, `${condition.type}: ${condition.reason || condition.status}`, condition.message);
  };
  const now = context.now ?? Date.now();
  const age = typeof metadata.creationTimestamp === 'string' ? now - Date.parse(metadata.creationTimestamp) : item.creationTimestamp ? now - Date.parse(item.creationTimestamp) : NaN;
  const terminating = Boolean(metadata.deletionTimestamp) || item.status === 'Terminating';
  const desired = item.kind === 'DaemonSet' ? status.desiredNumberScheduled ?? item.replicas : spec.replicas ?? item.replicas ?? parseReady(item.ready)?.desired;
  const idleWorkload = WORKLOADS.has(item.kind) && desired === 0;
  const completed = ['Succeeded', 'Completed', 'Complete'].includes(status.phase ?? item.status ?? '') || (item.kind === 'Job' && conditions.some((c) => c.type === 'Complete' && c.status === 'True'));

  if (terminating) {
    const deletingFor = now - Date.parse(metadata.deletionTimestamp);
    if (deletingFor > STUCK_AFTER_MS) add('terminating', 'warning', 'Deletion has not completed for over 5 minutes', Array.isArray(metadata.finalizers) && metadata.finalizers.length ? `Finalizers: ${metadata.finalizers.join(', ')}` : 'The resource is still terminating. Check its events and dependent resources.');
    if (item.kind !== 'Namespace') return [...issues.values()];
  }
  if (completed) return [];

  // Conditions share a convention across kinds, but the unhealthy polarity differs by type.
  for (const condition of conditions) {
    const type = String(condition.type ?? '');
    const value = String(condition.status);
    if (idleWorkload && ['Ready', 'Available', 'Progressing', 'ReplicaFailure'].includes(type)) continue;
    if (value === 'True' && /^(ReplicaFailure|Failed|FailureTarget|Degraded|Stalled|DiskPressure|MemoryPressure|PIDPressure|NetworkUnavailable|NamespaceDeletion.*Failure|NamespaceContentRemaining|NamespaceFinalizersRemaining)$/.test(type)) {
      if (['NamespaceContentRemaining', 'NamespaceFinalizersRemaining'].includes(type) && terminating && !(now - Date.parse(metadata.deletionTimestamp) > STUCK_AFTER_MS)) continue;
      fromCondition(condition, /^(ReplicaFailure|Failed|FailureTarget|Stalled)$/.test(type) ? 'error' : 'warning');
    }
    if (['False', 'Unknown'].includes(value) && ['Ready', 'Available', 'Progressing', 'Established', 'NamesAccepted'].includes(type)) {
      if (item.kind === 'Pod' && status.phase !== 'Running' && item.status !== 'Running') continue;
      fromCondition(condition, type === 'Progressing' || (item.kind === 'Node' && type === 'Ready') ? 'error' : 'warning');
    }
    if (item.kind === 'Pod' && type === 'PodScheduled' && value === 'False' && condition.reason === 'Unschedulable') fromCondition(condition);
  }

  if (item.kind === 'Pod') {
    let hasContainerFailure = false;
    for (const [group, states] of [['Container', status.containerStatuses], ['Init container', status.initContainerStatuses], ['Ephemeral container', status.ephemeralContainerStatuses]] as const) {
      if (!Array.isArray(states)) continue;
      for (const container of states) {
        const waiting = container.state?.waiting;
        const terminated = container.state?.terminated;
        if (waiting?.reason && !STARTUP_STATES.has(waiting.reason)) {
          hasContainerFailure = true;
          add(`container:${container.name}`, 'error', `${group} ${container.name}: ${waiting.reason}`, waiting.message);
        } else if (terminated && (Number(terminated.exitCode) !== 0 || FAILED_STATES.has(terminated.reason))) {
          hasContainerFailure = true;
          add(`container:${container.name}`, 'error', `${group} ${container.name}: ${terminated.reason || 'Terminated'} (exit ${terminated.exitCode ?? 'unknown'})`, terminated.message);
        }
      }
    }
    if (!hasContainerFailure && (FAILED_STATES.has(item.status ?? '') || status.phase === 'Failed')) {
      add('pod-state', 'error', status.reason || item.status || 'Pod failed', status.message);
    }
    const ready = parseReady(item.ready);
    if (!hasContainerFailure && ready && ready.ready < ready.desired && (status.phase === 'Running' || item.status === 'Running') && !issues.has('condition:Ready')) {
      add('containers-ready', 'warning', `${ready.ready}/${ready.desired} containers are ready`, conditions.find((c) => c.type === 'ContainersReady' && c.status === 'False')?.message);
    }
    if (!issues.size && status.phase === 'Pending' && age > STUCK_AFTER_MS) add('pod-pending', 'warning', 'Pod has been pending for over 5 minutes', status.message || 'Check scheduling, image pulls and volume provisioning in Events.');
  }

  if (WORKLOADS.has(item.kind) && !idleWorkload) {
    const ready = item.kind === 'DaemonSet' ? status.numberReady ?? parseReady(item.ready)?.ready : status.readyReplicas ?? parseReady(item.ready)?.ready;
    if (typeof ready === 'number' && typeof desired === 'number' && ready < desired && !issues.has('condition:Available') && !issues.has('condition:ReplicaFailure')) {
      add('replicas-ready', 'warning', `${ready}/${desired} replicas are ready`, 'Some desired replicas are not ready. Check the related Pods and workload conditions.');
    }
  }
  if (item.kind === 'Job' && item.status === 'Failed' && !issues.has('condition:Failed')) add('job-failed', 'error', status.reason || 'Job failed', status.message);
  if (item.kind === 'Job' && !issues.has('condition:Failed') && status.failed > 0) add('job-retries', 'warning', `${status.failed} failed Job attempt${status.failed === 1 ? '' : 's'}`, 'The Job has failed Pod attempts. Check its conditions and related Pods.');
  if (item.kind === 'Node' && item.status === 'NotReady' && !issues.has('condition:Ready')) add('node-ready', 'error', 'Node is not ready', 'Check node conditions for the kubelet or infrastructure failure.');
  if (item.kind === 'PersistentVolumeClaim' || item.kind === 'PersistentVolume') {
    const phase = status.phase ?? item.status;
    if (phase === 'Lost' || phase === 'Failed') add('volume-failed', 'error', `Volume is ${phase}`, status.message || status.reason);
    if (item.kind === 'PersistentVolumeClaim' && phase === 'Pending' && age > STUCK_AFTER_MS) {
      const storageClass = context.storageClass?.raw ?? {};
      if (storageClass.volumeBindingMode !== 'WaitForFirstConsumer' || metadata.annotations?.['volume.kubernetes.io/selected-node']) {
        add('volume-pending', 'warning', 'Volume claim has not bound for over 5 minutes', 'Check storage provisioning, capacity and PVC events.');
      }
    }
  }
  if (item.kind === 'Service') {
    if (spec.type === 'LoadBalancer' && !status.loadBalancer?.ingress?.length && age > STUCK_AFTER_MS) add('load-balancer', 'warning', 'Load balancer has no ingress address', 'The load balancer address has not been assigned. Check the service events and load balancer controller.');
    if (context.podsLoaded && context.pods && spec.selector && Object.keys(spec.selector).length) {
      const selected = context.pods.some((pod) => pod.namespace === item.namespace && matchesSelector(pod.labels ?? {}, spec.selector));
      if (!selected) add('service-selector', 'warning', 'Selector matches no loaded Pods', 'No Pod in this namespace matches the service selector. This check uses the loaded Pod snapshot.');
    }
  }
  if (item.kind === 'Event' && raw.type === 'Warning') add('warning-event', 'warning', raw.reason || 'Warning event', raw.message ?? raw.note);
  return [...issues.values()].sort((a, b) => Number(b.severity === 'error') - Number(a.severity === 'error'));
}

function parseReady(value?: string): { ready: number; desired: number } | undefined {
  const match = /^(\d+)\/(\d+)$/.exec(value ?? '');
  return match ? { ready: Number(match[1]), desired: Number(match[2]) } : undefined;
}
