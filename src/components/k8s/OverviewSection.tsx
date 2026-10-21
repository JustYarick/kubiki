import type { ReactNode } from 'react';
import { cx } from '../../core/utils/cx';

/** One shared section shell; content determines its height at every pane width. */
export function OverviewSection({ label, title, description, actions, children, className }: {
  label: string; title: ReactNode; description?: string; actions?: ReactNode; children: ReactNode; className?: string;
}) {
  return <section aria-label={label} className={cx('overview-section', className)}>
    <header className="overview-section-header">
      <div className="overview-section-heading"><h2>{title}</h2>{description && <p>{description}</p>}</div>
      {actions && <div className="overview-section-actions">{actions}</div>}
    </header>
    <div className="overview-section-body">{children}</div>
  </section>;
}
