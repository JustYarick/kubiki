import type { ResourceContainer, ResourceItem } from '../../types/k8s';

export const CONTAINER_ROLE_LABEL = { application: 'Container', sidecar: 'Sidecar', init: 'Init', ephemeral: 'Ephemeral' };
/** Status arrays are joined by name; positional fallback can attribute another container's failure. */
export function mapPodContainers(spec: Record<string, any>, status: Record<string, any>): ResourceContainer[] {
  return [
    [spec.containers ?? [], status.containerStatuses ?? [], 'application'],
    [spec.initContainers ?? [], status.initContainerStatuses ?? [], 'init'],
    [spec.ephemeralContainers ?? [], status.ephemeralContainerStatuses ?? [], 'ephemeral'],
  ].flatMap(([definitions, statuses, role]) => (definitions as any[]).map((definition) => {
    const cs = (statuses as any[]).find((entry) => entry.name === definition.name);
    const state = cs?.state?.running ? 'running' : cs?.state?.waiting ? 'waiting' : cs?.state?.terminated ? 'terminated' : cs?.ready ? 'running' : !cs && status.phase === 'Pending' ? 'waiting' : 'unknown';
    const detail = cs?.state?.[state] ?? {};
    return { name: definition.name, image: definition.image ?? '', role: role === 'init' && definition.restartPolicy === 'Always' ? 'sidecar' : role,
      state, reason: detail.reason ?? (!cs && state === 'waiting' ? 'Pending' : undefined), message: detail.message, exitCode: detail.exitCode,
      ready: cs?.ready ?? false, restarts: cs?.restartCount ?? 0,
      port: (definition.ports ?? []).map((p: any) => `${p.containerPort}/${p.protocol ?? 'TCP'}`).join(', ') || '-',
    } as ResourceContainer;
  }));
}
export function podContainers(item?: ResourceItem): ResourceContainer[] {
  if (!item) return [];
  const spec = item.raw?.spec ?? item.spec;
  return spec && ['containers', 'initContainers', 'ephemeralContainers'].some((key) => Array.isArray(spec[key]))
    ? mapPodContainers(spec, item.raw?.status ?? item.statusRaw ?? {}) : (item.containers ?? []).map((c) => ({ ...c, role: c.role ?? 'application', state: c.state ?? (c.ready ? 'running' : 'unknown') }));
}
export function canExecContainer(container: ResourceContainer): boolean { return !['waiting', 'terminated'].includes(container.state ?? 'unknown'); }
export function defaultContainer(item?: ResourceItem, shell = false): string | undefined {
  const containers = podContainers(item);
  const annotation = item?.raw?.metadata?.annotations?.['kubectl.kubernetes.io/default-container'] ?? (item?.metadata?.annotations as any)?.['kubectl.kubernetes.io/default-container'];
  const preferred = containers.find((c) => c.name === annotation && (!shell || canExecContainer(c)));
  return (preferred ?? (shell ? containers.find((c) => c.role === 'application' && c.state === 'running') ?? containers.find((c) => c.state === 'running') : undefined) ?? containers.find((c) => c.role === 'application') ?? containers[0])?.name;
}
export function containerSummary(container: ResourceContainer): string {
  return [CONTAINER_ROLE_LABEL[container.role ?? 'application'], container.name, container.reason ?? container.state ?? (container.ready ? 'running' : 'unknown'), container.state === 'running' && container.role !== 'init' && container.role !== 'ephemeral' ? container.ready ? 'Ready' : 'Not ready' : undefined, container.exitCode !== undefined ? `exit ${container.exitCode}` : undefined, `${container.restarts} restarts`, container.message].filter(Boolean).join(' · ');
}
export function containerTone(container: ResourceContainer): 'ok' | 'warn' | 'danger' | 'muted' | 'info' {
  if (container.state === 'terminated') return container.exitCode === 0 ? 'muted' : container.exitCode === undefined ? 'muted' : 'danger';
  if (container.state === 'waiting') {
    if (container.reason && /BackOff|Error|Failed|Invalid|Crash/i.test(container.reason)) return 'danger';
    return !container.reason || /^(Pending|ContainerCreating|PodInitializing)$/i.test(container.reason) ? 'info' : 'warn';
  }
  if (container.state === 'running' && (container.role === 'init' || container.role === 'ephemeral')) return 'ok';
  return container.ready ? 'ok' : container.state === 'running' ? 'warn' : 'muted';
}
