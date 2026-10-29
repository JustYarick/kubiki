import { useMutationConfirmStore } from '../../state/mutation_confirm_store';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';

export function MutationConfirmModal() {
  const pending = useMutationConfirmStore(s => s.pending);
  const resolve = useMutationConfirmStore(s => s.resolve);
  if (!pending) return null;
  const { resource, details, review, simple } = pending;
  const yaml = details?.kind === 'yaml';
  const deleting = simple?.destructive ?? details?.steps.some(step => step.operation === 'DELETE') ?? false;
  const title = simple?.title ?? (yaml ? 'Apply YAML changes?' : deleting ? 'Delete resource?' : 'Confirm operation?');
  const label = simple?.confirm_label ?? (yaml ? 'Apply YAML' : deleting ? 'Delete' : 'Confirm');
  const summary = simple ? review : details?.kind === 'batch' ? `Perform ${details.steps.length} operations on the selected resources.` : details?.steps[0]?.summary ?? review;
  return <Modal open onClose={() => void resolve(false)} width={yaml ? 640 : 480} title={title}
    footer={<><Button onClick={() => void resolve(false)}>Cancel</Button><Button variant={deleting ? 'danger' : 'primary'} onClick={() => void resolve(true)}>{label}</Button></>}>
    <div className="space-y-3 text-xs">
      <p className="font-mono font-medium break-all">{resource.kind} {resource.name}</p>
      <p className="text-[var(--text-secondary)] break-all">Cluster: {resource.context}{resource.namespace && ` · Namespace: ${resource.namespace}`}</p>
      {yaml ? details.steps.map((step, index) => <pre key={index} aria-label="YAML changes" className="max-h-96 overflow-auto whitespace-pre-wrap break-words font-mono select-text">{step.diff}</pre>) : <p className="whitespace-pre-wrap break-words">{summary}</p>}
    </div>
  </Modal>;
}
