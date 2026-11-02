import { ShieldAlert } from 'lucide-react';
import { stringify } from 'yaml';
import { Button } from '../../../components/ui/Button';
import { CodeEditor } from '../../../components/ui/CodeEditor';
import type { MutationConfirmRequest } from '../../../state/mutation_confirm_store';

export function formatManifestOrDiff(rawDiff: string, appliedYaml?: string): { code: string; language: 'yaml' | 'json' } {
  if (appliedYaml && appliedYaml.trim()) {
    return { code: appliedYaml.trim(), language: 'yaml' };
  }
  let text = (rawDiff || '').trim();
  if (text.startsWith('CREATE object:\n')) {
    text = text.slice('CREATE object:\n'.length).trim();
  }
  if (text.startsWith('{') && text.endsWith('}')) {
    try {
      const parsed = JSON.parse(text);
      return { code: stringify(parsed).trim(), language: 'yaml' };
    } catch {
      // keep text
    }
  }
  return { code: text, language: 'yaml' };
}

export function ActionApprovalCard({
  request,
  onResolve,
}: {
  request: MutationConfirmRequest;
  onResolve: (approved: boolean) => void;
}) {
  const { resource, details, review, simple } = request;
  const yaml = details?.kind === 'yaml';
  const deleting = simple?.destructive ?? details?.steps.some(step => step.operation === 'DELETE') ?? false;
  const title = simple?.title ?? (yaml ? 'Apply YAML changes?' : deleting ? 'Delete resource?' : 'Confirm operation?');
  const summary = simple ? review : details?.kind === 'batch' ? `Perform ${details.steps.length} operations on the selected resources.` : details?.steps[0]?.summary ?? review;
  const diffContent = yaml && details.steps[0]?.diff ? details.steps[0].diff : '';
  const formatted = diffContent ? formatManifestOrDiff(diffContent) : { code: '', language: 'yaml' as const };

  return (
    <div className="ai-action-approval-card my-3 p-4 rounded-lg border-2 border-amber-500/40 bg-[var(--bg-secondary)] shadow-lg animate-fade-in max-w-[900px] mx-auto">
      <div className="flex items-center justify-between gap-3 mb-2.5">
        <div className="flex items-center gap-2">
          <div className="p-1.5 rounded bg-amber-500/10 text-amber-400">
            <ShieldAlert size={16} aria-hidden="true" />
          </div>
          <div>
            <h4 className="text-xs font-semibold text-[var(--text-primary)]">{title}</h4>
            <p className="text-[10.5px] text-[var(--text-secondary)] font-mono">
              {resource.kind} <span className="text-[var(--text-primary)] font-semibold">{resource.name}</span>
              {resource.namespace ? ` · ns: ${resource.namespace}` : ''} · cluster: {resource.context}
            </p>
          </div>
        </div>
        <span className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30">
          Awaiting confirmation
        </span>
      </div>

      <p className="text-xs text-[var(--text-secondary)] mb-3 leading-relaxed">
        {simple ? summary.split('\n')[0] : summary}
      </p>
      {simple && summary.includes('\n') && (
        <details className="mb-3 text-xs">
          <summary>Tool arguments</summary>
          <pre className="overflow-auto max-h-48 whitespace-pre-wrap">{summary.slice(summary.indexOf('\n') + 1)}</pre>
        </details>
      )}

      {formatted.code ? (
        <div className="mb-3 rounded border border-[var(--border-default)] overflow-hidden">
          <CodeEditor
            ariaLabel="YAML Mutation Diff"
            value={formatted.code}
            language={formatted.language}
            readOnly={true}
            height="min(38vh, 300px)"
            copyable={true}
            variant="field"
          />
        </div>
      ) : null}

      <div className="flex items-center justify-end gap-2.5 pt-2 border-t border-[var(--border-subtle)]">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => onResolve(false)}
        >
          Decline
        </Button>
        <Button
          size="sm"
          variant={deleting ? 'danger' : 'primary'}
          onClick={() => onResolve(true)}
        >
          {simple?.confirm_label ?? (deleting ? 'Delete' : 'Apply')}
        </Button>
      </div>
    </div>
  );
}
