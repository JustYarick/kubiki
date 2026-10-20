import { useEffect } from 'react';
import { useContainerLaunchStore } from '../../state/container_launch_store';
import { useResourceStore } from '../../state/resource_store';
import { canExecContainer, containerSummary, CONTAINER_ROLE_LABEL, podContainers } from '../../core/resources/containers';
import type { ResourceContainer } from '../../types/k8s';
import { ContainerStatusIcon } from './ContainerSelect';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';

export function ContainerChoices({ containers, shell, onChoose }: { containers: ResourceContainer[]; shell: boolean; onChoose: (name: string) => void }) {
  return <div role="group" aria-label={shell ? 'Choose shell container' : 'Choose log container'} className="space-y-2">
    {containers.map(container => <button key={container.name} aria-label={`Open ${shell ? 'shell' : 'logs'} for ${container.name}`} disabled={shell && !canExecContainer(container)} title={containerSummary(container)} onClick={() => onChoose(container.name)} className="w-full flex items-center gap-3 rounded border border-[var(--border-default)] p-3 text-left hover:bg-[var(--bg-hover)] disabled:opacity-50 disabled:cursor-not-allowed">
      <ContainerStatusIcon container={container} /><span className="min-w-0 flex-1"><span className="block font-mono text-xs truncate">{container.name}</span><span className="block text-xs text-[var(--text-secondary)] mt-1 break-words">{CONTAINER_ROLE_LABEL[container.role ?? 'application']} · {container.reason ?? container.state ?? 'unknown'}{shell && !canExecContainer(container) ? ' · Shell unavailable' : ''}</span></span>
    </button>)}
  </div>;
}
export function ContainerLaunchDialog() {
  const { pending, choose, cancel } = useContainerLaunchStore();
  const pods = useResourceStore(state => state.resources.Pod);
  const current = pending && [...pods.values()].find(item => item.name === pending.item.name && item.namespace === pending.item.namespace);
  const invalid = !!pending && (!current || current.uid !== pending.item.uid);
  useEffect(() => { if (invalid) cancel(); }, [invalid, cancel]);
  return <Modal open={!!pending && !invalid} onClose={cancel} title={`Choose container · ${pending?.shell ? 'Shell' : 'Logs'}`} width={460} footer={<Button onClick={cancel}>Cancel</Button>}>
    {pending && <><p className="text-xs text-[var(--text-secondary)] mb-3 break-words">{pending.item.namespace} / {pending.item.name} · Select a container to connect.</p><ContainerChoices containers={podContainers(current || pending.item)} shell={pending.shell} onChoose={choose} /></>}
  </Modal>;
}
