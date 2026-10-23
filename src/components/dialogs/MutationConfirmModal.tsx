import { useMutationConfirmStore } from '../../state/mutation_confirm_store';
import { REVIEW_WARNINGS } from '../../providers/mutation_review';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { ShieldAlert, Trash2, FileDiff, Layers } from 'lucide-react';

export function MutationConfirmModal() {
  const pending = useMutationConfirmStore(s => s.pending);
  const resolve = useMutationConfirmStore(s => s.resolve);
  if (!pending) return null;
  const { resource, details, review } = pending;
  const batch = details?.kind === 'batch';
  const deleting = details?.steps.some(step => step.operation === 'DELETE') ?? false;
  const Icon = deleting ? Trash2 : batch ? Layers : details?.kind === 'yaml' ? FileDiff : ShieldAlert;
  const title = batch ? `Confirm Batch (${details.steps.length} steps): ${resource.kind} ${resource.name}`
    : `Confirm ${deleting ? 'Deletion' : 'Change'}: ${resource.kind} ${resource.name}`;
  return <Modal open onClose={() => void resolve(false)} width={640}
    title={<span className="flex items-center gap-2"><Icon size={16} /><span>{title}</span></span>}
    footer={<><Button onClick={() => void resolve(false)}>Cancel</Button><Button variant={deleting ? 'danger' : 'primary'} onClick={() => void resolve(true)}>{batch ? 'Confirm Batch' : deleting ? 'Confirm Delete' : 'Apply Change'}</Button></>}>
    <div className="flex flex-col gap-3.5 text-xs">
      <div className="p-3 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] break-words">
        <div className="font-mono font-medium">{resource.kind} {resource.name}</div>
        <div className="mt-1 text-[var(--text-secondary)]">Context: {resource.context}{resource.namespace ? ` · Namespace: ${resource.namespace}` : ' · Cluster scoped'}</div>
      </div>
      {details ? <>
        {details.warnings.map(warning => <p key={warning} role="note" className="p-3 rounded border border-[var(--status-warn)]/30 text-[var(--status-warn)]">{REVIEW_WARNINGS[warning]}</p>)}
        <div className="font-medium">{batch ? `All ${details.steps.length} steps will be executed sequentially. Failures are reported per step.` : 'Review Changes:'}</div>
        <ol aria-label="Operation targets" className="max-h-96 overflow-auto space-y-2 select-text">
          {details.steps.map((step, index) => <li key={index} className="p-3 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] break-words">
            <div className="font-mono font-medium">{batch ? `${index + 1}. ` : ''}{step.operation} {step.resource.kind} {step.resource.name}</div>
            <div className="mt-1 text-[var(--text-muted)]">{step.resource.namespace ?? 'Cluster scoped'} · UID: {step.resource.uid ?? 'New object'}</div>
            <p className="mt-2 whitespace-pre-wrap">{step.summary}</p>
            {step.diff && <details open={!batch} className="mt-2"><summary className="cursor-pointer">YAML changes</summary><pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap font-mono text-xs">{step.diff}</pre></details>}
          </li>)}
        </ol>
      </> : <pre className="max-h-96 overflow-auto whitespace-pre-wrap font-mono select-text">{review}</pre>}
      <p className="text-[var(--text-muted)]">Confirmation expires after 2 minutes. Cancel leaves the cluster unchanged.</p>
    </div>
  </Modal>;
}
