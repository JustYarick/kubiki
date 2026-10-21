import { useMemo } from 'react';
import { useMutationConfirmStore } from '../../state/mutation_confirm_store';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { ShieldAlert, Trash2, TriangleAlert, FileDiff, Layers, KeyRound } from 'lucide-react';

export function MutationConfirmModal() {
  const pending = useMutationConfirmStore((s) => s.pending);
  const resolve = useMutationConfirmStore((s) => s.resolve);

  const parsed = useMemo(() => {
    if (!pending) return null;
    const review = pending.review;
    const isDelete = review.includes('DELETE this Kubernetes object') || review.includes('DELETE this exact change');
    const isScale = review.includes('spec.replicas:');
    const isSecret = review.includes('data/') && review.includes('(base64):');
    const isCrd = review.includes('Deleting a CRD deletes all custom resources');
    const isNamespace = review.includes('Deleting a Namespace removes its namespaced contents');
    const isDependents = review.includes('Controllers or garbage collection may also remove dependents');

    const res = pending.resource as any;
    const kind = res?.kind || res?.query?.kind || 'Resource';
    const name = res?.name || '';
    const namespace = res?.namespace || res?.query?.namespace;
    const context = res?.context || res?.query?.context;

    // Extract diff section
    const lines = review.split('\n');
    let diffLines: string[] = [];
    let capturingDiff = false;
    for (const line of lines) {
      if (line.startsWith('DELETE this Kubernetes object') || line.startsWith('spec.replicas:') || line.startsWith('data/') || line.startsWith('--- Before') || line.startsWith('+++ After')) {
        capturingDiff = true;
      }
      if (capturingDiff) {
        if (line.includes('Apply this exact change?') || line.includes('DELETE this exact change?') || line.includes('Approve this operation?')) {
          break;
        }
        diffLines.push(line);
      }
    }

    return {
      isDelete,
      isScale,
      isSecret,
      isCrd,
      isNamespace,
      isDependents,
      kind,
      name,
      namespace,
      context,
      diffText: diffLines.join('\n').trim(),
      raw: review,
    };
  }, [pending]);

  if (!pending || !parsed) return null;

  const title = parsed.isDelete
    ? `Confirm Deletion: ${parsed.kind} ${parsed.name}`
    : `Confirm Change: ${parsed.kind} ${parsed.name}`;

  return (
    <Modal
      open
      onClose={() => resolve(false)}
      width={560}
      title={
        <span className="flex items-center gap-2">
          {parsed.isDelete ? (
            <Trash2 size="calc(15px * var(--ui-factor))" className="text-[var(--status-error)]" />
          ) : parsed.isScale ? (
            <Layers size="calc(15px * var(--ui-factor))" className="text-[var(--accent)]" />
          ) : parsed.isSecret ? (
            <KeyRound size="calc(15px * var(--ui-factor))" className="text-[var(--status-warn)]" />
          ) : (
            <FileDiff size="calc(15px * var(--ui-factor))" className="text-[var(--accent)]" />
          )}
          <span>{title}</span>
        </span>
      }
      footer={
        <>
          <Button onClick={() => resolve(false)}>Cancel</Button>
          <Button
            variant={parsed.isDelete ? 'danger' : 'primary'}
            onClick={() => resolve(true)}
          >
            {parsed.isDelete ? 'Confirm Delete' : 'Apply Change'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3.5 text-[length:calc(12px*var(--ui-factor))]">
        {/* Resource Identity Block */}
        <div className="rounded-[calc(6px*var(--ui-factor))] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3 flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <span className={`px-2 py-0.5 rounded text-[length:calc(11px*var(--ui-factor))] font-semibold uppercase tracking-wide shrink-0 border ${
                parsed.isDelete
                  ? 'bg-[var(--status-error)]/10 text-[var(--status-error)] border-[var(--status-error)]/20'
                  : 'bg-[var(--accent)]/10 text-[var(--accent)] border-[var(--accent)]/20'
              }`}>
                {parsed.kind}
              </span>
              <span className="font-mono font-medium text-[var(--text-primary)] truncate">
                {parsed.name}
              </span>
            </div>
            {parsed.namespace && (
              <span className="px-1.5 py-0.5 rounded font-mono text-[length:calc(11px*var(--ui-factor))] text-[var(--text-secondary)] bg-[var(--bg-secondary)] border border-[var(--border-subtle)] shrink-0">
                ns: {parsed.namespace}
              </span>
            )}
          </div>
          {parsed.context && (
            <div className="text-[length:calc(11px*var(--ui-factor))] text-[var(--text-muted)] font-mono">
              Context: {parsed.context}
            </div>
          )}
        </div>

        {/* Cascading Warnings */}
        {parsed.isCrd && (
          <div className="rounded-[calc(6px*var(--ui-factor))] border border-[var(--status-error)]/30 bg-[var(--status-error)]/10 p-3 flex items-start gap-2.5 text-[var(--status-error)]">
            <TriangleAlert size="calc(16px * var(--ui-factor))" className="shrink-0 mt-0.5" />
            <div className="flex flex-col gap-0.5 leading-relaxed">
              <span className="font-semibold text-[length:calc(12px*var(--ui-factor))]">Cascading CRD Deletion</span>
              <span className="text-[length:calc(11px*var(--ui-factor))] opacity-90">
                Deleting this CustomResourceDefinition will permanently delete all custom resources defined by it across all namespaces.
              </span>
            </div>
          </div>
        )}

        {parsed.isNamespace && (
          <div className="rounded-[calc(6px*var(--ui-factor))] border border-[var(--status-error)]/30 bg-[var(--status-error)]/10 p-3 flex items-start gap-2.5 text-[var(--status-error)]">
            <TriangleAlert size="calc(16px * var(--ui-factor))" className="shrink-0 mt-0.5" />
            <div className="flex flex-col gap-0.5 leading-relaxed">
              <span className="font-semibold text-[length:calc(12px*var(--ui-factor))]">Cascading Namespace Deletion</span>
              <span className="text-[length:calc(11px*var(--ui-factor))] opacity-90">
                Deleting this Namespace will permanently delete all workloads, secrets, configmaps, and resources inside it.
              </span>
            </div>
          </div>
        )}

        {parsed.isDependents && (
          <div className="rounded-[calc(6px*var(--ui-factor))] border border-[var(--status-warn)]/30 bg-[var(--status-warn)]/10 p-3 flex items-start gap-2.5 text-[var(--status-warn)]">
            <ShieldAlert size="calc(16px * var(--ui-factor))" className="shrink-0 mt-0.5" />
            <div className="flex flex-col gap-0.5 leading-relaxed">
              <span className="font-semibold text-[length:calc(12px*var(--ui-factor))]">Background Garbage Collection</span>
              <span className="text-[length:calc(11px*var(--ui-factor))] opacity-90">
                Kubernetes controllers or garbage collection may also remove dependent resources.
              </span>
            </div>
          </div>
        )}

        {/* Detailed Diff / Changes Preview */}
        {parsed.diffText && (
          <div className="flex flex-col gap-1.5">
            <span className="font-medium text-[length:calc(11px*var(--ui-factor))] text-[var(--text-secondary)]">Review Changes:</span>
            <pre className="font-mono text-[length:calc(11px*var(--ui-factor))] leading-relaxed p-3 rounded-[calc(6px*var(--ui-factor))] bg-[var(--bg-canvas)] border border-[var(--border-subtle)] overflow-x-auto max-h-56 text-[var(--text-primary)] whitespace-pre-wrap select-text">
              {parsed.diffText}
            </pre>
          </div>
        )}

        <div className="text-[length:calc(11px*var(--ui-factor))] text-[var(--text-muted)] italic">
          This operation requires explicit review and expires automatically after 2 minutes. Cancel leaves the cluster unchanged.
        </div>
      </div>
    </Modal>
  );
}
