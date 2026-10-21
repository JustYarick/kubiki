import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

export function DetailsSection({ title, label = title, icon: Icon, actions, children }: { title: string; label?: string; icon?: LucideIcon; actions?: ReactNode; children: ReactNode }) {
  return <section aria-label={label} className="details-section">
    <div className="details-section-heading">
      {Icon && <Icon size="calc(12px * var(--ui-factor))" aria-hidden="true" />}
      <h3 className="min-w-0 flex-1 truncate" title={title}>{title}</h3>{actions}
    </div>
    <div className="details-section-body">{children}</div>
  </section>;
}
