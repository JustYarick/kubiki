import React from 'react';
import { cx } from '../../core/utils/cx';

interface StatusBadgeProps {
  status?: string;
  className?: string;
  size?: 'sm' | 'md';
}

export const StatusBadge: React.FC<StatusBadgeProps> = ({ status = 'Unknown', className, size = 'md' }) => {
  const s = status.toLowerCase();

  let colorPair: [string, string] = ['bg-[var(--bg-surface)] text-[var(--text-secondary)] border-[var(--border-default)]', 'bg-[var(--status-neutral)]'];
  if (s === 'running' || s === 'active' || s === 'ready' || s === 'bound' || s === 'completed' || s === 'complete' || s === 'available') {
    colorPair = ['bg-[var(--status-ok)]/10 text-[var(--status-ok)] border-[var(--status-ok)]/30', 'bg-[var(--status-ok)]'];
  } else if (
    s === 'pending' || s === 'containercreating' || s === 'terminating' || s === 'waiting' ||
    s === 'progressing' || s === 'notready' || s === 'unavailable'
  ) {
    colorPair = ['bg-[var(--status-warn)]/10 text-[var(--status-warn)] border-[var(--status-warn)]/30', 'bg-[var(--status-warn)] animate-pulse'];
  } else if (
    s.includes('crashloop') || s === 'error' || s === 'failed' || s === 'backoff' || s.includes('imagepull') || s === 'evicted'
  ) {
    colorPair = ['bg-[var(--status-danger)]/10 text-[var(--status-danger)] border-[var(--status-danger)]/30', 'bg-[var(--status-danger)]'];
  }

  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 rounded-[calc(4px*var(--ui-factor))] font-mono font-medium border whitespace-nowrap transition-colors',
        size === 'md' ? 'text-[length:calc(10.5px*var(--ui-factor))] px-1.5 py-[1px]' : 'text-[length:calc(10px*var(--ui-factor))] px-1.5 py-0',
        colorPair[0],
        className
      )}
    >
      <span className={cx('w-1.5 h-1.5 rounded-full shrink-0', colorPair[1])} />
      {status}
    </span>
  );
};
