import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, type LucideIcon } from 'lucide-react';
import { cx } from '../../core/utils/cx';
import './ui.css';

export interface FieldProps {
  label: ReactNode;
  htmlFor?: string;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  horizontal?: boolean;
  className?: string;
  children?: ReactNode;
}

/** Adaptive form field wrapper that stacks automatically in narrow containers. */
export function Field({
  label,
  htmlFor,
  hint,
  error,
  required,
  horizontal = false,
  className,
  children,
}: FieldProps) {
  return (
    <div className={cx('ui-field', className)} data-horizontal={horizontal ? 'true' : undefined}>
      <label htmlFor={htmlFor} className="ui-field-label">
        {label}
        {required && <span className="text-[var(--status-danger)] ml-0.5" aria-hidden="true">*</span>}
      </label>
      <div className="min-w-0 flex-1">{children}</div>
      {error ? (
        <span role="alert" className="ui-field-error">{error}</span>
      ) : hint ? (
        <span className="ui-field-hint">{hint}</span>
      ) : null}
    </div>
  );
}

/** Responsive auto-fit grid for form fields and controls. */
export function FieldGroup({ className, children }: { className?: string; children?: ReactNode }) {
  return <div className={cx('ui-field-group', className)}>{children}</div>;
}

export interface SectionCardProps {
  title: ReactNode;
  subtitle?: ReactNode;
  icon?: LucideIcon;
  actions?: ReactNode;
  ariaLabel?: string;
  collapsible?: boolean;
  defaultOpen?: boolean;
  padded?: boolean;
  className?: string;
  bodyClassName?: string;
  children?: ReactNode;
}

/** Container-aware card with consistent Kubiki header, wrapping actions, and optional collapse. */
export function SectionCard({
  title,
  subtitle,
  icon: Icon,
  actions,
  ariaLabel,
  collapsible = false,
  defaultOpen = true,
  padded = true,
  className,
  bodyClassName,
  children,
}: SectionCardProps) {
  const [open, setOpen] = useState(defaultOpen);
  const heading = (
    <>
      {Icon && <Icon size="calc(13px * var(--ui-factor))" className="text-[var(--accent)] shrink-0" aria-hidden="true" />}
      <span className="ui-section-card-title">{title}</span>
      {subtitle && <span className="ui-section-card-subtitle shrink-0">{subtitle}</span>}
    </>
  );

  return (
    <section aria-label={ariaLabel ?? (typeof title === 'string' ? title : undefined)} className={cx('ui-section-card', className)}>
      <div className="ui-section-card-header">
        {collapsible ? (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
            className="ui-section-card-title-row text-left hover:text-[var(--text-primary)] cursor-pointer"
          >
            {open ? <ChevronDown size="calc(13px * var(--ui-factor))" className="shrink-0 text-[var(--text-muted)]" /> : <ChevronRight size="calc(13px * var(--ui-factor))" className="shrink-0 text-[var(--text-muted)]" />}
            {heading}
          </button>
        ) : (
          <div className="ui-section-card-title-row">{heading}</div>
        )}
        {actions && <div className="ui-section-card-actions">{actions}</div>}
      </div>
      {(!collapsible || open) && (
        <div className={cx('ui-section-card-body', bodyClassName)} data-padded={padded ? 'true' : undefined}>
          {children}
        </div>
      )}
    </section>
  );
}

export interface EmptyStateProps {
  icon?: LucideIcon;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
  className?: string;
}

/** Standard empty / no-matches / unavailable message block. */
export function EmptyState({ icon: Icon, title, description, action, compact = false, className }: EmptyStateProps) {
  return (
    <div role="status" className={cx('ui-empty-state', className)} data-compact={compact ? 'true' : undefined}>
      {Icon && <Icon size="calc(20px * var(--ui-factor))" className="text-[var(--text-muted)] opacity-75 shrink-0" aria-hidden="true" />}
      <p className="ui-empty-state-title">{title}</p>
      {description && <p className="ui-empty-state-description">{description}</p>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

export interface KeyValueItem {
  label: ReactNode;
  value: ReactNode;
  mono?: boolean;
}

/** Adaptive definition list that collapses to a single column in narrow panes. */
export function KeyValueList({ items, className }: { items: KeyValueItem[]; className?: string }) {
  return (
    <dl className={cx('ui-kv-list', className)}>
      {items.map((item, idx) => (
        <div key={idx} className="contents">
          <dt>{item.label}</dt>
          <dd className={cx(item.mono && 'font-mono')}>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
