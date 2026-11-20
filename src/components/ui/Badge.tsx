import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from '../../core/utils/cx';
import './ui.css';

export type BadgeTone = 'neutral' | 'ok' | 'warn' | 'danger' | 'info' | 'accent';
export type BadgeSize = 'xs' | 'sm';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  size?: BadgeSize;
  mono?: boolean;
  dot?: boolean;
  truncate?: boolean;
  children?: ReactNode;
}

export function Badge({
  tone = 'neutral',
  size = 'sm',
  mono = false,
  dot = false,
  truncate = false,
  className,
  children,
  ...rest
}: BadgeProps) {
  return (
    <span
      data-tone={tone}
      data-size={size}
      className={cx('ui-badge', mono && 'font-mono', className)}
      {...rest}
    >
      {dot && <span className="ui-badge-dot" aria-hidden="true" />}
      <span className={cx(truncate && 'truncate min-w-0')}>{children}</span>
    </span>
  );
}

export function CountPill({
  count,
  tone = 'neutral',
  className,
  title,
}: {
  count: number | string;
  tone?: BadgeTone;
  className?: string;
  title?: string;
}) {
  return (
    <Badge tone={tone} size="xs" mono className={cx('tabular-nums', className)} title={title}>
      {count}
    </Badge>
  );
}
