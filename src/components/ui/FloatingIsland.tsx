import { useId, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronUp, type LucideIcon } from 'lucide-react';
import { cx } from '../../core/utils/cx';
import './island.css';

export function FloatingIsland({ label, title, icon: Icon, children, defaultExpanded = false, className, testId }: {
  label: string; title: ReactNode; icon: LucideIcon; children: ReactNode; defaultExpanded?: boolean; className?: string; testId?: string;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const id = useId();
  return <aside data-testid={testId} aria-label={label} className={cx('floating-island', className)} onKeyDown={event => {
    if (expanded && event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); setExpanded(false); event.currentTarget.querySelector<HTMLButtonElement>(':scope > button')?.focus(); }
  }}>
    <button className="floating-island-heading" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(value => !value)}>
      <Icon size="calc(13px * var(--ui-factor))" className="shrink-0 text-[var(--text-secondary)]" />
      <span className="min-w-0 flex-1 truncate">{title}</span>
      {expanded ? <ChevronUp size="calc(12px * var(--ui-factor))" className="shrink-0" /> : <ChevronDown size="calc(12px * var(--ui-factor))" className="shrink-0" />}
    </button>
    {expanded && <div id={id} className="floating-island-body kubiki-scrollbar">{children}</div>}
  </aside>;
}
