import { TriangleAlert } from 'lucide-react';
import { errorHint, type K8sRequestError } from '../../providers/errors';
import { Button } from '../ui/Button';
import { cx } from '../../core/utils/cx';

export interface RequestErrorNoticeProps {
  error: K8sRequestError;
  onRetry?: () => void;
  retainedData?: boolean;
  /** Epoch timestamp (ms) of the last confirmed snapshot currently displayed. */
  updatedAt?: number;
  /** True when the retained rows came from cache on tab reopen and were never freshly confirmed. */
  fromCache?: boolean;
  /** Lets the user discard stale/cached rows while keeping the error and Retry action visible. */
  onDiscardStale?: () => void;
  className?: string;
}

export function RequestErrorNotice({
  error,
  onRetry,
  retainedData = false,
  updatedAt,
  fromCache = false,
  onDiscardStale,
  className,
}: RequestErrorNoticeProps) {
  const hint = errorHint(error);
  const syncedLabel = updatedAt
    ? new Date(updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : null;

  if (retainedData) {
    return (
      <div
        role="alert"
        data-error-code={error.code}
        data-retained="true"
        className={cx(
          'shrink-0 flex flex-wrap items-start justify-between gap-2 px-3 py-2.5 text-xs border-b border-[var(--status-warn)]/35 bg-[var(--status-warn)]/[0.08]',
          className,
        )}
      >
        <div className="flex items-start gap-2 min-w-0 flex-1">
          <TriangleAlert
            size="calc(14px * var(--ui-factor))"
            className="text-[var(--status-warn)] shrink-0 mt-0.5"
            aria-hidden="true"
          />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center rounded px-1.5 py-[1px] text-[length:calc(10px*var(--ui-factor))] font-semibold uppercase tracking-[0.04em] bg-[var(--status-warn)]/15 text-[var(--status-warn)] border border-[var(--status-warn)]/30">
                {fromCache ? 'Cached data' : 'Stale data'}
              </span>
              {syncedLabel && updatedAt && (
                <time
                  dateTime={new Date(updatedAt).toISOString()}
                  title={new Date(updatedAt).toLocaleString()}
                  className="text-[length:calc(10px*var(--ui-factor))] font-mono text-[var(--text-secondary)]"
                >
                  Last synced {syncedLabel}
                </time>
              )}
            </div>
            <p className="mt-1 break-words whitespace-pre-wrap text-[var(--text-primary)]">{error.message}</p>
            {hint && <p className="mt-0.5 text-[var(--text-secondary)]">{hint}</p>}
            <p className="mt-0.5 text-[var(--text-secondary)]">Showing previously loaded data. It may be out of date.</p>
          </div>
        </div>
        {(onRetry || onDiscardStale) && (
          <div className="flex items-center gap-1.5 shrink-0">
            {onRetry && <Button size="xs" variant="secondary" onClick={onRetry}>Retry</Button>}
            {onDiscardStale && <Button size="xs" variant="ghost" onClick={onDiscardStale}>Clear stale data</Button>}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      role="alert"
      data-error-code={error.code}
      className={cx('shrink-0 p-3 text-xs text-[var(--status-warn)] border-b border-[var(--border-default)]', className)}
    >
      <p className="break-words whitespace-pre-wrap">{error.message}</p>
      {hint && <p className="mt-1 text-[var(--text-secondary)]">{hint}</p>}
      {onRetry && (
        <div className="mt-2">
          <Button size="xs" variant="secondary" onClick={onRetry}>Retry</Button>
        </div>
      )}
    </div>
  );
}
