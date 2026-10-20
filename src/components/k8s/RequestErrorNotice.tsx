import { errorHint, type K8sRequestError } from '../../providers/errors';

export function RequestErrorNotice({ error, onRetry, retainedData = false }: { error: K8sRequestError; onRetry?: () => void; retainedData?: boolean }) {
  const hint = errorHint(error);
  return <div role="alert" data-error-code={error.code} className="p-3 text-xs text-[var(--status-warn)] border-b border-[var(--border-default)]">
    <p className="break-words whitespace-pre-wrap">{error.message}</p>
    {hint && <p className="mt-1 text-[var(--text-secondary)]">{hint}</p>}
    {retainedData && <p className="mt-1 text-[var(--text-secondary)]">Showing the last successfully loaded snapshot; it may be out of date.</p>}
    {onRetry && <button className="mt-2 text-[var(--accent)]" onClick={onRetry}>Retry</button>}
  </div>;
}
