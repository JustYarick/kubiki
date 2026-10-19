import React from 'react';
import { clsx } from 'clsx';

interface StatusBadgeProps {
  status?: string;
  className?: string;
}

export const StatusBadge: React.FC<StatusBadgeProps> = ({ status = 'Unknown', className }) => {
  const s = status.toLowerCase();

  let colorClasses = 'bg-zinc-800 text-zinc-400 border-zinc-700';
  let dotColor = 'bg-zinc-400';

  if (s === 'running' || s === 'active' || s === 'ready' || s === 'bound' || s === 'completed') {
    colorClasses = 'bg-emerald-950/60 text-emerald-400 border-emerald-800/60';
    dotColor = 'bg-emerald-400';
  } else if (
    s === 'pending' ||
    s === 'containercreating' ||
    s === 'terminating' ||
    s === 'waiting'
  ) {
    colorClasses = 'bg-amber-950/60 text-amber-400 border-amber-800/60';
    dotColor = 'bg-amber-400 animate-pulse';
  } else if (
    s.includes('crashloop') ||
    s.includes('error') ||
    s.includes('failed') ||
    s.includes('imagepull')
  ) {
    colorClasses = 'bg-rose-950/60 text-rose-400 border-rose-800/60';
    dotColor = 'bg-rose-400';
  }

  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-mono font-medium border transition-colors',
        colorClasses,
        className
      )}
    >
      <span className={clsx('w-1.5 h-1.5 rounded-full shrink-0', dotColor)} />
      {status}
    </span>
  );
};
