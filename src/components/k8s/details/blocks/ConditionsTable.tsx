import { CheckCircle2, XCircle, AlertCircle } from 'lucide-react';
import { cx } from '../../../../core/utils/cx';

interface Condition {
  type: string;
  status: 'True' | 'False' | 'Unknown';
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
}

interface ConditionsTableProps {
  conditions: Condition[];
}

export function ConditionsTable({ conditions }: ConditionsTableProps) {
  if (!conditions || conditions.length === 0) return null;

  return (
    <section aria-label="Conditions" className="details-section">
      <div className="details-section-heading text-[length:calc(11px*var(--ui-factor))] font-medium text-[var(--text-secondary)] bg-[var(--bg-secondary)] flex items-center justify-between">
        <span>Conditions ({conditions.length})</span>
      </div>
      <div className="divide-y divide-[var(--border-subtle)] bg-[var(--bg-canvas)]">
        {conditions.map((c) => {
          const negative = /^(Failed|Failure|Degraded|Stalled|Denied|ReplicaFailure|DisruptionTarget)$/.test(c.type);
          const pending = c.type === 'Reconciling';
          const isOk = c.status === (negative ? 'False' : 'True') && !pending;
          const isError = negative ? c.status === 'True' : c.status === 'False' && /^(Ready|Available|ContainersReady|PodScheduled|Progressing|ScalingActive|AbleToScale)$/.test(c.type);

          return (
            <div key={c.type} className="p-2.5 flex items-start gap-2.5 hover:bg-[var(--bg-hover)] transition-colors">
              <div className="mt-0.5 shrink-0">
                {isOk ? (
                  <CheckCircle2 size="calc(14px * var(--ui-factor))" className="text-emerald-400" />
                ) : isError ? (
                  <XCircle size="calc(14px * var(--ui-factor))" className="text-rose-400" />
                ) : (
                  <AlertCircle size="calc(14px * var(--ui-factor))" className="text-[var(--text-muted)]" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-xs text-[var(--text-primary)] min-w-0 break-all">{c.type}</span>
                  <span
                    className={cx(
                      'text-[length:calc(10px*var(--ui-factor))] font-mono font-medium px-1.5 py-0.2 rounded',
                      isOk ? 'text-emerald-400 bg-emerald-500/10' : isError ? 'text-rose-400 bg-rose-500/10' : 'text-[var(--text-muted)] bg-[var(--bg-secondary)]'
                    )}
                  >
                    {c.status}
                  </span>
                </div>
                {c.reason && (
                  <div className="text-[length:calc(10.5px*var(--ui-factor))] text-[var(--text-muted)] font-mono mt-0.5 break-all">
                    Reason: {c.reason}
                  </div>
                )}
                {c.message && (
                  <div className="text-[length:calc(11px*var(--ui-factor))] text-[var(--text-secondary)] mt-1 break-words">
                    {c.message}
                  </div>
                )}
                {c.lastTransitionTime && (
                  <div className="text-[length:calc(10px*var(--ui-factor))] text-[var(--text-muted)] mt-1">
                    Updated {new Date(c.lastTransitionTime).toLocaleString()}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
